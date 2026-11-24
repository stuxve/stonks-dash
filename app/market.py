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

    def bars(self, symbols: list[str], start: date | None = None, period: str | None = None) -> dict[str, pd.DataFrame]:
        """Daily open, high, low, close (unadjusted) and volume."""
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
            log.warning("bars download failed for %d symbols: %s", len(symbols), e)
            return {}
        out: dict[str, pd.DataFrame] = {}
        if df is None or df.empty:
            return out
        for sym in symbols:
            try:
                if isinstance(df.columns, pd.MultiIndex):
                    if sym in df.columns.get_level_values(0):
                        sub = df[sym]
                    elif sym in df.columns.get_level_values(1):
                        sub = df.xs(sym, axis=1, level=1)
                    else:
                        continue
                else:
                    sub = df
                cols = {k: _clean_series(sub[c]) for k, c in (("open", "Open"), ("high", "High"), ("low", "Low"),
                                                               ("close", "Close"), ("volume", "Volume")) if c in sub}
                f = pd.DataFrame(cols).dropna(subset=["close"])
                if not f.empty:
                    out[sym] = f
            except Exception as e:
                log.debug("parse bars %s failed: %s", sym, e)
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

    FUND_KEYS = {"name": ("shortName", "longName"), "sector": ("sector", "sectorDisp"), "industry": ("industry",),
                 "country": ("country",), "currency": ("currency",), "quote_type": ("quoteType",),
                 "price": ("currentPrice", "regularMarketPrice"), "market_cap": ("marketCap",),
                 "pe": ("trailingPE",), "fpe": ("forwardPE",), "pb": ("priceToBook",), "ev_ebitda": ("enterpriseToEbitda",),
                 "roe": ("returnOnEquity",), "op_margin": ("operatingMargins",), "profit_margin": ("profitMargins",),
                 "de": ("debtToEquity",), "rev_g": ("revenueGrowth",), "eps_g": ("earningsGrowth",),
                 "div_rate": ("dividendRate",), "trail_yield": ("trailingAnnualDividendYield",), "payout": ("payoutRatio",),
                 "beta": ("beta",), "target": ("targetMeanPrice",), "n": ("numberOfAnalystOpinions",),
                 "rec": ("recommendationMean",), "rec_key": ("recommendationKey",), "hi52": ("fiftyTwoWeekHigh",)}

    def fundamentals(self, symbol: str) -> dict:
        """Valuation, quality, growth, dividend and analyst fields of a stock (for the Ideas screener)."""
        info = self.yf.Ticker(symbol).get_info() or {}
        if not info or not (info.get("quoteType") or info.get("shortName")):
            raise LookupError(f"no info for {symbol}")
        out = {}
        for k, srcs in self.FUND_KEYS.items():
            v = next((info.get(x) for x in srcs if info.get(x) not in (None, "", "Infinity")), None)
            out[k] = v
        # yield from the forward dividend rate when there is one (both in the quote currency), else the trailing one
        px = out.get("price")
        out["div_yield"] = (out["div_rate"] / px) if out.get("div_rate") and px else (out.get("trail_yield") or 0.0)
        if out["div_yield"] and out["div_yield"] > 0.3:      # bad data (e.g. a percent where a fraction is expected)
            out["div_yield"] = None
        return out

    VAL_KEYS = {"name": ("longName", "shortName"), "quote_type": ("quoteType",), "currency": ("currency",),
                "fin_ccy": ("financialCurrency",), "sector": ("sector",), "industry": ("industry",), "country": ("country",),
                "price": ("currentPrice", "regularMarketPrice", "navPrice"), "market_cap": ("marketCap", "totalAssets"),
                "pe": ("trailingPE",), "fpe": ("forwardPE",), "eps": ("trailingEps", "epsTrailingTwelveMonths"),
                "feps": ("forwardEps", "epsForward"), "peg": ("trailingPegRatio", "pegRatio"),
                "ps": ("priceToSalesTrailing12Months",), "pb": ("priceToBook",), "ev_ebitda": ("enterpriseToEbitda",),
                "ev_rev": ("enterpriseToRevenue",), "eps_g": ("earningsGrowth",), "eps_qg": ("earningsQuarterlyGrowth",),
                "rev_g": ("revenueGrowth",)}

    # statement rows: our key -> (statement, Yahoo field names in order of preference)
    FIN_ROWS = {"revenue": ("inc", ("TotalRevenue", "OperatingRevenue")), "gross": ("inc", ("GrossProfit",)),
                "operating": ("inc", ("OperatingIncome", "EBIT")), "net": ("inc", ("NetIncomeCommonStockholders", "NetIncome")),
                "eps": ("inc", ("DilutedEPS", "BasicEPS")), "ebitda": ("inc", ("EBITDA", "NormalizedEBITDA")),
                "rnd": ("inc", ("ResearchAndDevelopment",)), "shares": ("inc", ("DilutedAverageShares", "BasicAverageShares")),
                "ocf": ("cf", ("OperatingCashFlow",)), "capex": ("cf", ("CapitalExpenditure",)), "fcf": ("cf", ("FreeCashFlow",)),
                "cash": ("bs", ("CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents")),
                "debt": ("bs", ("TotalDebt",)), "equity": ("bs", ("StockholdersEquity",))}

    def financials(self, symbol: str) -> dict:
        """Last reported quarters and fiscal years: revenue, margins' inputs, profit, EPS, cash flow, cash and debt."""
        t = self.yf.Ticker(symbol)
        out = {"currency": None}
        try:
            out["currency"] = (t.get_info() or {}).get("financialCurrency")
        except Exception:  # noqa: BLE001
            pass
        for freq, key in (("quarterly", "quarterly"), ("yearly", "annual")):
            frames = {}
            for st, fn in (("inc", t.get_income_stmt), ("cf", t.get_cash_flow), ("bs", t.get_balance_sheet)):
                try:
                    frames[st] = fn(pretty=False, freq=freq)
                except Exception as e:  # noqa: BLE001
                    log.info("%s %s %s failed: %s", symbol, st, freq, e)
                    frames[st] = None
            inc = frames.get("inc")
            if inc is None or inc.empty:
                out[key] = None
                continue
            periods = sorted({pd.Timestamp(c) for df in frames.values() if df is not None and not df.empty for c in df.columns})
            periods = [p for p in periods if p in set(pd.Timestamp(c) for c in inc.columns)][-8:]
            rows = {}
            for k, (st, names) in self.FIN_ROWS.items():
                df = frames.get(st)
                if df is None or df.empty:
                    continue
                name = next((n for n in names if n in df.index and df.loc[n].notna().any()), None)
                if not name:
                    continue
                ser = df.loc[name]
                ser.index = [pd.Timestamp(c) for c in ser.index]
                rows[k] = [None if p not in ser.index or pd.isna(ser[p]) else float(ser[p]) for p in periods]
            out[key] = {"periods": [p.date().isoformat() for p in periods], "rows": rows}
        if not out.get("quarterly") and not out.get("annual"):
            raise LookupError(f"no statements for {symbol}")
        return out

    def valuation(self, symbol: str) -> dict:
        """Valuation ratios plus the quarterly reported EPS history (for a historical P/E). Fields Yahoo lacks are None."""
        t = self.yf.Ticker(symbol)
        info = t.get_info() or {}
        if not info or not (info.get("quoteType") or info.get("shortName")):
            raise LookupError(f"no info for {symbol}")
        out = {k: next((info.get(x) for x in srcs if info.get(x) not in (None, "", "Infinity")), None)
               for k, srcs in self.VAL_KEYS.items()}
        for k in ("pe", "fpe", "peg", "ps", "pb", "ev_ebitda", "ev_rev"):
            try:
                out[k] = float(out[k]) if out[k] is not None else None
            except (TypeError, ValueError):
                out[k] = None
        eps = []
        if out["quote_type"] == "EQUITY":
            try:
                df = t.get_earnings_dates(limit=48)
                col = next((c for c in (df.columns if df is not None else []) if "Reported" in str(c)), None)
                if col is not None:
                    for d, v in df[col].items():
                        if pd.notna(v):
                            eps.append([pd.Timestamp(d).date().isoformat(), float(v)])
            except Exception as e:  # noqa: BLE001 — history is optional
                log.info("earnings history %s failed: %s", symbol, e)
        out["eps_hist"] = sorted(eps)
        return out

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

    def extended(self, symbol: str) -> dict:
        """US extended hours from Yahoo's quote: market state (PRE, REGULAR, POST, CLOSED…), the regular-session
        price, and the pre-market / after-hours price with its time (epoch seconds). Raw listing units."""
        i = self.yf.Ticker(symbol).info or {}

        def ts(v):
            if v is None:
                return None
            try:
                return int(v.timestamp()) if hasattr(v, "timestamp") else int(v)
            except (TypeError, ValueError):
                return None

        def blk(k):
            px = i.get(f"{k}MarketPrice")
            return {"price": float(px), "time": ts(i.get(f"{k}MarketTime"))} if px else None
        return {"state": i.get("marketState"), "currency": i.get("currency"),
                "regular": {"price": i.get("regularMarketPrice"), "prev_close": i.get("regularMarketPreviousClose"),
                            "time": ts(i.get("regularMarketTime"))},
                "pre": blk("pre"), "post": blk("post")}

    def intraday(self, symbol: str, period: str, interval: str) -> pd.Series:
        """Closes of `interval` bars (5m, 30m, 60m…) over `period` (1d, 5d, 1mo), UTC timestamps, raw listing units."""
        df = self.yf.download(symbol, period=period, interval=interval, auto_adjust=False, progress=False,
                              prepost=False, multi_level_index=False, timeout=20)
        if df is None or df.empty:
            return pd.Series(dtype=float)
        col = df["Close"]
        if isinstance(col, pd.DataFrame):
            col = col.iloc[:, 0]
        s = pd.to_numeric(col, errors="coerce").dropna()
        idx = pd.DatetimeIndex(s.index)
        s.index = idx.tz_convert("UTC") if idx.tz is not None else idx.tz_localize("UTC")
        return s[~s.index.duplicated(keep="last")].sort_index().astype(float)

    def dividends(self, symbol: str) -> dict:
        """Past dividends per share (ex-date, amount in the listing's currency as Yahoo quotes it, e.g. GBp) and
        the next ex-dividend / payment date when Yahoo's calendar has them."""
        t = self.yf.Ticker(symbol)
        out: dict = {"history": [], "ex_div": None, "pay_date": None}
        try:
            d = t.dividends
            if d is not None and len(d):
                out["history"] = [[pd.Timestamp(i).date().isoformat(), float(v)] for i, v in d.items()
                                  if v is not None and not pd.isna(v) and float(v) > 0][-60:]
        except Exception as e:  # noqa: BLE001
            log.info("dividends %s failed: %s", symbol, e)
            raise
        try:
            cal = t.calendar or {}
            for k, dst in (("Ex-Dividend Date", "ex_div"), ("Dividend Date", "pay_date")):
                if cal.get(k):
                    out[dst] = pd.Timestamp(cal[k]).date().isoformat()
        except Exception as e:  # noqa: BLE001
            log.info("dividend calendar %s failed: %s", symbol, e)
        return out

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

    def bars(self, symbols, start=None, period=None):
        out = {}
        for sym, c in self.closes(symbols, start=start, period=period).items():
            r = np.random.default_rng(self._seed(sym) + 21)
            n = len(c)
            prev = c.shift(1).fillna(c)
            span = np.abs(r.normal(0, 0.006, n)) + 0.001
            hi = np.maximum(c, prev) * (1 + span * r.uniform(0.2, 1, n))
            lo = np.minimum(c, prev) * (1 - span * r.uniform(0.2, 1, n))
            op = prev * (1 + r.normal(0, 0.003, n))
            vol = np.exp(r.normal(np.log(1e6), 0.4, n)) * (1 + 20 * np.abs(c.pct_change().fillna(0)))
            out[sym] = pd.DataFrame({"open": op, "high": np.maximum(hi, op), "low": np.minimum(lo, op), "close": c,
                                     "volume": np.round(vol)})
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

    def fundamentals(self, symbol: str) -> dict:
        r = np.random.default_rng(self._seed(symbol) + 23)
        px = float(self._series(symbol, date.today() - timedelta(days=10)).iloc[-1])
        sec = self._sector.get(symbol) or str(r.choice(["Technology", "Financial Services", "Healthcare", "Industrials",
                                                        "Consumer Cyclical", "Utilities", "Energy"]))
        fin = sec == "Financial Services"
        y = float(r.choice([0, 0, r.uniform(0.005, 0.07)]))
        return {"name": symbol.split(".")[0] + " Corp", "sector": sec, "industry": None, "country": self._country(symbol),
                "currency": self._currency(symbol), "quote_type": self._quote_type(symbol), "price": px,
                "market_cap": float(np.exp(r.uniform(np.log(5e9), np.log(3e12)))),
                "pe": float(r.uniform(6, 45)), "fpe": float(r.uniform(5, 38)), "pb": float(r.uniform(0.6, 12)),
                "ev_ebitda": None if fin else float(r.uniform(4, 30)), "roe": float(r.uniform(-0.05, 0.45)),
                "op_margin": float(r.uniform(0.02, 0.45)), "profit_margin": float(r.uniform(0.01, 0.35)),
                "de": None if fin else float(r.uniform(0, 280)), "rev_g": float(r.uniform(-0.1, 0.35)),
                "eps_g": float(r.uniform(-0.4, 0.6)), "div_rate": px * y if y else None, "trail_yield": y,
                "div_yield": y, "payout": float(r.uniform(0.1, 1.2)) if y else None, "beta": float(r.uniform(0.4, 1.8)),
                "target": px * float(r.uniform(0.9, 1.4)), "n": int(r.integers(0, 40)), "rec": float(r.uniform(1.3, 3.2)),
                "rec_key": str(r.choice(["buy", "hold", "strong_buy"])), "hi52": px * float(r.uniform(1.0, 1.4))}

    def financials(self, symbol: str) -> dict:
        if self._quote_type(symbol) != "EQUITY":
            raise LookupError("no statements")
        r = np.random.default_rng(self._seed(symbol) + 41)
        today = date.today()
        q_end = date(today.year, ((today.month - 1) // 3) * 3 + 1, 1) - timedelta(days=1)       # end of last quarter
        def make(n, step_months, scale):
            ends, d = [], q_end
            for _ in range(n):
                ends.append(d)
                m = d.month - step_months
                y = d.year + (m - 1) // 12
                m = (m - 1) % 12 + 1
                d = date(y, m, 1) + timedelta(days=32)
                d = date(d.year, d.month, 1) - timedelta(days=1)
            ends = sorted(ends)
            rev0, g = float(r.uniform(5e9, 6e10)) * scale, float(r.uniform(-0.02, 0.06))
            gm, om, nm = float(r.uniform(0.35, 0.7)), float(r.uniform(0.12, 0.4)), 0.0
            rows = {k: [] for k in ("revenue", "gross", "operating", "net", "eps", "ebitda", "rnd", "shares", "ocf", "capex", "fcf", "cash", "debt", "equity")}
            shares = float(r.uniform(5e8, 7e9))
            for k in range(n):
                rev = rev0 * (1 + g) ** k * float(r.uniform(0.95, 1.06))
                gmk, omk = gm + float(r.normal(0, 0.015)), om + float(r.normal(0, 0.02))
                net = rev * omk * 0.8
                capex = -rev * float(r.uniform(0.04, 0.12))
                ocf = net * float(r.uniform(1.0, 1.5))
                rows["revenue"].append(rev); rows["gross"].append(rev * gmk); rows["operating"].append(rev * omk)
                rows["net"].append(net); rows["eps"].append(round(net / shares, 2)); rows["ebitda"].append(rev * (omk + 0.06))
                rows["rnd"].append(rev * 0.12); rows["shares"].append(shares); rows["ocf"].append(ocf); rows["capex"].append(capex)
                rows["fcf"].append(ocf + capex); rows["cash"].append(rev * float(r.uniform(0.5, 1.5))); rows["debt"].append(rev * float(r.uniform(0.3, 1.2)))
                rows["equity"].append(rev * float(r.uniform(2, 4)))
            return {"periods": [e.isoformat() for e in ends], "rows": rows}
        return {"currency": self._currency(symbol), "quarterly": make(6, 3, 1.0), "annual": make(4, 12, 4.0)}

    def long_financials(self, symbol: str) -> dict:
        """Stand-in for the SEC history: ~16 years of a cyclical business (revenue booms, profits swing into losses)."""
        if self._quote_type(symbol) != "EQUITY":
            raise LookupError("no filings")
        r = np.random.default_rng(self._seed(symbol) + 53)
        q_end = date(date.today().year, ((date.today().month - 1) // 3) * 3 + 1, 1) - timedelta(days=1)
        ends = []
        d = q_end
        for _ in range(64):
            ends.append(d)
            m0 = date(d.year, d.month, 1)
            d = (date(m0.year - (1 if m0.month <= 3 else 0), (m0.month - 4) % 12 + 1, 1) + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        ends.sort()
        rev, q = float(r.uniform(1e9, 6e9)), []
        for k, e in enumerate(ends):
            cyc = np.sin(k / 5.5) * 0.6 + float(r.normal(0, 0.05))
            rev *= 1 + 0.02 + 0.06 * cyc
            margin = 0.08 + 0.22 * cyc
            q.append([e.isoformat(), rev, rev * margin, rev * (margin + 0.04)])
        annual = []
        for k in range(3, len(q), 4):
            w = q[k - 3:k + 1]
            annual.append([w[-1][0], sum(x[1] for x in w), sum(x[2] for x in w), sum(x[3] for x in w)])
        return {"currency": self._currency(symbol), "name": symbol + " Corp", "annual": annual, "quarterly": q}

    MOCK_INDEX_PE = {"SPY": (27.0, 22.5), "VGK": (15.5, 13.8), "EWP": (12.0, 11.0), "QQQ": (34.0, 28.0), "URTH": (23.0, 19.5),
                     "VT": (21.0, 18.0), "IEMG": (14.0, 12.0), "EZU": (16.0, 14.0)}

    def valuation(self, symbol: str) -> dict:
        qt = self._quote_type(symbol)
        sym = self.ALIAS.get(symbol, symbol)
        out = {k: None for k in YahooProvider.VAL_KEYS}
        out.update(name=symbol.split(".")[0] + (" Corp" if qt == "EQUITY" else ""), quote_type=qt, currency=self._currency(symbol))
        if symbol in self.MOCK_INDEX_PE:
            out["pe"], out["fpe"] = self.MOCK_INDEX_PE[symbol]
        if qt != "EQUITY":
            out["eps_hist"] = []
            return out
        r = np.random.default_rng(self._seed(symbol) + 31)
        s = self._series(sym, date.today() - timedelta(days=3700))
        # quarterly EPS consistent with a P/E that wanders between ~12 and ~40
        pe, eps, d = float(r.uniform(15, 30)), [], date.today() - timedelta(days=int(r.integers(10, 80)))
        while d > s.index[0].date() + timedelta(days=30):
            px = float(s[s.index <= pd.Timestamp(d)].iloc[-1])
            pe = float(np.clip(pe * np.exp(r.normal(0, 0.08)), 12, 40))
            eps.append([d.isoformat(), round(px / pe / 4, 4)])
            d -= timedelta(days=91)
        eps.sort()
        ttm = sum(x[1] for x in eps[-4:])
        px = float(s.iloc[-1])
        out.update(price=px, sector=self._sector.get(symbol) or "Technology", industry=None, country=self._country(symbol),
                   market_cap=float(np.exp(r.uniform(np.log(5e9), np.log(3e12)))), eps=ttm, pe=px / ttm if ttm > 0 else None,
                   feps=ttm * float(r.uniform(0.95, 1.3)), ps=float(r.uniform(1, 15)), pb=float(r.uniform(0.8, 15)),
                   ev_ebitda=float(r.uniform(5, 35)), ev_rev=float(r.uniform(1, 14)), eps_g=float(r.uniform(-0.2, 0.5)),
                   rev_g=float(r.uniform(-0.05, 0.3)), fin_ccy=self._currency(symbol), eps_hist=eps)
        out["fpe"] = px / out["feps"] if out["feps"] else None
        out["peg"] = out["fpe"] / (out["eps_g"] * 100) if out["eps_g"] and out["eps_g"] > 0 else None
        return out

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

    def extended(self, symbol: str) -> dict:
        """Synthetic US pre-market / after-hours quotes that follow the New York clock."""
        ny = pd.Timestamp.now(tz="America/New_York")
        hm = ny.hour * 60 + ny.minute
        wk = ny.weekday() < 5
        state = ("PRE" if wk and 240 <= hm < 570 else "REGULAR" if wk and 570 <= hm < 960
                 else "POST" if wk and 960 <= hm < 1200 else "CLOSED")
        last = float(self._series(symbol, date.today() - timedelta(days=10)).iloc[-1])
        r = np.random.default_rng(self._seed(symbol) ^ int(time.time() // 300))
        now = int(time.time())
        ext = lambda: {"price": round(last * float(np.exp(r.normal(0, 0.009))), 4), "time": now - int(r.integers(0, 240))}  # noqa: E731
        return {"state": state, "currency": self._currency(symbol),
                "regular": {"price": last, "prev_close": last / 1.004, "time": now - 3600},
                "pre": ext() if state == "PRE" else None,
                "post": ext() if state in ("POST", "CLOSED") else None}

    def intraday(self, symbol: str, period: str, interval: str) -> pd.Series:
        """Synthetic intraday bars ending at the latest close: 09:00–17:30 Madrid sessions (24/7 for crypto)."""
        step = {"5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60}[interval]
        days = {"1d": 1, "5d": 5, "1mo": 22}[period]
        daily = self._series(symbol, date.today() - timedelta(days=60))
        crypto = self._quote_type(symbol) == "CRYPTOCURRENCY"
        sess = daily.index[-days:] if not crypto else pd.date_range(end=pd.Timestamp(date.today()), periods=days)
        r = np.random.default_rng(self._seed(symbol) + 99)
        now = pd.Timestamp.now(tz="Europe/Madrid")
        stamps, vals = [], []
        for d in sess:
            lo, hi = (pd.Timestamp(d).tz_localize("Europe/Madrid") + pd.Timedelta(hours=h) for h in ((0, 24) if crypto else (9, 17.5)))
            t = pd.date_range(lo, min(hi, now), freq=f"{step}min")
            if not len(t):
                continue
            prev = float(daily[daily.index < pd.Timestamp(d)].iloc[-1]) if (daily.index < pd.Timestamp(d)).any() else float(daily.iloc[0])
            close = float(daily.get(pd.Timestamp(d), daily.iloc[-1]))
            walk = np.cumsum(r.normal(0, 0.0025, len(t)))
            path = prev * np.exp(walk - walk[-1] * np.linspace(0, 1, len(t)) + np.log(close / prev) * np.linspace(0, 1, len(t)))
            stamps += list(t)
            vals += list(path)
        s = pd.Series(vals, index=pd.DatetimeIndex(stamps).tz_convert("UTC"), dtype=float)
        return s[~s.index.duplicated(keep="last")].sort_index()

    def dividends(self, symbol: str) -> dict:
        """Quarterly payers among stocks (about 60%), a few semi-annual European ones; ETFs here accumulate."""
        if self._quote_type(symbol) != "EQUITY":
            return {"history": [], "ex_div": None, "pay_date": None}
        r = np.random.default_rng(self._seed(symbol) + 23)
        if r.random() > 0.6:
            return {"history": [], "ex_div": None, "pay_date": None}
        per_year = 2 if "." in symbol and r.random() < 0.5 else 4
        gap = 365 // per_year
        today = date.today()
        nxt = today + timedelta(days=int(r.integers(2, gap)))
        amt = round(self._base_level(symbol) * float(r.uniform(0.004, 0.012)), 4)
        hist = []
        for i in range(1, 4 * per_year + 1):
            hist.append([(nxt - timedelta(days=gap * i)).isoformat(), round(amt * (1 - 0.015 * (i // per_year)), 4)])
        hist.sort()
        cur = self._currency(symbol)
        if cur == "GBp":
            hist = [[d, v * 100] for d, v in hist]
        return {"history": hist, "ex_div": nxt.isoformat() if r.random() < 0.7 else None,
                "pay_date": (nxt + timedelta(days=int(r.integers(10, 30)))).isoformat() if r.random() < 0.5 else None}

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
        self._bars: dict[str, tuple[float, date, pd.DataFrame]] = {}       # daily high / low / close
        self._bars_recent: dict[str, tuple[float, pd.DataFrame]] = {}
        self._bars_miss: dict[str, float] = {}
        self.sources: dict[str, str] = {}   # symbol -> another listing of the same instrument to take prices from
        self._meta_miss: dict[str, float] = {}
        self.meta_retry = 600.0
        self._lock = threading.Lock()
        self.last_update: float | None = None

    # ---- price source substitution (e.g. a Munich listing priced from Xetra) ----
    def set_sources(self, mapping: dict[str, str]) -> None:
        """Take prices for `symbol` from `mapping[symbol]` (same instrument, same currency). Meta (name, type)
        still comes from the symbol itself. Cached prices of symbols whose source changed are dropped."""
        mapping = {k: v for k, v in mapping.items() if k and v and k != v}
        with self._lock:
            changed = {k for k in set(mapping) | set(self.sources) if mapping.get(k) != self.sources.get(k)}
            for k in changed:
                for c in (self._hist, self._recent, self._full, self._miss, self._bars, self._bars_recent, self._bars_miss):
                    c.pop(k, None)
            self.sources = mapping

    def _pull(self, fn, symbols: list[str], **kw) -> dict:
        """Call a provider price method with each symbol replaced by its price source, keyed back by symbol."""
        src = {s: self.sources.get(s, s) for s in symbols}
        data = fn(list(dict.fromkeys(src.values())), **kw)
        return {s: data[v] for s, v in src.items() if v in data}

    def _stamp(self, now: float, first, start) -> float:
        """Cache time for a downloaded series. Yahoo sometimes answers a batch with only the last few days for one
        ticker; a series starting much later than asked is kept 10 minutes instead of hours, so it's retried soon
        (a ticker that really is new just gets re-checked every 10 minutes)."""
        try:
            short = start is not None and pd.Timestamp(first) > pd.Timestamp(start) + pd.Timedelta(days=30)
        except Exception:  # noqa: BLE001
            short = False
        return now - self.history_ttl + 600 if short else now

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
            data = self._pull(self.p.closes, chunk, **kw)
            for s in chunk:
                if s in data:
                    ser = data[s]
                    t = self._stamp(now, ser.index[0], kw.get("start")) if ttl == self.history_ttl and len(ser) else now
                    cache[s] = (t, ser)
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
                data = self._pull(self.p.closes, chunk, start=start - timedelta(days=10))
                for s in chunk:
                    if s in data:
                        ser = data[s]
                        self._full[s] = (self._stamp(now, ser.index[0], start) if len(ser) else now, start, ser)
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

    def bars(self, symbols: list[str], start: date) -> dict[str, pd.DataFrame]:
        """Daily open / high / low / close (MAJOR currency units) and volume since `start`. Long part cached like `history`;
        the last few days refresh every few minutes so today's high and low stay current."""
        symbols = [s for s in dict.fromkeys(symbols) if s]
        if not symbols or not hasattr(self.p, "bars"):
            return {}
        now = time.time()
        with self._lock:
            need = [s for s in symbols
                    if not (s in self._bars and self._bars[s][1] <= start and now - self._bars[s][0] < self.history_ttl)
                    and not (s in self._bars_miss and now - self._bars_miss[s] < self.history_ttl)]
            for i in range(0, len(need), 80):
                chunk = need[i:i + 80]
                data = self._pull(self.p.bars, chunk, start=start - timedelta(days=10))
                for s in chunk:
                    if s in data:
                        f = data[s]
                        self._bars[s] = (self._stamp(now, f.index[0], start) if len(f) else now, start, f)
                    else:
                        self._bars_miss[s] = now
            rec = [s for s in symbols if s in self._bars
                   and not (s in self._bars_recent and now - self._bars_recent[s][0] < max(self.recent_ttl, 300))]
            if rec:
                data = self._pull(self.p.bars, rec, period="5d")
                for s in rec:
                    if s in data:
                        self._bars_recent[s] = (now, data[s])
        meta = self.meta(symbols)
        out = {}
        for s in symbols:
            hit = self._bars.get(s)
            if not hit:
                continue
            parts = [hit[2]] + ([self._bars_recent[s][1]] if s in self._bars_recent else [])
            f = pd.concat(parts)
            f = f[~f.index.duplicated(keep="last")].sort_index()
            _, div = normalize_currency((meta.get(s) or {}).get("currency"))
            if div != 1:
                f = f.copy()
                px = [c for c in ("open", "high", "low", "close") if c in f]
                f[px] = f[px] / div
            out[s] = f
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

    def fundamentals(self, symbols: list[str], ttl: float = 86400) -> tuple[dict[str, dict], dict]:
        """Cached fundamentals; missing ones are fetched in the background (a universe is ~100 Yahoo calls).
        Returns (data, progress)."""
        symbols = list(dict.fromkeys(symbols))
        keys = {s: f"fund2:{s}" for s in symbols}
        raw = self.db.get_meta(list(keys.values()), ttl)
        have = {s: raw[k] for s, k in keys.items() if k in raw}
        now = time.time()
        missing = [s for s in symbols if s not in have and now - self._meta_miss.get(keys[s], 0) > self.meta_retry]
        stale = [s for s in symbols if s not in have]
        if stale:      # an older copy beats nothing while the refresh runs
            old = self.db.get_meta([keys[s] for s in stale], max_age=30 * 86400)
            have.update({s: old[keys[s]] for s in stale if keys[s] in old})
        if missing and hasattr(self.p, "fundamentals"):
            with self._lock:
                running = getattr(self, "_fund_job", None)
                todo = [s for s in missing if s not in (running or set())]
                if todo:
                    job = set(todo) | (running or set())
                    self._fund_job = job

                    def work(batch):
                        def fetch(s):
                            try:
                                return s, self.p.fundamentals(s)
                            except Exception as e:  # noqa: BLE001
                                log.info("fundamentals %s failed: %s", s, e)
                                return s, None
                        with ThreadPoolExecutor(max_workers=min(self.workers, 3)) as ex:
                            for s, f in ex.map(fetch, batch):
                                if f:
                                    self.db.put_meta(f"fund2:{s}", f)
                                else:
                                    self._meta_miss[f"fund2:{s}"] = time.time()
                                with self._lock:
                                    self._fund_job.discard(s)
                    threading.Thread(target=work, args=(todo,), daemon=True).start()
        pending = len(getattr(self, "_fund_job", set()) & set(symbols))
        return have, {"have": len(have), "total": len(symbols), "pending": pending}

    def financials(self, symbol: str, ttl: float = 24 * 3600) -> dict | None:
        """Quarterly and annual statements for one stock (cached a day). None when Yahoo has none."""
        key = f"fin:{symbol}"
        hit = self.db.get_meta([key], ttl).get(key)
        if hit is not None:
            return hit or None
        if time.time() - self._meta_miss.get(key, 0) < self.meta_retry or not hasattr(self.p, "financials"):
            return self.db.get_meta([key], max_age=90 * 86400).get(key) or None
        try:
            v = self.p.financials(symbol)
        except Exception as e:  # noqa: BLE001
            log.info("financials %s failed: %s", symbol, e)
            self._meta_miss[key] = time.time()
            return self.db.get_meta([key], max_age=90 * 86400).get(key) or None
        self.db.put_meta(key, v)
        return v

    def valuation(self, symbol: str, ttl: float = 12 * 3600) -> dict | None:
        """Valuation ratios + EPS history for one symbol (cached 12 h). None when Yahoo has nothing."""
        key = f"val:{symbol}"
        hit = self.db.get_meta([key], ttl).get(key)
        if hit is not None:
            return hit or None
        if time.time() - self._meta_miss.get(key, 0) < self.meta_retry or not hasattr(self.p, "valuation"):
            old = self.db.get_meta([key], max_age=30 * 86400).get(key)
            return old or None
        try:
            v = self.p.valuation(symbol)
        except Exception as e:  # noqa: BLE001
            log.info("valuation %s failed: %s", symbol, e)
            self._meta_miss[key] = time.time()
            old = self.db.get_meta([key], max_age=30 * 86400).get(key)
            return old or None
        self.db.put_meta(key, v)
        return v

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

    def extended(self, symbols: list[str], ttl: float = 60) -> dict[str, dict]:
        """Pre-market / after-hours quotes per symbol (cached `ttl` seconds in memory, fetched in parallel)."""
        if not hasattr(self.p, "extended") or not symbols:
            return {}
        cache = self.__dict__.setdefault("_ext", {})
        now = time.time()
        todo = [s for s in dict.fromkeys(symbols) if not (s in cache and now - cache[s][0] < ttl)]

        def fetch(s):
            try:
                return s, self.p.extended(s)
            except Exception as e:  # noqa: BLE001
                log.info("extended hours %s failed: %s", s, e)
                return s, None
        if todo:
            with ThreadPoolExecutor(max_workers=min(self.workers, 4)) as ex:
                for s, d in ex.map(fetch, todo):
                    if d is not None:
                        cache[s] = (time.time(), d)
        return {s: cache[s][1] for s in symbols if s in cache}

    def intraday(self, symbol: str, period: str, interval: str, ttl: float = 60) -> pd.Series | None:
        """Intraday closes (MAJOR currency units, UTC index) for the detail chart, cached `ttl` seconds in memory.
        A listing priced from another one (IBCF.MU via IBCF.DE) uses that listing's bars."""
        if not hasattr(self.p, "intraday"):
            return None
        src = self.sources.get(symbol, symbol)
        key = (src, period, interval)
        cache = self.__dict__.setdefault("_intra", {})
        hit = cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            ser = hit[1]
        else:
            try:
                ser = self.p.intraday(src, period, interval)
            except Exception as e:  # noqa: BLE001
                log.info("intraday %s %s/%s failed: %s", src, period, interval, e)
                return hit[1] if hit else None
            cache[key] = (time.time(), ser)
        _, div = normalize_currency((self.meta([src]).get(src) or {}).get("currency"))
        return ser / div if ser is not None and div != 1 else ser

    def dividends(self, symbols: list[str], ttl: float = 12 * 3600) -> dict[str, dict]:
        """Dividend history and calendar per symbol (cached 12 h in SQLite), amounts in MAJOR currency units.
        A symbol priced from another listing (IBCF.MU via IBCF.DE) takes that listing's dividends: same fund."""
        symbols = list(dict.fromkeys(symbols))
        src = {s: self.sources.get(s, s) for s in symbols}
        keys = {s: f"div:{src[s]}" for s in symbols}
        raw = self.db.get_meta(list(set(keys.values())), ttl)
        have = {s: raw[k] for s, k in keys.items() if k in raw}
        now = time.time()
        todo = sorted({src[s] for s in symbols if s not in have and now - self._meta_miss.get(keys[s], 0) > self.meta_retry})
        if todo and hasattr(self.p, "dividends"):
            def fetch(s):
                try:
                    return s, self.p.dividends(s)
                except Exception as e:  # noqa: BLE001
                    log.info("dividends %s failed: %s", s, e)
                    return s, None
            got = {}
            with ThreadPoolExecutor(max_workers=min(self.workers, 4)) as ex:
                for s, d in ex.map(fetch, todo):
                    if d is None:
                        self._meta_miss[f"div:{s}"] = time.time()
                    else:
                        self.db.put_meta(f"div:{s}", d)
                        got[s] = d
            have.update({s: got[src[s]] for s in symbols if src[s] in got})
        stale = [s for s in symbols if s not in have]
        if stale:
            old = self.db.get_meta([keys[s] for s in stale], max_age=60 * 86400)
            have.update({s: old[keys[s]] for s in stale if keys[s] in old})
        meta = self.meta(list(set(src.values())))
        out = {}
        for s, d in have.items():
            _, div = normalize_currency((meta.get(src[s]) or {}).get("currency"))
            out[s] = {**d, "history": [[x, v / div] for x, v in d.get("history") or []], "source": src[s] if src[s] != s else None}
        return out

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
