import os
from datetime import date, timedelta

os.environ["STONKS_NO_WARMUP"] = "1"

import pytest
from fastapi.testclient import TestClient

from app import alerts, dividends
from app.main import build_app

TODAY = date(2026, 11, 23)


def q_hist(last: date, n=8, amt=0.5, gap=91):
    return [[(last - timedelta(days=gap * i)).isoformat(), amt] for i in range(n)][::-1]


def test_quarterly_payer_next_date_estimated_from_spacing():
    a = dividends.analyze(q_hist(date(2026, 9, 10)), None, None, 50.0, TODAY)
    assert a["freq"] == 4 and a["freq_label"] == "quarterly"
    assert a["forward"] == pytest.approx(2.0) and a["ttm"] == pytest.approx(2.0)
    assert a["yield_ttm"] == pytest.approx(4.0)
    n = a["next"]
    assert n["estimated"] and n["ex"] == (date(2026, 9, 10) + timedelta(days=91)).isoformat() and n["amount"] == 0.5
    assert len(a["schedule"]) == 4 and not a["stopped"]


def test_published_ex_date_wins_and_special_dividend_ignored_for_forward():
    h = q_hist(date(2026, 9, 10)) + [["2026-10-01", 5.0]]        # one-off special payment
    a = dividends.analyze(h, "2026-12-05", "2026-12-20", 50.0, TODAY)
    assert a["next"] == {**a["next"], "ex": "2026-12-05", "estimated": False, "pay": "2026-12-20", "days": 12}
    assert a["forward"] == pytest.approx(2.0)                     # regular amount, not the special one


def test_stopped_payer_and_non_payer():
    a = dividends.analyze(q_hist(date(2025, 12, 1)), None, None, 50.0, TODAY)
    assert a["stopped"] and a["next"] is None
    b = dividends.analyze([], None, None, 50.0, TODAY)
    assert not b["pays"] and b["next"] is None and b["forward"] is None


def test_pending_payment_after_ex_date():
    a = dividends.analyze(q_hist(date(2026, 11, 14)), "2026-11-14", "2026-11-30", 50.0, TODAY)
    assert a["pending_pay"] == {"ex": "2026-11-14", "pay": "2026-11-30", "amount": 0.5, "days": 7}


def test_follow_up_matches_recorded_dividends():
    lots = [{"id": 1, "symbol": "X", "quantity": 10, "bought_at": "2026-01-15"}]
    sells = [{"symbol": "X", "quantity": 4, "date": "2026-07-01"}]
    divs = [{"id": 9, "symbol": "X", "date": "2026-04-02", "amount": 5.0, "currency": "USD"}]
    h = [["2025-12-10", 0.5], ["2026-03-10", 0.5], ["2026-06-10", 0.5], ["2026-09-10", 0.5], ["2026-11-10", 0.5]]
    fu = {e["ex"]: e for e in dividends.follow_up(h, lots, sells, divs, TODAY)}
    assert "2025-12-10" not in fu                                    # bought later
    assert fu["2026-03-10"]["status"] == "recorded" and fu["2026-03-10"]["tx"]["id"] == 9
    assert fu["2026-06-10"]["status"] == "missing" and fu["2026-06-10"]["units"] == 10
    assert fu["2026-09-10"]["units"] == 6 and fu["2026-09-10"]["gross"] == pytest.approx(3.0)
    assert fu["2026-11-10"]["status"] == "awaiting"


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(db_path=str(tmp_path / "t.db"), provider="mock"))


def test_dividends_endpoint_and_recording_clears_follow_up(client):
    d = client.get("/api/dividends?base=EUR").json()
    kinds = [x["kind"] for x in d["items"]]
    assert kinds == sorted(kinds, key=["pays", "stopped", "none", "none_fund", "accumulating", "na"].index)
    payers = [x for x in d["items"] if x["kind"] == "pays"]
    assert payers and d["totals"]["annual"] == pytest.approx(sum(x["annual_base"] for x in payers))
    miss = next(((x, e) for x in d["items"] for e in x["follow_up"] if e["status"] == "missing"), None)
    assert miss, "mock portfolio should have an unrecorded past dividend"
    x, e = miss
    client.post("/api/transactions", json={"type": "DIVIDEND", "symbol": x["symbol"], "date": e["ex"],
                                          "amount": round(e["gross"], 4), "withholding": 0, "currency": x["currency"]})
    d2 = client.get("/api/dividends?base=EUR").json()
    x2 = next(i for i in d2["items"] if i["symbol"] == x["symbol"])
    assert next(f for f in x2["follow_up"] if f["ex"] == e["ex"])["status"] == "recorded"
    assert x2["received"]["count"] == 1 and d2["totals"]["missing"] == d["totals"]["missing"] - 1


def test_dividend_telegram_message_once(tmp_path):
    from app.db import DB
    x = {"symbol": "MSFT", "currency": "USD", "units": 2.0, "pending_pay": None,
         "next": {"ex": "2026-11-24", "days": 1, "estimated": False, "amount": 0.91, "amount_known": True,
                  "pay": "2026-12-11", "expected": 1.82, "expected_base": 1.67}}
    snap = {"base": "EUR", "lots": [], "earnings": [], "crosses": [], "dividends": [x]}
    m = alerts.Monitor(DB(str(tmp_path / "a.db")), lambda: snap, lambda: "")
    m.save_config({"chat_id": 1})
    m.tg.call = lambda method, http_timeout=15, **p: {}
    m.token = lambda: "x"
    out = m.check()
    assert len(out) == 1 and "MSFT goes ex-dividend tomorrow" in out[0]["text"] and "1,82 US$" in out[0]["text"]
    assert m.check() == []
    x["next"]["estimated"] = True                                    # our own guesses never alert
    x["next"]["ex"] = "2026-11-25"
    assert m.check() == []
