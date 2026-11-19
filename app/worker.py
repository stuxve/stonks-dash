"""Background worker: keeps the dashboard's data fresh on the Pi whether or not a browser is open.

* Snapshots — one shared cache of computed results (portfolio, sell-target levels, Highs & lows, heatmaps…).
  The worker fills it on a schedule; the API serves from it while it's fresh. The web page and the Telegram
  alerts therefore read the *same* numbers. Any change made through the API (a buy, a setting…) clears it.
* Worker     — a scheduler thread that runs each job at its own interval: short while markets are busy
  (weekdays 08:00–22:30 local time, which covers European and US sessions, or always when you hold crypto),
  longer otherwise. Jobs run on a small thread pool, so one slow Yahoo call can't stop the others; a job that
  runs much longer than expected is reported as stuck in /api/worker.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable
from zoneinfo import ZoneInfo

log = logging.getLogger("stonks.worker")

TZ = ZoneInfo(os.getenv("TZ") or "Europe/Madrid")
BUSY_FROM, BUSY_TO = (8, 0), (22, 30)


def local_now() -> datetime:
    return datetime.now(TZ)


def in_busy_window(now: datetime | None = None) -> bool:
    now = now or local_now()
    return now.weekday() < 5 and BUSY_FROM <= (now.hour, now.minute) < BUSY_TO


class Snapshots:
    """Thread-safe {key: (time, value)} cache of computed API results."""

    def __init__(self):
        self._d: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()
        self.cleared_at = 0.0

    def get(self, key: str, max_age: float):
        with self._lock:
            hit = self._d.get(key)
        if hit and time.time() - hit[0] <= max_age:
            return hit[1]
        return None

    def age(self, key: str) -> float | None:
        with self._lock:
            hit = self._d.get(key)
        return time.time() - hit[0] if hit else None

    def put(self, key: str, value, started: float | None = None):
        """`started`: when the computation began. A result that began before the last clear() is not stored,
        so a refresh that was running while you edited a buy can't put the old numbers back."""
        with self._lock:
            if started is not None and started < self.cleared_at:
                return value
            self._d[key] = (time.time(), value)
        return value

    def get_or(self, key: str, max_age: float, fn: Callable):
        hit = self.get(key, max_age)
        if hit is not None:
            return hit
        t0 = time.time()
        return self.put(key, fn(), started=t0)

    def refresh(self, key: str, fn: Callable):
        t0 = time.time()
        return self.put(key, fn(), started=t0)

    def clear(self):
        with self._lock:
            self._d.clear()
            self.cleared_at = time.time()


@dataclass
class Job:
    name: str
    label: str
    fn: Callable[[], object]
    busy_s: Callable[[], float] | float          # interval while markets are busy
    idle_s: Callable[[], float] | float          # interval otherwise
    enabled: Callable[[], bool] = lambda: True
    delay_s: float = 0                           # first run after start-up
    # state
    next_at: float = 0
    running_since: float | None = None
    last_start: float | None = None
    last_end: float | None = None
    last_ok: float | None = None
    last_error: str | None = None
    last_duration: float | None = None
    runs: int = 0
    errors: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def interval(self, busy: bool) -> float:
        v = self.busy_s if busy else self.idle_s
        return float(v() if callable(v) else v)


class Worker:
    def __init__(self, jobs: list[Job], busy: Callable[[], bool] = in_busy_window, threads: int = 3):
        self.jobs = {j.name: j for j in jobs}
        self.busy = busy
        self.started_at: float | None = None
        self._pool = ThreadPoolExecutor(max_workers=threads, thread_name_prefix="stonks-job")
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if self._thread:
            return
        self.started_at = time.time()
        for j in self.jobs.values():
            j.next_at = self.started_at + j.delay_s
        self._thread = threading.Thread(target=self._loop, name="stonks-scheduler", daemon=True)
        self._thread.start()
        log.info("background worker started: %s", ", ".join(self.jobs))

    def stop(self):
        self._stop.set()

    def _is_busy(self) -> bool:
        try:
            return bool(self.busy())
        except Exception:  # noqa: BLE001
            return in_busy_window()

    def _loop(self):
        while not self._stop.wait(5):
            busy = self._is_busy()
            now = time.time()
            for j in self.jobs.values():
                if j.running_since is None and now >= j.next_at:
                    try:
                        on = j.enabled()
                    except Exception:  # noqa: BLE001
                        on = True
                    if not on:
                        j.next_at = now + 60
                        continue
                    j.running_since = now
                    self._pool.submit(self._run, j, busy)

    def _run(self, j: Job, busy: bool):
        t0 = time.time()
        j.last_start = t0
        try:
            j.fn()
            j.last_ok = time.time()
            j.last_error = None
            log.debug("job %s ok in %.1fs", j.name, time.time() - t0)
        except Exception as e:  # noqa: BLE001
            j.errors += 1
            j.last_error = f"{type(e).__name__}: {e}"[:300]
            log.warning("job %s failed after %.1fs: %s", j.name, time.time() - t0, e)
        finally:
            j.runs += 1
            j.last_end = time.time()
            j.last_duration = j.last_end - t0
            # failed jobs retry sooner (but not in a tight loop)
            iv = j.interval(busy)
            j.next_at = j.last_end + (min(iv, 120) if j.last_error else iv)
            j.running_since = None

    def run_now(self, name: str | None = None) -> int:
        """Schedule a job (or every job) to run on the next tick."""
        n = 0
        for j in self.jobs.values():
            if name in (None, j.name) and j.running_since is None:
                j.next_at = 0
                n += 1
        return n

    def status(self) -> dict:
        now = time.time()
        busy = self._is_busy()
        out = []
        for j in self.jobs.values():
            iv = j.interval(busy)
            running = now - j.running_since if j.running_since else None
            out.append({
                "name": j.name, "label": j.label, "interval_s": iv, "enabled": _safe(j.enabled, True),
                "last_ok": j.last_ok, "last_start": j.last_start, "last_duration": j.last_duration,
                "last_error": j.last_error, "runs": j.runs, "errors": j.errors,
                "next_in": max(0.0, j.next_at - now) if j.running_since is None else None,
                "running_for": running,
                "stuck": bool(running and running > max(600, 3 * iv)),
                "late": bool(j.last_ok and now - j.last_ok > 3 * iv + 120),
            })
        return {"running": bool(self._thread and self._thread.is_alive()), "started_at": self.started_at,
                "busy": busy, "now": now, "jobs": out}


def _safe(fn, default):
    try:
        return bool(fn())
    except Exception:  # noqa: BLE001
        return default
