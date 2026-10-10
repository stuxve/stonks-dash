import os
os.environ["STONKS_NO_AUTOAPP"] = "1"
os.environ["STONKS_NO_WARMUP"] = "1"
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import exposure, ledger, tax
from app.main import build_app


def lot(i, qty, cost, d, sym="X", acct="A"):
    return {"id": i, "symbol": sym, "account": acct, "quantity": qty, "avg_cost": cost, "currency": "EUR",
            "bought_at": d, "fees": None, "manual_price": None}


def sell(i, qty, price, d, sym="X", acct="A"):
    return {"id": i, "type": "SELL", "symbol": sym, "account": acct, "quantity": qty, "price": price,
            "currency": "EUR", "date": d, "fees": None}


FX = ledger.FxBook("EUR", {}, {})


def years_for(lots, sells, prior=None, through=2024):
    fr = ledger.fifo(lots, sells)
    rz = ledger.realized(lots, sells, [], fr, FX)
    return tax.compute_years(lots, sells, [], fr, rz, prior or {}, through=through)


def test_scale_2026():
    assert tax.scale(10000)[0] == pytest.approx(6000 * .19 + 4000 * .21)
    assert tax.scale(400000)[0] == pytest.approx(6000 * .19 + 44000 * .21 + 150000 * .23 + 100000 * .27 + 100000 * .30)


def test_losses_offset_25pct_of_dividends_and_carry_forward():
    carries = []
    y1 = tax.year_result(-1000, 2000, 0, carries, 2023)
    assert y1["base"] == pytest.approx(1500) and carries == [[2023, 500]]
    y2 = tax.year_result(800, 0, 0, carries, 2024)
    assert y2["base"] == pytest.approx(300) and carries == []
    carries = [[2018, 900]]
    assert tax.year_result(500, 0, 0, carries, 2023)["base"] == pytest.approx(500)   # 2018 loss expired


def test_two_month_rule_defers_then_releases():
    lots = [lot(1, 10, 100, "2024-01-02"), lot(2, 10, 60, "2024-03-01")]
    sells = [sell(1, 10, 50, "2024-03-15"), sell(2, 10, 70, "2024-06-03")]
    y = years_for(lots, sells)["years"][2024]
    assert y["blocked"] == pytest.approx(-500)          # Jan lot sold at a loss while Mar lot (≤2 months before) kept
    assert y["released"] == pytest.approx(-500)         # released when the Mar lot is sold
    assert y["gp"] == pytest.approx(-500 + 100)


def test_two_month_rule_partial_and_after_window():
    lots = [lot(1, 10, 100, "2024-01-02"), lot(2, 4, 60, "2024-04-10")]          # rebuy 4 units within 2 months after
    ys = years_for(lots, [sell(1, 10, 50, "2024-03-15")])
    assert ys["years"][2024]["blocked"] == pytest.approx(-500 * 0.4)
    assert ys["wash"]["pending"][0]["amount"] == pytest.approx(-200)
    lots = [lot(1, 10, 100, "2024-01-02"), lot(2, 4, 60, "2024-06-20")]          # > 2 months later: fine
    assert years_for(lots, [sell(1, 10, 50, "2024-03-15")])["years"][2024]["blocked"] == 0


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(db_path=str(tmp_path / "t.db"), provider="mock"))


def test_tax_endpoint(client):
    for p in client.get("/api/positions").json():
        client.delete(f"/api/positions/{p['id']}")
    today = date.today()
    d = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    client.post("/api/positions", json={"symbol": "AAPL", "quantity": 10, "avg_cost": 1e6, "currency": "USD", "bought_at": d(200)})
    client.post("/api/positions", json={"symbol": "MSFT", "quantity": 1, "avg_cost": 1, "currency": "USD", "bought_at": d(100)})
    client.post("/api/transactions", json={"type": "SELL", "symbol": "AAPL", "date": d(10), "quantity": 2,
                                          "price": 1, "currency": "USD"})
    client.put("/api/settings", json={"tax_prior_losses": {str(today.year - 1): 100}})
    t = client.get("/api/tax").json()
    assert t["currency"] == "EUR" and t["selected"]["year"] == today.year
    assert t["sales"][0]["gain"] < 0 and t["sales"][0]["rebuy_until"]
    assert any(w["kind"] == "rebuy" and w["symbol"] == "AAPL" for w in t["warnings"])
    assert [h["symbol"] for h in t["harvest"]] == ["AAPL"]
    assert t["simulation"]["positions"][-1]["symbol"] == "MSFT"   # sorted by gain, biggest gain last
    assert any(y["year"] == today.year - 1 for y in t["years"])


def test_profile_detection_and_hedge():
    assert exposure.detect_profile("iShsV-S&P500 EUR Hgd U.ETF AccR") == "sp500"
    assert exposure.hedge_currency("iShsV-S&P500 EUR Hgd U.ETF AccR", "USD") == "EUR"
    assert exposure.detect_profile("Vanguard FTSE All-World UCITS ETF") == "all_world"
    assert exposure.detect_profile("iShares Core MSCI World UCITS ETF") == "msci_world"
    assert exposure.detect_profile("iShares Core MSCI EM IMI UCITS ETF") == "emerging"
    assert exposure.norm_name("Amazon.com, Inc.") == exposure.norm_name("Amazon.com Inc")
    assert exposure.norm_name("Alphabet Inc Class A") == exposure.norm_name("Alphabet Inc. Class C")


def test_exposure_lookthrough_overlap():
    positions = [
        {"symbol": "SPX", "ok": True, "value": 1000, "quote_type": "ETF", "display_name": "iShares Core S&P 500"},
        {"symbol": "AMZN", "ok": True, "value": 100, "quote_type": "EQUITY", "display_name": "Amazon.com, Inc.",
         "sector": "Consumer Cyclical", "price_currency": "USD"},
    ]
    meta = {"SPX": {"quote_type": "ETF", "name": "iShares Core S&P 500"},
            "AMZN": {"quote_type": "EQUITY", "name": "Amazon.com, Inc.", "country": "United States"}}
    funds = {"SPX": {"holdings": [{"symbol": "AMZN", "name": "Amazon.com Inc", "weight": 0.04}],
                     "sectors": {"technology": 0.5, "consumer_cyclical": 0.5}, "asset_classes": {"stockPosition": 1.0}}}
    e = exposure.compute(positions, meta, funds, {}, "EUR")
    amzn = next(c for c in e["companies"] if c["symbol"] == "AMZN")
    assert amzn["direct"] == 100 and amzn["funds"] == pytest.approx(40) and amzn["overlap"]
    assert sum(c["total"] for c in e["companies"]) == pytest.approx(1100)
    assert next(c for c in e["countries"] if c["key"] == "United States")["total"] == pytest.approx(1100)
    assert next(s for s in e["sectors"] if s["key"] == "Consumer Cyclical")["total"] == pytest.approx(600)


def test_exposure_and_costs_endpoints(client):
    e = client.get("/api/exposure").json()
    assert e["funds"] and e["companies"] and abs(sum(r["pct"] for r in e["countries"]) - 100) < 1e-6
    client.put("/api/settings", json={"fund_profiles": {e["funds"][0]["symbol"]: "emerging"}})
    e2 = client.get("/api/exposure").json()
    assert e2["funds"][0]["profile"] == "emerging"
    # costs: clear fees of one account, set a rule, fill
    pos = client.get("/api/positions").json()
    for p in pos:
        if p["account"] == "Broker A":
            client.patch(f"/api/positions/{p['id']}", json={"fees": None})
    c = client.get("/api/costs").json()
    acct = next(a for a in c["by_account"] if a["key"] == "Broker A")
    assert acct["missing"] == acct["trades"] > 0
    assert client.post("/api/costs/fill", json={"account": "Broker A"}).status_code == 400
    client.put("/api/settings", json={"account_fees": {"Broker A": {"fixed": 1, "pct": 0.1, "min": 2}}})
    assert client.post("/api/costs/fill", json={"account": "Broker A"}).json()["updated"] == acct["trades"]
    c2 = client.get("/api/costs").json()
    a2 = next(a for a in c2["by_account"] if a["key"] == "Broker A")
    assert a2["missing"] == 0 and a2["fees"] > 0 and c2["summary"]["ongoing_per_year"] > 0


def test_exposure_matches_by_ticker_when_names_differ():
    positions = [
        {"symbol": "F", "ok": True, "value": 1000, "quote_type": "ETF", "display_name": "S&P 500 fund"},
        {"symbol": "NVDA", "ok": True, "value": 50, "quote_type": "EQUITY", "display_name": "NVDA Corp"},
    ]
    meta = {"NVDA": {"quote_type": "EQUITY", "name": "NVDA Corp", "country": "United States"}}
    funds = {"F": {"holdings": [{"symbol": "NVDA", "name": "NVIDIA Corp", "weight": 0.07}], "sectors": {}}}
    e = exposure.compute(positions, meta, funds, {}, "EUR")
    nv = [c for c in e["companies"] if c["symbol"] == "NVDA"]
    assert len(nv) == 1 and nv[0]["overlap"] and nv[0]["total"] == pytest.approx(120)


def test_exposure_fund_without_data_uses_proxy_and_old_meta_refreshed(client):
    # a European listing with no composition on Yahoo + a stock whose cached metadata predates "country"
    client.post("/api/positions", json={"symbol": "IBCF.MU", "quantity": 1, "avg_cost": 150, "currency": "EUR",
                                        "bought_at": "2026-01-05"})
    client.post("/api/positions", json={"symbol": "REP.MC", "quantity": 10, "avg_cost": 12, "currency": "EUR",
                                        "bought_at": "2026-01-05"})
    db = client.app.state.db
    db.put_meta("REP.MC", {"name": "REPSOL", "currency": "EUR", "quote_type": "EQUITY"})   # old cache, no country
    e = client.get("/api/exposure").json()
    f = next(x for x in e["funds"] if x["symbol"] == "IBCF.MU")
    assert f["profile"] == "sp500" and f["proxy"] == "SPY" and f["data"] and f["hedged_to"] == "EUR"
    assert not any(r["key"] == "Unknown" for r in e["countries"])
    assert "Unknown (fund)" not in [r["key"] for r in e["sectors"]]
    # manual TER
    client.put("/api/settings", json={"fund_ter": {"IBCF.MU": 0.2}})
    e = client.get("/api/exposure").json()
    assert next(x for x in e["funds"] if x["symbol"] == "IBCF.MU")["ter"] == pytest.approx(0.002)
    c = client.get("/api/costs").json()
    assert next(o for o in c["ongoing"] if o["symbol"] == "IBCF.MU")["ter"] == pytest.approx(0.002)


def test_country_fallback_by_suffix():
    assert exposure.country_of("REP.MC", {}) == "Spain"
    assert exposure.country_of("ASML.AS", {}) == "Netherlands"
    assert exposure.country_of("TSLA", {}) == "United States"
    assert exposure.country_of("TSM", {"country": "Taiwan"}) == "Taiwan"
