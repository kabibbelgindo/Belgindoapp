"""Stok opname: periode berurutan, penghitungan, pengesahan, dan tutup periode."""
from __future__ import annotations

from datetime import date, timedelta

from .core import (
    AppError, DB, EPS, OPNAME_REASON_OTHER, OPNAME_REASONS, display_date,
    fmt_qty, iso_date, m3_value, normalize_size, now_iso, parse_iso_date,
    resolve_location, size_display, size_parts, today_iso, trim_number,
    validate_dimensions_standard,
)
from .stock import locked_through, stock_map, stock_rows


def _fmt_date(value) -> str:
    return display_date(str(value)[:10]) if value else "-"


def _qty(value) -> str:
    return fmt_qty(value)


def session_status(row: dict) -> str:
    if row.get("closure_id"):
        return "DITUTUP"
    return "DISAHKAN" if row.get("status") == "DONE" else "PENGHITUNGAN"


def list_sessions(db: DB) -> list[dict]:
    rows = db.q(
        """SELECT o.*, c.id AS closure_id, c.closed_at AS closed_at,
                  u.username AS created_by_name, a.username AS approved_by_name,
                  (SELECT COUNT(*) FROM stock_opname_items i WHERE i.opname_id=o.id) AS item_count
           FROM stock_opname o
           LEFT JOIN stock_period_closures c ON c.opname_id=o.id
           LEFT JOIN users u ON u.id=o.user_id
           LEFT JOIN users a ON a.id=o.approved_by
           ORDER BY o.period_end DESC, o.id DESC"""
    )
    for row in rows:
        row["label_status"] = session_status(row)
        row["period_start_display"] = _fmt_date(row.get("period_start"))
        row["period_end_display"] = _fmt_date(row.get("period_end"))
        row["created_display"] = _fmt_date(str(row.get("created_at") or "")[:10])
        row["closed_display"] = _fmt_date(str(row.get("closed_at") or "")[:10]) if row.get("closed_at") else None
    return rows


def unclosed_session(db: DB) -> dict | None:
    return db.one(
        """SELECT o.* FROM stock_opname o
           WHERE NOT EXISTS (SELECT 1 FROM stock_period_closures c WHERE c.opname_id=o.id)
           ORDER BY o.period_end DESC, o.id DESC LIMIT 1"""
    )


def last_closure(db: DB) -> dict | None:
    return db.one("SELECT * FROM stock_period_closures ORDER BY period_end DESC, id DESC LIMIT 1")


def next_period_start(db: DB) -> tuple[date, bool]:
    closure = last_closure(db)
    if closure:
        return parse_iso_date(closure["period_end"]) + timedelta(days=1), False
    first = db.scalar("SELECT MIN(SUBSTR(trx_date,1,10)) FROM transactions")
    if first:
        return parse_iso_date(first), True
    return date.today(), True


def default_cutoff(start: date, today: date | None = None) -> str:
    today = today or date.today()
    first_next = date(start.year + (start.month == 12), (start.month % 12) + 1, 1)
    month_end = first_next - timedelta(days=1)
    return min(month_end, today).isoformat()


def next_period_info(db: DB) -> dict:
    start, first = next_period_start(db)
    closure = last_closure(db)
    return {
        "start": start.isoformat(),
        "start_display": _fmt_date(start),
        "first": first,
        "suggested_cutoff": default_cutoff(start),
        "suggested_cutoff_display": _fmt_date(default_cutoff(start)),
        "last_closed": closure["period_end"] if closure else None,
        "last_closed_display": _fmt_date(closure["period_end"]) if closure else None,
        "unclosed": unclosed_session(db),
    }


def create_session(db: DB, user_id: int, start, end) -> int:
    start_date = parse_iso_date(start, "Tanggal mulai")
    end_date = parse_iso_date(end, "Tanggal cut-off")
    pending = unclosed_session(db)
    if pending:
        raise AppError(
            f"Periode {_fmt_date(pending['period_start'])} s.d. {_fmt_date(pending['period_end'])} belum ditutup. "
            "Sahkan dan tutup periode tersebut sebelum membuat periode baru."
        )
    expected, first = next_period_start(db)
    if not first and start_date != expected:
        raise AppError(f"Periode baru harus dimulai {_fmt_date(expected)} (sehari setelah penutupan terakhir).")
    if end_date < start_date:
        raise AppError("Tanggal cut-off tidak boleh sebelum tanggal mulai.")
    if end_date > date.today():
        raise AppError("Tanggal cut-off tidak boleh melewati hari ini.")
    snapshot = stock_rows(db, end_date.isoformat())
    stamp = now_iso()
    with db.atomic():
        if unclosed_session(db):
            raise AppError("Periode lain baru saja dibuat. Muat ulang halaman Stok Opname.")
        opname_id = db.insert(
            """INSERT INTO stock_opname(
                   period_year,period_month,period_start,period_end,status,user_id,created_at
               ) VALUES(?,?,?,?,?,?,?)""",
            (end_date.year, end_date.month, start_date.isoformat(), end_date.isoformat(), "DRAFT", user_id, stamp),
        )
        for row in snapshot:
            db.insert(
                """INSERT INTO stock_opname_items(
                       opname_id,product_id,trx_size,system_qty,physical_qty,location,note,reason
                   ) VALUES(?,?,?,?,?,?,?,?)""",
                (opname_id, int(row["product_id"]), row["size"] or "", float(row["stock"]), None,
                 row["location"] or "", "", ""),
            )
        db.log(
            user_id, "OPNAME_BUAT",
            f"#{opname_id} | {start_date.isoformat()} s.d. {end_date.isoformat()} | item={len(snapshot)}",
            "stock_opname", opname_id,
        )
    return opname_id


def _draft_lock(db: DB, opname_id: int) -> dict:
    session = db.one("SELECT * FROM stock_opname WHERE id=?", (int(opname_id),))
    if not session:
        raise AppError("Sesi opname tidak ditemukan.", 404)
    if session["status"] != "DRAFT":
        raise AppError("Opname sudah disahkan dan terkunci. Gunakan Buka Kembali Pengesahan bila perlu koreksi.")
    if db.one("SELECT id FROM stock_period_closures WHERE opname_id=?", (int(opname_id),)):
        raise AppError("Periode opname sudah ditutup dan tidak dapat diubah.")
    return session


def _refresh_items_locked(db: DB, session: dict) -> dict:
    cutoff = str(session["period_end"])[:10]
    snapshot = stock_rows(db, cutoff)
    smap = {(int(r["product_id"]), r["size"] or "", r["location"] or ""): r for r in snapshot}
    items = db.q("SELECT * FROM stock_opname_items WHERE opname_id=?", (int(session["id"]),))
    seen = set()
    updated = removed = added = 0
    for item in items:
        key = (int(item["product_id"]), normalize_size(item["trx_size"]), item["location"] or "")
        seen.add(key)
        latest = float(smap[key]["stock"]) if key in smap else 0.0
        if abs(float(item["system_qty"] or 0) - latest) > EPS:
            db.run("UPDATE stock_opname_items SET system_qty=? WHERE id=?", (latest, int(item["id"])))
            updated += 1
        if item["physical_qty"] is None and key not in smap and abs(latest) < EPS:
            db.run("DELETE FROM stock_opname_items WHERE id=?", (int(item["id"]),))
            removed += 1
    for key, row in smap.items():
        if key not in seen:
            db.insert(
                """INSERT INTO stock_opname_items(
                       opname_id,product_id,trx_size,system_qty,physical_qty,location,note,reason
                   ) VALUES(?,?,?,?,?,?,?,?)""",
                (int(session["id"]), key[0], key[1], float(row["stock"]), None, key[2], "", ""),
            )
            added += 1
    return {"added": added, "updated": updated, "removed": removed}


def refresh_items(db: DB, user_id: int, opname_id: int) -> dict:
    with db.atomic():
        session = _draft_lock(db, opname_id)
        result = _refresh_items_locked(db, session)
        db.log(user_id, "OPNAME_REFRESH", f"#{opname_id} | tambah={result['added']} | ubah={result['updated']} | hapus={result['removed']}", "stock_opname", int(opname_id))
    return result


def load_items(db: DB, opname_id: int) -> list[dict]:
    rows = db.q(
        """SELECT i.*, p.code, p.name, p.unit, p.purchase_price
           FROM stock_opname_items i JOIN products p ON p.id=i.product_id
           WHERE i.opname_id=? ORDER BY p.name COLLATE NOCASE, i.trx_size, i.location""",
        (int(opname_id),),
    )
    for row in rows:
        row["size_display"] = size_display(row["trx_size"])
        row["system_display"] = fmt_qty(row["system_qty"])
        physical = row.get("physical_qty")
        diff = None if physical is None else float(physical) - float(row["system_qty"] or 0)
        row["diff"] = None if diff is None else round(diff, 4)
        row["diff_display"] = "—" if diff is None else fmt_qty(diff)
        row["diff_m3"] = None if diff is None else round(m3_value(row["trx_size"], abs(diff)), 6)
        row["counted"] = physical is not None
    return rows


def _clean_reason(reason) -> str:
    value = str(reason or "").strip()
    if value and value not in OPNAME_REASONS:
        raise AppError("Alasan selisih tidak dikenal.")
    return value


def set_count(db: DB, user_id: int, opname_id: int, item_id: int, physical, reason: str = "", note: str = "") -> dict:
    if physical not in (None, ""):
        try:
            physical = float(physical)
        except (TypeError, ValueError):
            raise AppError("Stok fisik harus berupa angka.")
        if physical < 0:
            raise AppError("Stok fisik tidak boleh negatif.")
    else:
        physical = None
    reason = _clean_reason(reason)
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan maksimal 300 karakter.")
    with db.atomic():
        _draft_lock(db, opname_id)
        cursor = db.run(
            "UPDATE stock_opname_items SET physical_qty=?, reason=?, note=? WHERE id=? AND opname_id=?",
            (physical, reason, note, int(item_id), int(opname_id)),
        )
        if cursor.rowcount == 0:
            raise AppError("Baris opname tidak ditemukan; muat ulang daftar.")
        if physical is not None:
            item = db.one("SELECT trx_size FROM stock_opname_items WHERE id=?", (int(item_id),))
            db.log(user_id, "OPNAME_HITUNG", f"#{opname_id} | item={item_id} | fisik={fmt_qty(physical)} | alasan={reason or '-'}", "stock_opname", int(opname_id))
    return {"saved": True}


def add_found_item(db: DB, user_id: int, opname_id: int, product_id: int, size: str,
                   location: str, physical, reason: str = "Barang temuan", note: str = "") -> dict:
    try:
        physical = float(physical)
    except (TypeError, ValueError):
        raise AppError("Isi stok fisik untuk barang temuan.")
    if physical < 0:
        raise AppError("Stok fisik tidak boleh negatif.")
    normalized = normalize_size(size)
    if not normalized:
        raise AppError("Ukuran barang temuan wajib diisi.")
    product = db.one("SELECT * FROM products WHERE id=?", (int(product_id),))
    if not product:
        raise AppError("Barang tidak ditemukan.", 404)
    if not product["active"]:
        raise AppError("Barang berstatus nonaktif.")
    validate_dimensions_standard(db, normalized, allow_import=str(product["code"]).startswith("IMP/"))
    location = str(location or "").strip()
    if location:
        resolve_location(db, location)
    reason = _clean_reason(reason or "Barang temuan")
    note = str(note or "").strip()
    if len(note) > 300:
        raise AppError("Catatan maksimal 300 karakter.")
    with db.atomic():
        session = _draft_lock(db, opname_id)
        cutoff = str(session["period_end"])[:10]
        exists = db.one(
            "SELECT id FROM stock_opname_items WHERE opname_id=? AND product_id=? AND trx_size=? AND location=?",
            (int(opname_id), int(product_id), normalized, location),
        )
        if exists:
            raise AppError("Barang, ukuran, dan lokasi ini sudah ada. Isi stok fisik pada baris tersebut.")
        system = stock_map(db, cutoff).get((int(product_id), normalized, location), 0.0)
        item_id = db.insert(
            """INSERT INTO stock_opname_items(
                   opname_id,product_id,trx_size,system_qty,physical_qty,location,note,reason
               ) VALUES(?,?,?,?,?,?,?,?)""",
            (int(opname_id), int(product_id), normalized, system, physical, location, note, reason),
        )
        db.log(
            user_id, "OPNAME_TEMUAN",
            f"#{opname_id} | item={item_id} | {product['code']} | {size_display(normalized)} | "
            f"lokasi={location or '-'} | fisik={fmt_qty(physical)}",
            "stock_opname", int(opname_id),
        )
    return {"id": item_id}


def fill_uncounted_as_system(db: DB, user_id: int, opname_id: int) -> dict:
    with db.atomic():
        _draft_lock(db, opname_id)
        cursor = db.run(
            """UPDATE stock_opname_items
               SET physical_qty=system_qty,
                   note=CASE WHEN TRIM(COALESCE(note,''))='' THEN 'Tidak dihitung; dianggap sesuai stok sistem.' ELSE note END
               WHERE opname_id=? AND physical_qty IS NULL AND system_qty>=0""",
            (int(opname_id),),
        )
        db.log(user_id, "OPNAME_ISI_SESUAI", f"#{opname_id} | baris={cursor.rowcount}", "stock_opname", int(opname_id))
    return {"filled": cursor.rowcount}


def summarize(db: DB, opname_id: int) -> dict:
    summary = {
        "items": 0, "counted": 0, "uncounted": 0, "variance_items": 0,
        "plus_qty": 0.0, "minus_qty": 0.0, "plus_m3": 0.0, "minus_m3": 0.0,
        "missing_reason": 0, "missing_note": 0,
    }
    for item in load_items(db, opname_id):
        summary["items"] += 1
        if item["physical_qty"] is None:
            summary["uncounted"] += 1
            continue
        summary["counted"] += 1
        diff = float(item["physical_qty"]) - float(item["system_qty"] or 0)
        if abs(diff) < EPS:
            continue
        summary["variance_items"] += 1
        volume = m3_value(item["trx_size"], abs(diff))
        if diff > 0:
            summary["plus_qty"] += diff
            summary["plus_m3"] += volume
        else:
            summary["minus_qty"] += -diff
            summary["minus_m3"] += volume
        if not str(item.get("reason") or "").strip():
            summary["missing_reason"] += 1
        elif item["reason"] == OPNAME_REASON_OTHER and not str(item.get("note") or "").strip():
            summary["missing_note"] += 1
    for key in ("plus_qty", "minus_qty", "plus_m3", "minus_m3"):
        summary[key] = round(summary[key], 6)
    return summary


def approval_problems(db: DB, opname_id: int) -> list[str]:
    problems = []
    items = load_items(db, opname_id)
    uncounted = [item for item in items if item["physical_qty"] is None]
    if uncounted:
        problems.append(
            f"{len(uncounted)} item belum dihitung. Hitung semua item, atau konfirmasi "
            "\"anggap sesuai stok sistem\"."
        )
    no_reason, no_note = [], []
    for item in items:
        if item["physical_qty"] is None:
            continue
        diff = float(item["physical_qty"]) - float(item["system_qty"] or 0)
        if abs(diff) < EPS:
            continue
        label = f"{item['code']} {item['size_display']} @{item['location'] or '-'}".strip()
        if not str(item.get("reason") or "").strip():
            no_reason.append(label)
        elif item["reason"] == OPNAME_REASON_OTHER and not str(item.get("note") or "").strip():
            no_note.append(label)
    if no_reason:
        problems.append(f"{len(no_reason)} item selisih belum diberi alasan (contoh: {', '.join(no_reason[:3])}).")
    if no_note:
        problems.append(f"{len(no_note)} item beralasan \"Lainnya\" wajib diberi catatan (contoh: {', '.join(no_note[:3])}).")
    return problems


def _post_adjustment(db: DB, session_id: int, item: dict, diff: float, cutoff: str,
                     reason_text: str, user_id: int, stamp: str) -> None:
    number = f"OPN-{session_id}"
    size = normalize_size(item["trx_size"])
    location = str(item["location"] or "").strip()
    columns = (
        "trx_date,product_id,trx_type,qty,price,note,trx_size,trx_number,supplier,location,"
        "user_id,created_at,source_trx_id"
    )
    if diff > 0:
        db.run(
            f"INSERT INTO transactions({columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cutoff, int(item["product_id"]), "MASUK", diff, 0, reason_text, size, number, "", location,
             user_id, stamp, None),
        )
        return
    normalized = size
    lots = db.q(
        """SELECT t.id, t.qty-COALESCE((
                   SELECT SUM(o.qty) FROM transactions o
                   WHERE o.source_trx_id=t.id AND o.trx_type='KELUAR'
               ),0) AS rem,
               TRIM(COALESCE(t.location,'')) AS loc
           FROM transactions t
           WHERE t.trx_type='MASUK' AND t.product_id=?
             AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(t.trx_size),'×','x'),' ',''),'X','x'))=?
             AND SUBSTR(t.trx_date,1,10)<=?
           ORDER BY t.trx_date, t.id""",
        (int(item["product_id"]), normalized, cutoff),
    )
    lots = [lot for lot in lots if float(lot["rem"] or 0) > EPS]
    sources = {
        str(row["f"] or "").strip()
        for row in db.q(
            """SELECT DISTINCT TRIM(COALESCE(from_location,'')) AS f FROM location_transfers
               WHERE product_id=? AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(trx_size),'×','x'),' ',''),'X','x'))=?
                 AND TRIM(COALESCE(to_location,''))=? AND SUBSTR(transfer_date,1,10)<=?""",
            (int(item["product_id"]), normalized, location.strip(), cutoff),
        )
    }
    lots.sort(key=lambda lot: 0 if lot["loc"] == location.strip() else (1 if lot["loc"] in sources else 2))
    left = float(-diff)
    for lot in lots:
        if left <= EPS:
            break
        take = min(left, float(lot["rem"]))
        db.run(
            f"INSERT INTO transactions({columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cutoff, int(item["product_id"]), "KELUAR", take, 0, reason_text, size, number, "", location,
             user_id, stamp, int(lot["id"])),
        )
        left -= take
    if left > EPS:
        db.run(
            f"INSERT INTO transactions({columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cutoff, int(item["product_id"]), "KELUAR", left, 0, reason_text, size, number, "", location,
             user_id, stamp, None),
        )


def approve(db: DB, user_id: int, opname_id: int) -> dict:
    stamp = now_iso()
    with db.atomic():
        session = db.one("SELECT * FROM stock_opname WHERE id=?", (int(opname_id),))
        if not session:
            raise AppError("Sesi opname tidak ditemukan.", 404)
        if session["status"] == "DONE":
            raise AppError("Opname ini sudah disahkan.")
        cutoff = str(session["period_end"])[:10]
        if parse_iso_date(cutoff) > date.today():
            raise AppError("Tanggal cut-off belum tiba.")
        _refresh_items_locked(db, session)
        problems = approval_problems(db, opname_id)
        if problems:
            raise AppError("\n".join(problems))
        items = db.q("SELECT * FROM stock_opname_items WHERE opname_id=? ORDER BY product_id,trx_size,location", (int(opname_id),))
        snapshot = stock_map(db, cutoff)
        current = stock_map(db)
        codes = {int(row["id"]): row["code"] for row in db.q("SELECT id,code FROM products")}
        negatives = []
        for item in items:
            key = (int(item["product_id"]), normalize_size(item["trx_size"]), item["location"] or "")
            diff = float(item["physical_qty"]) - snapshot.get(key, 0.0)
            if diff < -EPS and current.get(key, 0.0) + diff < -EPS:
                negatives.append(
                    f"{codes.get(int(item['product_id']), item['product_id'])} "
                    f"{size_display(item['trx_size'])} @ {item['location'] or '-'} "
                    f"(stok sekarang {_qty(current.get(key, 0.0))}, koreksi -{_qty(-diff)})"
                )
        if negatives:
            raise AppError(
                "Penyesuaian akan membuat stok sekarang minus karena sudah ada pengeluaran setelah cut-off:\n- "
                + "\n- ".join(negatives[:8])
                + "\n\nPeriksa transaksi setelah tanggal cut-off, lalu coba lagi."
            )
        adjust = plus = minus = 0
        for item in items:
            key = (int(item["product_id"]), normalize_size(item["trx_size"]), item["location"] or "")
            system_qty = snapshot.get(key, 0.0)
            physical = float(item["physical_qty"])
            diff = physical - system_qty
            db.run("UPDATE stock_opname_items SET system_qty=? WHERE id=?", (system_qty, int(item["id"])))
            if abs(diff) < EPS:
                continue
            reason_text = f"Penyesuaian stok opname #{opname_id}: {item.get('reason') or '-'}"
            if str(item.get("note") or "").strip():
                reason_text += f" — {str(item['note']).strip()}"
            _post_adjustment(db, int(opname_id), item, diff, cutoff, reason_text, user_id, stamp)
            adjust += 1
            if diff > 0:
                plus += diff
            else:
                minus += -diff
        after = stock_map(db, cutoff)
        for item in items:
            key = (int(item["product_id"]), normalize_size(item["trx_size"]), item["location"] or "")
            if abs(after.get(key, 0.0) - float(item["physical_qty"])) > 1e-6:
                raise AppError(
                    "Pemeriksaan akhir gagal: saldo setelah penyesuaian tidak sama dengan hitungan fisik. "
                    "Tidak ada data yang diubah."
                )
        db.run(
            "UPDATE stock_opname SET status='DONE', completed_at=?, approved_by=? WHERE id=? AND status='DRAFT'",
            (stamp, user_id, int(opname_id)),
        )
        db.log(
            user_id, "OPNAME_SAH",
            f"#{opname_id} | cut-off={cutoff} | penyesuaian={adjust} | lebih={_qty(plus)} | kurang={_qty(minus)}",
            "stock_opname", int(opname_id),
        )
    return {"adjustments": adjust, "plus": plus, "minus": minus, "cutoff": cutoff}


def reopen(db: DB, user_id: int, opname_id: int, reason: str) -> dict:
    reason = str(reason or "").strip()
    if len(reason) < 5:
        raise AppError("Tulis alasan membuka kembali (minimal 5 karakter).")
    number = f"OPN-{opname_id}"
    with db.atomic():
        session = db.one("SELECT * FROM stock_opname WHERE id=?", (int(opname_id),))
        if not session:
            raise AppError("Sesi opname tidak ditemukan.", 404)
        if session["status"] != "DONE":
            raise AppError("Opname belum disahkan.")
        end = str(session["period_end"] or "")[:10]
        later = db.one(
            """SELECT id,status FROM stock_opname
               WHERE id<>? AND (COALESCE(period_end,'')>? OR (COALESCE(period_end,'')=? AND id>?)) LIMIT 1""",
            (int(opname_id), end, end, int(opname_id)),
        )
        if later:
            raise AppError("Hanya periode terakhir yang dapat dibuka kembali. Selesaikan periode yang lebih baru terlebih dahulu.")
        used = db.scalar(
            """SELECT COUNT(*) FROM transactions o
               WHERE o.trx_type='KELUAR' AND COALESCE(o.trx_number,'')<>?
                 AND o.source_trx_id IN (SELECT id FROM transactions WHERE trx_number=? AND trx_type='MASUK')""",
            (number, number), 0,
        )
        if int(used or 0) > 0:
            raise AppError("Stok hasil penyesuaian opname ini sudah dipakai barang keluar, sehingga tidak dapat dibatalkan.")
        adjusted = db.q("SELECT product_id,trx_size,location FROM transactions WHERE trx_number=?", (number,))
        closure = db.one("SELECT id FROM stock_period_closures WHERE opname_id=?", (int(opname_id),))
        if closure:
            db.run("DELETE FROM stock_period_closure_items WHERE closure_id=?", (int(closure["id"]),))
            db.run("DELETE FROM stock_period_closures WHERE id=?", (int(closure["id"]),))
        deleted = db.run("DELETE FROM transactions WHERE trx_number=?", (number,)).rowcount
        after = stock_map(db)
        for row in adjusted:
            key = (int(row["product_id"]), normalize_size(row["trx_size"]), (row["location"] or "").strip())
            if after.get(key, 0.0) < -EPS:
                raise AppError("Membatalkan penyesuaian akan membuat stok sekarang minus. Periksa transaksi setelah cut-off.")
        db.run("UPDATE stock_opname SET status='DRAFT', completed_at=NULL, approved_by=NULL WHERE id=?", (int(opname_id),))
        db.log(
            user_id, "OPNAME_BUKA_KEMBALI",
            f"#{opname_id} | ditutup={'ya' if closure else 'tidak'} | penyesuaian dihapus={deleted} | alasan={reason}",
            "stock_opname", int(opname_id),
        )
    return {"deleted": deleted}


def _movements(db: DB, start: str, end: str) -> dict:
    size_sql_t = "LOWER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(trx_size,'')),'×','x'),' ',''),'X','x'))"
    out: dict[tuple[int, str, str], dict] = {}

    def slot(product_id, size, location):
        return out.setdefault((int(product_id), size or "", location or ""), {
            "in": 0.0, "out": 0.0, "transfer": 0.0, "adj": 0.0,
        })

    for row in db.q(
        f"""SELECT product_id, {size_sql_t} AS size, TRIM(COALESCE(location,'')) AS location,
                   SUM(CASE WHEN trx_type='MASUK' AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty ELSE 0 END) AS q_in,
                   SUM(CASE WHEN trx_type='KELUAR' AND COALESCE(trx_number,'') NOT LIKE 'OPN-%' THEN qty ELSE 0 END) AS q_out,
                   SUM(CASE WHEN COALESCE(trx_number,'') LIKE 'OPN-%'
                        THEN (CASE WHEN trx_type='MASUK' THEN qty ELSE -qty END) ELSE 0 END) AS q_adj
            FROM transactions
            WHERE SUBSTR(trx_date,1,10)>=? AND SUBSTR(trx_date,1,10)<=?
            GROUP BY product_id,{size_sql_t},TRIM(COALESCE(location,''))""",
        (start, end),
    ):
        row_slot = slot(row["product_id"], row["size"], row["location"])
        row_slot["in"] += float(row["q_in"] or 0)
        row_slot["out"] += float(row["q_out"] or 0)
        row_slot["adj"] += float(row["q_adj"] or 0)
    for column, sign in (("from_location", -1), ("to_location", 1)):
        for row in db.q(
            f"""SELECT product_id, {size_sql_t} AS size, TRIM(COALESCE({column},'')) AS location, SUM(qty) AS q
                FROM location_transfers
                WHERE SUBSTR(transfer_date,1,10)>=? AND SUBSTR(transfer_date,1,10)<=?
                GROUP BY product_id,{size_sql_t},TRIM(COALESCE({column},''))""",
            (start, end),
        ):
            slot(row["product_id"], row["size"], row["location"])["transfer"] += sign * float(row["q"] or 0)
    return out


def rollforward(db: DB, start: str, end: str) -> list[dict]:
    start_date = parse_iso_date(start)
    end_date = parse_iso_date(end)
    opening = stock_map(db, (start_date - timedelta(days=1)).isoformat())
    closing = stock_map(db, end_date.isoformat())
    movements = _movements(db, start_date.isoformat(), end_date.isoformat())
    rows = []
    for key in set(opening) | set(closing) | set(movements):
        move = movements.get(key, {"in": 0.0, "out": 0.0, "transfer": 0.0, "adj": 0.0})
        opening_qty = opening.get(key, 0.0)
        closing_qty = closing.get(key, 0.0)
        if all(abs(value) < 1e-6 for value in (
            opening_qty, closing_qty, move["in"], move["out"], move["transfer"], move["adj"],
        )):
            continue
        rows.append({
            "key": key, "opening": opening_qty, "in": move["in"], "out": move["out"],
            "transfer": move["transfer"], "adj": move["adj"], "closing": closing_qty,
            "gap": opening_qty + move["in"] - move["out"] + move["transfer"] + move["adj"] - closing_qty,
        })
    rows.sort(key=lambda row: (row["key"][0], row["key"][1], row["key"][2]))
    return rows


def close_period(db: DB, user_id: int, opname_id: int) -> dict:
    stamp = now_iso()
    with db.atomic():
        session = db.one("SELECT * FROM stock_opname WHERE id=?", (int(opname_id),))
        if not session:
            raise AppError("Sesi opname tidak ditemukan.", 404)
        if session["status"] != "DONE":
            raise AppError("Sahkan opname terlebih dahulu sebelum menutup periode.")
        if db.one("SELECT id FROM stock_period_closures WHERE opname_id=?", (int(opname_id),)):
            raise AppError("Periode ini sudah ditutup.")
        items = db.q("SELECT * FROM stock_opname_items WHERE opname_id=? ORDER BY product_id,trx_size,location", (int(opname_id),))
        if any(item["physical_qty"] is None for item in items):
            raise AppError("Ada item yang belum dihitung; buka kembali pengesahan dan lengkapi hitungan.")
        cutoff = str(session["period_end"])[:10]
        start = str(session["period_start"] or cutoff)[:10]
        last = db.one("SELECT MAX(period_end) AS m FROM stock_period_closures")
        if last and last.get("m"):
            if cutoff <= str(last["m"])[:10]:
                raise AppError("Periode ini berakhir sebelum/pada penutupan terakhir.")
            if start != (parse_iso_date(last["m"]) + timedelta(days=1)).isoformat():
                raise AppError("Awal periode tidak bersambung dengan penutupan terakhir; ada celah antar periode.")
        snapshot = stock_map(db, cutoff)
        for item in items:
            key = (int(item["product_id"]), normalize_size(item["trx_size"]), item["location"] or "")
            if abs(snapshot.get(key, 0.0) - float(item["physical_qty"])) > 1e-6:
                raise AppError(
                    "Saldo buku per cut-off berbeda dari hitungan fisik (ada transaksi yang berubah setelah pengesahan). "
                    "Buka kembali pengesahan, lalu sahkan ulang."
                )
        rows = rollforward(db, start, cutoff)
        bad = [row for row in rows if abs(row["gap"]) > 1e-6]
        if bad:
            raise AppError(f"Rincian saldo tidak seimbang pada {len(bad)} baris (periksa tanggal transaksi).")
        closure_id = db.insert(
            """INSERT INTO stock_period_closures(
                   opname_id,period_start,period_end,closed_at,user_id,item_count,note
               ) VALUES(?,?,?,?,?,?,?)""",
            (int(opname_id), start, cutoff, stamp, user_id, len(rows), "Saldo akhir buku setelah penyesuaian opname."),
        )
        for row in rows:
            product_id, size, location = row["key"]
            db.insert(
                """INSERT INTO stock_period_closure_items(
                       closure_id,product_id,trx_size,location,closing_qty,opening_qty,in_qty,out_qty,transfer_qty,adj_qty
                   ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (closure_id, product_id, size, location, row["closing"], row["opening"], row["in"],
                 row["out"], row["transfer"], row["adj"]),
            )
        db.log(user_id, "OPNAME_TUTUP", f"#{opname_id} | {start} s.d. {cutoff} | saldo={len(rows)}", "stock_opname", int(opname_id))
    return {"closure_id": closure_id, "items": len(rows), "start": start, "end": cutoff}


def cancel_draft(db: DB, user_id: int, opname_id: int) -> dict:
    with db.atomic():
        session = _draft_lock(db, opname_id)
        db.run("DELETE FROM stock_opname_items WHERE opname_id=?", (int(opname_id),))
        db.run("DELETE FROM stock_opname WHERE id=?", (int(opname_id),))
        db.log(
            user_id, "OPNAME_BATAL",
            f"#{opname_id} | {session['period_start']} s.d. {session['period_end']}",
            "stock_opname", int(opname_id),
        )
    return {"cancelled": True}


def get_session(db: DB, opname_id: int) -> dict:
    session = db.one(
        """SELECT o.*, c.id AS closure_id, c.closed_at, u.username AS created_by_name,
                  a.username AS approved_by_name
           FROM stock_opname o
           LEFT JOIN stock_period_closures c ON c.opname_id=o.id
           LEFT JOIN users u ON u.id=o.user_id
           LEFT JOIN users a ON a.id=o.approved_by
           WHERE o.id=?""",
        (int(opname_id),),
    )
    if not session:
        raise AppError("Sesi opname tidak ditemukan.", 404)
    session["label_status"] = session_status(session)
    session["period_start_display"] = _fmt_date(session["period_start"])
    session["period_end_display"] = _fmt_date(session["period_end"])
    session["items"] = load_items(db, opname_id)
    session["summary"] = summarize(db, opname_id)
    session["problems"] = approval_problems(db, opname_id) if session["status"] == "DRAFT" else []
    session["locked_through"] = locked_through(db)
    closure = None
    if session.get("closure_id"):
        closure = db.one("SELECT * FROM stock_period_closures WHERE id=?", (int(session["closure_id"]),))
        closure_rows = db.q(
            """SELECT ci.*, p.code, p.name, p.unit
               FROM stock_period_closure_items ci JOIN products p ON p.id=ci.product_id
               WHERE ci.closure_id=? ORDER BY p.name, ci.trx_size, ci.location""",
            (int(session["closure_id"]),),
        )
        for row in closure_rows:
            row["size_display"] = size_display(row["trx_size"])
        closure["rows"] = closure_rows
    session["closure"] = closure
    session["next"] = next_period_info(db) if session["label_status"] == "DITUTUP" else None
    return session
