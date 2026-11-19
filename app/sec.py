"""Long revenue / profit history from SEC EDGAR (the US regulator's filings database), via its free XBRL API.

XBRL is the machine-readable format of the financial statements in 10-K / 10-Q (US companies) and 20-F / 40-F / 6-K
(foreign companies filing in the US). One request returns every value a company has ever filed ("company facts"),
typically ~15 years. The SEC asks API users to send a User-Agent naming who they are (`STONKS_SEC_UA`, e.g.
"Your Name your@email.com"); requests are limited to 10 per second, and here they are cached for a week.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import re
import urllib.request
from datetime import date

log = logging.getLogger("stonks.sec")

UA = os.getenv("STONKS_SEC_UA", "stonks-dash personal portfolio dashboard")
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

# concepts in order of preference; companies switch concepts over time (e.g. revenue under ASC 606 from 2018)
CONCEPTS = {
    "revenue": [("us-gaap", "Revenues"), ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
                ("us-gaap", "SalesRevenueNet"), ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"),
                ("us-gaap", "SalesRevenueGoodsNet"), ("us-gaap", "RevenuesNetOfInterestExpense"),
                ("ifrs-full", "Revenue"), ("ifrs-full", "RevenueFromContractsWithCustomers")],
    "net": [("us-gaap", "NetIncomeLoss"), ("us-gaap", "ProfitLoss"), ("us-gaap", "NetIncomeLossAvailableToCommonStockholdersBasic"),
            ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"), ("ifrs-full", "ProfitLoss")],
    "operating": [("us-gaap", "OperatingIncomeLoss"), ("ifrs-full", "ProfitLossFromOperatingActivities")],
}
FORMS = ("10-K", "10-Q", "20-F", "40-F", "6-K", "10-K/A", "10-Q/A", "20-F/A", "10-KT")


def fetch_json(url: str, timeout: float = 40) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — fixed https URLs
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
    return json.loads(data)


def _words(name: str | None) -> list[str]:
    stop = {"inc", "corp", "corporation", "co", "company", "ltd", "plc", "nv", "n", "v", "sa", "ag", "se", "holding",
            "holdings", "group", "the", "limited", "de", "class", "a", "b"}
    return [w for w in re.findall(r"[a-z0-9]+", (name or "").lower()) if w not in stop]


def find_cik(symbol: str, name: str | None, tickers: dict) -> int | None:
    """CIK (the SEC's company number) for a Yahoo symbol. US tickers match directly (BRK-B style); a foreign listing
    (ASML.AS) matches its US ticker only when the company names agree, so a different company with the same
    letters is never picked."""
    by = {str(v.get("ticker", "")).upper(): v for v in tickers.values()}
    sym = symbol.upper()
    if "." not in sym:
        hit = by.get(sym) or by.get(sym.replace("-", "."))
        return int(hit["cik_str"]) if hit else None
    root = sym.split(".")[0]
    hit = by.get(root)
    if hit and _words(name)[:1] and _words(name)[:1] == _words(hit.get("title"))[:1]:
        return int(hit["cik_str"])
    return None


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _series(facts: dict, concepts: list[tuple[str, str]]) -> tuple[dict, dict, str | None]:
    """{end: value} for annual (~1 year) and quarterly (~3 months) periods, merging concepts by preference."""
    annual, quarterly, ccy = {}, {}, None
    for tax, concept in concepts:
        units = ((facts.get(tax) or {}).get(concept) or {}).get("units") or {}
        if not units:
            continue
        unit = "USD" if "USD" in units else next((u for u in units if re.fullmatch(r"[A-Z]{3}", u)), None)
        if not unit:
            continue
        if ccy and unit != ccy:
            continue                     # don't mix currencies across concepts
        best_a, best_q = {}, {}
        for e in units[unit]:
            if not e.get("start") or not e.get("end") or e.get("form") not in FORMS or e.get("val") is None:
                continue
            d = _days(e["start"], e["end"])
            tgt = best_a if 330 <= d <= 400 else best_q if 75 <= d <= 105 else None
            if tgt is None:
                continue
            k = e["end"]
            if k not in tgt or (e.get("filed") or "") > (tgt[k][1] or ""):     # latest filing wins (restatements)
                tgt[k] = (e["start"], e.get("filed"), float(e["val"]))
        if not best_a and not best_q:
            continue
        ccy = ccy or unit
        for src, dst in ((best_a, annual), (best_q, quarterly)):
            for k, v in src.items():
                dst.setdefault(k, v)
    return annual, quarterly, ccy


def _add_q4(annual: dict, quarterly: dict) -> None:
    """10-Ks report the full year, not Q4: derive Q4 = year − (Q1 + Q2 + Q3) when the three quarters are known."""
    for end, (start, filed, val) in annual.items():
        if end in quarterly:
            continue
        qs = sorted((k, v) for k, v in quarterly.items() if k < end and _days(start, v[0]) >= -5)
        if len(qs) == 3 and _days(qs[-1][0], end) <= 105:
            quarterly[end] = (qs[-1][0], filed, val - sum(v[2] for _, v in qs))


def extract(companyfacts: dict) -> dict:
    """Annual and quarterly revenue, net income and operating income from an EDGAR company-facts document."""
    facts = companyfacts.get("facts") or {}
    out, ccy = {"annual": {}, "quarterly": {}}, None
    for key, concepts in CONCEPTS.items():
        a, q, c = _series(facts, concepts)
        if key == "revenue":
            ccy = c
        elif c and ccy and c != ccy:
            continue
        _add_q4(a, q)
        for freq, src in (("annual", a), ("quarterly", q)):
            for end, (_, _, val) in src.items():
                out[freq].setdefault(end, {})[key] = val
    res = {"currency": ccy, "name": companyfacts.get("entityName")}
    for freq in ("annual", "quarterly"):
        rows = [[end, v.get("revenue"), v.get("net"), v.get("operating")] for end, v in sorted(out[freq].items())
                if v.get("revenue") is not None or v.get("net") is not None]
        res[freq] = rows
    return res
