import sqlite3
from datetime import datetime, date
from typing import Dict, Any, List, Optional
from backend.db import get_db_connection


def calculate_consumption_metrics(reference_date: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Computes consumption metrics per item:
    - Daily, Weekly, Monthly consumption rates
    - Estimated days remaining & run-out date
    - Restock urgency status: 'ok', 'low', 'overdue'
    """
    ref_dt = datetime.strptime(reference_date, "%Y-%m-%d").date() if reference_date else date.today()

    conn = get_db_connection()
    cur = conn.execute("""
        SELECT 
            i.clean_name,
            i.category,
            i.unit,
            i.quantity,
            i.total_price,
            i.unit_price,
            r.receipt_date,
            r.provider
        FROM receipt_items i
        JOIN receipts r ON i.receipt_id = r.id
        ORDER BY r.receipt_date ASC, i.id ASC
    """)
    rows = cur.fetchall()

    # Group by clean_name (case-insensitive normalized)
    items_map: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        key = r["clean_name"].strip().lower()
        if key not in items_map:
            items_map[key] = {
                "clean_name": r["clean_name"].strip(),
                "category": r["category"],
                "unit": r["unit"] or "unit",
                "purchases": [],
                "total_quantity": 0.0,
                "total_spend": 0.0,
                "providers": set(),
            }
        p_date = datetime.strptime(r["receipt_date"][:10], "%Y-%m-%d").date()
        items_map[key]["purchases"].append({
            "date": p_date,
            "quantity": float(r["quantity"]),
            "unit_price": float(r["unit_price"]),
            "total_price": float(r["total_price"]),
            "provider": r["provider"]
        })
        items_map[key]["total_quantity"] += float(r["quantity"])
        items_map[key]["total_spend"] += float(r["total_price"])
        if r["provider"]:
            items_map[key]["providers"].add(r["provider"])

    # Fetch latest stock audit items
    latest_audits: Dict[str, Dict[str, Any]] = {}
    try:
        cur_audits = conn.execute("""
            SELECT 
                i.item_name,
                i.category,
                i.quantity as audit_quantity,
                i.unit as audit_unit,
                i.status as audit_status,
                a.audit_date,
                a.created_at as audit_created_at
            FROM stock_audit_items i
            JOIN stock_audits a ON i.audit_id = a.id
            ORDER BY a.audit_date DESC, a.id DESC
        """)
        for ar in cur_audits.fetchall():
            k = ar["item_name"].strip().lower()
            if k not in latest_audits:
                audit_dt = datetime.strptime(ar["audit_date"][:10], "%Y-%m-%d").date()
                latest_audits[k] = {
                    "item_name": ar["item_name"].strip(),
                    "category": ar["category"],
                    "quantity": float(ar["audit_quantity"]),
                    "unit": ar["audit_unit"],
                    "status": ar["audit_status"],
                    "date": audit_dt,
                    "date_str": ar["audit_date"][:10],
                }
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()

    results = []

    for key, data in items_map.items():
        purchases = data["purchases"]
        purchases.sort(key=lambda x: x["date"])
        n = len(purchases)
        first_date = purchases[0]["date"]
        last_date = purchases[-1]["date"]
        days_span = (last_date - first_date).days
        days_since_last = (ref_dt - last_date).days

        # Determine daily burn rate
        if n > 1 and days_span > 0:
            # We consumed batches 1 .. n-1 over days_span
            consumed_in_span = sum(p["quantity"] for p in purchases[:-1])
            if consumed_in_span > 0:
                daily_rate = consumed_in_span / days_span
            else:
                daily_rate = data["total_quantity"] / (days_span + (days_span / (n - 1)))
        else:
            # Single purchase or same-day purchases:
            # Estimate using elapsed time or category defaults
            qty = data["total_quantity"]
            if days_since_last > 0:
                daily_rate = qty / max(days_since_last, 7.0)
            else:
                # Same day default: assume typical grocery replenishment cycle of 7-14 days
                default_cycle_days = 7.0 if "Dairy" in data["category"] or "Produce" in data["category"] or "Bakery" in data["category"] else 14.0
                daily_rate = qty / default_cycle_days

        daily_rate = round(daily_rate, 3)
        weekly_rate = round(daily_rate * 7, 2)
        monthly_rate = round(daily_rate * 30.4, 2)

        # Check if a physical stock audit exists
        audit_info = latest_audits.get(key)
        
        # If an audit was conducted on or after the last purchase date, use it as baseline
        if audit_info and audit_info["date"] >= last_date:
            stock_source = "audit"
            audit_qty = audit_info["quantity"]
            days_since_audit = (ref_dt - audit_info["date"]).days
            
            if audit_info["status"] == "out_of_stock" or audit_qty <= 0:
                remaining_qty = 0.0
                days_left = 0.0
                status = "overdue"
                status_text = "Restock Needed"
            else:
                consumed_since_audit = (days_since_audit * daily_rate) if (days_since_audit > 0 and daily_rate > 0) else 0.0
                remaining_qty = max(0.0, round(audit_qty - consumed_since_audit, 2))
                
                if remaining_qty <= 0:
                    days_left = 0.0
                    status = "overdue"
                    status_text = "Restock Needed"
                elif daily_rate > 0:
                    days_left = round(remaining_qty / daily_rate, 1)
                    if audit_info["status"] == "low" or days_left <= 3:
                        status = "low"
                        status_text = "Running Low"
                    else:
                        status = "ok"
                        status_text = "Sufficient"
                else:
                    days_left = 999.0
                    status = "low" if audit_info["status"] == "low" else "ok"
                    status_text = "Running Low" if status == "low" else "Sufficient"
        else:
            stock_source = "receipt_estimate"
            latest_qty = purchases[-1]["quantity"]
            if daily_rate > 0:
                consumed_since_last = days_since_last * daily_rate
                remaining_qty = max(0.0, round(latest_qty - consumed_since_last, 2))
                days_left = round(remaining_qty / daily_rate, 1) if remaining_qty > 0 else 0.0
            else:
                remaining_qty = latest_qty
                days_left = 999.0

            if days_left <= 0:
                status = "overdue"
                status_text = "Restock Needed"
            elif days_left <= 3:
                status = "low"
                status_text = "Running Low"
            else:
                status = "ok"
                status_text = "Sufficient"

        avg_price = round(data["total_spend"] / data["total_quantity"], 2) if data["total_quantity"] > 0 else 0.0

        results.append({
            "clean_name": data["clean_name"],
            "category": data["category"],
            "unit": data["unit"],
            "purchase_count": n,
            "total_quantity": round(data["total_quantity"], 2),
            "total_spend": round(data["total_spend"], 2),
            "avg_unit_price": avg_price,
            "first_purchase_date": first_date.strftime("%Y-%m-%d"),
            "last_purchase_date": last_date.strftime("%Y-%m-%d"),
            "days_since_last": days_since_last,
            "daily_consumption": daily_rate,
            "weekly_consumption": weekly_rate,
            "monthly_consumption": monthly_rate,
            "estimated_stock_remaining": remaining_qty,
            "estimated_days_left": days_left,
            "status": status,
            "status_text": status_text,
            "providers": list(data["providers"]),
            "stock_source": stock_source,
            "last_audit_date": audit_info["date_str"] if audit_info else None,
            "last_audit_quantity": audit_info["quantity"] if audit_info else None,
            "last_audit_status": audit_info["status"] if audit_info else None
        })

    # Add any items that were audited but have no receipt purchases yet
    for key, a_info in latest_audits.items():
        if key in items_map:
            continue
        audit_qty = a_info["quantity"]
        audit_date = a_info["date"]
        days_since_audit = (ref_dt - audit_date).days
        default_cycle = 7.0 if any(c in a_info["category"] for c in ["Dairy", "Produce", "Bakery"]) else 14.0
        daily_rate = round(audit_qty / default_cycle, 3) if audit_qty > 0 else 0.0
        weekly_rate = round(daily_rate * 7, 2)
        monthly_rate = round(daily_rate * 30.4, 2)

        if a_info["status"] == "out_of_stock" or audit_qty <= 0:
            rem_qty = 0.0
            days_left = 0.0
            status = "overdue"
            status_text = "Restock Needed"
        else:
            consumed = (days_since_audit * daily_rate) if (days_since_audit > 0 and daily_rate > 0) else 0.0
            rem_qty = max(0.0, round(audit_qty - consumed, 2))
            days_left = round(rem_qty / daily_rate, 1) if (rem_qty > 0 and daily_rate > 0) else 0.0
            if rem_qty <= 0:
                status = "overdue"
                status_text = "Restock Needed"
            elif a_info["status"] == "low" or days_left <= 3:
                status = "low"
                status_text = "Running Low"
            else:
                status = "ok"
                status_text = "Sufficient"

        results.append({
            "clean_name": a_info["item_name"],
            "category": a_info["category"],
            "unit": a_info["unit"] or "unit",
            "purchase_count": 0,
            "total_quantity": audit_qty,
            "total_spend": 0.0,
            "avg_unit_price": 0.0,
            "first_purchase_date": a_info["date_str"],
            "last_purchase_date": a_info["date_str"],
            "days_since_last": days_since_audit,
            "daily_consumption": daily_rate,
            "weekly_consumption": weekly_rate,
            "monthly_consumption": monthly_rate,
            "estimated_stock_remaining": rem_qty,
            "estimated_days_left": days_left,
            "status": status,
            "status_text": status_text,
            "providers": [],
            "stock_source": "audit",
            "last_audit_date": a_info["date_str"],
            "last_audit_quantity": a_info["quantity"],
            "last_audit_status": a_info["status"]
        })

    # Sort so items needing replenishment come first
    results.sort(key=lambda x: (0 if x["status"] == "overdue" else 1 if x["status"] == "low" else 2, x["estimated_days_left"]))
    return results


def get_reporting_summary(
    provider: Optional[str] = None,
    category: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Dict[str, Any]:
    """Generates aggregated reports by provider, category, item, and time."""
    conn = get_db_connection()

    where_clauses = ["1=1"]
    params = []

    if provider:
        where_clauses.append("r.provider = ?")
        params.append(provider)
    if category:
        where_clauses.append("i.category = ?")
        params.append(category)
    if date_from:
        where_clauses.append("r.receipt_date >= ?")
        params.append(date_from)
    if date_to:
        where_clauses.append("r.receipt_date <= ?")
        params.append(date_to)

    where_sql = " AND ".join(where_clauses)

    # 1. Overall totals
    totals_query = f"""
        SELECT 
            COUNT(DISTINCT r.id) as total_receipts,
            COUNT(i.id) as total_items_count,
            COALESCE(SUM(i.total_price), 0.0) as grand_total_spend,
            COALESCE(SUM(i.quantity), 0.0) as total_quantity
        FROM receipts r
        LEFT JOIN receipt_items i ON r.id = i.receipt_id
        WHERE {where_sql}
    """
    t_row = conn.execute(totals_query, params).fetchone()
    totals = {
        "total_receipts": t_row["total_receipts"],
        "total_items_count": t_row["total_items_count"],
        "grand_total_spend": round(t_row["grand_total_spend"], 2),
        "total_quantity": round(t_row["total_quantity"], 2),
    }

    # 2. Spend by Provider
    prov_query = f"""
        SELECT 
            r.provider,
            COUNT(DISTINCT r.id) as trips,
            COUNT(i.id) as item_count,
            ROUND(COALESCE(SUM(i.total_price), 0.0), 2) as total_spend,
            ROUND(AVG(r.total_amount), 2) as avg_trip_cost
        FROM receipts r
        LEFT JOIN receipt_items i ON r.id = i.receipt_id
        WHERE {where_sql}
        GROUP BY r.provider
        ORDER BY total_spend DESC
    """
    by_provider = [dict(r) for r in conn.execute(prov_query, params).fetchall()]

    # 3. Spend by Category
    cat_query = f"""
        SELECT 
            COALESCE(i.category, 'Other') as category,
            COUNT(i.id) as item_count,
            ROUND(COALESCE(SUM(i.quantity), 0.0), 2) as total_quantity,
            ROUND(COALESCE(SUM(i.total_price), 0.0), 2) as total_spend
        FROM receipts r
        JOIN receipt_items i ON r.id = i.receipt_id
        WHERE {where_sql}
        GROUP BY i.category
        ORDER BY total_spend DESC
    """
    by_category = [dict(r) for r in conn.execute(cat_query, params).fetchall()]

    # 4. Detailed Items list with aggregates
    items_query = f"""
        SELECT 
            i.clean_name,
            i.category,
            i.unit,
            COUNT(i.id) as purchase_count,
            ROUND(COALESCE(SUM(i.quantity), 0.0), 2) as total_quantity,
            ROUND(COALESCE(SUM(i.total_price), 0.0), 2) as total_cost,
            ROUND(AVG(i.unit_price), 2) as avg_unit_price,
            MAX(r.receipt_date) as last_purchased
        FROM receipts r
        JOIN receipt_items i ON r.id = i.receipt_id
        WHERE {where_sql}
        GROUP BY i.clean_name, i.category, i.unit
        ORDER BY total_cost DESC
    """
    by_item = [dict(r) for r in conn.execute(items_query, params).fetchall()]

    # 5. Monthly spend trend
    monthly_query = f"""
        SELECT 
            SUBSTR(r.receipt_date, 1, 7) as month,
            COUNT(DISTINCT r.id) as receipt_count,
            ROUND(COALESCE(SUM(i.total_price), 0.0), 2) as monthly_spend
        FROM receipts r
        LEFT JOIN receipt_items i ON r.id = i.receipt_id
        WHERE {where_sql}
        GROUP BY SUBSTR(r.receipt_date, 1, 7)
        ORDER BY month ASC
    """
    monthly_trend = [dict(r) for r in conn.execute(monthly_query, params).fetchall()]

    conn.close()

    return {
        "totals": totals,
        "by_provider": by_provider,
        "by_category": by_category,
        "by_item": by_item,
        "monthly_trend": monthly_trend,
    }
