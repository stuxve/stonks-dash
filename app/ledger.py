"""Portfolio accounting.

* Buys are the rows of the `positions` table (one row = one lot), sells and dividends live in
  `transactions`.
* Sells consume lots FIFO per (symbol, account) — the Spanish rule for homogeneous securities.
* Realized gains use the FX rate of each date (acquisition FX for the cost, sale FX for the proceeds),
  and buy/sell fees are part of the cost / reduce the proceeds.
* The benchmark is a "shadow portfolio": every euro you put in or took out on a date is mirrored
  as a buy/sell of the benchmark on that same date.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime

import numpy as np
import pandas as pd

EPS = 1e-9


# ---------------------------------------------------------------------------------------------- basics
def lot_date(p: dict) -> date:
    if p.get("bought_at"):
        return date.fromisoformat(str(p["bought_at"])[:10])
    return datetime.fromtimestamp(p.get("created_at") or 0).date()


def tx_date(t: dict) -> date:
    return date.fromisoformat(str(t["date"])[:10])


def lot_cost_native(p: dict, qty: float | None = None) -> float:
    """Cost of `qty` units of this lot in its own currency, buy fees included pro rata."""
    q = float(p["quantity"])
    qty = q if qty is None else qty
    fees = float(p.get("fees") or 0.0)
    return qty * float(p["avg_cost"]) + (fees * qty / q if q else 0.0)


def _key(symbol: str | None, account: str | None) -> tuple[str, str]:
    return ((symbol or "").upper(), account or "")


@dataclass
class Match:
    sell_id: int | None
    lot_id: int
    qty: float


@dataclass
class FifoResult:
    remaining: dict          # lot id -> units still held
    matches: list            # [Match]
    shortfalls: list         # sells that sell more than was held at that date


def fifo(lots: list[dict], sells: list[dict]) -> FifoResult:
    groups: dict[tuple, list] = defaultdict(list)
    for lot in lots:
        if lot.get("symbol"):
            groups[_key(lot["symbol"], lot.get("account"))].append(lot)
    for g in groups.values():
        g.sort(key=lambda lot: (lot_date(lot), lot["id"]))
    remaining = {lot["id"]: float(lot["quantity"]) for lot in lots}
    matches, short = [], []
    for s in sorted(sells, key=lambda s: (tx_date(s), s.get("id") or 0)):
        sd = tx_date(s)
        need = float(s["quantity"])
        for lot in groups.get(_key(s["symbol"], s.get("account")), []):
            if need <= EPS or lot_date(lot) > sd:
                break
            take = min(remaining[lot["id"]], need)
            if take <= EPS:
                continue
            remaining[lot["id"]] -= take
            need -= take
            matches.append(Match(s.get("id"), lot["id"], take))
        if need > 1e-7:
            held = float(s["quantity"]) - need
            short.append({"sell_id": s.get("id"), "symbol": s["symbol"], "account": s.get("account"),
                          "date": sd.isoformat(), "held": held, "missing": need})
    return FifoResult(remaining, matches, short)


# ---------------------------------------------------------------------------------------------- FX
class FxBook:
    """Currency → base conversion at any date (falls back to today's rate when history is missing)."""

    def __init__(self, base: str, spot: dict[str, float], series: dict[str, pd.Series | None]):
        self.base = base.upper()
        self.spot = spot
        self.series = {k: v for k, v in series.items() if v is not None and not v.empty}
        self.approx: set[str] = set()

    def at(self, ccy: str | None, d) -> float:
        ccy = (ccy or self.base).upper()
        if ccy == self.base:
            return 1.0
        s = self.series.get(ccy)
        if s is not None:
            pos = s.index.searchsorted(pd.Timestamp(d), side="right") - 1
            return float(s.iloc[max(pos, 0)])
        self.approx.add(ccy)
        return float(self.spot.get(ccy) or math.nan)

    def on_index(self, ccy: str | None, idx: pd.DatetimeIndex) -> pd.Series:
        ccy = (ccy or self.base).upper()
        if ccy == self.base:
            return pd.Series(1.0, index=idx)
        s = self.series.get(ccy)
        if s is None:
            self.approx.add(ccy)
            return pd.Series(float(self.spot.get(ccy) or math.nan), index=idx)
        return _align(s, idx)


def _align(s: pd.Series, idx: pd.DatetimeIndex) -> pd.Series:
    """Values of a daily series on `idx`, carrying the last known value forward (and the first one back)."""
    u = s.index.union(idx)
    return s.reindex(u).ffill().bfill().reindex(idx)


# ---------------------------------------------------------------------------------------------- realized
def realized(lots: list[dict], sells: list[dict], divs: list[dict], fr: FifoResult, fx: FxBook) -> dict:
    lots_by_id = {lot["id"]: lot for lot in lots}
    sells_by_id = {s["id"]: s for s in sells}
    per_sell: dict[int, dict] = {}
    for m in fr.matches:
        s, lot = sells_by_id[m.sell_id], lots_by_id[m.lot_id]
        sd, ld = tx_date(s), lot_date(lot)
        fees_part = float(s.get("fees") or 0) * m.qty / float(s["quantity"])
        proceeds = (m.qty * float(s["price"]) - fees_part) * fx.at(s["currency"], sd)
        cost = lot_cost_native(lot, m.qty) * fx.at(lot["currency"], ld)
        r = per_sell.setdefault(m.sell_id, {"proceeds": 0.0, "cost": 0.0, "gain": 0.0, "lots": []})
        r["proceeds"] += proceeds
        r["cost"] += cost
        r["gain"] += proceeds - cost
        r["lots"].append({"lot_id": lot["id"], "qty": m.qty, "bought_at": ld.isoformat(),
                          "days_held": (sd - ld).days, "cost": cost, "proceeds": proceeds})
    per_div = {}
    for d in divs:
        rate = fx.at(d["currency"], tx_date(d))
        gross = float(d.get("amount") or 0) * rate
        wh = float(d.get("withholding") or 0) * rate
        per_div[d["id"]] = {"gross": gross, "withholding": wh, "net": gross - wh}

    years: dict[int, dict] = defaultdict(lambda: {"gains": 0.0, "losses": 0.0, "net": 0.0, "proceeds": 0.0,
                                                  "div_gross": 0.0, "div_withholding": 0.0, "div_net": 0.0,
                                                  "fees": 0.0, "sells": 0})
    for s in sells:
        r = per_sell.get(s["id"])
        y = years[tx_date(s).year]
        y["fees"] += float(s.get("fees") or 0) * fx.at(s["currency"], tx_date(s))
        if not r:
            continue
        y["sells"] += 1
        y["proceeds"] += r["proceeds"]
        y["net"] += r["gain"]
        if r["gain"] >= 0:
            y["gains"] += r["gain"]
        else:
            y["losses"] += r["gain"]
    for d in divs:
        r, y = per_div[d["id"]], years[tx_date(d).year]
        y["div_gross"] += r["gross"]
        y["div_withholding"] += r["withholding"]
        y["div_net"] += r["net"]
    for lot in lots:
        if lot.get("fees"):
            years[lot_date(lot).year]["fees"] += float(lot["fees"]) * fx.at(lot["currency"], lot_date(lot))
    return {
        "per_sell": per_sell,
        "per_div": per_div,
        "years": {k: years[k] for k in sorted(years, reverse=True)},
        "total_gain": sum(r["gain"] for r in per_sell.values()),
        "total_div_net": sum(r["net"] for r in per_div.values()),
        "total_fees": sum(y["fees"] for y in years.values()),
    }


# ---------------------------------------------------------------------------------------------- XIRR
def xirr(flows: list[tuple[date, float]]) -> float | None:
    """Money-weighted annual return. flows: (date, amount) — negative = money in, positive = money out."""
    flows = [(d, a) for d, a in flows if a and math.isfinite(a)]
    if len(flows) < 2 or all(a > 0 for _, a in flows) or all(a < 0 for _, a in flows):
        return None
    d0 = min(d for d, _ in flows)
    span = [((d - d0).days / 365.25, a) for d, a in flows]
    if max(t for t, _ in span) < 1 / 365:
        return None

    def npv(r):
        return sum(a / (1.0 + r) ** t for t, a in span)

    lo, hi = -0.9999, 1.0
    f_lo, f_hi = npv(lo), npv(hi)
    while f_lo * f_hi > 0 and hi < 1e6:
        hi *= 4
        f_hi = npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        fm = npv(mid)
        if f_lo * fm <= 0:
            hi = mid
        else:
            lo, f_lo = mid, fm
    return (lo + hi) / 2


# ---------------------------------------------------------------------------------------------- performance
def cash_flows(lots, sells, divs, rz: dict, fx: FxBook) -> list[tuple[date, float, str]]:
    """(date, amount in base, kind). Buys negative (money in), sells/dividends positive (money out)."""
    out = []
    for lot in lots:
        d = lot_date(lot)
        out.append((d, -lot_cost_native(lot) * fx.at(lot["currency"], d), "buy"))
    for s in sells:
        r = rz["per_sell"].get(s["id"])
        if r:
            out.append((tx_date(s), r["proceeds"], "sell"))
    for d in divs:
        out.append((tx_date(d), rz["per_div"][d["id"]]["net"], "dividend"))
    return sorted(out, key=lambda x: x[0])


def performance(lots, sells, divs, fr: FifoResult, rz: dict, fx: FxBook,
                prices: dict[str, pd.Series], price_ccy: dict[str, str],
                bench: pd.Series | None, bench_ccy: str | None,
                value_now: float, today: date | None = None, max_points: int = 600) -> dict:
    today = today or date.today()
    flows = cash_flows(lots, sells, divs, rz, fx)
    if not flows:
        return {"dates": [], "value": [], "invested": [], "bench": [], "summary": None}
    start = min(f[0] for f in flows)
    idx = pd.date_range(pd.Timestamp(start), pd.Timestamp(today), freq="D")

    # units held per lot over time
    sold = defaultdict(list)  # lot id -> [(date, qty)]
    sells_by_id = {s["id"]: s for s in sells}
    for m in fr.matches:
        sold[m.lot_id].append((tx_date(sells_by_id[m.sell_id]), m.qty))

    value = pd.Series(0.0, index=idx)
    price_cache: dict[str, pd.Series] = {}
    flat_lots = []
    for lot in lots:
        held = pd.Series(0.0, index=idx)
        held[held.index >= pd.Timestamp(lot_date(lot))] += float(lot["quantity"])
        for d, q in sold.get(lot["id"], []):
            held[held.index >= pd.Timestamp(d)] -= q
        sym = lot.get("symbol")
        if sym and lot.get("manual_price") is None and sym in prices:
            if sym not in price_cache:
                price_cache[sym] = _align(prices[sym], idx) * fx.on_index(price_ccy.get(sym), idx)
            value += held * price_cache[sym]
        else:
            # no price history (manual asset / unknown ticker): carry it at cost
            unit = lot_cost_native(lot) / float(lot["quantity"]) * fx.at(lot["currency"], lot_date(lot))
            value += held * unit
            flat_lots.append(lot["id"])
    value.iloc[-1] = value_now  # end exactly on today's live valuation

    flow_s = pd.Series(0.0, index=idx)
    for d, a, _ in flows:
        flow_s[pd.Timestamp(d)] += -a
    invested = flow_s.cumsum()

    bench_s = None
    summary_bench = {}
    if bench is not None and not bench.empty:
        b = _align(bench, idx) * fx.on_index(bench_ccy, idx)
        units = (flow_s / b).cumsum()
        bench_s = units * b
        b_flows = [(d, a) for d, a, _ in flows] + [(today, float(bench_s.iloc[-1]))]
        summary_bench = {"bench_now": float(bench_s.iloc[-1]), "bench_xirr": xirr(b_flows),
                         "bench_first_date": bench.index[0].date().isoformat()}

    p_flows = [(d, a) for d, a, _ in flows] + [(today, value_now)]
    money_in = -sum(a for _, a, k in flows if k == "buy")
    money_out = sum(a for _, a, k in flows if k != "buy")
    summary = {
        "start": start.isoformat(),
        "value_now": value_now,
        "net_invested": float(invested.iloc[-1]),
        "money_in": money_in,
        "money_out": money_out,
        "gain": value_now + money_out - money_in,
        "xirr": p_flows and xirr(p_flows),
        "flat_lots": flat_lots,
        **summary_bench,
    }
    if bench_s is not None:
        summary["bench_gain"] = summary["bench_now"] + money_out - money_in
        summary["alpha"] = summary["gain"] - summary["bench_gain"]

    # thin out long histories (keep the last point)
    step = max(1, math.ceil(len(idx) / max_points))
    take = np.unique(np.r_[np.arange(0, len(idx), step), len(idx) - 1])
    rnd = lambda s: [None if not math.isfinite(v) else round(float(v), 2) for v in s.iloc[take]]  # noqa: E731
    return {
        "dates": [d.date().isoformat() for d in idx[take]],
        "value": rnd(value),
        "invested": rnd(invested),
        "bench": rnd(bench_s) if bench_s is not None else [],
        "summary": summary,
    }


def bench_return(bench_base: pd.Series | None, since: date) -> float | None:
    """Benchmark return (in base currency) from `since` to the last point, as a fraction."""
    if bench_base is None or bench_base.empty:
        return None
    pos = bench_base.index.searchsorted(pd.Timestamp(since), side="right") - 1
    then = float(bench_base.iloc[max(pos, 0)])
    now = float(bench_base.iloc[-1])
    return now / then - 1 if then else None
