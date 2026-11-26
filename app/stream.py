"""Real-time prices: Yahoo's streaming feed (a WebSocket that pushes every trade price as it happens).

Settings → Live prices → "Real-time" turns it on. The worker tells the Streamer which tickers open pages are
showing; the Streamer keeps one WebSocket subscribed to exactly those, collects the latest price per ticker and
hands them over at most once a second (`on_ticks`), which the app pushes to the pages (SSE "ticks" events).
It reconnects by itself (2 s, 4 s … up to 60 s apart) and closes the socket when no page needs it.
Yahoo's prices are as real-time as on its website: most US and many European exchanges live, some delayed.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

log = logging.getLogger("stonks.stream")


class Streamer:
    def __init__(self, make_ws: Callable[[], object], on_ticks: Callable[[list[dict]], None], every: float = 1.0):
        self.make_ws = make_ws            # () -> object with subscribe(list), unsubscribe(list), listen(handler), close()
        self.on_ticks = on_ticks
        self.every = every
        self.want: set[str] = set()
        self.subscribed: set[str] = set()
        self.latest: dict[str, dict] = {}
        self._pending: dict[str, dict] = {}
        self._ws = None
        self._listener: threading.Thread | None = None
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.connected_at: float | None = None
        self.last_msg: float | None = None
        self.messages = 0
        self.per: dict[str, list] = {}        # symbol -> [messages, last message time]
        self.error: str | None = None

    # ---- control
    def start(self):
        if self._threads:
            return
        for fn, name in ((self._manage, "stonks-stream"), (self._flush, "stonks-stream-flush")):
            t = threading.Thread(target=fn, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self):
        self._stop.set()
        self._wake.set()
        self._close()

    def set_symbols(self, symbols) -> None:
        new = {s for s in symbols if s}
        with self._lock:
            if new == self.want:
                return
            self.want = new
        self._wake.set()

    def status(self) -> dict:
        with self._lock:
            per = {s: {"n": self.per[s][0], "last": self.per[s][1]} if s in self.per else {"n": 0, "last": None}
                   for s in sorted(self.want)}
        return {"symbols": sorted(self.want), "subscribed": len(self.subscribed), "connected": self._ws is not None,
                "connected_at": self.connected_at, "last_message": self.last_msg, "messages": self.messages,
                "error": self.error, "per_symbol": per, "now": time.time()}

    # ---- internals
    def _close(self):
        ws, self._ws = self._ws, None
        self.subscribed = set()
        self.connected_at = None
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

    def _manage(self):
        backoff = 2.0
        while not self._stop.is_set():
            with self._lock:
                want = set(self.want)
            if not want:
                self._close()
                self._wake.wait(5)
                self._wake.clear()
                continue
            if self._ws is not None and (self._listener is None or not self._listener.is_alive()):
                self._close()                                     # the feed dropped: reconnect
            if self._ws is None:
                try:
                    ws = self.make_ws()
                    ws.subscribe(sorted(want))
                    self._ws, self.subscribed, self.connected_at, self.error = ws, set(want), time.time(), None
                    self._listener = threading.Thread(target=self._listen, args=(ws,), name="stonks-stream-recv", daemon=True)
                    self._listener.start()
                    log.info("real-time feed connected (%d tickers)", len(want))
                    backoff = 2.0
                except Exception as e:  # noqa: BLE001
                    self.error = f"{type(e).__name__}: {e}"[:200]
                    log.warning("real-time feed: %s (retry in %.0fs)", self.error, backoff)
                    self._close()
                    self._wake.wait(backoff)
                    self._wake.clear()
                    backoff = min(60.0, backoff * 2)
                    continue
            else:
                add, rem = want - self.subscribed, self.subscribed - want
                try:
                    if add:
                        self._ws.subscribe(sorted(add))
                    if rem:
                        self._ws.unsubscribe(sorted(rem))
                    self.subscribed = set(want)
                except Exception as e:  # noqa: BLE001
                    self.error = f"{type(e).__name__}: {e}"[:200]
                    self._close()
                    continue
            self._wake.wait(5)
            self._wake.clear()

    def _listen(self, ws):
        try:
            ws.listen(self._on_message)
        except Exception as e:  # noqa: BLE001
            if self._ws is ws:
                self.error = f"{type(e).__name__}: {e}"[:200]
                log.info("real-time feed stopped: %s", self.error)
        finally:
            self._wake.set()

    def _on_message(self, d: dict):
        sym, px = d.get("id"), d.get("price")
        if not sym or px is None:
            return
        try:
            t = int(d.get("time") or 0) or int(time.time() * 1000)
        except (TypeError, ValueError):
            t = int(time.time() * 1000)
        tick = {"s": sym, "p": float(px), "t": t, "chp": d.get("change_percent"), "dv": d.get("day_volume"),
                "mh": d.get("market_hours")}
        with self._lock:
            self._pending[sym] = tick
            self.latest[sym] = tick
            self.last_msg = time.time()
            self.messages += 1
            c = self.per.setdefault(sym, [0, None])
            c[0] += 1
            c[1] = self.last_msg

    def _flush(self):
        while not self._stop.wait(self.every):
            with self._lock:
                batch = list(self._pending.values())
                self._pending.clear()
            if batch:
                try:
                    self.on_ticks(batch)
                except Exception as e:  # noqa: BLE001
                    log.info("tick handler failed: %s", e)


class MockFeed:
    """Stand-in for Yahoo's WebSocket in demo mode: a small random walk per subscribed ticker, a few ticks a second."""

    def __init__(self, price_of: Callable[[str], float | None], rate: float = 0.4):
        self.price_of, self.rate = price_of, rate
        self.subs: set[str] = set()
        self.px: dict[str, float] = {}
        self.vol: dict[str, float] = {}
        self._closed = threading.Event()

    def subscribe(self, symbols):
        self.subs |= set(symbols)

    def unsubscribe(self, symbols):
        self.subs -= set(symbols)

    def close(self):
        self._closed.set()

    def listen(self, handler):
        import random
        while not self._closed.wait(self.rate):
            for s in list(self.subs):
                if s not in self.px:
                    p0 = self.price_of(s)
                    if not p0:
                        continue
                    self.px[s], self.vol[s] = p0, 100_000.0
                self.px[s] *= 1 + random.gauss(0, 0.0007)
                self.vol[s] += random.randint(10, 500)
                handler({"id": s, "price": round(self.px[s], 4), "time": str(int(time.time() * 1000)),
                         "day_volume": str(int(self.vol[s])), "market_hours": "REGULAR_MARKET"})
        raise ConnectionError("closed")
