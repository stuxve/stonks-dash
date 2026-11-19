"""Valuation history: trailing P/E (price-to-earnings ratio) over time from quarterly reported EPS (earnings per share).

TTM (trailing twelve months) EPS after each report = the sum of the last four quarterly EPS. The historical P/E on a
date is that day's close divided by the TTM EPS known on that date. Quarters with negative TTM EPS have no P/E.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def ttm_eps(eps_hist: list[list]) -> pd.Series:
    """TTM EPS known after each quarterly report (needs 4 consecutive quarters, ~ 3 months apart)."""
    if not eps_hist:
        return pd.Series(dtype=float)
    s = pd.Series({pd.Timestamp(d): float(v) for d, v in eps_hist}).sort_index()
    s = s[~s.index.duplicated(keep="last")]
    out = {}
    for k in range(3, len(s)):
        w = s.iloc[k - 3:k + 1]
        span = (w.index[-1] - w.index[0]).days
        if 200 <= span <= 340:          # four quarters, not a gap in the data
            out[w.index[-1]] = float(w.sum())
    return pd.Series(out, dtype=float)


def pe_history(close: pd.Series, eps_hist: list[list], freq: str = "W-FRI") -> pd.DataFrame:
    """Weekly close, TTM EPS in force and P/E (NaN when TTM EPS <= 0 or not yet known)."""
    ttm = ttm_eps(eps_hist)
    if ttm.empty or close is None or close.empty:
        return pd.DataFrame(columns=["close", "ttm", "pe"])
    wk = close.resample(freq).last().dropna()
    eps_on = ttm.reindex(wk.index.union(ttm.index)).sort_index().ffill().reindex(wk.index)
    # an EPS figure older than ~7 months is stale (missed reports): don't carry it further
    last_rep = pd.Series(ttm.index, index=ttm.index).reindex(wk.index.union(ttm.index)).sort_index().ffill().reindex(wk.index)
    stale = (wk.index - pd.DatetimeIndex(last_rep)).days > 215
    eps_on[stale] = np.nan
    pe = (wk / eps_on).where(eps_on > 0)
    return pd.DataFrame({"close": wk, "ttm": eps_on, "pe": pe})


def pe_stats(pe: pd.Series, years: int) -> dict | None:
    """Median, quartiles, deciles, range and the current value's percentile over the last `years` years."""
    pe = pe.dropna()
    if pe.empty:
        return None
    w = pe[pe.index >= pe.index[-1] - pd.Timedelta(days=int(365.25 * years))]
    if len(w) < 26:                     # less than ~6 months of weekly points
        return None
    q = w.quantile([0.1, 0.25, 0.5, 0.75, 0.9])
    cur = float(w.iloc[-1])
    return {"years": years, "n": int(len(w)), "from": w.index[0].date().isoformat(),
            "p10": float(q[0.1]), "p25": float(q[0.25]), "median": float(q[0.5]), "p75": float(q[0.75]), "p90": float(q[0.9]),
            "min": float(w.min()), "max": float(w.max()), "current": cur, "pctile": float((w < cur).mean() * 100)}


def median(xs) -> float | None:
    xs = sorted(float(x) for x in xs if x is not None and np.isfinite(x))
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2
