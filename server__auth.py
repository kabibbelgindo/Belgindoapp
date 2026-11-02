"""Autentikasi, sesi cookie, pembatasan percobaan login, dan ganti password."""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass

from .core import (
    AppError, AuthError, DB, check_new_password, hash_password, now_iso,
    verify_password,
)
from .admin import public_user

SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_ATTEMPTS = 5
ATTEMPT_WINDOW_SECONDS = 60
LOCK_SECONDS = 30


@dataclass
class Session:
    token: str
    user_id: int
    created_at: float
    last_seen: float


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.RLock()

    def create(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._sessions[token] = Session(token, int(user_id), now, now)
            self._cleanup_locked(now)
        return token

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        now = time.time()
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            if now - session.last_seen > SESSION_TTL_SECONDS:
                self._sessions.pop(token, None)
                return None
            session.last_seen = now
            return session

    def revoke(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)

    def revoke_user(self, user_id: int, except_token: str | None = None) -> int:
        with self._lock:
            tokens = [
                token for token, session in self._sessions.items()
                if session.user_id == int(user_id) and token != except_token
            ]
            for token in tokens:
                self._sessions.pop(token, None)
            return len(tokens)

    def _cleanup_locked(self, now: float) -> None:
        expired = [
            token for token, session in self._sessions.items()
            if now - session.last_seen > SESSION_TTL_SECONDS
        ]
        for token in expired:
            self._sessions.pop(token, None)


class LoginLimiter:
    def __init__(self) -> None:
        self._attempts: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}
        self._lock = threading.RLock()

    def locked_for(self, key: str) -> int:
        with self._lock:
            until = self._locked_until.get(key, 0)
            now = time.time()
            if until > now:
                return max(1, int(until - now) + 1)
            if until:
                self._locked_until.pop(key, None)
            return 0

    def fail(self, key: str) -> int | None:
        with self._lock:
            now = time.time()
            attempts = [stamp for stamp in self._attempts.get(key, []) if now - stamp <= ATTEMPT_WINDOW_SECONDS]
            attempts.append(now)
            self._attempts[key] = attempts
            if len(attempts) >= MAX_ATTEMPTS:
                self._locked_until[key] = now + LOCK_SECONDS
                self._attempts[key] = []
                return LOCK_SECONDS
            return None

    def success(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)
            self._locked_until.pop(key, None)


def _user_row(db: DB, username: str) -> dict | None:
    return db.one("SELECT * FROM users WHERE username=? COLLATE NOCASE", (str(username or "").strip(),))


def login(db: DB, store: SessionStore, limiter: LoginLimiter,
          username: str, password: str) -> tuple[dict, str]:
    username = str(username or "").strip()
    password = str(password or "")
    key = username.lower()
    if not username or not password:
        raise AuthError("Username dan password wajib diisi.")
    wait = limiter.locked_for(key)
    if wait:
        raise AuthError(f"Terlalu banyak percobaan login. Coba lagi dalam {wait} detik.", 429)
    row = _user_row(db, username)
    if not row or not row.get("active") or not verify_password(password, row["password_hash"]):
        locked = limiter.fail(key)
        if locked:
            raise AuthError(f"Terlalu banyak percobaan login. Coba lagi dalam {locked} detik.", 429)
        raise AuthError("Username atau password salah.")
    limiter.success(key)
    stamp = now_iso()
    with db.atomic():
        db.run("UPDATE users SET last_login=? WHERE id=?", (stamp, int(row["id"])))
        db.log(row["id"], "LOGIN", f"user={row['username']}", "users", int(row["id"]))
    row = _user_row(db, username)
    token = store.create(int(row["id"]))
    return public_user(row), token


def current_user(db: DB, store: SessionStore, token: str | None) -> dict | None:
    session = store.get(token)
    if not session:
        return None
    row = db.one("SELECT * FROM users WHERE id=? AND active=1", (session.user_id,))
    if not row:
        store.revoke(token)
        return None
    return row


def change_password(db: DB, store: SessionStore, user: dict, token: str | None,
                    old_password: str, new_password: str, confirm_password: str) -> dict:
    row = db.one("SELECT * FROM users WHERE id=? AND active=1", (int(user["id"]),))
    if not row:
        raise AuthError("Sesi tidak valid.")
    if not verify_password(str(old_password or ""), row["password_hash"]):
        raise AppError("Password lama salah.")
    check_new_password(row["username"], new_password, confirm_password, str(old_password or ""))
    with db.atomic():
        db.run("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), int(row["id"])))
        db.log(int(row["id"]), "GANTI_PASSWORD", f"user={row['username']}", "users", int(row["id"]))
    revoked = store.revoke_user(int(row["id"]), except_token=token)
    return {"user": public_user(db.one("SELECT * FROM users WHERE id=?", (int(row["id"]),))), "revoked_sessions": revoked}


def logout(db: DB, store: SessionStore, token: str | None, user: dict | None) -> None:
    if user:
        db.log(int(user["id"]), "LOGOUT", f"user={user['username']}", "users", int(user["id"]))
    store.revoke(token)
