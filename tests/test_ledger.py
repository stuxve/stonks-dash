import os
os.environ["STONKS_NO_AUTOAPP"] = "1"
os.environ["STONKS_NO_WARMUP"] = "1"
from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import ledger
from app.main import build_app


def lot(i, qty, cost, d, ccy="EUR", sym="X", acct="A", fees=None):
    return {"id": i, "symbol": sym, "account": acct, "quantity": qty, "avg_cost": cost, "currency": ccy,
            "bought_at": d, "fees": fees, "manual_price": None}


def sell(i, qty, price, d, ccy="EUR", sym="X", acct="A", fees=None):
    return {"id": i, "type": "SELL", "symbol": sym, "account": acct, "quantity": qty, "price": price,
            "currency": ccy, "date": d, "fees": fees}


def test_fifo_consumes_oldest_first_per_account():
    lots = [lot(2, 5, 20, "2024-06-01"), lot(1, 10, 10, "2024-01-01"), lot(3, 10, 30, "2024-02-01", acct="B")]
    fr = ledger.fifo(lots, [sell(1, 12, 25, "2024-07-01")])
    assert fr.remaining == {1: 0, 2: 3, 3: 10}           # account B untouched
    assert [(m.lot_id, m.qty) for m in fr.matches] == [(1, 10), (2, 2)]
    assert not fr.shortfalls


def test_fifo_cannot_sell_lots_bought_later():
    lots = [lot(1, 10, 10, "2024-05-01")]
    fr = ledger.fifo(lots, [sell(1, 1, 10, "2024-04-01")])
    assert fr.shortfalls and fr.shortfalls[0]["held"] == 0


def test_realized_with_fees_and_historical_fx():
    idx = pd.to_datetime(["2024-01-01", "2024-07-01"])
    fx = ledger.FxBook("EUR", {"USD": 0.9}, {"USD": pd.Series([0.80, 0.95], index=idx)})
    lots = [lot(1, 10, 100, "2024-01-01", ccy="USD", fees=10)]            # cost 1010 USD @0.80 = 808 EUR
    sells = [sell(1, 5, 150, "2024-07-01", ccy="USD", fees=5)]            # proceeds 745 USD @0.95 = 707.75 EUR
    fr = ledger.fifo(lots, sells)
    rz = ledger.realized(lots, sells, [], fr, fx)
    r = rz["per_sell"][1]
    assert r["cost"] == pytest.approx(505 * 0.80)
    assert r["proceeds"] == pytest.approx(745 * 0.95)
    assert rz["years"][2024]["net"] == pytest.approx(745 * 0.95 - 505 * 0.80)
    assert rz["years"][2024]["fees"] == pytest.approx(10 * 0.80 + 5 * 0.95)


def test_xirr_simple_year():
    r = ledger.xirr([(date(2023, 1, 1), -1000), (date(2024, 1, 1), 1100)])
    assert r == pytest.approx(0.10, abs=2e-3)
    assert ledger.xirr([(date(2023, 1, 1), -1000)]) is None


def test_shadow_benchmark_matches_index_when_you_buy_the_index():
    """If you buy the benchmark itself, the shadow portfolio must equal your portfolio."""
    idx = pd.date_range("2024-01-01", "2024-12-31", freq="D")
    px = pd.Series(range(100, 100 + len(idx)), index=idx, dtype=float)
    lots = [lot(1, 10, 100, "2024-01-01", sym="IDX"), lot(2, 5, float(px[pd.Timestamp("2024-06-03")]), "2024-06-03", sym="IDX")]
    sells = [sell(1, 3, float(px[pd.Timestamp("2024-09-02")]), "2024-09-02", sym="IDX")]
    fx = ledger.FxBook("EUR", {}, {})
    fr = ledger.fifo(lots, sells)
    rz = ledger.realized(lots, sells, [], fr, fx)
    held = sum(fr.remaining.values())
    perf = ledger.performance(lots, sells, [], fr, rz, fx, {"IDX": px}, {"IDX": "EUR"}, px, "EUR",
                              value_now=held * float(px.iloc[-1]), today=date(2024, 12, 31))
    s = perf["summary"]
    assert s["bench_now"] == pytest.approx(s["value_now"], rel=1e-6)
    assert s["alpha"] == pytest.approx(0, abs=1e-6)
    assert s["xirr"] == pytest.approx(s["bench_xirr"], abs=1e-6)


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(db_path=str(tmp_path / "t.db"), provider="mock"))


def test_sell_flow_end_to_end(client):
    for p in client.get("/api/positions").json():
        client.delete(f"/api/positions/{p['id']}")
    a = client.post("/api/positions", json={"symbol": "AAPL", "quantity": 10, "avg_cost": 100, "currency": "USD",
                                            "account": "TR", "bought_at": "2025-01-10", "fees": 1}).json()["id"]
    client.post("/api/positions", json={"symbol": "AAPL", "quantity": 5, "avg_cost": 120, "currency": "USD",
                                        "account": "TR", "bought_at": "2025-06-10"})
    # selling more than held is refused
    r = client.post("/api/transactions", json={"type": "SELL", "symbol": "AAPL", "account": "TR", "date": "2025-08-01",
                                              "quantity": 20, "price": 150, "currency": "USD"})
    assert r.status_code == 400 and "held only" in r.json()["detail"]
    sid = client.post("/api/transactions", json={"type": "SELL", "symbol": "aapl", "account": "TR", "date": "2025-08-01",
                                                "quantity": 12, "price": 150, "currency": "USD", "fees": 1}).json()["id"]
    client.post("/api/transactions", json={"type": "DIVIDEND", "symbol": "AAPL", "account": "TR", "date": "2025-09-01",
                                          "amount": 3, "withholding": 0.45, "currency": "USD"})
    port = client.get("/api/portfolio?base=USD").json()
    assert [round(p["quantity"], 6) for p in port["positions"]] == [3]       # 10 + 5 − 12, oldest gone
    t = port["totals"]
    assert t["realized"] != 0 and t["dividends"] == pytest.approx(2.55)
    assert "vs_bench" in t and port["benchmark"]["ok"]
    # the first lot can't be shrunk below what the sale consumed
    assert client.patch(f"/api/positions/{a}", json={"quantity": 2}).status_code == 400
    assert client.delete(f"/api/positions/{a}").status_code == 400
    led = client.get("/api/ledger?base=USD").json()
    kinds = sorted(e["kind"] for e in led["events"])
    assert kinds == ["BUY", "BUY", "DIVIDEND", "SELL"]
    s = next(e for e in led["events"] if e["kind"] == "SELL")
    assert [round(x["qty"], 6) for x in s["lots"]] == [10, 2]
    assert led["years"]["2025"]["sells"] == 1
    perf = client.get("/api/performance?base=EUR").json()
    assert perf["dates"][0] == "2025-01-10" and perf["summary"]["xirr"] is not None
    assert len(perf["bench"]) == len(perf["dates"])
    # deleting the sale restores the lots
    client.delete(f"/api/transactions/{sid}")
    assert sum(p["quantity"] for p in client.get("/api/portfolio").json()["positions"]) == 15
