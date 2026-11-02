"""Agregasi laporan, dashboard, dan penyusun berkas ekspor."""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .core import (
    AppError, DB, display_date, fmt_qty, iso_date, m3_value, money_text,
    normalize_size, parse_iso_date, size_display, today_iso,
)
from . import documents, exports, opname, stock

MONTH_NAMES = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
]

MONEY_FORMAT = "#,##0"
QTY_FORMAT = "#,##0.####"
M3_FORMAT = "0.000000"


def month_label(year: int, month: int) -> str:
    return f"{MONTH_NAMES[month - 1][:3]} {str(year)[2:]}"


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    index = (year * 12 + (month - 1)) + delta
    return index // 12, index % 12 + 1


def current_bounds() -> tuple[str, str]:
    today = date.today()
    return today.replace(day=1).isoformat(), today.isoformat()


def resolve_bounds(start, end) -> tuple[str, str]:
    default_start, default_end = current_bounds()
    start = iso_date(start, "Tanggal dari") if str(start or "").strip() else default_start
    end = iso_date(end, "Tanggal sampai") if str(end or "").strip() else default_end
    if start > end:
        raise AppError("Tanggal dari tidak boleh melewati tanggal sampai.")
    return start, end


def _m3(size: str, qty) -> float:
    return round(m3_value(size, float(qty or 0)), 6)


def _booking_price(db: DB) -> dict[tuple[int, str], float]:
    reference = stock.price_reference(db)
    fallback = {
        int(row["id"]): float(row["purchase_price"] or 0)
        for row in db.q("SELECT id, purchase_price FROM products")
    }
    return reference, fallback


def _series(db: DB, months: int = 6) -> list[dict]:
    today = date.today()
    points = []
    for offset in range(months - 1, -1, -1):
        year, month = _shift_month(today.year, today.month, -offset)
        start = f"{year:04d}-{month:02d}-01"
        last_day = calendar.monthrange(year, month)[1]
        points.append({
            "month": f"{year:04d}-{month:02d}",
            "label": month_label(year, month),
            "start": start,
            "end": f"{year:04d}-{month:02d}-{last_day:02d}",
            "incoming_qty": 0.0, "incoming_m3": 0.0, "incoming_amount": 0.0,
            "outgoing_qty": 0.0, "outgoing_m3": 0.0,
        })
    if not points:
        return []
    start = points[0]["start"]
    rows = db.q(
        """SELECT SUBSTR(t.trx_date,1,7) AS month, t.trx_type, t.trx_size, t.qty, t.price,
                  COALESCE(t.trx_number,'') AS trx_number
           FROM transactions t
           WHERE SUBSTR(t.trx_date,1,10)>=? AND SUBSTR(t.trx_date,1,10)<=?""",
        (start, today_iso()),
    )
    lookup = {point["month"]: point for point in points}
    for row in rows:
        point = lookup.get(row["month"])
        if not point or str(row["trx_number"]).startswith("OPN-"):
            continue
        volume = m3_value(row["trx_size"], row["qty"])
        if row["trx_type"] == "MASUK":
            point["incoming_qty"] += float(row["qty"] or 0)
            point["incoming_m3"] += volume
            point["incoming_amount"] += volume * float(row["price"] or 0)
        else:
            point["outgoing_qty"] += float(row["qty"] or 0)
            point["outgoing_m3"] += volume
    for point in points:
        for key in ("incoming_qty", "outgoing_qty"):
            point[key] = round(point[key], 4)
        for key in ("incoming_m3", "outgoing_m3", "incoming_amount"):
            point[key] = round(point[key], 6)
    return points


def dashboard(db: DB) -> dict:
    today = today_iso()
    month_start, _ = current_bounds()
    grouped = stock.stock_grouped(db)
    total_qty = round(sum(float(row["stock"] or 0) for row in grouped), 4)
    total_m3 = round(sum(float(row["m3"] or 0) for row in grouped), 6)
    reference, fallback = _booking_price(db)
    stock_value = 0.0
    for row in grouped:
        price = reference.get((int(row["product_id"]), row["size"])) or fallback.get(int(row["product_id"])) or 0
        stock_value += float(row["m3"] or 0) * float(price)
    totals = db.one(
        """SELECT
             COALESCE(SUM(CASE WHEN trx_type='MASUK' AND trx_date=? AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty END),0) AS today_in_qty,
             COALESCE(SUM(CASE WHEN trx_type='KELUAR' AND trx_date=? AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty END),0) AS today_out_qty,
             COALESCE(SUM(CASE WHEN trx_type='MASUK' AND trx_date>=? AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty END),0) AS month_in_qty,
             COALESCE(SUM(CASE WHEN trx_type='KELUAR' AND trx_date>=? AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty END),0) AS month_out_qty
           FROM transactions WHERE trx_date>=?""",
        (today, today, month_start, month_start, month_start),
    ) or {}
    amounts = db.q(
        """SELECT trx_type, trx_size, qty, price, trx_date FROM transactions
           WHERE trx_date>=? AND COALESCE(trx_number,'') NOT LIKE 'OPN-%'""",
        (month_start,),
    )
    month_in_m3 = month_in_amount = month_out_m3 = 0.0
    for row in amounts:
        volume = m3_value(row["trx_size"], row["qty"])
        if row["trx_type"] == "MASUK":
            month_in_m3 += volume
            month_in_amount += volume * float(row["price"] or 0)
        else:
            month_out_m3 += volume
    today_in_m3 = today_out_m3 = 0.0
    for row in amounts:
        if str(row["trx_date"])[:10] != today:
            continue
        volume = m3_value(row["trx_size"], row["qty"])
        if row["trx_type"] == "MASUK":
            today_in_m3 += volume
        else:
            today_out_m3 += volume
    open_period = opname.next_period_info(db)
    unclosed = open_period.get("unclosed")
    if unclosed:
        summary = opname.summarize(db, int(unclosed["id"]))
        unclosed_payload = {
            "id": int(unclosed["id"]),
            "period_start_display": display_date(str(unclosed["period_start"])[:10]),
            "period_end_display": display_date(str(unclosed["period_end"])[:10]),
            "status": opname.session_status(unclosed),
            "summary": summary,
        }
    else:
        unclosed_payload = None
    active_tallies = db.scalar("SELECT COUNT(*) FROM tally_headers WHERE status='POSTED'", (), 0)
    active_recaps = db.scalar("SELECT COUNT(*) FROM payment_recap_headers WHERE status='AKTIF'", (), 0)
    counts = {
        "products": db.scalar("SELECT COUNT(*) FROM products WHERE active=1", (), 0),
        "sellers": db.scalar("SELECT COUNT(*) FROM sellers WHERE active=1", (), 0),
        "locations": db.scalar("SELECT COUNT(*) FROM storage_locations WHERE active=1", (), 0),
        "tallies": int(active_tallies or 0),
        "recaps": int(active_recaps or 0),
        "users": db.scalar("SELECT COUNT(*) FROM users WHERE active=1", (), 0),
    }
    recent = db.q(
        """SELECT a.id, a.event_time, a.action, a.detail, COALESCE(u.username,'sistem') AS username
           FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
           ORDER BY a.id DESC LIMIT 8"""
    )
    for row in recent:
        row["time_display"] = str(row["event_time"] or "")[:16].replace("T", " ")
    locations = []
    buckets: dict[str, dict] = {}
    for row in stock.stock_rows(db):
        location = row["location"] or "Tanpa lokasi"
        bucket = buckets.setdefault(location, {"location": location, "qty": 0.0, "m3": 0.0, "items": 0})
        bucket["qty"] += float(row["stock"] or 0)
        bucket["m3"] += float(row["m3"] or 0)
        bucket["items"] += 1
    for bucket in sorted(buckets.values(), key=lambda item: item["m3"], reverse=True):
        bucket["qty"] = round(bucket["qty"], 4)
        bucket["m3"] = round(bucket["m3"], 6)
        locations.append(bucket)
    top_products = sorted(grouped, key=lambda row: row["m3"], reverse=True)[:6]
    for row in top_products:
        row["locations_count"] = row.get("location_count", len(row.get("locations") or {}))
    return {
        "today": today,
        "today_display": display_date(today),
        "locked_through": stock.locked_through(db),
        "stock": {"qty": total_qty, "m3": total_m3, "value": round(stock_value, 2), "rows": len(grouped)},
        "today_in": {
            "qty": round(float(totals.get("today_in_qty") or 0), 4),
            "m3": round(today_in_m3, 6),
        },
        "today_out": {
            "qty": round(float(totals.get("today_out_qty") or 0), 4),
            "m3": round(today_out_m3, 6),
        },
        "month_in": {
            "qty": round(float(totals.get("month_in_qty") or 0), 4),
            "m3": round(month_in_m3, 6),
            "amount": round(month_in_amount, 2),
        },
        "month_out": {
            "qty": round(float(totals.get("month_out_qty") or 0), 4),
            "m3": round(month_out_m3, 6),
        },
        "counts": counts,
        "period": open_period,
        "unclosed": unclosed_payload,
        "series": _series(db, 6),
        "top_products": top_products,
        "locations": locations,
        "recent_activity": recent,
    }


def transaction_report(db: DB, start="", end="", kind="MASUK", seller_id=None,
                       product_id=None, location="", query="") -> dict:
    start, end = resolve_bounds(start, end)
    kind = str(kind or "MASUK").upper()
    sql = """
        SELECT t.id, t.trx_date, t.trx_type, t.qty, t.price, t.note, t.trx_size, t.location,
               t.trx_number, t.delivery_number, t.supplier, t.created_at,
               p.code, p.name, p.unit, s.name AS seller_name,
               r.rit_number, r.rit_date, u.username,
               src.trx_number AS source_number
        FROM transactions t
        JOIN products p ON p.id=t.product_id
        LEFT JOIN sellers s ON s.id=t.seller_id
        LEFT JOIN seller_rits r ON r.id=t.rit_id
        LEFT JOIN users u ON u.id=t.user_id
        LEFT JOIN transactions src ON src.id=t.source_trx_id
        WHERE t.trx_date>=? AND t.trx_date<=?
    """
    args = [start, end]
    if kind in ("MASUK", "KELUAR"):
        sql += " AND t.trx_type=?"
        args.append(kind)
        sql += " AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%'"
    elif kind == "OPNAME":
        sql += " AND COALESCE(t.trx_number,'') LIKE 'OPN-%'"
    elif kind != "SEMUA":
        raise AppError("Jenis laporan transaksi tidak dikenal.")
    if kind == "SEMUA":
        sql += " AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%'"
    if seller_id not in (None, ""):
        sql += " AND t.seller_id=?"
        args.append(int(seller_id))
    if product_id not in (None, ""):
        sql += " AND t.product_id=?"
        args.append(int(product_id))
    term = str(location or "").strip()
    if term:
        sql += " AND t.location=?"
        args.append(term)
    term = str(query or "").strip()
    if term:
        sql += (
            " AND (COALESCE(p.code,'') LIKE ? OR COALESCE(p.name,'') LIKE ? OR "
            "COALESCE(t.trx_size,'') LIKE ? OR COALESCE(t.trx_number,'') LIKE ? OR "
            "COALESCE(t.delivery_number,'') LIKE ? OR COALESCE(t.note,'') LIKE ? OR "
            "COALESCE(s.name,'') LIKE ?)"
        )
        args.extend([f"%{term}%"] * 7)
    sql += " ORDER BY t.trx_date, t.id"
    rows = db.q(sql, args)
    total_qty = total_m3 = total_amount = 0.0
    for row in rows:
        volume = m3_value(row["trx_size"], row["qty"])
        amount = volume * float(row["price"] or 0)
        row["size"] = normalize_size(row["trx_size"])
        row["size_display"] = size_display(row["size"])
        row["qty_display"] = fmt_qty(row["qty"])
        row["m3"] = round(volume, 6)
        row["amount"] = round(amount, 2)
        row["date_display"] = display_date(str(row["trx_date"])[:10])
        row["seller_name"] = row.get("seller_name") or "-"
        row["reference"] = row.get("trx_number") or row.get("delivery_number") or "-"
        row["rit_number_display"] = f"{int(row['rit_number']):02d}" if row.get("rit_number") else "-"
        total_qty += float(row["qty"] or 0)
        total_m3 += volume
        total_amount += amount
    return {
        "start": start, "end": end, "kind": kind,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {
            "count": len(rows), "qty": round(total_qty, 4),
            "m3": round(total_m3, 6), "amount": round(total_amount, 2),
        },
    }


def stock_report(db: DB, cutoff="", query="", location="", thickness="") -> dict:
    cutoff = iso_date(cutoff, "Tanggal cut-off") if str(cutoff or "").strip() else ""
    rows = stock.stock_rows(db, cutoff or None)
    reference, fallback = _booking_price(db)
    term = str(query or "").strip().lower()
    loc = str(location or "").strip()
    thick = None
    if str(thickness or "").strip():
        try:
            thick = float(str(thickness).replace(",", "."))
        except ValueError:
            thick = None
    result = []
    for row in rows:
        if term and term not in f"{row['code']} {row['name']} {row['size_display']} {row['location']}".lower():
            continue
        if loc and str(row["location"]) != loc:
            continue
        from .core import size_parts
        _, tval, _ = size_parts(row["size"])
        if thick is not None and abs(tval - thick) > 0.0001:
            continue
        price = reference.get((int(row["product_id"]), row["size"])) or fallback.get(int(row["product_id"])) or 0
        decorated = dict(row)
        decorated["price"] = round(float(price), 2)
        decorated["value"] = round(float(row["m3"] or 0) * float(price), 2)
        result.append(decorated)
    result.sort(key=lambda item: (item["name"].lower(), item["size"], item["location"]))
    return {
        "cutoff": cutoff, "cutoff_display": display_date(cutoff) if cutoff else "Saat ini",
        "rows": result,
        "totals": {
            "qty": round(sum(float(r["stock"] or 0) for r in result), 4),
            "m3": round(sum(float(r["m3"] or 0) for r in result), 6),
            "value": round(sum(float(r["value"] or 0) for r in result), 2),
            "lots": len(result),
        },
    }


def seller_summary(db: DB, start="", end="") -> dict:
    start, end = resolve_bounds(start, end)
    rows = db.q(
        """SELECT s.id AS seller_id, s.name AS seller_name, s.city,
                  COUNT(DISTINCT t.rit_id) AS rits,
                  COUNT(DISTINCT COALESCE(t.trx_number,'')) AS notes,
                  COALESCE(SUM(t.qty),0) AS qty,
                  COUNT(t.id) AS lines
           FROM transactions t JOIN sellers s ON s.id=t.seller_id
           WHERE t.trx_type='MASUK' AND t.trx_date>=? AND t.trx_date<=?
             AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%'
           GROUP BY s.id, s.name, s.city
           ORDER BY s.name COLLATE NOCASE""",
        (start, end),
    )
    volume_rows = db.q(
        """SELECT t.seller_id, t.trx_size, t.qty, t.price FROM transactions t
           WHERE t.trx_type='MASUK' AND t.trx_date>=? AND t.trx_date<=?
             AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%' AND t.seller_id IS NOT NULL""",
        (start, end),
    )
    buckets: dict[int, dict] = {}
    for row in volume_rows:
        bucket = buckets.setdefault(int(row["seller_id"]), {"m3": 0.0, "amount": 0.0})
        volume = m3_value(row["trx_size"], row["qty"])
        bucket["m3"] += volume
        bucket["amount"] += volume * float(row["price"] or 0)
    for row in rows:
        bucket = buckets.get(int(row["seller_id"]), {"m3": 0.0, "amount": 0.0})
        row["qty"] = round(float(row["qty"] or 0), 4)
        row["m3"] = round(bucket["m3"], 6)
        row["amount"] = round(bucket["amount"], 2)
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {
            "sellers": len(rows),
            "qty": round(sum(float(r["qty"] or 0) for r in rows), 4),
            "m3": round(sum(float(r["m3"] or 0) for r in rows), 6),
            "amount": round(sum(float(r["amount"] or 0) for r in rows), 2),
        },
    }


def recap_report(db: DB, start="", end="", seller_id=None) -> dict:
    start, end = resolve_bounds(start, end)
    rows = documents.list_recaps(db, seller_id=seller_id, start=start, end=end)
    total = 0.0
    for row in rows:
        row["created_display"] = display_date(str(row.get("created_at") or "")[:10])
        total += float(row.get("total_amount") or 0)
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {"count": len(rows), "amount": round(total, 2)},
    }


def tally_report(db: DB, start="", end="", seller_id=None) -> dict:
    start, end = resolve_bounds(start, end)
    rows = documents.list_tallies(db, seller_id=seller_id, start=start, end=end)
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {
            "count": len(rows),
            "amount": round(sum(float(r.get("total_amount") or 0) for r in rows), 2),
            "volume": round(sum(float(r.get("total_volume") or 0) for r in rows), 6),
        },
    }


def transfer_report(db: DB, start="", end="", query="") -> dict:
    start, end = resolve_bounds(start, end)
    rows = stock.list_transfers(db, start=start, end=end, query=query)
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {
            "count": len(rows),
            "qty": round(sum(float(r.get("qty") or 0) for r in rows), 4),
            "m3": round(sum(float(r.get("m3") or 0) for r in rows), 6),
        },
    }


def activity_report(db: DB, start="", end="", user_id=None, query="", limit=500) -> dict:
    start, end = resolve_bounds(start, end)
    sql = """SELECT a.id, a.event_time, a.action, a.detail, a.user_id,
                    COALESCE(u.username,'sistem') AS username
             FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
             WHERE SUBSTR(a.event_time,1,10)>=? AND SUBSTR(a.event_time,1,10)<=?"""
    args = [start, end]
    if user_id not in (None, ""):
        sql += " AND a.user_id=?"
        args.append(int(user_id))
    term = str(query or "").strip()
    if term:
        sql += " AND (COALESCE(a.action,'') LIKE ? OR COALESCE(a.detail,'') LIKE ? OR COALESCE(u.username,'') LIKE ?)"
        args.extend([f"%{term}%"] * 3)
    sql += " ORDER BY a.id DESC LIMIT ?"
    args.append(max(1, min(int(limit or 500), 2000)))
    rows = db.q(sql, args)
    for row in rows:
        row["time_display"] = str(row["event_time"] or "")[:16].replace("T", " ")
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
    }


# --------------------------------------------------------------------------- ekspor


def _fmt_price(value) -> str:
    return money_text(value)


def build_export(db: DB, name: str, params: dict | None = None) -> tuple[str, bytes]:
    params = params or {}
    name = str(name or "").strip().lower()
    stamp = date.today().strftime("%Y%m%d")
    if name in ("transactions", "transaksi", "masuk", "keluar"):
        kind = params.get("kind") or ("KELUAR" if name == "keluar" else "MASUK")
        data = transaction_report(
            db, params.get("start"), params.get("end"), kind,
            params.get("seller_id"), params.get("product_id"),
            params.get("location"), params.get("query"),
        )
        headers = ["Tanggal", "Jenis", "No. Nota/Ref", "Surat Jalan", "Penjual", "Rit",
                   "Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Qty", "M³",
                   "Harga/m³", "Jumlah", "Catatan", "Petugas"]
        rows = []
        for row in data["rows"]:
            rows.append([
                row["date_display"], row["trx_type"], row.get("trx_number") or "-",
                row.get("delivery_number") or "-", row["seller_name"],
                row["rit_number_display"], row["code"], row["name"], row["size_display"],
                row["location"] or "-", float(row["qty"] or 0), float(row["m3"] or 0),
                float(row["price"] or 0), float(row["amount"] or 0),
                row.get("note") or "", row.get("username") or "-",
            ])
        total = ["TOTAL", "", "", "", "", "", "", "", "", "",
                 float(data["totals"]["qty"]), float(data["totals"]["m3"]), "",
                 float(data["totals"]["amount"]), "", ""]
        title = f"Laporan Transaksi {kind.title()}"
        subtitle = f"Periode {data['start_display']} s.d. {data['end_display']}"
        content = exports.xlsx_bytes(
            title, subtitle, headers, rows,
            formats={10: QTY_FORMAT, 11: M3_FORMAT, 12: MONEY_FORMAT, 13: MONEY_FORMAT},
            totals=total, sheet_title=kind.title(),
        )
        return f"laporan-{kind.lower()}-{stamp}.xlsx", content
    if name in ("stock", "stok"):
        data = stock_report(db, params.get("cutoff"), params.get("query"),
                            params.get("location"), params.get("thickness"))
        headers = ["Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Qty", "M³",
                   "Harga Acuan/m³", "Nilai Persediaan"]
        rows = [[
            row["code"], row["name"], row["size_display"], row["location"] or "-",
            float(row["stock"] or 0), float(row["m3"] or 0),
            float(row["price"] or 0), float(row["value"] or 0),
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", float(data["totals"]["qty"]),
                 float(data["totals"]["m3"]), "", float(data["totals"]["value"])]
        content = exports.xlsx_bytes(
            "Laporan Persediaan", f"Posisi {data['cutoff_display']}", headers, rows,
            formats={4: QTY_FORMAT, 5: M3_FORMAT, 6: MONEY_FORMAT, 7: MONEY_FORMAT},
            totals=total, sheet_title="Persediaan",
        )
        return f"laporan-stok-{stamp}.xlsx", content
    if name in ("sellers", "penjual"):
        data = seller_summary(db, params.get("start"), params.get("end"))
        headers = ["Penjual", "Kota", "Jumlah Rit", "Jumlah Nota", "Baris",
                   "Qty", "M³", "Nilai Pembelian"]
        rows = [[
            row["seller_name"], row.get("city") or "-", row["rits"], row["notes"],
            row["lines"], float(row["qty"] or 0), float(row["m3"] or 0),
            float(row["amount"] or 0),
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", "", float(data["totals"]["qty"]),
                 float(data["totals"]["m3"]), float(data["totals"]["amount"])]
        content = exports.xlsx_bytes(
            "Rekap Pembelian per Penjual",
            f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows,
            formats={5: QTY_FORMAT, 6: M3_FORMAT, 7: MONEY_FORMAT},
            totals=total, sheet_title="Pembelian Penjual",
        )
        return f"rekap-penjual-{stamp}.xlsx", content
    if name in ("recaps", "rekap"):
        data = recap_report(db, params.get("start"), params.get("end"), params.get("seller_id"))
        headers = ["Nomor Rekap", "Tanggal", "Penjual", "Rit / Nota", "Qty", "M³", "Nilai", "Status"]
        rows = [[
            row["recap_number"], row["created_display"], row.get("seller_name") or "-",
            f"{row.get('rit_number_display') or '-'} / {row.get('note') or '-'}",
            float(row.get("total_qty") or 0), float(row.get("total_volume") or 0),
            float(row.get("total_amount") or 0), row.get("status") or "-",
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", "", "", float(data["totals"]["amount"]), ""]
        content = exports.xlsx_bytes(
            "Rekap Pembayaran", f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows, formats={4: QTY_FORMAT, 5: M3_FORMAT, 6: MONEY_FORMAT},
            totals=total, sheet_title="Rekap Pembayaran",
        )
        return f"rekap-pembayaran-{stamp}.xlsx", content
    if name in ("tallies", "tally"):
        data = tally_report(db, params.get("start"), params.get("end"), params.get("seller_id"))
        headers = ["Nomor Tally", "Dibuat", "Penjual", "Rit", "Qty", "M³", "Nilai", "Pemeriksa", "Status"]
        rows = [[
            row["tally_number"], row["created_display"], row.get("seller_name") or "-",
            row.get("rit_number_display") or "-", float(row.get("total_qty") or 0),
            float(row.get("total_volume") or 0), float(row.get("total_amount") or 0),
            row.get("signature") or "-", row.get("status") or "-",
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", "", float(data["totals"]["volume"]),
                 float(data["totals"]["amount"]), "", ""]
        content = exports.xlsx_bytes(
            "Daftar Tally", f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows, formats={4: QTY_FORMAT, 5: M3_FORMAT, 6: MONEY_FORMAT},
            totals=total, sheet_title="Tally",
        )
        return f"daftar-tally-{stamp}.xlsx", content
    if name in ("transfers", "mutasi"):
        data = transfer_report(db, params.get("start"), params.get("end"), params.get("query"))
        headers = ["Tanggal", "Kode", "Barang", "Ukuran T×L×P", "Dari", "Ke", "Qty", "M³", "Catatan", "Petugas"]
        rows = [[
            display_date(str(row["transfer_date"])[:10]), row["code"], row["name"],
            row["size_display"], row["from_location"], row["to_location"],
            float(row["qty"] or 0), float(row["m3"] or 0),
            row.get("note") or "", row.get("username") or "-",
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", "", "", float(data["totals"]["qty"]),
                 float(data["totals"]["m3"]), "", ""]
        content = exports.xlsx_bytes(
            "Mutasi Antar Lokasi", f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows, formats={6: QTY_FORMAT, 7: M3_FORMAT},
            totals=total, sheet_title="Mutasi",
        )
        return f"mutasi-lokasi-{stamp}.xlsx", content
    if name in ("activity", "aktivitas"):
        data = activity_report(db, params.get("start"), params.get("end"),
                               params.get("user_id"), params.get("query"))
        headers = ["Waktu", "Pengguna", "Aksi", "Rincian"]
        rows = [[row["time_display"], row["username"], row["action"], row.get("detail") or ""]
                for row in data["rows"]]
        content = exports.xlsx_bytes(
            "Log Aktivitas", f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows, sheet_title="Aktivitas",
        )
        return f"log-aktivitas-{stamp}.xlsx", content
    if name in ("imports", "impor"):
        from .importing import list_imports
        data = list_imports(db, params.get("start"), params.get("end"), params.get("query"))
        headers = ["Tanggal", "No. Penerimaan", "No. Dokumen", "Barcode", "Kode",
                   "Barang", "Ukuran T×L×P", "Qty", "M³", "Harga/m³", "Jumlah",
                   "Pemasok", "Lokasi", "Petugas"]
        rows = [[
            row["date_display"], row["trx_number"], row.get("delivery_number") or "-",
            row.get("barcode") or "-", row["code"], row["name"], row["size_display"],
            float(row["qty"] or 0), float(row["m3"] or 0), float(row["price"] or 0),
            float(row["amount"] or 0), row.get("supplier") or "-", row["location"] or "-",
            row.get("username") or "-",
        ] for row in data["rows"]]
        total = ["TOTAL", "", "", "", "", "", "", float(data["totals"]["qty"]),
                 float(data["totals"]["m3"]), "", float(data["totals"]["amount"]), "", "", ""]
        content = exports.xlsx_bytes(
            "Penerimaan Kayu Impor",
            f"Periode {data['start_display']} s.d. {data['end_display']}",
            headers, rows, formats={7: QTY_FORMAT, 8: M3_FORMAT, 9: MONEY_FORMAT, 10: MONEY_FORMAT},
            totals=total, sheet_title="Impor",
        )
        return f"penerimaan-impor-{stamp}.xlsx", content
    if name in ("opname", "stock-opname"):
        if params.get("id"):
            session = opname.get_session(db, int(params["id"]))
            headers = ["No", "Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Stok Sistem",
                       "Stok Fisik", "Selisih", "Alasan", "Catatan"]
            rows = []
            for index, item in enumerate(session.get("items", []), start=1):
                rows.append([
                    index, item.get("code") or "", item.get("name") or "",
                    item.get("size_display") or "-", item.get("location") or "-",
                    float(item.get("system_qty") or 0),
                    None if item.get("physical_qty") is None else float(item["physical_qty"]),
                    None if item.get("diff") is None else float(item["diff"]),
                    item.get("reason") or "", item.get("note") or "",
                ])
            content = exports.xlsx_bytes(
                "Stok Opname",
                f"Periode {session['period_start_display']} s.d. {session['period_end_display']} · {session['label_status']}",
                headers, rows, formats={5: QTY_FORMAT, 6: QTY_FORMAT, 7: QTY_FORMAT},
                sheet_title="Opname",
            )
            return f"opname-{params['id']}-{stamp}.xlsx", content
        sessions = opname.list_sessions(db)
        headers = ["No", "Periode Mulai", "Cut-off", "Status", "Item", "Dibuat Oleh",
                   "Disahkan Oleh", "Ditutup"]
        rows = [[
            row["id"], row["period_start_display"], row["period_end_display"],
            row["label_status"], row["item_count"], row.get("created_by_name") or "-",
            row.get("approved_by_name") or "-", row.get("closed_display") or "-",
        ] for row in sessions]
        content = exports.xlsx_bytes(
            "Daftar Periode Stok Opname", "", headers, rows, sheet_title="Periode Opname",
        )
        return f"daftar-opname-{stamp}.xlsx", content
    if name in ("stock-card", "kartu-stok"):
        card = stock.stock_card(
            db, int(params.get("product_id")), params.get("size"),
            params.get("location"), params.get("start"), params.get("end"),
        )
        headers = ["Tanggal", "Jenis", "Referensi", "Masuk", "Keluar", "Saldo", "Catatan"]
        rows = [[
            display_date(row["date"]), row["kind"], row["reference"],
            float(row["in_qty"] or 0), float(row["out_qty"] or 0),
            float(row["balance"] or 0), row.get("note") or "",
        ] for row in card["movements"]]
        content = exports.xlsx_bytes(
            f"Kartu Stok {card['product']['name']}",
            f"Ukuran {card['size_display']} · Lokasi {card['location']} · "
            f"{display_date(card['start'])} s.d. {display_date(card['end'])} · "
            f"Saldo awal {fmt_qty(card['opening'])}",
            headers, rows, formats={3: QTY_FORMAT, 4: QTY_FORMAT, 5: QTY_FORMAT},
            sheet_title="Kartu Stok",
        )
        return f"kartu-stok-{stamp}.xlsx", content
    raise AppError("Jenis ekspor tidak dikenal.", 404)
