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


def test_short_yahoo_history_is_retried_soon(tmp_path):
    """A batch answer with only a few days for one ticker must not be cached for hours."""
    from datetime import date, timedelta
    from app.db import DB
    from app.market import QuoteEngine

    calls = []

    class P:
        name = "fake"

        def closes(self, symbols, start=None, period=None):
            calls.append(tuple(symbols))
            n = 5 if len(calls) == 1 else 300
            idx = pd.bdate_range(end=pd.Timestamp(date.today()), periods=n)
            return {s: pd.Series(100.0, index=idx) for s in symbols}

        def meta(self, symbols):
            return {}

    eng = QuoteEngine(P(), DB(str(tmp_path / "e.db")), history_ttl=6 * 3600)
    eng.meta = lambda syms: {}
    start = date.today() - timedelta(days=400)
    assert len(eng.history(["MCD"], start)["MCD"]) == 5
    t, _, _ = eng._full["MCD"]
    assert time.time() - t > 6 * 3600 - 700                # expires ~10 min from now, not in 6 h
    eng._full["MCD"] = (t - 700, *eng._full["MCD"][1:])     # 10 minutes later…
    assert len(eng.history(["MCD"], start)["MCD"]) == 300 and len(calls) == 2


def test_live_events_stream_pushes_refreshes(client):
    import threading
    snap = client.app.state.snap

    def push():
        snap.refresh("port:EUR", lambda: {"positions": [{"id": 1, "price": 10.0, "quantity": 1}], "as_of": 1})
        snap.refresh("port:EUR", lambda: {"positions": [{"id": 1, "price": 10.0, "quantity": 1}], "as_of": 2})
        snap.refresh("heat:9:EUR", lambda: {"tiles": [], "as_of": 3})      # not watched: not sent
        snap.refresh("port:EUR", lambda: {"positions": [{"id": 1, "price": 10.5, "quantity": 1}], "as_of": 4})
    threading.Timer(0.5, push).start()
    with client.stream("GET", "/api/events?watch=port:eur,bogus:1&limit=3") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    events = [blk for blk in body.split("\n\n") if blk.startswith("event:")]
    assert events[0].startswith("event: hello") and '"watch": ["port:EUR"]' in events[0]
    ups = [json_load(e) for e in events[1:]]
    assert [u["key"] for u in ups] == ["port:EUR"] * 3
    assert [u["changed"] for u in ups] == [True, False, True]          # same prices → only the clock moves
    assert client.app.state.bus.clients() == 0                            # unsubscribed when the stream ends


def json_load(block):
    import json
    return json.loads(block.split("data: ", 1)[1])


def test_view_preferences_dont_clear_shared_results(client):
    snap = client.app.state.snap
    client.get("/api/portfolio?base=EUR")
    assert snap.age("port:EUR") is not None
    client.put("/api/settings", json={"p_mapview": "pnl", "live_seconds": 20})
    assert snap.age("port:EUR") is not None
    client.put("/api/settings", json={"benchmark": "IWDA.AS"})
    assert snap.age("port:EUR") is None
    st = client.get("/api/worker").json()["live"]
    assert st["seconds"] == 20 and st["clients"] == 0


def test_chart_endpoint_ranges(client):
    d1 = client.get("/api/chart?symbol=SAN.MC&range=1D").json()
    assert d1["intraday"] and len(d1["points"]) >= 2 and d1["ref"] == pytest.approx(d1["prev_close"])
    days = {time.strftime("%Y-%m-%d", time.localtime(t / 1000)) for t, _ in d1["points"]}
    assert len(days) == 1                                                   # one session only
    y = client.get("/api/chart?symbol=SAN.MC&range=1Y").json()
    assert not y["intraday"] and 240 <= len(y["points"]) <= 270 and y["ref"] == y["points"][0][1]
    assert y["change_pct"] == pytest.approx((y["last"] / y["ref"] - 1) * 100)
    mx = client.get("/api/chart?symbol=SAN.MC&range=max").json()
    assert len(mx["points"]) <= 500 and mx["points"][-1][0] <= time.time() * 1000 + 86400e3
    assert client.get("/api/chart?symbol=SAN.MC&range=5Y").status_code == 400
    assert client.get("/api/chart?symbol=bad sym&range=1Y").status_code == 400


def test_premarket_endpoint(client):
    client.put("/api/settings", json={"ranges": {"extra": ["AAPL", "SAN.MC"]}})
    d = client.get("/api/premarket?base=EUR").json()
    assert d["phase"]["k"] in ("pre", "regular", "post", "closed")
    assert {f["symbol"] for f in d["futures"]} >= {"ES=F", "NQ=F", "^VIX"}
    syms = [r["symbol"] for r in d["rows"]]
    assert "MSFT" in syms and "AAPL" in syms and "SAN.MC" not in syms      # US listings only
    for r in d["rows"]:
        if r["price"] is not None:
            assert r["change_pct"] == pytest.approx((r["price"] / r["regular"] - 1) * 100)
            assert r["kind"] in ("pre", "post")
        if r["held"] and r["impact"] is not None:
            assert abs(r["impact"]) < r["value"]
    assert d["totals"]["impact"] == pytest.approx(sum(r["impact"] or 0 for r in d["rows"]))
    assert next(r for r in d["rows"] if r["symbol"] == "AAPL")["impact"] is None   # watch only: no P&L


def test_implied_etf_move_math():
    import pandas as pd
    from app import implied
    g = implied.gauges_for({"United States": 70.0, "Japan": 10.0, "Other": 20.0})
    assert set(g) == {"United States", "Japan"} and g["United States"][3] == pytest.approx(0.875)
    t0 = pd.Timestamp("2026-11-23 16:30", tz="UTC")
    idx = pd.date_range("2026-11-23 12:00", periods=40, freq="30min", tz="UTC")
    es = pd.Series(100.0, index=idx); es.iloc[-1] = 101.0                  # +1% since t0
    nk = pd.Series(200.0, index=idx); nk.iloc[-1] = 196.0                  # −2%
    usd = pd.Series(1.10, index=idx); usd.iloc[-1] = 1.10 * 1.005          # EURUSD +0.5%: dollar weaker
    assert implied.move_since(es, t0) == pytest.approx(0.01)
    assert implied.move_since(es, pd.Timestamp("2026-11-20", tz="UTC")) is None   # no bar that early
    m = {"ES=F": implied.move_since(es, t0), "^N225": implied.move_since(nk, t0)}
    fx = {"USD": implied.move_since(usd, t0)}
    hedged = implied.estimate(g, m, fx, "EUR", hedged=True)
    assert hedged["move"] == pytest.approx(0.875 * 0.01 + 0.125 * -0.02)
    unhedged = implied.estimate(g, m, fx, "EUR", hedged=False)
    us = next(d for d in unhedged["drivers"] if d["country"] == "United States")
    assert us["fx"] == pytest.approx(1 / 1.005 - 1) and unhedged["move"] < hedged["move"]


def test_premarket_includes_european_etfs(client):
    import pandas as pd
    client.app.state.clock = lambda: pd.Timestamp.now(tz="Europe/Madrid").normalize().tz_convert("UTC") + pd.Timedelta(hours=22)
    d = client.get("/api/premarket?base=EUR").json()
    syms = {r["symbol"]: r for r in d["etfs"]}
    assert {"VWCE.DE", "IWDA.AS", "IS3N.DE"} <= set(syms) and "MSFT" not in syms
    r = syms["IWDA.AS"]
    assert r["state"] == "closed" and r["profile"].startswith("MSCI World") and r["move_pct"] is not None
    assert r["drivers"][0]["country"] == "United States" and r["drivers"][0]["label"] == "S&P 500 futures"
    assert sum(x["weight_pct"] for x in r["drivers"]) <= 100.01


def test_isin_listing_without_prices_is_resolved(client):
    res = client.get("/api/search?q=IE00TEST0001").json()
    assert res[0]["symbol"] == "DWXU.DE" and res[-1]["symbol"] == "IE00TEST0001.SG" and res[-1]["no_prices"]
    assert not client.get("/api/quote/IE00TEST0001.SG").json()["ok"]
    r = client.get("/api/resolve?symbol=ie00test0001.sg").json()
    assert r["resolved"] and r["symbol"] == "DWXU.DE" and r["from"] == "IE00TEST0001.SG" and "Xetra" in r["reason"]
    assert client.get("/api/resolve?symbol=MSFT").json() == {"symbol": "MSFT", "resolved": False, "name": "MSFT Corp"}
    miss = client.get("/api/resolve?symbol=ZZ00NOPE0001.SG").json()
    assert miss["symbol"] is None and "no other listing" in miss["reason"]
