import sqlite3
import os
import json
from datetime import datetime
from typing import List, Dict, Any, Optional

DB_PATH = os.environ.get("DB_PATH", "groceries.db")

DEFAULT_CATEGORIES = [
    {"name": "Produce & Fresh", "icon": "🥦", "color": "#10B981"},
    {"name": "Dairy & Eggs", "icon": "🧀", "color": "#F59E0B"},
    {"name": "Bakery & Bread", "icon": "🥖", "color": "#D97706"},
    {"name": "Meat & Seafood", "icon": "🥩", "color": "#EF4444"},
    {"name": "Pantry & Dry Goods", "icon": "🍚", "color": "#8B5CF6"},
    {"name": "Beverages & Drinks", "icon": "☕", "color": "#3B82F6"},
    {"name": "Snacks & Sweets", "icon": "🍪", "color": "#EC4899"},
    {"name": "Frozen Foods", "icon": "🧊", "color": "#06B6D4"},
    {"name": "Household & Cleaning", "icon": "🧼", "color": "#14B8A6"},
    {"name": "Personal Care", "icon": "🧴", "color": "#6366F1"},
    {"name": "Other", "icon": "📦", "color": "#64748B"},
]


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db_connection()
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS receipts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE NOT NULL,
                file_hash TEXT,
                provider TEXT NOT NULL,
                receipt_date TEXT NOT NULL,
                total_amount REAL NOT NULL,
                currency TEXT DEFAULT 'EUR',
                status TEXT DEFAULT 'confirmed',
                raw_json TEXT,
                notes TEXT,
                invoice_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Ensure invoice_id column exists if table already existed
        cols = [r[1] for r in conn.execute("PRAGMA table_info(receipts)").fetchall()]
        if "invoice_id" not in cols:
            conn.execute("ALTER TABLE receipts ADD COLUMN invoice_id TEXT")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS receipt_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                clean_name TEXT NOT NULL,
                quantity REAL NOT NULL DEFAULT 1.0,
                unit TEXT DEFAULT 'unit',
                unit_price REAL NOT NULL DEFAULT 0.0,
                total_price REAL NOT NULL DEFAULT 0.0,
                category TEXT DEFAULT 'Other',
                notes TEXT
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                icon TEXT,
                color TEXT
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS stock_audits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_date TEXT NOT NULL,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS stock_audit_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_id INTEGER NOT NULL REFERENCES stock_audits(id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                item_name TEXT NOT NULL,
                quantity REAL NOT NULL DEFAULT 0.0,
                unit TEXT DEFAULT 'unit',
                status TEXT DEFAULT 'in_stock',
                notes TEXT
            )
        """)

        # Seed categories if empty
        cur = conn.execute("SELECT COUNT(*) FROM categories")
        if cur.fetchone()[0] == 0:
            for cat in DEFAULT_CATEGORIES:
                conn.execute(
                    "INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)",
                    (cat["name"], cat["icon"], cat["color"])
                )

    conn.close()


def save_receipt(receipt_data: Dict[str, Any]) -> int:
    """Save or update receipt and all associated items inside a transaction."""
    conn = get_db_connection()
    with conn:
        filename = receipt_data.get("filename")
        provider = receipt_data.get("provider", "Unknown Provider")
        receipt_date = receipt_data.get("receipt_date", datetime.today().strftime("%Y-%m-%d"))
        total_amount = float(receipt_data.get("total_amount", 0.0))
        currency = receipt_data.get("currency", "EUR")
        status = receipt_data.get("status", "confirmed")
        notes = receipt_data.get("notes", "")
        raw_json = json.dumps(receipt_data.get("raw_json", {}))
        file_hash = receipt_data.get("file_hash", "")
        raw_inv = receipt_data.get("invoice_id")
        invoice_id = str(raw_inv).strip() if raw_inv is not None else None
        if invoice_id and invoice_id.lower() in ("null", "none", "n/a", "undefined", ""):
            invoice_id = None

        # Check existing receipt by filename, or by (invoice_id, provider)
        existing = None
        if filename:
            existing = conn.execute("SELECT id FROM receipts WHERE filename = ?", (filename,)).fetchone()
        if not existing and invoice_id:
            existing = conn.execute(
                "SELECT id FROM receipts WHERE invoice_id = ? AND provider = ?",
                (invoice_id, provider)
            ).fetchone()

        if existing:
            receipt_id = existing["id"]
            conn.execute("""
                UPDATE receipts
                SET filename = ?, provider = ?, receipt_date = ?, total_amount = ?, currency = ?,
                    status = ?, notes = ?, raw_json = ?, file_hash = ?, invoice_id = ?
                WHERE id = ?
            """, (filename, provider, receipt_date, total_amount, currency, status, notes, raw_json, file_hash, invoice_id, receipt_id))
            # Delete old items to cleanly overwrite
            conn.execute("DELETE FROM receipt_items WHERE receipt_id = ?", (receipt_id,))
        else:
            cur = conn.execute("""
                INSERT INTO receipts (filename, file_hash, provider, receipt_date, total_amount, currency, status, notes, raw_json, invoice_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (filename, file_hash, provider, receipt_date, total_amount, currency, status, notes, raw_json, invoice_id))
            receipt_id = cur.lastrowid

        # Insert items
        items = receipt_data.get("items", [])
        for item in items:
            name = item.get("name", "Unnamed Item").strip()
            clean_name = item.get("clean_name", name).strip()
            quantity = float(item.get("quantity", 1.0) or 1.0)
            unit = item.get("unit", "unit") or "unit"
            unit_price = float(item.get("unit_price", 0.0) or 0.0)
            total_price = float(item.get("total_price", unit_price * quantity) or 0.0)
            category = item.get("category", "Other") or "Other"
            item_notes = item.get("notes", "")

            conn.execute("""
                INSERT INTO receipt_items (receipt_id, name, clean_name, quantity, unit, unit_price, total_price, category, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (receipt_id, name, clean_name, quantity, unit, unit_price, total_price, category, item_notes))

    conn.close()
    return receipt_id


def get_receipt_by_invoice_id(invoice_id: str, provider: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Lookup receipt by invoice ID, optionally filtered by provider."""
    if not invoice_id:
        return None
    conn = get_db_connection()
    clean_id = invoice_id.strip()
    if provider:
        cur = conn.execute("SELECT * FROM receipts WHERE invoice_id = ? AND provider = ?", (clean_id, provider.strip()))
    else:
        cur = conn.execute("SELECT * FROM receipts WHERE invoice_id = ?", (clean_id,))
    receipt = cur.fetchone()
    if not receipt:
        conn.close()
        return None
    receipt_dict = dict(receipt)
    cur_items = conn.execute("SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id ASC", (receipt_dict["id"],))
    receipt_dict["items"] = [dict(item) for item in cur_items.fetchall()]
    conn.close()
    return receipt_dict


def get_receipts(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("""
        SELECT r.*, COUNT(i.id) as item_count
        FROM receipts r
        LEFT JOIN receipt_items i ON r.id = i.receipt_id
        GROUP BY r.id
        ORDER BY r.receipt_date DESC, r.id DESC
        LIMIT ? OFFSET ?
    """, (limit, offset))
    rows = [dict(row) for row in cur.fetchall()]
    conn.close()
    return rows


def get_receipt(receipt_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("SELECT * FROM receipts WHERE id = ?", (receipt_id,))
    receipt = cur.fetchone()
    if not receipt:
        conn.close()
        return None

    receipt_dict = dict(receipt)
    cur_items = conn.execute("SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id ASC", (receipt_id,))
    receipt_dict["items"] = [dict(item) for item in cur_items.fetchall()]
    conn.close()
    return receipt_dict


def get_receipt_by_filename(filename: str) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("SELECT * FROM receipts WHERE filename = ?", (filename,))
    receipt = cur.fetchone()
    if not receipt:
        conn.close()
        return None
    receipt_dict = dict(receipt)
    cur_items = conn.execute("SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id ASC", (receipt_dict["id"],))
    receipt_dict["items"] = [dict(item) for item in cur_items.fetchall()]
    conn.close()
    return receipt_dict


def delete_receipt(receipt_id: int) -> bool:
    conn = get_db_connection()
    with conn:
        conn.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
    conn.close()
    return True


def get_all_categories() -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("SELECT * FROM categories ORDER BY name ASC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def get_distinct_providers() -> List[str]:
    conn = get_db_connection()
    cur = conn.execute("SELECT DISTINCT provider FROM receipts WHERE provider IS NOT NULL AND provider != '' ORDER BY provider ASC")
    rows = [r["provider"] for r in cur.fetchall()]
    conn.close()
    return rows


def get_parsed_receipt_items() -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("""
        SELECT 
            i.category,
            i.clean_name as item_name,
            i.unit,
            COUNT(i.id) as times_bought,
            MAX(r.receipt_date) as last_purchased,
            ROUND(AVG(i.quantity), 1) as avg_quantity
        FROM receipt_items i
        JOIN receipts r ON i.receipt_id = r.id
        WHERE i.clean_name IS NOT NULL AND TRIM(i.clean_name) != ''
        GROUP BY i.category, i.clean_name
        ORDER BY i.category ASC, i.clean_name ASC
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    conn = get_db_connection()
    cur = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
    row = cur.fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key: str, value: str):
    conn = get_db_connection()
    with conn:
        conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", (key, value))
    conn.close()


def save_stock_audit(audit_date: str, notes: str, items: List[Dict[str, Any]]) -> int:
    conn = get_db_connection()
    with conn:
        cur = conn.execute(
            "INSERT INTO stock_audits (audit_date, notes) VALUES (?, ?)",
            (audit_date, notes)
        )
        audit_id = cur.lastrowid
        for item in items:
            item_name = str(item.get("item_name", "")).strip()
            if not item_name:
                continue
            category = str(item.get("category", "Other")).strip()
            try:
                qty = float(item.get("quantity", 0.0))
            except (ValueError, TypeError):
                qty = 0.0
            unit = str(item.get("unit", "unit")).strip()
            status = str(item.get("status", "in_stock")).strip()
            item_notes = str(item.get("notes", "")).strip()
            conn.execute("""
                INSERT INTO stock_audit_items (audit_id, category, item_name, quantity, unit, status, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (audit_id, category, item_name, qty, unit, status, item_notes))
    conn.close()
    return audit_id


def get_stock_audits() -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("""
        SELECT a.id, a.audit_date, a.notes, a.created_at,
               COUNT(i.id) as item_count,
               COUNT(DISTINCT i.category) as category_count,
               SUM(CASE WHEN i.status = 'in_stock' THEN 1 ELSE 0 END) as in_stock_count,
               SUM(CASE WHEN i.status = 'low' THEN 1 ELSE 0 END) as low_stock_count,
               SUM(CASE WHEN i.status = 'out_of_stock' THEN 1 ELSE 0 END) as out_of_stock_count
        FROM stock_audits a
        LEFT JOIN stock_audit_items i ON a.id = i.audit_id
        GROUP BY a.id
        ORDER BY a.audit_date DESC, a.id DESC
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def get_stock_audit(audit_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("SELECT * FROM stock_audits WHERE id = ?", (audit_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    audit = dict(row)
    cur_items = conn.execute("SELECT * FROM stock_audit_items WHERE audit_id = ? ORDER BY category ASC, item_name ASC", (audit_id,))
    audit["items"] = [dict(item) for item in cur_items.fetchall()]
    conn.close()
    return audit


def get_latest_stock_audit() -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cur = conn.execute("SELECT id FROM stock_audits ORDER BY audit_date DESC, id DESC LIMIT 1")
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return get_stock_audit(row["id"])


def delete_stock_audit(audit_id: int) -> bool:
    conn = get_db_connection()
    with conn:
        conn.execute("DELETE FROM stock_audits WHERE id = ?", (audit_id,))
    conn.close()
    return True

