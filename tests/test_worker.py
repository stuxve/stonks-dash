import os
import time
from datetime import datetime

os.environ["STONKS_NO_WARMUP"] = "1"

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import alerts, crosses, worker as wk
from app.main import build_app


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(db_path=str(tmp_path / "t.db"), provider="mock"))


def _vshape(n_down=260, n_up=120):
    """Falls for a year, then rises: the 50-day average ends above the 200-day one (golden cross)."""
    p = np.r_[np.linspace(200, 100, n_down), np.linspace(100, 190, n_up)]
    return pd.Series(p, index=pd.bdate_range("2025-01-01", periods=len(p)))


def test_sma_cross_finds_golden_cross_and_its_date():
    s = _vshape()
    x = crosses.sma_cross(s)
    assert x["state"] == "golden" and x["gap_pct"] > 0
    f, sl = s.rolling(50).mean(), s.rolling(200).mean()
    first_above = (f > sl)[s.index >= s.index[260]].idxmax()
    assert x["last"]["date"] == first_above.date().isoformat()
    assert x["last"]["bars_ago"] == len(s) - 1 - s.index.get_loc(first_above)
    assert crosses.sma_cross(s.iloc[:150]) is None                       # < 200 closes
    down = crosses.sma_cross(pd.Series(300 - s.values, index=s.index))
    assert down["state"] == "death"


def test_completed_drops_todays_moving_bar():
    s = pd.Series([1.0, 2.0, 3.0], index=pd.to_datetime(["2026-11-17", "2026-11-18", "2026-11-19"]))
    assert len(crosses.completed(s, datetime(2026, 11, 19, 15, 0))) == 2   # US still trading
    assert len(crosses.completed(s, datetime(2026, 11, 19, 22, 30))) == 3  # after the close
    assert len(crosses.completed(s, datetime(2026, 11, 20, 9, 0))) == 3


def test_cross_alert_sent_once_per_new_cross(tmp_path):
    from app.db import DB
    db = DB(str(tmp_path / "a.db"))
    s = _vshape()
    info = crosses.sma_cross(s)
    snap = {"base": "EUR", "lots": [], "earnings": [], "crosses": [{"symbol": "ABC", "name": "Abc Inc", "ccy": "USD",
                                                                    "held": True, "info": info}]}
    m = alerts.Monitor(db, lambda: snap, lambda: "")
    m.save_config({"chat_id": 1})
    sent = []
    m.tg.call = lambda method, http_timeout=15, **p: sent.append(p) or {}
    m.token = lambda: "x"
    # first sight of a cross that is weeks old: remembered, not announced
    assert info["last"]["bars_ago"] > 2 and m.check() == []
    # the trend flips: one death-cross message, then nothing more
    dn = crosses.sma_cross(pd.Series(300 - s.values, index=s.index))
    dn["last"] = {**dn["last"], "bars_ago": 0}
    snap["crosses"][0]["info"] = dn
    out = m.check()
    assert len(out) == 1 and "Death cross — ABC" in out[0]["text"] and "below" in out[0]["text"]
    assert m.check() == []
    m.save_config({"events": {**m.config()["events"], "golden": False}})
    snap["crosses"][0]["info"] = info                                    # golden again, but switched off
    assert m.check() == []
    assert "200-day" in alerts.crosses_list(snap["crosses"])


def test_snapshots_ignore_results_started_before_a_clear():
    s = wk.Snapshots()
    t0 = time.time()
    s.clear()
    s.put("k", 1, started=t0 - 1)
    assert s.get("k", 60) is None
    s.put("k", 2, started=time.time())
    assert s.get("k", 60) == 2 and s.get("k", -1) is None


def test_worker_runs_jobs_and_reports_status():
    hits = []
    boom = wk.Job("boom", "Boom", lambda: 1 / 0, 0.1, 0.1)
    ok = wk.Job("ok", "Ok", lambda: hits.append(1), 0.1, 0.1)
    w = wk.Worker([ok, boom], busy=lambda: True)
    w._run(ok, True)
    w._run(boom, True)
    st = {j["name"]: j for j in w.status()["jobs"]}
    assert hits == [1] and st["ok"]["last_ok"] and st["ok"]["runs"] == 1
    assert "ZeroDivisionError" in st["boom"]["last_error"] and st["boom"]["errors"] == 1
    assert w.run_now("ok") == 1 and ok.next_at == 0


def test_page_and_alerts_share_the_portfolio_snapshot(client):
    app = client.app
    p1 = client.get("/api/portfolio?base=EUR").json()
    assert client.get("/api/portfolio?base=EUR").json()["as_of"] == p1["as_of"]     # served from the snapshot
    for j in ("portfolio", "levels", "alerts", "moves", "boards", "earnings", "performance"):
        app.state.worker.jobs[j].fn()                                              # what the worker does
    p2 = client.get("/api/portfolio?base=EUR").json()
    sn = app.state.alerts.snapshot()
    assert sn["port"]["as_of"] == p2["as_of"] and sn["port"]["totals"]["pnl"] == p2["totals"]["pnl"]
    assert isinstance(sn["crosses"], list) and all(x["info"]["state"] in ("golden", "death") for x in sn["crosses"])
    # an edit clears the snapshot: the next read includes it
    n = len(p2["positions"])
    client.post("/api/positions", json={"symbol": "MSFT", "quantity": 1, "avg_cost": 10, "currency": "USD"})
    assert len(client.get("/api/portfolio?base=EUR").json()["positions"]) == n + 1
    st = client.get("/api/worker").json()
    assert {j["name"] for j in st["jobs"]} >= {"portfolio", "alerts", "boards"} and "busy" in st
    assert client.post("/api/worker/run?job=nope").status_code == 404
    assert "crosses" in client.get("/api/alerts").json()
