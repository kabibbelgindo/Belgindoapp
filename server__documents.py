"""Penerimaan lokal (rit/nota), tally, dan rekap pembayaran."""
from __future__ import annotations

import secrets
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from .core import (
    AppError, DB, EPS, display_date, fmt_qty, iso_date, line_amount, m3_value,
    make_size, normalize_size, now_iso, parse_iso_date, resolve_location,
    size_display, size_parts, today_iso, trim_number, validate_dimensions_standard,
)
from .stock import assert_period_open, locked_through


def normalize_note_number(value) -> str:
    raw = str(value or "").strip().upper()
    if raw.startswith("BR-"):
        raw = raw[3:].strip()
    if not (3 <= len(raw) <= 6 and raw.isdigit()):
        raise AppError("Nomor nota harus 3 sampai 6 digit angka setelah prefix BR-.")
    return f"BR-{raw}"


def display_note(value) -> str:
    text = str(value or "").strip()
    if not text:
        return "-"
    return text if text.upper().startswith("BR-") else f"BR-{text}"


def _check_thickness(db: DB, value) -> float:
    try:
        thickness = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        raise AppError("Tebal (T) harus berupa angka.")
    if thickness <= 0:
        raise AppError("Tebal (T) harus lebih dari 0.")
    if thickness > 60:
        raise AppError("Tebal (T) maksimal 60 mm.")
    active = [float(row["value"]) for row in db.q(
        "SELECT value FROM master_spec_values WHERE dimension='T' AND active=1"
    )]
    if active and not any(abs(thickness - value) < EPS for value in active):
        options = ", ".join(trim_number(v) for v in sorted(active))
        raise AppError(f"Tebal (T) harus dipilih dari master ({options}).")
    return thickness


def _check_price(db: DB, value) -> float:
    try:
        if isinstance(value, (int, float)):
            price = float(value)
        else:
            text = str(value or "").strip()
            try:
                price = float(text)
            except ValueError:
                price = float(text.replace(".", "").replace(",", "."))
    except (TypeError, ValueError):
        raise AppError("Harga per m³ harus berupa angka.")
    if price <= 0:
        raise AppError("Harga per m³ harus lebih dari 0.")
    active = [float(row["price"]) for row in db.q(
        "SELECT price FROM master_price_values WHERE active=1"
    )]
    if active and not any(abs(price - value) < 0.5 for value in active):
        raise AppError("Harga per m³ harus dipilih dari master harga.")
    return price


def _seller(db: DB, seller_id: int) -> dict:
    row = db.one("SELECT * FROM sellers WHERE id=?", (int(seller_id),))
    if not row:
        raise AppError("Penjual tidak ditemukan.", 404)
    if not row["active"]:
        raise AppError("Penjual berstatus nonaktif.")
    return row


def _rit(db: DB, rit_id: int) -> dict:
    row = db.one(
        """SELECT r.*, s.name AS seller_name, s.active AS seller_active
           FROM seller_rits r JOIN sellers s ON s.id=r.seller_id WHERE r.id=?""",
        (int(rit_id),),
    )
    if not row:
        raise AppError("Rit tidak ditemukan.", 404)
    return row


def list_rits(db: DB, seller_id: int, month: str = "") -> list[dict]:
    _seller(db, seller_id)
    sql = """SELECT r.*, s.name AS seller_name, u.username
             FROM seller_rits r JOIN sellers s ON s.id=r.seller_id
             LEFT JOIN users u ON u.id=r.user_id
             WHERE r.seller_id=?"""
    args = [int(seller_id)]
    if str(month or "").strip():
        sql += " AND r.rit_month=?"
        args.append(str(month).strip())
    sql += " ORDER BY r.rit_date DESC, r.id DESC"
    rows = db.q(sql, args)
    totals: dict[int, dict] = {}
    for trx in db.q(
        """SELECT rit_id, qty, price, trx_size, trx_number FROM transactions
           WHERE rit_id IS NOT NULL AND trx_type='MASUK'"""
    ):
        bucket = totals.setdefault(int(trx["rit_id"]), {"notes": set(), "lines": 0, "qty": 0.0, "volume": 0.0, "amount": 0.0})
        bucket["notes"].add(trx.get("trx_number") or "")
        bucket["lines"] += 1
        bucket["qty"] += float(trx["qty"] or 0)
        volume = m3_value(trx["trx_size"], trx["qty"])
        bucket["volume"] += volume
        bucket["amount"] += volume * float(trx["price"] or 0)
    for row in rows:
        bucket = totals.get(int(row["id"]), {"notes": set(), "lines": 0, "qty": 0.0, "volume": 0.0, "amount": 0.0})
        row["notes_count"] = len([note for note in bucket["notes"] if note])
        row["lines_count"] = bucket["lines"]
        row["qty"] = round(bucket["qty"], 4)
        row["volume"] = round(bucket["volume"], 6)
        row["amount"] = round(bucket["amount"], 2)
        row["qty_display"] = fmt_qty(row["qty"])
        row["rit_number_display"] = f"{int(row['rit_number']):02d}"
        row["is_locked"] = bool(locked_through(db) and str(row["rit_date"])[:10] <= locked_through(db))
    return rows


def create_rit(db: DB, user_id: int, seller_id: int, rit_number, rit_date, delivery_number: str, note: str = "") -> dict:
    seller = _seller(db, seller_id)
    try:
        number = int(str(rit_number).strip())
    except (TypeError, ValueError):
        raise AppError("Nomor rit harus berupa angka bulat.")
    if number <= 0:
        raise AppError("Nomor rit harus lebih dari 0.")
    target_date = iso_date(rit_date, "Tanggal rit")
    if target_date > today_iso():
        raise AppError("Tanggal rit tidak boleh melewati hari ini.")
    assert_period_open(db, target_date, "menambah rit")
    delivery = str(delivery_number or "").strip()
    if len(delivery) > 80:
        raise AppError("Nomor surat jalan maksimal 80 karakter.")
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan rit maksimal 300 karakter.")
    month = target_date[:7]
    if db.one("SELECT id FROM seller_rits WHERE seller_id=? AND rit_month=? AND rit_number=?", (int(seller_id), month, number)):
        raise AppError(f"Rit {number:02d} untuk {seller['name']} pada bulan ini sudah ada.")
    stamp = now_iso()
    with db.atomic():
        new_id = db.insert(
            """INSERT INTO seller_rits(seller_id,rit_number,rit_date,rit_month,delivery_number,note,user_id,created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (int(seller_id), number, target_date, month, delivery, note, user_id, stamp),
        )
        db.log(user_id, "RIT_TAMBAH", f"id={new_id} | {seller['name']} | rit={number:02d} | {target_date} | SJ={delivery}", "seller_rits", new_id)
    return {"id": new_id}


def update_rit(db: DB, user_id: int, rit_id: int, rit_number, rit_date, delivery_number: str, note: str = "") -> dict:
    rit = _rit(db, rit_id)
    target_date = iso_date(rit_date, "Tanggal rit")
    if target_date > today_iso():
        raise AppError("Tanggal rit tidak boleh melewati hari ini.")
    assert_period_open(db, rit["rit_date"], "mengubah rit")
    assert_period_open(db, target_date, "mengubah rit")
    try:
        number = int(str(rit_number).strip())
    except (TypeError, ValueError):
        raise AppError("Nomor rit harus berupa angka bulat.")
    if number <= 0:
        raise AppError("Nomor rit harus lebih dari 0.")
    delivery = str(delivery_number or "").strip()
    month = target_date[:7]
    conflict = db.one(
        "SELECT id FROM seller_rits WHERE seller_id=? AND rit_month=? AND rit_number=? AND id<>?",
        (int(rit["seller_id"]), month, number, int(rit_id)),
    )
    if conflict:
        raise AppError(f"Rit {number:02d} untuk penjual ini pada bulan tersebut sudah ada.")
    trx = db.q("SELECT id FROM transactions WHERE rit_id=?", (int(rit_id),))
    for line in trx:
        blockers = note_line_blockers(db, int(line["id"]))
        if any(blockers.values()):
            raise AppError(blocker_message(blockers))
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan rit maksimal 300 karakter.")
    with db.atomic():
        db.run(
            "UPDATE seller_rits SET rit_number=?, rit_date=?, rit_month=?, delivery_number=?, note=? WHERE id=?",
            (number, target_date, month, delivery, note, int(rit_id)),
        )
        db.log(user_id, "RIT_UBAH", f"id={rit_id} | rit={number:02d} | {target_date} | SJ={delivery}", "seller_rits", int(rit_id))
    return {"id": int(rit_id)}


def delete_rit(db: DB, user_id: int, rit_id: int) -> dict:
    rit = _rit(db, rit_id)
    if db.one("SELECT id FROM transactions WHERE rit_id=? LIMIT 1", (int(rit_id),)):
        raise AppError("Rit masih memiliki transaksi. Hapus transaksi/nota terlebih dahulu.")
    with db.atomic():
        db.run("DELETE FROM seller_rits WHERE id=?", (int(rit_id),))
        db.log(user_id, "RIT_HAPUS", f"id={rit_id} | {rit['seller_name']} | rit={int(rit['rit_number']):02d} | {rit['rit_date']}", "seller_rits", int(rit_id))
    return {"deleted": True}


# --------------------------------------------------------------------------- nota

def _group_rows(rows: list[dict]) -> list[dict]:
    groups: dict[str, dict] = {}
    for row in rows:
        key = row.get("trx_number") or ""
        group = groups.setdefault(key, {
            "note": key or "(tanpa nomor nota)",
            "note_raw": key,
            "trx_ids": [],
            "lines": [],
            "qty": 0.0,
            "volume": 0.0,
            "amount": 0.0,
            "products": set(),
            "dates": [],
        })
        volume = m3_value(row["trx_size"], row["qty"])
        amount = volume * float(row["price"] or 0)
        row = {**row, "size_display": size_display(row["trx_size"]), "volume": round(volume, 6), "amount": round(amount, 2)}
        group["trx_ids"].append(int(row["id"]))
        group["lines"].append(row)
        group["qty"] += float(row["qty"] or 0)
        group["volume"] += volume
        group["amount"] += amount
        group["products"].add(int(row["product_id"]))
        group["dates"].append(str(row["trx_date"])[:10])
    result = []
    for group in groups.values():
        group["qty"] = round(group["qty"], 4)
        group["volume"] = round(group["volume"], 6)
        group["amount"] = round(group["amount"], 2)
        group["date"] = max(group["dates"]) if group["dates"] else None
        group["lines_count"] = len(group["lines"])
        group["products_count"] = len(group["products"])
        group.pop("dates", None)
        group.pop("products", None)
        result.append(group)
    result.sort(key=lambda item: (item["date"] or "", item["note"]), reverse=True)
    return result


def list_notes(db: DB, rit_id: int) -> dict:
    rit = _rit(db, rit_id)
    rows = db.q(
        """SELECT t.*, p.code, p.name, p.unit
           FROM transactions t JOIN products p ON p.id=t.product_id
           WHERE t.rit_id=? AND t.trx_type='MASUK'
           ORDER BY t.trx_date, t.id""",
        (int(rit_id),),
    )
    groups = _group_rows(rows)
    tallies = db.q(
        """SELECT id,tally_number,note,status,total_qty,total_volume,total_amount,created_at
           FROM tally_headers WHERE rit_id=? ORDER BY id DESC""",
        (int(rit_id),),
    )
    recaps = db.q(
        """SELECT id,recap_number,note,status,total_qty,total_volume,total_amount,created_at
           FROM payment_recap_headers WHERE rit_id=? ORDER BY id DESC""",
        (int(rit_id),),
    )
    for group in groups:
        group["tallies"] = [t for t in tallies if (t.get("note") or "") == group["note_raw"]]
        group["recaps"] = [r for r in recaps if (r.get("note") or "") == group["note_raw"]]
        active_tallies = [t for t in group["tallies"] if t["status"] == "POSTED"]
        active_recaps = [r for r in group["recaps"] if r["status"] == "AKTIF"]
        group["has_active_tally"] = bool(active_tallies)
        group["has_active_recap"] = bool(active_recaps)
        group["tally_numbers"] = [t["tally_number"] for t in active_tallies]
        group["recap_numbers"] = [r["recap_number"] for r in active_recaps]
        group["is_locked"] = bool(group["date"] and locked_through(db) and group["date"] <= locked_through(db))
    return {"rit": rit, "notes": groups}


def get_note(db: DB, rit_id: int, note: str) -> dict:
    rit = _rit(db, rit_id)
    clean_note = str(note or "").strip()
    rows = db.q(
        """SELECT t.*, p.code, p.name, p.unit
           FROM transactions t JOIN products p ON p.id=t.product_id
           WHERE t.rit_id=? AND t.trx_type='MASUK' AND COALESCE(t.trx_number,'')=?
           ORDER BY t.trx_date, t.id""",
        (int(rit_id), clean_note),
    )
    if not rows:
        raise AppError("Nota tidak ditemukan.", 404)
    lines = []
    totals = {"qty": 0.0, "volume": 0.0, "amount": 0.0}
    for row in rows:
        blockers = note_line_blockers(db, int(row["id"]))
        volume = m3_value(row["trx_size"], row["qty"])
        amount = volume * float(row["price"] or 0)
        l, t, p = size_parts(row["trx_size"])
        lines.append({
            **row,
            "size_display": size_display(row["trx_size"]),
            "l": trim_number(l), "t": trim_number(t), "p": trim_number(p),
            "volume": round(volume, 6), "amount": round(amount, 2),
            "blockers": blockers,
            "can_edit": not any(blockers.values()) and not (locked_through(db) and str(row["trx_date"])[:10] <= locked_through(db)),
        })
        totals["qty"] += float(row["qty"] or 0)
        totals["volume"] += volume
        totals["amount"] += amount
    latest = lines[-1]
    tallies = db.q(
        """SELECT th.*, u.username FROM tally_headers th LEFT JOIN users u ON u.id=th.created_by
           WHERE th.rit_id=? AND th.note=? ORDER BY th.id DESC""",
        (int(rit_id), clean_note),
    )
    recaps = db.q(
        """SELECT rh.*, u.username FROM payment_recap_headers rh LEFT JOIN users u ON u.id=rh.created_by
           WHERE rh.rit_id=? AND rh.note=? ORDER BY rh.id DESC""",
        (int(rit_id), clean_note),
    )
    return {
        "rit": rit,
        "note": clean_note,
        "note_display": display_note(clean_note),
        "date": str(latest["trx_date"])[:10],
        "thickness": latest["t"],
        "price": latest["price"],
        "location": latest["location"],
        "delivery_number": latest.get("delivery_number") or rit.get("delivery_number"),
        "supplier": latest.get("supplier") or rit.get("seller_name"),
        "lines": lines,
        "totals": {
            "qty": round(totals["qty"], 4),
            "volume": round(totals["volume"], 6),
            "amount": round(totals["amount"], 2),
            "qty_display": fmt_qty(totals["qty"]),
        },
        "tallies": tallies,
        "recaps": recaps,
    }


def note_line_blockers(db: DB, trx_id: int) -> dict:
    tally = db.one(
        """SELECT th.tally_number FROM tally_items ti JOIN tally_headers th ON th.id=ti.tally_id
           WHERE ti.trx_id=? AND th.status='POSTED' LIMIT 1""",
        (int(trx_id),),
    )
    recap = db.one(
        """SELECT rh.recap_number FROM payment_recap_items ri
           JOIN payment_recap_headers rh ON rh.id=ri.recap_id
           WHERE ri.trx_id=? AND ri.active=1 AND rh.status='AKTIF' LIMIT 1""",
        (int(trx_id),),
    )
    outgoing = db.one(
        "SELECT id FROM transactions WHERE trx_type='KELUAR' AND source_trx_id=? LIMIT 1",
        (int(trx_id),),
    )
    return {
        "tally": tally["tally_number"] if tally else None,
        "recap": recap["recap_number"] if recap else None,
        "outgoing": int(outgoing["id"]) if outgoing else None,
    }


def blocker_message(blockers: dict) -> str:
    parts = []
    if blockers.get("tally"):
        parts.append(f"tally {blockers['tally']} masih aktif")
    if blockers.get("recap"):
        parts.append(f"rekap pembayaran {blockers['recap']} masih aktif")
    if blockers.get("outgoing"):
        parts.append(f"stok sudah dipakai barang keluar #{blockers['outgoing']}")
    return "Tidak dapat mengubah data karena " + ", ".join(parts) + "."


def add_note_line(db: DB, user_id: int, rit_id: int, note, trx_date, thickness, price,
                  location: str, product_id: int, width, length, qty, line_note: str = "") -> dict:
    rit = _rit(db, rit_id)
    if not rit.get("seller_active"):
        raise AppError("Penjual berstatus nonaktif.")
    clean_note = normalize_note_number(note)
    target_date = iso_date(trx_date, "Tanggal nota")
    if target_date > today_iso():
        raise AppError("Tanggal nota tidak boleh melewati hari ini.")
    assert_period_open(db, target_date, "mencatat barang masuk")
    active_document = db.one(
        """SELECT tally_number AS document, 'tally' AS kind FROM tally_headers
           WHERE rit_id=? AND UPPER(TRIM(COALESCE(note,'')))=UPPER(?) AND status='POSTED'
           UNION ALL
           SELECT recap_number AS document, 'rekap pembayaran' AS kind FROM payment_recap_headers
           WHERE rit_id=? AND UPPER(TRIM(COALESCE(note,'')))=UPPER(?) AND status='AKTIF'
           LIMIT 1""",
        (int(rit_id), clean_note, int(rit_id), clean_note),
    )
    if active_document:
        raise AppError(
            f"Nota ini sudah memiliki {active_document['kind']} {active_document['document']} aktif "
            "sehingga baris baru tidak dapat ditambahkan."
        )
    t_value = _check_thickness(db, thickness)
    price_value = _check_price(db, price)
    location_value = resolve_location(db, location)
    product = db.one("SELECT * FROM products WHERE id=?", (int(product_id),))
    if not product:
        raise AppError("Barang tidak ditemukan.", 404)
    if not product["active"]:
        raise AppError("Barang berstatus nonaktif.")
    if str(product["code"]).upper().startswith("IMP/"):
        raise AppError("Barang impor tidak dapat dipakai pada Penerimaan Lokal.")
    try:
        qty_value = float(qty)
    except (TypeError, ValueError):
        raise AppError("Qty harus berupa angka.")
    if qty_value <= 0:
        raise AppError("Qty harus lebih dari 0.")
    size = make_size(t_value, width, length)
    validate_dimensions_standard(db, size)
    line_note = str(line_note or "").strip()
    if len(line_note) > 300:
        raise AppError("Catatan baris maksimal 300 karakter.")
    stamp = now_iso()
    with db.atomic():
        new_id = db.insert(
            """INSERT INTO transactions(
                   trx_date,trx_type,product_id,qty,price,note,trx_size,location,
                   seller_id,rit_id,source_trx_id,trx_number,delivery_number,supplier,user_id,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                target_date, "MASUK", int(product_id), qty_value, price_value, line_note,
                size, location_value, int(rit["seller_id"]), int(rit_id), None, clean_note,
                rit["delivery_number"], rit["seller_name"], user_id, stamp,
            ),
        )
        db.run(
            """INSERT INTO product_active_prices(product_id,active_price,updated_at,updated_by)
               VALUES(?,?,?,?)
               ON CONFLICT(product_id) DO UPDATE SET
                 active_price=excluded.active_price, updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
            (int(product_id), price_value, stamp, user_id),
        )
        db.log(
            user_id, "BARANG_MASUK",
            f"id={new_id} | {display_date(target_date)} | nota={clean_note} | "
            f"barang={product['code']} {product['name']} | ukuran={size_display(size)} | qty={fmt_qty(qty_value)} | "
            f"harga={price_value} | lokasi={location_value} | penjual={rit['seller_name']}",
            "transactions", new_id,
        )
    return {"id": new_id, "note": clean_note}


def update_note(db: DB, user_id: int, rit_id: int, note, trx_date, thickness, price,
                location: str, new_note=None) -> dict:
    rit = _rit(db, rit_id)
    old_note = str(note or "").strip()
    target_note = normalize_note_number(new_note if str(new_note or "").strip() else note)
    target_date = iso_date(trx_date, "Tanggal nota")
    if target_date > today_iso():
        raise AppError("Tanggal nota tidak boleh melewati hari ini.")
    if locked_through(db) and (
        str(rit["rit_date"])[:10] <= locked_through(db)
        or target_date <= locked_through(db)
    ):
        raise AppError("Nota berada pada periode yang sudah ditutup dan tidak dapat diubah.")
    assert_period_open(db, target_date, "mengubah nota")
    t_value = _check_thickness(db, thickness)
    price_value = _check_price(db, price)
    location_value = resolve_location(db, location)
    rows = db.q(
        "SELECT * FROM transactions WHERE rit_id=? AND trx_type='MASUK' AND COALESCE(trx_number,'')=?",
        (int(rit_id), old_note),
    )
    if not rows:
        raise AppError("Nota tidak ditemukan.", 404)
    for row in rows:
        assert_period_open(db, row["trx_date"], "mengubah nota")
        blockers = note_line_blockers(db, int(row["id"]))
        if any(blockers.values()):
            raise AppError(blocker_message(blockers))
    old_location = str(rows[0]["location"] or "").strip()
    if old_location != location_value:
        # Stok di setiap lokasi asal setelah baris nota dipindahkan tidak boleh minus.
        from .stock import stock_at
        moved: dict[tuple[int, str, str], float] = {}
        for row in rows:
            row_location = str(row["location"] or "").strip()
            if row_location == location_value:
                continue
            key = (int(row["product_id"]), normalize_size(row["trx_size"]), row_location)
            moved[key] = moved.get(key, 0.0) + float(row["qty"] or 0)
        for (product_id, row_size, row_location), total_move in moved.items():
            if stock_at(db, product_id, row_size, row_location) + EPS < total_move:
                raise AppError(
                    f"Stok di lokasi {row_location or '(tanpa lokasi)'} sudah terpakai atau termutasi. "
                    "Nota tidak dapat dipindahkan tanpa membuat stok minus."
                )
    if target_note != old_note:
        duplicate = db.one(
            "SELECT id FROM transactions WHERE rit_id=? AND UPPER(TRIM(COALESCE(trx_number,'')))=UPPER(?) AND COALESCE(trx_number,'')<>? LIMIT 1",
            (int(rit_id), target_note, old_note),
        )
        if duplicate:
            raise AppError("Nomor nota tersebut sudah ada pada Rit ini.")
    stamp = now_iso()
    updated = 0
    with db.atomic():
        for row in rows:
            l_old, _, p_old = size_parts(row["trx_size"])
            new_size = make_size(t_value, l_old, p_old)
            db.run(
                """UPDATE transactions SET trx_date=?,price=?,location=?,trx_size=?,trx_number=?
                   WHERE id=? AND trx_type='MASUK'""",
                (target_date, price_value, location_value, new_size, target_note, int(row["id"])),
            )
            updated += 1
        db.run(
            """INSERT INTO product_active_prices(product_id,active_price,updated_at,updated_by)
               VALUES(?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET
               active_price=excluded.active_price, updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
            (int(rows[0]["product_id"]), price_value, stamp, user_id),
        )
        db.log(
            user_id, "UBAH_NOTA",
            f"rit={rit_id} | nota={old_note} → {target_note} | tanggal={target_date} | "
            f"tebal={trim_number(t_value)} | harga={price_value} | lokasi={location_value} | baris={updated}",
            "seller_rits", int(rit_id),
        )
    return {"note": target_note, "updated": updated}


def delete_note_line(db: DB, user_id: int, trx_id: int) -> dict:
    row = db.one(
        """SELECT t.*, p.code, p.name FROM transactions t JOIN products p ON p.id=t.product_id
           WHERE t.id=? AND t.trx_type='MASUK'""",
        (int(trx_id),),
    )
    if not row:
        raise AppError("Baris nota tidak ditemukan.", 404)
    assert_period_open(db, row["trx_date"], "menghapus baris nota")
    blockers = note_line_blockers(db, int(trx_id))
    if any(blockers.values()):
        raise AppError(blocker_message(blockers))
    from .stock import stock_at
    size = normalize_size(row["trx_size"])
    available = stock_at(db, int(row["product_id"]), size, row["location"])
    if available + EPS < float(row["qty"] or 0):
        raise AppError(
            "Stok di lokasi ini sudah terpakai atau termutasi sehingga baris nota tidak dapat dihapus."
        )
    with db.atomic():
        db.run("DELETE FROM transactions WHERE id=? AND trx_type='MASUK'", (int(trx_id),))
        db.log(
            user_id, "HAPUS_BARIS_NOTA",
            f"id={trx_id} | nota={row.get('trx_number')} | barang={row.get('code')} {row.get('name')} | "
            f"ukuran={size_display(size)} | qty={fmt_qty(row['qty'])}",
            "transactions", int(trx_id),
        )
    return {"deleted": True}


# --------------------------------------------------------------------------- tally

def _new_tally_number(db: DB) -> str:
    for _ in range(20):
        number = "TL-{}-{}".format(datetime.now().strftime("%y%m%d%H%M%S"), secrets.token_hex(2).upper())
        if not db.one("SELECT id FROM tally_headers WHERE tally_number=?", (number,)):
            return number
    raise AppError("Tidak dapat membuat nomor tally unik.")


def create_tally(db: DB, user_id: int, rit_id: int, note, items: list[dict], signature: str) -> dict:
    rit = _rit(db, rit_id)
    clean_note = str(note or "").strip()
    signature = str(signature or "").strip()
    if len(signature) < 3:
        raise AppError("Nama pemeriksa/tanda tangan wajib diisi (minimal 3 karakter).")
    if len(signature) > 100:
        raise AppError("Nama pemeriksa maksimal 100 karakter.")
    if not items:
        raise AppError("Pilih minimal satu baris untuk dibuat tally.")
    source_rows = db.q(
        "SELECT * FROM transactions WHERE rit_id=? AND trx_type='MASUK' AND COALESCE(trx_number,'')=?",
        (int(rit_id), clean_note),
    )
    by_id = {int(row["id"]): row for row in source_rows}
    if not by_id:
        raise AppError("Nota tidak ditemukan.", 404)
    prepared = []
    for item in items:
        try:
            trx_id = int(item.get("trx_id"))
        except (TypeError, ValueError):
            raise AppError("Baris tally tidak valid.")
        source = by_id.get(trx_id)
        if not source:
            raise AppError("Baris tally bukan bagian dari nota ini.")
        duplicate = db.one(
            """SELECT th.tally_number FROM tally_items ti JOIN tally_headers th ON th.id=ti.tally_id
               WHERE ti.trx_id=? AND th.status='POSTED' LIMIT 1""",
            (trx_id,),
        )
        if duplicate:
            raise AppError(f"Transaksi ini sudah dibuatkan Tally {duplicate['tally_number']}.")
        try:
            qty = float(item.get("qty", source["qty"]))
        except (TypeError, ValueError):
            raise AppError("Qty tally harus berupa angka.")
        if qty <= 0:
            raise AppError("Qty tally harus lebih dari 0.")
        if qty > float(source["qty"]) + EPS:
            raise AppError(f"Qty tally melebihi qty barang masuk untuk {source['trx_number']}.")
        kind = str(item.get("kind") or "FRESH").upper()
        if kind not in {"FRESH", "AFKIR"}:
            raise AppError("Kategori tally harus FRESH atau AFKIR.")
        price = float(source["price"] or 0) if kind == "FRESH" else 0.0
        volume = m3_value(source["trx_size"], qty)
        amount = float((Decimal(str(volume)) * Decimal(str(price))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        prepared.append({
            "trx_id": trx_id, "product_id": int(source["product_id"]), "trx_size": normalize_size(source["trx_size"]),
            "qty": qty, "kind": kind, "price": price, "volume": volume, "amount": amount,
            "note": str(item.get("note") or "").strip()[:300],
        })
    stamp = now_iso()
    number = _new_tally_number(db)
    totals_qty = sum(item["qty"] for item in prepared)
    totals_volume = sum(item["volume"] for item in prepared)
    totals_amount = round(sum(item["amount"] for item in prepared), 2)
    with db.atomic():
        tally_id = db.insert(
            """INSERT INTO tally_headers(
                   tally_number,rit_id,seller_id,note,delivery_number,status,signature,
                   total_qty,total_volume,total_amount,created_by,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (number, int(rit_id), int(rit["seller_id"]), clean_note, rit.get("delivery_number"), "POSTED", signature,
             totals_qty, totals_volume, totals_amount, user_id, stamp),
        )
        for item in prepared:
            db.insert(
                """INSERT INTO tally_items(tally_id,trx_id,product_id,trx_size,qty,kind,price_m3,volume,amount,note)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (tally_id, item["trx_id"], item["product_id"], item["trx_size"], item["qty"], item["kind"],
                 item["price"], item["volume"], item["amount"], item["note"]),
            )
        db.log(
            user_id, "TALLY_SIMPAN",
            f"{number} | rit={rit_id} | nota={clean_note} | item={len(prepared)} | "
            f"qty={fmt_qty(totals_qty)} | m3={totals_volume:.6f} | total={totals_amount:.2f} | pemeriksa={signature}",
            "tally_headers", tally_id,
        )
    return {"id": tally_id, "tally_number": number, "total_amount": totals_amount}


def list_tallies(db: DB, seller_id=None, start="", end="", query="", status="") -> list[dict]:
    sql = """SELECT th.*, s.name AS seller_name, r.rit_number, r.rit_date, u.username
             FROM tally_headers th
             LEFT JOIN sellers s ON s.id=th.seller_id
             LEFT JOIN seller_rits r ON r.id=th.rit_id
             LEFT JOIN users u ON u.id=th.created_by
             WHERE 1=1"""
    args = []
    if seller_id not in (None, ""):
        sql += " AND th.seller_id=?"
        args.append(int(seller_id))
    if str(start or "").strip():
        sql += " AND SUBSTR(th.created_at,1,10)>=?"
        args.append(iso_date(start, "Tanggal dari"))
    if str(end or "").strip():
        sql += " AND SUBSTR(th.created_at,1,10)<=?"
        args.append(iso_date(end, "Tanggal sampai"))
    if str(status or "").strip():
        sql += " AND th.status=?"
        args.append(str(status))
    term = str(query or "").strip()
    if term:
        sql += " AND (COALESCE(th.tally_number,'') LIKE ? OR COALESCE(th.note,'') LIKE ? OR COALESCE(s.name,'') LIKE ? OR COALESCE(th.signature,'') LIKE ?)"
        args.extend([f"%{term}%"] * 4)
    sql += " ORDER BY th.id DESC"
    rows = db.q(sql, args)
    for row in rows:
        row["item_count"] = db.scalar("SELECT COUNT(*) FROM tally_items WHERE tally_id=?", (int(row["id"]),), 0)
        row["rit_number_display"] = f"{int(row['rit_number']):02d}" if row.get("rit_number") else "-"
        row["created_display"] = f"{display_date(str(row['created_at'])[:10])}"
    return rows


def get_tally(db: DB, tally_id: int) -> dict:
    header = db.one(
        """SELECT th.*, s.name AS seller_name, r.rit_number, r.rit_date, r.delivery_number AS rit_delivery,
                  u.username FROM tally_headers th
           LEFT JOIN sellers s ON s.id=th.seller_id
           LEFT JOIN seller_rits r ON r.id=th.rit_id
           LEFT JOIN users u ON u.id=th.created_by WHERE th.id=?""",
        (int(tally_id),),
    )
    if not header:
        raise AppError("Tally tidak ditemukan.", 404)
    items = db.q(
        """SELECT ti.*, p.code, p.name, p.unit, t.trx_number, t.trx_date, t.note AS trx_note
           FROM tally_items ti
           JOIN products p ON p.id=ti.product_id
           JOIN transactions t ON t.id=ti.trx_id
           WHERE ti.tally_id=? ORDER BY ti.id""",
        (int(tally_id),),
    )
    for item in items:
        item["size_display"] = size_display(item["trx_size"])
        item["qty_display"] = fmt_qty(item["qty"])
    header["items"] = items
    header["rit_number_display"] = f"{int(header['rit_number']):02d}" if header.get("rit_number") else "-"
    header["can_cancel"] = header["status"] == "POSTED" and not _tally_locked(db, header)
    return header


def _tally_locked(db: DB, header: dict) -> bool:
    rows = db.q(
        """SELECT t.trx_date FROM tally_items ti JOIN transactions t ON t.id=ti.trx_id
           WHERE ti.tally_id=?""",
        (int(header["id"]),),
    )
    locked = locked_through(db)
    return bool(locked and any(str(row["trx_date"])[:10] <= locked for row in rows))


def cancel_tally(db: DB, user_id: int, tally_id: int, reason: str = "") -> dict:
    header = get_tally(db, tally_id)
    if header["status"] != "POSTED":
        raise AppError("Tally ini sudah dibatalkan.")
    if _tally_locked(db, header):
        raise AppError("Tally berada pada periode yang sudah ditutup sehingga tidak dapat dibatalkan.")
    reason = str(reason or "").strip()
    if len(reason) > 300:
        raise AppError("Alasan maksimal 300 karakter.")
    with db.atomic():
        db.run(
            "UPDATE tally_headers SET status='BATAL', cancelled_at=?, cancel_note=? WHERE id=? AND status='POSTED'",
            (now_iso(), reason, int(tally_id)),
        )
        db.log(user_id, "TALLY_BATAL", f"{header['tally_number']} | alasan={reason or '-'}", "tally_headers", int(tally_id))
    return {"cancelled": True}


# --------------------------------------------------------------------------- rekap pembayaran

def _new_recap_number(db: DB) -> str:
    for _ in range(20):
        number = "RK-{}-{}".format(datetime.now().strftime("%y%m%d"), secrets.token_hex(2).upper())
        if not db.one("SELECT id FROM payment_recap_headers WHERE recap_number=?", (number,)):
            return number
    raise AppError("Tidak dapat membuat nomor rekap unik.")


def create_recap(db: DB, user_id: int, rit_id: int, note) -> dict:
    rit = _rit(db, rit_id)
    clean_note = str(note or "").strip()
    rows = db.q(
        """SELECT t.*, p.code, p.name FROM transactions t JOIN products p ON p.id=t.product_id
           WHERE t.rit_id=? AND t.trx_type='MASUK' AND COALESCE(t.trx_number,'')=?""",
        (int(rit_id), clean_note),
    )
    if not rows:
        raise AppError("Nota tidak ditemukan.", 404)
    prepared = []
    for row in rows:
        assert_period_open(db, row["trx_date"], "membuat rekap pembayaran")
        active = db.one(
            """SELECT rh.recap_number, rh.created_at FROM payment_recap_items ri
               JOIN payment_recap_headers rh ON rh.id=ri.recap_id
               WHERE ri.trx_id=? AND ri.active=1 AND rh.status='AKTIF' LIMIT 1""",
            (int(row["id"]),),
        )
        if active:
            raise AppError(
                f"Transaksi {row.get('trx_number') or '-'} sudah masuk rekap aktif {active['recap_number']} "
                f"({display_date(str(active['created_at'])[:10])}). Batalkan rekap lama terlebih dahulu."
            )
        volume = m3_value(row["trx_size"], row["qty"])
        amount = float((Decimal(str(volume)) * Decimal(str(row["price"] or 0))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        prepared.append({
            "trx_id": int(row["id"]), "qty": float(row["qty"]), "size": normalize_size(row["trx_size"]),
            "price": float(row["price"] or 0), "volume": volume, "amount": amount,
        })
    total_qty = sum(item["qty"] for item in prepared)
    total_volume = sum(item["volume"] for item in prepared)
    total_amount = round(sum(item["amount"] for item in prepared), 2)
    number = _new_recap_number(db)
    stamp = now_iso()
    with db.atomic():
        recap_id = db.insert(
            """INSERT INTO payment_recap_headers(
                   recap_number,seller_id,rit_id,note,total_qty,total_volume,total_amount,status,created_by,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (number, int(rit["seller_id"]), int(rit_id), clean_note, total_qty, total_volume, total_amount,
             "AKTIF", user_id, stamp),
        )
        for item in prepared:
            db.insert(
                """INSERT INTO payment_recap_items(recap_id,trx_id,active,qty,trx_size,price,volume,amount)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (recap_id, item["trx_id"], 1, item["qty"], item["size"], item["price"], item["volume"], item["amount"]),
            )
        db.log(
            user_id, "REKAP_PEMBAYARAN",
            f"{number} | rit={rit_id} | nota={clean_note} | item={len(prepared)} | "
            f"qty={fmt_qty(total_qty)} | total={total_amount:.2f}",
            "payment_recap_headers", recap_id,
        )
    return {"id": recap_id, "recap_number": number, "total_amount": total_amount}


def list_recaps(db: DB, seller_id=None, start="", end="", query="", status="") -> list[dict]:
    sql = """SELECT rh.*, s.name AS seller_name, r.rit_number, u.username
             FROM payment_recap_headers rh
             LEFT JOIN sellers s ON s.id=rh.seller_id
             LEFT JOIN seller_rits r ON r.id=rh.rit_id
             LEFT JOIN users u ON u.id=rh.created_by
             WHERE 1=1"""
    args = []
    if seller_id not in (None, ""):
        sql += " AND rh.seller_id=?"
        args.append(int(seller_id))
    if str(start or "").strip():
        sql += " AND SUBSTR(rh.created_at,1,10)>=?"
        args.append(iso_date(start, "Tanggal dari"))
    if str(end or "").strip():
        sql += " AND SUBSTR(rh.created_at,1,10)<=?"
        args.append(iso_date(end, "Tanggal sampai"))
    if str(status or "").strip():
        sql += " AND rh.status=?"
        args.append(str(status))
    term = str(query or "").strip()
    if term:
        sql += " AND (COALESCE(rh.recap_number,'') LIKE ? OR COALESCE(rh.note,'') LIKE ? OR COALESCE(s.name,'') LIKE ?)"
        args.extend([f"%{term}%"] * 3)
    sql += " ORDER BY rh.id DESC"
    rows = db.q(sql, args)
    for row in rows:
        row["item_count"] = db.scalar("SELECT COUNT(*) FROM payment_recap_items WHERE recap_id=? AND active=1", (int(row["id"]),), 0)
        row["rit_number_display"] = f"{int(row['rit_number']):02d}" if row.get("rit_number") else "-"
    return rows


def get_recap(db: DB, recap_id: int) -> dict:
    header = db.one(
        """SELECT rh.*, s.name AS seller_name, r.rit_number, r.rit_date, u.username
           FROM payment_recap_headers rh
           LEFT JOIN sellers s ON s.id=rh.seller_id
           LEFT JOIN seller_rits r ON r.id=rh.rit_id
           LEFT JOIN users u ON u.id=rh.created_by WHERE rh.id=?""",
        (int(recap_id),),
    )
    if not header:
        raise AppError("Rekap pembayaran tidak ditemukan.", 404)
    items = db.q(
        """SELECT ri.*, p.code, p.name, p.unit, t.trx_date, t.trx_number,
                  t.delivery_number, t.supplier
           FROM payment_recap_items ri
           JOIN transactions t ON t.id=ri.trx_id
           JOIN products p ON p.id=t.product_id
           WHERE ri.recap_id=? ORDER BY ri.id""",
        (int(recap_id),),
    )
    for item in items:
        item["size_display"] = size_display(item["trx_size"])
        item["qty_display"] = fmt_qty(item["qty"])
    header["items"] = items
    header["rit_number_display"] = f"{int(header['rit_number']):02d}" if header.get("rit_number") else "-"
    locked = locked_through(db)
    header["can_cancel"] = header["status"] == "AKTIF" and not (
        locked and any(str(item["trx_date"])[:10] <= locked for item in items)
    )
    return header


def cancel_recap(db: DB, user_id: int, recap_id: int, reason: str = "") -> dict:
    header = get_recap(db, recap_id)
    if header["status"] != "AKTIF":
        raise AppError("Rekap pembayaran ini sudah dibatalkan.")
    locked = locked_through(db)
    for item in header["items"]:
        if locked and str(item["trx_date"])[:10] <= locked:
            raise AppError("Rekap pembayaran berada pada periode yang sudah ditutup sehingga tidak dapat dibatalkan.")
    reason = str(reason or "").strip()
    if len(reason) > 300:
        raise AppError("Alasan maksimal 300 karakter.")
    with db.atomic():
        db.run(
            "UPDATE payment_recap_headers SET status='BATAL', cancelled_at=?, cancel_note=? WHERE id=? AND status='AKTIF'",
            (now_iso(), reason, int(recap_id)),
        )
        db.run("UPDATE payment_recap_items SET active=0 WHERE recap_id=?", (int(recap_id),))
        db.log(user_id, "BATAL_REKAP_PEMBAYARAN", f"{header['recap_number']} | alasan={reason or '-'}", "payment_recap_headers", int(recap_id))
    return {"cancelled": True}


def seller_directory(db: DB) -> list[dict]:
    rows = db.q(
        """SELECT s.*,
                  (SELECT COUNT(*) FROM seller_rits r WHERE r.seller_id=s.id) AS rit_count,
                  (SELECT COUNT(*) FROM transactions t WHERE t.seller_id=s.id AND t.trx_type='MASUK') AS line_count,
                  (SELECT COALESCE(SUM(t.qty),0) FROM transactions t WHERE t.seller_id=s.id AND t.trx_type='MASUK') AS qty_in,
                  (SELECT COALESCE(SUM(t.qty),0) FROM transactions t WHERE t.seller_id=s.id AND t.trx_type='KELUAR') AS qty_out,
                  (SELECT MAX(t.trx_date) FROM transactions t WHERE t.seller_id=s.id) AS last_trx
           FROM sellers s ORDER BY s.active DESC, s.name COLLATE NOCASE"""
    )
    for row in rows:
        row["qty_in_display"] = fmt_qty(row["qty_in"])
        row["qty_out_display"] = fmt_qty(row["qty_out"])
    return rows
