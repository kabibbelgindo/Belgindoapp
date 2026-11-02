"""Titik masuk aplikasi PT. Belgindo Raya Inventory (versi web modern)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import traceback
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path

from server.api import APP_VERSION, SESSION_COOKIE, Api, ApiResult
from server.core import APP_NAME, APP_SUBTITLE, AppError, DB, init_database
from server.seed import demo_purge_done, purge_demo_data, seed_accounts

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = BASE_DIR / "data"
DEFAULT_DB = DATA_DIR / "belgindo.db"
BACKUP_DIR = DATA_DIR / "backups"
MAX_BODY = 8 * 1024 * 1024

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; "
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; "
        "frame-ancestors 'none'"
    ),
}


class BelgiindoServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, db_path: Path, api: Api):
        super().__init__(address, handler)
        self.db_path = str(db_path)
        self.api = api
        self.web_dir = WEB_DIR.resolve()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"BelgindoRaya/{APP_VERSION}"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stdout.write(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}\n")

    # ------------------------------------------------------------------ helpers

    def _headers_lower(self) -> dict:
        return {key.lower(): value for key, value in self.headers.items()}

    def _cookie_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _read_body(self) -> object:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise AppError("Content-Length tidak valid.")
        if length > MAX_BODY:
            raise AppError("Ukuran permintaan terlalu besar.", 413)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        content_type = str(self.headers.get("Content-Type") or "").lower()
        if "application/json" in content_type or content_type == "":
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AppError("Body JSON tidak valid.")
        raise AppError("Gunakan Content-Type application/json.", 415)

    def _send_bytes(self, status: int, content: bytes, content_type: str,
                    extra_headers: dict | None = None, set_cookie: str | None = None,
                    clear_cookie: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        if set_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={set_cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
            )
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _send_json(self, status: int, payload: dict, extra_headers: dict | None = None,
                   set_cookie: str | None = None, clear_cookie: bool = False) -> None:
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
        headers.update(extra_headers or {})
        self._send_bytes(status, content, "application/json; charset=utf-8", headers, set_cookie, clear_cookie)

    # ------------------------------------------------------------------ API

    def _handle_api(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        query = {
            key: values[-1]
            for key, values in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()
        }
        try:
            body = self._read_body() if method in ("POST", "PUT", "PATCH", "DELETE") else {}
            headers = self._headers_lower()
            db = DB(self.server.db_path)
            try:
                result: ApiResult = self.server.api.dispatch(
                    db, method, parsed.path, query, body, headers,
                    self._cookie_token(), self.client_address[0],
                )
            finally:
                db.close()
            if result.raw is not None:
                self._send_bytes(
                    result.status, result.raw, result.content_type,
                    result.headers, result.set_cookie, result.clear_cookie,
                )
            else:
                self._send_json(
                    result.status, {"ok": True, "data": result.data},
                    result.headers, result.set_cookie, result.clear_cookie,
                )
        except AppError as exc:
            payload = {
                "ok": False, "error": exc.message, "code": getattr(exc, "code", "ERROR"),
                "status": exc.status,
            }
            self._send_json(exc.status, payload)
        except Exception:
            traceback.print_exc()
            payload = {
                "ok": False, "error": "Terjadi kesalahan internal. Periksa konsol server.",
                "code": "INTERNAL_ERROR", "status": 500,
            }
            self._send_json(500, payload)

    # ------------------------------------------------------------------ static

    def _serve_static(self) -> None:
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path in ("", "/"):
            relative = "index.html"
        else:
            relative = path.lstrip("/")
        web_dir: Path = self.server.web_dir
        candidate = (web_dir / relative).resolve()
        try:
            candidate.relative_to(web_dir)
        except ValueError:
            self._send_json(404, {"ok": False, "error": "Berkas tidak ditemukan."})
            return
        if not candidate.is_file():
            accept = str(self.headers.get("Accept") or "")
            if "text/html" in accept and not Path(relative).suffix:
                candidate = web_dir / "index.html"
            else:
                self._send_json(404, {"ok": False, "error": "Berkas tidak ditemukan."})
                return
        try:
            stat = candidate.stat()
            content = candidate.read_bytes()
        except OSError:
            self._send_json(500, {"ok": False, "error": "Berkas tidak dapat dibaca."})
            return
        content_type = MIME_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
        if candidate.name == "index.html":
            self._send_bytes(200, content, content_type, {"Cache-Control": "no-store"})
            return
        # Aset statis memakai ETag: permintaan ulang yang sama cukup dijawab 304
        # sehingga browser tidak mengunduh ulang seluruh JS/CSS setiap kali buka.
        etag = f'"{candidate.name}-{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("ETag", etag)
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            return
        self._send_bytes(200, content, content_type, {"Cache-Control": "no-cache", "ETag": etag})

    # ------------------------------------------------------------------ verbs

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api"):
            self._handle_api("GET")
        else:
            self._serve_static()

    def do_HEAD(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api"):
            self._handle_api("GET")
        else:
            self._serve_static()

    def do_POST(self):
        self._handle_api("POST")

    def do_PUT(self):
        self._handle_api("PUT")

    def do_PATCH(self):
        self._handle_api("PATCH")

    def do_DELETE(self):
        self._handle_api("DELETE")

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"{APP_NAME} — {APP_SUBTITLE} (edisi web modern)",
    )
    parser.add_argument("--host", default=os.environ.get("BR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BR_PORT", "9393")))
    parser.add_argument("--db", default=os.environ.get("BR_DB", str(DEFAULT_DB)))
    parser.add_argument("--no-browser", action="store_true", help="Jangan buka browser otomatis.")
    return parser.parse_args()


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    args = parse_args()
    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    db = init_database(str(db_path))
    created_accounts = False
    cleaned_demo = False
    try:
        if not demo_purge_done(db):
            purge_demo_data(db)
            cleaned_demo = True
            print("Data contoh versi lama dibersihkan: transaksi dan master demo dikosongkan.")
        if not db.scalar("SELECT COUNT(*) FROM users", (), 0):
            seed_accounts(db)
            created_accounts = True
            print("Database kosong dibuat dengan dua akun awal (tanpa data contoh).")
    finally:
        db.close()
    api = Api(str(BACKUP_DIR))
    server = BelgiindoServer((args.host, args.port), Handler, db_path, api)
    url_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{url_host}:{args.port}/"
    print("=" * 66)
    print(f"  {APP_NAME} — {APP_SUBTITLE}")
    print(f"  Edisi Web Modern · v{APP_VERSION}")
    print("=" * 66)
    print(f"  Alamat   : {url}")
    print(f"  Database : {db_path}")
    print(f"  Backup   : {BACKUP_DIR}")
    if created_accounts:
        print("  Akun awal: admin / 123  ·  administrator / administrator")
        print("  (Password diganti sukarela lewat menu Ganti Password)")
    elif cleaned_demo:
        print("  Data contoh lama telah dibersihkan; database siap diisi data nyata")
        print("  Akun     : gunakan akun yang sudah terdaftar")
    else:
        print("  Akun     : gunakan akun yang sudah terdaftar")
    print("  Hentikan : Ctrl+C")
    print("=" * 66)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
