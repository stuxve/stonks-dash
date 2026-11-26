"""Dashboard PIN lock: every /api call needs a session cookie, which you get by entering the PIN.

- The PIN is the vault's (app/trlive.py `Vault`): scrypt over the PIN + a per-install secret, AES-GCM. A right PIN
  is the one that decrypts the vault; nothing else about it is stored. 5 wrong PINs block attempts for 15 min.
- Unlocking gives this browser a random session id in an HttpOnly, SameSite=Strict cookie. The session ends after
  `auth.idle_minutes` (Settings, default 10) without you using the page: only real activity (clicks, keys,
  scrolling, sent by the page as POST /api/auth/ping) counts, not the page's own background requests.
- State-changing requests from another origin are refused (Origin header must match Host), on top of SameSite.
- Sessions live in memory: restarting the container locks every browser.
- Forgot the PIN: `sudo docker exec stonks-dash python -m app.auth reset`, then restart the container. That deletes
  the PIN and the saved Trade Republic session (your portfolio data stays); the page then asks for a new PIN.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

COOKIE = "stonks_sid"
PUBLIC = {"/api/health", "/api/auth", "/api/auth/setup", "/api/auth/unlock", "/api/auth/lock"}


class Auth:
    def __init__(self, vault, idle_minutes: Callable[[], float], enabled: bool = True):
        self.vault, self.idle_minutes, self.enabled = vault, idle_minutes, enabled
        self.key: bytes | None = None             # vault key, kept after the first unlock (Trade Republic needs it)
        self._s: dict[str, dict] = {}            # session id -> {"seen": last activity, "at": created}
        self._lock = threading.Lock()

    # ---- sessions
    def _new(self) -> str:
        tok = secrets.token_urlsafe(32)
        with self._lock:
            self._s[tok] = {"seen": time.time(), "at": time.time()}
        return tok

    def remaining(self, tok: str | None) -> float | None:
        """Seconds left before this session locks, or None if it isn't valid."""
        if not tok:
            return None
        with self._lock:
            s = self._s.get(tok)
            if not s:
                return None
            left = s["seen"] + self.idle_minutes() * 60 - time.time()
            if left <= 0:
                self._s.pop(tok, None)
                return None
            return left

    def valid(self, tok: str | None) -> bool:
        return not self.enabled or self.remaining(tok) is not None

    def touch(self, tok: str | None) -> None:
        with self._lock:
            if tok in self._s:
                self._s[tok]["seen"] = time.time()

    def end(self, tok: str | None) -> None:
        with self._lock:
            self._s.pop(tok, None)

    def end_others(self, tok: str | None) -> None:
        with self._lock:
            self._s = {k: v for k, v in self._s.items() if k == tok}

    def status(self, tok: str | None) -> dict:
        if not self.enabled:
            return {"state": "off", "enabled": False}
        left = self.remaining(tok)
        st = "no_pin" if not self.vault.pin_set() else "unlocked" if left is not None else "locked"
        v = self.vault
        return {"state": st, "enabled": True, "idle_minutes": self.idle_minutes(), "remaining": left,
                "attempts_left": v.attempts_left(),
                "locked_out_until": v.locked_until if v.locked_until > time.time() else None}

    # ---- PIN
    def setup(self, new_pin: str) -> str:
        if self.vault.pin_set():
            from .trlive import VaultError
            raise VaultError("A PIN is already set.")
        self.key = self.vault.set_pin(new_pin)
        return self._new()

    def unlock(self, pin: str) -> tuple[str, dict]:
        self.key, payload = self.vault.open(pin)
        return self._new(), payload

    def change_pin(self, tok: str | None, old_pin: str, new_pin: str) -> None:
        self.key = self.vault.set_pin(new_pin, old_pin)
        self.end_others(tok)                     # other browsers have to enter the new PIN


# ------------------------------------------------------------------------------------------------ ASGI
def cookie_of(headers) -> str | None:
    """The session id from raw ASGI headers [(b'cookie', b'a=1; stonks_sid=…')]."""
    for k, v in headers:
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                name, _, val = part.strip().partition("=")
                if name == COOKIE:
                    return val
    return None


def _same_origin(headers) -> bool:
    h = dict(headers)
    origin = h.get(b"origin")
    if not origin:
        return True                              # same-origin form posts and non-browser clients send none
    host = (h.get(b"x-forwarded-host") or h.get(b"host") or b"").decode("latin-1").split(",")[0].strip()
    try:
        return urlsplit(origin.decode("latin-1")).netloc == host
    except ValueError:
        return False


class AuthMiddleware:
    """Pure ASGI (keeps /api/events streaming): 401 for any /api call without a live session; 403 for
    state-changing calls from another origin."""

    def __init__(self, inner, auth: Auth):
        self.inner, self.auth = inner, auth

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.inner(scope, receive, send)
        if scope["method"] not in ("GET", "HEAD", "OPTIONS") and not _same_origin(scope["headers"]):
            return await _json(send, 403, {"detail": "Cross-origin request refused."})
        if scope["path"] not in PUBLIC and not self.auth.valid(cookie_of(scope["headers"])):
            return await _json(send, 401, {"detail": "locked"})
        return await self.inner(scope, receive, send)


async def _json(send, status: int, body: dict):
    raw = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode()),
                            (b"cache-control", b"no-store")]})
    await send({"type": "http.response.body", "body": raw})


# ------------------------------------------------------------------------------------------------ CLI
def _reset(db_path: str) -> None:
    from .db import DB
    from .trlive import Vault
    DB(db_path).put_meta(Vault.KEY, {})
    print("Dashboard PIN and saved Trade Republic session deleted. Restart the container "
          "(sudo docker restart stonks-dash), then open the dashboard to set a new PIN.")


if __name__ == "__main__":
    import sys
    if sys.argv[1:2] != ["reset"]:
        sys.exit("usage: python -m app.auth reset [path/to/stonks.db]")
    _reset(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.getenv("STONKS_DATA_DIR", "/data"), "stonks.db"))
