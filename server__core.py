"""Fondasi aplikasi: error, format angka Indonesia, keamanan, dan akses SQLite."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

APP_NAME = "PT. BELGINDO RAYA INVENTORY"
APP_SUBTITLE = "Inventori Kayu"
M3_DIVISOR = Decimal("10000000")
EPS = 1e-9

DEFAULT_PASSWORDS = {
    "administrator": {"administrator"},
    "admin": {"123", "admin123"},
}
DEVELOPER_USERNAME = "administrator"
DEVELOPER_PASSWORD = "administrator"
FIRST_LOGIN_USERNAME = "admin"
FIRST_LOGIN_PASSWORD = "123"
WEAK_PASSWORDS = {
    "123", "1234", "12345", "123456", "111111", "password", "admin",
    "administrator", "admin123", "qwerty", "belgindo", "belgindo123",
}
MIN_PASSWORD_LENGTH = 6

OPNAME_REASONS = (
    "Salah hitung / perlu hitung ulang",
    "Transaksi belum tercatat",
    "Salah catat transaksi",
    "Susut / rusak / afkir",
    "Pindah lokasi belum dicatat",
    "Barang temuan",
    "Lainnya",
)
OPNAME_REASON_OTHER = "Lainnya"


class AppError(ValueError):
    """Kesalahan aturan bisnis yang aman ditampilkan kepada pengguna."""

    def __init__(self, message: str, status: int = 400, code: str = "BUSINESS_RULE"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


class AuthError(AppError):
    def __init__(self, message: str, status: int = 401, code: str = "UNAUTHORIZED"):
        super().__init__(message, status=status, code=code)


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today_iso() -> str:
    return date.today().isoformat()


def parse_iso_date(value, field: str = "Tanggal") -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    raise AppError(f"{field} tidak valid. Gunakan format DD-MM-YYYY.")


def iso_date(value, field: str = "Tanggal") -> str:
    return parse_iso_date(value, field).isoformat()


def display_date(value) -> str:
    text = str(value or "")[:10]
    try:
        return date.fromisoformat(text).strftime("%d-%m-%Y")
    except ValueError:
        return "-"


def trim_number(value) -> str:
    try:
        dec = Decimal(str(value)).normalize()
    except (InvalidOperation, ValueError):
        return str(value or "")
    if dec == dec.to_integral():
        return str(int(dec))
    return format(dec, "f").rstrip("0").rstrip(".")


def fmt_qty(value) -> str:
    try:
        dec = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return "0"
    text = format(dec, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",")


def m3_text(value, decimals: int = 6) -> str:
    try:
        dec = Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return "0"
    text = format(dec, "f").rstrip("0").rstrip(".")
    return (text or "0").replace(".", ",")


def normalize_size(size) -> str:
    """Menormalkan ukuran apa pun ke bentuk kanonik LxTxP (tanpa spasi)."""
    text = str(size or "").strip().lower().replace("×", "x").replace(" ", "")
    if not text:
        return ""
    parts = text.split("x")
    if len(parts) != 3:
        raise AppError("Ukuran harus terdiri dari Lebar, Tebal, dan Panjang.")
    try:
        values = [Decimal(part.replace(",", ".")) for part in parts]
    except InvalidOperation as exc:
        raise AppError("Ukuran harus berupa angka.") from exc
    if any(value <= 0 for value in values):
        raise AppError("Ukuran harus lebih besar dari 0.")
    return "x".join(trim_number(value) for value in values)


def make_size(thickness, width, length) -> str:
    """Menerima T (mm), L (cm), P (cm) dan menyimpan LxTxP."""
    try:
        t = Decimal(str(thickness).replace(",", "."))
        l = Decimal(str(width).replace(",", "."))
        p = Decimal(str(length).replace(",", "."))
    except (InvalidOperation, ValueError) as exc:
        raise AppError("Ukuran T, L, dan P harus berupa angka.") from exc
    if min(t, l, p) <= 0:
        raise AppError("Ukuran T, L, dan P harus lebih besar dari 0.")
    return f"{trim_number(l)}x{trim_number(t)}x{trim_number(p)}"


def size_parts(size) -> tuple[float, float, float]:
    """Kembalikan (L, T, P)."""
    normalized = normalize_size(size)
    if not normalized:
        return 0.0, 0.0, 0.0
    l, t, p = normalized.split("x")
    return float(l), float(t), float(p)


def size_display(size) -> str:
    """Urutan tampilan T × L × P (T=Tebal mm, L=Lebar cm, P=Panjang cm)."""
    try:
        l, t, p = size_parts(size)
        if not (l and t and p):
            return "-"
        return f"{trim_number(t)} × {trim_number(l)} × {trim_number(p)}"
    except AppError:
        return str(size or "-")


def m3_value(size, qty) -> float:
    try:
        l, t, p = size_parts(size)
        volume = Decimal(str(l)) * Decimal(str(t)) * Decimal(str(p)) * Decimal(str(qty)) / M3_DIVISOR
        return float(volume)
    except (AppError, InvalidOperation, ValueError):
        return 0.0


def line_amount(size, qty, price) -> float:
    try:
        amount = Decimal(str(m3_value(size, qty))) * Decimal(str(price or 0))
        return float(amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return 0.0


def money_text(value) -> str:
    try:
        amount = Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        amount = Decimal("0")
    sign = "-" if amount < 0 else ""
    whole, _, cents = format(abs(amount), ".2f").partition(".")
    groups = []
    while whole:
        groups.append(whole[-3:])
        whole = whole[:-3]
    integer = ".".join(reversed(groups)) or "0"
    if cents == "00":
        return f"{sign}Rp {integer}"
    return f"{sign}Rp {integer},{cents}"


def validate_dimensions_standard(db: "DB", size: str, allow_import: bool = False) -> None:
    if allow_import:
        l, t, p = size_parts(size)
        if l > 200 or t > 100 or p > 2000:
            raise AppError("Ukuran melebihi batas aman. Periksa kembali T, L, dan P.")
        return
    l, t, p = size_parts(size)
    if t > 60:
        raise AppError(f"Tebal (T) maksimal 60 mm. Nilai sekarang {trim_number(t)} mm.")
    if l > 20:
        raise AppError(f"Lebar (L) maksimal 20 cm. Nilai sekarang {trim_number(l)} cm.")
    if p > 999:
        raise AppError(f"Panjang (P) maksimal 999 cm. Nilai sekarang {trim_number(p)} cm.")
    active = {}
    for row in db.q("SELECT dimension, value FROM master_spec_values WHERE active=1"):
        active.setdefault(row["dimension"], set()).add(round(float(row["value"]), 6))
    checks = (("L", l), ("T", t), ("P", p))
    labels = {"L": "Lebar (L)", "T": "Tebal (T)", "P": "Panjang (P)"}
    for key, value in checks:
        values = active.get(key)
        if values and round(float(value), 6) not in values:
            options = ", ".join(trim_number(v) for v in sorted(values))
            raise AppError(f"{labels[key]} harus dipilih dari master ({options}).")


def generate_name_code(db: "DB", name: str, table: str = "products") -> str:
    """Kode otomatis dari karakter ke-1, ke-3, dan ke-5 nama (seperti aplikasi asal)."""
    if table not in {"products"}:
        raise AppError("Tabel kode otomatis tidak dikenal.")
    letters = "".join(ch for ch in str(name or "").upper() if ch.isalnum())
    if not letters:
        raise AppError("Nama wajib diisi untuk membuat kode.")
    base = "".join(letters[i] for i in (0, 2, 4) if i < len(letters))
    if len(base) < 2:
        base = (letters + "BRG")[:3]
    candidates = [base]
    extras = letters[1::2] + letters[5:]
    for ch in extras:
        base += ch
        candidates.append(base)
    for suffix in range(1, 1000):
        candidates.append(f"{candidates[0]}{suffix:02d}")
    for code in candidates:
        if not db.one(f"SELECT id FROM {table} WHERE code=? COLLATE NOCASE", (code,)):
            return code.upper()
    raise AppError("Tidak dapat membuat kode unik. Gunakan nama lain.")


def resolve_seller_id(db: "DB", value, allow_inactive: bool = False):
    if value in (None, ""):
        return None
    if isinstance(value, int) or (isinstance(value, str) and value.isdigit()):
        row = db.one("SELECT * FROM sellers WHERE id=?", (int(value),))
    else:
        row = db.one("SELECT * FROM sellers WHERE name=? COLLATE NOCASE", (str(value).strip(),))
    if not row:
        raise AppError("Penjual tidak ditemukan.")
    if not row["active"] and not allow_inactive:
        raise AppError("Penjual berstatus nonaktif.")
    return int(row["id"])


def resolve_location(db: "DB", value, allow_inactive: bool = False) -> str:
    name = str(value or "").strip()
    if not name:
        raise AppError("Lokasi wajib dipilih.")
    row = db.one("SELECT * FROM storage_locations WHERE code=? COLLATE NOCASE OR name=? COLLATE NOCASE", (name, name))
    if not row:
        raise AppError("Lokasi tidak ditemukan pada data master.")
    if not row["active"] and not allow_inactive:
        raise AppError(f"Lokasi {name} berstatus nonaktif.")
    return str(row["code"]).strip()


# --------------------------------------------------------------------------- keamanan

def hash_password(password: str, iterations: int = 200_000) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt, digest = str(stored).split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        computed = hashlib.pbkdf2_hmac(
            "sha256", str(password).encode("utf-8"),
            base64.b64decode(salt), int(iterations),
        )
        return hmac.compare_digest(base64.b64encode(computed).decode("ascii"), digest)
    except (ValueError, TypeError):
        return False


def uses_default_password(username, password) -> bool:
    return str(password or "") in DEFAULT_PASSWORDS.get(str(username or "").strip().lower(), ())


def check_new_password(username: str, new: str, confirm: str, old: str | None = None) -> None:
    new = str(new or "")
    if not new or not str(confirm or ""):
        raise AppError("Password baru dan konfirmasi wajib diisi.")
    if new != str(confirm):
        raise AppError("Password baru dan konfirmasi tidak sama.")
    if len(new) < MIN_PASSWORD_LENGTH:
        raise AppError(f"Password baru minimal {MIN_PASSWORD_LENGTH} karakter.")
    if old is not None and new == str(old):
        raise AppError("Password baru tidak boleh sama dengan password lama.")
    if new.strip().lower() == str(username or "").strip().lower():
        raise AppError("Password baru tidak boleh sama dengan username.")
    if new.strip().lower() in WEAK_PASSWORDS or uses_default_password(username, new):
        raise AppError("Password terlalu mudah ditebak. Pilih password lain.")


# --------------------------------------------------------------------------- database

class DB:
    def __init__(self, path: str):
        self.path = path
        self.conn = sqlite3.connect(path, timeout=30, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=15000")
        self.conn.execute("PRAGMA synchronous=NORMAL")

    def close(self) -> None:
        try:
            self.conn.close()
        except sqlite3.Error:
            pass

    def q(self, sql: str, args=()) -> list[dict]:
        return [dict(row) for row in self.conn.execute(sql, tuple(args)).fetchall()]

    def one(self, sql: str, args=()) -> dict | None:
        row = self.conn.execute(sql, tuple(args)).fetchone()
        return dict(row) if row is not None else None

    def scalar(self, sql: str, args=(), default=None):
        row = self.conn.execute(sql, tuple(args)).fetchone()
        if row is None:
            return default
        value = row[0]
        return default if value is None else value

    def run(self, sql: str, args=()):
        return self.conn.execute(sql, tuple(args))

    def insert(self, sql: str, args=()) -> int:
        cursor = self.conn.execute(sql, tuple(args))
        return int(cursor.lastrowid)

    @contextmanager
    def atomic(self):
        if self.conn.in_transaction:
            raise RuntimeError("Transaksi database bersarang tidak didukung.")
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield self
        except Exception:
            self.conn.rollback()
            raise
        else:
            self.conn.commit()

    def log(self, user_id, action: str, detail: str = "", entity: str = "activity", entity_id=None) -> None:
        stamp = now_iso()
        self.run(
            "INSERT INTO activity_log(event_time,user_id,action,detail) VALUES(?,?,?,?)",
            (stamp, user_id, action, detail),
        )
        self.run(
            "INSERT INTO sync_outbox(created_at,entity,entity_id,action,status) VALUES(?,?,?,?,?)",
            (stamp, entity, entity_id, action, "SYNCED"),
        )

    def backup(self, destination_dir: str, prefix: str = "backup") -> str:
        os.makedirs(destination_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        target = os.path.join(destination_dir, f"{prefix}_{stamp}.db")
        backup_conn = sqlite3.connect(target)
        try:
            self.conn.backup(backup_conn)
        finally:
            backup_conn.close()
        return target


def init_database(path: str) -> DB:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = DB(path)
    from .schema import DDL, SCHEMA_VERSION
    db.conn.executescript(DDL)
    columns = {row["name"] for row in db.q("PRAGMA table_info(users)")}
    if "full_name" not in columns:
        db.run("ALTER TABLE users ADD COLUMN full_name TEXT")
    if "must_change_password" not in columns:
        db.run("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
    existing = db.one("SELECT value FROM app_meta WHERE key='schema_version'")
    if existing is None:
        db.run("INSERT OR IGNORE INTO app_meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
        db.run("INSERT OR IGNORE INTO app_meta(key,value) VALUES('created_at',?)", (now_iso(),))
    return db


def add_days(iso_value: str, days: int) -> str:
    return (parse_iso_date(iso_value) + timedelta(days=days)).isoformat()


def month_bounds(year: int, month: int) -> tuple[str, str]:
    first = date(year, month, 1)
    last = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
    return first.isoformat(), last.isoformat()
