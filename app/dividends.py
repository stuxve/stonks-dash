"""Dividend follow-up for the shares and funds you hold.

Words used here:
* ex-dividend date ("ex-date") — the first day a buyer no longer gets the coming payment. You must own the units
  BEFORE it (bought at the latest the trading day before). The number of units you held then is what you're paid on.
* pay date — when the cash reaches the broker, usually 1–6 weeks after the ex-date.
* trailing 12-month (TTM) yield — dividends with an ex-date in the last 365 days divided by today's price.
* yield on cost — what the current payout rate pays per year on what you paid for your units.

Yahoo gives the past ex-dates with the amount per share, and, for many US stocks, the next ex-date and pay date.
When the next ex-date isn't published, it's estimated from the usual spacing of past payments (marked "estimated").
"""
from __future__ import annotations

from datetime import date, timedelta
from statistics import median

FREQS = (1, 2, 3, 4, 6, 12)
FREQ_LABEL = {1: "yearly", 2: "twice a year", 3: "3 times a year", 4: "quarterly", 6: "every 2 months", 12: "monthly"}


def _d(x) -> date:
    return date.fromisoformat(str(x)[:10])


def frequency(hist: list[tuple[date, float]], today: date) -> tuple[int | None, float | None]:
    """(payments per year, typical days between payments) from the last ~3 years of ex-dates."""
    recent = [d for d, _ in hist if d >= today - timedelta(days=3 * 365 + 30)]
    if len(recent) < 2:
        return (1, 365.0) if recent and recent[-1] >= today - timedelta(days=420) else (None, None)
    gaps = [(b - a).days for a, b in zip(recent, recent[1:]) if (b - a).days > 10]   # skip special extras
    if not gaps:
        return None, None
    g = median(gaps)
    f = min(FREQS, key=lambda x: abs(365 / x - g))
    return f, 365 / f


def units_at(lots: list[dict], sells: list[dict], d: date) -> float:
    """Units held at the start of day `d` (bought before it, minus sold before it)."""
    q = sum(float(x["quantity"]) for x in lots if _lot_day(x) < d)
    q -= sum(float(t["quantity"] or 0) for t in sells if _d(t["date"]) < d)
    return max(0.0, q)


def _lot_day(x: dict) -> date:
    from .ledger import lot_date
    return lot_date(x)


def analyze(hist_raw: list, cal_ex: str | None, cal_pay: str | None, price: float | None, today: date) -> dict:
    """Payout pattern and the next payment for one symbol. Amounts per share in the listing's currency."""
    hist = sorted((_d(d), float(v)) for d, v in hist_raw or [] if v)
    out = {"pays": bool(hist), "freq": None, "freq_label": None, "last": None, "ttm": 0.0, "yield_ttm": None,
           "forward": None, "next": None, "stopped": False, "history": [[d.isoformat(), v] for d, v in hist[-16:]]}
    past = [(d, v) for d, v in hist if d <= today]
    future_hist = [(d, v) for d, v in hist if d > today]
    freq, gap = frequency(past, today)
    out["freq"], out["freq_label"] = freq, FREQ_LABEL.get(freq)
    if past:
        out["last"] = {"ex": past[-1][0].isoformat(), "amount": past[-1][1]}
        out["ttm"] = sum(v for d, v in past if d > today - timedelta(days=365))
        if price:
            out["yield_ttm"] = out["ttm"] / price * 100
    # the regular amount: the latest payment, unless it was a one-off far above the usual ones
    regular = None
    if past:
        last_n = [v for _, v in past[-(freq or 1) * 2:]]
        med = median(last_n)
        regular = past[-1][1] if past[-1][1] <= med * 1.8 else med
    if freq and regular:
        out["forward"] = regular * freq
    # next ex-date: Yahoo's calendar if it's ahead, else the usual spacing after the last one
    nxt = None
    if cal_ex and _d(cal_ex) >= today:
        ex = _d(cal_ex)
        amt = next((v for d, v in hist if d == ex), None)
        nxt = {"ex": ex.isoformat(), "estimated": False, "amount": amt if amt is not None else regular,
               "amount_known": amt is not None}
    elif future_hist:
        ex, amt = future_hist[0]
        nxt = {"ex": ex.isoformat(), "estimated": False, "amount": amt, "amount_known": True}
    elif past and gap:
        ex = past[-1][0] + timedelta(days=round(gap))
        overdue = 0
        while ex < today:
            ex += timedelta(days=round(gap))
            overdue += 1
        if overdue >= 2:                                  # two payments missed: it probably stopped
            out["stopped"] = True
        nxt = {"ex": ex.isoformat(), "estimated": True, "amount": regular, "amount_known": False}
    if nxt and not out["stopped"]:
        nxt["days"] = (_d(nxt["ex"]) - today).days
        nxt["pay"] = cal_pay if cal_pay and _d(cal_pay) >= _d(nxt["ex"]) and not nxt["estimated"] else None
        out["next"] = nxt
    # a payment still to come for an ex-date that has passed (Yahoo keeps both dates until the next one is set)
    out["pending_pay"] = None
    if cal_ex and cal_pay and _d(cal_ex) <= today <= _d(cal_pay):
        amt = next((v for d, v in hist if d == _d(cal_ex)), None)
        out["pending_pay"] = {"ex": cal_ex, "pay": cal_pay, "amount": amt, "days": (_d(cal_pay) - today).days}
    # the next 12 months of ex-dates, for the income calendar
    sched = []
    if out["next"] and gap:
        ex = _d(out["next"]["ex"])
        while ex <= today + timedelta(days=365):
            sched.append({"ex": ex.isoformat(), "amount": out["next"]["amount"] if not sched else regular,
                          "estimated": out["next"]["estimated"] or bool(sched)})
            ex += timedelta(days=round(gap))
    out["schedule"] = sched
    return out


def follow_up(hist_raw: list, lots: list[dict], sells: list[dict], divs: list[dict], today: date,
              years: float = 2) -> list[dict]:
    """Each past ex-date (last `years` years) you held units for, and whether a dividend was recorded for it.

    A recorded dividend (Transactions → Dividend) of the same symbol dated from 5 days before to 75 days after the
    ex-date counts as that payment. Statuses: "recorded", "awaiting" (ex-date within the last 45 days: usually
    not paid yet) and "missing" (older and nothing recorded)."""
    hist = sorted((_d(d), float(v)) for d, v in hist_raw or [] if v)
    used: set = set()
    txs = sorted(divs, key=lambda t: t["date"])
    out = []
    for ex, amt in hist:
        if ex > today or ex < today - timedelta(days=int(365 * years)):
            continue
        u = units_at(lots, sells, ex)
        if u <= 1e-9:
            continue
        tx = next((t for t in txs if t["id"] not in used and ex - timedelta(days=5) <= _d(t["date"]) <= ex + timedelta(days=75)), None)
        if tx:
            used.add(tx["id"])
        status = "recorded" if tx else ("awaiting" if (today - ex).days <= 45 else "missing")
        out.append({"ex": ex.isoformat(), "amount": amt, "units": u, "gross": u * amt, "status": status,
                    "tx": {"id": tx["id"], "date": tx["date"], "amount": tx.get("amount"), "currency": tx.get("currency")} if tx else None})
    return out[::-1]
