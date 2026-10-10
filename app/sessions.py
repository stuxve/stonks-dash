"""World market sessions: open/close times, lunch breaks, holidays and early closes.

Exchange schedules come from `exchange_calendars` (holiday-aware, maintained per release).
FX, CME Globex futures and crypto use simple weekly rules (they ignore holidays).
All timestamps go to the browser as UTC epoch milliseconds; the UI does timezone display.
"""
from __future__ import annotations

import logging
import threading
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

log = logging.getLogger("stonks.sessions")

# code, name, city, region, index symbol
CATALOG = [
    ("XNYS", "NYSE / Nasdaq", "New York", "Americas", "^GSPC"),
    ("XTSE", "Toronto SE", "Toronto", "Americas", "^GSPTSE"),
    ("XMEX", "Bolsa Mexicana", "Mexico City", "Americas", "^MXX"),
    ("BVMF", "B3", "São Paulo", "Americas", "^BVSP"),
    ("XLON", "London SE", "London", "Europe", "^FTSE"),
    ("XETR", "Xetra", "Frankfurt", "Europe", "^GDAXI"),
    ("XPAR", "Euronext Paris", "Paris", "Europe", "^FCHI"),
    ("XAMS", "Euronext Amsterdam", "Amsterdam", "Europe", "^AEX"),
    ("XMAD", "BME", "Madrid", "Europe", "^IBEX"),
    ("XMIL", "Borsa Italiana", "Milan", "Europe", "FTSEMIB.MI"),
    ("XLIS", "Euronext Lisbon", "Lisbon", "Europe", "PSI20.LS"),
    ("XSWX", "SIX Swiss", "Zurich", "Europe", "^SSMI"),
    ("XSTO", "Nasdaq Stockholm", "Stockholm", "Europe", "^OMX"),
    ("XCSE", "Nasdaq Copenhagen", "Copenhagen", "Europe", "^OMXC25"),
    ("XOSL", "Oslo Børs", "Oslo", "Europe", "OSEBX.OL"),
    ("XHEL", "Nasdaq Helsinki", "Helsinki", "Europe", "^OMXH25"),
    ("XWAR", "Warsaw SE", "Warsaw", "Europe", "WIG20.WA"),
    ("XIST", "Borsa Istanbul", "Istanbul", "Europe", "XU100.IS"),
    ("XJSE", "Johannesburg SE", "Johannesburg", "Middle East & Africa", "^J203.JO"),
    ("XSAU", "Tadawul", "Riyadh", "Middle East & Africa", "^TASI.SR"),
    ("XTKS", "Tokyo SE", "Tokyo", "Asia-Pacific", "^N225"),
    ("XHKG", "HKEX", "Hong Kong", "Asia-Pacific", "^HSI"),
    ("XSHG", "Shanghai SE", "Shanghai", "Asia-Pacific", "000001.SS"),
    ("XKRX", "Korea Exchange", "Seoul", "Asia-Pacific", "^KS11"),
    ("XTAI", "Taiwan SE", "Taipei", "Asia-Pacific", "^TWII"),
    ("XBOM", "BSE / NSE", "Mumbai", "Asia-Pacific", "^NSEI"),
    ("XSES", "Singapore Exchange", "Singapore", "Asia-Pacific", "^STI"),
    ("XASX", "ASX", "Sydney", "Asia-Pacific", "^AXJO"),
    ("XNZE", "NZX", "Wellington", "Asia-Pacific", "^NZ50"),
    ("FX", "FX spot", "Global (NY close)", "24h markets", "EURUSD=X"),
    ("CME", "CME Globex futures", "Chicago", "24h markets", "ES=F"),
    ("CRYPTO", "Crypto", "Everywhere", "24h markets", "BTC-USD"),
]
CATALOG_BY_CODE = {c[0]: c for c in CATALOG}

DEFAULT_EXCHANGES = ["XNYS", "XTSE", "BVMF", "XLON", "XETR", "XPAR", "XMAD", "XMIL", "XSWX",
                     "XTKS", "XHKG", "XSHG", "XKRX", "XBOM", "XASX", "FX", "CME", "CRYPTO"]

NY = ZoneInfo("America/New_York")


def _ms(ts) -> int | None:
    if ts is None or pd.isna(ts):
        return None
    return int(pd.Timestamp(ts).timestamp() * 1000)


class SessionService:
    def __init__(self, back_days: int = 3, fwd_days: int = 21):
        self.back = back_days
        self.fwd = fwd_days
        self._cals: dict[str, tuple[date, object]] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ calendars
    def _calendar(self, code: str, today: date):
        import exchange_calendars as xc
        from exchange_calendars.calendar_utils import _default_calendar_factories as factories
        with self._lock:
            hit = self._cals.get(code)
            if hit and hit[0] == today:
                return hit[1]
            cls = factories[code]
            start = pd.Timestamp(today - timedelta(days=self.back + 7))
            end = pd.Timestamp(today + timedelta(days=self.fwd + 7))
            bound = cls.bound_max() if hasattr(cls, "bound_max") else None
            stale = False
            if bound is not None and end > bound:
                end = pd.Timestamp(bound)
                stale = end < pd.Timestamp(today + timedelta(days=7))
            if end <= start:
                cal = None
            else:
                cal = xc.get_calendar(code, start=start, end=end)
                cal._stonks_stale = stale  # noqa: SLF001 - our own annotation
            self._cals[code] = (today, cal)
            return cal

    # ------------------------------------------------------------------ builders
    def _exchange(self, code: str, now: datetime) -> dict:
        cal = self._calendar(code, now.date())
        lo = pd.Timestamp(now - timedelta(days=self.back))
        hi = pd.Timestamp(now + timedelta(days=self.fwd))
        out = {"sessions": [], "ext": [], "holidays": [], "early": [], "stale": True, "tz": None}
        if cal is None:
            return out
        tz = ZoneInfo(str(cal.tz))
        out["tz"] = str(cal.tz)
        out["stale"] = bool(getattr(cal, "_stonks_stale", False))
        sched = cal.schedule
        sched = sched[(sched["close"] >= lo) & (sched["open"] <= hi)]
        closes_local = [c.tz_convert(tz).time() for c in sched["close"]]
        regular_close = Counter(closes_local).most_common(1)[0][0] if closes_local else None
        for (day, row), cl in zip(sched.iterrows(), closes_local):
            early = regular_close is not None and cl < regular_close
            out["sessions"].append({"o": _ms(row["open"]), "c": _ms(row["close"]),
                                    "bs": _ms(row.get("break_start")), "be": _ms(row.get("break_end")),
                                    "early": early})
            if early:
                out["early"].append({"date": day.date().isoformat(), "close": _ms(row["close"])})
            if code == "XNYS":  # US extended hours: 04:00 pre-market, 4h after-hours
                pre = datetime.combine(day.date(), time(4, 0), NY)
                out["ext"].append({"s": int(pre.timestamp() * 1000), "e": _ms(row["open"]), "k": "pre"})
                out["ext"].append({"s": _ms(row["close"]), "e": _ms(row["close"]) + 4 * 3600_000, "k": "post"})
        # holidays: weekdays inside the calendar range without a session
        names: dict[date, str] = {}
        try:
            if cal.regular_holidays is not None:
                ser = cal.regular_holidays.holidays(lo.normalize().tz_localize(None),
                                                    hi.normalize().tz_localize(None), return_name=True)
                names = {d.date(): str(n) for d, n in ser.items()}
        except Exception as e:  # holiday naming is best-effort
            log.debug("holiday names %s: %s", code, e)
        session_days = {d.date() for d in cal.schedule.index}
        last_day = cal.schedule.index[-1].date() if len(cal.schedule) else lo.date()
        d = lo.date()
        while d <= min(hi.date(), last_day):
            if d not in session_days and _is_weekday(cal, d):
                out["holidays"].append({"date": d.isoformat(), "name": names.get(d, "Holiday")})
            d += timedelta(days=1)
        return out

    @staticmethod
    def _weekly(now: datetime, kind: str, back: int, fwd: int) -> dict:
        """FX: Sun 17:00 → Fri 17:00 New York. CME Globex: Sun–Thu 18:00 → next day 17:00 New York."""
        sessions = []
        start = (now - timedelta(days=back + 7)).astimezone(NY).date()
        end = (now + timedelta(days=fwd)).astimezone(NY).date()
        d = start
        while d <= end:
            wd = d.weekday()  # Mon=0 … Sun=6
            if kind == "FX" and wd == 6:
                o = datetime.combine(d, time(17, 0), NY)
                c = datetime.combine(d + timedelta(days=5), time(17, 0), NY)
                sessions.append({"o": int(o.timestamp() * 1000), "c": int(c.timestamp() * 1000),
                                 "bs": None, "be": None, "early": False})
            if kind == "CME" and wd in (6, 0, 1, 2, 3):
                o = datetime.combine(d, time(18, 0), NY)
                c = datetime.combine(d + timedelta(days=1), time(17, 0), NY)
                sessions.append({"o": int(o.timestamp() * 1000), "c": int(c.timestamp() * 1000),
                                 "bs": None, "be": None, "early": False})
            d += timedelta(days=1)
        return {"sessions": sessions, "ext": [], "holidays": [], "early": [], "stale": False,
                "tz": "America/New_York"}

    def build(self, codes: list[str], now: datetime | None = None) -> list[dict]:
        now = now or datetime.now(timezone.utc)
        out = []
        for code in codes:
            meta = CATALOG_BY_CODE.get(code)
            if not meta:
                continue
            _, name, city, region, index = meta
            try:
                if code in ("FX", "CME"):
                    data = self._weekly(now, code, self.back, self.fwd)
                elif code == "CRYPTO":
                    data = {"sessions": [], "ext": [], "holidays": [], "early": [], "stale": False,
                            "tz": "UTC", "always_open": True}
                else:
                    data = self._exchange(code, now)
            except Exception as e:
                log.warning("sessions for %s failed: %s", code, e)
                data = {"sessions": [], "ext": [], "holidays": [], "early": [], "stale": True, "tz": None,
                        "error": str(e)}
            out.append({"code": code, "name": name, "city": city, "region": region, "index": index,
                        **data})
        return out


def _is_weekday(cal, d: date) -> bool:
    """True when `d` is a normal trading weekday for this calendar (handles Fri/Sat-style weekmasks)."""
    mask = getattr(cal, "weekmask", "1111100")
    if len(mask) == 7 and set(mask) <= {"0", "1"}:
        return mask[d.weekday()] == "1"
    days = mask.split()
    return d.strftime("%a") in days
