"""Price levels for the Sell targets tab: suggested resistance / support zones, volatility and breakouts.

Everything works on daily CLOSES (intraday spikes never set a level):

* clean()      — drops bad ticks: a Hampel filter (close far from the local median, in robust deviations)
                 plus one-day spikes that fully revert the next day.
* volatility() — typical daily move (close-to-close "ATR"), daily/annual volatility, bars per year
                 (crypto trades 7 days a week).
* zones()      — turning points (local highs and lows) found with several look-back windows (5/10/20 bars).
                 A wiggle that only one window sees is dropped; the rest are grouped into zones whose width
                 scales with the asset's volatility, then ranked by touches, weighted towards recent ones.
* breakout()   — a zone the price was below in the last weeks and has now closed above for 2+ days by more
                 than one typical daily move: the old resistance becomes support.

These are places to look, not forecasts.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

WINDOWS = (5, 10, 20)          # pivot look-backs (bars each side)
MIN_WINDOWS = 2                # a zone must be seen by at least this many look-backs
TOUCH_GAP = 5                  # pivots closer than this (bars) count as one touch
HALF_LIFE_DAYS = 365           # recency weight of a touch halves every year
LOOKBACK_DAYS = 3 * 365


def clean(s: pd.Series, k: float = 5.0, half: int = 3) -> pd.Series:
    """Daily closes without bad ticks (values replaced by the local median)."""
    s = s.dropna()
    s = s[s > 0]
    if len(s) < 2 * half + 3:
        return s
    med = s.rolling(2 * half + 1, center=True, min_periods=half + 1).median()
    mad = (s - med).abs().rolling(2 * half + 1, center=True, min_periods=half + 1).median() * 1.4826
    # floor the deviation so flat stretches (MAD≈0) don't flag ordinary moves
    floor = s.pct_change().abs().rolling(60, min_periods=10).median().bfill().fillna(0.01) * med
    bad = (s - med).abs() > k * np.maximum(mad, floor)
    out = s.where(~bad, med)
    # one-bar spike that reverts: big jump in, matching jump back out
    r = np.log(out).diff()
    sd = r.rolling(60, min_periods=10).std().bfill()
    spike = (r.abs() > 6 * sd) & (r.shift(-1) * r < 0) & (r.shift(-1).abs() > 0.7 * r.abs())
    if spike.any():
        nb = (out.shift(1) + out.shift(-1)) / 2
        out = out.where(~spike, nb)
    return out


def volatility(s: pd.Series) -> dict | None:
    """ATR-like typical daily move and volatility, from closes."""
    s = s.dropna()
    if len(s) < 25:
        return None
    last = s[s.index >= s.index[-1] - pd.Timedelta(days=365)]
    per_year = max(min(len(last), 366), 200) if len(last) > 150 else 252
    r = np.log(s).diff().dropna()
    sd = float(r.iloc[-min(len(r), 250):].std())
    atr = float(s.diff().abs().iloc[-22:].mean())           # close-to-close average true range (22 bars)
    price = float(s.iloc[-1])
    return {"atr": atr, "atr_pct": atr / price * 100 if price else None, "vol_d": sd,
            "vol_y": sd * math.sqrt(per_year), "per_year": per_year}


def _pivots(c: np.ndarray, w: int) -> list[tuple[int, str]]:
    n = len(c)
    out = []
    if n < 2 * w + 1:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    win = sliding_window_view(c, 2 * w + 1)
    mx, mn = win.max(axis=1), win.min(axis=1)
    mid = c[w:n - w]
    for j in np.nonzero(mid >= mx)[0]:
        out.append((int(j + w), "high"))
    for j in np.nonzero(mid <= mn)[0]:
        out.append((int(j + w), "low"))
    return out


def zones(s: pd.Series, atr_pct: float | None) -> list[dict]:
    """All stable zones (any side of the price), with touches and a recency-weighted score."""
    s = s.dropna()
    if len(s) < 60:
        return []
    c = s.to_numpy(dtype=float)
    idx = s.index
    found: dict[int, dict] = {}
    for w in WINDOWS:
        for i, kind in _pivots(c, w):
            p = found.setdefault(i, {"i": i, "price": c[i], "kind": kind, "windows": set()})
            p["windows"].add(w)
    piv = [p for p in found.values() if len(p["windows"]) >= MIN_WINDOWS]
    # a high in the last bars can't be confirmed by the longer look-backs yet: keep the recent swing high
    tail = 2 * max(WINDOWS)
    if len(c) > tail:
        j = len(c) - tail + int(np.argmax(c[-tail:]))
        if j > len(c) - 1 - max(WINDOWS) and j < len(c) - 1 and c[j] > c[-1] and j not in {p["i"] for p in piv}:
            piv.append({"i": j, "price": c[j], "kind": "high", "windows": {0}, "recent": True})
    if not piv:
        return []
    tol = min(max(1.25 * (atr_pct or 1.0), 0.75), 6.0) / 100      # zone width scales with volatility
    piv.sort(key=lambda p: p["price"])
    groups, cur = [], [piv[0]]
    for p in piv[1:]:
        if p["price"] <= cur[0]["price"] * (1 + tol):
            cur.append(p)
        else:
            groups.append(cur)
            cur = [p]
    groups.append(cur)
    end = idx[-1]
    out = []
    for g in groups:
        g.sort(key=lambda p: p["i"])
        touches = []
        for p in g:                                   # nearby pivots are one touch
            if touches and p["i"] - touches[-1]["i"] < TOUCH_GAP:
                continue
            touches.append(p)
        ages = [(end - idx[p["i"]]).days for p in touches]
        score = sum(0.5 ** (a / HALF_LIFE_DAYS) for a in ages)
        prices = [p["price"] for p in g]
        out.append({
            "level": float(np.median(prices)), "lo": float(min(prices)), "hi": float(max(prices)),
            "touches": len(touches), "score": round(score, 3),
            "highs": sum(p["kind"] == "high" for p in touches), "lows": sum(p["kind"] == "low" for p in touches),
            "last_touch": idx[touches[-1]["i"]].date().isoformat(),
            "first_touch": idx[touches[0]["i"]].date().isoformat(),
            "recent": any(p.get("recent") for p in g) and len(touches) == 1,
        })
    return out


def split(all_zones: list[dict], price: float, atr_pct: float | None, n: int = 3) -> tuple[list, list]:
    """Strongest `n` resistances above and supports below the price (each sorted by distance)."""
    gap = (atr_pct or 1.0) / 100 * 0.5
    above = [z for z in all_zones if z["lo"] > price * (1 + gap)]
    below = [z for z in all_zones if z["hi"] < price * (1 - gap)]
    pick = lambda zs: sorted(zs, key=lambda z: (-z["score"], -z["touches"]))[:n]  # noqa: E731
    return (sorted(pick(above), key=lambda z: z["level"]),
            sorted(pick(below), key=lambda z: -z["level"]))


def breakout(s: pd.Series, all_zones: list[dict], atr: float | None, recent: int = 20, confirm: int = 2) -> dict | None:
    """Highest zone the price was below within `recent` bars and has closed above (by > 1 ATR) for `confirm` bars."""
    s = s.dropna()
    if not atr or len(s) < recent + confirm + 1:
        return None
    lastn = s.iloc[-confirm:]
    before = s.iloc[-(recent + confirm):-confirm]
    best = None
    for z in all_zones:
        if z["highs"] < 1 or z["touches"] < 2:   # a level that capped the price before, more than once
            continue
        if (lastn > z["hi"] + atr).all() and (before < z["lo"]).any():
            if best is None or z["level"] > best["level"]:
                best = z
    if not best:
        return None
    crossed = s[(s.index >= before.index[0]) & (s > best["hi"])]
    return {**best, "since": crossed.index[0].date().isoformat() if len(crossed) else None}


def breakdown(s: pd.Series, all_zones: list[dict], atr: float | None, recent: int = 20, confirm: int = 2) -> dict | None:
    """Downside break: a support (held the price 2+ times) that the price was above within `recent` bars and has now
    closed below, by more than one ATR, for `confirm` bars. Returns the nearest such level above the price."""
    s = s.dropna()
    if not atr or len(s) < recent + confirm + 1:
        return None
    lastn = s.iloc[-confirm:]
    before = s.iloc[-(recent + confirm):-confirm]
    best = None
    for z in all_zones:
        if z["lows"] < 1 or z["touches"] < 2:
            continue
        if (lastn < z["lo"] - atr).all() and (before > z["hi"]).any():
            if best is None or z["level"] < best["level"]:
                best = z
    if not best:
        return None
    crossed = s[(s.index >= before.index[0]) & (s < best["lo"])]
    return {**best, "since": crossed.index[0].date().isoformat() if len(crossed) else None}


def hit_probability(price: float, level: float, vol_y: float | None, years: float) -> float | None:
    """Chance the price TOUCHES `level` within `years`, for a driftless log-random walk (reflection principle)."""
    if not (price and level and vol_y and years > 0):
        return None
    b = abs(math.log(level / price))
    sig = vol_y * math.sqrt(years)
    if sig <= 0:
        return None
    return float(min(1.0, 2 * (1 - 0.5 * (1 + math.erf(b / sig / math.sqrt(2))))))


def analyze(s: pd.Series, price: float | None = None) -> dict | None:
    """Everything the tab needs for one symbol."""
    s = clean(s)
    if s.empty:
        return None
    if price is not None and price > 0:
        if s.index[-1].date() < pd.Timestamp.today().date():
            s = pd.concat([s, pd.Series([price], index=[pd.Timestamp(pd.Timestamp.today().date())])])
        else:
            s = s.copy()
            s.iloc[-1] = price
    v = volatility(s)
    px = float(s.iloc[-1])
    zs = zones(s, v and v["atr_pct"])
    above, below = split(zs, px, v and v["atr_pct"])
    return {
        "price": px, "vol": v,
        "resistance": above, "support": below,
        "breakout": breakout(s, zs, v and v["atr"]),
        "breakdown": breakdown(s, zs, v and v["atr"]),
        "last_closes": [float(x) for x in s.iloc[-3:]],
        "history_from": s.index[0].date().isoformat(),
        "series": s,
    }
