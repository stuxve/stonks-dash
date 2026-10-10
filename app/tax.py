"""Spanish IRPF helper (base del ahorro) — an estimate, not tax advice.

* Escala del ahorro (territorio común, 2025+): 19 % hasta 6.000 €, 21 % hasta 50.000 €, 23 % hasta 200.000 €,
  27 % hasta 300.000 €, 30 % a partir de ahí. Editable in settings (`tax_brackets`).
* Ganancias/pérdidas patrimoniales y rendimientos del capital mobiliario (dividendos) se integran por separado;
  un saldo negativo compensa hasta el 25 % del otro (cupo único con las pérdidas de años anteriores) y lo que
  sobra se arrastra 4 años.
* Regla de los dos meses (art. 33.5.f LIRPF): la pérdida no se computa en la parte correspondiente a valores
  homogéneos comprados en los 2 meses anteriores o posteriores a la venta; se integra cuando se venden esos valores.
* Doble imposición internacional: la retención en origen se deduce como máximo hasta el impuesto español sobre
  ese dividendo (simplificado: tipo medio del ahorro).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

import pandas as pd

from .ledger import EPS, lot_date, tx_date

DEFAULT_BRACKETS = [[6000, 0.19], [50000, 0.21], [200000, 0.23], [300000, 0.27], [None, 0.30]]
CARRY_YEARS = 4
CAP_RATE = 0.25


def scale(base: float, brackets=None) -> tuple[float, list[dict]]:
    """Tax on `base` with a progressive scale. Returns (tax, breakdown)."""
    brackets = brackets or DEFAULT_BRACKETS
    tax, lo, parts = 0.0, 0.0, []
    for upto, rate in brackets:
        hi = float("inf") if upto is None else float(upto)
        if base <= lo:
            break
        chunk = min(base, hi) - lo
        tax += chunk * rate
        parts.append({"from": lo, "to": None if upto is None else hi, "rate": rate, "amount": chunk, "tax": chunk * rate})
        lo = hi
    return tax, parts


# ---------------------------------------------------------------------------------------------- 2-month rule
def wash_sales(lots: list[dict], sells: list[dict], fr, per_sell: dict, today: date | None = None) -> dict:
    """Detect losses deferred by the 2-month rule and when they are released.

    Returns {"blocked": {sell_id: amount<0}, "released": [(date, amount<0, sell_id_origin, lot_id)],
             "pending": [{lot_id, symbol, amount<0}], "replacements": {sell_id: [{lot_id, qty}]}}
    """
    by_symbol = defaultdict(list)
    for lot in lots:
        if lot.get("symbol"):
            by_symbol[lot["symbol"].upper()].append(lot)
    consumed = defaultdict(lambda: defaultdict(float))     # sell id -> lot id -> qty
    for m in fr.matches:
        consumed[m.sell_id][m.lot_id] += m.qty
    sell_dates = {s["id"]: tx_date(s) for s in sells}
    used_as_replacement = defaultdict(float)               # lot id -> units already covering an earlier loss
    blocked, replacements, deferred_on_lot = {}, {}, defaultdict(list)  # lot -> [(units, per_unit_amount)]

    for s in sorted(sells, key=lambda s: (tx_date(s), s["id"])):
        r = per_sell.get(s["id"])
        if not r or r["gain"] >= -EPS:
            continue
        sd = pd.Timestamp(tx_date(s))
        lo, hi = sd - pd.DateOffset(months=2), sd + pd.DateOffset(months=2)
        q_sold = float(s["quantity"])
        need = q_sold
        used = []
        for lot in sorted(by_symbol.get(s["symbol"].upper(), []), key=lambda x: (lot_date(x), x["id"])):
            ld = pd.Timestamp(lot_date(lot))
            if not (lo <= ld <= hi) or need <= EPS:
                continue
            units = float(lot["quantity"]) - consumed[s["id"]].get(lot["id"], 0.0) - used_as_replacement[lot["id"]]
            if ld <= sd:  # bought before: only what was still held after this sale counts
                units -= sum(q for sid, per in consumed.items() if sid != s["id"] and sell_dates.get(sid) and
                             pd.Timestamp(sell_dates[sid]) <= sd for lid, q in per.items() if lid == lot["id"])
            units = max(0.0, min(units, need))
            if units > EPS:
                used.append((lot["id"], units))
                used_as_replacement[lot["id"]] += units
                need -= units
        if not used:
            continue
        frac = (q_sold - need) / q_sold
        amount = r["gain"] * frac                 # negative
        blocked[s["id"]] = amount
        replacements[s["id"]] = [{"lot_id": lid, "qty": u} for lid, u in used]
        per_unit = amount / (q_sold - need)
        for lid, u in used:
            deferred_on_lot[lid].append([u, per_unit, s["id"]])

    # release deferred losses when the replacement units are sold (FIFO order of later matches)
    released, lot_sales = [], defaultdict(list)
    for m in fr.matches:
        lot_sales[m.lot_id].append((sell_dates[m.sell_id], m.qty, m.sell_id))
    for lid, chunks in deferred_on_lot.items():
        sales = sorted(lot_sales.get(lid, []))
        for d, q, sid in sales:
            for ch in chunks:
                if q <= EPS:
                    break
                if ch[2] == sid:          # the loss-making sale itself
                    continue
                take = min(ch[0], q)
                if take > EPS:
                    released.append((d, take * ch[1], ch[2], lid))
                    ch[0] -= take
                    q -= take
    pending = []
    lots_by_id = {x["id"]: x for x in lots}
    for lid, chunks in deferred_on_lot.items():
        left = sum(c[0] * c[1] for c in chunks if c[0] > EPS)
        if left < -EPS:
            pending.append({"lot_id": lid, "symbol": lots_by_id[lid]["symbol"], "amount": left})
    return {"blocked": blocked, "released": released, "pending": pending, "replacements": replacements}


# ---------------------------------------------------------------------------------------------- yearly IRPF
def year_result(gp: float, rcm: float, withheld: float, carries: list[list], year: int, brackets=None) -> dict:
    """One tax year. gp = saldo ganancias/pérdidas, rcm = dividendos íntegros, carries = [[year, gp_loss_left>0]]
    (mutated in place: consumed and the new loss appended)."""
    carries[:] = [c for c in carries if year - c[0] <= CARRY_YEARS and c[1] > EPS]
    cap = CAP_RATE * max(rcm, 0.0)
    comp = {"gp_vs_rcm": 0.0, "prior_vs_gp": 0.0, "prior_vs_rcm": 0.0}
    g, r = gp, rcm
    if g < 0:
        off = min(-g, cap)
        g += off
        r -= off
        cap -= off
        comp["gp_vs_rcm"] = off
    else:
        for c in carries:
            use = min(c[1], g)
            c[1] -= use
            g -= use
            comp["prior_vs_gp"] += use
    for c in carries:
        if cap <= EPS or r <= EPS:
            break
        use = min(c[1], cap, r)
        c[1] -= use
        r -= use
        cap -= use
        comp["prior_vs_rcm"] += use
    carries[:] = [c for c in carries if c[1] > EPS]
    if g < -EPS:
        carries.append([year, -g])
        g = 0.0
    base = max(g, 0.0) + max(r, 0.0)
    tax, parts = scale(base, brackets)
    avg = tax / base if base > EPS else 0.0
    dd = min(withheld, max(rcm, 0.0) * avg)
    return {"year": year, "gp": gp, "rcm": rcm, "base_gp": max(g, 0.0), "base_rcm": max(r, 0.0), "base": base,
            "tax": tax, "brackets": parts, "avg_rate": avg, "withheld": withheld, "dd_deduction": dd,
            "after_deductions": tax - dd, "compensations": comp,
            "carry_out": [{"year": c[0], "amount": c[1], "expires": c[0] + CARRY_YEARS} for c in carries]}


def compute_years(lots, sells, divs, fr, rz, prior_losses: dict, brackets=None, through: int | None = None) -> dict:
    """Run every year from the first transaction (or prior loss) to `through`."""
    ws = wash_sales(lots, sells, fr, rz["per_sell"])
    gp = defaultdict(float)
    detail = defaultdict(lambda: {"gains": 0.0, "losses": 0.0, "blocked": 0.0, "released": 0.0})
    for s in sells:
        r = rz["per_sell"].get(s["id"])
        if not r:
            continue
        y = tx_date(s).year
        g = r["gain"]
        b = ws["blocked"].get(s["id"], 0.0)
        gp[y] += g - b
        if g >= 0:
            detail[y]["gains"] += g
        else:
            detail[y]["losses"] += g
        detail[y]["blocked"] += b
    for d, amount, _sid, _lid in ws["released"]:
        gp[d.year] += amount
        detail[d.year]["released"] += amount
    rcm, wh = defaultdict(float), defaultdict(float)
    for d in divs:
        r = rz["per_div"][d["id"]]
        rcm[tx_date(d).year] += r["gross"]
        wh[tx_date(d).year] += r["withholding"]
    years = set(gp) | set(rcm)
    prior = {int(k): float(v) for k, v in (prior_losses or {}).items() if v}
    through = through or date.today().year
    first = min(years | set(prior) | {through})
    carries: list[list] = []
    out = {}
    for y in range(first, through + 1):
        if y in prior:
            carries.append([y, prior[y]])
        snapshot = [list(c) for c in carries]
        res = year_result(gp.get(y, 0.0), rcm.get(y, 0.0), wh.get(y, 0.0), carries, y, brackets)
        res.update(detail.get(y, {"gains": 0.0, "losses": 0.0, "blocked": 0.0, "released": 0.0}))
        res["carry_in"] = [{"year": c[0], "amount": c[1]} for c in snapshot if y - c[0] <= CARRY_YEARS]
        res["_carry_in_raw"] = snapshot
        out[y] = res
    return {"years": out, "wash": ws, "gp": dict(gp), "rcm": dict(rcm), "withheld": dict(wh)}


def marginal(year_res: dict, carries_in: list[list], extra_gp: float, brackets=None) -> float:
    """Extra tax this year if `extra_gp` (may be negative) were realized now."""
    base_c = [list(c) for c in carries_in]
    with_c = [list(c) for c in carries_in]
    y = year_res["year"]
    a = year_result(year_res["gp"], year_res["rcm"], year_res["withheld"], base_c, y, brackets)
    b = year_result(year_res["gp"] + extra_gp, year_res["rcm"], year_res["withheld"], with_c, y, brackets)
    return b["after_deductions"] - a["after_deductions"]
