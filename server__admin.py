"""Administrasi data master, pengguna, backup, reset, dan status sinkronisasi lokal."""
from __future__ import annotations

import os
import re
import secrets
import shutil
import sqlite3
import tempfile
from datetime import datetime

from .core import (
    AppError, DB, DEVELOPER_USERNAME, check_new_password, generate_name_code,
    hash_password, now_iso, verify_password,
)

IMPORT_PREFIX = "IMP/"
PRODUCT_UNITS = ("BATANG", "LEMBAR", "KUBIK", "TON")


def is_import_code(code) -> bool:
    return str(code or "").strip().upper().startswith(IMPORT_PREFIX)


def require_admin(user: dict | None) -> dict:
    if not user or user.get("role") != "admin" or not user.get("active"):
        raise AppError("Akses ditolak. Tindakan ini khusus administrator.", 403, "FORBIDDEN")
    return user


def require_primary(user: dict | None) -> dict:
    require_admin(user)
    if not user.get("is_primary_admin"):
        raise AppError(
            "Akses ditolak. Perubahan status data master hanya dapat dilakukan Admin Utama.",
            403, "PRIMARY_REQUIRED",
        )
    return user


def _text(value, label: str, required: bool = False, max_len: int = 180) -> str:
    text = str(value if value is not None else "").strip()
    if required and not text:
        raise AppError(f"{label} wajib diisi.")
    if len(text) > max_len:
        raise AppError(f"{label} maksimal {max_len} karakter.")
    return text


def _number(value, label: str, minimum: float = 0.0, allow_blank: bool = False) -> float | None:
    if value in (None, "") and allow_blank:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise AppError(f"{label} harus berupa angka.")
    if number < minimum:
        raise AppError(f"{label} minimal {minimum:g}.")
    return number


def _flag(value, default: bool = True) -> int:
    if value is None:
        return 1 if default else 0
    if isinstance(value, bool):
        return 1 if value else 0
    return 1 if str(value).strip().lower() in ("1", "true", "ya", "aktif", "active", "on") else 0


def _unique_error(exc: Exception, message: str) -> None:
    if isinstance(exc, sqlite3.IntegrityError):
        raise AppError(message)


# --------------------------------------------------------------------------- produk


def list_products(db: DB, include_inactive: bool = True, local_only: bool = False,
                  query: str = "") -> list[dict]:
    sql = """
        SELECT p.*, COALESCE(pap.active_price, 0) AS active_price,
               pap.updated_at AS price_updated_at
        FROM products p LEFT JOIN product_active_prices pap ON pap.product_id=p.id
        WHERE 1=1
    """
    args = []
    if not include_inactive:
        sql += " AND p.active=1"
    if local_only:
        sql += " AND p.active=1 AND p.code NOT LIKE 'IMP/%'"
    term = str(query or "").strip()
    if term:
        sql += " AND (p.code LIKE ? OR p.name LIKE ?)"
        args.extend([f"%{term}%", f"%{term}%"])
    sql += " ORDER BY p.name COLLATE NOCASE, p.code"
    rows = db.q(sql, args)
    for row in rows:
        row["is_import"] = is_import_code(row["code"])
        row["size_default_display"] = _default_size(row)
    return rows


def _default_size(row: dict) -> str:
    specs = [row.get("spec_t"), row.get("spec_l"), row.get("spec_p")]
    if all(value not in (None, "") for value in specs):
        return " × ".join(f"{float(value):g}" for value in specs)
    return "-"


def get_product(db: DB, product_id: int) -> dict:
    row = db.one(
        """SELECT p.*, COALESCE(pap.active_price,0) AS active_price
           FROM products p LEFT JOIN product_active_prices pap ON pap.product_id=p.id
           WHERE p.id=?""",
        (int(product_id),),
    )
    if not row:
        raise AppError("Barang tidak ditemukan.", 404)
    row["is_import"] = is_import_code(row["code"])
    return row


def _check_active_spec(db: DB, dimension: str, value, label: str) -> float | None:
    if value in (None, ""):
        return None
    number = _number(value, label)
    row = db.one(
        "SELECT id FROM master_spec_values WHERE dimension=? AND value=? AND active=1",
        (dimension, number),
    )
    if not row:
        raise AppError(f"{label} {number:g} tidak ada pada master ukuran aktif.")
    return number


def _check_active_price(db: DB, value) -> float:
    price = _number(value, "Harga aktif", 0.0)
    if price == 0:
        return 0.0
    if not db.one("SELECT id FROM master_price_values WHERE price=? AND active=1", (price,)):
        raise AppError(f"Harga {price:,.0f} tidak ada pada master harga aktif.".replace(",", "."))
    return price


def _prepare_product(db: DB, payload: dict, current: dict | None = None) -> dict:
    name = _text(payload.get("name") or (current or {}).get("name"), "Nama barang", True, 120)
    code = _text(payload.get("code") or (current or {}).get("code"), "Kode barang", False, 40).upper()
    if current and is_import_code(current.get("code")):
        code = current["code"]
    elif code and is_import_code(code):
        raise AppError("Kode dengan awalan IMP/ khusus barang hasil impor dan tidak dapat dibuat manual.")
    if current is None and not code:
        code = generate_name_code(db, name)
    if current and current.get("code") and code != current["code"]:
        used = db.one(
            "SELECT (SELECT COUNT(*) FROM transactions WHERE product_id=?) + "
            "(SELECT COUNT(*) FROM stock_opname_items WHERE product_id=?) AS n",
            (int(current["id"]), int(current["id"])),
        )
        if used and int(used["n"] or 0) > 0:
            raise AppError("Kode barang tidak dapat diubah karena sudah dipakai transaksi/opname.")
    unit = _text(payload.get("unit", (current or {}).get("unit", "BATANG")), "Satuan", True, 20).upper()
    if unit not in PRODUCT_UNITS:
        raise AppError("Satuan harus salah satu dari: " + ", ".join(PRODUCT_UNITS) + ".")
    purchase_price = _number(payload.get("purchase_price", (current or {}).get("purchase_price", 0)),
                             "Harga beli acuan")
    spec_t = _check_active_spec(db, "T", payload.get("spec_t", (current or {}).get("spec_t")), "Tebal default")
    spec_l = _check_active_spec(db, "L", payload.get("spec_l", (current or {}).get("spec_l")), "Lebar default")
    spec_p = _check_active_spec(db, "P", payload.get("spec_p", (current or {}).get("spec_p")), "Panjang default")
    min_stock = _number(payload.get("min_stock", (current or {}).get("min_stock", 0)), "Stok minimum")
    active_price = payload.get("active_price", None)
    if active_price is None:
        active_price = (current or {}).get("active_price", 0)
    active_price = _check_active_price(db, active_price)
    return {
        "name": name, "code": code, "unit": unit, "purchase_price": purchase_price,
        "spec_t": spec_t, "spec_l": spec_l, "spec_p": spec_p, "min_stock": min_stock,
        "active_price": active_price,
    }


def create_product(db: DB, user_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    prepared = _prepare_product(db, payload or {})
    stamp = now_iso()
    with db.atomic():
        try:
            product_id = db.insert(
                """INSERT INTO products(code,name,unit,purchase_price,spec_t,spec_l,spec_p,min_stock,active,created_at)
                   VALUES(?,?,?,?,?,?,?,?,1,?)""",
                (prepared["code"], prepared["name"], prepared["unit"], prepared["purchase_price"],
                 prepared["spec_t"], prepared["spec_l"], prepared["spec_p"], prepared["min_stock"], stamp),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Kode barang sudah dipakai. Gunakan kode lain.")
            raise
        if prepared["active_price"] > 0:
            db.run(
                "INSERT INTO product_active_prices(product_id,active_price,updated_at,updated_by) VALUES(?,?,?,?)",
                (product_id, prepared["active_price"], stamp, int(user_id)),
            )
        db.log(user_id, "TAMBAH_BARANG",
               f"{prepared['code']} | {prepared['name']} | satuan={prepared['unit']} | harga={prepared['active_price']:g}",
               "products", product_id)
    return get_product(db, product_id)


def update_product(db: DB, user_id: int, product_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    current = get_product(db, product_id)
    prepared = _prepare_product(db, payload or {}, current)
    stamp = now_iso()
    with db.atomic():
        try:
            db.run(
                """UPDATE products SET code=?,name=?,unit=?,purchase_price=?,spec_t=?,spec_l=?,spec_p=?,min_stock=?
                   WHERE id=?""",
                (prepared["code"], prepared["name"], prepared["unit"], prepared["purchase_price"],
                 prepared["spec_t"], prepared["spec_l"], prepared["spec_p"], prepared["min_stock"], int(product_id)),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Kode barang sudah dipakai. Gunakan kode lain.")
            raise
        if prepared["active_price"] != float(current.get("active_price") or 0):
            db.run(
                """INSERT INTO product_active_prices(product_id,active_price,updated_at,updated_by) VALUES(?,?,?,?)
                   ON CONFLICT(product_id) DO UPDATE SET active_price=excluded.active_price,
                       updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
                (int(product_id), prepared["active_price"], stamp, int(user_id)),
            )
        db.log(user_id, "UBAH_BARANG",
               f"{prepared['code']} | {prepared['name']} | harga aktif={prepared['active_price']:g}",
               "products", int(product_id))
    return get_product(db, product_id)


def toggle_product(db: DB, user_id: int, product_id: int) -> dict:
    user = require_primary(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    product = get_product(db, product_id)
    target = 0 if product["active"] else 1
    with db.atomic():
        db.run("UPDATE products SET active=? WHERE id=?", (target, int(product_id)))
        db.log(user_id, "STATUS_BARANG",
               f"{product['code']} | {product['name']} | status={'AKTIF' if target else 'NONAKTIF'}",
               "products", int(product_id))
    return {"active": bool(target)}


# --------------------------------------------------------------------------- penjual


def list_sellers(db: DB, include_inactive: bool = True, query: str = "") -> list[dict]:
    sql = "SELECT * FROM sellers WHERE 1=1"
    args = []
    if not include_inactive:
        sql += " AND active=1"
    term = str(query or "").strip()
    if term:
        sql += " AND (name LIKE ? OR city LIKE ? OR phone LIKE ?)"
        args.extend([f"%{term}%"] * 3)
    sql += " ORDER BY name COLLATE NOCASE"
    rows = db.q(sql, args)
    for row in rows:
        counts = db.one(
            """SELECT (SELECT COUNT(*) FROM seller_rits WHERE seller_id=?) AS rits,
                      (SELECT COUNT(*) FROM transactions WHERE seller_id=?) AS transactions""",
            (int(row["id"]), int(row["id"])),
        ) or {}
        row["rit_count"] = int(counts.get("rits") or 0)
        row["transaction_count"] = int(counts.get("transactions") or 0)
    return rows


def create_seller(db: DB, user_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    name = _text(payload.get("name"), "Nama penjual", True, 120)
    city = _text(payload.get("city"), "Kota", False, 80)
    phone = _text(payload.get("phone"), "Telepon", False, 40)
    address = _text(payload.get("address"), "Alamat", False, 240)
    note = _text(payload.get("note"), "Catatan", False, 240)
    stamp = now_iso()
    with db.atomic():
        try:
            seller_id = db.insert(
                "INSERT INTO sellers(name,city,phone,address,note,active,created_at) VALUES(?,?,?,?,?,1,?)",
                (name, city, phone, address, note, stamp),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nama penjual sudah terdaftar.")
            raise
        db.log(user_id, "TAMBAH_PENJUAL", f"{name} | {city}", "sellers", seller_id)
    return db.one("SELECT * FROM sellers WHERE id=?", (seller_id,))


def update_seller(db: DB, user_id: int, seller_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    current = db.one("SELECT * FROM sellers WHERE id=?", (int(seller_id),))
    if not current:
        raise AppError("Penjual tidak ditemukan.", 404)
    name = _text(payload.get("name", current["name"]), "Nama penjual", True, 120)
    city = _text(payload.get("city", current["city"]), "Kota", False, 80)
    phone = _text(payload.get("phone", current["phone"]), "Telepon", False, 40)
    address = _text(payload.get("address", current["address"]), "Alamat", False, 240)
    note = _text(payload.get("note", current["note"]), "Catatan", False, 240)
    with db.atomic():
        try:
            db.run(
                "UPDATE sellers SET name=?,city=?,phone=?,address=?,note=? WHERE id=?",
                (name, city, phone, address, note, int(seller_id)),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nama penjual sudah terdaftar.")
            raise
        db.log(user_id, "UBAH_PENJUAL", f"{name} | {city}", "sellers", int(seller_id))
    return db.one("SELECT * FROM sellers WHERE id=?", (int(seller_id),))


def toggle_seller(db: DB, user_id: int, seller_id: int) -> dict:
    require_primary(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    seller = db.one("SELECT * FROM sellers WHERE id=?", (int(seller_id),))
    if not seller:
        raise AppError("Penjual tidak ditemukan.", 404)
    target = 0 if seller["active"] else 1
    with db.atomic():
        db.run("UPDATE sellers SET active=? WHERE id=?", (target, int(seller_id)))
        db.log(user_id, "STATUS_PENJUAL",
               f"{seller['name']} | status={'AKTIF' if target else 'NONAKTIF'}", "sellers", int(seller_id))
    return {"active": bool(target)}


def delete_seller(db: DB, user_id: int, seller_id: int) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    seller = db.one("SELECT * FROM sellers WHERE id=?", (int(seller_id),))
    if not seller:
        raise AppError("Penjual tidak ditemukan.", 404)
    used = db.one(
        """SELECT (SELECT COUNT(*) FROM seller_rits WHERE seller_id=?) +
                  (SELECT COUNT(*) FROM transactions WHERE seller_id=?) AS n""",
        (int(seller_id), int(seller_id)),
    )
    if used and int(used["n"] or 0) > 0:
        raise AppError("Penjual sudah memiliki rit/transaksi. Nonaktifkan saja agar jejak audit tetap utuh.")
    with db.atomic():
        db.run("DELETE FROM sellers WHERE id=?", (int(seller_id),))
        db.log(user_id, "HAPUS_PENJUAL", seller["name"], "sellers", int(seller_id))
    return {"deleted": True}


# --------------------------------------------------------------------------- lokasi


def list_locations(db: DB, include_inactive: bool = True) -> list[dict]:
    sql = "SELECT * FROM storage_locations"
    if not include_inactive:
        sql += " WHERE active=1"
    sql += " ORDER BY code COLLATE NOCASE"
    rows = db.q(sql)
    for row in rows:
        used = db.one(
            """SELECT (SELECT COUNT(*) FROM transactions WHERE location=?) +
                      (SELECT COUNT(*) FROM location_transfers WHERE from_location=? OR to_location=?) +
                      (SELECT COUNT(*) FROM stock_opname_items WHERE location=?) AS n""",
            (row["code"], row["code"], row["code"], row["code"]),
        ) or {}
        row["used"] = int(used.get("n") or 0)
    return rows


def create_location(db: DB, user_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    code = _text(payload.get("code"), "Kode lokasi", True, 30).upper()
    name = _text(payload.get("name") or code, "Nama lokasi", True, 80)
    if db.one("SELECT id FROM storage_locations WHERE code=? COLLATE NOCASE OR name=? COLLATE NOCASE", (code, name)):
        raise AppError("Kode atau nama lokasi sudah dipakai.")
    stamp = now_iso()
    with db.atomic():
        try:
            location_id = db.insert(
                "INSERT INTO storage_locations(code,name,active,created_at) VALUES(?,?,1,?)",
                (code, name, stamp),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Kode lokasi sudah dipakai.")
            raise
        db.log(user_id, "TAMBAH_LOKASI", f"{code} | {name}", "storage_locations", location_id)
    return db.one("SELECT * FROM storage_locations WHERE id=?", (location_id,))


def update_location(db: DB, user_id: int, location_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    current = db.one("SELECT * FROM storage_locations WHERE id=?", (int(location_id),))
    if not current:
        raise AppError("Lokasi tidak ditemukan.", 404)
    name = _text(payload.get("name", current["name"]), "Nama lokasi", True, 80)
    code = _text(payload.get("code", current["code"]), "Kode lokasi", True, 30).upper()
    if code != current["code"]:
        if db.scalar("SELECT COUNT(*) FROM transactions WHERE location=?", (current["code"],), 0):
            raise AppError("Kode lokasi tidak dapat diubah karena sudah dipakai transaksi.")
        if db.scalar("SELECT COUNT(*) FROM location_transfers WHERE from_location=? OR to_location=?",
                     (current["code"], current["code"]), 0):
            raise AppError("Kode lokasi tidak dapat diubah karena sudah dipakai mutasi.")
    duplicate = db.one(
        "SELECT id FROM storage_locations WHERE (code=? COLLATE NOCASE OR name=? COLLATE NOCASE) AND id<>?",
        (code, name, int(location_id)),
    )
    if duplicate:
        raise AppError("Kode atau nama lokasi sudah dipakai.")
    with db.atomic():
        db.run("UPDATE storage_locations SET code=?,name=? WHERE id=?", (code, name, int(location_id)))
        db.log(user_id, "UBAH_LOKASI", f"{code} | {name}", "storage_locations", int(location_id))
    return db.one("SELECT * FROM storage_locations WHERE id=?", (int(location_id),))


def toggle_location(db: DB, user_id: int, location_id: int) -> dict:
    require_primary(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    location = db.one("SELECT * FROM storage_locations WHERE id=?", (int(location_id),))
    if not location:
        raise AppError("Lokasi tidak ditemukan.", 404)
    target = 0 if location["active"] else 1
    with db.atomic():
        db.run("UPDATE storage_locations SET active=? WHERE id=?", (target, int(location_id)))
        db.log(user_id, "STATUS_LOKASI",
               f"{location['code']} | status={'AKTIF' if target else 'NONAKTIF'}",
               "storage_locations", int(location_id))
    return {"active": bool(target)}


def delete_location(db: DB, user_id: int, location_id: int) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    location = db.one("SELECT * FROM storage_locations WHERE id=?", (int(location_id),))
    if not location:
        raise AppError("Lokasi tidak ditemukan.", 404)
    used = sqlite3_safe_location_usage(db, location["code"])
    if used:
        raise AppError("Lokasi sudah dipakai data transaksi/opname. Nonaktifkan saja.")
    with db.atomic():
        db.run("DELETE FROM storage_locations WHERE id=?", (int(location_id),))
        db.log(user_id, "HAPUS_LOKASI", f"{location['code']} | {location['name']}", "storage_locations", int(location_id))
    return {"deleted": True}


def sqlite3_safe_location_usage(db: DB, code: str) -> int:
    row = db.one(
        """SELECT (SELECT COUNT(*) FROM transactions WHERE location=?) +
                  (SELECT COUNT(*) FROM location_transfers WHERE from_location=? OR to_location=?) +
                  (SELECT COUNT(*) FROM stock_opname_items WHERE location=?) AS n""",
        (code, code, code, code),
    )
    return int((row or {}).get("n") or 0)


# --------------------------------------------------------------------------- master ukuran/harga


def list_specs(db: DB, include_inactive: bool = True) -> dict:
    result = {}
    for dimension in ("T", "L", "P"):
        sql = "SELECT * FROM master_spec_values WHERE dimension=?"
        if not include_inactive:
            sql += " AND active=1"
        sql += " ORDER BY value"
        result[dimension] = db.q(sql, (dimension,))
    return result


def list_prices(db: DB, include_inactive: bool = True) -> list[dict]:
    sql = "SELECT * FROM master_price_values"
    if not include_inactive:
        sql += " WHERE active=1"
    sql += " ORDER BY price"
    return db.q(sql)


def create_spec(db: DB, user_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    dimension = str(payload.get("dimension") or "").strip().upper()
    if dimension not in ("T", "L", "P"):
        raise AppError("Dimensi harus T, L, atau P.")
    value = _number(payload.get("value"), "Nilai ukuran", 0.01)
    with db.atomic():
        try:
            spec_id = db.insert(
                "INSERT INTO master_spec_values(dimension,value,active,created_at) VALUES(?,?,1,?)",
                (dimension, value, now_iso()),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nilai ukuran tersebut sudah ada pada dimensi ini.")
            raise
        db.log(user_id, "TAMBAH_MASTER_UKURAN", f"{dimension}={value:g}", "master_spec_values", spec_id)
    return db.one("SELECT * FROM master_spec_values WHERE id=?", (spec_id,))


def update_spec(db: DB, user_id: int, spec_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    spec = db.one("SELECT * FROM master_spec_values WHERE id=?", (int(spec_id),))
    if not spec:
        raise AppError("Master ukuran tidak ditemukan.", 404)
    value = _number(payload.get("value", spec["value"]), "Nilai ukuran", 0.01)
    with db.atomic():
        try:
            db.run("UPDATE master_spec_values SET value=? WHERE id=?", (value, int(spec_id)))
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nilai ukuran tersebut sudah ada pada dimensi ini.")
            raise
        db.log(user_id, "UBAH_MASTER_UKURAN", f"{spec['dimension']}={value:g}", "master_spec_values", int(spec_id))
    return db.one("SELECT * FROM master_spec_values WHERE id=?", (int(spec_id),))


def toggle_spec(db: DB, user_id: int, spec_id: int) -> dict:
    require_primary(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    spec = db.one("SELECT * FROM master_spec_values WHERE id=?", (int(spec_id),))
    if not spec:
        raise AppError("Master ukuran tidak ditemukan.", 404)
    target = 0 if spec["active"] else 1
    with db.atomic():
        db.run("UPDATE master_spec_values SET active=? WHERE id=?", (target, int(spec_id)))
        db.log(user_id, "STATUS_MASTER_UKURAN",
               f"{spec['dimension']}={spec['value']:g} | status={'AKTIF' if target else 'NONAKTIF'}",
               "master_spec_values", int(spec_id))
    return {"active": bool(target)}


def create_price(db: DB, user_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    price = _number(payload.get("price"), "Harga", 0.01)
    with db.atomic():
        try:
            price_id = db.insert(
                "INSERT INTO master_price_values(price,active,created_at) VALUES(?,1,?)",
                (price, now_iso()),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nilai harga tersebut sudah ada.")
            raise
        db.log(user_id, "TAMBAH_MASTER_HARGA", f"{price:g}", "master_price_values", price_id)
    return db.one("SELECT * FROM master_price_values WHERE id=?", (price_id,))


def update_price(db: DB, user_id: int, price_id: int, payload: dict) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    current = db.one("SELECT * FROM master_price_values WHERE id=?", (int(price_id),))
    if not current:
        raise AppError("Master harga tidak ditemukan.", 404)
    price = _number(payload.get("price", current["price"]), "Harga", 0.01)
    with db.atomic():
        try:
            db.run("UPDATE master_price_values SET price=? WHERE id=?", (price, int(price_id)))
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Nilai harga tersebut sudah ada.")
            raise
        db.log(user_id, "UBAH_MASTER_HARGA", f"{current['price']:g} -> {price:g}",
               "master_price_values", int(price_id))
    return db.one("SELECT * FROM master_price_values WHERE id=?", (int(price_id),))


def toggle_price(db: DB, user_id: int, price_id: int) -> dict:
    require_primary(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    price = db.one("SELECT * FROM master_price_values WHERE id=?", (int(price_id),))
    if not price:
        raise AppError("Master harga tidak ditemukan.", 404)
    target = 0 if price["active"] else 1
    with db.atomic():
        db.run("UPDATE master_price_values SET active=? WHERE id=?", (target, int(price_id)))
        db.log(user_id, "STATUS_MASTER_HARGA",
               f"{price['price']:g} | status={'AKTIF' if target else 'NONAKTIF'}",
               "master_price_values", int(price_id))
    return {"active": bool(target)}


def delete_price(db: DB, user_id: int, price_id: int) -> dict:
    require_admin(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))
    current = db.one("SELECT * FROM master_price_values WHERE id=?", (int(price_id),))
    if not current:
        raise AppError("Master harga tidak ditemukan.", 404)
    used = db.one(
        "SELECT COUNT(*) AS n FROM product_active_prices WHERE active_price=?",
        (current["price"],),
    )
    if int((used or {}).get("n") or 0) > 0:
        raise AppError(
            "Harga masih dipakai sebagai harga aktif barang. Ubah harga barang terlebih dahulu atau nonaktifkan saja."
        )
    with db.atomic():
        db.run("DELETE FROM master_price_values WHERE id=?", (int(price_id),))
        db.log(user_id, "HAPUS_MASTER_HARGA", f"{current['price']:g}", "master_price_values", int(price_id))
    return {"deleted": True}


# --------------------------------------------------------------------------- pengguna


def public_user(row: dict) -> dict:
    return {
        "id": int(row["id"]), "username": row["username"],
        "full_name": row.get("full_name") or "",
        "role": row["role"], "is_primary_admin": bool(row.get("is_primary_admin")),
        "active": bool(row.get("active")),
        "created_at": row.get("created_at"), "last_login": row.get("last_login"),
    }


def get_active_user(db: DB, user_id: int) -> dict | None:
    row = db.one("SELECT * FROM users WHERE id=? AND active=1", (int(user_id),))
    return row


def list_users(db: DB, actor: dict) -> list[dict]:
    require_admin(actor)
    rows = db.q(
        "SELECT * FROM users WHERE LOWER(username)<>? ORDER BY is_primary_admin DESC, username",
        (DEVELOPER_USERNAME.lower(),),
    )
    users = [public_user(row) for row in rows]
    for row in users:
        row["is_self"] = row["id"] == actor["id"]
    return users


def _active_admin_count(db: DB, exclude: int | None = None) -> int:
    sql = "SELECT COUNT(*) FROM users WHERE role='admin' AND active=1"
    args = []
    if exclude is not None:
        sql += " AND id<>?"
        args.append(int(exclude))
    return int(db.scalar(sql, args, 0))


def _username(value) -> str:
    username = _text(value, "Username", True, 32)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,31}", username):
        raise AppError("Username 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.")
    if username.lower() == DEVELOPER_USERNAME.lower():
        raise AppError("Username tersebut khusus sistem dan tidak dapat digunakan.")
    return username


def create_user(db: DB, actor: dict, payload: dict) -> dict:
    require_admin(actor)
    username = _username(payload.get("username"))
    password = str(payload.get("password") or "")
    confirm = str(payload.get("confirm_password") or password)
    check_new_password(username, password, confirm)
    full_name = _text(payload.get("full_name"), "Nama lengkap", False, 80)
    role = str(payload.get("role") or "user").strip().lower()
    if role not in ("user", "admin"):
        raise AppError("Role harus user atau admin.")
    with db.atomic():
        try:
            user_id = db.insert(
                """INSERT INTO users(username,full_name,password_hash,role,is_primary_admin,active,
                                     must_change_password,created_at) VALUES(?,?,?,?,0,1,0,?)""",
                (username, full_name, hash_password(password), role, now_iso()),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Username sudah dipakai. Pilih username lain.")
            raise
        db.log(actor["id"], "TAMBAH_PENGGUNA", f"{username} | role={role}", "users", user_id)
    return public_user(db.one("SELECT * FROM users WHERE id=?", (user_id,)))


def update_user(db: DB, actor: dict, user_id: int, payload: dict) -> dict:
    require_admin(actor)
    target = db.one("SELECT * FROM users WHERE id=?", (int(user_id),))
    if not target:
        raise AppError("Pengguna tidak ditemukan.", 404)
    if target.get("is_primary_admin"):
        raise AppError("Akun Admin Utama tidak dapat diubah dari daftar pengguna.")
    if target["id"] == actor["id"] and "active" in payload and not _flag(payload.get("active")):
        raise AppError("Tidak dapat menonaktifkan akun yang sedang dipakai.")
    username = _username(payload.get("username", target["username"]))
    full_name = _text(payload.get("full_name", target.get("full_name")), "Nama lengkap", False, 80)
    role = str(payload.get("role", target["role"])).strip().lower()
    if role not in ("user", "admin"):
        raise AppError("Role harus user atau admin.")
    active = _flag(payload.get("active", target["active"]))
    if target["id"] == actor["id"] and role != "admin":
        raise AppError("Tidak dapat menurunkan role akun yang sedang dipakai.")
    if target["role"] == "admin" and (role != "admin" or active == 0):
        if _active_admin_count(db, exclude=target["id"]) < 1:
            raise AppError("Harus tersisa minimal satu admin aktif.")
    with db.atomic():
        try:
            db.run(
                "UPDATE users SET username=?,full_name=?,role=?,active=? WHERE id=?",
                (username, full_name, role, active, int(user_id)),
            )
        except sqlite3.IntegrityError as exc:
            _unique_error(exc, "Username sudah dipakai. Pilih username lain.")
            raise
        db.log(actor["id"], "UBAH_PENGGUNA",
               f"{target['username']} -> {username} | role={role} | active={active}",
               "users", int(user_id))
    return public_user(db.one("SELECT * FROM users WHERE id=?", (int(user_id),)))


def reset_user_password(db: DB, actor: dict, user_id: int, payload: dict) -> dict:
    require_admin(actor)
    target = db.one("SELECT * FROM users WHERE id=?", (int(user_id),))
    if not target:
        raise AppError("Pengguna tidak ditemukan.", 404)
    if target.get("is_primary_admin"):
        raise AppError("Password Admin Utama hanya dapat diubah oleh akun tersebut melalui Ganti Password.")
    if target["id"] == actor["id"]:
        raise AppError("Gunakan menu Ganti Password untuk akun sendiri.")
    new_password = str(payload.get("new_password") or "")
    if len(new_password) < 6:
        raise AppError("Password sementara minimal 6 karakter.")
    check_new_password(target["username"], new_password, str(payload.get("confirm_password") or new_password))
    with db.atomic():
        db.run("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), int(user_id)))
        db.log(actor["id"], "RESET_PASSWORD_PENGGUNA",
               f"target={target['username']}", "users", int(user_id))
    return {"id": int(user_id)}


def delete_user(db: DB, actor: dict, user_id: int, password: str) -> dict:
    require_admin(actor)
    target = db.one("SELECT * FROM users WHERE id=?", (int(user_id),))
    if not target:
        raise AppError("Pengguna tidak ditemukan.", 404)
    if target.get("is_primary_admin"):
        raise AppError("Akun Admin Utama tidak dapat dihapus.")
    if target["id"] == actor["id"]:
        raise AppError("Pengguna yang sedang login tidak dapat dihapus.")
    actor_row = db.one("SELECT * FROM users WHERE id=? AND active=1", (int(actor["id"]),))
    if not actor_row or not verify_password(str(password or ""), actor_row["password_hash"]):
        raise AppError("Password administrator salah.")
    used = db.one(
        """SELECT (SELECT COUNT(*) FROM transactions WHERE user_id=?) +
                  (SELECT COUNT(*) FROM location_transfers WHERE user_id=?) +
                  (SELECT COUNT(*) FROM stock_opname WHERE user_id=?) +
                  (SELECT COUNT(*) FROM activity_log WHERE user_id=?) AS n""",
        (int(user_id), int(user_id), int(user_id), int(user_id)),
    )
    if used and int(used["n"] or 0) > 0:
        raise AppError("Pengguna memiliki riwayat transaksi/aktivitas. Nonaktifkan akun agar jejak audit tetap utuh.")
    if target["role"] == "admin" and _active_admin_count(db, exclude=target["id"]) < 1:
        raise AppError("Harus tersisa minimal satu admin aktif.")
    with db.atomic():
        db.run("DELETE FROM users WHERE id=?", (int(user_id),))
        db.log(actor["id"], "HAPUS_PENGGUNA", target["username"], "users", int(user_id))
    return {"deleted": True}


# --------------------------------------------------------------------------- backup / reset / sync


def create_backup_bytes(db: DB) -> tuple[str, bytes]:
    folder = tempfile.mkdtemp(prefix="br_backup_")
    try:
        path = db.backup(folder, prefix="belgindo")
        with open(path, "rb") as handle:
            content = handle.read()
        return os.path.basename(path), content
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def create_backup_file(db: DB, destination_dir: str) -> str:
    os.makedirs(destination_dir, exist_ok=True)
    return db.backup(destination_dir, prefix="backup_sebelum_reset")


MASTER_TABLES = (
    "users", "products", "product_active_prices", "master_spec_values",
    "master_price_values", "sellers", "storage_locations", "app_meta",
)


def reset_transactions(db: DB, actor: dict, password: str, confirmation: str,
                       backup_dir: str) -> dict:
    require_admin(actor)
    if str(confirmation or "").strip() != "RESET":
        raise AppError("Ketik RESET dengan huruf kapital untuk mengonfirmasi.")
    actor_row = db.one("SELECT * FROM users WHERE id=? AND active=1", (int(actor["id"]),))
    if not actor_row or actor_row["role"] != "admin" or not verify_password(str(password or ""), actor_row["password_hash"]):
        raise AppError("Password administrator salah atau akun tidak lagi aktif.")
    backup_path = create_backup_file(db, backup_dir)
    master_before = {table: int(db.scalar(f"SELECT COUNT(*) FROM {table}", (), 0)) for table in MASTER_TABLES}
    tables = (
        "stock_period_closure_items", "stock_period_closures", "tally_items", "tally_headers",
        "payment_recap_items", "payment_recap_headers", "stock_opname_items", "stock_opname",
        "location_transfers", "transactions", "seller_rits", "activity_log", "sync_outbox",
    )
    with db.atomic():
        for table in tables:
            db.run(f"DELETE FROM {table}")
        db.run(
            "DELETE FROM sqlite_sequence WHERE name IN (" + ",".join("?" for _ in tables) + ")",
            tuple(tables),
        )
        for table, original in master_before.items():
            current = int(db.scalar(f"SELECT COUNT(*) FROM {table}", (), 0))
            if current != original:
                raise AppError(
                    f"Integritas data master terganggu (tabel {table}: {original} -> {current}). Reset dibatalkan."
                )
        db.log(actor["id"], "RESET_TRANSAKSI",
               f"Reset seluruh data transaksi; backup={os.path.basename(backup_path)}", "app_meta", None)
    return {"backup": os.path.basename(backup_path), "deleted_tables": list(tables)}


def sync_status(db: DB) -> dict:
    rows = db.q("SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status")
    counts = {row["status"]: int(row["n"]) for row in rows}
    last = db.one("SELECT created_at, entity, action FROM sync_outbox ORDER BY id DESC LIMIT 1")
    pending = int(counts.get("PENDING", 0)) + int(counts.get("FAILED", 0))
    return {
        "mode": "LOKAL",
        "mode_label": "Database lokal (SQLite)",
        "pending": pending,
        "failed": int(counts.get("FAILED", 0)),
        "synced": int(counts.get("SYNCED", 0)),
        "total": sum(counts.values()),
        "last": last,
        "message": (
            "Semua perubahan tersimpan di database lokal dan tercatat pada outbox audit."
            if pending == 0 else
            f"{pending} perubahan menunggu pemeriksaan pada outbox lokal."
        ),
    }


def retry_sync(db: DB, actor: dict) -> dict:
    require_admin(actor)
    with db.atomic():
        cursor = db.run("UPDATE sync_outbox SET status='SYNCED' WHERE status IN ('PENDING','FAILED')")
        db.log(actor["id"], "SINKRONISASI_ULANG", f"baris={cursor.rowcount}", "sync_outbox", None)
    return {"updated": cursor.rowcount, "status": sync_status(db)}


def purge_synced_outbox(db: DB, actor: dict) -> dict:
    require_primary(actor)
    with db.atomic():
        cursor = db.run("DELETE FROM sync_outbox WHERE status='SYNCED'")
        db.log(actor["id"], "BERSIHKAN_OUTBOX", f"baris={cursor.rowcount}", "sync_outbox", None)
    return {"deleted": cursor.rowcount}
