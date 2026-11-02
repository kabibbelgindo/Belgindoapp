"""Akun awal dan pembersihan data contoh peninggalan versi demo."""
from __future__ import annotations

from .core import DB, hash_password, now_iso

DEMO_ACCOUNTS = [
    ("administrator", "Administrator Utama", "administrator", "admin", 1),
    ("admin", "Admin Operasional", "123", "admin", 0),
]

DEMO_PURGE_ACTION = "BERSIHKAN_DATA_DEMO"

# Baris bawaan versi sebelumnya ditanam dengan nama dan catatan yang selalu sama,
# sehingga pola itulah yang dipakai untuk mengenalinya kembali. Data nyata dengan
# nama lain tidak tersentuh; baris yang masih dirujuk data nyata ikut dipertahankan.
DEMO_PRODUCT_NAMES = [
    "MERANTI MERAH", "KRUING PUTIH", "BANGKIRAI SUPER", "KAMPER JAYA", "SENGON LAUT", "RIMBA CAMPUR",
]
DEMO_SELLER_NAMES = [
    "CV. SUMBER JAYA", "UD. KARYA ABADI", "PT. RIMBA NUSANTARA", "TOKO SENTOSA",
]
DEMO_LOCATION_CODES = ["GUDANG A", "GUDANG B", "GUDANG KERING"]
DEMO_SPEC_VALUES = [
    ("T", 20), ("T", 25), ("T", 30), ("T", 35), ("T", 40), ("T", 42), ("T", 45),
    ("L", 8), ("L", 10), ("L", 12), ("L", 14), ("L", 16),
    ("P", 100), ("P", 130),
]
DEMO_PRICE_VALUES = [2_200_000, 2_500_000, 2_800_000, 3_000_000, 3_200_000, 3_500_000, 4_000_000]
DEMO_NOTE_TEXTS = [
    "Pengiriman rutin awal periode", "Pengiriman periode berjalan",
    "Pasokan rutin", "Penerimaan periode berjalan",
    "Pemakaian produksi meja", "Pemakaian produksi kursi", "Pemakaian produksi lemari",
    "Penataan ulang gudang", "Persiapan pengiriman", "Mutasi untuk pesanan khusus",
    "Sebagian batang retak",
]


def seed_accounts(db: DB) -> bool:
    """Database kosong hanya ditanami akun login; master dan transaksi diisi sendiri."""
    if db.scalar("SELECT COUNT(*) FROM users", (), 0):
        return False
    for username, full_name, password, role, primary in DEMO_ACCOUNTS:
        db.insert(
            "INSERT INTO users(username,full_name,password_hash,role,is_primary_admin,active,created_at) "
            "VALUES(?,?,?,?,?,1,?)",
            (username, full_name, hash_password(password), role, primary, now_iso()),
        )
    return True


def _demo_text(value, options) -> bool:
    clean = str(value or "").strip().lower()
    return bool(clean) and any(str(option).strip().lower() == clean for option in options)


def _demo_note(value) -> bool:
    return _demo_text(value, DEMO_NOTE_TEXTS)


def demo_purge_done(db: DB) -> bool:
    return bool(db.one("SELECT 1 FROM activity_log WHERE action=? LIMIT 1", (DEMO_PURGE_ACTION,)))


def purge_demo_data(db: DB) -> dict:
    """Menghapus data contoh milik versi lama sekali saja (penanda di log aktivitas)."""
    counts = {
        "rit": 0, "transaksi": 0, "tally": 0, "rekap": 0, "mutasi": 0, "opname": 0,
        "barang": 0, "penjual": 0, "gudang": 0, "spek": 0, "harga": 0, "jejak": 0,
    }
    products = [name.upper() for name in DEMO_PRODUCT_NAMES]
    sellers = [name.upper() for name in DEMO_SELLER_NAMES]
    demo_note_sql = " OR ".join(["TRIM(LOWER(COALESCE(note, '')))=LOWER(?)" for _ in DEMO_NOTE_TEXTS])
    note_params = tuple(DEMO_NOTE_TEXTS)
    with db.atomic():
        rit_ids = [int(row["id"]) for row in db.q(
            f"SELECT id FROM seller_rits WHERE {demo_note_sql}", tuple(note_params))]
        product_ids = [int(row["id"]) for row in db.q(
            "SELECT id FROM products WHERE UPPER(TRIM(name)) IN (" + ",".join("?" * len(products)) + ")",
            tuple(products))]
        seller_ids = [int(row["id"]) for row in db.q(
            "SELECT id FROM sellers WHERE UPPER(TRIM(name)) IN (" + ",".join("?" * len(sellers)) + ")",
            tuple(sellers))]

        def id_list(ids):
            return ",".join(str(int(value)) for value in ids) if ids else "-1"

        rit_set = set(rit_ids)
        product_set = set(product_ids)
        seller_set = set(seller_ids)
        trx_ids = {int(row["id"]) for row in db.q(
            f"SELECT id FROM transactions WHERE rit_id IN ({id_list(rit_ids)})"
            f" OR product_id IN ({id_list(product_ids)})"
            f" OR COALESCE(seller_id, -1) IN ({id_list(seller_ids)})"
            f" OR ({demo_note_sql})", tuple(note_params))}

        tally_ids = {int(row["id"]) for row in db.q(
            f"SELECT id FROM tally_headers WHERE rit_id IN ({id_list(rit_ids)})"
            f" OR COALESCE(seller_id, -1) IN ({id_list(seller_ids)})")}
        for row in db.q(f"SELECT id, tally_id FROM tally_items WHERE trx_id IN ({id_list(trx_ids)})"
                        f" OR product_id IN ({id_list(product_ids)})"):
            tally_ids.add(int(row["tally_id"]))
        tally_items = db.q(f"SELECT id FROM tally_items WHERE tally_id IN ({id_list(tally_ids)})"
                           f" OR trx_id IN ({id_list(trx_ids)}) OR product_id IN ({id_list(product_ids)})")
        db.run(f"DELETE FROM tally_items WHERE id IN ({id_list([int(r['id']) for r in tally_items])})")
        tally_rows = db.q(f"SELECT id FROM tally_headers WHERE id IN ({id_list(tally_ids)})")
        db.run(f"DELETE FROM tally_headers WHERE id IN ({id_list([int(r['id']) for r in tally_rows])})")
        counts["tally"] = len(tally_rows)

        recap_ids = {int(row["id"]) for row in db.q(
            f"SELECT id FROM payment_recap_headers WHERE rit_id IN ({id_list(rit_ids)})"
            f" OR COALESCE(seller_id, -1) IN ({id_list(seller_ids)})")}
        for row in db.q(f"SELECT id, recap_id FROM payment_recap_items WHERE trx_id IN ({id_list(trx_ids)})"):
            recap_ids.add(int(row["recap_id"]))
        recap_items = db.q(f"SELECT id FROM payment_recap_items WHERE recap_id IN ({id_list(recap_ids)})"
                           f" OR trx_id IN ({id_list(trx_ids)})")
        db.run(f"DELETE FROM payment_recap_items WHERE id IN ({id_list([int(r['id']) for r in recap_items])})")
        recap_rows = db.q(f"SELECT id FROM payment_recap_headers WHERE id IN ({id_list(recap_ids)})")
        db.run(f"DELETE FROM payment_recap_headers WHERE id IN ({id_list([int(r['id']) for r in recap_rows])})")
        counts["rekap"] = len(recap_rows)

        trx_rows = db.q(f"SELECT id FROM transactions WHERE id IN ({id_list(trx_ids)})")
        db.run(f"DELETE FROM transactions WHERE id IN ({id_list([int(r['id']) for r in trx_rows])})")
        counts["transaksi"] = len(trx_rows)

        # Mutasi hanya ikut terhapus bila barang/catatannya demo; lokasi yang
        # masih dipakai mutasi nyata tidak dibuang.
        transfer_rows = db.q(
            f"SELECT id FROM location_transfers WHERE product_id IN ({id_list(product_ids)})"
            f" OR ({demo_note_sql})", note_params)
        db.run(f"DELETE FROM location_transfers WHERE id IN ({id_list([int(r['id']) for r in transfer_rows])})")
        counts["mutasi"] = len(transfer_rows)

        opname_item_ids = [int(row["id"]) for row in db.q(
            f"SELECT id FROM stock_opname_items WHERE product_id IN ({id_list(product_ids)})")]
        db.run(f"DELETE FROM stock_opname_items WHERE id IN ({id_list(opname_item_ids)})")
        closure_item_ids = [int(row["id"]) for row in db.q(
            f"SELECT id FROM stock_period_closure_items WHERE product_id IN ({id_list(product_ids)})")]
        db.run(f"DELETE FROM stock_period_closure_items WHERE id IN ({id_list(closure_item_ids)})")

        empty_sessions = [int(row["id"]) for row in db.q(
            "SELECT id FROM stock_opname WHERE id NOT IN (SELECT opname_id FROM stock_opname_items)")]
        empty_closures = [int(row["id"]) for row in db.q(
            f"SELECT id FROM stock_period_closures WHERE opname_id IN ({id_list(empty_sessions)})"
            " OR id NOT IN (SELECT closure_id FROM stock_period_closure_items)")]
        db.run(f"DELETE FROM stock_period_closures WHERE id IN ({id_list(empty_closures)})")
        db.run(f"DELETE FROM stock_opname WHERE id IN ({id_list(empty_sessions)})")
        counts["opname"] = len(empty_sessions)

        rit_rows = db.q(f"SELECT id FROM seller_rits WHERE id IN ({id_list(rit_ids)})"
                        f" OR seller_id IN ({id_list(seller_ids)})")
        db.run(f"DELETE FROM seller_rits WHERE id IN ({id_list([int(r['id']) for r in rit_rows])})")
        counts["rit"] = len(rit_rows)

        stock_tables = ("transactions", "tally_items", "location_transfers", "stock_opname_items",
                        "stock_period_closure_items")
        doomed_products = []
        for row in db.q("SELECT id, name FROM products"):
            product_id = int(row["id"])
            if not _demo_text(row["name"], DEMO_PRODUCT_NAMES):
                continue
            if any(db.scalar(f"SELECT COUNT(*) FROM {table} WHERE product_id=?", (product_id,), 0)
                   for table in stock_tables):
                continue
            doomed_products.append(product_id)
        db.run(f"DELETE FROM product_active_prices WHERE product_id IN ({id_list(doomed_products)})")
        db.run(f"DELETE FROM products WHERE id IN ({id_list(doomed_products)})")
        counts["barang"] = len(doomed_products)

        doomed_sellers = [int(row["id"]) for row in db.q(
            "SELECT id FROM sellers WHERE UPPER(TRIM(name)) IN (" + ",".join("?" * len(sellers)) + ")",
            tuple(sellers))
            if not db.scalar("SELECT COUNT(*) FROM seller_rits WHERE seller_id=?", (int(row["id"]),), 0)
            and not db.scalar("SELECT COUNT(*) FROM transactions WHERE seller_id=?", (int(row["id"]),), 0)]
        db.run(f"DELETE FROM sellers WHERE id IN ({id_list(doomed_sellers)})")
        counts["penjual"] = len(doomed_sellers)

        doomed_locations = [str(row["code"]) for row in db.q("SELECT code FROM storage_locations")
                            if _demo_text(row["code"], DEMO_LOCATION_CODES)
                            and not db.scalar("SELECT COUNT(*) FROM transactions WHERE TRIM(LOWER(location))=TRIM(LOWER(?))",
                                              (row["code"],), 0)
                            and not db.scalar(
                                "SELECT COUNT(*) FROM location_transfers WHERE TRIM(LOWER(from_location))=TRIM(LOWER(?))"
                                " OR TRIM(LOWER(to_location))=TRIM(LOWER(?))", (row["code"], row["code"]), 0)
                            and not db.scalar("SELECT COUNT(*) FROM stock_opname_items WHERE TRIM(LOWER(location))=TRIM(LOWER(?))",
                                              (row["code"],), 0)]
        db.run("DELETE FROM storage_locations WHERE LOWER(TRIM(code)) IN ("
               + ",".join("?" * len(doomed_locations)) + ")", tuple(code.lower() for code in doomed_locations))
        counts["gudang"] = len(doomed_locations)

        demo_specs = {(str(dim), float(val)) for dim, val in DEMO_SPEC_VALUES}
        spec_column = {"T": "spec_t", "L": "spec_l", "P": "spec_p"}
        for row in db.q("SELECT id, dimension, value FROM master_spec_values"):
            dimension = str(row["dimension"])
            if (dimension, float(row["value"])) not in demo_specs:
                continue
            used = db.scalar(f"SELECT COUNT(*) FROM products WHERE {spec_column[dimension]}=?",
                             (row["value"],), 0)
            if not used:
                db.run("DELETE FROM master_spec_values WHERE id=?", (int(row["id"]),))
                counts["spek"] += 1

        demo_prices = {float(price) for price in DEMO_PRICE_VALUES}
        for row in db.q("SELECT id, price FROM master_price_values"):
            if float(row["price"]) not in demo_prices:
                continue
            used = (db.scalar("SELECT COUNT(*) FROM products WHERE purchase_price=?", (row["price"],), 0)
                    or db.scalar("SELECT COUNT(*) FROM product_active_prices WHERE active_price=?", (row["price"],), 0)
                    or db.scalar("SELECT COUNT(*) FROM transactions WHERE price=?", (row["price"],), 0))
            if not used:
                db.run("DELETE FROM master_price_values WHERE id=?", (int(row["id"]),))
                counts["harga"] += 1

        words = [word.lower() for word in
                 DEMO_PRODUCT_NAMES + DEMO_SELLER_NAMES + DEMO_LOCATION_CODES + DEMO_NOTE_TEXTS]
        log_ids = [int(row["id"]) for row in db.q("SELECT id, detail FROM activity_log")
                   if any(word in str(row["detail"] or "").lower() for word in words)]
        db.run(f"DELETE FROM activity_log WHERE id IN ({id_list(log_ids)})")
        counts["jejak"] = len(log_ids)

    db.log(None, DEMO_PURGE_ACTION,
           " | ".join(f"{key}={value}" for key, value in counts.items()), "app_meta", None)
    return counts
