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
    conn.close()

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

        # Inventory projection from latest purchase
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
            "providers": list(data["providers"])
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
