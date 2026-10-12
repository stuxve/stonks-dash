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
