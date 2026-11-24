"""Indicative move of a fund while its own exchange is closed.

A European-listed ETF (VWCE.DE, IWDA.AS, IS3N.DE…) only trades from 09:00 to 17:30. Before that, and in the
evening, the markets it holds keep moving: US index futures trade almost round the clock, Asia trades during the
European night, and the currency changes. This estimates where the fund would be now, relative to its last close:

    move ≈ Σ country weight × (that market's move since the fund's last close, converted into the fund's currency)

* Country weights come from the fund's index profile (app/exposure.py: MSCI World ≈ 72% US, 5% Japan…).
  Countries without a gauge ("Other") are left out and the rest scaled back to 100%.
* Each market's move is measured from the fund's last close time to now, on 30-minute bars: US = S&P 500
  futures (Nasdaq 100 futures for Nasdaq funds), Japan = Nikkei 225, and so on. A European index that hasn't
  traded since then simply contributes 0.
* Currency: a fund that isn't currency-hedged gains when the dollar (yen, pound…) rises against its own
  currency. Hedged share classes ("EUR Hedged") ignore it. Emerging-market currencies are approximated by the dollar.
It is an estimate, not a quote: the fund's real price at the open also reflects spreads and demand.
"""
from __future__ import annotations

import pandas as pd

# country → (gauge symbol, label, currency)
GAUGES = {
    "United States": ("ES=F", "S&P 500 futures", "USD"),
    "Japan": ("^N225", "Nikkei 225", "JPY"),
    "China": ("^HSI", "Hang Seng", "HKD"),
    "Hong Kong": ("^HSI", "Hang Seng", "HKD"),
    "Taiwan": ("^TWII", "Taiwan Weighted", "USD"),
    "South Korea": ("^KS11", "KOSPI", "USD"),
    "India": ("^NSEI", "Nifty 50", "USD"),
    "Australia": ("^AXJO", "S&P/ASX 200", "AUD"),
    "Canada": ("^GSPTSE", "S&P/TSX", "CAD"),
    "Brazil": ("^BVSP", "Bovespa", "USD"),
    "Mexico": ("^MXX", "IPC Mexico", "USD"),
    "United Kingdom": ("^FTSE", "FTSE 100", "GBP"),
    "France": ("^FCHI", "CAC 40", "EUR"),
    "Germany": ("^GDAXI", "DAX", "EUR"),
    "Switzerland": ("^SSMI", "SMI", "CHF"),
    "Netherlands": ("^AEX", "AEX", "EUR"),
    "Spain": ("^IBEX", "IBEX 35", "EUR"),
    "Italy": ("FTSEMIB.MI", "FTSE MIB", "EUR"),
}
NASDAQ = ("NQ=F", "Nasdaq 100 futures", "USD")
FX_CCYS = ("USD", "JPY", "GBP", "CHF", "HKD", "AUD", "CAD")


def gauges_for(countries: dict, nasdaq: bool = False) -> dict:
    """{country: (symbol, label, ccy, weight 0..1)} for the countries we can track, weights rescaled to 1."""
    use = {c: (NASDAQ if nasdaq and c == "United States" else GAUGES[c]) for c in countries if c in GAUGES}
    tot = sum(countries[c] for c in use) or 1.0
    return {c: (*use[c], countries[c] / tot) for c in use}


def move_since(ser: pd.Series | None, t0: pd.Timestamp) -> float | None:
    """Relative move from the last bar at or before `t0` to the latest bar (None without a bar before t0)."""
    if ser is None or len(ser) < 2:
        return None
    before = ser[ser.index <= t0]
    if before.empty:
        return None
    a, b = float(before.iloc[-1]), float(ser.iloc[-1])
    return b / a - 1 if a else None


def estimate(g: dict, moves: dict, fx_moves: dict, fund_ccy: str, hedged: bool) -> dict:
    """g: gauges_for(...); moves: {symbol: move}; fx_moves: {ccy: move of FUNDCCY/ccy pair} (e.g. EURUSD=X).
    Returns the total move and each driver's contribution (fractions, not %)."""
    drivers, total, covered = [], 0.0, 0.0
    for country, (sym, label, ccy, w) in sorted(g.items(), key=lambda kv: -kv[1][3]):
        m = moves.get(sym)
        if m is None:
            continue
        fx = 0.0
        if not hedged and ccy != fund_ccy:
            pair = fx_moves.get(ccy if ccy in fx_moves else "USD")
            if pair is not None:
                fx = 1 / (1 + pair) - 1                      # the foreign currency vs the fund's currency
        local = (1 + m) * (1 + fx) - 1
        drivers.append({"country": country, "gauge": sym, "label": label, "weight": w, "market": m, "fx": fx,
                        "contribution": w * local})
        total += w * local
        covered += w
    if covered and covered < 0.999:                           # a gauge had no data: scale to what we saw
        total /= covered
    return {"move": total if covered else None, "covered": covered, "drivers": drivers}
