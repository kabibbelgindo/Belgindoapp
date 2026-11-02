"""Penerimaan kayu impor: parser payload, pencatatan, riwayat, dan koreksi."""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import date, datetime

from .core import (
    AppError, DB, display_date, fmt_qty, iso_date, m3_value, make_size,
    normalize_size, now_iso, resolve_location, size_display, today_iso,
)
from .stock import assert_period_open

ALIASES = {
    "barcode": ("barcode", "bar_code", "kode_barcode", "code", "id"),
    "product_code": ("product_code", "kode_barang", "kode", "sku", "item_code"),
    "product_name": ("product_name", "nama_barang", "nama", "item", "product", "species", "jenis_kayu"),
    "size": ("size", "ukuran", "dimension", "dimensi"),
    "length": ("length", "panjang", "p"),
    "width": ("width", "lebar", "l"),
    "thickness": ("thickness", "tebal", "t"),
    "qty": ("qty", "quantity", "jumlah", "batang"),
    "supplier": ("supplier", "pemasok", "exporter", "asal", "country", "negara_asal"),
    "number": ("number", "document", "no_dokumen", "invoice", "invoice_no"),
    "date": ("date", "tanggal"),
    "location": ("location", "lokasi", "warehouse", "gudang"),
    "price": ("price", "harga", "harga_m3", "price_m3"),
    "note": ("note", "catatan"),
}


def parse_payload(payload) -> dict:
    """Terima JSON objek, pasangan KEY=VALUE/KEY:VALUE, atau teks dipisah | ; newline."""
    if isinstance(payload, dict):
        data = {str(key).strip().lower(): str(value).strip() for key, value in payload.items() if value is not None}
        raw = json.dumps(payload, ensure_ascii=False)
    else:
        raw = str(payload or "").strip()
        data = {}
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                data = {str(key).strip().lower(): str(value).strip() for key, value in obj.items() if value is not None}
        except (ValueError, TypeError):
            pass
        if not data:
            for part in re.split(r"[|;\n]+", raw):
                if "=" in part:
                    key, value = part.split("=", 1)
                    data[key.strip().lower()] = value.strip()
                elif ":" in part:
                    key, value = part.split(":", 1)
                    data[key.strip().lower()] = value.strip()
    out = {"raw": raw}
    for target, keys in ALIASES.items():
        for key in keys:
            if key in data and str(data[key]).strip():
                out[target] = str(data[key]).strip()
                break
    for key, value in data.items():
        out.setdefault(key, value)
    return out


def _parse_date(value) -> str:
    text = str(value or "").strip()
    if not text:
        text = date.today().strftime("%d-%m-%Y")
    for pattern in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            parsed = datetime.strptime(text[:10], pattern).date()
            return parsed.isoformat()
        except ValueError:
            continue
    raise AppError("Tanggal tidak valid. Gunakan format DD-MM-YYYY.")


def _positive_number(value, label: str, allow_zero: bool = False) -> float:
    try:
        number = float(str(value).replace(",", ".").replace("Rp", "").strip())
    except (TypeError, ValueError):
        raise AppError(f"{label} harus berupa angka.")
    if not math.isfinite(number) or (number < 0 or (number == 0 and not allow_zero)):
        raise AppError(f"{label} harus {'nol atau lebih' if allow_zero else 'lebih dari nol'}.")
    return number


def _price_value(value) -> float:
    text = str(value or "0").strip().replace("Rp", "").replace(" ", "")
    if not text:
        return 0.0
    if re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d+)?", text):
        text = text.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d+)?", text):
        text = text.replace(",", "")
    else:
        text = text.replace(",", ".")
    return _positive_number(text, "Harga per m³", allow_zero=True)


def _dimensions(data: dict) -> str:
    thickness, width, length = data.get("thickness"), data.get("width"), data.get("length")
    if any(str(value or "").strip() for value in (thickness, width, length)):
        values = []
        for label, raw in (("Tebal", thickness), ("Lebar", width), ("Panjang", length)):
            text = str(raw or "").strip()
            if not re.fullmatch(r"\d{1,4}", text) or int(text) <= 0:
                raise AppError(f"Ukuran {label} harus angka positif maksimal 4 digit.")
            values.append(int(text))
        return make_size(values[0], values[1], values[2])
    raw_size = str(data.get("size") or "").strip()
    if not raw_size:
        raise AppError("Ukuran (T, L, P) wajib diisi.")
    try:
        normalized = normalize_size(raw_size)
    except AppError:
        raise AppError("Ukuran tidak valid. Gunakan format T×L×P atau T, L, P.")
    if not normalized:
        raise AppError("Ukuran wajib diisi.")
    return normalized


def _split_note(note: str) -> tuple[str, str]:
    text = str(note or "")
    match = re.search(r"BARCODE=([^;]*);\s*", text)
    if match:
        barcode = match.group(1).strip()
        rest = (text[:match.start()] + text[match.end():]).strip()
    else:
        barcode = ""
        rest = text.strip()
    prefix = "Penerimaan impor."
    if rest.startswith(prefix):
        rest = rest[len(prefix):].strip()
    return barcode, rest


def _import_number(db: DB, number: str, barcode: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_-]", "", str(number or barcode or ""))[:35]
    trx_number = "IMP-" + (stem or uuid.uuid4().hex[:12])
    if db.one("SELECT id FROM transactions WHERE trx_number=?", (trx_number,)):
        raise AppError("Nomor penerimaan impor sudah pernah digunakan. Periksa barcode atau nomor dokumen.")
    return trx_number


def _prepare(db: DB, data: dict) -> dict:
    name = str(data.get("product_name") or data.get("product") or data.get("product_code") or "").strip().upper()
    if not name:
        raise AppError("Nama barang wajib diisi.")
    if len(name) > 120:
        raise AppError("Nama barang maksimal 120 karakter.")
    trx_date = _parse_date(data.get("date"))
    if trx_date > today_iso():
        raise AppError("Tanggal penerimaan tidak boleh melewati hari ini.")
    assert_period_open(db, trx_date, "menyimpan penerimaan impor")
    size = _dimensions(data)
    qty = _positive_number(data.get("qty"), "Jumlah batang")
    if qty > 1_000_000:
        raise AppError("Jumlah batang tidak wajar.")
    price = _price_value(data.get("price"))
    location = str(data.get("location") or "").strip()
    if not location:
        raise AppError("Lokasi gudang wajib diisi.")
    location = resolve_location(db, location)
    barcode = str(data.get("barcode") or "").strip()[:120]
    number = str(data.get("number") or "").strip()[:80]
    supplier = str(data.get("supplier") or "").strip()[:120]
    note = str(data.get("note") or "").strip()[:300]
    return {
        "name": name, "trx_date": trx_date, "size": size, "qty": qty, "price": price,
        "location": location, "barcode": barcode, "number": number,
        "supplier": supplier, "note": note,
    }


def _ensure_product(db: DB, name: str) -> dict:
    slug = re.sub(r"[^A-Za-z0-9]", "", name)[:18] or "ITEM"
    code = f"IMP/{slug}"
    counter = 1
    while True:
        product = db.one("SELECT * FROM products WHERE code=? COLLATE NOCASE", (code,))
        if not product:
            product_id = db.insert(
                "INSERT INTO products(code,name,unit,purchase_price,active,created_at) VALUES(?,?,?,?,1,?)",
                (code, name, "BATANG", 0, now_iso()),
            )
            return db.one("SELECT * FROM products WHERE id=?", (product_id,))
        if str(product.get("name") or "").strip().upper() == name:
            return product
        counter += 1
        code = f"IMP/{slug}{counter}"


def create_import(db: DB, user_id: int, payload) -> dict:
    data = payload if isinstance(payload, dict) and "parsed" not in payload else parse_payload(payload)
    prepared = _prepare(db, data)
    stamp = now_iso()
    with db.atomic():
        product = _ensure_product(db, prepared["name"])
        trx_number = _import_number(db, prepared["number"], prepared["barcode"])
        note_parts = []
        if prepared["barcode"]:
            note_parts.append(f"BARCODE={prepared['barcode']};")
        note_parts.append("Penerimaan impor.")
        if prepared["note"]:
            note_parts.append(prepared["note"])
        note_text = " ".join(note_parts)
        trx_id = db.insert(
            """INSERT INTO transactions(
                   trx_date,trx_type,product_id,qty,price,note,trx_size,location,
                   seller_id,rit_id,source_trx_id,trx_number,delivery_number,supplier,user_id,created_at
               ) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)""",
            (prepared["trx_date"], "MASUK", int(product["id"]), prepared["qty"], prepared["price"],
             note_text, prepared["size"], prepared["location"], trx_number,
             prepared["number"] or None, prepared["supplier"], int(user_id), stamp),
        )
        db.log(
            user_id, "PENERIMAAN_IMPOR",
            f"{trx_number} | produk={product['code']} {product['name']} | ukuran={size_display(prepared['size'])} | "
            f"qty={fmt_qty(prepared['qty'])} | lokasi={prepared['location']} | pemasok={prepared['supplier'] or '-'}",
            "transactions", trx_id,
        )
    return get_import(db, trx_id)


def list_imports(db: DB, start: str = "", end: str = "", query: str = "") -> dict:
    if not str(start or "").strip():
        start = date.today().replace(day=1).isoformat()
    else:
        start = iso_date(start, "Tanggal dari")
    if not str(end or "").strip():
        end = date.today().isoformat()
    else:
        end = iso_date(end, "Tanggal sampai")
    if start > end:
        raise AppError("Tanggal dari tidak boleh melewati tanggal sampai.")
    sql = """
        SELECT t.id, t.trx_date, t.trx_number, t.qty, t.price, t.note, t.trx_size,
               t.location, t.supplier, t.delivery_number, t.created_at,
               p.code, p.name, u.username
        FROM transactions t
        JOIN products p ON p.id=t.product_id
        LEFT JOIN users u ON u.id=t.user_id
        WHERE t.trx_type='MASUK' AND COALESCE(t.trx_number,'') LIKE 'IMP-%'
          AND t.trx_date>=? AND t.trx_date<=?
    """
    args = [start, end]
    term = str(query or "").strip()
    if term:
        sql += (
            " AND (COALESCE(t.trx_number,'') LIKE ? OR COALESCE(t.delivery_number,'') LIKE ? OR "
            "COALESCE(p.code,'') LIKE ? OR COALESCE(p.name,'') LIKE ? OR "
            "COALESCE(t.supplier,'') LIKE ? OR COALESCE(t.note,'') LIKE ? OR COALESCE(t.location,'') LIKE ?)"
        )
        args.extend([f"%{term}%"] * 7)
    sql += " ORDER BY t.trx_date DESC, t.id DESC"
    rows = db.q(sql, args)
    total_qty = total_m3 = total_amount = 0.0
    for row in rows:
        barcode, _ = _split_note(row.get("note") or "")
        row["barcode"] = barcode
        row["document_number"] = row.get("delivery_number") or ""
        row["size"] = normalize_size(row["trx_size"])
        row["size_display"] = size_display(row["size"])
        row["qty_display"] = fmt_qty(row["qty"])
        row["date_display"] = display_date(str(row["trx_date"])[:10])
        volume = m3_value(row["size"], row["qty"])
        row["m3"] = round(volume, 6)
        row["amount"] = round(volume * float(row["price"] or 0), 2)
        total_qty += float(row["qty"] or 0)
        total_m3 += volume
        total_amount += volume * float(row["price"] or 0)
    return {
        "start": start, "end": end,
        "start_display": display_date(start), "end_display": display_date(end),
        "rows": rows,
        "totals": {
            "count": len(rows), "qty": round(total_qty, 4),
            "m3": round(total_m3, 6), "amount": round(total_amount, 2),
        },
    }


def get_import(db: DB, trx_id: int) -> dict:
    row = db.one(
        """SELECT t.*, p.code, p.name, p.unit, u.username
           FROM transactions t JOIN products p ON p.id=t.product_id
           LEFT JOIN users u ON u.id=t.user_id
           WHERE t.id=? AND t.trx_type='MASUK' AND COALESCE(t.trx_number,'') LIKE 'IMP-%'""",
        (int(trx_id),),
    )
    if not row:
        raise AppError("Penerimaan impor tidak ditemukan.", 404)
    barcode, note = _split_note(row.get("note") or "")
    row["barcode"] = barcode
    row["user_note"] = note
    row["size"] = normalize_size(row["trx_size"])
    row["size_display"] = size_display(row["size"])
    row["volume"] = round(m3_value(row["size"], row["qty"]), 6)
    row["amount"] = round(row["volume"] * float(row["price"] or 0), 2)
    row["date_display"] = display_date(str(row["trx_date"])[:10])
    row["used"] = round(float(db.scalar(
        "SELECT COALESCE(SUM(qty),0) FROM transactions WHERE source_trx_id=? AND trx_type='KELUAR'",
        (int(trx_id),), 0,
    ) or 0), 4)
    row["can_edit"] = True
    return row


def update_import(db: DB, user_id: int, trx_id: int, payload: dict) -> dict:
    current = get_import(db, trx_id)
    data = dict(payload or {})
    trx_date = _parse_date(data.get("date", current["trx_date"]))
    if trx_date > today_iso():
        raise AppError("Tanggal penerimaan tidak boleh melewati hari ini.")
    assert_period_open(db, current["trx_date"], "mengubah penerimaan impor")
    assert_period_open(db, trx_date, "mengubah penerimaan impor")
    qty = _positive_number(data.get("qty", current["qty"]), "Jumlah batang")
    if qty + 0.0001 < float(current["used"]):
        raise AppError(f"Qty tidak boleh lebih kecil dari barang keluar yang sudah memakai lot ini ({fmt_qty(current['used'])}).")
    price = _price_value(data.get("price", current["price"]))
    supplier = str(data.get("supplier", current.get("supplier")) or "").strip()[:120]
    note = str(data.get("note", current.get("user_note")) or "").strip()[:300]
    barcode = str(data.get("barcode", current.get("barcode")) or "").strip()[:120]
    note_parts = []
    if barcode:
        note_parts.append(f"BARCODE={barcode};")
    note_parts.append("Penerimaan impor.")
    if note:
        note_parts.append(note)
    with db.atomic():
        db.run(
            "UPDATE transactions SET trx_date=?,qty=?,price=?,supplier=?,note=? WHERE id=? AND trx_type='MASUK'",
            (trx_date, qty, price, supplier, " ".join(note_parts), int(trx_id)),
        )
        db.log(
            user_id, "UBAH_PENERIMAAN_IMPOR",
            f"{current['trx_number']} | qty {fmt_qty(current['qty'])} -> {fmt_qty(qty)} | "
            f"tgl {current['trx_date']} -> {trx_date} | harga={price:g}",
            "transactions", int(trx_id),
        )
    return get_import(db, trx_id)
