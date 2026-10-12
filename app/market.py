"""Market data: providers (Yahoo via yfinance, or a deterministic mock) and a caching quote engine
that computes period changes (1D..1Y), normalizes sub-unit currencies and converts to a base currency."""
from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, asdict
from datetime import date, timedelta

import numpy as np
import pandas as pd

log = logging.getLogger("stonks.market")

PERIODS = ("1D", "1W", "1M", "3M", "6M", "YTD", "1Y")
SUBUNITS = {"GBp": ("GBP", 100.0), "GBX": ("GBP", 100.0), "ZAc": ("ZAR", 100.0),
            "ILA": ("ILS", 100.0), "KWF": ("KWD", 1000.0)}


def normalize_currency(ccy: str | None) -> tuple[str, float]:
    """Return (major currency, divisor). GBp -> (GBP, 100)."""
    if not ccy:
        return "USD", 1.0
    if ccy in SUBUNITS:
        return SUBUNITS[ccy]
    return ccy.upper(), 1.0


def _ter(v) -> float | None:
    """Expense ratio as a fraction (0.0007). Yahoo sometimes reports it in percent (0.07)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or x <= 0:
        return None
    return x / 100 if x > 0.03 else x


def _clean_series(s: pd.Series) -> pd.Series:
    s = pd.to_numeric(s, errors="coerce").dropna()
    if s.empty:
        return s
    idx = pd.DatetimeIndex(s.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    s.index = idx.normalize()
    s = s[~s.index.duplicated(keep="last")].sort_index()
    return s.astype(float)


# --------------------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------------------
class YahooProvider:
    name = "yahoo"

    def __init__(self):
        import os
        import yfinance as yf  # imported lazily so tests can run without network
        cache = os.path.join(os.getenv("STONKS_DATA_DIR", "/data"), "yf-cache")
        try:
            os.makedirs(cache, exist_ok=True)
            yf.set_tz_cache_location(cache)
        except Exception as e:  # read-only FS etc. — yfinance still works without the tz cache
            log.info("yfinance cache disabled: %s", e)
        self.yf = yf

    def closes(self, symbols: list[str], start: date | None = None, period: str | None = None) -> dict[str, pd.Series]:
        if not symbols:
            return {}
        kw = dict(interval="1d", auto_adjust=False, group_by="ticker", threads=True,
                  progress=False, multi_level_index=True, timeout=20)
        if start is not None:
            kw["start"] = start.isoformat()
        else:
            kw["period"] = period or "5d"
        try:
            df = self.yf.download(list(symbols), **kw)
        except Exception as e:  # network / rate limit
            log.warning("download failed for %d symbols: %s", len(symbols), e)
            return {}
        out: dict[str, pd.Series] = {}
        if df is None or df.empty:
            return out
        for sym in symbols:
            try:
                if isinstance(df.columns, pd.MultiIndex):
                    lv0 = df.columns.get_level_values(0)
                    if sym in lv0:
                        sub = df[sym]
                    elif sym in df.columns.get_level_values(1):
                        sub = df.xs(sym, axis=1, level=1)
                    else:
                        continue
                    col = sub["Close"]
                else:
                    col = df["Close"]
                s = _clean_series(col)
                if not s.empty:
                    out[sym] = s
            except Exception as e:
                log.debug("parse %s failed: %s", sym, e)
        return out

    def info(self, symbol: str) -> dict:
        t = self.yf.Ticker(symbol)
        info: dict = {}
        try:
            info = t.get_info() or {}
        except Exception as e:
            log.info("info failed for %s: %s", symbol, e)
        meta = {
            "name": info.get("shortName") or info.get("longName") or symbol,
            "long_name": info.get("longName"),
            "currency": info.get("currency"),
            "quote_type": info.get("quoteType"),
            "sector": info.get("sector") or info.get("sectorDisp"),
            "industry": info.get("industry") or info.get("industryDisp"),
            "category": info.get("category") or info.get("fundFamily"),
            "exchange": info.get("fullExchangeName") or info.get("exchange"),
            "market_cap": info.get("marketCap") or info.get("totalAssets") or info.get("netAssets"),
            "country": info.get("country"),
            "ter": _ter(info.get("netExpenseRatio") or info.get("annualReportExpenseRatio")),
        }
        if not meta["currency"] or not meta["market_cap"]:
            try:
                fi = t.fast_info
                meta["currency"] = meta["currency"] or fi.get("currency")
                meta["market_cap"] = meta["market_cap"] or fi.get("marketCap")
                meta["quote_type"] = meta["quote_type"] or fi.get("quoteType")
            except Exception:
                pass
        if not meta["currency"]:
            # Without the currency we'd silently convert at the wrong FX rate: don't cache, retry later.
            raise LookupError(f"no metadata for {symbol}")
        return meta

    def analyst(self, symbol: str) -> dict:
        """Analyst consensus price target (stocks). {} when Yahoo has none."""
        t = self.yf.Ticker(symbol)
        info: dict = {}
        try:
            info = t.get_info() or {}
        except Exception as e:  # noqa: BLE001
            log.info("analyst info failed for %s: %s", symbol, e)
        out = {"mean": info.get("targetMeanPrice"), "median": info.get("targetMedianPrice"),
               "low": info.get("targetLowPrice"), "high": info.get("targetHighPrice"),
               "n": info.get("numberOfAnalystOpinions"), "rec": info.get("recommendationKey"),
               "rec_mean": info.get("recommendationMean"), "fwd_eps": info.get("forwardEps"),
               "fwd_pe": info.get("forwardPE"), "currency": info.get("currency")}
        if not out["mean"]:
            try:
                apt = t.analyst_price_targets or {}
                out.update(mean=apt.get("mean"), median=apt.get("median"), low=apt.get("low"), high=apt.get("high"))
            except Exception:  # noqa: BLE001
                pass
        return out if out["mean"] else {}

    def earnings(self, symbol: str) -> dict:
        """Next earnings date(s), estimates, recent reports and dividend dates. {} when Yahoo has none."""
        t = self.yf.Ticker(symbol)
        out: dict = {"next": [], "history": []}

        def iso(d):
            try:
                return pd.Timestamp(d).date().isoformat()
            except Exception:  # noqa: BLE001
                return None
        try:
            cal = t.calendar or {}
            ed = cal.get("Earnings Date") or []
            out["next"] = [x for x in (iso(d) for d in (ed if isinstance(ed, (list, tuple)) else [ed])) if x]
            out["eps_est"] = cal.get("Earnings Average")
            out["rev_est"] = cal.get("Revenue Average")
            out["ex_div"] = iso(cal["Ex-Dividend Date"]) if cal.get("Ex-Dividend Date") else None
            out["div_date"] = iso(cal["Dividend Date"]) if cal.get("Dividend Date") else None
        except Exception as e:  # noqa: BLE001
            log.info("calendar %s failed: %s", symbol, e)
        try:
            df = t.get_earnings_dates(limit=12)
            if df is not None and not df.empty:
                for d, row in df.iterrows():
                    def num(k):
                        v = row.get(k)
                        return None if v is None or pd.isna(v) else float(v)
                    out["history"].append({"date": iso(d), "eps_est": num("EPS Estimate"), "eps": num("Reported EPS"),
                                           "surprise": num("Surprise(%)")})
                future = sorted(h["date"] for h in out["history"] if h["eps"] is None and h["date"] >= date.today().isoformat())
                if future and not out["next"]:
                    out["next"] = future[:1]
                out["history"] = [h for h in out["history"] if h["eps"] is not None]
        except Exception as e:  # noqa: BLE001
            log.info("earnings dates %s failed: %s", symbol, e)
        return out if (out["next"] or out["history"]) else {}

    def fund(self, symbol: str) -> dict | None:
        """Top holdings, sector weights, asset classes and expense ratio of an ETF / mutual fund."""
        try:
            fd = self.yf.Ticker(symbol).funds_data
        except Exception as e:  # noqa: BLE001
            log.info("funds_data %s failed: %s", symbol, e)
            return None

        def get(attr):
            try:
                v = getattr(fd, attr)
                return v() if callable(v) else v
            except Exception as e:  # noqa: BLE001
                log.debug("funds_data %s.%s: %s", symbol, attr, e)
                return None

        out = {"holdings": [], "sectors": {}, "asset_classes": {}, "ter": None, "category": None}
        th = get("top_holdings")
        if th is not None and not getattr(th, "empty", True):
            for sym, row in th.iterrows():
                out["holdings"].append({"symbol": str(sym), "name": str(row.get("Name") or sym),
                                        "weight": float(row.get("Holding Percent") or 0)})
        out["sectors"] = {k: float(v) for k, v in (get("sector_weightings") or {}).items() if v is not None}
        out["asset_classes"] = {k: float(v) for k, v in (get("asset_classes") or {}).items() if v is not None}
        ops = get("fund_operations")
        try:
            if ops is not None and "Annual Report Expense Ratio" in ops.index:
                out["ter"] = _ter(ops.loc["Annual Report Expense Ratio"].iloc[0])
        except Exception:  # noqa: BLE001
            pass
        ov = get("fund_overview") or {}
        out["category"] = ov.get("categoryName")
        if not (out["holdings"] or out["sectors"] or out["ter"]):
            return None
        return out

    def search(self, query: str, limit: int = 10) -> list[dict]:
        try:
            s = self.yf.Search(query, max_results=limit, news_count=0, lists_count=0,
                               recommended=0, include_cb=False, raise_errors=False)
            quotes = s.quotes or []
        except Exception as e:
            log.info("search failed: %s", e)
            return []
        out = []
        for q in quotes:
            if not q.get("symbol"):
                continue
            out.append({
                "symbol": q["symbol"],
                "name": q.get("shortname") or q.get("longname") or q["symbol"],
                "exchange": q.get("exchDisp") or q.get("exchange"),
                "type": q.get("typeDisp") or q.get("quoteType"),
            })
        return out


class MockProvider:
    """Deterministic synthetic data so the app (and tests) run without network access."""
    name = "mock"

    SECTORS = {
        "Technology": "AAPL MSFT NVDA AVGO ORCL CRM AMD CSCO IBM INTU ADBE QCOM TXN NOW MU AMAT PLTR ASML.AS SAP.DE IDR.MC AMS.MC",
        "Communication Services": "GOOGL META NFLX DIS T VZ DTE.DE TEF.MC CLNX.MC",
        "Consumer Cyclical": "AMZN TSLA HD MCD MC.PA RMS.PA ITX.MC PUIG.MC UBER",
        "Financial Services": "BRK-B JPM V MA BAC WFC GS MS AXP ALV.DE SAN.MC BBVA.MC CABK.MC SAB.MC BKT.MC UNI.MC MAP.MC ISP.MI UCG.MI HSBA.L BNP.PA INGA.AS",
        "Healthcare": "LLY JNJ ABBV UNH MRK ABT TMO ISRG SAN.PA NOVO-B.CO ROG.SW NOVN.SW AZN.L GRF.MC ROVI.MC",
        "Consumer Defensive": "WMT COST PG KO PM PEP OR.PA NESN.SW ULVR.L",
        "Energy": "XOM CVX TTE.PA SHEL.L REP.MC",
        "Industrials": "GE CAT BA SIE.DE AIR.PA SU.PA RHM.DE ACS.MC AENA.MC FER.MC IAG.MC SCYR.MC LOG.MC",
        "Utilities": "NEE IBE.MC ENEL.MI ELE.MC NTGY.MC RED.MC ENG.MC ANA.MC ANE.MC SLR.MC",
        "Basic Materials": "LIN ACX.MC MTS.MC",
        "Real Estate": "COL.MC MRL.MC",
    }
    ETFS = set("VWCE.DE IWDA.AS EUNL.DE SXR8.DE CSPX.L VUSA.AS IS3N.DE XDWD.DE MEUD.PA EQQQ.DE "
               "SPY VOO QQQ VTI VT VXUS VNQ BND AGG TLT GLD IBCF.MU IBCF.DE URTH IEMG VGK EZU EWP EWJ EWU BNDW".split())
    NO_FUND_DATA = {"IBCF.MU"}   # simulates European listings Yahoo publishes no composition for

    def __init__(self):
        self._sector = {s: sec for sec, syms in self.SECTORS.items() for s in syms.split()}
        self.fail = set()  # symbols that should behave as unknown (for tests)

    @staticmethod
    def _seed(sym: str) -> int:
        return int(hashlib.sha256(sym.encode()).hexdigest()[:8], 16)

    def _quote_type(self, sym: str) -> str:
        if sym.startswith("^") or sym in ("FTSEMIB.MI", "PSI20.LS", "000001.SS", "DX-Y.NYB"):
            return "INDEX"
        if sym.endswith("-USD"):
            return "CRYPTOCURRENCY"
        if sym.endswith("=F"):
            return "FUTURE"
        if sym.endswith("=X"):
            return "CURRENCY"
        if sym in self.ETFS:
            return "ETF"
        if sym.startswith("0P"):
            return "MUTUALFUND"
        return "EQUITY"

    def _currency(self, sym: str) -> str:
        if sym.endswith("=X"):
            pair = sym[:-2]
            return pair[3:6] if len(pair) == 6 else "USD"
        for suf, c in ((".DE", "EUR"), (".MU", "EUR"), (".AS", "EUR"), (".PA", "EUR"), (".MC", "EUR"), (".MI", "EUR"),
                       (".LS", "EUR"), (".L", "GBp"), (".SW", "CHF"), (".CO", "DKK"), (".SS", "CNY"),
                       (".HK", "HKD"), (".T", "JPY")):
            if sym.endswith(suf):
                return c
        return "USD"

    _FX = {"EURUSD": 1.09, "GBPUSD": 1.27, "CHFUSD": 1.13, "DKKUSD": 0.146, "JPYUSD": 0.0067,
           "CNYUSD": 0.138, "HKDUSD": 0.128, "ZARUSD": 0.055}

    def _base_level(self, sym: str) -> float:
        if sym.endswith("=X"):
            pair = sym[:-2]
            a, b = pair[:3], pair[3:6]
            usd = lambda c: 1.0 if c == "USD" else self._FX.get(f"{c}USD", 1.0)  # noqa: E731
            return usd(a) / usd(b)
        r = np.random.default_rng(self._seed(sym))
        qt = self._quote_type(sym)
        if qt == "INDEX":
            return float(r.uniform(800, 40000))
        if qt == "CRYPTOCURRENCY":
            return float(r.choice([0.2, 1.5, 30, 150, 600, 3000, 60000]) * r.uniform(0.8, 1.3))
        lvl = float(np.exp(r.uniform(np.log(5), np.log(900))))
        return lvl * (100 if self._currency(sym) == "GBp" else 1)

    ALIAS = {"IBCF.DE": "IBCF.MU"}     # same fund on another exchange: same prices

    def _series(self, sym: str, start: date) -> pd.Series:
        sym = self.ALIAS.get(sym, sym)
        r = np.random.default_rng(self._seed(sym))
        end = date.today()
        days = pd.bdate_range(start=date(end.year - 6, 1, 1), end=end)
        if self._quote_type(sym) == "CRYPTOCURRENCY":
            days = pd.date_range(start=date(end.year - 6, 1, 1), end=end)
        qt = self._quote_type(sym)
        if sym.endswith("=X"):
            vol, drift = 0.004, 0.0
        elif qt == "CRYPTOCURRENCY":
            vol, drift = 0.035, r.uniform(-0.0005, 0.0015)
        elif qt in ("ETF", "INDEX", "MUTUALFUND"):
            vol, drift = r.uniform(0.006, 0.012), r.uniform(0.0001, 0.0004)
        else:
            vol, drift = r.uniform(0.010, 0.022), r.uniform(-0.0003, 0.0008)
        rets = r.normal(drift, vol, len(days))
        level = self._base_level(sym) * np.exp(np.cumsum(rets) - np.sum(rets))
        # intraday wobble on the last bar so auto-refresh visibly changes something
        minute = int(time.time() // 60)
        level[-1] *= float(np.exp(np.random.default_rng(self._seed(sym) ^ minute).normal(0, vol * 0.3)))
        s = pd.Series(level, index=days)
        return s[s.index >= pd.Timestamp(start)]

    SHORT_HISTORY = {"IBCF.MU": 3}   # simulates a listing Yahoo has only a few days of history for

    def closes(self, symbols, start=None, period=None):
        if start is None:
            start = date.today() - timedelta(days=8)
        out = {}
        for s in symbols:
            if s in self.fail:
                continue
            ser = self._series(s, start)
            if s in self.SHORT_HISTORY:
                full = self._series(s, date.today() - timedelta(days=30))
                ser = ser[ser.index >= full.index[-self.SHORT_HISTORY[s]]]
            out[s] = ser
        return out

    def info(self, symbol: str) -> dict:
        r = np.random.default_rng(self._seed(symbol) + 7)
        qt = self._quote_type(symbol)
        cap = None
        if qt == "EQUITY":
            cap = float(np.exp(r.uniform(np.log(1.5e10), np.log(3.5e12))))
        elif qt in ("ETF", "MUTUALFUND"):
            cap = float(np.exp(r.uniform(np.log(2e9), np.log(6e11))))
        elif qt == "CRYPTOCURRENCY":
            cap = float(np.exp(r.uniform(np.log(5e9), np.log(1.8e12))))
        return {
            "name": symbol.split(".")[0].replace("^", "") + (" Index" if qt == "INDEX" else " Corp" if qt == "EQUITY" else ""),
            "long_name": {"IBCF.MU": "iShsV-S&P500 EUR Hgd U.ETF AccR"}.get(symbol),
            "currency": self._currency(symbol),
            "quote_type": qt,
            "sector": self._sector.get(symbol) if qt == "EQUITY" else None,
            "industry": None,
            "category": "Global equity" if qt == "ETF" else None,
            "exchange": "MOCK",
            "market_cap": cap,
            "country": self._country(symbol) if qt == "EQUITY" else None,
            "ter": round(float(r.uniform(0.0007, 0.0025)), 5) if qt in ("ETF", "MUTUALFUND") else None,
        }

    def analyst(self, symbol: str) -> dict:
        if self._quote_type(symbol) != "EQUITY":
            return {}
        r = np.random.default_rng(self._seed(symbol) + 13)
        px = float(self._series(symbol, date.today() - timedelta(days=10)).iloc[-1])
        mean = px * r.uniform(0.95, 1.30)
        return {"mean": mean, "median": mean * r.uniform(0.97, 1.03), "low": mean * r.uniform(0.7, 0.9),
                "high": mean * r.uniform(1.1, 1.4), "n": int(r.integers(4, 40)),
                "rec": str(r.choice(["buy", "strong_buy", "hold"])), "rec_mean": round(float(r.uniform(1.5, 3)), 2),
                "fwd_eps": None, "fwd_pe": None, "currency": self._currency(symbol)}

    def earnings(self, symbol: str) -> dict:
        if self._quote_type(symbol) != "EQUITY":
            return {}
        r = np.random.default_rng(self._seed(symbol) + 17)
        today = date.today()
        nxt = today + timedelta(days=int(r.integers(1, 80)))
        hist = []
        for i in range(1, 9):
            d = nxt - timedelta(days=91 * i)
            est = float(r.uniform(0.5, 3))
            act = est * float(r.uniform(0.85, 1.2))
            hist.append({"date": d.isoformat(), "eps_est": round(est, 2), "eps": round(act, 2),
                         "surprise": round((act / est - 1) * 100, 2)})
        return {"next": [nxt.isoformat()], "eps_est": round(float(r.uniform(0.5, 3)), 2), "rev_est": None,
                "ex_div": None, "div_date": None, "history": hist}

    def _country(self, sym: str) -> str:
        for suf, c in ((".DE", "Germany"), (".AS", "Netherlands"), (".PA", "France"), (".MC", "Spain"),
                       (".MI", "Italy"), (".LS", "Portugal"), (".L", "United Kingdom"), (".SW", "Switzerland"),
                       (".CO", "Denmark")):
            if sym.endswith(suf):
                return c
        return "Taiwan" if sym == "TSM" else "United States"

    def fund(self, symbol: str) -> dict | None:
        if self._quote_type(symbol) not in ("ETF", "MUTUALFUND") or symbol in self.NO_FUND_DATA:
            return None
        from . import seeds
        r = np.random.default_rng(self._seed(symbol) + 11)
        names = {"AAPL": "Apple Inc", "MSFT": "Microsoft Corp", "NVDA": "NVIDIA Corp", "AMZN": "Amazon.com Inc",
                 "GOOGL": "Alphabet Inc Class A", "META": "Meta Platforms Inc Class A", "AVGO": "Broadcom Inc",
                 "TSLA": "Tesla Inc", "BRK-B": "Berkshire Hathaway Inc Class B", "JPM": "JPMorgan Chase & Co",
                 "LLY": "Eli Lilly and Co", "V": "Visa Inc Class A", "TSM": "Taiwan Semiconductor Manufacturing Co Ltd",
                 "ASML": "ASML Holding NV"}
        pool = list(names)
        picks = [pool[i] for i in r.choice(len(pool), size=10, replace=False)]
        w = np.sort(r.uniform(0.008, 0.06, size=10))[::-1]
        sectors = dict(zip(["technology", "financial_services", "healthcare", "consumer_cyclical", "industrials",
                            "communication_services", "consumer_defensive", "energy", "basic_materials",
                            "utilities", "realestate"], r.dirichlet(np.ones(11) * 2)))
        return {"holdings": [{"symbol": s, "name": names[s], "weight": float(x)} for s, x in zip(picks, w)],
                "sectors": {k: float(v) for k, v in sectors.items()},
                "asset_classes": {"stockPosition": 0.995, "cashPosition": 0.005},
                "ter": round(float(r.uniform(0.0007, 0.0025)), 5), "category": None}

    def search(self, query: str, limit: int = 10) -> list[dict]:
        from . import seeds
        pool = set(seeds.US_MEGACAPS + seeds.EUROPE_LEADERS + seeds.IBEX35 + seeds.CRYPTO)
        pool |= {s for s, *_ in seeds.WORLD_INDICES + seeds.INDEX_FUNDS_ETFS + seeds.MACRO}
        pool |= {"IBCF.MU", "IBCF.DE"}
        q = query.strip().upper()
        hits = sorted(s for s in pool if q in s)[:limit]
        return [{"symbol": s, "name": self.info(s)["name"], "exchange": "MOCK",
                 "type": self._quote_type(s)} for s in hits]


# --------------------------------------------------------------------------------------
# Quote engine
# --------------------------------------------------------------------------------------
@dataclass
class Quote:
    symbol: str
    ok: bool = False
    name: str | None = None
    currency: str = "USD"          # major unit (GBp normalized to GBP)
    price: float | None = None
    prev_close: float | None = None
    last_date: str | None = None
    changes: dict = field(default_factory=dict)   # period -> pct (e.g. -1.23)
    market_cap: float | None = None               # in `currency`
    quote_type: str | None = None
    sector: str | None = None
    industry: str | None = None
    category: str | None = None
    exchange: str | None = None
    spark: list = field(default_factory=list)     # last ~30 closes for tooltip sparkline

    def to_dict(self):
        return asdict(self)


def _ref_close(s: pd.Series, target: pd.Timestamp) -> float | None:
    sub = s[s.index <= target]
    if sub.empty:
        return None
    return float(sub.iloc[-1])


def compute_changes(s: pd.Series) -> tuple[float | None, float | None, dict, str | None]:
    """Return (last, prev_close, changes{period: pct}, last_date) from a daily close series."""
    if s is None or s.empty:
        return None, None, {}, None
    last_ts = s.index[-1]
    last = float(s.iloc[-1])
    prev = float(s.iloc[-2]) if len(s) >= 2 else None
    targets = {
        "1W": last_ts - pd.Timedelta(days=7),
        "1M": last_ts - pd.DateOffset(months=1),
        "3M": last_ts - pd.DateOffset(months=3),
        "6M": last_ts - pd.DateOffset(months=6),
        "YTD": pd.Timestamp(year=last_ts.year - 1, month=12, day=31),
        "1Y": last_ts - pd.DateOffset(years=1),
    }
    ch = {"1D": (last / prev - 1) * 100 if prev else None}
    for p, t in targets.items():
        ref = _ref_close(s, t)
        ch[p] = (last / ref - 1) * 100 if ref else None
    ch = {k: (None if v is None or not math.isfinite(v) else round(v, 4)) for k, v in ch.items()}
    return last, prev, ch, last_ts.date().isoformat()


class QuoteEngine:
    def __init__(self, provider, db, recent_ttl: float = 60, history_ttl: float = 6 * 3600,
                 meta_ttl: float = 24 * 3600, workers: int = 8):
        self.p = provider
        self.db = db
        self.recent_ttl = recent_ttl
        self.history_ttl = history_ttl
        self.meta_ttl = meta_ttl
        self.workers = workers
        self._recent: dict[str, tuple[float, pd.Series]] = {}
        self._hist: dict[str, tuple[float, pd.Series]] = {}
        self._full: dict[str, tuple[float, date, pd.Series]] = {}   # long history since an arbitrary start
        self._miss: dict[str, float] = {}   # negative cache for symbols with no data
        self._meta_miss: dict[str, float] = {}
        self.meta_retry = 600.0
        self._lock = threading.Lock()
        self.last_update: float | None = None

    # ---- raw series with TTL caches ----
    def _fetch(self, cache: dict, symbols: list[str], ttl: float, **kw) -> None:
        now = time.time()
        stale = [s for s in symbols
                 if (s not in cache or now - cache[s][0] > ttl)
                 and not (s in self._miss and now - self._miss[s] < ttl)]
        if not stale:
            return
        for i in range(0, len(stale), 80):
            chunk = stale[i:i + 80]
            data = self.p.closes(chunk, **kw)
            for s in chunk:
                if s in data:
                    cache[s] = (now, data[s])
                    self._miss.pop(s, None)
                elif s not in cache:
                    self._miss[s] = now

    def series(self, symbols: list[str]) -> dict[str, pd.Series]:
        symbols = list(dict.fromkeys(symbols))
        with self._lock:
            self._fetch(self._hist, symbols, self.history_ttl, start=date.today() - timedelta(days=400))
            self._fetch(self._recent, symbols, self.recent_ttl, period="5d")
            self.last_update = time.time()
            out = {}
            for s in symbols:
                parts = [c[1] for c in (self._hist.get(s), self._recent.get(s)) if c is not None]
                if not parts:
                    continue
                merged = pd.concat(parts)
                merged = merged[~merged.index.duplicated(keep="last")].sort_index()
                out[s] = merged
            return out

    def history(self, symbols: list[str], start: date) -> dict[str, pd.Series]:
        """Daily closes since `start` in MAJOR currency units (GBp → GBP), merged with the latest bar."""
        symbols = [s for s in dict.fromkeys(symbols) if s]
        now = time.time()
        with self._lock:
            need = [s for s in symbols
                    if not (s in self._full and self._full[s][1] <= start and now - self._full[s][0] < self.history_ttl)
                    and not (s in self._miss and now - self._miss[s] < self.recent_ttl)]
            for i in range(0, len(need), 80):
                chunk = need[i:i + 80]
                data = self.p.closes(chunk, start=start - timedelta(days=10))
                for s in chunk:
                    if s in data:
                        self._full[s] = (now, start, data[s])
                    else:
                        self._miss[s] = now
        meta = self.meta(symbols)
        out = {}
        for s in symbols:
            hit = self._full.get(s)
            if not hit:
                continue
            parts = [hit[2]] + ([self._recent[s][1]] if s in self._recent else [])
            ser = pd.concat(parts)
            ser = ser[~ser.index.duplicated(keep="last")].sort_index()
            _, div = normalize_currency((meta.get(s) or {}).get("currency"))
            out[s] = ser / div
        return out

    def funds(self, symbols: list[str], ttl: float = 7 * 86400) -> dict[str, dict]:
        """Fund composition (cached a week in SQLite)."""
        symbols = list(dict.fromkeys(symbols))
        keys = {s: f"fund:{s}" for s in symbols}
        have_raw = self.db.get_meta(list(keys.values()), ttl)
        have = {s: have_raw[k] for s, k in keys.items() if k in have_raw}
        now = time.time()
        missing = [s for s in symbols if s not in have and now - self._meta_miss.get(keys[s], 0) > self.meta_retry]
        if missing and hasattr(self.p, "fund"):
            def fetch(s):
                try:
                    return s, self.p.fund(s)
                except Exception as e:  # noqa: BLE001
                    log.info("fund %s failed: %s", s, e)
                    return s, None
            with ThreadPoolExecutor(max_workers=min(self.workers, 4)) as ex:
                for s, f in ex.map(fetch, missing):
                    if f:
                        self.db.put_meta(keys[s], f)
                        have[s] = f
                    else:
                        self._meta_miss[keys[s]] = time.time()
        stale = [s for s in symbols if s not in have]
        if stale:
            old = self.db.get_meta([keys[s] for s in stale], max_age=10 * 365 * 86400)
            have.update({s: old[keys[s]] for s in stale if keys[s] in old})
        return have

    def analyst(self, symbols: list[str], ttl: float = 86400) -> dict[str, dict]:
        """Analyst consensus targets in major currency units (cached a day; 'none' answers are cached too)."""
        symbols = list(dict.fromkeys(symbols))
        keys = {s: f"analyst:{s}" for s in symbols}
        raw = self.db.get_meta(list(keys.values()), ttl)
        have = {s: raw[k] for s, k in keys.items() if k in raw}
        now = time.time()
        missing = [s for s in symbols if s not in have and now - self._meta_miss.get(keys[s], 0) > self.meta_retry]
        if missing and hasattr(self.p, "analyst"):
            def fetch(s):
                try:
                    return s, self.p.analyst(s)
                except Exception as e:  # noqa: BLE001
                    log.info("analyst %s failed: %s", s, e)
                    return s, None
            with ThreadPoolExecutor(max_workers=min(self.workers, 4)) as ex:
                for s, a in ex.map(fetch, missing):
                    if a is None:
                        self._meta_miss[keys[s]] = time.time()
                        continue
                    self.db.put_meta(keys[s], a)
                    have[s] = a
        meta = self.meta(symbols)
        out = {}
        for s, a in have.items():
            if not a or not a.get("mean"):
                continue
            _, div = normalize_currency(a.get("currency") or (meta.get(s) or {}).get("currency"))
            out[s] = {k: (v / div if k in ("mean", "median", "low", "high") and v else v) for k, v in a.items()}
        return out

    def earnings(self, symbols: list[str], ttl: float = 12 * 3600) -> dict[str, dict]:
        """Earnings calendar per stock (cached 12 h; empty answers too)."""
        symbols = list(dict.fromkeys(symbols))
        keys = {s: f"earn:{s}" for s in symbols}
        raw = self.db.get_meta(list(keys.values()), ttl)
        have = {s: raw[k] for s, k in keys.items() if k in raw}
        now = time.time()
        missing = [s for s in symbols if s not in have and now - self._meta_miss.get(keys[s], 0) > self.meta_retry]
        if missing and hasattr(self.p, "earnings"):
            def fetch(s):
                try:
                    return s, self.p.earnings(s)
                except Exception as e:  # noqa: BLE001
                    log.info("earnings %s failed: %s", s, e)
                    return s, None
            with ThreadPoolExecutor(max_workers=min(self.workers, 4)) as ex:
                for s, e_ in ex.map(fetch, missing):
                    if e_ is None:
                        self._meta_miss[keys[s]] = time.time()
                        continue
                    self.db.put_meta(keys[s], e_)
                    have[s] = e_
        stale = [s for s in symbols if s not in have]
        if stale:
            old = self.db.get_meta([keys[s] for s in stale], max_age=30 * 86400)
            have.update({s: old[keys[s]] for s in stale if keys[s] in old})
        return have

    # ---- metadata ----
    def meta(self, symbols: list[str]) -> dict[str, dict]:
        symbols = list(dict.fromkeys(symbols))
        have = self.db.get_meta(symbols, self.meta_ttl)
        # entries cached by an older version (no "country"/"ter" fields) are refreshed once
        have = {s: m for s, m in have.items() if "country" in m}
        now = time.time()
        missing = [s for s in symbols if s not in have
                   and now - self._meta_miss.get(s, 0) > self.meta_retry]
        if missing:
            def fetch(s):
                try:
                    return s, self.p.info(s)
                except Exception as e:
                    log.info("meta %s failed: %s", s, e)
                    return s, None
            with ThreadPoolExecutor(max_workers=self.workers) as ex:
                for s, m in ex.map(fetch, missing):
                    if m:
                        self.db.put_meta(s, m)
                        have[s] = m
                        self._meta_miss.pop(s, None)
                    else:
                        self._meta_miss[s] = time.time()
        # stale cache beats nothing (e.g. Yahoo rate-limited us)
        still = [s for s in symbols if s not in have]
        if still:
            have.update(self.db.get_meta(still, max_age=10 * 365 * 86400))
        return have

    # ---- quotes ----
    def quotes(self, symbols: list[str]) -> dict[str, Quote]:
        symbols = [s for s in dict.fromkeys(symbols) if s]
        ser = self.series(symbols)
        meta = self.meta(symbols)
        out = {}
        for s in symbols:
            m = meta.get(s) or {}
            ccy, div = normalize_currency(m.get("currency"))
            q = Quote(symbol=s, name=m.get("name") or s, currency=ccy, quote_type=m.get("quote_type"),
                      sector=m.get("sector"), industry=m.get("industry"), category=m.get("category"),
                      exchange=m.get("exchange"))
            mc = m.get("market_cap")
            q.market_cap = float(mc) if mc else None
            series = ser.get(s)
            if series is not None and not series.empty:
                last, prev, ch, ld = compute_changes(series)
                q.ok = True
                q.price = last / div
                q.prev_close = prev / div if prev else None
                q.changes = ch
                q.last_date = ld
                q.spark = [round(float(v) / div, 6) for v in series.iloc[-30:].tolist()]
            out[s] = q
        return out

    # ---- FX ----
    def fx_rates(self, currencies: set[str], base: str) -> dict[str, float]:
        """Map currency -> multiplier to convert into `base`."""
        base = base.upper()
        rates = {base: 1.0}
        need = sorted(c for c in currencies if c and c != base)
        if not need:
            return rates
        pairs = {c: f"{c}{base}=X" for c in need}
        ser = self.series(list(pairs.values()))
        for c, pair in pairs.items():
            s = ser.get(pair)
            if s is not None and not s.empty:
                rates[c] = float(s.iloc[-1])
            elif c != "USD" and base != "USD":
                # try via USD cross
                via = self.series([f"{c}USD=X", f"USD{base}=X"])
                a, b = via.get(f"{c}USD=X"), via.get(f"USD{base}=X")
                if a is not None and b is not None and not a.empty and not b.empty:
                    rates[c] = float(a.iloc[-1]) * float(b.iloc[-1])
        return rates
