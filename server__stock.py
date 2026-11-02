"""Stok, lot, mutasi lokasi, barang keluar, dan penguncian periode."""
from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal

from .core import (
    AppError, DB, EPS, display_date, fmt_qty, iso_date, line_amount, m3_value,
    make_size, normalize_size, now_iso, parse_iso_date, resolve_location,
    size_display, size_parts, today_iso, trim_number,
)


def _size_sql(column: str) -> str:
    return (
        "LOWER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE("
        f"{column},'')), '×','x'),' ',''),'X','x'))"
    )


def _loc_sql(column: str) -> str:
    return f"TRIM(COALESCE({column},''))"


def locked_through(db: DB) -> str | None:
    row = db.one("SELECT MAX(period_end) AS m FROM stock_opname WHERE status='DONE'")
    value = (row or {}).get("m")
    return str(value)[:10] if value else None


def assert_period_open(db: DB, value, action: str = "mengubah data") -> None:
    locked = locked_through(db)
    if not locked:
        return
    target = iso_date(value)
    if target <= locked:
        raise AppError(
            f"Tanggal {display_date(target)} sudah dikunci oleh stok opname yang disahkan "
            f"(terkunci s.d. {display_date(locked)}). Tidak dapat {action} pada tanggal tersebut. "
            "Buka kembali pengesahan periode terakhir bila perlu koreksi."
        )


def stock_rows(db: DB, cutoff: str | None = None) -> list[dict]:
    cutoff = iso_date(cutoff) if cutoff else None
    tx_where = "WHERE SUBSTR(t.trx_date,1,10)<=?" if cutoff else ""
    tr_where = "WHERE SUBSTR(transfer_date,1,10)<=?" if cutoff else ""
    size_expr = _size_sql("trx_size")
    from_loc = _loc_sql("from_location")
    to_loc = _loc_sql("to_location")
    sql = f"""
        WITH events AS (
            SELECT t.product_id,
                   {size_expr} AS size,
                   {_loc_sql("t.location")} AS location,
                   CASE WHEN t.trx_type='MASUK' THEN t.qty ELSE -t.qty END AS change,
                   CASE WHEN t.trx_type='MASUK' AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%' THEN t.qty ELSE 0 END AS incoming,
                   CASE WHEN t.trx_type='KELUAR' AND COALESCE(t.trx_number,'') NOT LIKE 'OPN-%' THEN t.qty ELSE 0 END AS outgoing,
                   CASE WHEN COALESCE(t.trx_number,'') LIKE 'OPN-%' THEN CASE WHEN t.trx_type='MASUK' THEN t.qty ELSE -t.qty END ELSE 0 END AS adjustment,
                   0 AS transfer_in, 0 AS transfer_out, 0 AS transfer_change
            FROM transactions t {tx_where}
            UNION ALL
            SELECT product_id, {size_expr}, {from_loc}, -qty, 0, 0, 0, 0, qty, -qty
            FROM location_transfers {tr_where}
            UNION ALL
            SELECT product_id, {size_expr}, {to_loc}, qty, 0, 0, 0, qty, 0, qty
            FROM location_transfers {tr_where}
        )
        SELECT p.id AS product_id, p.code, p.name, p.unit, p.purchase_price,
               e.size, e.location,
               SUM(e.change) AS stock,
               SUM(e.incoming) AS incoming,
               SUM(e.outgoing) AS outgoing,
               SUM(e.adjustment) AS adjustment,
               SUM(e.transfer_in) AS transfer_in,
               SUM(e.transfer_out) AS transfer_out
        FROM events e
        JOIN products p ON p.id=e.product_id
        GROUP BY p.id, p.code, p.name, p.unit, p.purchase_price, e.size, e.location
        HAVING ABS(SUM(e.change)) > 0.0001
        ORDER BY p.name COLLATE NOCASE, e.size, e.location
    """
    args = []
    if cutoff:
        args.extend([cutoff, cutoff, cutoff])
    rows = db.q(sql, args)
    for row in rows:
        row["stock"] = round(float(row["stock"] or 0), 4)
        row["m3"] = round(m3_value(row["size"], row["stock"]), 6)
        row["size_display"] = size_display(row["size"])
    return rows


def stock_map(db: DB, cutoff: str | None = None) -> dict[tuple[int, str, str], float]:
    return {
        (int(r["product_id"]), r["size"] or "", r["location"] or ""): float(r["stock"] or 0)
        for r in stock_rows(db, cutoff)
    }


def stock_at(db: DB, product_id: int, size: str, location: str) -> float:
    return stock_map(db).get((int(product_id), normalize_size(size), str(location or "").strip()), 0.0)


def stock_grouped(db: DB, query: str = "", location: str = "", thickness: str = "") -> list[dict]:
    rows = stock_rows(db)
    groups: dict[tuple[int, str], dict] = {}
    q = str(query or "").strip().lower()
    loc_filter = str(location or "").strip().lower()
    t_filter = None
    if str(thickness or "").strip():
        try:
            t_filter = float(str(thickness).replace(",", "."))
        except ValueError:
            t_filter = None
    for row in rows:
        if loc_filter and str(row["location"]).lower() != loc_filter:
            continue
        if q and q not in f"{row['code']} {row['name']} {row['size_display']} {row['location']}".lower():
            continue
        if t_filter is not None:
            _, tval, _ = size_parts(row["size"])
            if abs(tval - t_filter) > EPS:
                continue
        key = (int(row["product_id"]), row["size"] or "")
        group = groups.setdefault(key, {
            "product_id": int(row["product_id"]),
            "code": row["code"],
            "name": row["name"],
            "unit": row["unit"],
            "size": row["size"],
            "size_display": row["size_display"],
            "stock": 0.0,
            "locations": {},
            "m3": 0.0,
        })
        group["stock"] += float(row["stock"] or 0)
        group["locations"][row["location"] or ""] = float(row["stock"] or 0)
    result = list(groups.values())
    for group in result:
        group["stock"] = round(group["stock"], 4)
        group["m3"] = round(m3_value(group["size"], group["stock"]), 6)
        group["location_count"] = len(group["locations"])
    result.sort(key=lambda item: (item["name"].lower(), item["size"]))
    return result


def available_lots(db: DB, product_id: int, size: str, location: str | None = None) -> list[dict]:
    normalized = normalize_size(size)
    rows = db.q(
        """
        SELECT t.id, t.trx_date, t.trx_number, t.delivery_number, t.supplier,
               t.location, t.qty, t.price, t.note, t.created_at,
               COALESCE((
                   SELECT SUM(o.qty) FROM transactions o
                   WHERE o.source_trx_id=t.id AND o.trx_type='KELUAR'
               ), 0) AS used
        FROM transactions t
        WHERE t.trx_type='MASUK' AND t.product_id=?
          AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(t.trx_size),'×','x'),' ',''),'X','x'))=?
        ORDER BY t.trx_date, t.id
        """,
        (int(product_id), normalized),
    )
    current_stock = None
    if location is not None:
        current_stock = stock_map(db).get((int(product_id), normalized, str(location).strip()), 0.0)
    lots = []
    for row in rows:
        remaining = round(float(row["qty"] or 0) - float(row["used"] or 0), 4)
        if remaining <= EPS:
            continue
        capacity = remaining if current_stock is None else max(0.0, min(remaining, current_stock))
        lots.append({
            **row,
            "remaining": remaining,
            "capacity": round(capacity, 4),
            "size": normalized,
            "size_display": size_display(normalized),
        })
    return lots


def lot_capacity(db: DB, source_id: int, location: str) -> dict:
    lot = db.one(
        """
        SELECT t.*, COALESCE((
            SELECT SUM(o.qty) FROM transactions o
            WHERE o.source_trx_id=t.id AND o.trx_type='KELUAR'
        ),0) AS used
        FROM transactions t
        WHERE t.id=? AND t.trx_type='MASUK'
        """,
        (int(source_id),),
    )
    if not lot:
        raise AppError("Lot barang masuk sumber tidak ditemukan.")
    normalized = normalize_size(lot["trx_size"])
    remaining = round(float(lot["qty"] or 0) - float(lot["used"] or 0), 4)
    stock = stock_map(db).get((int(lot["product_id"]), normalized, str(location or "").strip()), 0.0)
    lot["size"] = normalized
    lot["size_display"] = size_display(normalized)
    lot["remaining"] = remaining
    lot["location_stock"] = round(stock, 4)
    lot["capacity"] = round(max(0.0, min(remaining, stock)), 4)
    return lot


def record_outgoing(db: DB, user_id: int, source_id: int, location: str, qty, trx_date, note: str = "") -> dict:
    try:
        qty = float(qty)
    except (TypeError, ValueError):
        raise AppError("Qty harus berupa angka.")
    if qty <= 0:
        raise AppError("Qty barang keluar harus lebih dari 0.")
    target_date = iso_date(trx_date, "Tanggal keluar")
    if target_date > today_iso():
        raise AppError("Tanggal keluar tidak boleh melewati hari ini.")
    assert_period_open(db, target_date, "mencatat barang keluar")
    location = str(location or "").strip()
    if location:
        resolve_location(db, location)
    lot = lot_capacity(db, source_id, location)
    if target_date < str(lot["trx_date"])[:10]:
        raise AppError("Tanggal keluar tidak boleh sebelum tanggal barang masuk.")
    if lot["remaining"] + EPS < qty:
        raise AppError(
            f"Sisa lot sumber hanya {fmt_qty(lot['remaining'])}. "
            "Kurangi qty atau pilih lot lain."
        )
    if lot["location_stock"] + EPS < qty:
        raise AppError(
            f"Stok barang ini di lokasi tersebut hanya {fmt_qty(lot['location_stock'])}. "
            f"Tidak cukup untuk mengeluarkan {fmt_qty(qty)}."
        )
    if len(str(note or "")) > 300:
        raise AppError("Catatan maksimal 300 karakter.")
    stamp = now_iso()
    with db.atomic():
        new_id = db.insert(
            """INSERT INTO transactions(
                   trx_date,trx_type,product_id,qty,price,note,trx_size,location,
                   seller_id,rit_id,source_trx_id,trx_number,delivery_number,supplier,user_id,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                target_date, "KELUAR", int(lot["product_id"]), qty, 0, str(note or "").strip(),
                lot["size"], location, lot.get("seller_id"), lot.get("rit_id"), int(source_id),
                None, None, lot.get("supplier") or "", user_id, stamp,
            ),
        )
        db.log(
            user_id, "BARANG_KELUAR",
            f"id={new_id} | {display_date(target_date)} | lot={source_id} | "
            f"qty={fmt_qty(qty)} | ukuran={size_display(lot['size'])} | lokasi={location or '-'} | "
            f"catatan={str(note or '').strip()}",
            "transactions", new_id,
        )
    return {"id": new_id}


def update_outgoing(db: DB, user_id: int, trx_id: int, qty, trx_date, note: str, location: str) -> dict:
    row = db.one("SELECT * FROM transactions WHERE id=? AND trx_type='KELUAR'", (int(trx_id),))
    if not row:
        raise AppError("Transaksi barang keluar tidak ditemukan.", 404)
    try:
        new_qty = float(qty)
    except (TypeError, ValueError):
        raise AppError("Qty harus berupa angka.")
    if new_qty <= 0:
        raise AppError("Qty harus lebih dari 0.")
    new_date = iso_date(trx_date, "Tanggal keluar")
    new_location = str(location or "").strip()
    if new_date > today_iso():
        raise AppError("Tanggal keluar tidak boleh melewati hari ini.")
    assert_period_open(db, row["trx_date"], "mengubah barang keluar")
    assert_period_open(db, new_date, "mengubah barang keluar")
    if new_location:
        resolve_location(db, new_location)
    source_id = row.get("source_trx_id")
    if source_id:
        lot = lot_capacity(db, int(source_id), new_location)
        if new_date < str(lot["trx_date"])[:10]:
            raise AppError("Tanggal keluar tidak boleh sebelum tanggal barang masuk.")
        max_qty = float(lot["remaining"] or 0) + float(row["qty"] or 0)
        if new_qty > max_qty + EPS:
            raise AppError(f"Qty melebihi sisa lot sumber. Maksimum: {fmt_qty(max_qty)}.")
    old_location = str(row["location"] or "").strip()
    old_size = normalize_size(row["trx_size"])
    projected = stock_at(db, int(row["product_id"]), old_size, new_location)
    if old_location == new_location:
        projected += float(row["qty"] or 0)
    if projected + EPS < new_qty:
        raise AppError(
            f"Stok di lokasi tujuan hanya {fmt_qty(max(0.0, projected))} setelah memperhitungkan transaksi ini. "
            "Kurangi qty atau pilih lokasi lain."
        )
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan maksimal 300 karakter.")
    stamp = now_iso()
    with db.atomic():
        db.run(
            "UPDATE transactions SET trx_date=?, qty=?, note=?, location=? WHERE id=? AND trx_type='KELUAR'",
            (new_date, new_qty, note, new_location, int(trx_id)),
        )
        db.log(
            user_id, "UBAH_BARANG_KELUAR",
            f"id={trx_id} | sebelum: qty={fmt_qty(row['qty'])} tgl={row['trx_date']} lokasi={old_location or '-'} | "
            f"sesudah: qty={fmt_qty(new_qty)} tgl={new_date} lokasi={new_location or '-'} | catatan={note}",
            "transactions", int(trx_id),
        )
    return {"id": int(trx_id)}


def cancel_outgoing(db: DB, user_id: int, ids: list[int], reason: str = "") -> dict:
    clean_ids = []
    for value in ids or []:
        try:
            clean_ids.append(int(value))
        except (TypeError, ValueError):
            continue
    if not clean_ids:
        raise AppError("Pilih minimal satu transaksi barang keluar.")
    rows = []
    for trx_id in clean_ids:
        row = db.one(
            """SELECT t.*, p.code, p.name FROM transactions t
               JOIN products p ON p.id=t.product_id
               WHERE t.id=? AND t.trx_type='KELUAR'""",
            (trx_id,),
        )
        if not row:
            continue
        assert_period_open(db, row["trx_date"], "membatalkan barang keluar")
        rows.append(row)
    if not rows:
        raise AppError("Tidak ada data barang keluar yang dapat dibatalkan.")
    stamp = now_iso()
    total = sum(float(row["qty"] or 0) for row in rows)
    with db.atomic():
        for row in rows:
            db.run("DELETE FROM transactions WHERE id=? AND trx_type='KELUAR'", (int(row["id"]),))
            db.log(
                user_id, "BATAL_BARANG_KELUAR",
                f"id={row['id']} | sumber={row.get('source_trx_id') or '-'} | qty={fmt_qty(row['qty'])} | "
                f"ukuran={size_display(row['trx_size'])} | tgl={row['trx_date']} | "
                f"barang={row.get('code')} {row.get('name')} | alasan={reason or '-'}",
                "transactions", int(row["id"]),
            )
    return {"cancelled": len(rows), "total_qty": round(total, 4)}


def list_outgoing(db: DB, start: str, end: str, query: str = "") -> list[dict]:
    start = iso_date(start or date.today().replace(day=1).isoformat(), "Tanggal dari")
    end = iso_date(end or today_iso(), "Tanggal sampai")
    if start > end:
        raise AppError("Tanggal dari tidak boleh melewati tanggal sampai.")
    sql = """
        SELECT t.id, t.trx_date, t.qty, t.note, t.trx_size, t.location, t.supplier,
               t.price, t.trx_number, t.delivery_number, t.created_at,
               p.code, p.name, p.unit, u.username,
               s.trx_number AS source_number, s.trx_date AS source_date
        FROM transactions t
        JOIN products p ON p.id=t.product_id
        LEFT JOIN users u ON u.id=t.user_id
        LEFT JOIN transactions s ON s.id=t.source_trx_id
        WHERE t.trx_type='KELUAR' AND t.trx_date>=? AND t.trx_date<=?
    """
    args = [start, end]
    term = str(query or "").strip()
    if term:
        sql += (
            " AND (COALESCE(p.code,'') LIKE ? OR COALESCE(p.name,'') LIKE ? OR "
            "COALESCE(t.trx_size,'') LIKE ? OR COALESCE(t.note,'') LIKE ? OR "
            "COALESCE(t.location,'') LIKE ? OR COALESCE(t.supplier,'') LIKE ?)"
        )
        args.extend([f"%{term}%"] * 6)
    sql += " ORDER BY t.trx_date DESC, t.id DESC"
    rows = db.q(sql, args)
    locked = locked_through(db)
    for row in rows:
        row["size_display"] = size_display(row["trx_size"])
        row["qty_display"] = fmt_qty(row["qty"])
        row["is_locked"] = bool(locked and str(row["trx_date"])[:10] <= locked)
        row["locked_through"] = locked
    return rows


def get_outgoing(db: DB, trx_id: int) -> dict:
    row = db.one(
        """SELECT t.*, p.code, p.name, p.unit, u.username,
                  s.trx_number AS source_number, s.trx_date AS source_date,
                  s.delivery_number AS source_delivery, s.supplier AS source_supplier,
                  s.qty AS source_qty
           FROM transactions t
           JOIN products p ON p.id=t.product_id
           LEFT JOIN users u ON u.id=t.user_id
           LEFT JOIN transactions s ON s.id=t.source_trx_id
           WHERE t.id=? AND t.trx_type='KELUAR'""",
        (int(trx_id),),
    )
    if not row:
        raise AppError("Transaksi barang keluar tidak ditemukan.", 404)
    row["size_display"] = size_display(row["trx_size"])
    row["m3"] = round(m3_value(row["trx_size"], row["qty"]), 6)
    return row


def record_transfer(db: DB, user_id: int, product_id: int, size: str, from_location: str,
                    to_location: str, qty, transfer_date, note: str = "") -> dict:
    normalized = normalize_size(size)
    from_location = str(from_location or "").strip()
    to_location = str(to_location or "").strip()
    if not from_location:
        raise AppError("Lokasi asal wajib diisi.")
    resolve_location(db, from_location)
    resolve_location(db, to_location)
    if from_location.lower() == to_location.lower():
        raise AppError("Lokasi tujuan harus berbeda dari lokasi asal.")
    try:
        qty = float(qty)
    except (TypeError, ValueError):
        raise AppError("Qty mutasi harus berupa angka.")
    if qty <= 0:
        raise AppError("Qty mutasi harus lebih dari 0.")
    target_date = iso_date(transfer_date, "Tanggal mutasi")
    if target_date > today_iso():
        raise AppError("Tanggal mutasi tidak boleh melewati hari ini.")
    assert_period_open(db, target_date, "mencatat mutasi")
    available = stock_at(db, product_id, normalized, from_location)
    if available + EPS < qty:
        raise AppError(f"Stok di {from_location} tidak cukup. Tersedia {fmt_qty(available)}.")
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan maksimal 300 karakter.")
    stamp = now_iso()
    with db.atomic():
        new_id = db.insert(
            """INSERT INTO location_transfers(
                   transfer_date,product_id,trx_size,from_location,to_location,qty,note,user_id,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?)""",
            (target_date, int(product_id), normalized, from_location, to_location, qty, note, user_id, stamp),
        )
        db.log(
            user_id, "MUTASI_LOKASI",
            f"id={new_id} | {display_date(target_date)} | produk={product_id} | ukuran={size_display(normalized)} | "
            f"qty={fmt_qty(qty)} | {from_location} → {to_location} | catatan={note}",
            "location_transfers", new_id,
        )
    return {"id": new_id}


def list_transfers(db: DB, start: str = "", end: str = "", query: str = "") -> list[dict]:
    sql = """
        SELECT tr.*, p.code, p.name, p.unit, u.username
        FROM location_transfers tr
        JOIN products p ON p.id=tr.product_id
        LEFT JOIN users u ON u.id=tr.user_id
        WHERE 1=1
    """
    args = []
    if str(start or "").strip():
        sql += " AND tr.transfer_date>=?"
        args.append(iso_date(start, "Tanggal dari"))
    if str(end or "").strip():
        sql += " AND tr.transfer_date<=?"
        args.append(iso_date(end, "Tanggal sampai"))
    term = str(query or "").strip()
    if term:
        sql += (
            " AND (COALESCE(p.code,'') LIKE ? OR COALESCE(p.name,'') LIKE ? OR "
            "COALESCE(tr.from_location,'') LIKE ? OR COALESCE(tr.to_location,'') LIKE ? OR "
            "COALESCE(tr.note,'') LIKE ?)"
        )
        args.extend([f"%{term}%"] * 5)
    sql += " ORDER BY tr.transfer_date DESC, tr.id DESC"
    rows = db.q(sql, args)
    for row in rows:
        row["size_display"] = size_display(row["trx_size"])
        row["qty_display"] = fmt_qty(row["qty"])
        row["m3"] = round(m3_value(row["trx_size"], row["qty"]), 6)
    return rows


def stock_card(db: DB, product_id: int, size: str, location: str, start: str, end: str) -> dict:
    normalized = normalize_size(size)
    location = str(location or "").strip()
    start = iso_date(start, "Tanggal dari")
    end = iso_date(end, "Tanggal sampai")
    if start > end:
        raise AppError("Tanggal dari tidak boleh melewati tanggal sampai.")
    product = db.one("SELECT id,code,name,unit,purchase_price FROM products WHERE id=?", (int(product_id),))
    if not product:
        raise AppError("Barang tidak ditemukan.", 404)
    opening = stock_map(db, (parse_iso_date(start) - timedelta(days=1)).isoformat()).get(
        (int(product_id), normalized, location), 0.0
    )
    size_expr = _size_sql("trx_size")
    trx = db.q(
        f"""SELECT id, trx_date AS movement_date, trx_type, qty, note, trx_number, created_at,
                   CASE WHEN trx_type='MASUK' THEN qty ELSE 0 END AS in_qty,
                   CASE WHEN trx_type='KELUAR' THEN qty ELSE 0 END AS out_qty
            FROM transactions
            WHERE product_id=? AND {size_expr}=? AND {_loc_sql('location')}=?
              AND trx_date>=? AND trx_date<=?""",
        (int(product_id), normalized, location, start, end),
    )
    transfers = db.q(
        f"""SELECT id, transfer_date AS movement_date, qty, note, from_location, to_location, created_at,
                   CASE WHEN {_loc_sql('to_location')}=? THEN qty ELSE 0 END AS in_qty,
                   CASE WHEN {_loc_sql('from_location')}=? THEN qty ELSE 0 END AS out_qty
            FROM location_transfers
            WHERE product_id=? AND {size_expr}=?
              AND (TRIM(from_location)=? OR TRIM(to_location)=?)
              AND transfer_date>=? AND transfer_date<=?""",
        (location, location, int(product_id), normalized, location, location, start, end),
    )
    movements = []
    for row in trx:
        is_opn = str(row.get("trx_number") or "").startswith("OPN-")
        label = "MASUK" if row["trx_type"] == "MASUK" else "KELUAR"
        if is_opn:
            label = "PENYESUAIAN OPNAME"
        movements.append({
            "date": str(row["movement_date"])[:10], "kind": label, "in_qty": float(row["in_qty"] or 0),
            "out_qty": float(row["out_qty"] or 0), "reference": row.get("trx_number") or "",
            "note": row.get("note") or "", "sort": (str(row["movement_date"]), 1, row["id"]),
        })
    for row in transfers:
        movements.append({
            "date": str(row["movement_date"])[:10],
            "kind": "MUTASI MASUK" if float(row["in_qty"] or 0) > 0 else "MUTASI KELUAR",
            "in_qty": float(row["in_qty"] or 0), "out_qty": float(row["out_qty"] or 0),
            "reference": f"{row['from_location']} → {row['to_location']}",
            "note": row.get("note") or "", "sort": (str(row["movement_date"]), 2, row["id"]),
        })
    movements.sort(key=lambda item: item["sort"])
    balance = float(opening)
    for row in movements:
        balance = round(balance + row["in_qty"] - row["out_qty"], 4)
        row["balance"] = balance
    volume_opening = m3_value(normalized, opening) if opening else 0.0
    volume_in = sum(m3_value(normalized, row["in_qty"]) for row in movements)
    volume_out = sum(m3_value(normalized, row["out_qty"]) for row in movements)
    return {
        "product": product, "size": normalized, "size_display": size_display(normalized),
        "location": location, "start": start, "end": end,
        "opening": round(float(opening), 4), "opening_m3": round(volume_opening, 6),
        "in_m3": round(volume_in, 6), "out_m3": round(volume_out, 6),
        "closing": round(balance, 4), "closing_m3": round(m3_value(normalized, balance), 6),
        "movements": movements,
    }


def price_reference(db: DB) -> dict[tuple[int, str], float]:
    """Harga rata-rata tertimbang volume dari barang masuk berharga (bukan OPN)."""
    rows = db.q(
        """SELECT product_id, trx_size, qty, price FROM transactions
           WHERE trx_type='MASUK' AND price>0 AND COALESCE(trx_number,'') NOT LIKE 'OPN-%'"""
    )
    totals: dict[tuple[int, str], list[float]] = {}
    for row in rows:
        size = normalize_size(row["trx_size"])
        volume = m3_value(size, row["qty"])
        amount = volume * float(row["price"] or 0)
        bucket = totals.setdefault((int(row["product_id"]), size), [0.0, 0.0])
        bucket[0] += volume
        bucket[1] += amount
    result = {}
    for key, (volume, amount) in totals.items():
        if volume > EPS:
            result[key] = amount / volume
    return result


def stock_lots_detail(db: DB, product_id: int, size: str, location: str) -> list[dict]:
    normalized = normalize_size(size)
    lots = available_lots(db, product_id, normalized, location)
    for lot in lots:
        lot["available"] = lot["capacity"]
        lot["m3_remaining"] = round(m3_value(normalized, lot["remaining"]), 6)
    return lots


def recent_outgoing_lots(db: DB, product_id: int, size: str, location: str, limit: int = 10) -> list[dict]:
    normalized = normalize_size(size)
    return db.q(
        """SELECT t.id, t.trx_date, t.qty, t.note, t.supplier, u.username
           FROM transactions t LEFT JOIN users u ON u.id=t.user_id
           WHERE t.trx_type='KELUAR' AND t.product_id=? AND {size_expr}=? AND {loc_sql}=?
           ORDER BY t.trx_date DESC, t.id DESC LIMIT ?""".format(
            size_expr=_size_sql("t.trx_size"), loc_sql=_loc_sql("t.location")
        ),
        (int(product_id), normalized, str(location or "").strip(), int(limit)),
    )
