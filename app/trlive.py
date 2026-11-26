"""Trade Republic: live prices for your TR holdings from Lang & Schwarz Exchange (LSX), the venue TR trades on
(07:30–23:00, also for US stocks and the European ETFs Yahoo barely updates).

Trade Republic has no public API. This uses pytr (https://github.com/pytr-org/pytr), which speaks the private
API of TR's web app as you. Login is pytr's "v2" flow: phone number + your TR PIN, then you confirm a push in
the TR app (or type your authenticator-app code). It needs no bot-protection bypass. Only reading calls are used
here: account settings, the compact portfolio and price tickers. Nothing that places, changes or cancels orders.

Security
* Your TR PIN is used for that one login request and then dropped (not stored, not kept in memory).
* What is stored is the web session (cookies), encrypted with AES-GCM (authenticated encryption). The key is
  derived with scrypt (a deliberately slow, memory-hard function) from your *dashboard PIN* plus a secret
  kept on the Pi (`STONKS_SECRET`, or /data/.stonks_secret created on first use). A copy of the database alone
  can't be decrypted. Someone with the Pi's disk could try every 4–8-digit PIN, so keep the Pi itself safe.
* The dashboard PIN also locks the whole dashboard (app/auth.py). Unlocking it gives the Pi the key; from then
  on the price feed keeps running (and saves refreshed cookies) even while the dashboard is locked again.
  After a container restart it waits for the next unlock.
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
        self.lock = threading.RLock()            # a write never mixes an old key with a new salt

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
        with self.lock:
            self._write(key, payload, salt, **extra)

    def _write(self, key: bytes, payload: dict, salt: bytes | None = None, **extra):
        rec = self._rec()
        rec.update(extra)
        rec.update(salt=base64.b64encode(salt).decode() if salt else rec["salt"], blob=self._seal(key, payload), at=time.time())
        self.db.put_meta(self.KEY, rec)

    def set_pin(self, new_pin: str, old_pin: str | None = None):
        """Set the first PIN, or change it (needs the current one): the session is re-encrypted with the new key."""
        with self.lock:
            payload = {"session": None}
            if self.pin_set():
                if old_pin is None:
                    raise VaultError("Enter the current PIN.")
                _, payload = self.open(old_pin)
            salt = os.urandom(16)
            key = self._derive(new_pin, salt)
            self._write(key, payload, salt)
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




def _auth_ended(e: Exception) -> bool:
    """TR refused the session itself (logged out), as opposed to a network hiccup or a TR outage."""
    r = getattr(e, "response", None)
    return getattr(r, "status_code", None) in (401, 403)


class SessionEnded(Exception):
    pass


# ------------------------------------------------------------------------------------------------ live
class TRLive:
    """Login, the saved session and the price feed. `key()` gives the vault key (from the dashboard unlock).
    `on_ticks(list)` gets [{isin, p (EUR), bid, ask, t, venue}] about once a second, from its own thread."""

    RETRY_MIN, RETRY_MAX = 5.0, 300.0

    def __init__(self, db, vault: Vault, on_ticks: Callable[[list[dict]], None], key: Callable[[], bytes | None],
                 api_factory: Callable | None = None):
        self.db, self.vault, self.on_ticks, self.key = db, vault, on_ticks, key
        self.api_factory = api_factory or self._pytr
        self.api = None
        self._phone: str | None = None
        self.pending: dict | None = None
        self.error: str | None = None
        self.connected = False
        self.portfolio: list[dict] = []          # [{isin, qty, avg, category}]
        self.portfolio_at = 0.0
        self.instruments: dict[str, dict] = {}   # isin -> {name, venue, error}
        self.last_tick: float | None = None
        self.ticks = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pending_ticks: dict[str, dict] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._flush, name="stonks-tr-flush", daemon=True).start()

    @staticmethod
    def _pytr(phone: str, pin: str):
        from pytr.api import TradeRepublicApi
        api = TradeRepublicApi(phone_no=phone, pin=pin, locale="en", save_cookies=False, use_v2_login=True, waf_token=None)
        # pytr keeps these on the class; give this instance its own
        api.subscriptions, api._previous_responses = {}, {}
        api._subscription_id_counter = 1
        return api

    # ---- state
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def state(self) -> str:
        if self.pending:
            return "pending"
        if self.running():
            return "live" if self.connected else "connecting"
        return "no_session" if not self.vault._rec().get("has_session") else "stopped"

    def status(self) -> dict:
        p = self.pending
        return {"state": self.state(), "error": self.error,
                "phone": (self._phone[:3] + "•••" + self._phone[-2:]) if self._phone else self.vault._rec().get("phone_hint"),
                "pending": {"needs_code": p["needs_code"], "until": p["until"]} if p else None,
                "last_tick": self.last_tick, "ticks": self.ticks, "portfolio_at": self.portfolio_at or None,
                "now": time.time()}

    # ---- login: phone + TR PIN (used once, then dropped) → confirm in the TR app / authenticator code
    def start_login(self, phone: str, tr_pin: str):
        if not self.key():
            raise VaultError("Unlock the dashboard first.")
        self.stop()
        api = self.api_factory(phone, tr_pin)
        try:
            countdown = api.initiate_weblogin()
        finally:
            api.pin = None                                       # only the login request needs it
        self.pending = {"api": api, "phone": phone, "needs_code": bool(getattr(api, "weblogin_needs_authenticator", False)),
                        "until": time.time() + (countdown or 120)}
        self.error = None
        if not self.pending["needs_code"]:
            threading.Thread(target=self._await_confirm, args=(self.pending,), name="stonks-tr-login", daemon=True).start()
        return self.status()

    def _await_confirm(self, p: dict):
        try:
            p["api"].complete_weblogin()                         # polls until you confirm in the app
            self._activate(p["api"], p["phone"])
        except Exception as e:  # noqa: BLE001
            self.error = f"Login failed: {e}"[:200]
            log.info("TR login failed: %s", type(e).__name__)
        finally:
            if self.pending is p:
                self.pending = None

    def submit_code(self, code: str):
        p = self.pending
        if not p or not p["needs_code"]:
            raise VaultError("No login is waiting for a code.")
        if time.time() > p["until"]:
            self.pending = None
            raise VaultError("The login expired. Log in again.")
        try:
            p["api"].complete_weblogin(code)
        except Exception as e:  # noqa: BLE001 — a wrong code: try again while the login is still open
            raise VaultError(f"{e}"[:200]) from None
        self.pending = None
        self._activate(p["api"], p["phone"])
        return self.status()

    def _activate(self, api, phone: str):
        self.api, self._phone, self.error = api, phone, None
        self.save()
        self._start()

    def resume(self, payload: dict | None = None):
        """After the dashboard unlock: start the feed from the saved session, unless it's already running."""
        if self.running() or self.pending:
            return
        if payload is None:
            key = self.key()
            if not key or not self.vault._rec().get("has_session"):
                return
            try:
                payload = Vault._unseal(key, self.vault._rec()["blob"])
            except Exception:  # noqa: BLE001
                return
        s = (payload or {}).get("session")
        if not s:
            return
        api = self.api_factory(s["phone"], "0000")               # pytr wants a PIN; a resumed session never sends it
        api.pin = None
        load_cookies(api._websession, s["cookies"])
        self.api, self._phone = api, s["phone"]
        self._start()

    def save(self):
        """Store the current cookies (encrypted). Under the vault lock, so a PIN change can't interleave."""
        api = self.api
        if api is None or not self._phone:
            return
        with self.vault.lock:
            key = self.key()
            if not key:
                return
            payload = {"session": {"phone": self._phone, "cookies": dump_cookies(api._websession.cookies)}}
            self.vault.write(key, payload, has_session=True, phone_hint=self._phone[:3] + "•••" + self._phone[-2:])

    def stop(self):
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(8)
        self.connected = False

    def disconnect(self):
        """Stop the feed and delete the saved session (log in again to resume)."""
        self.stop()
        self.pending = None
        with self.vault.lock:
            key = self.key()
            if key and self.vault.pin_set():
                self.vault.write(key, {"session": None}, has_session=False, phone_hint=None)
        self.api, self._phone, self.portfolio, self.instruments, self.error = None, None, [], {}, None

    # ---- the feed: its own thread and asyncio loop, reconnecting with a growing pause
    def _start(self):
        self.stop()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(self.api, self._stop), name="stonks-tr", daemon=True)
        self._thread.start()

    def _run(self, api, stop: threading.Event):
        wait = self.RETRY_MIN
        while not stop.is_set():
            got = [False]
            try:
                asyncio.run(self._loop(api, stop, got))
            except SessionEnded:
                self.error = "Trade Republic ended the session (it does after a while, or when you log in elsewhere). Log in again."
                log.info("TR session ended")
                with self.vault.lock:
                    key = self.key()
                    if key:
                        self.vault.write(key, {"session": None}, has_session=False)
                break
            except Exception as e:  # noqa: BLE001 — network, TR outage, dropped websocket: try again
                if stop.is_set():
                    break
                wait = self.RETRY_MIN if got[0] else min(self.RETRY_MAX, wait * 2)
                self.error = f"Connection lost ({type(e).__name__}); reconnecting in {int(wait)} s."
                log.info("TR feed: %s: %s (retry in %.0fs)", type(e).__name__, e, wait)
            finally:
                self.connected = False
            stop.wait(wait)

    async def _loop(self, api, stop: threading.Event, got: list):
        loop = asyncio.get_running_loop()

        def check():
            try:
                api.settings()                                   # refreshes the web session
            except Exception as e:  # noqa: BLE001
                if _auth_ended(e):
                    raise SessionEnded() from None
                raise
        await loop.run_in_executor(None, check)
        # a fresh websocket and subscription table for this connection
        api._lock = asyncio.Lock()
        api.subscriptions, api._previous_responses = {}, {}
        api._ws = None
        details: dict[str, str] = {}                             # subscription id -> ISIN
        tickers: dict[str, str] = {}                             # subscription id -> ISIN
        subscribed: set[str] = set()
        try:
            await api.compact_portfolio()
            self.connected = True
            keepalive = refreshed = time.time()

            async def want_ticker(isin):
                ins = self.instruments.get(isin) or {}
                if isin in subscribed or not ins.get("venue"):
                    return
                subscribed.add(isin)
                tickers[await api.ticker(isin, exchange=ins["venue"])] = isin

            while not stop.is_set():
                try:
                    sid, sub, payload = await asyncio.wait_for(api.recv(), 1.0)
                except asyncio.TimeoutError:
                    sid = None
                except Exception as e:  # noqa: BLE001 — pytr raises TradeRepublicError for one bad subscription
                    if type(e).__name__ != "TradeRepublicError":
                        raise
                    bad = getattr(e, "subscription_id", None) or (e.args[0] if e.args else None)
                    isin = tickers.pop(bad, None) or details.pop(bad, None)
                    if isin:
                        self.instruments.setdefault(isin, {})["error"] = "Trade Republic sends no price for it"
                    log.info("TR subscription error for %s", isin or bad)
                    sid = None
                if sid is not None:
                    got[0] = True
                    kind = sub.get("type")
                    if kind == "compactPortfolioByType":
                        self._take_portfolio(payload)
                        await api.unsubscribe(sid)
                        for pos in self.portfolio:
                            if pos["isin"] not in self.instruments:
                                details[await api.instrument_details(pos["isin"])] = pos["isin"]
                            else:
                                await want_ticker(pos["isin"])
                    elif kind == "instrument":
                        isin = details.pop(sid, None) or sub.get("id")
                        await api.unsubscribe(sid)
                        ids = payload.get("exchangeIds") or []
                        self.instruments[isin] = {"name": payload.get("shortName") or payload.get("name"),
                                                  "venue": "LSX" if "LSX" in ids else (ids[0] if ids else None),
                                                  "error": None if ids else "Not traded on any Trade Republic venue"}
                        await want_ticker(isin)
                    elif kind == "ticker":
                        isin = tickers.get(sid) or sub.get("id", "").split(".")[0]
                        p, bid, ask, t = tick_price(payload)
                        if p:
                            with self._lock:
                                self._pending_ticks[isin] = {"isin": isin, "p": p, "bid": bid, "ask": ask,
                                                             "t": t or int(time.time() * 1000),
                                                             "venue": (self.instruments.get(isin) or {}).get("venue")}
                            self.last_tick, self.ticks = time.time(), self.ticks + 1
                            self.error = None
                now = time.time()
                if now - keepalive > 240:                        # TR web sessions need a refresh every ~5 min
                    keepalive = now
                    await loop.run_in_executor(None, check)
                    await loop.run_in_executor(None, self.save)  # keep the newest cookies for a restart
                if now - refreshed > 600:                        # pick up bought / sold holdings
                    refreshed = now
                    await api.compact_portfolio()
        finally:
            try:
                await api.close()
            except Exception:  # noqa: BLE001
                pass

    def _flush(self):
        """Hand the ticks over about once a second, outside the feed's event loop (the handler may hit the network)."""
        while True:
            time.sleep(1.0)
            with self._lock:
                batch, self._pending_ticks = list(self._pending_ticks.values()), {}
            if batch:
                try:
                    self.on_ticks(batch)
                except Exception as e:  # noqa: BLE001
                    log.info("TR tick handler: %s", e)

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
                out.append({"isin": isin, "qty": num("netSize"), "avg": num("averageBuyIn"),
                            "category": cat.get("categoryType")})
        self.portfolio, self.portfolio_at = out, time.time()


# ------------------------------------------------------------------------------------------------ demo
class FakeTRApi:
    """Stand-in for pytr in demo mode and tests, shaped like the real thing: the portfolio has no names (they come
    from `instrument_details`, with the venues), prices stream per venue, and it can be told to drop the
    connection, end the session, or leave out the ask."""

    HOLDINGS = [("ES0113900J37", "Banco Santander", 900.0, 80.0, ["LSX", "TDG"]),
                ("US5949181045", "Microsoft", 12.0, 420.0, ["LSX", "TDG"]),
                ("XF000BTC0017", "Bitcoin", 0.15, 80000.0, ["BHS"])]

    def __init__(self, phone, pin, holdings=None, confirm_after: float = 1.0, drop_after: int | None = None,
                 no_ask: bool = False, needs_code: bool = False):
        import requests
        self.phone_no, self.pin = phone, pin
        self._websession = requests.Session()
        self.weblogin_needs_authenticator = needs_code
        self.confirm_after, self.drop_after, self.no_ask = confirm_after, drop_after, no_ask
        self.ended = False
        self.holdings = holdings or self.HOLDINGS
        self.subscriptions, self._previous_responses = {}, {}
        self._q: asyncio.Queue | None = None
        self._n = self._recvs = 0
        self._px = {h[0]: h[3] for h in self.holdings}

    def initiate_weblogin(self):
        return 60

    def complete_weblogin(self, code=None):
        if self.weblogin_needs_authenticator:
            if code != "123456":
                raise ValueError("Wrong code.")
        else:
            time.sleep(self.confirm_after)
        self._websession.cookies.set("tr_session", "demo", domain=".traderepublic.com")

    def settings(self):
        if self.ended:
            import requests
            r = requests.Response()
            r.status_code = 401
            raise requests.HTTPError("401 Unauthorized", response=r)
        return {"securitiesAccountNumber": "demo"}

    async def _queue(self):
        if self._q is None:
            self._q = asyncio.Queue()
        return self._q

    async def _sub(self, payload, reply=None):
        q = await self._queue()
        self._n += 1
        sid = str(self._n)
        self.subscriptions[sid] = payload
        if reply is not None:
            await q.put((sid, reply))
        return sid

    async def compact_portfolio(self):
        return await self._sub({"type": "compactPortfolioByType"}, {"categories": [{"categoryType": "stocks", "positions": [
            {"isin": h[0], "netSize": str(h[2]), "averageBuyIn": str(h[3])} for h in self.holdings]}]})

    async def instrument_details(self, isin):
        h = next(x for x in self.holdings if x[0] == isin)
        return await self._sub({"type": "instrument", "id": isin}, {"shortName": h[1], "exchangeIds": h[4]})

    async def ticker(self, isin, exchange="LSX"):
        return await self._sub({"type": "ticker", "id": f"{isin}.{exchange}"})

    async def unsubscribe(self, sid):
        self.subscriptions.pop(sid, None)

    async def recv(self):
        import random
        self._recvs += 1
        if self.drop_after and self._recvs > self.drop_after:
            self.drop_after = None
            raise ConnectionError("websocket closed")
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
        out = {"bid": {"price": round(p * 0.9995, 4)}, "last": {"price": round(p, 4), "time": int(time.time() * 1000)}}
        if not self.no_ask:
            out["ask"] = {"price": round(p * 1.0005, 4)}
        return sid, s, out

    async def close(self):
        self._q = None
