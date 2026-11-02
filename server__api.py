"""REST API aplikasi: autentikasi, operasi, laporan, ekspor, dan administrasi."""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable

from . import admin, auth, documents, exports, importing, opname, reports, stock
from .core import (
    APP_NAME, APP_SUBTITLE, AppError, AuthError, DB, OPNAME_REASONS,
    display_date, today_iso,
)
from .admin import public_user

APP_VERSION = "1.0.99"
APP_EDITION = "Modern Web"
SESSION_COOKIE = "br_sid"


def _app_info() -> dict:
    today = today_iso()
    return {
        "name": APP_NAME,
        "subtitle": APP_SUBTITLE,
        "version": APP_VERSION,
        "edition": APP_EDITION,
        "today": today,
        "today_display": display_date(today),
        "year": date.today().year,
    }


def _permissions(user: dict) -> dict:
    is_admin = user.get("role") == "admin"
    primary = bool(user.get("is_primary_admin"))
    return {
        "is_admin": is_admin,
        "is_primary": primary,
        "manage_master": is_admin,
        "change_master_status": primary,
        "manage_users": is_admin,
        "approve_opname": is_admin,
        "close_period": is_admin,
        "cancel_opname": is_admin,
        "reopen_opname": primary,
        "reset_data": is_admin,
        "backup": is_admin,
        "activity": is_admin,
        "sync": is_admin,
    }


@dataclass
class ApiResult:
    data: Any = None
    status: int = 200
    raw: bytes | None = None
    content_type: str = "application/json; charset=utf-8"
    headers: dict = field(default_factory=dict)
    set_cookie: str | None = None
    clear_cookie: bool = False


@dataclass
class ApiContext:
    db: DB
    user: dict | None
    token: str | None
    query: dict
    body: Any
    headers: dict
    ip: str
    sessions: auth.SessionStore
    limiter: auth.LoginLimiter
    backup_dir: str
    set_cookie: str | None = None
    clear_cookie: bool = False


@dataclass
class Route:
    method: str
    pattern: re.Pattern
    handler: Callable
    auth_required: bool = True


def _q_int(ctx: ApiContext, name: str, required: bool = False, default: int | None = None) -> int | None:
    value = ctx.query.get(name)
    if value in (None, ""):
        if required:
            raise AppError(f"Parameter {name} wajib diisi.")
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise AppError(f"Parameter {name} harus berupa angka.")


def _q_str(ctx: ApiContext, name: str, default: str = "") -> str:
    return str(ctx.query.get(name, default) or "").strip()


def _body_dict(ctx: ApiContext) -> dict:
    if isinstance(ctx.body, dict):
        return ctx.body
    if ctx.body in (None, ""):
        return {}
    raise AppError("Payload harus berupa objek JSON.")


def _body_int(ctx: ApiContext, name: str, required: bool = True, default: int | None = None) -> int | None:
    body = _body_dict(ctx)
    value = body.get(name)
    if value in (None, ""):
        if required:
            raise AppError(f"{name} wajib diisi.")
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise AppError(f"{name} harus berupa angka bulat.")


def _body_list(ctx: ApiContext, name: str) -> list:
    body = _body_dict(ctx)
    value = body.get(name)
    if value is None:
        return []
    if not isinstance(value, list):
        raise AppError(f"{name} harus berupa daftar.")
    return value


class Api:
    def __init__(self, backup_dir: str) -> None:
        self.sessions = auth.SessionStore()
        self.limiter = auth.LoginLimiter()
        self.backup_dir = backup_dir
        self.routes: list[Route] = []
        self._register()

    # ------------------------------------------------------------------ routing

    def _route(self, method: str, pattern: str, handler: Callable,
               auth_required: bool = True) -> None:
        self.routes.append(Route(method.upper(), re.compile(f"^{pattern}$"), handler, auth_required))

    def _register(self) -> None:
        self._route("GET", r"/api/health", self.health, auth_required=False)
        self._route("POST", r"/api/auth/login", self.login, auth_required=False)
        self._route("POST", r"/api/auth/logout", self.logout)
        self._route("GET", r"/api/auth/session", self.session_info)
        self._route("POST", r"/api/auth/change-password", self.change_password)
        self._route("GET", r"/api/meta", self.meta)
        self._route("GET", r"/api/dashboard", self.dashboard)

        self._route("GET", r"/api/sellers/directory", self.seller_directory)
        self._route("GET", r"/api/rits", self.list_rits)
        self._route("POST", r"/api/rits", self.create_rit)
        self._route("PUT", r"/api/rits/(?P<rit_id>\d+)", self.update_rit)
        self._route("DELETE", r"/api/rits/(?P<rit_id>\d+)", self.delete_rit)
        self._route("GET", r"/api/rits/(?P<rit_id>\d+)/notes", self.list_notes)
        self._route("GET", r"/api/rits/(?P<rit_id>\d+)/notes/(?P<note>[^/]+)", self.get_note)
        self._route("POST", r"/api/rits/(?P<rit_id>\d+)/notes", self.add_note_line)
        self._route("PUT", r"/api/rits/(?P<rit_id>\d+)/notes/(?P<note>[^/]+)", self.update_note)
        self._route("DELETE", r"/api/note-lines/(?P<trx_id>\d+)", self.delete_note_line)
        self._route("POST", r"/api/rits/(?P<rit_id>\d+)/notes/(?P<note>[^/]+)/tally", self.create_tally)
        self._route("POST", r"/api/rits/(?P<rit_id>\d+)/notes/(?P<note>[^/]+)/recap", self.create_recap)
        self._route("GET", r"/api/tallies", self.list_tallies)
        self._route("GET", r"/api/tallies/(?P<tally_id>\d+)", self.get_tally)
        self._route("POST", r"/api/tallies/(?P<tally_id>\d+)/cancel", self.cancel_tally)
        self._route("GET", r"/api/recaps", self.list_recaps)
        self._route("GET", r"/api/recaps/(?P<recap_id>\d+)", self.get_recap)
        self._route("POST", r"/api/recaps/(?P<recap_id>\d+)/cancel", self.cancel_recap)

        self._route("GET", r"/api/stock", self.stock_list)
        self._route("GET", r"/api/stock/lots", self.stock_lots)
        self._route("GET", r"/api/stock-card", self.stock_card)
        self._route("GET", r"/api/outgoing", self.list_outgoing)
        self._route("POST", r"/api/outgoing", self.create_outgoing)
        self._route("GET", r"/api/outgoing/(?P<trx_id>\d+)", self.get_outgoing)
        self._route("PUT", r"/api/outgoing/(?P<trx_id>\d+)", self.update_outgoing)
        self._route("POST", r"/api/outgoing/cancel", self.cancel_outgoing)
        self._route("GET", r"/api/transfers", self.list_transfers)
        self._route("POST", r"/api/transfers", self.create_transfer)

        self._route("GET", r"/api/imports", self.list_imports)
        self._route("POST", r"/api/imports", self.create_import)
        self._route("POST", r"/api/imports/parse", self.parse_import)
        self._route("GET", r"/api/imports/(?P<trx_id>\d+)", self.get_import)
        self._route("PUT", r"/api/imports/(?P<trx_id>\d+)", self.update_import)
        self._route("GET", r"/api/imports/export", self.export_imports)

        self._route("GET", r"/api/opname", self.opname_home)
        self._route("POST", r"/api/opname", self.create_opname)
        self._route("GET", r"/api/opname/(?P<opname_id>\d+)", self.get_opname)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/refresh", self.refresh_opname)
        self._route("PUT", r"/api/opname/(?P<opname_id>\d+)/items/(?P<item_id>\d+)", self.set_opname_count)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/items", self.add_found_item)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/fill", self.fill_opname)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/approve", self.approve_opname)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/reopen", self.reopen_opname)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/close", self.close_opname)
        self._route("POST", r"/api/opname/(?P<opname_id>\d+)/cancel", self.cancel_opname)

        self._route("GET", r"/api/reports/transactions", self.report_transactions)
        self._route("GET", r"/api/reports/stock", self.report_stock)
        self._route("GET", r"/api/reports/sellers", self.report_sellers)
        self._route("GET", r"/api/reports/recaps", self.report_recaps)
        self._route("GET", r"/api/reports/tallies", self.report_tallies)
        self._route("GET", r"/api/reports/transfers", self.report_transfers)
        self._route("GET", r"/api/reports/imports", self.report_imports)
        self._route("GET", r"/api/reports/activity", self.report_activity)
        self._route("GET", r"/api/exports/(?P<name>[a-z-]+)", self.export_file)

        self._route("GET", r"/api/pdf/tally/(?P<tally_id>\d+)", self.pdf_tally)
        self._route("GET", r"/api/pdf/recap/(?P<recap_id>\d+)", self.pdf_recap)
        self._route("GET", r"/api/pdf/opname/(?P<opname_id>\d+)", self.pdf_opname)

        self._route("GET", r"/api/master/products", self.master_products)
        self._route("POST", r"/api/master/products", self.master_product_create)
        self._route("PUT", r"/api/master/products/(?P<product_id>\d+)", self.master_product_update)
        self._route("POST", r"/api/master/products/(?P<product_id>\d+)/toggle", self.master_product_toggle)
        self._route("GET", r"/api/master/sellers", self.master_sellers)
        self._route("POST", r"/api/master/sellers", self.master_seller_create)
        self._route("PUT", r"/api/master/sellers/(?P<seller_id>\d+)", self.master_seller_update)
        self._route("POST", r"/api/master/sellers/(?P<seller_id>\d+)/toggle", self.master_seller_toggle)
        self._route("DELETE", r"/api/master/sellers/(?P<seller_id>\d+)", self.master_seller_delete)
        self._route("GET", r"/api/master/locations", self.master_locations)
        self._route("POST", r"/api/master/locations", self.master_location_create)
        self._route("PUT", r"/api/master/locations/(?P<location_id>\d+)", self.master_location_update)
        self._route("POST", r"/api/master/locations/(?P<location_id>\d+)/toggle", self.master_location_toggle)
        self._route("DELETE", r"/api/master/locations/(?P<location_id>\d+)", self.master_location_delete)
        self._route("GET", r"/api/master/specs", self.master_specs)
        self._route("POST", r"/api/master/specs", self.master_spec_create)
        self._route("PUT", r"/api/master/specs/(?P<spec_id>\d+)", self.master_spec_update)
        self._route("POST", r"/api/master/specs/(?P<spec_id>\d+)/toggle", self.master_spec_toggle)
        self._route("GET", r"/api/master/prices", self.master_prices)
        self._route("POST", r"/api/master/prices", self.master_price_create)
        self._route("PUT", r"/api/master/prices/(?P<price_id>\d+)", self.master_price_update)
        self._route("POST", r"/api/master/prices/(?P<price_id>\d+)/toggle", self.master_price_toggle)
        self._route("DELETE", r"/api/master/prices/(?P<price_id>\d+)", self.master_price_delete)
        self._route("GET", r"/api/master/users", self.master_users)
        self._route("POST", r"/api/master/users", self.master_user_create)
        self._route("PUT", r"/api/master/users/(?P<user_id>\d+)", self.master_user_update)
        self._route("POST", r"/api/master/users/(?P<user_id>\d+)/reset-password", self.master_user_reset_password)
        self._route("DELETE", r"/api/master/users/(?P<user_id>\d+)", self.master_user_delete)

        self._route("GET", r"/api/admin/activity", self.admin_activity)
        self._route("GET", r"/api/admin/sync", self.admin_sync)
        self._route("POST", r"/api/admin/sync/retry", self.admin_sync_retry)
        self._route("POST", r"/api/admin/sync/purge", self.admin_sync_purge)
        self._route("GET", r"/api/admin/backup", self.admin_backup)
        self._route("POST", r"/api/admin/reset-transactions", self.admin_reset)

    # ------------------------------------------------------------------ dispatch

    def dispatch(self, db: DB, method: str, path: str, query: dict, body: Any,
                 headers: dict, token: str | None, ip: str) -> ApiResult:
        method = method.upper()
        path = urllib.parse.unquote(path.split("?", 1)[0])
        if len(path) > 1:
            path = path.rstrip("/")
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            if str(headers.get("x-requested-with") or "") != "XMLHttpRequest":
                raise AppError("Permintaan ditolak: header keamanan X-Requested-With tidak ada.", 403, "CSRF")
        route = None
        params: dict = {}
        for candidate in self.routes:
            if candidate.method != method:
                continue
            match = candidate.pattern.match(path)
            if match:
                route = candidate
                params = match.groupdict()
                break
        if route is None:
            raise AppError("Endpoint tidak ditemukan.", 404, "NOT_FOUND")
        user = None
        if route.auth_required:
            session = self.sessions.get(token)
            if session:
                user = db.one("SELECT * FROM users WHERE id=? AND active=1", (session.user_id,))
                if not user:
                    self.sessions.revoke(token)
            if not user:
                raise AuthError("Sesi tidak ditemukan atau sudah berakhir. Silakan login kembali.")
        ctx = ApiContext(
            db=db, user=user, token=token, query=query, body=body, headers=headers,
            ip=ip, sessions=self.sessions, limiter=self.limiter, backup_dir=self.backup_dir,
        )
        result = route.handler(ctx, **params)
        if not isinstance(result, ApiResult):
            result = ApiResult(data=result)
        if ctx.set_cookie:
            result.set_cookie = ctx.set_cookie
        if ctx.clear_cookie:
            result.clear_cookie = True
        return result

    # ------------------------------------------------------------------ auth & meta

    def health(self, ctx: ApiContext) -> dict:
        return {"status": "ok", "app": _app_info()}

    def login(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        username = str(body.get("username") or "").strip()
        key = f"{username.lower()}|{ctx.ip}"
        user, token = auth.login(
            ctx.db, ctx.sessions, ctx.limiter, username, str(body.get("password") or ""),
        )
        ctx.set_cookie = token
        return {
            "user": user,
            "permissions": _permissions(ctx.db.one("SELECT * FROM users WHERE id=?", (user["id"],))),
            "app": _app_info(),
        }

    def logout(self, ctx: ApiContext) -> dict:
        auth.logout(ctx.db, ctx.sessions, ctx.token, ctx.user)
        ctx.clear_cookie = True
        return {"logged_out": True}

    def session_info(self, ctx: ApiContext) -> dict:
        return {
            "user": public_user(ctx.user),
            "permissions": _permissions(ctx.user),
            "app": _app_info(),
        }

    def change_password(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        result = auth.change_password(
            ctx.db, ctx.sessions, ctx.user, ctx.token,
            str(body.get("old_password") or ""), str(body.get("new_password") or ""),
            str(body.get("confirm_password") or ""),
        )
        result["permissions"] = _permissions(ctx.db.one("SELECT * FROM users WHERE id=?", (ctx.user["id"],)))
        return result

    def meta(self, ctx: ApiContext) -> dict:
        db = ctx.db
        products = admin.list_products(db, include_inactive=False, local_only=True)
        sellers = admin.list_sellers(db, include_inactive=False)
        locations = admin.list_locations(db, include_inactive=False)
        specs = admin.list_specs(db, include_inactive=False)
        prices = admin.list_prices(db, include_inactive=False)
        period = opname.next_period_info(db)
        if period.get("unclosed"):
            row = period["unclosed"]
            row["label_status"] = opname.session_status(row)
            row["period_start_display"] = display_date(str(row["period_start"])[:10])
            row["period_end_display"] = display_date(str(row["period_end"])[:10])
        locked = stock.locked_through(db)
        counts = {
            "active_tallies": int(db.scalar("SELECT COUNT(*) FROM tally_headers WHERE status='POSTED'", (), 0)),
            "active_recaps": int(db.scalar("SELECT COUNT(*) FROM payment_recap_headers WHERE status='AKTIF'", (), 0)),
            "unclosed_opname": int(period["unclosed"]["id"]) if period.get("unclosed") else None,
            "products": len(products),
        }
        return {
            "app": _app_info(),
            "user": public_user(ctx.user),
            "permissions": _permissions(ctx.user),
            "masters": {
                "products": [
                    {key: row.get(key) for key in (
                        "id", "code", "name", "unit", "spec_t", "spec_l", "spec_p",
                        "active_price", "purchase_price", "min_stock",
                    )}
                    for row in products
                ],
                "sellers": [
                    {"id": row["id"], "name": row["name"], "city": row.get("city") or ""}
                    for row in sellers
                ],
                "locations": [
                    {"code": row["code"], "name": row["name"]} for row in locations
                ],
                "specs": specs,
                "prices": [row["price"] for row in prices],
            },
            "constants": {
                "opname_reasons": list(OPNAME_REASONS),
                "product_units": list(admin.PRODUCT_UNITS),
                "import_prefix": admin.IMPORT_PREFIX,
                "min_password_length": 6,
            },
            "lock": {
                "locked_through": locked,
                "locked_through_display": display_date(locked) if locked else None,
            },
            "period": period,
            "counts": counts,
        }

    def dashboard(self, ctx: ApiContext) -> dict:
        data = reports.dashboard(ctx.db)
        data["permissions"] = _permissions(ctx.user)
        data["user"] = public_user(ctx.user)
        data["app"] = _app_info()
        return data

    # ------------------------------------------------------------------ penerimaan lokal

    def seller_directory(self, ctx: ApiContext) -> dict:
        rows = documents.seller_directory(ctx.db)
        return {"sellers": rows}

    def list_rits(self, ctx: ApiContext) -> dict:
        seller_id = _q_int(ctx, "seller_id", required=True)
        month = _q_str(ctx, "month") or date.today().strftime("%Y-%m")
        return {"month": month, "rits": documents.list_rits(ctx.db, seller_id, month)}

    def create_rit(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        return documents.create_rit(
            ctx.db, ctx.user["id"], _body_int(ctx, "seller_id"), body.get("rit_number"),
            body.get("date"), str(body.get("delivery_number") or ""), str(body.get("note") or ""),
        )

    def update_rit(self, ctx: ApiContext, rit_id: str) -> dict:
        body = _body_dict(ctx)
        return documents.update_rit(
            ctx.db, ctx.user["id"], int(rit_id), body.get("rit_number"), body.get("date"),
            str(body.get("delivery_number") or ""), str(body.get("note") or ""),
        )

    def delete_rit(self, ctx: ApiContext, rit_id: str) -> dict:
        return documents.delete_rit(ctx.db, ctx.user["id"], int(rit_id))

    def list_notes(self, ctx: ApiContext, rit_id: str) -> dict:
        return documents.list_notes(ctx.db, int(rit_id))

    def get_note(self, ctx: ApiContext, rit_id: str, note: str) -> dict:
        return documents.get_note(ctx.db, int(rit_id), note)

    def add_note_line(self, ctx: ApiContext, rit_id: str) -> dict:
        body = _body_dict(ctx)
        return documents.add_note_line(
            ctx.db, ctx.user["id"], int(rit_id), body.get("note"), body.get("date"),
            body.get("thickness"), body.get("price"), str(body.get("location") or ""),
            _body_int(ctx, "product_id"), body.get("width"), body.get("length"),
            body.get("qty"), str(body.get("line_note") or ""),
        )

    def update_note(self, ctx: ApiContext, rit_id: str, note: str) -> dict:
        body = _body_dict(ctx)
        return documents.update_note(
            ctx.db, ctx.user["id"], int(rit_id), note, body.get("date"),
            body.get("thickness"), body.get("price"), str(body.get("location") or ""),
            body.get("new_note"),
        )

    def delete_note_line(self, ctx: ApiContext, trx_id: str) -> dict:
        return documents.delete_note_line(ctx.db, ctx.user["id"], int(trx_id))

    def create_tally(self, ctx: ApiContext, rit_id: str, note: str) -> dict:
        body = _body_dict(ctx)
        return documents.create_tally(
            ctx.db, ctx.user["id"], int(rit_id), note,
            _body_list(ctx, "items"), str(body.get("signature") or ""),
        )

    def create_recap(self, ctx: ApiContext, rit_id: str, note: str) -> dict:
        return documents.create_recap(ctx.db, ctx.user["id"], int(rit_id), note)

    def list_tallies(self, ctx: ApiContext) -> dict:
        rows = documents.list_tallies(
            ctx.db, _q_int(ctx, "seller_id"), _q_str(ctx, "start"), _q_str(ctx, "end"),
            _q_str(ctx, "query"), _q_str(ctx, "status"),
        )
        return {"tallies": rows}

    def get_tally(self, ctx: ApiContext, tally_id: str) -> dict:
        return documents.get_tally(ctx.db, int(tally_id))

    def cancel_tally(self, ctx: ApiContext, tally_id: str) -> dict:
        body = _body_dict(ctx)
        return documents.cancel_tally(ctx.db, ctx.user["id"], int(tally_id), str(body.get("reason") or ""))

    def list_recaps(self, ctx: ApiContext) -> dict:
        rows = documents.list_recaps(
            ctx.db, _q_int(ctx, "seller_id"), _q_str(ctx, "start"), _q_str(ctx, "end"),
            _q_str(ctx, "query"), _q_str(ctx, "status"),
        )
        return {"recaps": rows}

    def get_recap(self, ctx: ApiContext, recap_id: str) -> dict:
        return documents.get_recap(ctx.db, int(recap_id))

    def cancel_recap(self, ctx: ApiContext, recap_id: str) -> dict:
        body = _body_dict(ctx)
        return documents.cancel_recap(ctx.db, ctx.user["id"], int(recap_id), str(body.get("reason") or ""))

    # ------------------------------------------------------------------ stok

    def stock_list(self, ctx: ApiContext) -> dict:
        rows = stock.stock_grouped(
            ctx.db, _q_str(ctx, "query"), _q_str(ctx, "location"), _q_str(ctx, "thickness"),
        )
        for row in rows:
            row["location_count"] = len(row.get("locations") or {})
        return {
            "rows": rows,
            "totals": {
                "qty": round(sum(float(row["stock"] or 0) for row in rows), 4),
                "m3": round(sum(float(row["m3"] or 0) for row in rows), 6),
                "items": len(rows),
            },
            "locked_through": stock.locked_through(ctx.db),
        }

    def stock_lots(self, ctx: ApiContext) -> dict:
        product_id = _q_int(ctx, "product_id", required=True)
        size = _q_str(ctx, "size")
        location = _q_str(ctx, "location")
        if not size:
            raise AppError("Parameter size wajib diisi.")
        lots = stock.stock_lots_detail(ctx.db, product_id, size, location)
        row = ctx.db.one(
            """SELECT id,code,name,unit,purchase_price FROM products WHERE id=?""",
            (product_id,),
        ) or {}
        return {
            "lots": lots,
            "product": row,
            "on_hand": stock.stock_at(ctx.db, product_id, size, location),
            "location": location,
        }

    def stock_card(self, ctx: ApiContext) -> dict:
        product_id = _q_int(ctx, "product_id", required=True)
        start = _q_str(ctx, "start") or date.today().replace(day=1).isoformat()
        end = _q_str(ctx, "end") or today_iso()
        return stock.stock_card(ctx.db, product_id, _q_str(ctx, "size"), _q_str(ctx, "location"), start, end)

    def list_outgoing(self, ctx: ApiContext) -> dict:
        rows = stock.list_outgoing(
            ctx.db, _q_str(ctx, "start"), _q_str(ctx, "end"), _q_str(ctx, "query"),
        )
        return {
            "rows": rows,
            "totals": {
                "count": len(rows),
                "qty": round(sum(float(row["qty"] or 0) for row in rows), 4),
            },
            "locked_through": stock.locked_through(ctx.db),
        }

    def create_outgoing(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        return stock.record_outgoing(
            ctx.db, ctx.user["id"], _body_int(ctx, "source_id"), str(body.get("location") or ""),
            body.get("qty"), body.get("date"), str(body.get("note") or ""),
        )

    def get_outgoing(self, ctx: ApiContext, trx_id: str) -> dict:
        row = stock.get_outgoing(ctx.db, int(trx_id))
        row["m3_display"] = f"{row['m3']:.6f}"
        row["max_qty"] = None
        if row.get("source_trx_id"):
            try:
                lot = stock.lot_capacity(ctx.db, int(row["source_trx_id"]), row.get("location") or "")
                row["max_qty"] = round(float(lot.get("remaining") or 0) + float(row.get("qty") or 0), 4)
                row["lot_remaining"] = round(float(lot.get("remaining") or 0), 4)
            except AppError:
                pass
        return row

    def update_outgoing(self, ctx: ApiContext, trx_id: str) -> dict:
        body = _body_dict(ctx)
        return stock.update_outgoing(
            ctx.db, ctx.user["id"], int(trx_id), body.get("qty"), body.get("date"),
            str(body.get("note") or ""), str(body.get("location") or ""),
        )

    def cancel_outgoing(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        ids = body.get("ids")
        if not isinstance(ids, list):
            raise AppError("ids harus berupa daftar transaksi.")
        return stock.cancel_outgoing(ctx.db, ctx.user["id"], ids, str(body.get("reason") or ""))

    def list_transfers(self, ctx: ApiContext) -> dict:
        rows = stock.list_transfers(ctx.db, _q_str(ctx, "start"), _q_str(ctx, "end"), _q_str(ctx, "query"))
        return {
            "rows": rows,
            "totals": {
                "count": len(rows),
                "qty": round(sum(float(row["qty"] or 0) for row in rows), 4),
                "m3": round(sum(float(row["m3"] or 0) for row in rows), 6),
            },
        }

    def create_transfer(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        return stock.record_transfer(
            ctx.db, ctx.user["id"], _body_int(ctx, "product_id"), str(body.get("size") or ""),
            str(body.get("from_location") or ""), str(body.get("to_location") or ""),
            body.get("qty"), body.get("date"), str(body.get("note") or ""),
        )

    # ------------------------------------------------------------------ impor

    def list_imports(self, ctx: ApiContext) -> dict:
        return importing.list_imports(ctx.db, _q_str(ctx, "start"), _q_str(ctx, "end"), _q_str(ctx, "query"))

    def create_import(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        if isinstance(body.get("fields"), dict):
            data = body["fields"]
        elif body.get("payload") is not None:
            data = importing.parse_payload(body["payload"])
        else:
            data = body
        return importing.create_import(ctx.db, ctx.user["id"], data)

    def parse_import(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        payload = body.get("payload")
        if payload in (None, ""):
            raise AppError("Isi payload barcode/dokumen terlebih dahulu.")
        parsed = importing.parse_payload(payload)
        return {"parsed": parsed}

    def get_import(self, ctx: ApiContext, trx_id: str) -> dict:
        return importing.get_import(ctx.db, int(trx_id))

    def update_import(self, ctx: ApiContext, trx_id: str) -> dict:
        return importing.update_import(ctx.db, ctx.user["id"], int(trx_id), _body_dict(ctx))

    def export_imports(self, ctx: ApiContext) -> ApiResult:
        return self._export(ctx, "imports")

    # ------------------------------------------------------------------ opname

    def opname_home(self, ctx: ApiContext) -> dict:
        sessions = opname.list_sessions(ctx.db)
        info = opname.next_period_info(ctx.db)
        if info.get("unclosed"):
            row = info["unclosed"]
            row["label_status"] = opname.session_status(row)
            row["period_start_display"] = display_date(str(row["period_start"])[:10])
            row["period_end_display"] = display_date(str(row["period_end"])[:10])
        return {
            "sessions": sessions,
            "next": info,
            "locked_through": stock.locked_through(ctx.db),
            "permissions": _permissions(ctx.user),
        }

    def create_opname(self, ctx: ApiContext) -> dict:
        body = _body_dict(ctx)
        opname_id = opname.create_session(ctx.db, ctx.user["id"], body.get("start"), body.get("end"))
        return opname.get_session(ctx.db, opname_id)

    def get_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        data = opname.get_session(ctx.db, int(opname_id))
        data["permissions"] = _permissions(ctx.user)
        return data

    def refresh_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        result = opname.refresh_items(ctx.db, ctx.user["id"], int(opname_id))
        result["session"] = opname.get_session(ctx.db, int(opname_id))
        return result

    def set_opname_count(self, ctx: ApiContext, opname_id: str, item_id: str) -> dict:
        body = _body_dict(ctx)
        return opname.set_count(
            ctx.db, ctx.user["id"], int(opname_id), int(item_id), body.get("physical_qty"),
            str(body.get("reason") or ""), str(body.get("note") or ""),
        )

    def add_found_item(self, ctx: ApiContext, opname_id: str) -> dict:
        body = _body_dict(ctx)
        return opname.add_found_item(
            ctx.db, ctx.user["id"], int(opname_id), _body_int(ctx, "product_id"),
            str(body.get("size") or ""), str(body.get("location") or ""), body.get("physical_qty"),
            str(body.get("reason") or "Barang temuan"), str(body.get("note") or ""),
        )

    def fill_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        return opname.fill_uncounted_as_system(ctx.db, ctx.user["id"], int(opname_id))

    def approve_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        admin.require_admin(ctx.user)
        return opname.approve(ctx.db, ctx.user["id"], int(opname_id))

    def reopen_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        admin.require_primary(ctx.user)
        body = _body_dict(ctx)
        return opname.reopen(ctx.db, ctx.user["id"], int(opname_id), str(body.get("reason") or ""))

    def close_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        admin.require_admin(ctx.user)
        return opname.close_period(ctx.db, ctx.user["id"], int(opname_id))

    def cancel_opname(self, ctx: ApiContext, opname_id: str) -> dict:
        admin.require_admin(ctx.user)
        return opname.cancel_draft(ctx.db, ctx.user["id"], int(opname_id))

    # ------------------------------------------------------------------ laporan

    def _report_filters(self, ctx: ApiContext) -> dict:
        return {
            "start": _q_str(ctx, "start"), "end": _q_str(ctx, "end"),
            "seller_id": _q_int(ctx, "seller_id"), "product_id": _q_int(ctx, "product_id"),
            "location": _q_str(ctx, "location"), "query": _q_str(ctx, "query"),
            "cutoff": _q_str(ctx, "cutoff"), "thickness": _q_str(ctx, "thickness"),
            "kind": _q_str(ctx, "kind") or "MASUK",
        }

    def report_transactions(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.transaction_report(
            ctx.db, f["start"], f["end"], f["kind"], f["seller_id"], f["product_id"],
            f["location"], f["query"],
        )

    def report_stock(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.stock_report(ctx.db, f["cutoff"], f["query"], f["location"], f["thickness"])

    def report_sellers(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.seller_summary(ctx.db, f["start"], f["end"])

    def report_recaps(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.recap_report(ctx.db, f["start"], f["end"], f["seller_id"])

    def report_tallies(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.tally_report(ctx.db, f["start"], f["end"], f["seller_id"])

    def report_transfers(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return reports.transfer_report(ctx.db, f["start"], f["end"], f["query"])

    def report_imports(self, ctx: ApiContext) -> dict:
        f = self._report_filters(ctx)
        return importing.list_imports(ctx.db, f["start"], f["end"], f["query"])

    def report_activity(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        f = self._report_filters(ctx)
        return reports.activity_report(
            ctx.db, f["start"], f["end"], _q_int(ctx, "user_id"), f["query"],
            int(_q_str(ctx, "limit") or 500),
        )

    def _export(self, ctx: ApiContext, name: str) -> ApiResult:
        if name in ("activity", "aktivitas"):
            admin.require_admin(ctx.user)
        params = {
            key: value for key, value in ctx.query.items() if value not in (None, "")
        }
        filename, content = reports.build_export(ctx.db, name, params)
        return ApiResult(
            raw=content,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def export_file(self, ctx: ApiContext, name: str) -> ApiResult:
        return self._export(ctx, name)

    def pdf_tally(self, ctx: ApiContext, tally_id: str) -> ApiResult:
        content = exports.tally_pdf(ctx.db, int(tally_id))
        return ApiResult(
            raw=content, content_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="tally-{tally_id}.pdf"'},
        )

    def pdf_recap(self, ctx: ApiContext, recap_id: str) -> ApiResult:
        content = exports.recap_pdf(ctx.db, int(recap_id))
        return ApiResult(
            raw=content, content_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="rekap-{recap_id}.pdf"'},
        )

    def pdf_opname(self, ctx: ApiContext, opname_id: str) -> ApiResult:
        mode = _q_str(ctx, "mode") or "count"
        if mode not in ("count", "result"):
            raise AppError("Mode PDF opname tidak dikenal.")
        content = exports.opname_pdf(ctx.db, int(opname_id), mode)
        return ApiResult(
            raw=content, content_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="opname-{opname_id}-{mode}.pdf"'},
        )

    # ------------------------------------------------------------------ master: produk

    def master_products(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        rows = admin.list_products(
            ctx.db, include_inactive=_q_str(ctx, "include_inactive") != "0",
            query=_q_str(ctx, "query"),
        )
        return {"products": rows}

    def master_product_create(self, ctx: ApiContext) -> dict:
        return admin.create_product(ctx.db, ctx.user["id"], _body_dict(ctx))

    def master_product_update(self, ctx: ApiContext, product_id: str) -> dict:
        return admin.update_product(ctx.db, ctx.user["id"], int(product_id), _body_dict(ctx))

    def master_product_toggle(self, ctx: ApiContext, product_id: str) -> dict:
        return admin.toggle_product(ctx.db, ctx.user["id"], int(product_id))

    # ------------------------------------------------------------------ master: penjual

    def master_sellers(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return {"sellers": admin.list_sellers(
            ctx.db, include_inactive=_q_str(ctx, "include_inactive") != "0", query=_q_str(ctx, "query"),
        )}

    def master_seller_create(self, ctx: ApiContext) -> dict:
        return admin.create_seller(ctx.db, ctx.user["id"], _body_dict(ctx))

    def master_seller_update(self, ctx: ApiContext, seller_id: str) -> dict:
        return admin.update_seller(ctx.db, ctx.user["id"], int(seller_id), _body_dict(ctx))

    def master_seller_toggle(self, ctx: ApiContext, seller_id: str) -> dict:
        return admin.toggle_seller(ctx.db, ctx.user["id"], int(seller_id))

    def master_seller_delete(self, ctx: ApiContext, seller_id: str) -> dict:
        return admin.delete_seller(ctx.db, ctx.user["id"], int(seller_id))

    # ------------------------------------------------------------------ master: lokasi

    def master_locations(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return {"locations": admin.list_locations(ctx.db, include_inactive=_q_str(ctx, "include_inactive") != "0")}

    def master_location_create(self, ctx: ApiContext) -> dict:
        return admin.create_location(ctx.db, ctx.user["id"], _body_dict(ctx))

    def master_location_update(self, ctx: ApiContext, location_id: str) -> dict:
        return admin.update_location(ctx.db, ctx.user["id"], int(location_id), _body_dict(ctx))

    def master_location_toggle(self, ctx: ApiContext, location_id: str) -> dict:
        return admin.toggle_location(ctx.db, ctx.user["id"], int(location_id))

    def master_location_delete(self, ctx: ApiContext, location_id: str) -> dict:
        return admin.delete_location(ctx.db, ctx.user["id"], int(location_id))

    # ------------------------------------------------------------------ master: ukuran & harga

    def master_specs(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return admin.list_specs(ctx.db, include_inactive=_q_str(ctx, "include_inactive") != "0")

    def master_spec_create(self, ctx: ApiContext) -> dict:
        return admin.create_spec(ctx.db, ctx.user["id"], _body_dict(ctx))

    def master_spec_update(self, ctx: ApiContext, spec_id: str) -> dict:
        return admin.update_spec(ctx.db, ctx.user["id"], int(spec_id), _body_dict(ctx))

    def master_spec_toggle(self, ctx: ApiContext, spec_id: str) -> dict:
        return admin.toggle_spec(ctx.db, ctx.user["id"], int(spec_id))

    def master_prices(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return {"prices": admin.list_prices(ctx.db, include_inactive=_q_str(ctx, "include_inactive") != "0")}

    def master_price_create(self, ctx: ApiContext) -> dict:
        return admin.create_price(ctx.db, ctx.user["id"], _body_dict(ctx))

    def master_price_update(self, ctx: ApiContext, price_id: str) -> dict:
        return admin.update_price(ctx.db, ctx.user["id"], int(price_id), _body_dict(ctx))

    def master_price_toggle(self, ctx: ApiContext, price_id: str) -> dict:
        return admin.toggle_price(ctx.db, ctx.user["id"], int(price_id))

    def master_price_delete(self, ctx: ApiContext, price_id: str) -> dict:
        return admin.delete_price(ctx.db, ctx.user["id"], int(price_id))

    # ------------------------------------------------------------------ master: pengguna

    def master_users(self, ctx: ApiContext) -> dict:
        return {"users": admin.list_users(ctx.db, ctx.user)}

    def master_user_create(self, ctx: ApiContext) -> dict:
        return admin.create_user(ctx.db, ctx.user, _body_dict(ctx))

    def master_user_update(self, ctx: ApiContext, user_id: str) -> dict:
        result = admin.update_user(ctx.db, ctx.user, int(user_id), _body_dict(ctx))
        if not result.get("active"):
            ctx.sessions.revoke_user(int(user_id))
        return result

    def master_user_reset_password(self, ctx: ApiContext, user_id: str) -> dict:
        result = admin.reset_user_password(ctx.db, ctx.user, int(user_id), _body_dict(ctx))
        ctx.sessions.revoke_user(int(user_id))
        return result

    def master_user_delete(self, ctx: ApiContext, user_id: str) -> dict:
        body = _body_dict(ctx)
        result = admin.delete_user(ctx.db, ctx.user, int(user_id), str(body.get("password") or ""))
        ctx.sessions.revoke_user(int(user_id))
        return result

    # ------------------------------------------------------------------ admin

    def admin_activity(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return reports.activity_report(
            ctx.db, _q_str(ctx, "start"), _q_str(ctx, "end"), _q_int(ctx, "user_id"),
            _q_str(ctx, "query"), int(_q_str(ctx, "limit") or 500),
        )

    def admin_sync(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        return admin.sync_status(ctx.db)

    def admin_sync_retry(self, ctx: ApiContext) -> dict:
        return admin.retry_sync(ctx.db, ctx.user)

    def admin_sync_purge(self, ctx: ApiContext) -> dict:
        return admin.purge_synced_outbox(ctx.db, ctx.user)

    def admin_backup(self, ctx: ApiContext) -> ApiResult:
        admin.require_admin(ctx.user)
        filename, content = admin.create_backup_bytes(ctx.db)
        ctx.db.log(ctx.user["id"], "BACKUP_DATABASE", f"file={filename}", "app_meta", None)
        return ApiResult(
            raw=content, content_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def admin_reset(self, ctx: ApiContext) -> dict:
        admin.require_admin(ctx.user)
        body = _body_dict(ctx)
        return admin.reset_transactions(
            ctx.db, ctx.user, str(body.get("password") or ""),
            str(body.get("confirmation") or ""), ctx.backup_dir,
        )
