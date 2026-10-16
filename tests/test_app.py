import os
import json
import pytest
from datetime import date, timedelta
from fastapi.testclient import TestClient

# Set test database path before importing app
os.environ["DB_PATH"] = "test_groceries.db"

from backend.main import app
from backend.db import init_db, save_receipt, get_receipt, get_receipts, delete_receipt
from backend.extractor import clean_json_response
from backend.analytics import calculate_consumption_metrics, get_reporting_summary

client = TestClient(app)


@pytest.fixture(autouse=True)
def cleanup_test_db():
    if os.path.exists("test_groceries.db"):
        os.remove("test_groceries.db")
    init_db()
    yield
    if os.path.exists("test_groceries.db"):
        os.remove("test_groceries.db")


def test_clean_json_response_with_markdown_fences():
    raw_response = """
    Here is the receipt data you requested:
    ```json
    {
      "provider": "Mercadona",
      "receipt_date": "2026-10-10",
      "currency": "EUR",
      "total_amount": 14.85,
      "items": [
        {
          "name": "LECHE ENTERA H",
          "clean_name": "Whole Milk 1L",
          "quantity": 3,
          "unit": "pack",
          "unit_price": 0.95,
          "total_price": 2.85,
          "category": "Dairy & Eggs"
        },
        {
          "name": "PLATANO CANARIAS",
          "clean_name": "Bananas",
          "quantity": 1.2,
          "unit": "kg",
          "unit_price": 1.99,
          "total_price": 2.39,
          "category": "Produce & Fresh"
        }
      ]
    }
    ```
    Have a nice day!
    """
    cleaned = clean_json_response(raw_response)
    assert cleaned["provider"] == "Mercadona"
    assert cleaned["receipt_date"] == "2026-10-10"
    assert len(cleaned["items"]) == 2
    assert cleaned["items"][0]["clean_name"] == "Whole Milk 1L"
    assert cleaned["items"][0]["quantity"] == 3.0
    assert cleaned["items"][1]["category"] == "Produce & Fresh"


def test_clean_json_response_with_missing_commas_and_glitches():
    # LLM output with missing comma between objects and trailing comma
    glitched_response = """
    {
      "provider": "Mercadona",
      "receipt_date": "2026-10-16",
      "items": [
        {
          "name": "Item 1",
          "quantity": 1,
          "total_price": 2.50
        }
        {
          "name": "Item 2",
          "quantity": 2,
          "total_price": 5.00,
        }
      ]
    }
    """
    cleaned = clean_json_response(glitched_response)
    assert cleaned["provider"] == "Mercadona"
    assert len(cleaned["items"]) == 2


def test_clean_json_response_truncated_stream_recovery():
    # Model hit max tokens and was cut off mid-stream
    truncated_response = """
    {
      "provider": "Mercadona",
      "receipt_date": "2026-10-16",
      "items": [
        {
          "name": "Item 1",
          "quantity": 1,
          "total_price": 2.50
        },
        {
          "name": "Item 2",
          "quantity": 2,
          "total_price": 5.00
        },
        {
          "name": "Item 3",
          "quantity": 1,
          "total_price
    """
    cleaned = clean_json_response(truncated_response)
    assert cleaned["provider"] == "Mercadona"
    # Should safely recover the 2 complete items before the cutoff
    assert len(cleaned["items"]) == 2
    assert cleaned["items"][1]["name"] == "Item 2"


def test_database_crud_and_endpoints():
    # 1. Test saving receipt
    payload = {
        "filename": "test_receipt_1.jpg",
        "provider": "Lidl",
        "receipt_date": "2026-10-01",
        "total_amount": 12.50,
        "currency": "EUR",
        "items": [
            {
                "name": "Oat Milk Barista",
                "clean_name": "Oat Milk",
                "quantity": 2.0,
                "unit": "L",
                "unit_price": 1.50,
                "total_price": 3.00,
                "category": "Dairy & Eggs"
            },
            {
                "name": "Sourdough Bread",
                "clean_name": "Bread",
                "quantity": 1.0,
                "unit": "unit",
                "unit_price": 2.20,
                "total_price": 2.20,
                "category": "Bakery & Bread"
            }
        ]
    }
    resp = client.post("/api/receipts/save", json=payload)
    assert resp.status_code == 200
    receipt_id = resp.json()["receipt_id"]
    assert receipt_id > 0

    # 2. Test fetching receipt details
    resp_get = client.get(f"/api/receipts/{receipt_id}")
    assert resp_get.status_code == 200
    rec = resp_get.json()["receipt"]
    assert rec["provider"] == "Lidl"
    assert len(rec["items"]) == 2

    # 3. Test list receipts
    resp_list = client.get("/api/receipts")
    assert resp_list.status_code == 200
    assert len(resp_list.json()["receipts"]) == 1


def test_consumption_estimator_burn_rates():
    # Insert two sequential purchases of Milk 7 days apart
    p1 = {
        "filename": "receipt_week1.jpg",
        "provider": "Mercadona",
        "receipt_date": "2026-10-01",
        "total_amount": 4.00,
        "items": [
            {
                "name": "Milk",
                "clean_name": "Whole Milk 1L",
                "quantity": 7.0,
                "unit": "L",
                "unit_price": 1.00,
                "total_price": 7.00,
                "category": "Dairy & Eggs"
            }
        ]
    }
    p2 = {
        "filename": "receipt_week2.jpg",
        "provider": "Mercadona",
        "receipt_date": "2026-10-08",
        "total_amount": 4.00,
        "items": [
            {
                "name": "Milk",
                "clean_name": "Whole Milk 1L",
                "quantity": 7.0,
                "unit": "L",
                "unit_price": 1.00,
                "total_price": 7.00,
                "category": "Dairy & Eggs"
            }
        ]
    }
    save_receipt(p1)
    save_receipt(p2)

    # Calculate metrics referencing 2026-10-10 (2 days after purchase 2)
    metrics = calculate_consumption_metrics(reference_date="2026-10-10")
    assert len(metrics) == 1
    milk = metrics[0]

    # In 7 days span (Oct 1 to Oct 8), batch 1 of 7 liters was consumed => 1 L/day
    assert milk["daily_consumption"] == 1.0
    assert milk["weekly_consumption"] == 7.0
    assert milk["monthly_consumption"] == 30.4
    # On Oct 10 (2 days elapsed since Oct 8 batch of 7), 5 remaining, ~5 days left
    assert milk["estimated_stock_remaining"] == 5.0
    assert milk["estimated_days_left"] == 5.0
    assert milk["status"] == "ok"


def test_reports_aggregation():
    save_receipt({
        "filename": "r1.jpg",
        "provider": "Carrefour",
        "receipt_date": "2026-10-05",
        "total_amount": 25.00,
        "items": [
            {"name": "Apples", "clean_name": "Apples", "quantity": 2, "unit": "kg", "unit_price": 2.5, "total_price": 5.0, "category": "Produce & Fresh"},
            {"name": "Coffee Beans", "clean_name": "Coffee", "quantity": 1, "unit": "pack", "unit_price": 8.0, "total_price": 8.0, "category": "Beverages & Drinks"},
        ]
    })

    summary = get_reporting_summary()
    assert summary["totals"]["total_receipts"] == 1
    assert summary["totals"]["grand_total_spend"] == 13.0
    assert len(summary["by_provider"]) == 1
    assert summary["by_provider"][0]["provider"] == "Carrefour"
    assert len(summary["by_category"]) == 2


def test_test_primary_api_endpoint_empty():
    # When no key or base url is provided, returns helpful failure message
    resp = client.post("/api/settings/test-primary", json={"base_url": "", "api_key": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is False
    assert "Neither API Base URL nor API Key" in data["message"]


def test_test_ollama_endpoint():
    resp = client.post("/api/settings/test-ollama", json={"base_url": "http://127.0.0.1:11434", "model": "gemma4:e2b"})
    assert resp.status_code == 200
    data = resp.json()
    assert "success" in data


def test_build_primary_api_request_opencode_responses_url():
    from backend.extractor import build_primary_api_request, extract_text_from_api_response

    # Test 1: OpenCode /responses endpoint should NOT have /chat/completions appended
    url, payload, is_responses = build_primary_api_request(
        base_url="https://opencode.ai/inference/v1/responses",
        model="gpt-5.5",
        prompt="Analyze receipt",
        b64_image="fakebase64data"
    )
    assert url == "https://opencode.ai/inference/v1/responses"
    assert is_responses is True
    assert "input" in payload
    assert payload["input"][0]["role"] == "user"

    # Test 2: Standard base URL should resolve to /chat/completions
    url2, payload2, is_responses2 = build_primary_api_request(
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        prompt="Analyze receipt",
        b64_image="fakebase64data"
    )
    assert url2 == "https://api.openai.com/v1/chat/completions"
    assert is_responses2 is False
    assert "messages" in payload2

    # Test 3: Responses API format parsing
    resp_data_1 = {"output_text": "{\"provider\": \"TestStore\"}"}
    assert extract_text_from_api_response(resp_data_1) == "{\"provider\": \"TestStore\"}"

    resp_data_2 = {"output": [{"content": [{"text": "{\"provider\": \"TestStore2\"}"}]}]}
    assert extract_text_from_api_response(resp_data_2) == "{\"provider\": \"TestStore2\"}"

    # Test 4: Reasoning model with reasoning items followed by message item
    resp_data_3 = {
        "output": [
            {"id": "rs_1", "type": "reasoning", "content": []},
            {"id": "rs_2", "type": "reasoning", "content": []},
            {
                "id": "msg_1",
                "type": "message",
                "content": [{"type": "output_text", "text": "{\"provider\": \"Mercadona\"}"}]
            }
        ]
    }
    # Test 5: Google AI Studio Gemini OpenAI-compatible endpoint resolution
    url_gemini, payload_gemini, is_resp_gemini = build_primary_api_request(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-2.0-flash",
        prompt="Analyze receipt",
        b64_image="fakebase64data"
    )
    assert url_gemini == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert is_resp_gemini is False
    assert "messages" in payload_gemini


def test_duplicate_receipt_detection_via_invoice_id():
    from backend.db import get_receipt_by_invoice_id

    # 1. Save initial receipt with invoice ID
    p1 = {
        "filename": "scan_A.jpg",
        "provider": "Mercadona",
        "receipt_date": "2026-10-10",
        "total_amount": 15.00,
        "invoice_id": "3572-016-394107",
        "items": [
            {"name": "Milk", "clean_name": "Milk", "quantity": 1.0, "unit": "L", "unit_price": 1.5, "total_price": 1.5, "category": "Dairy & Eggs"}
        ]
    }
    resp1 = client.post("/api/receipts/save", json=p1)
    assert resp1.status_code == 200
    id1 = resp1.json()["receipt_id"]

    # 2. Query by invoice_id
    found = get_receipt_by_invoice_id("3572-016-394107", "Mercadona")
    assert found is not None
    assert found["id"] == id1
    assert found["filename"] == "scan_A.jpg"
    assert found["invoice_id"] == "3572-016-394107"

    # 3. Saving another file with the same invoice_id updates/merges the existing receipt
    p2 = {
        "filename": "scan_B_duplicate.jpg",
        "provider": "Mercadona",
        "receipt_date": "2026-10-10",
        "total_amount": 15.00,
        "invoice_id": "3572-016-394107",
        "items": [
            {"name": "Milk", "clean_name": "Milk", "quantity": 1.0, "unit": "L", "unit_price": 1.5, "total_price": 1.5, "category": "Dairy & Eggs"}
        ]
    }
    resp2 = client.post("/api/receipts/save", json=p2)
    assert resp2.status_code == 200
    id2 = resp2.json()["receipt_id"]
    # Should update the existing record rather than creating a duplicate
    assert id2 == id1

    # Verify total receipt count in database is still 1
    resp_list = client.get("/api/receipts")
    assert len(resp_list.json()["receipts"]) == 1


