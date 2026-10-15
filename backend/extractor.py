import base64
import json
import os
import re
import io
import httpx
from PIL import Image, ImageOps
from typing import Dict, Any, Tuple, Optional
from backend.db import get_setting

DEFAULT_CATEGORIES = [
    "Produce & Fresh",
    "Dairy & Eggs",
    "Bakery & Bread",
    "Meat & Seafood",
    "Pantry & Dry Goods",
    "Beverages & Drinks",
    "Snacks & Sweets",
    "Frozen Foods",
    "Household & Cleaning",
    "Personal Care",
    "Other",
]

PROMPT = f"""You are an expert grocery receipt parser. Analyze the receipt image and extract structured data.
You must return ONLY a valid JSON object (no extra commentary, markdown explanation, or conversation) with the following structure:
{{
  "provider": "Store or Supermarket name (e.g. Mercadona, Carrefour, Lidl, Trader Joe's)",
  "receipt_date": "YYYY-MM-DD (Date of the purchase; if unclear, use 2026-10-14)",
  "invoice_id": "Ticket, Invoice, or Factura Simplificada number/code printed on receipt (e.g. 3572-016-394107, or null if not found)",
  "currency": "EUR (or currency code on receipt)",
  "total_amount": 0.0,
  "items": [
    {{
      "name": "Raw item name from receipt line",
      "clean_name": "Standardized friendly item name (e.g., Bananas, Whole Milk 1L, Chicken Breast)",
      "quantity": 1.0,
      "unit": "unit (or kg, g, pack, L, bottle)",
      "unit_price": 0.0,
      "total_price": 0.0,
      "category": "One of: {', '.join(DEFAULT_CATEGORIES)}"
    }}
  ]
}}

Rules:
1. Extract EVERY purchased grocery item listed on the receipt.
2. For weighed items (like fruits/vegetables), put the weight in kilograms or grams into quantity/unit (e.g. quantity: 0.65, unit: "kg").
3. Normalize item names to a friendly clean_name so items can be tracked across multiple shopping trips.
4. Categorize each item into the closest category from the provided list.
5. Make sure total_amount is a floating point number.
6. Return purely valid JSON.
"""


def optimize_image_for_vision(filepath: str, max_dimension: int = 1400, quality: int = 85) -> str:
    """Read, fix EXIF orientation, resize if larger than max_dimension, and return base64 JPEG."""
    with Image.open(filepath) as img:
        # Transpose based on EXIF to handle phone photos taken vertically
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        # Resize keeping aspect ratio
        width, height = img.size
        if max(width, height) > max_dimension:
            scale = max_dimension / float(max(width, height))
            new_size = (int(width * scale), int(height * scale))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")


def clean_json_response(text: str) -> Dict[str, Any]:
    """Parse JSON out of raw model response, handling markdown fences or leading/trailing text."""
    text = text.strip()
    # Check for markdown code fences
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if fence_match:
        text = fence_match.group(1).strip()

    # Find first { and last }
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace != -1:
        text = text[first_brace : last_brace + 1]

    try:
        data = json.loads(text)
    except Exception as e:
        # Fallback regex repair for common JSON trailing comma errors
        repaired = re.sub(r",\s*([\]}])", r"\1", text)
        data = json.loads(repaired)

    # Sanitize and validate
    if not isinstance(data, dict):
        raise ValueError("Model output is not a JSON object")

    items = data.get("items", [])
    if not isinstance(items, list):
        items = []

    cleaned_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "Item")).strip()
        clean_name = str(item.get("clean_name", name)).strip()
        try:
            qty = float(item.get("quantity", 1.0))
        except (ValueError, TypeError):
            qty = 1.0
        unit = str(item.get("unit", "unit")).strip()
        try:
            unit_price = float(item.get("unit_price", 0.0))
        except (ValueError, TypeError):
            unit_price = 0.0
        try:
            total_price = float(item.get("total_price", unit_price * qty))
        except (ValueError, TypeError):
            total_price = 0.0
        cat = str(item.get("category", "Other")).strip()
        if cat not in DEFAULT_CATEGORIES:
            cat = "Other"

        cleaned_items.append({
            "name": name,
            "clean_name": clean_name,
            "quantity": qty,
            "unit": unit,
            "unit_price": unit_price,
            "total_price": total_price,
            "category": cat
        })

    try:
        total_amount = float(data.get("total_amount", sum(i["total_price"] for i in cleaned_items)))
    except (ValueError, TypeError):
        total_amount = sum(i["total_price"] for i in cleaned_items)

    raw_invoice = data.get("invoice_id")
    invoice_id = str(raw_invoice).strip() if raw_invoice is not None else None
    if invoice_id and invoice_id.lower() in ("null", "none", "n/a", "undefined", ""):
        invoice_id = None

    return {
        "provider": str(data.get("provider", "Unknown Store")).strip(),
        "receipt_date": str(data.get("receipt_date", "2026-10-14")).strip(),
        "invoice_id": invoice_id,
        "currency": str(data.get("currency", "EUR")).strip(),
        "total_amount": round(total_amount, 2),
        "items": cleaned_items
    }


def build_primary_api_request(base_url: str, model: str, prompt: str, b64_image: Optional[str] = None) -> Tuple[str, Dict[str, Any], bool]:
    """
    Intelligently resolves endpoint URL and formats request payload:
    - If URL already contains an endpoint path (e.g. /responses, /chat/completions, /messages), preserves it.
    - If /responses is targeted, formats payload for OpenAI / OpenCode Responses API.
    - Otherwise formats for standard OpenAI Chat Completions API.
    """
    clean_base = base_url.strip().rstrip('/')
    
    if clean_base.endswith("/chat/completions") or clean_base.endswith("/responses") or clean_base.endswith("/messages"):
        url = clean_base
    elif "/responses" in clean_base or clean_base.endswith("/v1/responses"):
        url = clean_base
    elif clean_base.endswith("/chat"):
        url = f"{clean_base}/completions"
    else:
        url = f"{clean_base}/chat/completions"

    is_responses_api = "/responses" in url

    if is_responses_api:
        if b64_image:
            payload = {
                "model": model,
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": prompt},
                            {
                                "type": "input_image",
                                "image_url": f"data:image/jpeg;base64,{b64_image}"
                            }
                        ]
                    }
                ]
            }
        else:
            payload = {
                "model": model,
                "input": prompt
            }
    else:
        # Check if model is a known reasoning model that forbids temperature (e.g., o1, o3, gpt-6)
        is_reasoning_model = any(m in model.lower() for m in ["o1", "o3", "gpt-6", "luna"])
        if b64_image:
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{b64_image}",
                                    "detail": "high"
                                }
                            }
                        ]
                    }
                ],
                "max_tokens": 2048
            }
            if not is_reasoning_model:
                payload["temperature"] = 0.1
        else:
            payload = {
                "model": model,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": 20
            }
            if not is_reasoning_model:
                payload["temperature"] = 0.0

    return url, payload, is_responses_api


def extract_text_from_api_response(res_json: Any) -> str:
    """Extract output text from various provider response formats (OpenAI, OpenCode, Anthropic)."""
    if not isinstance(res_json, dict):
        return str(res_json)

    # 1. Standard OpenAI Chat Completions: choices[0].message.content
    choices = res_json.get("choices")
    if choices and isinstance(choices, list) and len(choices) > 0:
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            msg = choice.get("message", {})
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content
                elif isinstance(content, list):
                    text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                    if text.strip():
                        return text

    # 2. OpenAI / OpenCode Responses API: output_text field
    if "output_text" in res_json and isinstance(res_json["output_text"], str) and res_json["output_text"].strip():
        return res_json["output_text"]

    # 3. Responses API: output list (supporting reasoning models with reasoning + message elements)
    output = res_json.get("output")
    if output:
        if isinstance(output, str) and output.strip():
            return output
        if isinstance(output, list) and len(output) > 0:
            # First look for an explicit message item (standard in Responses API)
            for item in output:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "message" or item.get("role") == "assistant":
                    content = item.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
                    if isinstance(content, list):
                        text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                        if text.strip():
                            return text
                    if "text" in item and isinstance(item["text"], str) and item["text"].strip():
                        return item["text"]

            # Fallback: check all items in output for non-empty text content
            for item in output:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                    if text.strip():
                        return text
                if "text" in item and isinstance(item["text"], str) and item["text"].strip():
                    return item["text"]

    # 4. Anthropic style content
    content = res_json.get("content")
    if content:
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            if text.strip():
                return text

    # 5. Generic response field
    if "response" in res_json and str(res_json["response"]).strip():
        return str(res_json["response"])

    raise ValueError(f"Unrecognized model response structure: {json.dumps(res_json)[:250]}")


async def extract_via_primary_api(b64_image: str) -> Optional[Dict[str, Any]]:
    """Attempt extraction using the primary Copencode / OpenAI-compatible API."""
    base_url = get_setting("PRIMARY_API_BASE_URL", os.environ.get("PRIMARY_API_BASE_URL", "https://opencode.ai/inference/openai/v1/responses")).strip()
    api_key = get_setting("PRIMARY_API_KEY", os.environ.get("PRIMARY_API_KEY", "")).strip()
    model = get_setting("PRIMARY_VISION_MODEL", os.environ.get("PRIMARY_VISION_MODEL", "gpt-6-luna")).strip()

    if not base_url and not api_key:
        return None

    if not base_url:
        base_url = "https://api.openai.com/v1"

    url, payload, is_responses_api = build_primary_api_request(base_url, model, PROMPT, b64_image)

    headers = {
        "Content-Type": "application/json",
    }
    if api_key and api_key != "***":
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        
        # Auto-heal parameter rejection (temperature / max_tokens on reasoning models)
        if resp.status_code == 400:
            err_text = resp.text.lower()
            retry_needed = False

            if "temperature" in err_text and "temperature" in payload:
                payload.pop("temperature", None)
                retry_needed = True

            if "max_tokens" in err_text and "max_tokens" in payload:
                payload.pop("max_tokens", None)
                retry_needed = True

            if is_responses_api and ("input_text" in err_text or "input_image" in err_text or "format" in err_text):
                payload["input"] = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": PROMPT},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}}
                        ]
                    }
                ]
                retry_needed = True

            if retry_needed:
                resp = await client.post(url, json=payload, headers=headers)

        if resp.status_code >= 400:
            try:
                err_json = resp.json()
                err_msg = err_json.get("error", {}).get("message", resp.text)
            except Exception:
                err_msg = resp.text
            raise RuntimeError(f"Primary API returned HTTP {resp.status_code}: {err_msg}")

        resp.raise_for_status()
        res_json = resp.json()
        content = extract_text_from_api_response(res_json)
        return clean_json_response(content)


async def extract_via_ollama(b64_image: str) -> Dict[str, Any]:
    """Fallback extraction using local Ollama instance."""
    ollama_url = get_setting("OLLAMA_BASE_URL", os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")).strip()
    model = get_setting("OLLAMA_MODEL", os.environ.get("OLLAMA_MODEL", "gemma4:e2b")).strip()
    timeout = float(get_setting("OLLAMA_TIMEOUT_SECONDS", os.environ.get("OLLAMA_TIMEOUT_SECONDS", "180")))

    url = f"{ollama_url.rstrip('/')}/api/generate"
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [b64_image],
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 2048
        }
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            try:
                err_json = resp.json()
                err_msg = err_json.get("error", resp.text)
            except Exception:
                err_msg = resp.text
            raise RuntimeError(f"Ollama returned HTTP {resp.status_code}: {err_msg}")

        resp.raise_for_status()
        res_json = resp.json()
        content = res_json.get("response", "")
        return clean_json_response(content)


async def parse_receipt_image(filepath: str) -> Tuple[Dict[str, Any], str]:
    """
    Main extraction pipeline:
    Tries primary API first. If unconfigured or encounters an error, falls back to local Ollama.
    Returns: (parsed_data, used_engine)
    """
    b64_img = optimize_image_for_vision(filepath)

    primary_err = None
    # 1. Try Primary API
    try:
        primary_res = await extract_via_primary_api(b64_img)
        if primary_res:
            return primary_res, "Primary API"
    except Exception as e:
        primary_err = e
        print(f"[Extractor] Primary API failed ({e}), falling back to Ollama...")

    # 2. Local Ollama Fallback
    try:
        ollama_res = await extract_via_ollama(b64_img)
        return ollama_res, "Ollama Local (Gemma)"
    except Exception as e:
        print(f"[Extractor] Ollama fallback failed: {e}")
        err_msg = "All extraction methods failed."
        if primary_err:
            err_msg += f"\n• Primary API: {primary_err}"
        err_msg += f"\n• Ollama: {e}"
        raise RuntimeError(err_msg)
