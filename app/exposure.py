"""Look-through exposure: what you really own once funds/ETFs are opened up.

* Companies & sectors of funds come from Yahoo (top holdings — usually the top 10 — and sector weights).
  The part of a fund outside its top holdings is shown as "Other holdings of <fund>".
* Yahoo has no country split for funds, so countries/currencies use an index profile detected from the fund's
  name (MSCI World, S&P 500, Emerging…). The weights are approximate index-level figures and can be overridden
  per fund in the UI. "Hedged" share classes are treated as exposed to their hedge currency.
"""
from __future__ import annotations

import re
from collections import defaultdict

PROFILES = {
    "msci_world": {"proxy": "URTH", "label": "MSCI World (developed)", "countries": {
        "United States": 72.0, "Japan": 5.4, "United Kingdom": 3.6, "Canada": 3.1, "France": 2.6, "Switzerland": 2.4,
        "Germany": 2.3, "Australia": 1.7, "Netherlands": 1.2, "Sweden": 0.9, "Spain": 0.8, "Italy": 0.7,
        "Denmark": 0.6, "Other": 2.7}},
    "all_world": {"proxy": "VT", "label": "All-World / ACWI", "countries": {
        "United States": 63.0, "Japan": 5.2, "United Kingdom": 3.2, "China": 2.8, "Canada": 2.8, "France": 2.3,
        "Switzerland": 2.1, "Germany": 2.1, "Taiwan": 2.1, "India": 1.9, "Australia": 1.6, "South Korea": 1.1,
        "Netherlands": 1.0, "Other": 8.8}},
    "sp500": {"proxy": "SPY", "label": "S&P 500", "countries": {"United States": 100.0}},
    "us_total": {"proxy": "VTI", "label": "US total market", "countries": {"United States": 100.0}},
    "nasdaq100": {"proxy": "QQQ", "label": "Nasdaq-100", "countries": {"United States": 97.0, "Other": 3.0}},
    "emerging": {"proxy": "IEMG", "label": "Emerging markets", "countries": {
        "China": 26.0, "India": 19.0, "Taiwan": 19.0, "South Korea": 10.0, "Brazil": 4.5, "Saudi Arabia": 3.5,
        "South Africa": 3.2, "Mexico": 2.0, "Other": 12.8}},
    "europe": {"proxy": "VGK", "label": "Europe (Stoxx 600 / MSCI Europe)", "countries": {
        "United Kingdom": 22.0, "France": 16.0, "Switzerland": 15.0, "Germany": 14.0, "Netherlands": 7.0,
        "Sweden": 5.0, "Spain": 4.5, "Denmark": 4.0, "Italy": 4.0, "Other": 8.5}},
    "eurozone": {"proxy": "EZU", "label": "Eurozone (Euro Stoxx / EMU)", "countries": {
        "France": 33.0, "Germany": 29.0, "Netherlands": 15.0, "Spain": 9.0, "Italy": 8.0, "Other": 6.0}},
    "spain": {"proxy": "EWP", "label": "Spain (IBEX)", "countries": {"Spain": 100.0}},
    "japan": {"proxy": "EWJ", "label": "Japan", "countries": {"Japan": 100.0}},
    "uk": {"proxy": "EWU", "label": "United Kingdom", "countries": {"United Kingdom": 100.0}},
    "us_bonds": {"proxy": "AGG", "label": "US bonds", "countries": {"United States": 100.0}, "asset": "Bonds"},
    "global_bonds": {"proxy": "BNDW", "label": "Global bonds", "countries": {"United States": 45.0, "Japan": 10.0, "France": 6.0,
                                                           "Germany": 5.0, "United Kingdom": 5.0, "Other": 29.0},
                     "asset": "Bonds"},
    "gold": {"proxy": "GLD", "label": "Gold", "countries": {"Commodity (no country)": 100.0}, "asset": "Commodities",
             "currency": "USD"},
    "unknown": {"label": "Unknown — set a profile", "countries": {"Unclassified": 100.0}},
}

# order matters: first match wins
PROFILE_RULES = [
    (r"s&p ?500|sp ?500|core s&p|\bvoo\b|\bspy\b|\bcspx\b|\bsxr8\b|\bvusa\b", "sp500"),
    (r"nasdaq|\bqqq\b|\beqqq\b", "nasdaq100"),
    (r"total stock market|total market|\bvti\b", "us_total"),
    (r"all[- ]world|acwi|all cap|total world|\bvwce\b|\bvt\b|global all", "all_world"),
    (r"emerging|\bem imi\b|msci em\b|\bis3n\b|\beimi\b", "emerging"),
    (r"treasury|aggregate|\bagg\b|\bbnd\b|\btlt\b|us bond|govt bond", "us_bonds"),
    (r"global bond|global aggregate|bond index", "global_bonds"),
    (r"gold|\bgld\b|\bsgln\b|\b4gld\b", "gold"),
    (r"euro stoxx|\bemu\b|eurozone|euro area", "eurozone"),
    (r"stoxx europe|europe 600|msci europe|europe|\bmeud\b", "europe"),
    (r"ibex|spain|españa", "spain"),
    (r"japan|nikkei|topix", "japan"),
    (r"ftse 100|united kingdom|\buk\b", "uk"),
    (r"world|global stock|developed|\biwda\b|\beunl\b|\bxdwd\b|\bswda\b", "msci_world"),
]

COUNTRY_CCY = {
    "United States": "USD", "Japan": "JPY", "United Kingdom": "GBP", "Canada": "CAD", "Switzerland": "CHF",
    "Australia": "AUD", "Sweden": "SEK", "Denmark": "DKK", "Norway": "NOK", "China": "CNY/HKD", "Hong Kong": "HKD",
    "Taiwan": "TWD", "India": "INR", "South Korea": "KRW", "Brazil": "BRL", "Saudi Arabia": "SAR",
    "South Africa": "ZAR", "Mexico": "MXN", "Singapore": "SGD", "Israel": "ILS", "Poland": "PLN",
    **{c: "EUR" for c in ("France", "Germany", "Netherlands", "Spain", "Italy", "Belgium", "Finland", "Ireland",
                          "Austria", "Portugal", "Luxembourg", "Greece")},
}

SECTOR_KEYS = {
    "realestate": "Real Estate", "consumer_cyclical": "Consumer Cyclical", "basic_materials": "Basic Materials",
    "consumer_defensive": "Consumer Defensive", "technology": "Technology",
    "communication_services": "Communication Services", "financial_services": "Financial Services",
    "utilities": "Utilities", "industrials": "Industrials", "energy": "Energy", "healthcare": "Healthcare",
}

_SUFFIX = {"inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "nv", "sa", "se", "ag", "holding",
           "holdings", "group", "class", "a", "b", "c", "the", "ord", "shs", "adr", "spa", "asa", "ab", "oyj",
           "as", "n", "v", "s", "p", "com", "reg", "registered", "share", "shares", "de", "cv"}


def norm_name(name: str | None) -> str:
    toks = [t for t in re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).split() if t not in _SUFFIX]
    return " ".join(toks[:2])


def detect_profile(text: str) -> str:
    t = (text or "").lower()
    for rx, key in PROFILE_RULES:
        if re.search(rx, t):
            return key
    return "unknown"


def hedge_currency(name: str, base: str) -> str | None:
    t = (name or "").lower()
    if not re.search(r"hedg|\bhdg\b|\bhgd\b", t):
        return None
    for c in ("eur", "usd", "gbp", "chf"):
        if re.search(rf"\b{c}\b", t):
            return c.upper()
    return base


# listing suffix → country, used when Yahoo doesn't give the company's country
SUFFIX_COUNTRY = {
    "MC": "Spain", "AS": "Netherlands", "PA": "France", "DE": "Germany", "F": "Germany", "MU": "Germany",
    "SG": "Germany", "BE": "Germany", "DU": "Germany", "HM": "Germany", "HA": "Germany", "L": "United Kingdom",
    "IL": "United Kingdom", "MI": "Italy", "SW": "Switzerland", "CO": "Denmark", "ST": "Sweden", "OL": "Norway",
    "HE": "Finland", "LS": "Portugal", "BR": "Belgium", "VI": "Austria", "IR": "Ireland", "WA": "Poland",
    "T": "Japan", "HK": "Hong Kong", "SS": "China", "SZ": "China", "KS": "South Korea", "KQ": "South Korea",
    "TW": "Taiwan", "TWO": "Taiwan", "AX": "Australia", "NZ": "New Zealand", "TO": "Canada", "V": "Canada",
    "SA": "Brazil", "MX": "Mexico", "NS": "India", "BO": "India", "SI": "Singapore", "JO": "South Africa",
    "SR": "Saudi Arabia", "IS": "Turkey", "TA": "Israel",
}


def country_of(sym: str, meta: dict) -> str:
    if meta.get("country"):
        return meta["country"]
    if "." in sym:
        return SUFFIX_COUNTRY.get(sym.rsplit(".", 1)[1], "Unknown")
    return "United States"   # no suffix = US listing (ADRs without a Yahoo country stay approximate)


def fund_profile(sym: str, p: dict, meta: dict, fund: dict, overrides: dict) -> tuple[str, str]:
    """(auto-detected profile, profile in use)."""
    name = p.get("display_name") or meta.get("name") or sym
    text = " ".join(filter(None, [meta.get("long_name"), meta.get("name"), name, sym, (fund or {}).get("category"),
                                  meta.get("category")]))
    auto = detect_profile(text)
    return auto, overrides.get(sym) or auto


def needs_proxy(fund: dict | None) -> bool:
    return not fund or not (fund.get("holdings") or fund.get("sectors"))


def compute(positions: list[dict], meta: dict, funds: dict, overrides: dict, base: str,
            proxies: dict | None = None, ter_overrides: dict | None = None) -> dict:
    """positions: open rows from /api/portfolio (value in base). Returns exposure tables."""
    companies = defaultdict(lambda: {"name": None, "symbol": None, "direct": 0.0, "funds": 0.0, "via": defaultdict(float)})
    sectors = defaultdict(lambda: {"direct": 0.0, "funds": 0.0})
    countries = defaultdict(lambda: {"direct": 0.0, "funds": 0.0})
    currencies = defaultdict(lambda: {"direct": 0.0, "funds": 0.0})
    fund_info = []
    total = 0.0

    def add(table, key, kind, v):
        table[key][kind] += v

    # direct stocks indexed by ticker so fund holdings with a different spelling of the name still match
    by_ticker = {}
    for p in positions:
        sym = (p.get("symbol") or "").upper()
        m = meta.get(sym) or {}
        if (p.get("quote_type") or m.get("quote_type")) in ("EQUITY", None) and sym:
            key = norm_name(m.get("long_name") or m.get("name") or p.get("display_name") or sym) or sym.split(".")[0].lower()
            by_ticker[sym] = key
            if "." not in sym:
                by_ticker.setdefault(sym.split("-")[0], key)

    def holding_key(h):
        hs = (h.get("symbol") or "").upper()
        if hs in by_ticker:
            return by_ticker[hs]
        return norm_name(h.get("name")) or hs.split(".")[0].lower()

    for p in positions:
        v = p.get("value") if p.get("ok") else p.get("cost")
        if not v:
            continue
        total += v
        sym = (p.get("symbol") or "").upper()
        m = meta.get(sym) or {}
        qt = p.get("quote_type") or m.get("quote_type")
        name = p.get("display_name") or m.get("name") or sym
        if qt in ("ETF", "MUTUALFUND"):
            f = funds.get(sym) or {}
            auto, prof_key = fund_profile(sym, p, m, f, overrides)
            prof = PROFILES.get(prof_key, PROFILES["unknown"])
            own_ter = f.get("ter") or m.get("ter")
            proxy_used = None
            if needs_proxy(f) and prof.get("proxy") and (proxies or {}).get(prof["proxy"]):
                # Yahoo publishes nothing for this listing: borrow the composition of a fund tracking the same index
                proxy_used = prof["proxy"]
                f = {**proxies[proxy_used], "ter": None}
            # companies: top holdings + rest
            covered = 0.0
            for h in f.get("holdings") or []:
                w = float(h.get("weight") or 0)
                if w <= 0:
                    continue
                key = holding_key(h)
                c = companies[key]
                c["name"] = c["name"] or h.get("name")
                c["symbol"] = c["symbol"] or h.get("symbol")
                c["funds"] += v * w
                c["via"][sym] += v * w
                covered += w
            rest = max(0.0, 1.0 - covered)
            if rest > 1e-6:
                c = companies[f"__rest__{sym}"]
                c["name"] = f"Other holdings of {sym}"
                c["symbol"] = None
                c["funds"] += v * rest
                c["via"][sym] += v * rest
                c["rest"] = True
            # sectors (equity part) + asset classes
            ac = f.get("asset_classes") or {}
            stock = ac.get("stockPosition")
            stock = float(stock) if stock not in (None, "") else (0.0 if prof.get("asset") else 1.0)
            sw = {k: float(x) for k, x in (f.get("sectors") or {}).items() if x}
            ssum = sum(sw.values())
            if prof.get("asset") and not sw:
                add(sectors, prof["asset"], "funds", v)
            elif sw and ssum > 0:
                for k, x in sw.items():
                    add(sectors, SECTOR_KEYS.get(k, k.replace("_", " ").title()), "funds", v * stock * x / ssum)
                for k, label in (("bondPosition", "Bonds"), ("cashPosition", "Cash"), ("otherPosition", "Other"),
                                 ("preferredPosition", "Other"), ("convertiblePosition", "Bonds")):
                    x = ac.get(k)
                    if x:
                        add(sectors, label, "funds", v * float(x))
            else:
                add(sectors, "Unknown (fund)", "funds", v)
            # countries & currencies from the index profile
            hedge = hedge_currency(" ".join(filter(None, [m.get("long_name"), m.get("name"), name])), base)
            ctot = sum(prof["countries"].values())
            for country, w in prof["countries"].items():
                add(countries, country, "funds", v * w / ctot)
                ccy = hedge or prof.get("currency") or COUNTRY_CCY.get(country, "Other")
                add(currencies, ccy, "funds", v * w / ctot)
            ter_o = (ter_overrides or {}).get(sym)
            fund_info.append({"symbol": sym, "name": name, "value": v, "profile": prof_key, "auto_profile": auto,
                              "profile_label": prof["label"], "hedged_to": hedge, "top_covered": covered,
                              "n_holdings": len(f.get("holdings") or []), "has_sectors": bool(sw),
                              "ter": (ter_o / 100) if ter_o is not None else own_ter, "ter_manual": ter_o is not None,
                              "data": bool(f.get("holdings") or f.get("sectors")), "proxy": proxy_used})
        elif qt == "CRYPTOCURRENCY":
            key = f"__crypto__{sym}"
            companies[key].update(name=name, symbol=sym)
            companies[key]["direct"] += v
            add(sectors, "Crypto", "direct", v)
            add(countries, "Crypto (no country)", "direct", v)
            add(currencies, "Crypto", "direct", v)
        elif qt in ("EQUITY", None) and sym:
            key = norm_name(m.get("long_name") or m.get("name") or name) or sym.split(".")[0].lower()
            c = companies[key]
            c["name"] = name
            c["symbol"] = sym
            c["direct"] += v
            add(sectors, p.get("sector") or m.get("sector") or "Unknown", "direct", v)
            country = country_of(sym, m)
            add(countries, country, "direct", v)
            add(currencies, COUNTRY_CCY.get(country) or p.get("price_currency") or "Other", "direct", v)
        else:  # manual / other
            key = f"__manual__{p.get('id')}"
            companies[key].update(name=name, symbol=sym or None)
            companies[key]["direct"] += v
            add(sectors, "Unclassified", "direct", v)
            add(countries, "Unclassified", "direct", v)
            add(currencies, p.get("currency") or "Other", "direct", v)

    def table(d, extra=None):
        rows = []
        for k, x in d.items():
            t = x["direct"] + x["funds"]
            if t <= 0:
                continue
            row = {"key": k, "direct": x["direct"], "funds": x["funds"], "total": t, "pct": t / total * 100 if total else 0}
            if extra:
                row.update(extra(k, x))
            rows.append(row)
        return sorted(rows, key=lambda r: -r["total"])

    comp_rows = table(companies, lambda k, x: {
        "name": x["name"] or k, "symbol": x["symbol"], "rest": bool(x.get("rest")),
        "via": [{"fund": f, "value": val} for f, val in sorted(x["via"].items(), key=lambda kv: -kv[1])],
        "overlap": x["direct"] > 0 and x["funds"] > 0})
    return {
        "total": total,
        "companies": comp_rows,
        "sectors": table(sectors),
        "countries": table(countries),
        "currencies": table(currencies),
        "funds": fund_info,
        "overlaps": [r for r in comp_rows if r["overlap"]],
        "profiles": {k: v["label"] for k, v in PROFILES.items()},
    }
