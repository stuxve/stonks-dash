"""Telegram alerts for the Sell targets tab.

* evaluate()  — the same rules as the Sell targets tab (static/targets.js), in Python, so the Pi can check them
                while no browser is open: target hit, stop hit (fixed, % trailing or ×ATR chandelier), breakout
                with a suggested stop/target, near target / near stop, and upcoming earnings.
* Telegram    — tiny Bot API client (stdlib only). The bot token comes from TELEGRAM_BOT_TOKEN or is stored
                write-only in the database; it is never returned by the API or included in backups.
* Monitor     — two background threads: one checks the alerts every N minutes and sends only CHANGES
                (with a cooldown per buy and event), the other long-polls the bot for /link, /status, /summary,
                /mute, /unmute and /help. Messages from chats other than the linked one are ignored.
"""
from __future__ import annotations

import html
import json
import logging
import os
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from zoneinfo import ZoneInfo

log = logging.getLogger("stonks.alerts")

DEFAULTS = {
    "enabled": True,
    "events": {"tp": True, "sl": True, "brk": True, "brkdn": True, "near": False, "earnings": True, "unmonitored": False},
    "interval_min": 15,
    "near_pct": None,          # None = use the Sell targets setting (default 5)
    "earn_days": 3,
    "summary_time": None,      # "HH:MM" local time for a daily summary, or None
    "cooldown_h": 12,
    "app_url": None,
    "chat_id": None,
    "chat_name": None,
}
SECRET_KEY = "secret:telegram_token"
STATE_KEY = "alerts:state"
LOG_KEY = "alerts:log"


# ---------------------------------------------------------------------------------------------- formatting
def fmt_num(v: float | None, d: int = 2) -> str:
    """Spanish style: 1.234,56"""
    if v is None:
        return "—"
    s = f"{abs(v):,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("−" if v < 0 else "") + s


def fmt_money(v: float | None, ccy: str | None) -> str:
    sym = {"EUR": "€", "USD": "US$", "GBP": "£", "CHF": "CHF", "JPY": "¥"}.get(ccy or "", ccy or "")
    d = 2 if v is None or abs(v) < 1e5 else 0
    return f"{fmt_num(v, d)} {sym}".strip()


def fmt_signed(v: float | None, ccy: str | None) -> str:
    if v is None:
        return "—"
    return ("+" if v > 0 else "") + fmt_money(v, ccy)


def fmt_pct(v: float | None, d: int = 1) -> str:
    if v is None:
        return "—"
    return f"{'+' if v > 0 else ''}{fmt_num(v, d)}%"


def fee_for(rules: dict, account: str | None, gross: float) -> float:
    r = (rules or {}).get(account or "")
    if not r or not gross > 0:
        return 0.0
    f = (r.get("fixed") or 0) + (r.get("pct") or 0) / 100 * gross
    if r.get("min") is not None:
        f = max(f, r["min"])
    return round(f, 2)


# ---------------------------------------------------------------------------------------------- evaluation
def eval_lot(p: dict, fx: dict, L: dict | None, pk: dict | None, near: float, fee_rules: dict) -> dict:
    """Status of one open buy — mirrors evalLot() in static/targets.js."""
    pccy = p.get("price_currency") or p.get("currency")
    rate = fx[p["currency"]] / fx[pccy] if fx.get(p.get("currency")) and fx.get(pccy) else 1.0
    buy = p["avg_cost"] * rate
    price = p.get("price") if p.get("ok") else None
    vol = (L or {}).get("vol") or {}
    atr = vol.get("atr")
    peak = max(pk["peak"], price if price is not None else float("-inf")) if pk else None
    trail = peak * (1 - p["trail_pct"] / 100) if p.get("trail_pct") and peak else None
    chand = peak - p["atr_k"] * atr if p.get("atr_k") and peak and atr else None
    stop, src = p.get("stop_price"), ("fixed" if p.get("stop_price") is not None else None)
    if trail is not None and (stop is None or trail > stop):
        stop, src = trail, "trail"
    if chand is not None and (stop is None or chand > stop):
        stop, src = chand, "atr"
    tp = p.get("target_price")
    has = any(p.get(k) is not None for k in ("target_price", "stop_price", "trail_pct", "atr_k"))
    st = "watch"
    if not has:
        st = "none"
    elif price is None:
        st = "nodata"
    elif tp is not None and price >= tp:
        st = "tp"
    elif stop is not None and price <= stop:
        st = "sl"
    elif tp is not None and (tp / price - 1) * 100 <= near:
        st = "near-tp"
    elif stop is not None and (1 - stop / price) * 100 <= near:
        st = "near-sl"
    sugg = None
    if price is not None and atr and L and st not in ("sl", "nodata"):
        nxt = next((z for z in (L.get("resistance") or []) if z["level"] > price), None)
        closes = (L.get("last_closes") or [])[-2:]
        bk = L.get("breakout")
        if tp is not None and price >= tp and len(closes) == 2 and all(c >= tp + atr for c in closes):
            ns = tp - 0.5 * atr
            if stop is None or ns > stop + 0.1 * atr:
                sugg = {"stop": ns, "target": nxt["level"] if nxt else None, "level": tp, "kind": "target", "dir": "up",
                        "why": f"closed above your target {fmt_num(tp)} for 2 days"}
        elif bk and price > bk["hi"]:
            ns = bk["lo"] - 0.5 * atr
            if ns < price and (stop is None or ns > stop + 0.1 * atr):
                sugg = {"stop": ns, "target": tp if tp is not None and tp > price else (nxt["level"] if nxt else None),
                        "level": bk["level"], "touches": bk["touches"], "since": bk.get("since"), "kind": "zone", "dir": "up",
                        "why": f"broke the {fmt_num(bk['level'])} resistance ({bk['touches']}× touched)"}
        if sugg and sugg["target"] is not None and sugg["target"] <= sugg["stop"]:
            sugg["target"] = None
        if sugg:
            st = "brk"
        # downside: a support gave way. Warn, show the next support, and offer a tighter stop under it
        bd = L.get("breakdown")
        if not sugg and st != "tp" and bd and price < bd["lo"]:
            nsup = next((z for z in (L.get("support") or []) if z["level"] < price), None)
            ns = nsup["lo"] - 0.5 * atr if nsup else None
            tighter = ns if ns is not None and ns < price and (stop is None or ns > stop + 0.1 * atr) else None
            sugg = {"dir": "down", "kind": "zone", "level": bd["level"], "touches": bd["touches"], "since": bd.get("since"),
                    "next": nsup["level"] if nsup else None, "stop": tighter, "target": tp,
                    "why": f"fell through the {fmt_num(bd['level'])} support ({bd['touches']}× touched)"}
            st = "brkdn"
    fxp = fx.get(pccy) or 0.0

    def pnl_at(px):
        if px is None or p.get("cost") is None or not fxp:
            return None
        gross = p["quantity"] * px
        return (gross - fee_for(fee_rules, p.get("account"), gross)) * fxp - p["cost"]
    return {"id": p["id"], "symbol": p.get("symbol"), "name": p.get("display_name") or p.get("symbol"),
            "account": p.get("account"), "bought_at": p.get("bought_at"), "quantity": p.get("quantity"),
            "ccy": pccy, "buy": buy, "price": price, "stop": stop, "stop_src": src, "tp": tp, "peak": peak,
            "status": st, "sugg": sugg, "has": has, "pnl": p.get("pnl"), "pnl_pct": p.get("pnl_pct"),
            "at_tp": pnl_at(tp), "at_sl": pnl_at(stop), "atr": atr}


def evaluate(rows: list[dict], fx: dict, levels: dict, near: float, fee_rules: dict) -> list[dict]:
    syms, lots = (levels or {}).get("symbols") or {}, (levels or {}).get("lots") or {}
    return [eval_lot(p, fx, syms.get(p.get("symbol")), lots.get(str(p["id"])), near, fee_rules)
            for p in rows if (p.get("quantity") or 0) > 0]


# ---------------------------------------------------------------------------------------------- messages
EMO = {"tp": "✅", "sl": "🛑", "brk": "🚀", "brkdn": "📉", "near-tp": "🎯", "near-sl": "⚠️", "earnings": "📅"}
TITLE = {"tp": "Target hit", "sl": "Stop hit", "brk": "Broke out", "brkdn": "Broke down", "near-tp": "Near target",
         "near-sl": "Near stop"}


def title_of(r: dict) -> str:
    """'Broke out' reads as good news; below your buy price it's a rebound that only lets you cut the loss."""
    if r["status"] == "brk" and r.get("price") is not None and r["price"] < r["buy"]:
        return "Rebound"
    return TITLE[r["status"]]


def direction_of(r: dict) -> str | None:
    if r["status"] == "brk":
        return "↑ upside"
    if r["status"] == "brkdn":
        return "↓ downside"
    return None


def lot_message(r: dict, base: str, app_url: str | None, now: datetime | None = None) -> str:
    e = html.escape
    c = r["ccy"]
    now = now or datetime.now(ZoneInfo(os.getenv("TZ") or "Europe/Madrid"))
    when = f" · bought {r['bought_at']}" if r.get("bought_at") else ""
    emo = "↗️" if title_of(r) == "Rebound" else EMO[r["status"]]
    d = direction_of(r)
    lines = [f"{emo} <b>{title_of(r)} {d} — {e(r['symbol'] or r['name'])}</b>" if d else f"{emo} <b>{title_of(r)} — {e(r['symbol'] or r['name'])}</b>",
             f"Price <b>{fmt_money(r['price'], c)}</b> ({fmt_pct(r['pnl_pct'])} vs your buy {fmt_money(r['buy'], c)}) · {now:%H:%M}"]
    src = {"fixed": "stop", "trail": "trailing stop", "atr": "×ATR stop"}.get(r.get("stop_src") or "", "stop")
    if r["status"] in ("tp", "near-tp") and r["tp"] is not None:
        lines.append(f"Target {fmt_money(r['tp'], c)}" + (f" · P/L there {fmt_signed(r['at_tp'], base)}" if r.get("at_tp") is not None else ""))
    if r["status"] in ("sl", "near-sl") and r["stop"] is not None:
        lines.append(f"{src.capitalize()} {fmt_money(r['stop'], c)}" + (f" · P/L there {fmt_signed(r['at_sl'], base)}" if r.get("at_sl") is not None else ""))
    if r["status"] == "brk" and r.get("sugg"):
        g = r["sugg"]
        if g.get("kind") == "zone":
            since = f", since {g['since']}" if g.get("since") else ""
            lines.append(f"<b>Upside break</b>: closed 2 days above the <b>{fmt_money(g['level'], c)}</b> resistance (touched {g.get('touches')}×{since}).")
        else:
            lines.append(f"<b>Upside break</b>: closed 2 days above your target <b>{fmt_money(g['level'], c)}</b>.")
        vs = lambda px: fmt_pct((px / r["buy"] - 1) * 100) + " vs buy" if px is not None and r["buy"] else ""  # noqa: E731
        cur = f"{fmt_money(r['stop'], c)} ({vs(r['stop'])})" if r.get("stop") is not None else "none"
        lines.append(f"Stop: {cur} → <b>{fmt_money(g['stop'], c)}</b> ({vs(g['stop'])}) suggested")
        if g.get("target") is None:
            lines.append("Target: none above (no resistance left) — let the stop do the work")
        elif r.get("tp") is not None and abs(g["target"] - r["tp"]) < 1e-6:
            lines.append(f"Target: {fmt_money(g['target'], c)} (unchanged)")
        else:
            lines.append(f"Target: {fmt_money(r['tp'], c) if r.get('tp') is not None else 'none'} → <b>{fmt_money(g['target'], c)}</b> (next resistance)")
        if r["price"] < r["buy"]:
            lines.append("<i>Still below your buy price: the higher stop limits the loss, it doesn't lock a gain.</i>")
        lines.append("Apply it with <b>Raise stop</b> in Sell targets.")
    if r["status"] == "brkdn" and r.get("sugg"):
        g = r["sugg"]
        since = f", since {g['since']}" if g.get("since") else ""
        frm = lambda px: fmt_pct((px / r["price"] - 1) * 100) + " from here" if px is not None and r["price"] else ""  # noqa: E731
        lines.append(f"<b>Downside break</b>: closed 2 days below the <b>{fmt_money(g['level'], c)}</b> support (touched {g.get('touches')}×{since}). "
                     "Old support often acts as resistance on the way back up.")
        lines.append(f"Next support: {fmt_money(g['next'], c)} ({frm(g['next'])})" if g.get("next") is not None
                     else "Next support: none below in the last 3 years")
        lines.append(f"Your {src}: {fmt_money(r['stop'], c)} ({frm(r['stop'])})" if r.get("stop") is not None else "Your stop: none set")
        if g.get("stop") is not None:
            lines.append(f"Option: tighten the stop → <b>{fmt_money(g['stop'], c)}</b>, just under the next support (<b>Tighten stop</b> in Sell targets).")
        if r.get("at_sl") is not None:
            lines.append(f"P/L if the current stop is hit: {fmt_signed(r['at_sl'], base)}")
    lines.append(f"<i>{e(r.get('account') or '')}{when} · {fmt_num(r['quantity'], 4)} u. · P/L now {fmt_signed(r.get('pnl'), base)}</i>")
    if app_url:
        lines.append(f'<a href="{e(app_url.rstrip("/"))}/#portfolio">Open Sell targets</a>')
    return "\n".join(lines)


def earnings_message(x: dict, stop_dist: float | None) -> str:
    e = html.escape
    when = "today" if x["days"] == 0 else "tomorrow" if x["days"] == 1 else f"in {x['days']} days"
    lines = [f"{EMO['earnings']} <b>{e(x['symbol'])} reports earnings {when}</b> ({x['next']}{', estimated' if x.get('next_to') else ''})"]
    if x.get("typical_move") is not None:
        lines.append(f"Typical move after a report: ±{fmt_num(x['typical_move'], 1)}%")
    if stop_dist is not None and stop_dist < 0:
        warn = x.get("typical_move") is not None and abs(stop_dist) <= x["typical_move"] * 1.2
        lines.append(f"Your stop is {fmt_num(abs(stop_dist), 1)}% away" + (" — <b>inside that range</b>" if warn else ""))
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------- Telegram
class Telegram:
    API = os.getenv("STONKS_TELEGRAM_API", "https://api.telegram.org")   # overridable for local testing

    def __init__(self, token_getter):
        self.token_getter = token_getter
        self._me = None

    def call(self, method: str, http_timeout: float = 15, **params):
        token = self.token_getter()
        if not token:
            raise RuntimeError("no Telegram bot token configured")
        data = urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
                                       for k, v in params.items() if v is not None}).encode()
        req = urllib.request.Request(f"{self.API}/bot{token}/{method}", data=data)
        try:
            with urllib.request.urlopen(req, timeout=http_timeout) as r:
                out = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                out = json.loads(e.read().decode())
            except Exception:  # noqa: BLE001
                raise RuntimeError(f"Telegram HTTP {e.code}") from None
        if not out.get("ok"):
            raise RuntimeError(f"Telegram: {out.get('description') or 'error'}")
        return out.get("result")

    def me(self, refresh: bool = False):
        if self._me is None or refresh:
            self._me = self.call("getMe")
        return self._me

    def send(self, chat_id, text: str):
        return self.call("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", disable_web_page_preview=True)


# ---------------------------------------------------------------------------------------------- monitor
class Monitor:
    """Owns the config, state and threads. `snapshot()` is provided by the app: it returns the data to check."""

    def __init__(self, db, snapshot, summary):
        self.db = db
        self.snapshot = snapshot          # () -> {"base", "lots": [eval rows], "earnings": [...], "stop_dist": {}}
        self.summary = summary            # () -> str (HTML) for /summary and the daily summary
        self.tg = Telegram(self.token)
        self.pairing = None               # {"code", "until"}
        self.last_check = None
        self.last_error = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._threads = []

    # ---- config / secrets
    def config(self) -> dict:
        c = dict(DEFAULTS)
        c.update(self.db.get_settings().get("alerts") or {})
        c["events"] = {**DEFAULTS["events"], **(c.get("events") or {})}
        return c

    def save_config(self, patch: dict) -> dict:
        cur = self.db.get_settings().get("alerts") or {}
        cur.update(patch)
        self.db.update_settings({"alerts": cur})
        return self.config()

    def token(self) -> str | None:
        env = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        if env:
            return env
        s = self.db.get_meta([SECRET_KEY], 10 * 365 * 86400).get(SECRET_KEY) or {}
        return s.get("token") or None

    def token_source(self) -> str | None:
        if os.getenv("TELEGRAM_BOT_TOKEN", "").strip():
            return "env"
        return "app" if self.token() else None

    def set_token(self, token: str | None):
        self.db.put_meta(SECRET_KEY, {"token": (token or "").strip() or None})
        self.tg._me = None

    def _meta(self, key, default):
        return self.db.get_meta([key], 10 * 365 * 86400).get(key) or default

    def state(self) -> dict:
        return self._meta(STATE_KEY, {})

    def log(self) -> list:
        return self._meta(LOG_KEY, {"items": []})["items"]

    def _log(self, kind: str, text: str, ok: bool = True, err: str | None = None):
        items = self.log()
        items.insert(0, {"t": time.time(), "kind": kind, "text": text, "ok": ok, "err": err})
        self.db.put_meta(LOG_KEY, {"items": items[:60]})

    # ---- sending
    def send(self, text: str, kind: str = "info") -> bool:
        cfg = self.config()
        if not cfg.get("chat_id"):
            self._log(kind, text, False, "no chat linked")
            return False
        try:
            self.tg.send(cfg["chat_id"], text)
            self._log(kind, text)
            return True
        except Exception as e:  # noqa: BLE001
            self.last_error = str(e)
            self._log(kind, text, False, str(e))
            log.warning("telegram send failed: %s", e)
            return False

    # ---- the check: send what changed
    def check(self, force: bool = False) -> list[dict]:
        with self._lock:
            cfg = self.config()
            if not force and (not cfg.get("enabled") or not self.token() or not cfg.get("chat_id")):
                return []
            st = self.state()
            muted = st.get("muted_until") or 0
            snap = self.snapshot()
            now = time.time()
            ev = cfg["events"]
            want = {"tp": ev.get("tp"), "sl": ev.get("sl"), "brk": ev.get("brk"), "brkdn": ev.get("brkdn"),
                    "near-tp": ev.get("near"), "near-sl": ev.get("near")}
            last = st.get("lots") or {}
            sent_at = st.get("sent") or {}
            cool = (cfg.get("cooldown_h") or 12) * 3600
            out, new_last = [], {}
            for r in snap["lots"]:
                key = str(r["id"])
                new_last[key] = r["status"]
                if r["status"] not in want or not want[r["status"]]:
                    continue
                if not r["has"] and not ev.get("unmonitored"):
                    continue                                    # buys without any exit: only if asked for
                if last.get(key) == r["status"]:
                    continue                                    # nothing changed since the last check
                k2 = f"{key}:{r['status']}"
                if now - sent_at.get(k2, 0) < cool:
                    continue                                    # flapping around a level
                out.append({"kind": r["status"], "text": lot_message(r, snap["base"], cfg.get("app_url")), "key": k2})
            if ev.get("earnings"):
                seen = st.get("earn") or {}
                for x in snap.get("earnings") or []:
                    if x.get("days") is None or not 0 <= x["days"] <= (cfg.get("earn_days") or 3):
                        continue
                    k2 = f"{x['symbol']}:{x['next']}"
                    if k2 in seen:
                        continue
                    seen[k2] = now
                    out.append({"kind": "earnings", "text": earnings_message(x, (snap.get("stop_dist") or {}).get(x["symbol"])), "key": None})
                st["earn"] = {k: v for k, v in seen.items() if now - v < 60 * 86400}
            sent = []
            if now >= muted or force:
                for m in out:
                    if self.send(m["text"], m["kind"]):
                        sent.append(m)
                        if m["key"]:
                            sent_at[m["key"]] = now
            st["lots"] = new_last
            st["sent"] = {k: v for k, v in sent_at.items() if now - v < 7 * 86400}
            self.db.put_meta(STATE_KEY, st)
            self.last_check = now
            return sent

    def maybe_summary(self):
        cfg = self.config()
        t = cfg.get("summary_time")
        if not t or not cfg.get("chat_id") or not self.token():
            return
        tz = ZoneInfo(os.getenv("TZ") or "Europe/Madrid")
        now = datetime.now(tz)
        hh, mm = (int(x) for x in t.split(":"))
        st = self.state()
        today = now.date().isoformat()
        if st.get("summary_day") == today or (now.hour, now.minute) < (hh, mm):
            return
        if self.send(self.summary(), "summary"):
            st["summary_day"] = today
            self.db.put_meta(STATE_KEY, st)

    # ---- pairing: the chat that sends the code becomes the linked chat
    def new_pairing(self) -> dict:
        self.pairing = {"code": f"{random.SystemRandom().randint(0, 999999):06d}", "until": time.time() + 600}
        return self.pairing

    def handle_update(self, u: dict):
        msg = u.get("message") or u.get("edited_message")
        if not msg or "text" not in msg:
            return
        chat = msg["chat"]
        text = msg["text"].strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@")[0].lower()
        cfg = self.config()
        linked = cfg.get("chat_id")
        p = self.pairing
        code = arg.strip() if cmd in ("/start", "/link") else ""
        if p and code and code == p["code"] and time.time() < p["until"]:
            name = chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username")
            self.save_config({"chat_id": chat["id"], "chat_name": name})
            self.pairing = None
            self.tg.send(chat["id"], "🔗 Linked to <b>stonks-dash</b>. You'll get your Sell targets alerts here.\nSend /help for commands.")
            self._log("link", f"linked chat {name}")
            return
        if not linked or chat["id"] != linked:
            return                                               # not our chat: ignore silently
        if cmd == "/status":
            snap = self.snapshot()
            ev = cfg["events"]
            act = [r for r in snap["lots"] if r["status"] in TITLE and (r["has"] or ev.get("unmonitored"))]
            if not act:
                self.tg.send(linked, "Nothing to report: every buy is between its stop and target.")
            else:
                order = ["sl", "brkdn", "brk", "tp", "near-sl", "near-tp"]
                act.sort(key=lambda r: order.index(r["status"]))
                lines = [f"{EMO[r['status']]} <b>{html.escape(r['symbol'] or r['name'])}</b> {title_of(r).lower()}{(' ' + direction_of(r)) if direction_of(r) else ''} · "
                         f"{fmt_money(r['price'], r['ccy'])} ({fmt_pct(r['pnl_pct'])})" for r in act]
                self.tg.send(linked, "\n".join(lines))
        elif cmd == "/summary":
            self.tg.send(linked, self.summary())
        elif cmd == "/mute":
            try:
                h = float(arg or 8)
            except ValueError:
                h = 8
            st = self.state()
            st["muted_until"] = time.time() + h * 3600
            self.db.put_meta(STATE_KEY, st)
            self.tg.send(linked, f"🔕 Muted for {fmt_num(h, 0)} h. /unmute to resume.")
        elif cmd == "/unmute":
            st = self.state()
            st["muted_until"] = 0
            self.db.put_meta(STATE_KEY, st)
            self.tg.send(linked, "🔔 Alerts on.")
        elif cmd in ("/help", "/start"):
            self.tg.send(linked, "/status — buys at or near a target or stop\n/summary — portfolio today\n"
                                 "/mute [hours] — pause alerts (default 8 h)\n/unmute — resume")

    # ---- threads
    def start(self):
        if self._threads:
            return
        for fn in (self._check_loop, self._poll_loop):
            t = threading.Thread(target=fn, daemon=True)
            t.start()
            self._threads.append(t)

    def _check_loop(self):
        time.sleep(20)
        while not self._stop.is_set():
            try:
                self.check()
                self.maybe_summary()
            except Exception as e:  # noqa: BLE001
                self.last_error = str(e)
                log.warning("alert check failed: %s", e)
            mins = max(5, int(self.config().get("interval_min") or 15))
            # wake every minute so the daily summary isn't late and config changes apply soon
            for _ in range(mins):
                if self._stop.wait(60):
                    return
                try:
                    self.maybe_summary()
                except Exception as e:  # noqa: BLE001
                    log.info("summary failed: %s", e)

    def _poll_loop(self):
        offset = None
        while not self._stop.is_set():
            if not self.token():
                self._stop.wait(30)
                continue
            try:      # long poll: Telegram holds the request up to 25 s until a message arrives
                ups = self.tg.call("getUpdates", http_timeout=40, offset=offset, timeout=25, allowed_updates=["message"])
            except Exception as e:  # noqa: BLE001
                log.info("telegram poll: %s", e)
                self._stop.wait(15)
                continue
            for u in ups or []:
                offset = u["update_id"] + 1
                try:
                    self.handle_update(u)
                except Exception as e:  # noqa: BLE001
                    log.info("telegram update failed: %s", e)
