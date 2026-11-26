"""Trade Republic live prices (app/trlive.py): the PIN vault, login → live → lock → unlock, mapping, the API.
Runs against FakeTRApi (demo mode), never against Trade Republic."""
import os
import time

os.environ["STONKS_NO_WARMUP"] = "1"

import pytest
from fastapi.testclient import TestClient

from app import trlive
from app.main import build_app

PIN, PIN2 = "4821", "907316"          # test values only


@pytest.fixture
def app(tmp_path):
    return build_app(db_path=str(tmp_path / "t.db"), provider="mock")


@pytest.fixture
def client(app):
    c = TestClient(app)
    yield c
    app.state.tr.lock()


def _wait(fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    return fn()


def _go_live(client):
    # the demo portfolio already holds SAN.MC 900 and MSFT 12, the same as FakeTRApi's holdings
    assert client.post("/api/tr/pin", json={"new_pin": PIN}).json()["state"] == "no_session"
    r = client.post("/api/tr/login", json={"phone": "+34600123456", "tr_pin": "1234", "pin": PIN})
    assert r.status_code == 200 and r.json()["state"] == "pending"
    assert _wait(lambda: client.get("/api/tr").json()["state"] == "live")
    return _wait(lambda: (d := client.get("/api/tr").json())["positions"] and all(p["symbol"] for p in d["positions"]) and d)


# ---------------------------------------------------------------------------------------------- vault
class _DB:
    def __init__(self):
        self.m = {}

    def get_meta(self, keys, ttl=None):
        return {k: self.m[k] for k in keys if k in self.m}

    def put_meta(self, k, v):
        self.m[k] = v


def test_vault_encrypts_and_checks_the_pin():
    db = _DB()
    v = trlive.Vault(db, b"pepper" * 6)
    assert not v.pin_set()
    key = v.set_pin(PIN)
    v.write(key, {"session": {"phone": "+34600123456", "cookies": [{"name": "a", "value": "secret-cookie"}]}}, has_session=True)
    blob = str(db.m[trlive.Vault.KEY])
    assert "secret-cookie" not in blob and "+34600123456" not in blob and PIN not in blob
    _, payload = v.open(PIN)
    assert payload["session"]["cookies"][0]["value"] == "secret-cookie"
    # another install's secret (pepper) can't open it even with the right PIN
    with pytest.raises(trlive.VaultError):
        trlive.Vault(db, b"other!" * 6).open(PIN)


def test_vault_wrong_pins_lock_out_and_pin_change_keeps_the_session():
    db = _DB()
    v = trlive.Vault(db, b"pepper" * 6)
    v.write(v.set_pin(PIN), {"session": {"phone": "+1", "cookies": []}}, has_session=True)
    for _ in range(trlive.Vault.MAX_FAILS - 1):
        with pytest.raises(trlive.VaultError):
            v.open("0000")
    assert v.attempts_left() == 1
    v.open(PIN)                                        # a right PIN resets the count
    assert v.attempts_left() == trlive.Vault.MAX_FAILS
    with pytest.raises(trlive.VaultError):
        v.set_pin(PIN2, "1111")                        # changing needs the current PIN
    v.set_pin(PIN2, PIN)
    with pytest.raises(trlive.VaultError):
        v.open(PIN)
    assert v.open(PIN2)[1]["session"]["phone"] == "+1"
    assert db.m[trlive.Vault.KEY].get("has_session")
    for _ in range(trlive.Vault.MAX_FAILS):
        with pytest.raises(trlive.VaultError):
            v.open("0000")
    with pytest.raises(trlive.VaultError, match="Too many"):
        v.open(PIN2)                                   # locked out even with the right PIN


def test_pepper_file_is_private(tmp_path):
    os.environ.pop("STONKS_SECRET", None)
    p1 = trlive.load_pepper(str(tmp_path))
    assert p1 == trlive.load_pepper(str(tmp_path)) and len(p1) >= 32
    assert oct(os.stat(tmp_path / ".stonks_secret").st_mode & 0o777) == "0o600"


def test_tick_price_uses_the_bid_ask_midpoint():
    p, bid, ask, t = trlive.tick_price({"bid": {"price": "99"}, "ask": {"price": 101}, "last": {"price": 100.5, "time": 5}})
    assert (p, bid, ask, t) == (100.0, 99.0, 101.0, 5)
    assert trlive.tick_price({"last": {"price": 7}})[0] == 7.0


# ---------------------------------------------------------------------------------------------- API
def test_states_login_and_mapping(client, app):
    assert client.get("/api/tr").json()["state"] == "no_pin"
    assert client.post("/api/tr/login", json={"phone": "+34600123456", "tr_pin": "1234", "pin": PIN}).status_code == 400
    d = _go_live(client)
    assert d["phone"] == "+34•••56" and d["unlocked_until"] > time.time() + 500
    by = {p["isin"]: p for p in d["positions"]}
    assert by["ES0113900J37"]["symbol"] == "SAN.MC" and by["ES0113900J37"]["qty"] == 900 and by["ES0113900J37"]["dash_qty"] == 900
    assert by["US5949181045"]["symbol"] == "MSFT" and by["US5949181045"]["how"] == "auto"
    assert "SAN.MC" in d["held"]
    # ticks reach the price engine, converted to the listing's currency (MSFT: EUR → USD)
    eng = app.state.engine
    assert _wait(lambda: "SAN.MC" in eng.live_px and "MSFT" in eng.live_px)
    assert eng.quotes(["SAN.MC"])["SAN.MC"].price == eng.live_px["SAN.MC"][0]
    assert _wait(lambda: client.get("/api/tr").json()["ticks"] > 2)
    # nothing secret in settings, the export or the API
    dump = client.get("/api/settings").text + client.get("/api/export").text + client.get("/api/tr").text
    assert "1234" not in dump and PIN not in dump and "+34600123456" not in dump and "tr_session" not in dump


def test_lock_unlock_change_pin_and_auto_lock(client, app):
    _go_live(client)
    assert client.post("/api/tr/lock").json()["state"] == "locked"
    assert not app.state.engine.live_px                   # back to Yahoo's prices
    r = client.post("/api/tr/unlock", json={"pin": "0000"})
    assert r.status_code == 400 and client.get("/api/tr").json()["attempts_left"] == trlive.Vault.MAX_FAILS - 1
    assert client.post("/api/tr/unlock", json={"pin": PIN}).json()["state"] == "live"
    # change the PIN while unlocked: the next lock saves with the new key
    assert client.post("/api/tr/pin", json={"pin": PIN, "new_pin": PIN2}).json()["state"] == "live"
    client.post("/api/tr/lock")
    assert client.post("/api/tr/unlock", json={"pin": PIN}).status_code == 400
    assert client.post("/api/tr/unlock", json={"pin": PIN2}).json()["state"] == "live"
    # auto-lock: once the time is up the watchdog locks it (checks every 5 s)
    assert client.put("/api/tr/config", json={"lock_minutes": 3}).json()["lock_minutes"] == 3
    app.state.tr.unlocked_until = time.time() - 1
    assert client.get("/api/tr").json()["state"] == "locked"
    assert _wait(lambda: app.state.tr.api is None, 7)


def test_mapping_override_and_forget(client):
    _go_live(client)
    d = client.put("/api/tr/config", json={"map": {"US5949181045": "none"}}).json()
    p = next(x for x in d["positions"] if x["isin"] == "US5949181045")
    assert p["symbol"] is None and p["how"] == "yours"
    d = client.put("/api/tr/config", json={"map": {"US5949181045": "auto"}}).json()
    assert next(x for x in d["positions"] if x["isin"] == "US5949181045")["symbol"] == "MSFT"
    assert client.put("/api/tr/config", json={"map": {"nope": "X"}}).status_code == 400
    assert client.put("/api/tr/config", json={"lock_minutes": 0}).status_code == 422
    assert client.post("/api/tr/forget", json={"pin": "0000"}).status_code == 400
    d = client.post("/api/tr/forget", json={"pin": PIN}).json()
    assert d["state"] == "no_session" and not d["positions"]


def test_reset_when_the_pin_is_forgotten(client):
    _go_live(client)
    client.post("/api/tr/lock")
    d = client.post("/api/tr/reset").json()
    assert d["state"] == "no_pin" and not d["positions"] and d["phone"] is None
    assert client.post("/api/tr/unlock", json={"pin": PIN}).status_code == 400
