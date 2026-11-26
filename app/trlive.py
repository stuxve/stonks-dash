"""Trade Republic: live prices for your TR holdings from Lang & Schwarz Exchange (LSX), the venue TR trades on
(07:30–23:00, also for US stocks and the European ETFs Yahoo barely updates).

Trade Republic has no public API. This uses pytr (https://github.com/pytr-org/pytr), which speaks the private
API of TR's web app as you. Login is pytr's "v2" flow: phone number + your TR PIN, then you confirm a push in
the TR app (or type your authenticator-app code). It needs no bot-protection bypass. Only reading calls are used
here: account settings, the compact portfolio and price tickers. Nothing that places, changes or cancels orders.

Security
* Your TR PIN is used for that one login request and never stored.
* What is stored is the web session (cookies), encrypted with AES-GCM (authenticated encryption). The key is
  derived with scrypt (a deliberately slow, memory-hard function) from your *dashboard PIN* plus a secret
  kept on the Pi (`STONKS_SECRET`, or /data/.stonks_secret created on first use). A copy of the database alone
  can't be decrypted. Someone with the Pi's disk could try every 4–8-digit PIN, so keep the Pi itself safe.
* The session is usable only while unlocked: the PIN unlocks it for `lock_minutes` (default 10), then it locks
  again by itself (the decrypted session and the key are dropped from memory). 5 wrong PINs → 15 minutes
  without attempts.
* TR can log the web session out at any time (it also does when you log in elsewhere); then log in again.
Using a private API may be against TR's terms; TR could block the session. It's your account and your call.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import threading
import time
from typing import Callable

log = logging.getLogger("stonks.tr")
for _n in ("pytr", "pytr.api"):
    logging.getLogger(_n).setLevel(logging.WARNING)       # pytr logs login responses at debug level


# ------------------------------------------------------------------------------------------------ vault
class VaultError(Exception):
    pass


class Vault:
    """The TR session, encrypted with a key from the dashboard PIN + a per-install secret (the 'pepper')."""
    KEY = "secret:tr_vault"
    MAX_FAILS, LOCKOUT_S = 5, 900

    def __init__(self, db, pepper: bytes):
        self.db, self.pepper = db, pepper
        self.fails, self.locked_until = 0, 0.0

    def _rec(self) -> dict:
        return self.db.get_meta([self.KEY], 10 * 365 * 86400).get(self.KEY) or {}

    def pin_set(self) -> bool:
        return bool(self._rec().get("blob"))

    def _derive(self, pin: str, salt: bytes) -> bytes:
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
        return Scrypt(salt=salt + self.pepper, length=32, n=2 ** 15, r=8, p=1).derive(pin.encode())

    @staticmethod
    def _seal(key: bytes, payload: dict) -> str:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = os.urandom(12)
        return base64.b64encode(nonce + AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), b"stonks-tr")).decode()

    @staticmethod
    def _unseal(key: bytes, blob: str) -> dict:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw = base64.b64decode(blob)
        return json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], b"stonks-tr"))

    def open(self, pin: str) -> tuple[bytes, dict]:
        """(key, payload) for the right PIN; counts failures and locks out after too many."""
        now = time.time()
        if now < self.locked_until:
            raise VaultError(f"Too many wrong PINs. Try again in {int(self.locked_until - now) // 60 + 1} min.")
        rec = self._rec()
        if not rec.get("blob"):
            raise VaultError("No PIN set yet.")
        key = self._derive(pin, base64.b64decode(rec["salt"]))
        try:
            payload = self._unseal(key, rec["blob"])
        except Exception:  # noqa: BLE001 — wrong key: authentication tag mismatch
            self.fails += 1
            if self.fails >= self.MAX_FAILS:
                self.fails, self.locked_until = 0, now + self.LOCKOUT_S
                raise VaultError("Wrong PIN. Too many attempts: locked for 15 minutes.") from None
            raise VaultError(f"Wrong PIN ({self.MAX_FAILS - self.fails} attempts left).") from None
        self.fails = 0
        return key, payload

    def attempts_left(self) -> int:
        return self.MAX_FAILS - self.fails

    def write(self, key: bytes, payload: dict, salt: bytes | None = None, **extra):
        rec = self._rec()
        rec.update(extra)
        rec.update(salt=base64.b64encode(salt).decode() if salt else rec["salt"], blob=self._seal(key, payload), at=time.time())
        self.db.put_meta(self.KEY, rec)

    def set_pin(self, new_pin: str, old_pin: str | None = None):
        """Set the first PIN, or change it (needs the current one): the session is re-encrypted with the new key."""
        payload = {"session": None}
        if self.pin_set():
            if old_pin is None:
                raise VaultError("Enter the current PIN.")
            _, payload = self.open(old_pin)
        salt = os.urandom(16)
        key = self._derive(new_pin, salt)
        self.write(key, payload, salt)
        return key

    def forget(self):
        self.db.put_meta(self.KEY, {})


def load_pepper(data_dir: str) -> bytes:
    env = os.getenv("STONKS_SECRET", "").strip()
    if env:
        return env.encode()
    path = os.path.join(data_dir, ".stonks_secret")
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        val = secrets.token_bytes(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(val)
        return val


# ------------------------------------------------------------------------------------------------ cookies
def dump_cookies(jar) -> list[dict]:
    return [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "secure": c.secure,
             "expires": c.expires} for c in jar if c.domain.endswith("traderepublic.com")]


def load_cookies(session, cookies: list[dict]):
    for c in cookies:
        session.cookies.set(c["name"], c["value"], domain=c["domain"], path=c.get("path") or "/",
                            secure=bool(c.get("secure")), expires=c.get("expires"))


def tick_price(payload: dict) -> tuple[float | None, float | None, float | None, int | None]:
    """(price, bid, ask, time ms) from a TR ticker message: the bid/ask midpoint, or the last trade."""
    def px(k):
        try:
            return float((payload.get(k) or {}).get("price"))
        except (TypeError, ValueError):
            return None
    bid, ask, last = px("bid"), px("ask"), px("last")
    t = (payload.get("last") or payload.get("bid") or {}).get("time")
    mid = (bid + ask) / 2 if bid and ask else None
    return (mid or last), bid, ask, (int(t) if t else None)


# ------------------------------------------------------------------------------------------------ live
class TRLive:
    """Login, lock / unlock and the ticker loop. `on_ticks(list)` gets [{isin, p (EUR), bid, ask, t}]."""

    def __init__(self, db, vault: Vault, on_ticks: Callable[[list[dict]], None], api_factory: Callable | None = None,
                 lock_minutes: Callable[[], float] = lambda: 10):
        self.db, self.vault, self.on_ticks = db, vault, on_ticks
        self.api_factory = api_factory or self._pytr
        self.lock_minutes = lock_minutes
        self.api = None
        self._key: bytes | None = None
        self._phone: str | None = None
        self.unlocked_until = 0.0
        self.pending: dict | None = None
        self.error: str | None = None
        self.portfolio: list[dict] = []          # [{isin, name, qty, avg}]
        self.portfolio_at = 0.0
        self.last_tick: float | None = None
        self.ticks = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pending_ticks: dict[str, dict] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._watchdog, name="stonks-tr-lock", daemon=True).start()

    @staticmethod
    def _pytr(phone: str, pin: str):
        from pytr.api import TradeRepublicApi
        api = TradeRepublicApi(phone_no=phone, pin=pin, locale="en", save_cookies=False, use_v2_login=True, waf_token=None)
        # pytr keeps these on the class; give this instance its own
        api.subscriptions, api._previous_responses = {}, {}
        api._subscription_id_counter = 1
        return api

    # ---- state
    def state(self) -> str:
        if self.pending:
            return "pending"
        if self.api is not None and time.time() < self.unlocked_until:
            return "live"
        if not self.vault.pin_set():
            return "no_pin"
        rec = self.vault._rec()
        return "locked" if rec.get("has_session") else "no_session"

    def status(self) -> dict:
        p = self.pending
        return {"state": self.state(), "pin_set": self.vault.pin_set(), "error": self.error,
                "phone": (self._phone[:3] + "•••" + self._phone[-2:]) if self._phone else self.vault._rec().get("phone_hint"),
                "unlocked_until": self.unlocked_until if self.state() == "live" else None,
                "lock_minutes": self.lock_minutes(), "attempts_left": self.vault.attempts_left(),
                "locked_out_until": self.vault.locked_until if self.vault.locked_until > time.time() else None,
                "pending": {"needs_code": p["needs_code"], "until": p["until"]} if p else None,
                "last_tick": self.last_tick, "ticks": self.ticks,
                "portfolio_at": self.portfolio_at or None}

    # ---- login: phone + TR PIN (used once, not kept) → confirm in the TR app / authenticator code
    def start_login(self, phone: str, tr_pin: str, dash_pin: str):
        key, payload = self.vault.open(dash_pin)                 # checks the dashboard PIN first
        self.lock()
        api = self.api_factory(phone, tr_pin)
        countdown = api.initiate_weblogin()
        self.pending = {"api": api, "phone": phone, "key": key, "payload": payload,
                        "needs_code": bool(getattr(api, "weblogin_needs_authenticator", False)),
                        "until": time.time() + (countdown or 120)}
        self.error = None
        if not self.pending["needs_code"]:
            threading.Thread(target=self._await_confirm, name="stonks-tr-login", daemon=True).start()
        return self.status()

    def _await_confirm(self, code: str | None = None):
        p = self.pending
        if not p:
            return
        try:
            p["api"].complete_weblogin(code)                    # polls until you confirm in the app
            self._activate(p["api"], p["phone"], p["key"], p["payload"], save=True)
        except Exception as e:  # noqa: BLE001
            self.error = f"Login failed: {e}"[:200]
            log.info("TR login failed: %s", type(e).__name__)
        finally:
            self.pending = None

    def submit_code(self, code: str):
        if not self.pending or not self.pending["needs_code"]:
            raise VaultError("No login is waiting for a code.")
        self._await_confirm(code)
        if self.error:
            raise VaultError(self.error)
        return self.status()

    def _activate(self, api, phone: str, key: bytes, payload: dict, save: bool):
        self.api, self._key, self._phone = api, key, phone
        self.unlocked_until = time.time() + self.lock_minutes() * 60
        if save:
            self._save()
        self._start_loop()

    def _save(self):
        if self.api is None or self._key is None:
            return
        payload = {"session": {"phone": self._phone, "cookies": dump_cookies(self.api._websession.cookies)}}
        self.vault.write(self._key, payload, has_session=True, phone_hint=self._phone[:3] + "•••" + self._phone[-2:])

    def set_pin(self, new_pin: str, old_pin: str | None = None):
        """Set or change the dashboard PIN; while unlocked, later saves use the new key."""
        self._save()                                             # the newest cookies go into the re-encrypted copy
        key = self.vault.set_pin(new_pin, old_pin)
        if self._key is not None:
            self._key = key
        return self.status()

    # ---- unlock / lock
    def unlock(self, dash_pin: str):
        key, payload = self.vault.open(dash_pin)
        s = payload.get("session")
        if not s:
            raise VaultError("No Trade Republic session saved: log in first.")
        api = self.api_factory(s["phone"], "0000")               # the PIN isn't needed to resume a session
        load_cookies(api._websession, s["cookies"])
        try:
            api.settings()                                       # refreshes the session; fails if TR logged it out
        except Exception:  # noqa: BLE001
            self.error = "Trade Republic ended the session (it does after a while, or when you log in elsewhere). Log in again."
            self.vault.write(key, {"session": None}, has_session=False)
            raise VaultError(self.error) from None
        self.error = None
        self._activate(api, s["phone"], key, payload, save=True)
        return self.status()

    def lock(self):
        self._save()                                             # keep the refreshed cookies (encrypted)
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(5)
        self.api, self._key, self.unlocked_until = None, None, 0.0
        self._stop = threading.Event()

    def forget(self, dash_pin: str):
        key, _ = self.vault.open(dash_pin)
        self.lock()
        self.vault.write(key, {"session": None}, has_session=False, phone_hint=None)
        self.portfolio, self._phone = [], None

    def reset(self):
        """Forgot the PIN (or STONKS_SECRET changed): delete the PIN and the saved session. Reveals nothing."""
        self.lock()
        self.pending = None
        self.vault.forget()
        self.vault.fails, self.vault.locked_until = 0, 0.0
        self.portfolio, self._phone, self.error = [], None, None

    def _watchdog(self):
        while True:
            time.sleep(5)
            if self.api is not None and time.time() >= self.unlocked_until:
                log.info("TR session locked after %s min", self.lock_minutes())
                try:
                    self.lock()
                except Exception as e:  # noqa: BLE001
                    log.info("TR lock failed: %s", e)

    # ---- ticker loop (its own thread and asyncio loop)
    def _start_loop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(5)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(self.api, self._stop), name="stonks-tr", daemon=True)
        self._thread.start()

    def _run(self, api, stop: threading.Event):
        try:
            asyncio.run(self._loop(api, stop))
        except Exception as e:  # noqa: BLE001
            if not stop.is_set():
                self.error = f"Price feed stopped: {type(e).__name__}"
                log.info("TR loop ended: %s", e)

    async def _loop(self, api, stop: threading.Event):
        api._lock = asyncio.Lock()                               # bound to this loop
        loop = asyncio.get_running_loop()
        await api.compact_portfolio()
        subs: dict[str, str] = {}
        keepalive = time.time()
        flushed = time.time()
        while not stop.is_set():
            try:
                sid, sub, payload = await asyncio.wait_for(api.recv(), 1.0)
            except asyncio.TimeoutError:
                sid = None
            except Exception as e:  # noqa: BLE001 — pytr raises TradeRepublicError for one bad subscription
                if type(e).__name__ != "TradeRepublicError":
                    raise
                log.info("TR subscription error: %s", getattr(e, "error", e))
                sid = None
            if sid is not None:
                kind = sub.get("type")
                if kind == "compactPortfolioByType":
                    self._take_portfolio(payload)
                    await api.unsubscribe(sid)
                    for pos in self.portfolio:
                        if pos["isin"] not in subs:
                            subs[pos["isin"]] = await api.ticker(pos["isin"], exchange="LSX")
                elif kind == "ticker":
                    isin = sub.get("id", "").split(".")[0]
                    p, bid, ask, t = tick_price(payload)
                    if p:
                        with self._lock:
                            self._pending_ticks[isin] = {"isin": isin, "p": p, "bid": bid, "ask": ask,
                                                         "t": t or int(time.time() * 1000)}
                        self.last_tick, self.ticks = time.time(), self.ticks + 1
            if time.time() - flushed >= 1.0:
                flushed = time.time()
                with self._lock:
                    batch, self._pending_ticks = list(self._pending_ticks.values()), {}
                if batch:
                    try:
                        self.on_ticks(batch)
                    except Exception as e:  # noqa: BLE001
                        log.info("TR tick handler: %s", e)
            if time.time() - keepalive > 240:                    # TR web sessions need a refresh every ~5 min
                keepalive = time.time()
                try:
                    await loop.run_in_executor(None, api.settings)
                except Exception as e:  # noqa: BLE001
                    self.error = "Trade Republic ended the session. Log in again."
                    log.info("TR keepalive failed: %s", type(e).__name__)
                    break
            if time.time() - self.portfolio_at > 600 and self.portfolio_at:   # refresh holdings every 10 min
                self.portfolio_at = time.time()
                await api.compact_portfolio()
        try:
            await api.close()
        except Exception:  # noqa: BLE001
            pass

    def _take_portfolio(self, payload: dict):
        out = []
        for cat in payload.get("categories") or []:
            for pos in cat.get("positions") or []:
                isin = pos.get("isin") or pos.get("instrumentId")
                if not isin:
                    continue
                def num(k):
                    try:
                        return float(pos.get(k))
                    except (TypeError, ValueError):
                        return None
                out.append({"isin": isin, "name": pos.get("name"), "qty": num("netSize"), "avg": num("averageBuyIn"),
                            "category": cat.get("categoryType")})
        self.portfolio, self.portfolio_at = out, time.time()


# ------------------------------------------------------------------------------------------------ demo
class FakeTRApi:
    """Stand-in for pytr in demo mode and tests: confirms the login by itself after a moment, holds two ISINs
    and streams a random walk around their prices."""

    def __init__(self, phone, pin, holdings: list[tuple[str, str, float, float]] | None = None, confirm_after: float = 1.0):
        import requests
        self._websession = requests.Session()
        self.weblogin_needs_authenticator = False
        self.confirm_after = confirm_after
        self.holdings = holdings or [("ES0113900J37", "Banco Santander", 900.0, 80.0), ("US5949181045", "Microsoft", 12.0, 420.0)]
        self.subscriptions, self._previous_responses = {}, {}
        self._q: asyncio.Queue | None = None
        self._n = 0
        self._px = {i: p for i, _, _, p in self.holdings}

    def initiate_weblogin(self):
        return 60

    def complete_weblogin(self, code=None):
        time.sleep(self.confirm_after)
        self._websession.cookies.set("tr_session", "demo", domain=".traderepublic.com")

    def settings(self):
        return {"securitiesAccountNumber": "demo"}

    async def _queue(self):
        if self._q is None:
            self._q = asyncio.Queue()
        return self._q

    async def compact_portfolio(self):
        q = await self._queue()
        self._n += 1
        sid = str(self._n)
        self.subscriptions[sid] = {"type": "compactPortfolioByType"}
        await q.put((sid, {"categories": [{"categoryType": "stocks", "positions": [
            {"isin": i, "name": n, "netSize": str(qty), "averageBuyIn": str(p)} for i, n, qty, p in self.holdings]}]}))
        return sid

    async def ticker(self, isin, exchange="LSX"):
        self._n += 1
        sid = str(self._n)
        self.subscriptions[sid] = {"type": "ticker", "id": f"{isin}.{exchange}"}
        return sid

    async def unsubscribe(self, sid):
        self.subscriptions.pop(sid, None)

    async def recv(self):
        import random
        q = await self._queue()
        if not q.empty():
            sid, payload = await q.get()
            return sid, self.subscriptions.get(sid, {}), payload
        await asyncio.sleep(0.3)
        tick = [(sid, s) for sid, s in self.subscriptions.items() if s.get("type") == "ticker"]
        if not tick:
            raise asyncio.TimeoutError
        sid, s = random.choice(tick)
        isin = s["id"].split(".")[0]
        self._px[isin] *= 1 + random.gauss(0, 0.0006)
        p = self._px[isin]
        return sid, s, {"bid": {"price": round(p * 0.9995, 4)}, "ask": {"price": round(p * 1.0005, 4)},
                        "last": {"price": round(p, 4), "time": int(time.time() * 1000)}}

    async def close(self):
        pass
