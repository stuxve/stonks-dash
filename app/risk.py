"""Portfolio risk: volatility, drawdowns, correlation, beta, risk contribution, concentration and scenarios.

All series are daily prices already converted to the base currency. Assets that trade 7 days a week (crypto)
and 5 days (stocks) are put on one business-day calendar, so a weekend crypto move lands on Monday.
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd

TRADING_DAYS = 252

# historical stress windows (peak → trough of the broad market, or of crypto for the crypto winter)
SCENARIOS = [
    {"key": "covid", "label": "COVID crash", "start": "2020-02-19", "end": "2020-03-23"},
    {"key": "bear2022", "label": "2022 bear market", "start": "2022-01-03", "end": "2022-10-12"},
    {"key": "crypto2022", "label": "Crypto winter", "start": "2021-11-08", "end": "2022-11-21"},
    {"key": "carry2024", "label": "Aug 2024 yen-carry sell-off", "start": "2024-07-16", "end": "2024-08-05"},
    {"key": "tariffs2025", "label": "2025 tariff shock", "start": "2025-02-19", "end": "2025-04-08"},
]


def business_returns(prices: dict[str, pd.Series], start: date | None = None) -> pd.DataFrame:
    """Daily simple returns on business days (prices carried forward over holidays and weekends)."""
    if not prices:
        return pd.DataFrame()
    df = pd.DataFrame({k: v[~v.index.duplicated(keep="last")] for k, v in prices.items() if v is not None and len(v)})
    if df.empty:
        return df
    df = df.sort_index()
    bidx = pd.bdate_range(df.index.min(), df.index.max())
    df = df.reindex(df.index.union(bidx)).ffill().reindex(bidx)
    r = df.pct_change(fill_method=None)
    if start is not None:
        r = r[r.index >= pd.Timestamp(start)]
    return r.iloc[1:] if len(r) else r


def portfolio_returns(R: pd.DataFrame, w: pd.Series) -> pd.Series:
    """Constant-weight mix; on days an asset has no data yet, its weight is spread over the others."""
    w = w.reindex(R.columns).fillna(0.0)
    avail = R.notna().astype(float) * w
    tot = avail.sum(axis=1).replace(0, np.nan)
    return (R.fillna(0.0) * avail).sum(axis=1) / tot


def ann_vol(r: pd.Series) -> float | None:
    r = r.dropna()
    return float(r.std() * math.sqrt(TRADING_DAYS)) if len(r) > 20 else None


def ann_return(r: pd.Series) -> float | None:
    r = r.dropna()
    if len(r) < 20:
        return None
    g = float((1 + r).prod())
    yrs = len(r) / TRADING_DAYS
    return g ** (1 / yrs) - 1 if g > 0 else None


def drawdown(r: pd.Series, max_points: int = 500) -> dict | None:
    """Deepest fall from a peak of the growth index, its dates and length, plus the underwater curve."""
    r = r.dropna()
    if len(r) < 2:
        return None
    idx = (1 + r).cumprod()
    peak = idx.cummax()
    dd = idx / peak - 1
    trough = dd.idxmin()
    mdd = float(dd.loc[trough])
    pk = idx.loc[:trough].idxmax()
    after = idx.loc[trough:]
    rec = after[after >= idx.loc[pk]]
    rec_d = rec.index[0] if len(rec) else None
    end = rec_d or idx.index[-1]
    cur = float(dd.iloc[-1])
    cur_peak = idx.idxmax()
    step = max(1, math.ceil(len(dd) / max_points))
    take = np.unique(np.r_[np.arange(0, len(dd), step), len(dd) - 1])
    return {
        "max": mdd, "peak": pk.date().isoformat(), "trough": trough.date().isoformat(),
        "recovered": rec_d.date().isoformat() if rec_d is not None else None,
        "days_down": int((trough - pk).days), "days_total": int((end - pk).days),
        "current": cur, "current_since": cur_peak.date().isoformat() if cur < -1e-9 else None,
        "curve": {"dates": [d.date().isoformat() for d in dd.index[take]], "dd": [round(float(x), 5) for x in dd.iloc[take]]},
    }


def worst_window(r: pd.Series, days: int) -> dict | None:
    r = r.dropna()
    if len(r) <= days:
        return None
    roll = (1 + r).rolling(days).apply(np.prod, raw=True) - 1
    d = roll.idxmin()
    return {"ret": float(roll.loc[d]), "end": d.date().isoformat(),
            "start": r.index[max(0, r.index.get_loc(d) - days + 1)].date().isoformat()}


def beta_corr(r: pd.Series, m: pd.Series) -> tuple[float | None, float | None]:
    x = pd.concat([r, m], axis=1).dropna()
    if len(x) < 40:
        return None, None
    a, b = x.iloc[:, 0], x.iloc[:, 1]
    var = float(b.var())
    beta = float(a.cov(b) / var) if var > 0 else None
    return beta, float(a.corr(b))


def risk_contributions(R: pd.DataFrame, w: pd.Series) -> dict[str, float]:
    """Share of the portfolio variance each asset is responsible for (sums to 1)."""
    X = R.dropna(how="all").fillna(0.0)
    if len(X) < 40:
        return {}
    cov = X.cov().to_numpy() * TRADING_DAYS
    wv = w.reindex(R.columns).fillna(0.0).to_numpy()
    var = float(wv @ cov @ wv)
    if var <= 0:
        return {}
    mrc = cov @ wv
    return {c: float(wv[i] * mrc[i] / var) for i, c in enumerate(R.columns)}


def concentration(weights: dict[str, float]) -> dict:
    w = sorted((v for v in weights.values() if v > 0), reverse=True)
    s = sum(w) or 1.0
    w = [v / s for v in w]
    hhi = sum(v * v for v in w)
    return {"top1": w[0] * 100 if w else 0, "top5": sum(w[:5]) * 100, "hhi": hhi,
            "effective_n": (1 / hhi) if hhi else 0, "n": len(w)}


def window_return(s: pd.Series | None, start: str, end: str) -> float | None:
    """Return of a base-currency price series between two dates (last price on or before each date)."""
    if s is None or s.empty:
        return None
    a, b = pd.Timestamp(start), pd.Timestamp(end)
    s = s.dropna()
    if s.index[0] > a + pd.Timedelta(days=7) or s.index[-1] < b:
        return None
    pa = s[s.index <= a]
    pb = s[s.index <= b]
    if pa.empty or pb.empty or not pa.iloc[-1]:
        return None
    return float(pb.iloc[-1] / pa.iloc[-1] - 1)


def daily_moves(s: pd.Series, bars: pd.DataFrame | None = None) -> dict | None:
    """How much a price moves in a day: last-year distribution of daily returns, records, this week's best/worst day.
    Works on the asset's own currency (its moves, not your FX). `s` should be cleaned of bad ticks."""
    s = s.dropna()
    s = s[s > 0]
    if len(s) < 30:
        return None
    r = s.pct_change().dropna()
    end = r.index[-1]
    yr = r[r.index > end - pd.Timedelta(days=365)]
    if len(yr) < 20:
        return None
    q = yr.quantile([0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
    wk = r[r.index > end - pd.Timedelta(days=7)]
    base_wk = s[s.index <= end - pd.Timedelta(days=7)]
    today = float(r.iloc[-1])
    out = {
        "n": int(len(yr)),
        "q": {k: float(v) for k, v in zip(("p1", "p5", "p25", "p50", "p75", "p95", "p99"), q.to_numpy())},
        "median_abs": float(yr.abs().median()),
        "sd": float(yr.std()),
        "up_share": float((yr > 0).mean()),
        "days": {"up3": int((yr > 0.03).sum()), "dn3": int((yr < -0.03).sum()),
                 "up5": int((yr > 0.05).sum()), "dn5": int((yr < -0.05).sum())},
        "year_best": {"ret": float(yr.max()), "date": yr.idxmax().date().isoformat()},
        "year_worst": {"ret": float(yr.min()), "date": yr.idxmin().date().isoformat()},
        "today": {"ret": today, "date": end.date().isoformat(),
                  "pctile": float((yr < today).mean() * 100)},
        "week": None,
    }
    if len(wk):
        out["week"] = {"best": {"ret": float(wk.max()), "date": wk.idxmax().date().isoformat()},
                       "worst": {"ret": float(wk.min()), "date": wk.idxmin().date().isoformat()},
                       "change": float(s.iloc[-1] / base_wk.iloc[-1] - 1) if len(base_wk) else None,
                       "days": int(len(wk)),
                       "range": {"hi": float(s[s.index > end - pd.Timedelta(days=7)].max()),
                                 "lo": float(s[s.index > end - pd.Timedelta(days=7)].min())}}
    hl = intraday_hilo(s, bars)
    out["windows"] = {k: window_extremes(s, d, hl) for k, d in WINDOWS.items()}
    return out


WINDOWS = {"15d": 15, "6m": 182, "1y": 365}


def intraday_hilo(close: pd.Series, bars: pd.DataFrame | None) -> pd.DataFrame | None:
    """Daily intraday high and low aligned to `close` (already cleaned). Yahoo's highs and lows carry bad ticks more
    often than its closes, so a high (low) that overshoots both the day's and the previous close by more than
    max(5%, 8x the typical overshoot) is dropped back to that close. Days with no intraday data (or covered by a
    proxy) use the close. `real` marks days whose high/low are actual intraday data."""
    if bars is None or bars.empty or close is None or close.empty:
        return None
    b = bars.reindex(close.index)
    prev = close.shift(1).fillna(close)
    top, bot = np.maximum(close, prev), np.minimum(close, prev)
    hi = pd.to_numeric(b.get("high"), errors="coerce").where(lambda x: x > 0)
    lo = pd.to_numeric(b.get("low"), errors="coerce").where(lambda x: x > 0)
    real = hi.notna() & lo.notna()
    hi = np.maximum(hi.fillna(close), close)
    lo = np.minimum(lo.fillna(close), close)
    ex_h = (hi / top - 1).clip(lower=0)
    ex_l = (1 - lo / bot).clip(lower=0)
    lim_h = max(0.05, 8 * float(ex_h[real].median() or 0)) if real.any() else 0.05
    lim_l = max(0.05, 8 * float(ex_l[real].median() or 0)) if real.any() else 0.05
    hi = hi.where(ex_h <= lim_h, top)
    lo = lo.where(ex_l <= lim_l, bot)
    return pd.DataFrame({"high": hi, "low": lo, "real": real})


def window_extremes(s: pd.Series, days: int, hl: pd.DataFrame | None = None) -> dict | None:
    """Highest and lowest close of the last `days` calendar days, where today's price sits between them,
    and the biggest one-day rise and fall in that window."""
    s = s.dropna()
    end = s.index[-1]
    w = s[s.index > end - pd.Timedelta(days=days)]
    if len(w) < 3:
        return None
    r = s.pct_change()
    rw = r[r.index > end - pd.Timedelta(days=days)].dropna()
    hi_d, lo_d = w.idxmax(), w.idxmin()
    hi, lo, now = float(w.loc[hi_d]), float(w.loc[lo_d]), float(s.iloc[-1])
    first = float(s[s.index <= end - pd.Timedelta(days=days)].iloc[-1]) if (s.index <= end - pd.Timedelta(days=days)).any() else float(w.iloc[0])
    out = {"days": days, "n": int(len(w)), "now": now,
           "hi": hi, "hi_date": hi_d.date().isoformat(), "lo": lo, "lo_date": lo_d.date().isoformat(),
           "from_hi": now / hi - 1 if hi else None, "from_lo": now / lo - 1 if lo else None,
           "pos": (now - lo) / (hi - lo) if hi > lo else 0.5,
           "change": now / first - 1 if first else None,
           "at_hi": hi_d == end, "at_lo": lo_d == end,
           "best": None, "worst": None}
    if len(rw):
        out["best"] = {"ret": float(rw.max()), "date": rw.idxmax().date().isoformat()}
        out["worst"] = {"ret": float(rw.min()), "date": rw.idxmin().date().isoformat()}
        today = float(r.iloc[-1])
        out["today"] = today
        out["today_is_best"] = rw.idxmax() == end and today > 0
        out["today_is_worst"] = rw.idxmin() == end and today < 0
    if hl is not None:
        h = hl[(hl.index > end - pd.Timedelta(days=days)) & (hl.index <= end)]
        if len(h) and h["real"].any():
            ih_d, il_d = h["high"].idxmax(), h["low"].idxmin()
            ih, il = float(h["high"].loc[ih_d]), float(h["low"].loc[il_d])
            out["intra"] = {"hi": ih, "hi_date": ih_d.date().isoformat(), "lo": il, "lo_date": il_d.date().isoformat(),
                            "from_hi": now / ih - 1 if ih else None, "from_lo": now / il - 1 if il else None,
                            "pos": (now - il) / (ih - il) if ih > il else 0.5,
                            "at_hi": ih_d == end, "at_lo": il_d == end,
                            "real_days": int(h["real"].sum()), "days": int(len(h))}
    return out
