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
