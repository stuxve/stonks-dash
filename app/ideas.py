"""Stock screener for the Ideas tab: ranks a universe (IBEX 35, or large caps worldwide) on transparent factors,
including how well each stock fits YOUR portfolio. It is a screen, not advice: it ranks what the data says today.

Every factor is a 0–100 score (percentile inside the universe; valuation is compared within the same sector when
there are enough peers). The final weighting is done in the browser so you can change it instantly.
"""
from __future__ import annotations

import math

import numpy as np

# large caps outside the US/Europe lists, so "World" isn't only US + Europe
WORLD_EXTRA = ["TSM", "7203.T", "6758.T", "8306.T", "6861.T", "0700.HK", "9988.HK", "005930.KS", "BHP.AX",
               "CBA.AX", "RY.TO", "SHOP.TO", "MELI", "INFY", "RIO.L", "GSK.L", "DGE.L"]

# approximate sector weights of a global index (MSCI ACWI), in Yahoo's sector names, %
WORLD_SECTORS = {"Technology": 26.0, "Financial Services": 17.0, "Healthcare": 10.0, "Consumer Cyclical": 10.5,
                 "Industrials": 11.0, "Communication Services": 8.5, "Consumer Defensive": 6.0, "Energy": 4.0,
                 "Basic Materials": 3.5, "Utilities": 2.6, "Real Estate": 2.1}
EQUITY_SECTORS = set(WORLD_SECTORS)

# regions of a global index, %
WORLD_REGIONS = {"United States": 63.0, "Europe": 14.5, "Japan": 5.0, "Emerging markets": 10.5, "Other developed": 7.0}
EUROPE = {"United Kingdom", "France", "Switzerland", "Germany", "Netherlands", "Sweden", "Spain", "Italy", "Denmark",
          "Finland", "Belgium", "Norway", "Ireland", "Portugal", "Austria", "Luxembourg"}
EMERGING = {"China", "Taiwan", "India", "South Korea", "Brazil", "Saudi Arabia", "South Africa", "Mexico",
            "Indonesia", "Thailand", "Malaysia", "Hong Kong", "Uruguay", "Argentina", "Chile", "Poland", "Turkey"}

# dividend withholding at source (headline %, Spanish resident) — the part above the treaty rate (usually 15%)
# can't be credited against Spanish IRPF and is lost unless you reclaim it from that country
WHT = {"United States": 15, "Spain": 19, "Germany": 26.375, "France": 25, "Netherlands": 15, "Italy": 26,
       "Switzerland": 35, "United Kingdom": 0, "Ireland": 25, "Denmark": 27, "Finland": 35, "Belgium": 30,
       "Portugal": 25, "Sweden": 30, "Norway": 25, "Japan": 15.315, "Hong Kong": 0, "China": 10, "South Korea": 22,
       "Taiwan": 21, "Australia": 30, "Canada": 25, "India": 20, "Brazil": 0, "Uruguay": 7}
TREATY = 15.0


def region_of(country: str | None) -> str:
    if not country:
        return "Other developed"
    if country == "United States":
        return "United States"
    if country == "Japan":
        return "Japan"
    if country in EUROPE:
        return "Europe"
    if country in EMERGING:
        return "Emerging markets"
    return "Other developed"


def lost_withholding(country: str | None) -> float:
    """% of a dividend you can't recover as a Spanish resident (rough, headline rates)."""
    if country in (None, "Spain"):
        return 0.0
    return max(0.0, WHT.get(country, 15.0) - TREATY)


def _rank(vals: dict[str, float | None], higher_better: bool = True) -> dict[str, float]:
    """Percentile 0–100 among the non-missing values (ties share the average rank)."""
    xs = {k: v for k, v in vals.items() if v is not None and math.isfinite(v)}
    if not xs:
        return {}
    keys = list(xs)
    arr = np.array([xs[k] for k in keys], dtype=float)
    if not higher_better:
        arr = -arr
    order = arr.argsort(kind="mergesort")
    ranks = np.empty(len(arr))
    ranks[order] = np.arange(len(arr))
    for v in np.unique(arr):           # average ties
        m = arr == v
        ranks[m] = ranks[m].mean()
    n = len(arr)
    return {k: (100.0 if n == 1 else float(ranks[i] / (n - 1) * 100)) for i, k in enumerate(keys)}


def _rank_by_group(vals: dict, groups: dict, higher_better: bool, min_peers: int = 4) -> dict[str, float]:
    """Rank within the same sector when it has enough peers, else across the whole universe."""
    out = _rank(vals, higher_better)
    by = {}
    for k, g in groups.items():
        by.setdefault(g, []).append(k)
    for g, ks in by.items():
        sub = {k: vals.get(k) for k in ks}
        if sum(v is not None for v in sub.values()) >= min_peers:
            out.update(_rank(sub, higher_better))
    return out


def _avg(*xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _median(vals):
    xs = sorted(v for v in vals if v is not None and math.isfinite(v))
    return xs[len(xs) // 2] if xs else None


def score(cands: list[dict], my_sectors: dict[str, float], my_regions: dict[str, float], world: bool) -> list[dict]:
    """cands: dicts with symbol, name, sector, country, fundamentals (pe, fpe, pb, ev_ebitda, roe, op_margin, de,
    rev_g, eps_g, div_yield, payout, target, price, n, rec) and derived mom, from_high, vol, corr, held_pct.
    my_sectors / my_regions: your equity exposure in % (look-through)."""
    S = {c["symbol"]: c for c in cands}
    sector = {k: c.get("sector") or "Unknown" for k, c in S.items()}
    pos = lambda v: v if v is not None and v > 0 else None  # noqa: E731  (negative P/E etc. = not meaningful)
    fin = lambda k: sector[k] == "Financial Services"  # noqa: E731

    pe = {k: pos(c.get("fpe")) or pos(c.get("pe")) for k, c in S.items()}
    r_pe = _rank_by_group(pe, sector, higher_better=False)
    r_pb = _rank_by_group({k: pos(c.get("pb")) for k, c in S.items()}, sector, higher_better=False)
    r_ev = _rank_by_group({k: (None if fin(k) else pos(c.get("ev_ebitda"))) for k, c in S.items()}, sector, False)
    r_roe = _rank({k: c.get("roe") for k, c in S.items()})
    r_om = _rank({k: (None if fin(k) else c.get("op_margin")) for k, c in S.items()})
    r_de = _rank({k: (None if fin(k) else c.get("de")) for k, c in S.items()}, higher_better=False)
    r_rg = _rank({k: c.get("rev_g") for k, c in S.items()})
    r_eg = _rank({k: c.get("eps_g") for k, c in S.items()})
    r_mom = _rank({k: c.get("mom") for k, c in S.items()})
    r_hi = _rank({k: c.get("from_high") for k, c in S.items()})          # closer to the 52-week high = higher
    up = {k: (min(c["target"] / c["price"] - 1, 0.6) if c.get("target") and c.get("price") and (c.get("n") or 0) >= 3
              and 0.2 < c["target"] / c["price"] < 5 else None) for k, c in S.items()}
    r_up = _rank(up)
    r_rec = _rank({k: (c.get("rec") if (c.get("n") or 0) >= 3 else None) for k, c in S.items()}, higher_better=False)
    net_y = {}
    for k, c in S.items():
        y = c.get("div_yield") or 0.0
        net_y[k] = y * (1 - lost_withholding(c.get("country")) / 100)
    r_inc = _rank(net_y)
    r_vol = _rank({k: c.get("vol") for k, c in S.items()}, higher_better=False)
    r_corr = _rank({k: c.get("corr") for k, c in S.items()}, higher_better=False)
    med_pe = {g: _median([pe[k] for k in S if sector[k] == g]) for g in set(sector.values())}

    eq_tot = sum(v for s, v in my_sectors.items() if s in EQUITY_SECTORS) or 0.0
    my_sec = {s: (my_sectors.get(s, 0.0) / eq_tot * 100 if eq_tot else 0.0) for s in WORLD_SECTORS}
    wsum = sum(WORLD_SECTORS.values())
    ref_sec = {s: v / wsum * 100 for s, v in WORLD_SECTORS.items()}
    rg_tot = sum(my_regions.values()) or 0.0
    my_reg = {r: (my_regions.get(r, 0.0) / rg_tot * 100 if rg_tot else 0.0) for r in WORLD_REGIONS}

    out = []
    for k, c in S.items():
        f, why, flags = {}, {}, []
        # value
        f["value"] = _avg(r_pe.get(k), r_pb.get(k), r_ev.get(k))
        if pe[k]:
            m = med_pe.get(sector[k])
            if m and sector[k] != "Unknown" and abs(pe[k] / m - 1) > 0.05:
                why["value"] = f"P/E {pe[k]:.1f} vs {m:.1f} sector median"
            else:
                why["value"] = f"P/E {pe[k]:.1f}" + (", about the sector median" if m and sector[k] != "Unknown" else "")
        elif c.get("pb"):
            why["value"] = f"P/B {c['pb']:.1f}"
        # quality
        f["quality"] = _avg(r_roe.get(k), r_om.get(k), r_de.get(k))
        bits = []
        if c.get("roe") is not None:
            bits.append(f"ROE {c['roe'] * 100:.0f}%")
        if c.get("op_margin") is not None and not fin(k):
            bits.append(f"op. margin {c['op_margin'] * 100:.0f}%")
        why["quality"] = ", ".join(bits)
        if c.get("de") is not None and not fin(k) and c["de"] > 200:
            flags.append(f"debt/equity {c['de']:.0f}%")
        # growth
        f["growth"] = _avg(r_rg.get(k), r_eg.get(k))
        bits = []
        if c.get("rev_g") is not None:
            bits.append(f"sales {c['rev_g'] * 100:+.0f}%")
        if c.get("eps_g") is not None:
            bits.append(f"earnings {c['eps_g'] * 100:+.0f}%")
        why["growth"] = ", ".join(bits) + (" (last quarter, year on year)" if bits else "")
        if c.get("eps_g") is not None and c["eps_g"] < -0.2:
            flags.append(f"earnings {c['eps_g'] * 100:.0f}%")
        # momentum
        f["momentum"] = _avg(r_mom.get(k), r_hi.get(k))
        if c.get("mom") is not None:
            why["momentum"] = f"{c['mom'] * 100:+.0f}% over 12 months (excl. last month)" + (
                f", {abs(c['from_high']) * 100:.0f}% below its 52-week high" if c.get("from_high") is not None and c["from_high"] < -0.02 else ", at its 52-week high")
        # analysts
        f["analysts"] = _avg(r_up.get(k), r_rec.get(k))
        if up.get(k) is not None:
            why["analysts"] = f"consensus {up[k] * 100:+.0f}% · {c.get('n')} analysts" + (f" · {c['rec_key'].replace('_', ' ')}" if c.get("rec_key") else "")
        # income (net of non-recoverable withholding for a Spanish resident)
        y = c.get("div_yield") or 0.0
        inc = r_inc.get(k) if y > 0 else 0.0       # no dividend = no income score
        if c.get("payout") and c["payout"] > 1.0:
            flags.append(f"payout {c['payout'] * 100:.0f}% of earnings")
            inc = inc * 0.5 if inc is not None else None
        f["income"] = inc
        if y > 0:
            lost = lost_withholding(c.get("country"))
            why["income"] = f"yield {y * 100:.1f}%" + (f" ({net_y[k] * 100:.1f}% after {lost:.0f}% non-recoverable withholding)" if lost > 0.5 else (" (no foreign withholding)" if c.get("country") == "Spain" else ""))
        # risk
        f["risk"] = r_vol.get(k)
        if c.get("vol") is not None:
            why["risk"] = f"volatility {c['vol'] * 100:.0f}%/yr"
        # fit with YOUR portfolio
        parts, fit_bits = [], []
        sec = sector[k]
        if sec in ref_sec and eq_tot:
            gap = ref_sec[sec] - my_sec.get(sec, 0.0)
            parts.append(max(0.0, min(100.0, 50 + gap * 5)))
            if gap >= 3:
                fit_bits.append(f"adds {sec}: you {my_sec.get(sec, 0):.0f}%, world {ref_sec[sec]:.0f}%")
            elif gap <= -5:
                flags.append(f"{sec} already {my_sec.get(sec, 0):.0f}% of your stocks (world {ref_sec[sec]:.0f}%)")
        if world and rg_tot:
            reg = region_of(c.get("country"))
            gap = WORLD_REGIONS[reg] - my_reg.get(reg, 0.0)
            parts.append(max(0.0, min(100.0, 50 + gap * 3)))
            if gap >= 4:
                fit_bits.append(f"adds {reg}: you {my_reg.get(reg, 0):.0f}%, world {WORLD_REGIONS[reg]:.0f}%")
        if r_corr.get(k) is not None:
            parts.append(r_corr[k])
            if c["corr"] < 0.35:
                fit_bits.append(f"moves little with your portfolio (corr {c['corr']:.2f})")
        fit = _avg(*parts)
        held = c.get("held_pct") or 0.0
        if fit is not None and held > 0:
            fit = max(0.0, fit - min(40.0, held * 6))
        if held >= 0.5:
            flags.append(f"you already hold {held:.1f}% (direct + inside funds)")
        f["fit"] = fit
        if fit_bits:
            why["fit"] = "; ".join(fit_bits)
        coverage = sum(v is not None for v in f.values()) / len(f)
        out.append({"symbol": k, "name": c.get("name") or k, "sector": sec, "country": c.get("country"),
                    "region": region_of(c.get("country")), "price": c.get("price"), "currency": c.get("currency"),
                    "pe": pe[k], "pb": c.get("pb"), "div_yield": y, "net_yield": net_y[k], "upside": up.get(k),
                    "n": c.get("n"), "mom": c.get("mom"), "vol": c.get("vol"), "corr": c.get("corr"),
                    "held_pct": held, "market_cap": c.get("market_cap"),
                    "f": {kk: (round(v, 1) if v is not None else None) for kk, v in f.items()},
                    "why": {kk: v for kk, v in why.items() if v}, "flags": flags, "coverage": coverage})
    return out
