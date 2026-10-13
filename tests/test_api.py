import os
os.environ["STONKS_NO_AUTOAPP"] = "1"
os.environ["STONKS_NO_WARMUP"] = "1"
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from app.main import build_app
from app.market import compute_changes, normalize_currency


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(db_path=str(tmp_path / "t.db"), provider="mock"))


def test_compute_changes():
    idx = pd.bdate_range("2025-01-01", "2026-10-08")
    s = pd.Series(range(1, len(idx) + 1), index=idx, dtype=float)
    last, prev, ch, ld = compute_changes(s)
    assert last == len(idx) and prev == len(idx) - 1
    assert ch["1D"] == pytest.approx((last / prev - 1) * 100, abs=1e-3)
    ytd_ref = s[s.index <= "2025-12-31"].iloc[-1]
    assert ch["YTD"] == pytest.approx((last / ytd_ref - 1) * 100, abs=1e-3)
    assert ld == "2026-10-08"


def test_subunit():
    assert normalize_currency("GBp") == ("GBP", 100.0)
    assert normalize_currency("EUR") == ("EUR", 1.0)


def test_boards_seeded_and_heatmap(client):
    boards = client.get("/api/boards").json()
    assert len(boards) >= 6
    hm = client.get(f"/api/boards/{boards[0]['id']}/heatmap?base=USD").json()
    assert hm["base"] == "USD" and len(hm["tiles"]) == len(boards[0]["items"])
    t = hm["tiles"][0]
    assert t["ok"] and set(hm["periods"]) <= set(t["changes"])


def test_gbp_pence_normalized(client):
    q = client.get("/api/quote/AZN.L").json()
    assert q["currency"] == "GBP"


def test_board_crud(client):
    b = client.post("/api/boards", json={"name": "Mine"}).json()
    it = client.post(f"/api/boards/{b['id']}/items", json={"symbol": "aapl", "group_name": "X"}).json()
    client.patch(f"/api/items/{it['id']}", json={"weight": 3})
    board = [x for x in client.get("/api/boards").json() if x["id"] == b["id"]][0]
    assert board["items"][0]["symbol"] == "AAPL" and board["items"][0]["weight"] == 3
    client.patch(f"/api/boards/{b['id']}", json={"config": {"size_mode": "equal"}})
    assert [x for x in client.get("/api/boards").json() if x["id"] == b["id"]][0]["config"]["size_mode"] == "equal"
    assert client.delete(f"/api/boards/{b['id']}").status_code == 204


def test_portfolio_math_and_fx(client):
    for p in client.get("/api/positions").json():
        client.delete(f"/api/positions/{p['id']}")
    r = client.post("/api/positions", json={"name": "Fund X", "quantity": 10, "avg_cost": 100,
                                            "currency": "EUR", "manual_price": 110})
    assert r.status_code == 201
    eur = client.get("/api/portfolio?base=EUR").json()
    assert eur["totals"]["value"] == pytest.approx(1100)
    assert eur["totals"]["pnl_pct"] == pytest.approx(10)
    usd = client.get("/api/portfolio?base=USD").json()
    assert usd["totals"]["value"] == pytest.approx(1100 * usd["fx"]["EUR"])
    assert usd["totals"]["pnl_pct"] == pytest.approx(10)
    # validation
    assert client.post("/api/positions", json={"quantity": 1, "avg_cost": 1}).status_code == 400
    assert client.post("/api/positions", json={"symbol": "X", "quantity": -1, "avg_cost": 1}).status_code == 422
    assert client.get("/api/portfolio?base=JPY").status_code == 400


def test_unknown_symbol_doesnt_break(client):
    client.app.state.provider.fail.add("ZZZZ")
    b = client.post("/api/boards", json={"name": "bad"}).json()
    client.post(f"/api/boards/{b['id']}/items", json={"symbol": "ZZZZ"})
    client.post(f"/api/boards/{b['id']}/items", json={"symbol": "AAPL"})
    tiles = client.get(f"/api/boards/{b['id']}/heatmap").json()["tiles"]
    assert [t["ok"] for t in tiles] == [False, True]


def test_export_import_roundtrip(client):
    data = client.get("/api/export").json()
    n_boards, n_pos = len(data["boards"]), len(data["positions"])
    assert client.post("/api/import", json=data).json()["ok"]
    again = client.get("/api/export").json()
    assert len(again["boards"]) == n_boards and len(again["positions"]) == n_pos


def _fake_yf_frame(symbols):
    idx = pd.to_datetime(["2026-10-06", "2026-10-07", "2026-10-08"])
    cols = pd.MultiIndex.from_product([symbols, ["Open", "High", "Low", "Close", "Adj Close", "Volume"]])
    df = pd.DataFrame(1.0, index=idx, columns=cols)
    for i, s in enumerate(symbols):
        df[(s, "Close")] = [100.0, 101.0, 102.0 + i]
    df[(symbols[-1], "Close")] = float("nan")  # one symbol with no data at all
    return df


def test_yahoo_parsing_and_meta_failure(tmp_path, monkeypatch):
    from app.market import YahooProvider, QuoteEngine
    from app.db import DB
    import yfinance as yf
    monkeypatch.setenv("STONKS_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(yf, "download", lambda tickers, **kw: _fake_yf_frame(list(tickers)))
    p = YahooProvider()
    out = p.closes(["AAA", "BBB", "DEAD"], period="5d")
    assert set(out) == {"AAA", "BBB"} and out["BBB"].iloc[-1] == 103.0

    class FailingTicker:
        def __init__(self, s): pass
        def get_info(self): raise RuntimeError("429")
        @property
        def fast_info(self): raise RuntimeError("429")
    monkeypatch.setattr(yf, "Ticker", FailingTicker)
    db = DB(str(tmp_path / "x.db"))
    eng = QuoteEngine(p, db)
    qs = eng.quotes(["AAA", "DEAD"])
    q = qs["AAA"]
    assert not qs["DEAD"].ok
    assert q.ok and q.price == 102.0
    assert db.get_meta(["AAA"], 1e9) == {}  # failure must not be cached as "USD"


def test_sessions_endpoint(client):
    from datetime import datetime, timezone
    from app.sessions import SessionService
    d = client.get("/api/sessions").json()
    codes = [e["code"] for e in d["exchanges"]]
    assert "XNYS" in codes and "CRYPTO" in codes and len(d["catalog"]) > len(codes)
    nyse = next(e for e in d["exchanges"] if e["code"] == "XNYS")
    assert nyse["tz"] == "America/New_York" and nyse["sessions"] and nyse["ext"]
    s = nyse["sessions"][0]
    assert s["c"] - s["o"] in (6.5 * 3600_000, 3.5 * 3600_000)   # regular or early close
    tokyo = SessionService().build(["XTKS"])[0]
    assert all(x["bs"] and x["be"] for x in tokyo["sessions"])     # lunch break present
    # Thanksgiving 2026 is a holiday, the day after is an early close
    svc = SessionService(back_days=1, fwd_days=6)
    ny = svc.build(["XNYS"], now=datetime(2026, 11, 24, 12, tzinfo=timezone.utc))[0]
    assert {"date": "2026-11-26", "name": "Thanksgiving"} in ny["holidays"]
    assert any(e["date"] == "2026-11-27" for e in ny["early"])
    # FX: one Sun 17:00 → Fri 17:00 NY session per week
    fx = svc.build(["FX"])[0]
    assert all(x["c"] - x["o"] == 5 * 86400_000 for x in fx["sessions"])
    # chooser
    client.put("/api/settings", json={"sessions_exchanges": ["XMAD", "XTKS"]})
    assert [e["code"] for e in client.get("/api/sessions").json()["exchanges"]] == ["XMAD", "XTKS"]


def test_quotes_endpoint(client):
    q = client.get("/api/quotes?symbols=^GSPC,AAPL").json()
    assert q["^GSPC"]["ok"] and "spark" not in q["AAPL"]


def test_purchase_date_and_migration(client, tmp_path):
    import sqlite3
    from datetime import date, timedelta
    from app.db import DB
    r = client.post("/api/positions", json={"symbol": "AAPL", "quantity": 1, "avg_cost": 100,
                                            "currency": "USD", "bought_at": "2025-03-12"})
    pid = r.json()["id"]
    row = next(p for p in client.get("/api/portfolio").json()["positions"] if p["id"] == pid)
    assert row["bought_at"] == "2025-03-12"
    client.patch(f"/api/positions/{pid}", json={"bought_at": "2024-01-02"})
    assert next(p for p in client.get("/api/positions").json() if p["id"] == pid)["bought_at"] == "2024-01-02"
    future = (date.today() + timedelta(days=5)).isoformat()
    assert client.patch(f"/api/positions/{pid}", json={"bought_at": future}).status_code == 400
    assert client.patch(f"/api/positions/{pid}", json={"bought_at": "not-a-date"}).status_code == 422
    assert any(p.get("bought_at") == "2024-01-02" for p in client.get("/api/export").json()["positions"])
    # a database created before the column existed gets migrated in place
    old = tmp_path / "old.db"
    c = sqlite3.connect(old)
    c.execute("CREATE TABLE positions (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, name TEXT, quantity REAL NOT NULL, "
              "avg_cost REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', account TEXT, group_name TEXT, "
              "manual_price REAL, notes TEXT, created_at REAL NOT NULL)")
    c.execute("INSERT INTO positions(symbol, quantity, avg_cost, created_at) VALUES ('MSFT', 1, 1, 0)")
    c.commit(); c.close()
    db = DB(str(old))
    assert db.list_positions()[0]["bought_at"] is None


def test_sell_targets(client):
    r = client.post("/api/positions", json={"symbol": "AAPL", "quantity": 2, "avg_cost": 100, "currency": "USD",
                                            "bought_at": "2025-06-02", "target_price": 300, "stop_price": 80})
    assert r.status_code == 201
    pid = r.json()["id"]
    row = next(p for p in client.get("/api/portfolio").json()["positions"] if p["id"] == pid)
    assert row["target_price"] == 300 and row["stop_price"] == 80 and row["trail_pct"] is None
    # partial updates keep the other exits; clearing with null works
    assert client.patch(f"/api/positions/{pid}", json={"trail_pct": 12.5}).status_code == 200
    assert client.patch(f"/api/positions/{pid}", json={"stop_price": None}).status_code == 200
    p = next(p for p in client.get("/api/positions").json() if p["id"] == pid)
    assert (p["target_price"], p["stop_price"], p["trail_pct"]) == (300, None, 12.5)
    # stop must stay below the target; trailing % in (0, 100)
    assert client.patch(f"/api/positions/{pid}", json={"stop_price": 310}).status_code == 400
    assert client.patch(f"/api/positions/{pid}", json={"trail_pct": 150}).status_code == 422
    assert client.post("/api/positions", json={"symbol": "MSFT", "quantity": 1, "avg_cost": 1,
                                               "target_price": 5, "stop_price": 6}).status_code == 400
    # editing the buy elsewhere doesn't wipe the exits
    client.patch(f"/api/positions/{pid}", json={"quantity": 3, "avg_cost": 100, "notes": "x"})
    p = next(p for p in client.get("/api/positions").json() if p["id"] == pid)
    assert p["target_price"] == 300 and p["trail_pct"] == 12.5
    # highest close since the buy, never below today's price
    pk = client.get("/api/targets/peaks").json()["peaks"][str(pid)]
    q = client.get("/api/quote/AAPL").json()
    assert pk["peak"] >= q["price"] - 1e-9 and pk["low"] <= pk["peak"] and pk["peak_date"] >= "2025-06-02"
    # exits travel with export/import
    assert any(x.get("target_price") == 300 for x in client.get("/api/export").json()["positions"])


def test_levels_math():
    import numpy as np
    from app import levels
    idx = pd.bdate_range("2023-10-02", periods=700)
    t = np.arange(700)
    c = 100 + 10 * np.sin(t / 15) + np.random.default_rng(1).normal(0, 0.6, 700)
    s = pd.Series(c, index=idx)
    s.iloc[400] = 300                                   # bad tick
    assert levels.clean(s).iloc[400] < 115
    a = levels.analyze(s)
    r, sup = a["resistance"][0], a["support"][0]
    assert 108 < r["level"] < 113 and r["touches"] >= 5 and r["highs"] >= 5      # the 110 ceiling, many touches
    assert 87 < sup["level"] < 92 and sup["touches"] >= 5
    assert all(z["level"] > a["price"] for z in a["resistance"])
    assert a["breakout"] is None
    assert 0 < a["vol"]["atr_pct"] < 2 and 0.1 < a["vol"]["vol_y"] < 0.3
    # range 95–105 for a long time, then a break above with 2 confirming closes
    c2 = np.r_[100 + 5 * np.sin(np.arange(400) / 8), np.linspace(100, 112, 15), [112.5, 113, 113.4]]
    b = levels.analyze(pd.Series(c2, index=pd.bdate_range("2024-01-01", periods=len(c2))))
    assert b["breakout"] and 104 < b["breakout"]["level"] < 106
    # touch probability: driftless reflection principle
    assert levels.hit_probability(100, 100, 0.2, 1) == pytest.approx(1)
    assert levels.hit_probability(100, 110, 0.2, 1) == pytest.approx(0.634, abs=0.01)
    assert levels.hit_probability(100, 300, 0.2, 1) < 0.001


def test_levels_endpoint_and_atr_stop(client):
    r = client.post("/api/positions", json={"symbol": "MSFT", "quantity": 2, "avg_cost": 100, "currency": "USD",
                                            "bought_at": "2025-06-02", "atr_k": 3})
    pid = r.json()["id"]
    assert client.patch(f"/api/positions/{pid}", json={"atr_k": 25}).status_code == 422
    d = client.get("/api/targets/levels").json()
    m = d["symbols"]["MSFT"]
    assert m["vol"]["atr"] > 0 and m["price"] > 0
    assert all(z["level"] > m["price"] for z in m["resistance"])
    assert all(z["level"] < m["price"] for z in m["support"])
    assert m["analyst"] and m["analyst"]["mean"] > 0 and "upside" in m["analyst"]   # stocks get a consensus
    assert d["lots"][str(pid)]["peak"] >= d["lots"][str(pid)]["low"]
    assert next(p for p in client.get("/api/positions").json() if p["id"] == pid)["atr_k"] == 3


def test_etf_implied_target(client):
    # IBCF.MU has no holdings data in the mock (like the real Munich listing): it borrows SPY's
    client.post("/api/positions", json={"symbol": "IBCF.MU", "quantity": 1, "avg_cost": 150, "currency": "EUR",
                                        "bought_at": "2026-08-27"})
    d = client.get("/api/targets/levels").json()["symbols"]
    a = d["IBCF.MU"]["analyst"]
    assert a and a["implied"] and a["proxy"] == "SPY"
    assert 0 < a["coverage"] <= 100 and a["n_holdings"] >= 1
    tops = a["top"]
    w = sum(t["weight"] for t in tops)
    assert a["upside"] == pytest.approx(sum(t["weight"] * t["upside"] for t in tops) / w)
    assert a["mean"] == pytest.approx(d["IBCF.MU"]["price"] * (1 + a["upside"] / 100))
    etf = next(s for s in ("VWCE.DE", "IWDA.AS") if s in d)
    assert d[etf]["analyst"]["implied"] and d[etf]["analyst"]["proxy"] is None
    assert all(d[s]["analyst"] is None for s in d if s.endswith("-USD"))     # crypto: no coverage


def test_risk_math():
    import numpy as np
    from app import risk
    idx = pd.bdate_range("2023-01-02", periods=500)
    rng = np.random.default_rng(3)
    m = rng.normal(0.0003, 0.01, 500)
    a = 1.5 * m + rng.normal(0, 0.005, 500)          # beta 1.5
    b = rng.normal(0.0002, 0.01, 500)                 # unrelated
    px = {k: pd.Series(100 * np.cumprod(1 + r), index=idx) for k, r in (("M", m), ("A", a), ("B", b))}
    R = risk.business_returns(px)
    beta, corr = risk.beta_corr(R["A"], R["M"])
    assert beta == pytest.approx(1.5, abs=0.15) and corr > 0.9
    _, c0 = risk.beta_corr(R["B"], R["M"])
    assert abs(c0) < 0.15
    w = pd.Series({"A": 0.5, "B": 0.5})
    rc = risk.risk_contributions(R[["A", "B"]], w)
    assert sum(rc.values()) == pytest.approx(1) and rc["A"] > rc["B"]           # the volatile one carries more risk
    # drawdown: up 10%, down to −30% from the peak, back above the peak
    s = pd.Series([100, 110, 99, 77, 90, 111, 112.0], index=pd.bdate_range("2024-01-01", periods=7))
    dd = risk.drawdown(s.pct_change().dropna())
    assert dd["max"] == pytest.approx(-0.3) and dd["peak"] == "2024-01-02" and dd["trough"] == "2024-01-04"
    assert dd["recovered"] == "2024-01-08" and dd["current"] == pytest.approx(0)
    c = risk.concentration({"x": 90, "y": 10})
    assert c["top1"] == pytest.approx(90) and c["effective_n"] == pytest.approx(1 / 0.82)
    # crypto on weekends lands on Monday; missing early data → weight spread over the rest
    sat = pd.Series([1.0, 2.0, 2.0, 3.0], index=pd.to_datetime(["2024-01-05", "2024-01-06", "2024-01-07", "2024-01-08"]))
    r = risk.business_returns({"C": sat})
    assert list(r.index.dayofweek) == [0] and r["C"].iloc[0] == pytest.approx(2.0)
    late = R[["A", "B"]].copy()
    late.loc[late.index[:100], "B"] = np.nan
    rp = risk.portfolio_returns(late, w)
    assert rp.iloc[50] == pytest.approx(late["A"].iloc[50])
    assert risk.window_return(px["M"], "2023-02-01", "2023-06-01") is not None
    assert risk.window_return(px["M"], "2020-02-19", "2020-03-23") is None       # before the data starts


def test_risk_mix_earnings_endpoints(client):
    client.post("/api/positions", json={"symbol": "BTC-USD", "quantity": 0.1, "avg_cost": 30000, "currency": "USD",
                                        "bought_at": "2025-01-02"})
    d = client.get("/api/risk?base=EUR&years=3").json()
    assert d["mix"]["vol"] > 0 and d["mix"]["dd"]["max"] < 0 and d["bench"]["vol"] > 0
    assert sum(h["weight"] for h in d["holdings"]) == pytest.approx(100)
    assert sum(h["risk_share"] for h in d["holdings"]) == pytest.approx(100, abs=0.5)
    btc = next(h for h in d["holdings"] if h["symbol"] == "BTC-USD")
    assert btc["class"] == "crypto" and btc["fx_share"] == 1.0 and btc["vol"] > 0.3
    assert {s["key"] for s in d["scenarios"]} >= {"covid", "bear2022"}
    assert d["corr"]["keys"] and len(d["corr"]["m"]) == len(d["corr"]["keys"])
    assert 0 < d["concentration"]["top5"] <= 100
    mx = client.post("/api/risk/mix", json={"weights": {"MSFT": 50, "BTC-USD": 50}}).json()
    assert mx["vol"] > 0.2 and set(mx["used"]) == {"MSFT", "BTC-USD"}
    assert client.post("/api/risk/mix", json={"weights": {}}).status_code == 400
    e = client.get("/api/earnings").json()["items"]
    assert e and all(x["symbol"] != "BTC-USD" for x in e)          # stocks only
    x = e[0]
    assert x["next"] and x["days"] >= 0 and len(x["history"]) <= 4 and x["typical_move"] is not None


def test_risk_proxy_benchmark_and_actual(client):
    # IBCF.MU has only a few days of history in the mock (like Yahoo's Munich listing); IBCF.DE is the same fund
    r = client.post("/api/positions", json={"symbol": "IBCF.MU", "quantity": 100, "avg_cost": 150, "currency": "EUR",
                                            "bought_at": "2026-08-27"})
    assert r.status_code == 201
    d = client.get("/api/risk?years=3&bench=VWCE.DE").json()
    h = next(x for x in d["holdings"] if x["symbol"] == "IBCF.MU")
    assert h["proxy"] and h["proxy"]["symbol"] == "IBCF.DE" and h["proxy"]["kind"] == "listing"
    assert h["vol"] and h["vol"] > 0.05 and h["risk_share"] > 0           # no longer carried as cash
    assert d["benchmark"]["symbol"] == "VWCE.DE"
    assert d["fit"] and d["fit"][0]["corr"] >= d["fit"][-1]["corr"]
    a = d["actual"]
    assert a and "diversified" in a and a.get("first", {}).get("top")
    # a manual proxy wins
    client.put("/api/settings", json={"risk_proxies": {"IBCF.MU": "SPY"}})
    d2 = client.get("/api/risk?years=3").json()
    h2 = next(x for x in d2["holdings"] if x["symbol"] == "IBCF.MU")
    assert h2["proxy"]["symbol"] == "SPY" and h2["proxy"]["kind"] == "manual"
    # the Monte Carlo volatility uses the proxy too
    mx = client.post("/api/risk/mix", json={"weights": {"IBCF.MU": 100}}).json()
    assert mx["vol"] and mx["vol"] > 0.05


def test_diversified_start_skips_single_stock_period(client):
    for p in client.get("/api/positions").json():
        client.delete(f"/api/positions/{p['id']}")
    client.post("/api/positions", json={"symbol": "TSLA", "quantity": 10, "avg_cost": 100, "currency": "USD", "bought_at": "2022-01-03"})
    for s, d in (("MSFT", "2024-03-01"), ("NVDA", "2024-03-01"), ("IWDA.AS", "2024-03-01")):
        client.post("/api/positions", json={"symbol": s, "quantity": 10, "avg_cost": 100, "currency": "USD", "bought_at": d})
    a = client.get("/api/risk?years=3").json()["actual"]
    assert a["diversified"] and a["since"] == "2024-03-01" and a["first"]["top"] == "TSLA"


def test_ideas_screener(client):
    import time as _t
    for _ in range(40):                       # fundamentals load in the background
        d = client.get("/api/ideas?universe=spain").json()
        if not d["progress"]["pending"] and d["rows"]:
            break
        _t.sleep(0.25)
    assert d["rows"] and all(r["symbol"].endswith(".MC") for r in d["rows"])
    r = d["rows"][0]
    assert set(r["f"]) == {"value", "quality", "growth", "momentum", "analysts", "income", "risk", "fit"}
    assert all(v is None or 0 <= v <= 100 for x in d["rows"] for v in x["f"].values())
    assert all(x["f"]["income"] == 0 for x in d["rows"] if not x["div_yield"])
    held = [x for x in d["rows"] if x["symbol"] == "SAN.MC"]       # the demo portfolio holds SAN.MC
    assert held and held[0]["held_pct"] > 0 and any("already hold" in f for f in held[0]["flags"])
    assert abs(sum(d["ref_sectors"].values()) - 100) < 0.01
    w = client.get("/api/ideas?universe=world").json()
    assert w["universe"] == "world" and not any(x["symbol"].endswith(".MC") for x in w["rows"])


def test_ideas_withholding_and_ranks():
    from app import ideas
    assert ideas.lost_withholding("Spain") == 0 and ideas.lost_withholding("United States") == 0
    assert ideas.lost_withholding("Switzerland") == 20 and ideas.lost_withholding("Germany") == pytest.approx(11.375)
    r = ideas._rank({"a": 1, "b": 2, "c": 3, "d": None})
    assert r == {"a": 0.0, "b": 50.0, "c": 100.0}
    assert ideas._rank({"a": 1, "b": 2}, higher_better=False) == {"a": 100.0, "b": 0.0}
    assert ideas.region_of("Japan") == "Japan" and ideas.region_of("Taiwan") == "Emerging markets"


def test_ideas_extra_tickers(client):
    import time as _t

    def get():
        for _ in range(40):
            d = client.get("/api/ideas?universe=spain").json()
            if not d["progress"]["pending"]:
                return d
            _t.sleep(0.25)
        return d
    get()                                                  # warm the cache without extras
    client.put("/api/settings", json={"ideas": {"custom": {"spain": ["CIE.MC", "SAN.MC", "IWDA.AS"]}}})
    d = get()                                              # must not be served from the old cache
    st = {c["symbol"]: c["status"] for c in d["custom"]}
    assert st == {"CIE.MC": "added", "SAN.MC": "in_list", "IWDA.AS": "not_stock"}
    assert any(r["symbol"] == "CIE.MC" for r in d["rows"])


def test_alert_rules_match_sell_targets():
    from app import alerts
    fx = {"EUR": 1.0, "USD": 0.9}
    base = {"id": 1, "symbol": "X", "currency": "USD", "price_currency": "USD", "avg_cost": 100.0, "ok": True,
            "quantity": 10, "cost": 900.0, "pnl": 0, "pnl_pct": 0, "account": "B"}
    L = {"vol": {"atr": 2.0}, "resistance": [{"level": 130.0}], "support": [], "last_closes": [121, 123],
         "breakout": None}
    ev = lambda p, L=L, pk=None: alerts.eval_lot({**base, **p}, fx, L, pk, 5, {})  # noqa: E731
    assert ev({"price": 110, "target_price": 120})["status"] == "watch"
    assert ev({"price": 115, "target_price": 120})["status"] == "near-tp"
    assert ev({"price": 121, "target_price": 120})["status"] == "tp"           # closes not 1 ATR above yet
    r = ev({"price": 123, "target_price": 120}, dict(L, last_closes=[122.5, 123]))
    assert r["status"] == "brk" and r["sugg"]["stop"] == pytest.approx(119) and r["sugg"]["target"] == 130
    # trailing 10% below a 150 peak → stop 135 → hit at 134
    r = ev({"price": 134, "trail_pct": 10}, pk={"peak": 150})
    assert r["status"] == "sl" and r["stop_src"] == "trail" and r["stop"] == pytest.approx(135)
    # ×ATR beats a lower fixed stop
    r = ev({"price": 146, "atr_k": 3, "stop_price": 120}, pk={"peak": 150})
    assert r["stop_src"] == "atr" and r["stop"] == pytest.approx(144) and r["status"] == "near-sl"
    assert ev({"price": 110})["status"] == "none"
    assert alerts.fmt_money(1234.5, "EUR") == "1.234,50 €"


def test_telegram_alerts_flow(client, monkeypatch):
    m = client.app.state.alerts
    sent = []

    def fake_call(method, http_timeout=15, **p):
        if method == "getMe":
            return {"username": "stonks_test_bot", "first_name": "Stonks"}
        if method == "sendMessage":
            sent.append(p)
            return {"message_id": len(sent)}
        return []
    monkeypatch.setattr(m.tg, "call", fake_call)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert client.post("/api/alerts/token", json={"token": "nope"}).status_code == 400
    r = client.post("/api/alerts/token", json={"token": "123456789:" + "A" * 35}).json()
    assert r["token"] == "app" and r["bot"]["username"] == "stonks_test_bot"
    assert "secret" not in json_dumps(client.get("/api/settings").json())             # never leaked
    assert "AAAAAAAAAA" not in json_dumps(client.get("/api/export").json())
    # pairing: only the chat that sends the code gets linked
    code = client.post("/api/alerts/link").json()["pairing"]["code"]
    m.handle_update({"update_id": 1, "message": {"chat": {"id": 666, "first_name": "Eve"}, "text": "/start 000000"}})
    assert not client.get("/api/alerts").json()["linked"]
    m.handle_update({"update_id": 2, "message": {"chat": {"id": 42, "first_name": "Juan"}, "text": f"/start {code}"}})
    st = client.get("/api/alerts").json()
    assert st["linked"] and st["config"]["chat_id"] == 42 and sent[-1]["chat_id"] == 42
    n = len(sent)
    m.handle_update({"update_id": 3, "message": {"chat": {"id": 666}, "text": "/status"}})
    assert len(sent) == n                                                               # other chats ignored
    # a target below the price → one alert, then silence until the status changes
    pid = client.post("/api/positions", json={"symbol": "MSFT", "quantity": 1, "avg_cost": 10, "currency": "USD",
                                              "bought_at": "2025-01-02", "target_price": 11}).json()["id"]
    client.put("/api/alerts/config", json={"events": {"earnings": False}})
    r = client.post("/api/alerts/check").json()
    assert r["sent"] >= 1 and any("MSFT" in s["text"] for s in sent)
    assert not any("IS3N.DE" in s["text"] for s in sent)          # buys without exits aren't monitored by default
    assert client.post("/api/alerts/check").json()["sent"] == 0
    m.handle_update({"update_id": 4, "message": {"chat": {"id": 42}, "text": "/status"}})
    assert "MSFT" in sent[-1]["text"]
    m.handle_update({"update_id": 5, "message": {"chat": {"id": 42}, "text": "/mute 2"}})
    assert client.get("/api/alerts").json()["muted_until"]
    assert client.post("/api/alerts/test").status_code == 200 and "Test" in sent[-1]["text"]
    client.delete(f"/api/positions/{pid}")


def json_dumps(x):
    import json
    return json.dumps(x)


def test_breakout_message_is_explicit():
    from datetime import datetime
    from app import alerts
    fx = {"EUR": 1.0}
    p = {"id": 9, "symbol": "ASML.AS", "currency": "EUR", "price_currency": "EUR", "avg_cost": 1631.8, "ok": True,
         "price": 1545.0, "quantity": 0.0944, "cost": 154.0, "pnl": -8.19, "pnl_pct": -5.3, "account": "Trade Republic",
         "bought_at": "2026-10-09", "stop_price": 1350.6, "target_price": 2057.34}
    L = {"vol": {"atr": 20.0}, "resistance": [{"level": 1621.2}], "last_closes": [1540, 1545],
         "breakout": {"level": 1513.9, "lo": 1506.9, "hi": 1515.0, "touches": 2, "since": "2026-10-10"}}
    r = alerts.eval_lot(p, fx, L, None, 5, {})
    assert r["status"] == "brk" and alerts.title_of(r) == "Rebound"               # below the buy price
    msg = alerts.lot_message(r, "EUR", None, now=datetime(2026, 10, 13, 10, 28))
    assert "Rebound ↑ upside — ASML.AS" in msg and "Upside break" in msg and "1.513,90 €" in msg and "touched 2×" in msg
    assert "1.350,60 €" in msg and "→ <b>1.496,90 €</b>" in msg                    # from the current stop to the new one
    assert "2.057,34 € (unchanged)" in msg and "doesn't lock a gain" in msg and "10:28" in msg
    r2 = alerts.eval_lot({**p, "price": 1700.0, "pnl_pct": 4.2}, fx, dict(L, last_closes=[1690, 1700]), None, 5, {})
    assert alerts.title_of(r2) == "Broke out"


def test_breakdown_direction():
    import numpy as np
    from datetime import datetime
    from app import alerts, levels
    # support at ~95 held many times, then a fall through it with 2 confirming closes
    c = np.r_[100 + 5 * np.sin(np.arange(400) / 8), np.linspace(100, 88, 15), [87.5, 87.0, 86.6]]
    a = levels.analyze(pd.Series(c, index=pd.bdate_range("2024-01-01", periods=len(c))))
    bd = a["breakdown"]
    assert bd and 94 < bd["level"] < 96 and a["breakout"] is None
    p = {"id": 1, "symbol": "X", "currency": "EUR", "price_currency": "EUR", "avg_cost": 90.0, "ok": True, "price": 86.6,
         "quantity": 10, "cost": 900.0, "pnl": -34, "pnl_pct": -3.8, "stop_price": 70.0, "target_price": 110.0}
    r = alerts.eval_lot(p, {"EUR": 1.0}, a, None, 5, {})
    assert r["status"] == "brkdn" and r["sugg"]["dir"] == "down" and alerts.direction_of(r) == "↓ downside"
    msg = alerts.lot_message(r, "EUR", None, now=datetime(2026, 10, 13, 12, 0))
    assert "Broke down ↓ downside" in msg and "Downside break" in msg and "support" in msg
    up = {**p, "price": 120.0, "pnl_pct": 33.0}
    L = {"vol": {"atr": 1.0}, "resistance": [], "support": [], "last_closes": [119, 120],
         "breakout": {"level": 105.0, "lo": 104.0, "hi": 106.0, "touches": 3, "since": "2026-10-01"}, "breakdown": None}
    r2 = alerts.eval_lot({**up, "target_price": 150.0}, {"EUR": 1.0}, L, None, 5, {})
    assert r2["status"] == "brk" and "Broke out ↑ upside" in alerts.lot_message(r2, "EUR", None)


def test_daily_moves(client):
    import numpy as np
    from app import risk
    idx = pd.bdate_range("2025-01-01", periods=300)
    r = np.random.default_rng(5).normal(0, 0.01, 300)
    r[-2], r[-4] = 0.06, -0.045                       # this week: a big up day and a big down day
    s = pd.Series(100 * np.cumprod(1 + r), index=idx)
    m = risk.daily_moves(s)
    assert m["week"]["best"]["ret"] == pytest.approx(0.06, abs=1e-9) and m["week"]["worst"]["ret"] == pytest.approx(-0.045, abs=1e-9)
    assert m["week"]["best"]["date"] == idx[-2].date().isoformat()
    assert 0.004 < m["median_abs"] < 0.01 and m["q"]["p5"] < 0 < m["q"]["p95"]
    assert m["days"]["up5"] >= 1 and m["year_best"]["ret"] == pytest.approx(0.06, abs=1e-9)
    d = client.get("/api/moves").json()["symbols"]
    assert d and all("week" in v and "q" in v for v in d.values())
