import os
import io
import csv
import json
import time
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend.db import (
    init_db,
    save_receipt,
    get_receipts,
    get_receipt,
    get_receipt_by_filename,
    delete_receipt,
    get_all_categories,
    get_distinct_providers,
    get_setting,
    set_setting,
)
from backend.extractor import (
    parse_receipt_image,
    DEFAULT_CATEGORIES,
    build_primary_api_request,
    extract_text_from_api_response,
)
from backend.analytics import calculate_consumption_metrics, get_reporting_summary

# Initialize DB on import
init_db()

RECEIPTS_DIR = Path(os.environ.get("RECEIPTS_DIR", "receipts"))
RECEIPTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Grocery Replenishment & Receipt Tracker API",
    description="Local receipt scanner, reporting, and consumption estimator",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic Schemas
class ItemSchema(BaseModel):
    name: str
    clean_name: Optional[str] = None
    quantity: float = 1.0
    unit: str = "unit"
    unit_price: float = 0.0
    total_price: float = 0.0
    category: str = "Other"
    notes: Optional[str] = ""


class ReceiptSaveSchema(BaseModel):
    filename: str
    provider: str
    receipt_date: str
    total_amount: float
    currency: str = "EUR"
    notes: Optional[str] = ""
    status: str = "confirmed"
    items: List[ItemSchema] = []
    raw_json: Optional[Dict[str, Any]] = None


class SettingsSchema(BaseModel):
    primary_api_base_url: Optional[str] = None
    primary_api_key: Optional[str] = None
    primary_vision_model: Optional[str] = None
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    ollama_timeout_seconds: Optional[str] = None


class TestPrimaryApiSchema(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None


class TestOllamaSchema(BaseModel):
    base_url: Optional[str] = None
    model: Optional[str] = None


# Endpoints
@app.get("/api/receipts/files")
def list_receipt_files():
    """Scan the /receipts folder and compare with DB records."""
    valid_exts = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
    files = []

    if RECEIPTS_DIR.exists():
        for f in RECEIPTS_DIR.iterdir():
            if f.is_file() and f.suffix.lower() in valid_exts:
                stat = f.stat()
                existing = get_receipt_by_filename(f.name)
                files.append({
                    "filename": f.name,
                    "size_bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    "status": "saved" if existing else "unprocessed",
                    "receipt_id": existing["id"] if existing else None,
                    "provider": existing["provider"] if existing else None,
                    "receipt_date": existing["receipt_date"] if existing else None,
                    "total_amount": existing["total_amount"] if existing else None,
                    "item_count": len(existing["items"]) if existing else 0,
                })

    files.sort(key=lambda x: x["filename"], reverse=True)
    return {"files": files, "count": len(files)}


@app.post("/api/receipts/parse/{filename}")
async def parse_receipt(filename: str):
    """Run the hybrid extraction pipeline on a receipt image."""
    filepath = RECEIPTS_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail=f"File {filename} not found in receipts directory")

    try:
        parsed_data, engine = await parse_receipt_image(str(filepath))
        parsed_data["filename"] = filename
        return {"data": parsed_data, "engine": engine}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")


@app.post("/api/receipts/save")
def save_receipt_record(payload: ReceiptSaveSchema):
    """Persist receipt and items into SQLite."""
    try:
        data = payload.model_dump()
        receipt_id = save_receipt(data)
        return {"success": True, "receipt_id": receipt_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save receipt: {str(e)}")


@app.get("/api/receipts")
def list_receipts(limit: int = 100, offset: int = 0):
    """Get list of confirmed receipts from the database."""
    return {"receipts": get_receipts(limit=limit, offset=offset)}


@app.get("/api/receipts/{receipt_id}")
def get_receipt_details(receipt_id: int):
    """Get single receipt with items."""
    receipt = get_receipt(receipt_id)
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return {"receipt": receipt}


@app.delete("/api/receipts/{receipt_id}")
def remove_receipt(receipt_id: int):
    """Delete receipt and associated items."""
    success = delete_receipt(receipt_id)
    return {"success": success}


@app.get("/api/reports")
def get_reports(
    provider: Optional[str] = None,
    category: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """Aggregate analytics for reports."""
    summary = get_reporting_summary(
        provider=provider,
        category=category,
        date_from=date_from,
        date_to=date_to,
    )
    return summary


@app.get("/api/reports/export")
def export_reports(
    format: str = Query("csv", pattern="^(csv|json)$"),
    provider: Optional[str] = None,
    category: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """Export items report as CSV or JSON."""
    summary = get_reporting_summary(
        provider=provider,
        category=category,
        date_from=date_from,
        date_to=date_to,
    )
    items = summary.get("by_item", [])

    if format == "json":
        content = json.dumps(summary, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=grocery_report.json"}
        )

    # Format as CSV
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Item Name", "Category", "Unit", "Purchase Count",
        "Total Quantity", "Total Cost (EUR)", "Avg Unit Price (EUR)", "Last Purchased"
    ])
    for item in items:
        writer.writerow([
            item.get("clean_name", ""),
            item.get("category", ""),
            item.get("unit", ""),
            item.get("purchase_count", 0),
            item.get("total_quantity", 0.0),
            item.get("total_cost", 0.0),
            item.get("avg_unit_price", 0.0),
            item.get("last_purchased", "")
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=grocery_items_report.csv"}
    )


@app.get("/api/consumption")
def get_consumption(reference_date: Optional[str] = None):
    """Calculate daily, weekly, monthly consumption rates and replenishment projection."""
    metrics = calculate_consumption_metrics(reference_date=reference_date)
    return {"metrics": metrics}


@app.get("/api/categories")
def list_categories():
    """List available categories."""
    return {"categories": get_all_categories(), "defaults": DEFAULT_CATEGORIES}


@app.get("/api/providers")
def list_providers():
    """List distinct supermarket providers."""
    return {"providers": get_distinct_providers()}


@app.get("/api/settings")
def get_settings():
    """Retrieve current system settings."""
    return {
        "primary_api_base_url": get_setting("PRIMARY_API_BASE_URL", os.environ.get("PRIMARY_API_BASE_URL", "")),
        "primary_api_key": "***" if get_setting("PRIMARY_API_KEY", os.environ.get("PRIMARY_API_KEY", "")) else "",
        "primary_vision_model": get_setting("PRIMARY_VISION_MODEL", os.environ.get("PRIMARY_VISION_MODEL", "gpt-4o-mini")),
        "ollama_base_url": get_setting("OLLAMA_BASE_URL", os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")),
        "ollama_model": get_setting("OLLAMA_MODEL", os.environ.get("OLLAMA_MODEL", "gemma4:e2b")),
        "ollama_timeout_seconds": get_setting("OLLAMA_TIMEOUT_SECONDS", os.environ.get("OLLAMA_TIMEOUT_SECONDS", "180")),
    }


@app.post("/api/settings")
def update_settings(payload: SettingsSchema):
    """Save updated system settings."""
    if payload.primary_api_base_url is not None:
        set_setting("PRIMARY_API_BASE_URL", payload.primary_api_base_url.strip())
    if payload.primary_api_key is not None and payload.primary_api_key != "***":
        set_setting("PRIMARY_API_KEY", payload.primary_api_key.strip())
    if payload.primary_vision_model is not None:
        set_setting("PRIMARY_VISION_MODEL", payload.primary_vision_model.strip())
    if payload.ollama_base_url is not None:
        set_setting("OLLAMA_BASE_URL", payload.ollama_base_url.strip())
    if payload.ollama_model is not None:
        set_setting("OLLAMA_MODEL", payload.ollama_model.strip())
    if payload.ollama_timeout_seconds is not None:
        set_setting("OLLAMA_TIMEOUT_SECONDS", str(payload.ollama_timeout_seconds).strip())
    return {"success": True}


@app.post("/api/settings/test-primary")
async def test_primary_api(payload: TestPrimaryApiSchema):
    """Test connection and inference with the configured Primary Vision API."""
    base_url = (payload.base_url or get_setting("PRIMARY_API_BASE_URL", os.environ.get("PRIMARY_API_BASE_URL", "")) or "").strip()
    
    api_key = payload.api_key.strip() if payload.api_key else ""
    if not api_key or api_key == "***":
        api_key = (get_setting("PRIMARY_API_KEY", os.environ.get("PRIMARY_API_KEY", "")) or "").strip()
        
    model = (payload.model or get_setting("PRIMARY_VISION_MODEL", os.environ.get("PRIMARY_VISION_MODEL", "gpt-4o-mini")) or "gpt-4o-mini").strip()

    if not base_url and not api_key:
        return {"success": False, "message": "Neither API Base URL nor API Key is provided or configured."}

    if not base_url:
        base_url = "https://api.openai.com/v1"

    url, req_payload, is_responses_api = build_primary_api_request(
        base_url=base_url,
        model=model,
        prompt="Respond with 'OK' if you can read this.",
        b64_image=None
    )

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    start_time = time.time()
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(url, json=req_payload, headers=headers)
            
            # Auto-heal parameter rejection (temperature / max_tokens on reasoning models like gpt-6-luna)
            if resp.status_code == 400:
                err_text = resp.text.lower()
                retry_needed = False
                if "temperature" in err_text and "temperature" in req_payload:
                    req_payload.pop("temperature", None)
                    retry_needed = True
                if "max_tokens" in err_text and "max_tokens" in req_payload:
                    req_payload.pop("max_tokens", None)
                    retry_needed = True
                if retry_needed:
                    resp = await client.post(url, json=req_payload, headers=headers)

            elapsed = round((time.time() - start_time) * 1000)
            
            if resp.status_code >= 400:
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("error", {}).get("message", resp.text)
                except Exception:
                    err_msg = resp.text
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "message": f"API returned HTTP {resp.status_code} for {url}: {err_msg}"
                }

            data = resp.json()
            reply = extract_text_from_api_response(data).strip()
            return {
                "success": True,
                "latency_ms": elapsed,
                "model": model,
                "reply": reply,
                "message": f"Connected to {model} via {url} ({elapsed}ms). Response: '{reply}'"
            }
    except httpx.ConnectError:
        return {"success": False, "message": f"Could not connect to {url}. Please verify URL host and port."}
    except httpx.TimeoutException:
        return {"success": False, "message": f"Connection to {url} timed out after 25s."}
    except Exception as e:
        return {"success": False, "message": f"Connection failed: {str(e)}"}


@app.post("/api/settings/test-ollama")
async def test_ollama(payload: TestOllamaSchema):
    """Test connection and model availability with the local Ollama instance."""
    ollama_url = (payload.base_url or get_setting("OLLAMA_BASE_URL", os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")) or "http://127.0.0.1:11434").strip()
    model = (payload.model or get_setting("OLLAMA_MODEL", os.environ.get("OLLAMA_MODEL", "gemma4:e2b")) or "gemma4:e2b").strip()

    url = f"{ollama_url.rstrip('/')}/api/tags"
    start_time = time.time()
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(url)
            elapsed = round((time.time() - start_time) * 1000)
            if resp.status_code != 200:
                return {"success": False, "message": f"Ollama returned HTTP {resp.status_code}"}
            
            data = resp.json()
            models = [m.get("name") for m in data.get("models", [])]
            model_found = any(m == model or m.startswith(model.split(":")[0]) for m in models)
            
            msg = f"Ollama is online ({elapsed}ms). Available models: {', '.join(models) if models else 'None'}."
            if model_found:
                msg += f" Target model '{model}' is installed and ready!"
            else:
                msg += f" Notice: Target model '{model}' not found in installed list."
                
            return {
                "success": True,
                "latency_ms": elapsed,
                "models": models,
                "model_found": model_found,
                "message": msg
            }
    except httpx.ConnectError:
        return {"success": False, "message": f"Ollama is offline or unreachable at {ollama_url}."}
    except httpx.TimeoutException:
        return {"success": False, "message": f"Connection to Ollama at {ollama_url} timed out."}
    except Exception as e:
        return {"success": False, "message": f"Ollama check failed: {str(e)}"}


@app.get("/api/receipt-image/{filename}")
def serve_receipt_image(filename: str):
    """Serve a receipt image securely from /receipts."""
    filepath = RECEIPTS_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="Receipt image not found")
    return FileResponse(filepath)


# Serve frontend static files
FRONTEND_DIR = Path("frontend")
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
