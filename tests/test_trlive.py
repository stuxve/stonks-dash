"""Dashboard PIN lock (app/auth.py) and Trade Republic live prices (app/trlive.py).
Runs against FakeTRApi (demo mode), never against Trade Republic."""
import os
import time

os.environ["STONKS_NO_WARMUP"] = "1"

import pytest
from fastapi.testclient import TestClient

from app import auth as authmod, trlive
from app.main import build_app

PIN, PIN2 = "482193", "907316"        # test values only


def _wait(fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    return fn()


@pytest.fixture
def app(tmp_path):
    a = build_app(db_path=str(tmp_path / "t.db"), provider="mock", require_pin=True)
    a.state.tr.RETRY_MIN = 0.3
    yield a
    a.state.tr.stop()


@pytest.fixture
def client(app):
    return TestClient(app)


def _setup(client):
    r = client.post("/api/auth/setup", json={"new_pin": PIN})
    assert r.status_code == 200 and r.json()["state"] == "unlocked"
    return r


def _tr_live(client, app, **fake):
    if fake:
        app.state.tr.api_factory = lambda ph, pin: trlive.FakeTRApi(ph, pin, **fake)
    r = client.post("/api/tr/login", json={"phone": "+34600123456", "tr_pin": "1234"})
    assert r.status_code == 200, r.text
    assert _wait(lambda: client.get("/api/tr").json()["state"] == "live")
    return _wait(lambda: (d := client.get("/api/tr").json())["positions"] and all(p["name"] for p in d["positions"])
                 and sum(1 for p in d["positions"] if p["symbol"]) >= 2 and d)


# ---------------------------------------------------------------------------------------------- dashboard lock
def test_everything_is_locked_until_the_pin(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/auth").json()["state"] == "no_pin"
    for path in ("/api/portfolio", "/api/settings", "/api/export", "/api/tr", "/api/events?limit=1"):
        assert client.get(path).status_code == 401, path
    assert client.post("/api/positions", json={"symbol": "X", "quantity": 1, "avg_cost": 1}).status_code == 401
    r = _setup(client)
    ck = r.headers["set-cookie"].lower()
    assert "httponly" in ck and "samesite=strict" in ck
    assert client.get("/api/portfolio").status_code == 200
    assert client.post("/api/auth/setup", json={"new_pin": "1111"}).status_code == 400   # only the first time
    # another browser: locked, wrong PINs count, the right one opens
    other = TestClient(client.app)
    assert other.get("/api/auth").json()["state"] == "locked"
    assert other.post("/api/auth/unlock", json={"pin": "000000"}).status_code == 400
    assert other.get("/api/auth").json()["attempts_left"] == trlive.Vault.MAX_FAILS - 1
    assert other.post("/api/auth/unlock", json={"pin": PIN}).json()["state"] == "unlocked"
    assert other.get("/api/settings").status_code == 200


def test_idle_lock_counts_only_your_activity(client, app):
    _setup(client)
    auth = app.state.auth
    tok = client.cookies.get(authmod.COOKIE)
    auth._s[tok]["seen"] -= 9 * 60                       # 9 of 10 minutes without use
    client.get("/api/portfolio")                          # the page's own requests don't count
    assert 50 < auth.remaining(tok) < 61
    assert client.post("/api/auth/ping").json()["remaining"] > 590      # you used it
    auth._s[tok]["seen"] -= 10 * 60 + 1
    assert client.get("/api/portfolio").status_code == 401
    assert client.get("/api/auth").json()["state"] == "locked"
    # the setting applies right away
    client.post("/api/auth/unlock", json={"pin": PIN})
    assert client.put("/api/auth/config", json={"idle_minutes": 30}).json()["idle_minutes"] == 30
    assert client.put("/api/auth/config", json={"idle_minutes": 0}).status_code == 422
    assert client.post("/api/auth/lock").json()["state"] == "locked"
    assert client.get("/api/settings").status_code == 401


def test_cross_origin_writes_are_refused(client):
    _setup(client)
    bad = {"Origin": "http://evil.example"}
    assert client.post("/api/auth/lock", headers=bad).status_code == 403
    assert client.post("/api/auth/unlock", json={"pin": PIN}, headers=bad).status_code == 403
    assert client.post("/api/positions", json={"symbol": "X", "quantity": 1, "avg_cost": 1}, headers=bad).status_code == 403
    ok = {"Origin": "http://testserver"}
    assert client.post("/api/auth/ping", headers=ok).status_code == 200


def test_events_stream_ends_when_locked(client, app):
    _setup(client)
    tok = client.cookies.get(authmod.COOKIE)
    app.state.auth.end(tok)
    assert client.get("/api/events?watch=port:EUR&limit=1").status_code == 401


def test_change_pin_locks_other_browsers_and_cli_reset(client, app, tmp_path):
    _setup(client)
    other = TestClient(client.app)
    other.post("/api/auth/unlock", json={"pin": PIN})
    assert client.post("/api/auth/pin", json={"pin": "111111", "new_pin": PIN2}).status_code == 400
    assert client.post("/api/auth/pin", json={"pin": PIN, "new_pin": PIN2}).json()["state"] == "unlocked"
    assert other.get("/api/settings").status_code == 401
    assert other.post("/api/auth/unlock", json={"pin": PIN}).status_code == 400
    assert other.post("/api/auth/unlock", json={"pin": PIN2}).status_code == 200
    authmod._reset(str(tmp_path / "t.db"))
    assert not app.state.auth.vault.pin_set()


# ---------------------------------------------------------------------------------------------- Trade Republic
def test_login_names_venues_mapping_and_no_secrets(client, app):
    _setup(client)
    d = _tr_live(client, app)
    assert d["phone"] == "+34•••56"
    by = {p["isin"]: p for p in d["positions"]}
    assert by["ES0113900J37"]["name"] == "Banco Santander" and by["ES0113900J37"]["venue"] == "LSX"
    assert by["ES0113900J37"]["symbol"] == "SAN.MC" and by["ES0113900J37"]["dash_qty"] == 900
    assert by["US5949181045"]["symbol"] == "MSFT" and by["US5949181045"]["how"] == "auto"
    assert by["XF000BTC0017"]["venue"] == "BHS"          # not on LSX: priced on its own venue
    assert app.state.tr.api.pin is None                  # the TR PIN isn't kept after the login request
    eng = app.state.engine
    assert _wait(lambda: {"SAN.MC", "MSFT", "BTC-USD"} <= set(eng.live_px))
    assert eng.quotes(["SAN.MC"])["SAN.MC"].price == eng.live_px["SAN.MC"][0]
    dump = client.get("/api/settings").text + client.get("/api/export").text + client.get("/api/tr").text
    assert "1234" not in dump and PIN not in dump and "+34600123456" not in dump and "tr_session" not in dump


def test_feed_keeps_running_while_the_dashboard_is_locked(client, app):
    _setup(client)
    _tr_live(client, app)
    client.post("/api/auth/lock")
    n = app.state.tr.ticks
    assert _wait(lambda: app.state.tr.ticks > n + 3)
    assert app.state.tr.state() == "live"


def test_dropped_connection_reconnects(client, app):
    _setup(client)
    _tr_live(client, app, drop_after=12)
    tr = app.state.tr
    assert _wait(lambda: tr.error and "reconnecting" in tr.error, 6)
    assert _wait(lambda: tr.state() == "live" and tr.error is None, 8)
    n = tr.ticks
    assert _wait(lambda: tr.ticks > n + 2)


def test_session_ended_by_tr_vs_network_error(client, app):
    _setup(client)
    _tr_live(client, app)
    tr = app.state.tr
    tr.api.ended = True                                  # TR answers 401 at the next check
    tr.api.drop_after = 1                                # force a reconnect, which checks the session
    tr.api._recvs = 5
    assert _wait(lambda: tr.state() == "no_session", 8)
    assert "ended the session" in tr.error
    # a network error while resuming keeps the saved session
    tr2 = app.state.tr
    tr2.vault.write(app.state.auth.key, {"session": {"phone": "+34600123456", "cookies": []}}, has_session=True)

    class Flaky(trlive.FakeTRApi):
        def settings(self):
            raise ConnectionError("DNS")
    tr2.api_factory = lambda ph, pin: Flaky(ph, pin)
    tr2.resume()
    assert _wait(lambda: tr2.error and "reconnecting" in tr2.error, 4)
    assert tr2.vault._rec().get("has_session") is True
    tr2.stop()


def test_tick_without_ask_uses_the_last_price(client, app):
    _setup(client)
    _tr_live(client, app, no_ask=True)
    assert _wait(lambda: "SAN.MC" in app.state.engine.live_px)


def test_authenticator_code_can_be_retried(client, app):
    _setup(client)
    app.state.tr.api_factory = lambda ph, pin: trlive.FakeTRApi(ph, pin, needs_code=True)
    d = client.post("/api/tr/login", json={"phone": "+34600123456", "tr_pin": "1234"}).json()
    assert d["state"] == "pending" and d["pending"]["needs_code"]
    assert client.post("/api/tr/login/code", json={"code": "000000"}).status_code == 400
    assert client.get("/api/tr").json()["state"] == "pending"
    assert client.post("/api/tr/login/code", json={"code": "123456"}).status_code == 200
    assert _wait(lambda: client.get("/api/tr").json()["state"] == "live")


def test_restart_resumes_on_the_next_unlock(client, app, tmp_path):
    _setup(client)
    _tr_live(client, app)
    app.state.tr.stop()
    app2 = build_app(db_path=str(tmp_path / "t.db"), provider="mock", require_pin=True)
    c2 = TestClient(app2)
    assert c2.get("/api/tr").status_code == 401
    assert app2.state.tr.state() == "stopped"
    c2.post("/api/auth/unlock", json={"pin": PIN})
    assert _wait(lambda: app2.state.tr.state() == "live")
    app2.state.tr.stop()


def test_mapping_override_and_disconnect(client, app):
    _setup(client)
    _tr_live(client, app)
    d = client.put("/api/tr/config", json={"map": {"US5949181045": "none"}}).json()
    p = next(x for x in d["positions"] if x["isin"] == "US5949181045")
    assert p["symbol"] is None and p["how"] == "yours"
    assert "MSFT" not in app.state.engine.live_px
    d = client.put("/api/tr/config", json={"map": {"US5949181045": "auto"}}).json()
    assert next(x for x in d["positions"] if x["isin"] == "US5949181045")["symbol"] == "MSFT"
    assert client.put("/api/tr/config", json={"map": {"nope": "X"}}).status_code == 400
    d = client.post("/api/tr/disconnect").json()
    assert d["state"] == "no_session" and not d["positions"]
    assert not app.state.auth.vault._rec().get("has_session")


# ---------------------------------------------------------------------------------------------- units
def test_vault_encrypts_and_checks_the_pin():
    class _DB:
        def __init__(self):
            self.m = {}

        def get_meta(self, keys, ttl=None):
            return {k: self.m[k] for k in keys if k in self.m}

        def put_meta(self, k, v):
            self.m[k] = v
    db = _DB()
    v = trlive.Vault(db, b"pepper" * 6)
    key = v.set_pin(PIN)
    v.write(key, {"session": {"phone": "+34600123456", "cookies": [{"name": "a", "value": "secret-cookie"}]}}, has_session=True)
    blob = str(db.m[trlive.Vault.KEY])
    assert "secret-cookie" not in blob and "+34600123456" not in blob and PIN not in blob
    assert v.open(PIN)[1]["session"]["cookies"][0]["value"] == "secret-cookie"
    with pytest.raises(trlive.VaultError):
        trlive.Vault(db, b"other!" * 6).open(PIN)          # another install's secret can't open it
    for _ in range(trlive.Vault.MAX_FAILS):
        with pytest.raises(trlive.VaultError):
            v.open("0000")
    with pytest.raises(trlive.VaultError, match="Too many"):
        v.open(PIN)


def test_pepper_file_is_private(tmp_path):
    os.environ.pop("STONKS_SECRET", None)
    p1 = trlive.load_pepper(str(tmp_path))
    assert p1 == trlive.load_pepper(str(tmp_path)) and len(p1) >= 32
    assert oct(os.stat(tmp_path / ".stonks_secret").st_mode & 0o777) == "0o600"


def test_tick_price_and_weekend_1d(app):
    # `last` (what TR values your portfolio with), the midpoint only without it; `pre` = the venue's previous close
    assert trlive.tick_price({"bid": {"price": "99"}, "ask": {"price": 101}, "last": {"price": 100.5, "time": 5}})[:3] == (100.5, 99.0, 101.0)
    assert trlive.tick_price({"bid": {"price": 99}, "ask": {"price": 101}})[0] == 100.0
    assert trlive.tick_pre({"pre": {"price": "98.5"}}) == 98.5 and trlive.tick_pre({}) is None
    eng = app.state.engine
    q0 = eng.quotes(["SAN.MC"])["SAN.MC"]
    last_day = time.mktime(time.strptime(q0.last_date, "%Y-%m-%d")) + 20 * 3600     # a quote on the last bar's day
    eng.set_live("SAN.MC", q0.price * 1.01, last_day)
    q = eng.quotes(["SAN.MC"])["SAN.MC"]
    assert q.prev_close == q0.prev_close                  # still compares with the bar before
    eng.set_live("SAN.MC", q0.price * 1.01, last_day + 86400)                       # the next day
    q = eng.quotes(["SAN.MC"])["SAN.MC"]
    assert q.prev_close == pytest.approx(q0.price) and q.changes["1D"] == pytest.approx(1.0, abs=1e-6)


# ---------------------------------------------------------------------------------------------- TR for every ticker
def _live_job(app):
    app.state.worker.jobs["live"].fn()


def _others_live(client, app, syms, timeout=30):
    def ok():
        _live_job(app)
        d = client.get("/api/tr").json()
        live = {o["symbol"] for o in d.get("others", []) if o["live"]}
        return syms <= live and d
    return _wait(ok, timeout)


def test_other_holdings_get_tr_prices(client, app):
    _setup(client)
    _tr_live(client, app)
    want = {"NVDA", "ASML.AS", "VWCE.DE", "IWDA.AS", "IS3N.DE", "ETH-USD"}   # demo holdings at other brokers
    d = _others_live(client, app, want)
    assert d, client.get("/api/tr").json().get("others")
    by = {o["symbol"]: o for o in d["others"]}
    assert by["IWDA.AS"]["isin"] == "IE00B4L5Y983" and by["IWDA.AS"]["how"] == "ticker"
    assert by["ETH-USD"]["isin"] == "XF000ETH0019" and by["ETH-USD"]["venue"] == "BHS"
    eng = app.state.engine
    assert eng.quotes(["NVDA"])["NVDA"].price == eng.live_px["NVDA"][0]
    # your choice wins: "none" keeps Yahoo's price, "auto" looks it up again
    d = client.put("/api/tr/config", json={"isin": {"NVDA": "none"}}).json()
    assert "NVDA" not in eng.live_px
    assert any(o["symbol"] == "NVDA" and o["how"] == "yours" and not o["isin"] for o in d["others"])
    client.put("/api/tr/config", json={"isin": {"NVDA": "auto"}})
    assert _others_live(client, app, {"NVDA"})
    assert client.put("/api/tr/config", json={"isin": {"NVDA": "XX"}}).status_code == 400


def test_lookup_skips_indices_and_finds_by_ticker(client, app):
    _setup(client)
    _tr_live(client, app)
    assert client.get("/api/tr/lookup?symbol=^GSPC").json()["how"] == "not on TR"
    d = client.get("/api/tr/lookup?symbol=ASML.AS").json()
    assert d["isin"] == "NL0010273215" and d["instrument"]["venue"] == "LSX"


def test_charts_take_intraday_from_tr(client, app):
    _setup(client)
    _tr_live(client, app)
    assert _others_live(client, app, {"NVDA"})
    d = client.get("/api/chart?symbol=NVDA&range=1D").json()
    assert d["intraday"] and "Trade Republic" in d["chart_source"] and len(d["points"]) > 10
    d = client.get("/api/chart?symbol=NVDA&range=1Y").json()
    assert d["chart_source"] is None                      # longer ranges stay Yahoo's
    t = client.get("/api/ta?symbol=NVDA&interval=5m").json()
    assert t["tr_from"] and t["bars"][-1][0] >= t["tr_from"]
    assert t["bars"][0][0] < t["tr_from"]                  # older bars from Yahoo
    times = [b[0] for b in t["bars"]]
    assert times == sorted(times) and len(set(times)) == len(times)
    # TR not connected: Yahoo only
    app.state.tr.stop()
    app.state.tr._aloop = None
    assert client.get("/api/chart?symbol=NVDA&range=1D").json()["chart_source"] is None


def test_day_change_like_the_tr_app_and_tr_stays_the_source_when_quiet(client, app):
    _setup(client)
    _tr_live(client, app)
    eng, tr = app.state.engine, app.state.tr
    assert _wait(lambda: "MSFT" in eng.live_px and eng.live_px["MSFT"][3])
    d = client.get("/api/tr/quote?symbol=MSFT").json()
    assert d["isin"] == "US5949181045" and d["shown"]["from_tr"]
    # today's change is measured against TR's previous close, as in the app (same ratio in EUR or US$)
    assert d["shown"]["day_pct"] == pytest.approx(d["tr_day_pct"], abs=0.05)
    pos = next(p for p in client.get("/api/portfolio?base=EUR").json()["positions"] if p["symbol"] == "MSFT")
    assert pos["live_src"] == "TR"
    # valued with TR's own euro price, as in the app (no detour through US$)
    eur, pre = app.state.tr.latest["US5949181045"]["p"], app.state.tr.latest["US5949181045"]["pre"]
    assert pos["price_eur"] and pos["value"] == pytest.approx(pos["quantity"] * pos["price_eur"], rel=1e-9)
    assert abs(pos["price_eur"] / eur - 1) < 0.01 and pos["price_currency"] == "USD"
    # no new ticks (venue closed): the last price is re-sent, so TR stays the source past the 2-minute window
    tr.RESEND_S = 0.5
    eng.live_ttl = 2.0
    tr.api.drop_after = None
    async def quiet():
        import asyncio
        await asyncio.sleep(3600)
    tr.api.recv = quiet
    time.sleep(4)
    assert eng.live_fresh("MSFT")
