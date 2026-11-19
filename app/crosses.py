"""Golden cross / death cross: the 50-day simple moving average (SMA, the plain average of the last 50 daily
closes) crossing the 200-day SMA. Above = "golden" (longer-term uptrend), below = "death" (downtrend).

Only completed daily closes count: before 22:15 local time today's bar is still moving (US markets close at
22:00 in Madrid), so it is left out and a cross is reported once, on the close that made it.
"""
from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd

FAST, SLOW = 50, 200
CLOSE_DONE = (22, 15)


def completed(closes: pd.Series, now: datetime) -> pd.Series:
    s = closes.dropna()
    if len(s) and s.index[-1].date() >= now.date() and (now.hour, now.minute) < CLOSE_DONE:
        s = s.iloc[:-1]
    return s


def sma_cross(closes: pd.Series, fast: int = FAST, slow: int = SLOW) -> dict | None:
    """Current 50/200 state, the date of the last cross and the one before it. None without 200+ closes."""
    s = closes.dropna().astype(float)
    if len(s) < slow + 1:
        return None
    f, sl = s.rolling(fast).mean(), s.rolling(slow).mean()
    d = (f - sl).dropna()
    sign = pd.Series(np.sign(d.values), index=d.index).replace(0, np.nan).ffill().dropna()
    if sign.empty:
        return None
    flips = sign[sign.ne(sign.shift()) & sign.shift().notna()]
    pos = {ts: i for i, ts in enumerate(sign.index)}

    def cross(ts):
        return {"date": ts.date().isoformat(), "state": "golden" if sign[ts] > 0 else "death",
                "bars_ago": len(sign) - 1 - pos[ts]}
    last = cross(flips.index[-1]) if len(flips) else None
    prev = cross(flips.index[-2]) if len(flips) > 1 else None
    return {
        "state": "golden" if sign.iloc[-1] > 0 else "death",
        "as_of": s.index[-1].date().isoformat(),
        "price": float(s.iloc[-1]), "fast": float(f.iloc[-1]), "slow": float(sl.iloc[-1]),
        "gap_pct": float((f.iloc[-1] / sl.iloc[-1] - 1) * 100),
        "price_vs_slow": float((s.iloc[-1] / sl.iloc[-1] - 1) * 100),
        "last": last, "prev": prev,
    }
