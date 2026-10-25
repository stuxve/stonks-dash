"""stonks-dash API + static frontend."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
import datetime as dt
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import DB
from . import alerts, exposure, ideas, ledger, levels, risk, seeds, tax
from .market import PERIODS, MockProvider, QuoteEngine, YahooProvider, normalize_currency
from .sessions import CATALOG, DEFAULT_EXCHANGES, SessionService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stonks")
SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")

DATA_DIR = os.getenv("STONKS_DATA_DIR", "/data")
PROVIDER = os.getenv("STONKS_PROVIDER", "yahoo").lower()
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
BASES = ("EUR", "USD")
DEFAULT_BENCHMARK = "IWDA.AS"   # iShares Core MSCI World (EUR, accumulating)


class BoardIn(BaseModel):
    name: str | None = None
    position: int | None = None
    config: dict | None = None


class ItemIn(BaseModel):
    symbol: str | None = None
    label: str | None = None
    group_name: str | None = None
    weight: float | None = Field(default=None, ge=0)
    position: int | None = None


class PositionIn(BaseModel):
    symbol: str | None = None
    name: str | None = None
    quantity: float | None = Field(default=None, gt=0)
    avg_cost: float | None = Field(default=None, ge=0)
    currency: str | None = None
    account: str | None = None
    group_name: str | None = None
    manual_price: float | None = Field(default=None, ge=0)
    notes: str | None = None
    bought_at: date | None = None   # purchase date (YYYY-MM-DD)
    fees: float | None = Field(default=None, ge=0)
    # sell objectives for this buy, in the quote currency
    target_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    trail_pct: float | None = Field(default=None, gt=0, lt=100)
    atr_k: float | None = Field(default=None, gt=0, le=20)   # chandelier stop: peak − k × typical daily move


class TxIn(BaseModel):
    type: str | None = None                 # SELL | DIVIDEND
    symbol: str | None = None
    account: str | None = None
    date: dt.date | None = None
    quantity: float | None = Field(default=None, gt=0)
    price: float | None = Field(default=None, ge=0)
    amount: float | None = Field(default=None, gt=0)
    withholding: float | None = Field(default=None, ge=0)
    currency: str | None = None
    fees: float | None = Field(default=None, ge=0)
    notes: str | None = None


class MixIn(BaseModel):
    weights: dict[str, float]
    base: str | None = None
    years: int = Field(default=3, ge=1, le=10)


class AlertCfgIn(BaseModel):
    enabled: bool | None = None
    events: dict[str, bool] | None = None
    interval_min: int | None = Field(default=None, ge=5, le=1440)
    near_pct: float | None = Field(default=None, gt=0, le=50)
    earn_days: int | None = Field(default=None, ge=0, le=30)
    summary_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$|^$")
    cooldown_h: float | None = Field(default=None, ge=0, le=168)
    app_url: str | None = Field(default=None, max_length=200)


class TokenIn(BaseModel):
    token: str | None = Field(default=None, max_length=100)


class FillIn(BaseModel):
    account: str | None = None
    overwrite: bool = False


def _seed_mock_portfolio(db: DB, engine: QuoteEngine) -> None:
    """Demo positions whose cost basis is plausible relative to the synthetic prices."""
    from .seeds import DEMO_POSITIONS
    syms = [p[0] for p in DEMO_POSITIONS]
    quotes = engine.quotes(syms)
    held_days = [812, 540, 400, 365, 210, 95, 61, 23, 4]
    hist = engine.history(syms, date.today() - timedelta(days=max(held_days) + 10))
    for (sym, qty, _cost, _ccy, acct, grp), days in zip(DEMO_POSITIONS, held_days):
        q, h = quotes[sym], hist.get(sym)
        bought = date.today() - timedelta(days=days)
        if q.ok and h is not None:
            pos = h.index.searchsorted(pd.Timestamp(bought), side="right") - 1
            db.create_position({"symbol": sym, "quantity": qty, "avg_cost": round(float(h.iloc[max(pos, 0)]), 4),
                                "currency": q.currency, "account": acct, "group_name": grp,
                                "bought_at": bought.isoformat(), "fees": 1.0})


def build_app(db_path: str | None = None, provider: str | None = None) -> FastAPI:
    provider = (provider or PROVIDER).lower()
    db = DB(db_path or os.path.join(DATA_DIR, "stonks.db"))
    prov = MockProvider() if provider == "mock" else YahooProvider()
    engine = QuoteEngine(prov, db,
                         recent_ttl=float(os.getenv("STONKS_QUOTE_TTL", "60")),
                         history_ttl=float(os.getenv("STONKS_HISTORY_TTL", str(6 * 3600))))
    db.seed_if_empty(demo_portfolio=(provider != "mock" and os.getenv("STONKS_DEMO_PORTFOLIO") == "1"))
    if provider == "mock" and not db.list_positions():
        _seed_mock_portfolio(db, engine)

    app = FastAPI(title="stonks-dash", version="1.0.0")
    sessions = SessionService()
    app.state.db, app.state.engine, app.state.provider, app.state.sessions = db, engine, prov, sessions

    if os.getenv("STONKS_NO_WARMUP") != "1":
        # building ~20 holiday calendars takes a few seconds; do it before the first page view
        import threading
        threading.Thread(target=lambda: sessions.build(
            db.get_settings().get("sessions_exchanges") or DEFAULT_EXCHANGES), daemon=True).start()

    def base_or_default(base: str | None) -> str:
        b = (base or db.get_settings().get("base_currency") or "EUR").upper()
        if b not in BASES:
            raise HTTPException(400, f"base must be one of {BASES}")
        return b

    # ------------------------------------------------------------------ meta
    @app.get("/api/health")
    def health():
        return {"ok": True, "provider": prov.name, "last_update": engine.last_update}

    @app.get("/api/settings")
    def get_settings():
        return db.get_settings()

    @app.put("/api/settings")
    def put_settings(data: dict):
        if "base_currency" in data and str(data["base_currency"]).upper() not in BASES:
            raise HTTPException(400, f"base_currency must be one of {BASES}")
        db.update_settings(data)
        return db.get_settings()

    @app.get("/api/search")
    def search(q: str = Query(..., min_length=1), limit: int = 10):
        return prov.search(q, limit=limit)

    @app.get("/api/quote/{symbol}")
    def quote(symbol: str):
        q = engine.quotes([symbol.upper()])[symbol.upper()]
        return q.to_dict()

    @app.get("/api/quotes")
    def quotes(symbols: str = Query(..., description="comma-separated")):
        syms = [x.strip().upper() for x in symbols.split(",") if x.strip()][:200]
        qs = engine.quotes(syms)
        return {s: {k: v for k, v in qs[s].to_dict().items() if k != "spark"} for s in syms}

    # ------------------------------------------------------------------ market hours
    @app.get("/api/sessions")
    def get_sessions(codes: str | None = None):
        selected = ([c.strip().upper() for c in codes.split(",") if c.strip()] if codes
                    else db.get_settings().get("sessions_exchanges") or DEFAULT_EXCHANGES)
        return {
            "now": int(time.time() * 1000),
            "selected": selected,
            "exchanges": sessions.build(selected),
            "catalog": [{"code": c, "name": n, "city": city, "region": r, "index": i}
                        for c, n, city, r, i in CATALOG],
        }

    # ------------------------------------------------------------------ boards


    @app.get("/api/boards")
    def list_boards():
        return db.list_boards()

    @app.post("/api/boards", status_code=201)
    def create_board(b: BoardIn):
        if not b.name:
            raise HTTPException(400, "name required")
        bid = db.create_board(b.name, b.config or {"size_mode": "cap", "group_mode": "sector"})
        return db.get_board(bid)

    @app.patch("/api/boards/{board_id}")
    def update_board(board_id: int, b: BoardIn):
        if not db.get_board(board_id):
            raise HTTPException(404, "board not found")
        db.update_board(board_id, b.model_dump(exclude_unset=True))
        return db.get_board(board_id)

    @app.delete("/api/boards/{board_id}", status_code=204)
    def delete_board(board_id: int):
        db.delete_board(board_id)

    @app.post("/api/boards/{board_id}/items", status_code=201)
    def add_item(board_id: int, it: ItemIn):
        if not db.get_board(board_id):
            raise HTTPException(404, "board not found")
        if not it.symbol:
            raise HTTPException(400, "symbol required")
        iid = db.add_item(board_id, it.model_dump())
        return {"id": iid}

    @app.patch("/api/items/{item_id}")
    def update_item(item_id: int, it: ItemIn):
        db.update_item(item_id, it.model_dump(exclude_unset=True))
        return {"ok": True}

    @app.delete("/api/items/{item_id}", status_code=204)
    def delete_item(item_id: int):
        db.delete_item(item_id)

    @app.get("/api/boards/{board_id}/heatmap")
    def heatmap(board_id: int, base: str | None = None):
        base = base_or_default(base)
        board = db.get_board(board_id)
        if not board:
            raise HTTPException(404, "board not found")
        syms = [it["symbol"] for it in board["items"]]
        quotes = engine.quotes(syms)
        fx = engine.fx_rates({q.currency for q in quotes.values()}, base)
        tiles = []
        for it in board["items"]:
            q = quotes[it["symbol"]]
            rate = fx.get(q.currency)
            tiles.append({
                **q.to_dict(),
                "item_id": it["id"],
                "label": it["label"],
                "group_name": it["group_name"],
                "weight": it["weight"],
                "market_cap_base": q.market_cap * rate if (q.market_cap and rate) else None,
                "fx": rate,
            })
        return {"board": {k: board[k] for k in ("id", "name", "config")}, "base": base,
                "periods": PERIODS, "tiles": tiles, "fx": fx, "provider": prov.name,
                "as_of": time.time()}

    # ------------------------------------------------------------------ portfolio
    def _validate_position(p: dict, partial: bool):
        if not partial:
            if p.get("quantity") is None or p.get("avg_cost") is None:
                raise HTTPException(400, "quantity and avg_cost are required")
            if not p.get("symbol") and p.get("manual_price") is None:
                raise HTTPException(400, "symbol or manual_price is required")
        if p.get("currency") and len(p["currency"]) != 3:
            raise HTTPException(400, "currency must be a 3-letter ISO code")
        if p.get("bought_at") and p["bought_at"] > date.today() + timedelta(days=1):
            raise HTTPException(400, "purchase date is in the future")

    def _check_exits(cur: dict, d: dict):
        tp = d["target_price"] if "target_price" in d else cur.get("target_price")
        sl = d["stop_price"] if "stop_price" in d else cur.get("stop_price")
        if tp is not None and sl is not None and sl >= tp:
            raise HTTPException(400, "The stop loss must be below the target price.")

    def _check_fifo(lots: list[dict], sells: list[dict], editing_buy: bool = False):
        """Refuse any change that leaves a sale selling more than was held at its date."""
        short = ledger.fifo(lots, sells).shortfalls
        if short:
            x = short[0]
            where = f" in {x['account']}" if x["account"] else ""
            sold = x["missing"] + x["held"]
            if editing_buy:
                raise HTTPException(400, f"Your sale of {sold:g} {x['symbol']}{where} on {x['date']} needs this buy "
                                         f"(only {x['held']:g} would be left to sell). Adjust or delete that sale first.")
            raise HTTPException(400, f"On {x['date']} you held only {x['held']:g} {x['symbol']}{where} "
                                     f"(buys dated on or before the sale), so you can't sell {sold:g}.")

    def _sells():
        return [t for t in db.list_transactions() if t["type"] == "SELL"]

    @app.get("/api/positions")
    def list_positions():
        return db.list_positions()

    @app.post("/api/positions", status_code=201)
    def create_position(p: PositionIn):
        d = p.model_dump()
        _validate_position(d, partial=False)
        _check_exits({}, d)
        return {"id": db.create_position(d)}

    @app.patch("/api/positions/{pos_id}")
    def update_position(pos_id: int, p: PositionIn):
        d = p.model_dump(exclude_unset=True)
        _validate_position(d, partial=True)
        cur = next((x for x in db.list_positions() if x["id"] == pos_id), None)
        if cur is None:
            raise HTTPException(404, "position not found")
        _check_exits(cur, d)
        lots = [({**x, **{k: (str(v) if k == "bought_at" and v else v) for k, v in d.items()}} if x["id"] == pos_id else x)
                for x in db.list_positions()]
        _check_fifo(lots, _sells(), editing_buy=True)
        db.update_position(pos_id, d)
        return {"ok": True}

    @app.delete("/api/positions/{pos_id}", status_code=204)
    def delete_position(pos_id: int):
        _check_fifo([x for x in db.list_positions() if x["id"] != pos_id], _sells(), editing_buy=True)
        db.delete_position(pos_id)

    # ---- transactions: sells & dividends
    def _validate_tx(t: dict):
        typ = t.get("type")
        if typ not in ("SELL", "DIVIDEND"):
            raise HTTPException(400, "type must be SELL or DIVIDEND")
        if not t.get("symbol") or not t.get("date") or not t.get("currency"):
            raise HTTPException(400, "symbol, date and currency are required")
        if len(t["currency"]) != 3:
            raise HTTPException(400, "currency must be a 3-letter ISO code")
        if date.fromisoformat(str(t["date"])[:10]) > date.today() + timedelta(days=1):
            raise HTTPException(400, "date is in the future")
        if typ == "SELL" and (not t.get("quantity") or t.get("price") is None):
            raise HTTPException(400, "a sale needs quantity and price")
        if typ == "DIVIDEND":
            if not t.get("amount"):
                raise HTTPException(400, "a dividend needs an amount")
            if (t.get("withholding") or 0) > t["amount"]:
                raise HTTPException(400, "withholding can't exceed the gross amount")

    @app.get("/api/transactions")
    def list_transactions():
        return db.list_transactions()

    @app.post("/api/transactions", status_code=201)
    def create_transaction(t: TxIn):
        d = t.model_dump()
        d["symbol"] = (d.get("symbol") or "").strip().upper()
        d["type"] = (d.get("type") or "").upper()
        d["currency"] = (d.get("currency") or "").upper()
        _validate_tx(d)
        if d["type"] == "SELL":
            _check_fifo(db.list_positions(), _sells() + [{**d, "id": None, "date": str(d["date"])}])
        return {"id": db.create_transaction(d)}

    @app.patch("/api/transactions/{tx_id}")
    def update_transaction(tx_id: int, t: TxIn):
        cur = db.get_transaction(tx_id)
        if not cur:
            raise HTTPException(404, "transaction not found")
        d = t.model_dump(exclude_unset=True)
        d.pop("type", None)
        merged = {**cur, **{k: (str(v) if k == "date" else v) for k, v in d.items()}}
        merged["symbol"] = (merged.get("symbol") or "").upper()
        merged["currency"] = (merged.get("currency") or "").upper()
        _validate_tx(merged)
        if merged["type"] == "SELL":
            _check_fifo(db.list_positions(), [merged if x["id"] == tx_id else x for x in _sells()])
        db.update_transaction(tx_id, d)
        return {"ok": True}

    @app.delete("/api/transactions/{tx_id}", status_code=204)
    def delete_transaction(tx_id: int):
        db.delete_transaction(tx_id)

    # ---- shared computations
    def _fxbook(base: str, currencies: set, start: date) -> ledger.FxBook:
        currencies = {c.upper() for c in currencies if c}
        spot = engine.fx_rates(currencies, base)
        pairs = {c: f"{c}{base}=X" for c in currencies if c != base}
        hist = engine.history(list(pairs.values()), start) if pairs else {}
        return ledger.FxBook(base, spot, {c: hist.get(pair) for c, pair in pairs.items()})

    def _benchmark(base: str, start: date, sym: str | None = None):
        """(symbol, name, series in base currency, native series, currency) — or Nones when unavailable."""
        sym = (sym or db.get_settings().get("benchmark") or DEFAULT_BENCHMARK).upper()
        try:
            hist = engine.history([sym], start).get(sym)
            meta = engine.meta([sym]).get(sym) or {}
        except Exception as e:  # noqa: BLE001
            log.info("benchmark %s unavailable: %s", sym, e)
            hist, meta = None, {}
        if hist is None or hist.empty:
            return sym, meta.get("name") or sym, None, None, None
        ccy, _ = normalize_currency(meta.get("currency"))
        fx = _fxbook(base, {ccy}, start)
        idx = hist.index
        return sym, meta.get("name") or sym, hist * fx.on_index(ccy, idx), hist, ccy

    _src_auto: dict[str, str] = {}
    _src_checked: dict[str, float] = {}

    def _sync_sources(syms) -> None:
        """Price some listings from another listing of the same fund. Yahoo's data for secondary listings (Munich,
        Stuttgart…) is often only a few weeks long, stale or without intraday highs/lows, while the main listing
        (Xetra) has years of clean data. Auto: an ETF/fund whose own history is short or stale gets the listing
        `_alt_listing` finds (same ticker root, same currency, Xetra first). Manual: settings.price_sources
        {"IBCF.MU": "IBCF.DE"}; an empty value keeps the symbol's own prices."""
        manual = {k.upper(): (v or "").strip().upper() for k, v in (db.get_settings().get("price_sources") or {}).items()}
        now = time.time()
        todo = [s_ for s_ in dict.fromkeys(syms) if s_ and s_.upper() not in manual and s_ not in _src_auto
                and now - _src_checked.get(s_, 0) > 6 * 3600]
        if todo:
            meta = engine.meta(todo)
            for s_ in todo:
                _src_checked[s_] = now
                if (meta.get(s_) or {}).get("quote_type") not in ("ETF", "MUTUALFUND"):
                    continue
                h = engine.history([s_], date.today() - timedelta(days=400)).get(s_)
                if (h is not None and len(h) >= 200 and h.index[0] <= pd.Timestamp(date.today() - timedelta(days=330))
                        and h.index[-1] >= pd.Timestamp(date.today() - timedelta(days=7))):
                    continue
                try:
                    alt = _alt_listing(s_)
                except Exception as e:  # noqa: BLE001
                    log.warning("price source lookup for %s failed: %s", s_, e)
                    alt = None
                if alt:
                    log.info("pricing %s from %s (own Yahoo history is short or stale)", s_, alt)
                    _src_auto[s_] = alt
        final = {k: v for k, v in _src_auto.items() if k.upper() not in manual}
        final.update({k: v for k, v in manual.items() if v})
        if final != engine.sources:
            engine.set_sources(final)

    def _context(base: str):
        lots = db.list_positions()
        _sync_sources([x["symbol"] for x in lots if x["symbol"] and x["manual_price"] is None])
        txs = db.list_transactions()
        sells = [t for t in txs if t["type"] == "SELL"]
        divs = [t for t in txs if t["type"] == "DIVIDEND"]
        fr = ledger.fifo(lots, sells)
        return lots, sells, divs, fr

    def _realized(base, lots, sells, divs, fr):
        if not sells and not divs and not any(x.get("fees") for x in lots):
            return {"per_sell": {}, "per_div": {}, "years": {}, "total_gain": 0.0, "total_div_net": 0.0,
                    "total_fees": 0.0}, None
        dates = [ledger.lot_date(x) for x in lots] + [ledger.tx_date(t) for t in sells + divs]
        ccys = {x["currency"] for x in lots} | {t["currency"] for t in sells + divs}
        fx = _fxbook(base, ccys, min(dates))
        return ledger.realized(lots, sells, divs, fr, fx), fx

    def _open_rows(base, lots, fr):
        """Open lots (FIFO remainder) valued at live prices. Cost uses today's FX, as before."""
        open_lots = [x for x in lots if fr.remaining.get(x["id"], 0) > ledger.EPS]
        syms = [x["symbol"] for x in open_lots if x["symbol"] and x["manual_price"] is None]
        quotes = engine.quotes(syms) if syms else {}
        ccys = {x["currency"] for x in open_lots} | {q.currency for q in quotes.values()}
        fx = engine.fx_rates(ccys, base)
        rows = []
        tot = {"value": 0.0, "cost": 0.0, "day_pnl": 0.0}
        for p in open_lots:
            qty = fr.remaining[p["id"]]
            q = quotes.get(p["symbol"]) if p["manual_price"] is None else None
            r = {**p, "orig_quantity": p["quantity"], "quantity": qty, "ok": False, "price": None,
                 "price_currency": p["currency"], "changes": {}, "value": None, "cost": None, "pnl": None,
                 "pnl_pct": None, "day_pnl": None, "quote_type": None, "sector": None, "industry": None,
                 "spark": [], "display_name": p["name"] or p["symbol"],
                 "price_source": engine.sources.get(p["symbol"]) if p["manual_price"] is None else None}
            fx_cost = fx.get(p["currency"])
            if p["manual_price"] is not None:
                price, pccy, prev = p["manual_price"], p["currency"], None
                r["quote_type"] = "MANUAL"
            elif q and q.ok:
                price, pccy, prev = q.price, q.currency, q.prev_close
                r.update(changes=q.changes, quote_type=q.quote_type, sector=q.sector,
                         industry=q.industry, spark=q.spark, last_date=q.last_date,
                         display_name=p["name"] or q.name or p["symbol"])
            else:
                price = None
            fx_price = fx.get(pccy) if price is not None else None
            if price is not None and fx_price and fx_cost:
                value = qty * price * fx_price
                cost = ledger.lot_cost_native(p, qty) * fx_cost
                r.update(ok=True, price=price, price_currency=pccy, value=value, cost=cost,
                         pnl=value - cost, pnl_pct=((value / cost - 1) * 100) if cost else None)
                if prev:
                    r["day_pnl"] = qty * (price - prev) * fx_price
                    tot["day_pnl"] += r["day_pnl"]
                tot["value"] += value
                tot["cost"] += cost
            rows.append(r)
        return rows, tot, fx

    @app.get("/api/portfolio")
    def portfolio(base: str | None = None):
        base = base_or_default(base)
        lots, sells, divs, fr = _context(base)
        rows, tot, fx = _open_rows(base, lots, fr)
        rz, _ = _realized(base, lots, sells, divs, fr)
        tot["pnl"] = tot["value"] - tot["cost"]
        tot["pnl_pct"] = (tot["pnl"] / tot["cost"] * 100) if tot["cost"] else None
        prev_val = tot["value"] - tot["day_pnl"]
        tot["day_pct"] = (tot["day_pnl"] / prev_val * 100) if prev_val else None
        tot["count"] = len(rows)
        tot["missing"] = sum(1 for r in rows if not r["ok"])
        tot["realized"] = rz["total_gain"]
        tot["dividends"] = rz["total_div_net"]
        tot["fees"] = rz["total_fees"]
        tot["total_return"] = tot["pnl"] + rz["total_gain"] + rz["total_div_net"]

        # benchmark over the same holding period as each open lot
        bench = {"symbol": (db.get_settings().get("benchmark") or DEFAULT_BENCHMARK).upper(), "ok": False}
        dated = [r for r in rows if r["ok"] and r.get("bought_at")]   # undated buys: no fair comparison
        if dated:
            sym, name, b_base, _, _ = _benchmark(base, min(ledger.lot_date(r) for r in dated))
            bench.update(symbol=sym, name=name)
            if b_base is not None:
                bench["ok"] = True
                bv = bc = vv = 0.0
                for r in dated:
                    br = ledger.bench_return(b_base, ledger.lot_date(r))
                    if br is None:
                        continue
                    r["bench_ret"] = br * 100
                    r["bench_value"] = r["cost"] * (1 + br)
                    r["vs_bench"] = (r["value"] - r["bench_value"]) / r["cost"] * 100 if r["cost"] else None
                    bv += r["bench_value"]
                    bc += r["cost"]
                    vv += r["value"]
                tot["bench_value"] = bv
                tot["vs_bench"] = (vv - bv) / bc * 100 if bc else None
        return {"base": base, "positions": rows, "totals": tot, "fx": fx, "periods": PERIODS,
                "benchmark": bench, "provider": prov.name, "as_of": time.time()}

    @app.get("/api/ledger")
    def ledger_view(base: str | None = None):
        base = base_or_default(base)
        lots, sells, divs, fr = _context(base)
        rz, fxb = _realized(base, lots, sells, divs, fr)
        if fxb is None and lots:
            fxb = _fxbook(base, {x["currency"] for x in lots}, min(ledger.lot_date(x) for x in lots))
        events = []
        for x in lots:
            d = ledger.lot_date(x)
            events.append({"kind": "BUY", "id": x["id"], "date": d.isoformat(), "date_known": bool(x.get("bought_at")),
                           "symbol": x["symbol"], "name": x["name"], "account": x["account"],
                           "quantity": x["quantity"], "remaining": fr.remaining.get(x["id"]),
                           "price": x["avg_cost"], "currency": x["currency"], "fees": x.get("fees"),
                           "amount": ledger.lot_cost_native(x) * fxb.at(x["currency"], d) if fxb else None})
        for t in sells:
            r = rz["per_sell"].get(t["id"]) or {}
            events.append({"kind": "SELL", "id": t["id"], "date": t["date"], "symbol": t["symbol"],
                           "account": t["account"], "quantity": t["quantity"], "price": t["price"],
                           "currency": t["currency"], "fees": t["fees"], "notes": t["notes"],
                           "amount": r.get("proceeds"), "cost": r.get("cost"), "gain": r.get("gain"),
                           "lots": r.get("lots", [])})
        for t in divs:
            r = rz["per_div"].get(t["id"]) or {}
            events.append({"kind": "DIVIDEND", "id": t["id"], "date": t["date"], "symbol": t["symbol"],
                           "account": t["account"], "gross_native": t["amount"], "withholding_native": t["withholding"],
                           "currency": t["currency"], "notes": t["notes"], "amount": r.get("net"),
                           "gross": r.get("gross"), "withholding": r.get("withholding")})
        events.sort(key=lambda e: (e["date"], e["kind"] != "BUY"), reverse=True)
        return {"base": base, "events": events, "years": rz["years"], "total_gain": rz["total_gain"],
                "total_dividends": rz["total_div_net"], "total_fees": rz["total_fees"],
                "fx_approx": sorted(fxb.approx) if fxb else []}

    @app.get("/api/performance")
    def performance(base: str | None = None):
        base = base_or_default(base)
        lots, sells, divs, fr = _context(base)
        if not lots:
            return {"base": base, "dates": [], "summary": None}
        start = min([ledger.lot_date(x) for x in lots] + [ledger.tx_date(t) for t in sells + divs])
        rows, tot, _ = _open_rows(base, lots, fr)
        priced = sorted({x["symbol"] for x in lots if x["symbol"] and x["manual_price"] is None})
        prices = engine.history(priced, start) if priced else {}
        meta = engine.meta(priced) if priced else {}
        price_ccy = {s: normalize_currency((meta.get(s) or {}).get("currency"))[0] for s in priced}
        sym, name, _, b_native, b_ccy = _benchmark(base, start)
        ccys = ({x["currency"] for x in lots} | {t["currency"] for t in sells + divs} | set(price_ccy.values())
                | ({b_ccy} if b_ccy else set()))
        fx = _fxbook(base, ccys, start)
        rz = ledger.realized(lots, sells, divs, fr, fx)
        perf = ledger.performance(lots, sells, divs, fr, rz, fx, prices, price_ccy, b_native, b_ccy,
                                  value_now=tot["value"] + sum(r["cost"] or 0 for r in rows if not r["ok"]))
        missing = [s for s in priced if s not in prices]
        return {"base": base, **perf, "benchmark": {"symbol": sym, "name": name, "ok": b_native is not None},
                "missing_history": missing, "fx_approx": sorted(fx.approx), "as_of": time.time()}

    # ------------------------------------------------------------------ taxes (Spain)
    @app.get("/api/tax")
    def tax_view(year: int | None = None):
        cur_base = "EUR"   # Spanish IRPF is always computed in euros
        today = date.today()
        year = year or today.year
        st = db.get_settings()
        brackets = st.get("tax_brackets") or tax.DEFAULT_BRACKETS
        prior = st.get("tax_prior_losses") or {}
        lots, sells, divs, fr = _context(cur_base)
        dates = [ledger.lot_date(x) for x in lots] + [ledger.tx_date(t) for t in sells + divs]
        ccys = {x["currency"] for x in lots} | {t["currency"] for t in sells + divs}
        fx = _fxbook(cur_base, ccys, min(dates) if dates else today)
        rz = ledger.realized(lots, sells, divs, fr, fx)
        comp = tax.compute_years(lots, sells, divs, fr, rz, prior, brackets, through=max(year, today.year))
        years = comp["years"]
        ws = comp["wash"]
        lots_by_id = {x["id"]: x for x in lots}
        two_m = lambda d: (pd.Timestamp(d) + pd.DateOffset(months=2)).date().isoformat()  # noqa: E731

        sales = []
        for t in sells:
            if ledger.tx_date(t).year != year or t["id"] not in rz["per_sell"]:
                continue
            r = rz["per_sell"][t["id"]]
            b = ws["blocked"].get(t["id"], 0.0)
            sales.append({"id": t["id"], "date": t["date"], "symbol": t["symbol"], "account": t["account"],
                          "quantity": t["quantity"], "proceeds": r["proceeds"], "cost": r["cost"], "gain": r["gain"],
                          "blocked": b, "computable": r["gain"] - b,
                          "replacements": [{**x, "bought_at": ledger.lot_date(lots_by_id[x["lot_id"]]).isoformat()}
                                           for x in ws["replacements"].get(t["id"], [])],
                          "rebuy_until": two_m(ledger.tx_date(t)) if r["gain"] < 0 else None})
        released = [{"date": d.isoformat(), "amount": a, "symbol": lots_by_id[lid]["symbol"]}
                    for d, a, _sid, lid in ws["released"] if d.year == year]
        dividends = [{"date": t["date"], "symbol": t["symbol"], **rz["per_div"][t["id"]]}
                     for t in divs if ledger.tx_date(t).year == year]

        # what-if for the current year: selling each open position today
        cy = years[today.year]
        carry_in = cy.get("_carry_in_raw", [])
        rows, _, spot = _open_rows(cur_base, lots, fr)
        by_sym: dict = {}
        cutoff = today - timedelta(days=61)
        for r in rows:
            if not r["ok"]:
                continue
            key = (r["symbol"] or r["display_name"] or str(r["id"])).upper()
            cost_tax = ledger.lot_cost_native(r, r["quantity"]) * fx.at(r["currency"], ledger.lot_date(r))
            a = by_sym.setdefault(key, {"symbol": r["symbol"], "name": r["display_name"], "quantity": 0.0,
                                        "value": 0.0, "cost": 0.0, "recent_qty": 0.0, "accounts": set()})
            a["quantity"] += r["quantity"]
            a["value"] += r["value"]
            a["cost"] += cost_tax
            a["accounts"].add(r["account"] or "")
            if ledger.lot_date(r) >= cutoff:
                a["recent_qty"] += r["quantity"]
        sim = []
        for a in by_sym.values():
            gain = a["value"] - a["cost"]
            sim.append({**a, "accounts": sorted(a["accounts"]), "gain": gain,
                        "tax": tax.marginal(cy, carry_in, gain, brackets)})
        sim.sort(key=lambda x: x["gain"])
        total_gain = sum(x["gain"] for x in sim)
        harvest = [{**x, "saving": -x["tax"], "rebuy_until": two_m(today)} for x in sim if x["gain"] < -0.005]
        warnings = []
        for t in sells:
            r = rz["per_sell"].get(t["id"])
            d = ledger.tx_date(t)
            if r and r["gain"] < 0 and (today - d).days <= 62:
                warnings.append({"kind": "rebuy", "symbol": t["symbol"], "until": two_m(d), "loss": r["gain"],
                                 "sale_date": t["date"]})
        for p in ws["pending"]:
            warnings.append({"kind": "deferred", "symbol": p["symbol"], "amount": p["amount"]})
        for y in years.values():
            y.pop("_carry_in_raw", None)
        return {
            "year": year, "today": today.isoformat(), "currency": "EUR", "brackets": brackets,
            "prior_losses": prior,
            "years": [years[y] for y in sorted(years, reverse=True)],
            "selected": years[year], "sales": sales, "released": released, "dividends": dividends,
            "simulation": {"positions": sim, "sell_all_gain": total_gain,
                           "sell_all_tax": tax.marginal(cy, carry_in, total_gain, brackets) if sim else 0.0,
                           "year_now": cy},
            "harvest": harvest, "warnings": warnings, "fx_approx": sorted(fx.approx),
        }

    # ------------------------------------------------------------------ sell targets
    def _levels():
        """Suggested levels, volatility, breakouts and analyst consensus per symbol; peak since each buy."""
        lots, _sells, _divs, fr = _context("EUR")
        open_lots = [x for x in lots if fr.remaining.get(x["id"], 0) > ledger.EPS
                     and x["symbol"] and x["manual_price"] is None]
        if not open_lots:
            return {"symbols": {}, "lots": {}}
        syms = sorted({x["symbol"] for x in open_lots})
        start = min([date.today() - timedelta(days=levels.LOOKBACK_DAYS)]
                    + [ledger.lot_date(x) for x in open_lots if x.get("bought_at")])
        hist = engine.history(syms, start)
        quotes = engine.quotes(syms)
        meta = engine.meta(syms)
        eq = [s_ for s_ in syms if (meta.get(s_) or {}).get("quote_type") == "EQUITY"
              or (quotes.get(s_) and quotes[s_].quote_type == "EQUITY")]
        try:
            cons = engine.analyst(eq) if eq else {}
        except Exception as e:  # noqa: BLE001 — consensus is optional
            log.info("analyst consensus failed: %s", e)
            cons = {}
        funds_syms = [s_ for s_ in syms if ((meta.get(s_) or {}).get("quote_type") in ("ETF", "MUTUALFUND"))
                      or (quotes.get(s_) and quotes[s_].quote_type in ("ETF", "MUTUALFUND"))]
        try:
            implied = _implied_upside(funds_syms, open_lots, meta) if funds_syms else {}
        except Exception as e:  # noqa: BLE001 — optional
            log.info("implied fund targets failed: %s", e)
            implied = {}
        out, series = {}, {}
        for s_ in syms:
            ser = hist.get(s_)
            q = quotes.get(s_)
            if ser is None or ser.empty:
                continue
            a = levels.analyze(ser, q.price if q and q.ok else None)
            if not a:
                continue
            series[s_] = a.pop("series")
            c = dict(cons[s_]) if s_ in cons else None
            if c and not (0.2 < c["mean"] / a["price"] < 5):     # different currency unit — don't trust it
                c = None
            if c is None and s_ in implied:                       # ETF: weighted consensus of its holdings
                im = implied[s_]
                c = {**im, "implied": True, "mean": a["price"] * (1 + im["upside"] / 100)}
            if c:
                c["upside"] = (c["mean"] / a["price"] - 1) * 100
                for z in a["resistance"] + a["support"]:
                    z["confluence"] = abs(z["level"] / c["mean"] - 1) <= 0.03
                if a["resistance"]:
                    near = a["resistance"][0]
                    c["vs_resistance"] = (c["mean"] / near["level"] - 1) * 100
                    c["likely_break"] = c["mean"] > near["hi"] * 1.05
            a["analyst"] = c
            out[s_] = a
        lot_out = {}
        for x in open_lots:
            ser = series.get(x["symbol"])
            if ser is None or not x.get("bought_at"):
                continue
            ser = ser[ser.index >= pd.Timestamp(ledger.lot_date(x))]
            if ser.empty:
                continue
            hi, lo = ser.idxmax(), ser.idxmin()
            lot_out[str(x["id"])] = {"peak": float(ser.loc[hi]), "peak_date": hi.date().isoformat(),
                                     "low": float(ser.loc[lo]), "low_date": lo.date().isoformat()}
        return {"symbols": out, "lots": lot_out}

    def _implied_upside(fund_syms: list[str], open_lots: list[dict], meta: dict) -> dict:
        """ETF implied upside: analyst consensus upside of each top holding, weighted by its share of the fund.

        Funds Yahoo has no holdings for borrow them from the proxy ETF of their index (as in Exposure). The part of
        the fund not covered is assumed to have the same average upside; `coverage` says how much was covered."""
        fd = engine.funds(fund_syms)
        overrides = db.get_settings().get("fund_profiles") or {}
        src = {}
        for f in fund_syms:
            fund = fd.get(f)
            if fund and fund.get("holdings"):
                src[f] = (fund["holdings"], None)
                continue
            row = next((x for x in open_lots if x["symbol"] == f), {})
            _, prof = exposure.fund_profile(f, row, meta.get(f) or {}, fund or {}, overrides)
            px = exposure.PROFILES.get(prof, {}).get("proxy")
            if px:
                src[f] = (None, px)
        pxs = sorted({px for _, px in src.values() if px})
        pfd = engine.funds(pxs) if pxs else {}
        hold = {}
        for f, (h, px) in src.items():
            h = h if h is not None else (pfd.get(px) or {}).get("holdings") or []
            h = [x for x in h if x.get("symbol") and (x.get("weight") or 0) > 0]
            if h:
                hold[f] = (h, px)
        all_h = sorted({x["symbol"] for h, _ in hold.values() for x in h})
        if not all_h:
            return {}
        cons = engine.analyst(all_h)
        qts = engine.quotes(all_h)
        out = {}
        for f, (h, px) in hold.items():
            used = []
            for x in h:
                c, q = cons.get(x["symbol"]), qts.get(x["symbol"])
                if not (c and q and q.ok and q.price and c.get("mean")):
                    continue
                r = c["mean"] / q.price
                if not 0.2 < r < 5:
                    continue
                used.append({"symbol": x["symbol"], "name": x.get("name") or x["symbol"], "weight": x["weight"] * 100,
                             "upside": (r - 1) * 100, "n": c.get("n")})
            cov = sum(u["weight"] for u in used)
            if cov <= 0:
                continue
            out[f] = {"upside": sum(u["weight"] * u["upside"] for u in used) / cov, "coverage": cov,
                      "n_holdings": len(used), "n_top": len(h), "proxy": px,
                      "n": sum(u["n"] or 0 for u in used) or None,
                      "top": sorted(used, key=lambda u: -u["weight"])[:10]}
        return out

    @app.get("/api/targets/levels")
    def target_levels():
        return _levels()

    @app.get("/api/targets/peaks")
    def target_peaks():
        """Highest close since each open, dated buy (quote currency, bad ticks removed)."""
        return {"peaks": _levels()["lots"]}

    # ------------------------------------------------------------------ risk
    def _base_prices(base: str, syms: list[str], start: date) -> tuple[dict, dict]:
        """Daily closes converted to the base currency, plus each symbol's meta."""
        hist = engine.history(syms, start) if syms else {}
        meta = engine.meta(syms) if syms else {}
        ccy = {s_: normalize_currency((meta.get(s_) or {}).get("currency"))[0] for s_ in syms}
        fx = _fxbook(base, {c for c in ccy.values() if c}, start)
        out = {}
        for s_, ser in hist.items():
            if ser is not None and not ser.empty:
                out[s_] = (ser * fx.on_index(ccy.get(s_), ser.index)).dropna()
        return out, meta

    def _asset_class(sym: str, row: dict, m: dict, overrides: dict) -> str:
        qt = row.get("quote_type") or m.get("quote_type")
        if row.get("manual_price") is not None or not sym:
            return "other"
        if qt == "CRYPTOCURRENCY":
            return "crypto"
        if qt in ("ETF", "MUTUALFUND"):
            _, prof = exposure.fund_profile(sym, row, m, {}, overrides)
            asset = exposure.PROFILES.get(prof, {}).get("asset")
            return {"Bonds": "bond", "Commodities": "gold"}.get(asset, "equity")
        return "equity"

    def _fx_share(sym: str, row: dict, m: dict, cls_: str, base: str, overrides: dict) -> float:
        """Part of the holding exposed to currencies other than the base (for the FX stress)."""
        if cls_ == "other":
            return 0.0
        if cls_ == "crypto":
            return 0.0 if base == "USD" else 1.0
        name = " ".join(filter(None, [m.get("long_name"), m.get("name"), row.get("display_name")]))
        if exposure.hedge_currency(name, base) == base:
            return 0.0
        if row.get("quote_type") in ("ETF", "MUTUALFUND") or m.get("quote_type") in ("ETF", "MUTUALFUND"):
            _, prof = exposure.fund_profile(sym, row, m, {}, overrides)
            pr = exposure.PROFILES.get(prof)
            if not pr:
                return 0.0 if (row.get("price_currency") == base) else 1.0
            tot = sum(pr["countries"].values()) or 1
            if pr.get("currency"):
                return 0.0 if pr["currency"] == base else 1.0
            return sum(w for c, w in pr["countries"].items()
                       if exposure.COUNTRY_CCY.get(c, "Other") != base) / tot
        ccy = exposure.COUNTRY_CCY.get(exposure.country_of(sym, m)) or row.get("price_currency")
        return 0.0 if ccy == base else 1.0

    RISK_BENCHMARKS = ["IWDA.AS", "VWCE.DE", "SXR8.DE", "EQQQ.DE", "IS3N.DE", "MEUD.PA"]

    def _alt_listing(sym: str) -> str | None:
        """Another listing of the same fund with a longer history: same root ticker, same currency, same price (±3%)."""
        key = f"alt2:{sym}"   # v2: Xetra first, works when our own quote is missing
        hit = db.get_meta([key], 7 * 86400).get(key)
        if hit is not None:
            return hit.get("symbol")
        root = sym.split(".")[0].upper()
        try:
            cands = [r["symbol"] for r in prov.search(root, limit=15)
                     if r["symbol"].split(".")[0].upper() == root and r["symbol"].upper() != sym.upper()]
        except Exception:  # noqa: BLE001
            cands = []
        best = None
        if cands:
            q = engine.quotes([sym] + cands)
            own = q.get(sym)
            own_ccy = (own.currency if own else None) or normalize_currency((engine.meta([sym]).get(sym) or {}).get("currency"))[0]
            hist = engine.history(cands, date.today() - timedelta(days=3 * 365))
            for c in cands:
                qc, h = q.get(c), hist.get(c)
                if not (qc and qc.ok and qc.currency == own_ccy) or h is None or len(h) < 250:
                    continue
                # same price when ours has one (Yahoo often has none, or a stale one, for Munich listings)
                if own and own.ok and abs(qc.price / own.price - 1) >= 0.03:
                    continue
                rank = (not c.upper().endswith(".DE"), h.index[0])     # Xetra first: the main, most liquid venue
                if best is None or rank < best[1]:
                    best = (c, rank)
        db.put_meta(key, {"symbol": best[0] if best else None})
        return best[0] if best else None

    def _splice_proxies(base: str, px: dict, keys: list[str], meta: dict, info: dict, since: date) -> dict:
        """For holdings whose own price history starts well after `since`, prepend a proxy with a long history:
        your manual choice (Risk tab), another listing of the same fund, or an ETF on the same index (in its local
        currency when your fund is hedged to your base currency). Returns {key: proxy info}; `px` is updated."""
        cfg = {k.upper(): v.upper() for k, v in (db.get_settings().get("risk_proxies") or {}).items() if v}
        overrides = db.get_settings().get("fund_profiles") or {}
        used = {}
        for k in keys:
            own = px.get(k)
            if own is not None and len(own) and own.index[0] <= pd.Timestamp(since) + pd.Timedelta(days=30):
                continue
            m = meta.get(k) or {}
            row = info.get(k) or {}
            qt = row.get("quote_type") or m.get("quote_type")
            cand, kind = cfg.get(k.upper()), "manual"
            if not cand and qt in ("ETF", "MUTUALFUND"):
                alt = _alt_listing(k)
                if alt:
                    cand, kind = alt, "listing"
                else:
                    _, prof = exposure.fund_profile(k, row, m, {}, overrides)
                    cand, kind = exposure.PROFILES.get(prof, {}).get("proxy"), "index"
            if not cand:
                continue
            name = " ".join(filter(None, [m.get("long_name"), m.get("name"), row.get("display_name")]))
            hedged = kind == "index" and exposure.hedge_currency(name, base) == base
            if hedged:     # a hedged fund moves like the index in its own currency, without the FX swings
                pser = engine.history([cand], since - timedelta(days=10)).get(cand)
            else:
                pser = _base_prices(base, [cand], since - timedelta(days=10))[0].get(cand)
            if pser is None or pser.empty:
                continue
            pser = pser.dropna()
            if own is not None and len(own):
                t0 = own.index[0]
                before = pser[pser.index < t0]
                at = pser[pser.index <= t0]
                if before.empty or at.empty or not at.iloc[-1]:
                    continue
                synth = pd.concat([before * (float(own.iloc[0]) / float(at.iloc[-1])), own])
            else:
                t0, synth = None, pser
            px[k] = synth[~synth.index.duplicated(keep="last")].sort_index()
            used[k] = {"symbol": cand, "kind": kind, "hedged": hedged,
                       "until": t0.date().isoformat() if t0 is not None else None}
        return used

    def _diversified_since(lots: list[dict], sells: list[dict], fr) -> tuple[date | None, dict]:
        """First day the open positions (at cost) look like a portfolio: ≥ 3 effective holdings and none above 50%."""
        sell_date = {t["id"]: ledger.tx_date(t) for t in sells}
        sold = {}
        for mt in fr.matches:
            sold.setdefault(mt.lot_id, []).append((sell_date.get(mt.sell_id), mt.qty))
        fxr = engine.fx_rates({x["currency"] for x in lots}, "EUR")
        days = sorted({ledger.lot_date(x) for x in lots} | set(sell_date.values()))
        first = None
        for d in days:
            w = {}
            for x in lots:
                if ledger.lot_date(x) > d:
                    continue
                q = float(x["quantity"]) - sum(qq for dd, qq in sold.get(x["id"], []) if dd and dd <= d)
                if q <= ledger.EPS:
                    continue
                key = x["symbol"] or f"m{x['id']}"
                w[key] = w.get(key, 0.0) + ledger.lot_cost_native(x, q) * (fxr.get(x["currency"]) or 1.0)
            tot = sum(w.values())
            if not tot:
                continue
            sh = sorted((v / tot for v in w.values()), reverse=True)
            if first is None:
                first = {"date": d.isoformat(), "top": max(w, key=w.get), "top_share": sh[0] * 100, "n": len(w)}
            if 1 / sum(v * v for v in sh) >= 3 and sh[0] <= 0.5:
                return d, first
        return None, first or {}

    @app.get("/api/risk")
    def risk_view(base: str | None = None, years: int = Query(3, ge=1, le=10), bench: str | None = None):
        base = base_or_default(base)
        lots, _sells, _divs, fr = _context(base)
        rows, tot, _ = _open_rows(base, lots, fr)
        settings = db.get_settings()
        overrides = settings.get("fund_profiles") or {}
        hold: dict[str, dict] = {}
        for r in rows:
            key = r["symbol"] if r["symbol"] and r["manual_price"] is None else f"manual:{r['id']}"
            h = hold.setdefault(key, {"key": key, "symbol": r["symbol"], "name": r["display_name"], "value": 0.0,
                                      "quote_type": r["quote_type"], "price_currency": r["price_currency"],
                                      "manual_price": r["manual_price"], "display_name": r["display_name"],
                                      "priced": True})
            if r["ok"]:
                h["value"] += r["value"]
            else:
                h["priced"] = False
        total = sum(h["value"] for h in hold.values())
        if total <= 0:
            return {"base": base, "empty": True}
        today = date.today()
        start = today - timedelta(days=int(years * 365.25))
        hist_start = min(start, date(2020, 1, 1)) - timedelta(days=10)      # the stress scenarios go back to 2020
        syms = [k for k in hold if not k.startswith("manual:")]
        has_crypto = any(h["quote_type"] == "CRYPTOCURRENCY" for h in hold.values())
        px, meta = _base_prices(base, syms + (["BTC-USD"] if has_crypto and "BTC-USD" not in syms else []), hist_start)
        proxies = _splice_proxies(base, px, syms, meta, hold, hist_start)
        bench = (bench or (settings.get("risk") or {}).get("benchmark") or DEFAULT_BENCHMARK).upper()
        b_sym, b_name, b_base, _, _ = _benchmark(base, hist_start, bench)
        allp = {**{s_: px[s_] for s_ in syms if s_ in px}, **({"__bench__": b_base} if b_base is not None else {})}
        R_all = risk.business_returns(allp)
        R = R_all[R_all.index >= pd.Timestamp(start)] if not R_all.empty else R_all
        m_r = R["__bench__"] if "__bench__" in R else None
        cols = [s_ for s_ in syms if s_ in R.columns]
        Rh = R[cols].copy() if cols else pd.DataFrame(index=R.index)
        for k, h in hold.items():                     # manual / unpriced holdings: carried flat (0% moves)
            if k not in Rh.columns:
                Rh[k] = 0.0
        w = pd.Series({k: hold[k]["value"] / total for k in Rh.columns})
        rp = risk.portfolio_returns(Rh, w) if len(Rh) else pd.Series(dtype=float)

        def stats(r):
            if r is None or r.dropna().empty:
                return None
            dd = risk.drawdown(r)
            out = {"vol": risk.ann_vol(r), "ret": risk.ann_return(r), "dd": dd,
                   "worst_day": risk.worst_window(r, 1), "worst_month": risk.worst_window(r, 21)}
            if m_r is not None and r is not m_r:
                out["beta"], out["corr"] = risk.beta_corr(r, m_r)
            return out

        mix = stats(rp)
        bench_stats = stats(m_r) if m_r is not None else None
        fit = []
        try:
            cands = list(dict.fromkeys(RISK_BENCHMARKS + [b_sym, (settings.get("benchmark") or DEFAULT_BENCHMARK).upper()]))
            cpx, _ = _base_prices(base, cands, start - timedelta(days=10))
            CR = risk.business_returns(cpx, start)
            for c in cands:
                if c in CR and len(rp):
                    be, co = risk.beta_corr(rp, CR[c])
                    if co is not None:
                        fit.append({"symbol": c, "corr": co, "beta": be})
            fit.sort(key=lambda f: -f["corr"])
        except Exception as e:  # noqa: BLE001
            log.info("benchmark fit failed: %s", e)
        # actual portfolio, time-weighted (contributions removed), from the performance series
        actual = None
        try:
            perf = performance(base)
            if perf.get("dates"):
                v = pd.Series(perf["value"], index=pd.to_datetime(perf["dates"]), dtype=float)
                inv = pd.Series(perf["invested"], index=v.index, dtype=float)
                prev = v.shift(1)
                r_act = ((v - inv.diff().fillna(0)) / prev - 1)[prev > 0].replace([np.inf, -np.inf], np.nan).dropna()
                div_d, first = _diversified_since(lots, _sells, fr)
                full = risk.drawdown(r_act) if len(r_act) > 5 else None
                if div_d is not None:
                    r_div = r_act[r_act.index > pd.Timestamp(div_d)]
                    actual = {"dd": risk.drawdown(r_div) if len(r_div) > 5 else None, "since": div_d.isoformat(),
                              "diversified": True, "start": perf["dates"][0], "first": first, "full": full}
                elif full:
                    actual = {"dd": full, "since": perf["dates"][0], "diversified": False, "first": first}
        except Exception as e:  # noqa: BLE001
            log.info("actual drawdown failed: %s", e)

        rc = risk.risk_contributions(Rh, w) if len(Rh) else {}
        holdings = []
        for k in sorted(Rh.columns, key=lambda c: -w[c]):
            h = hold[k]
            m = meta.get(h["symbol"] or "", {}) or {}
            cls_ = _asset_class(h["symbol"], h, m, overrides)
            r = Rh[k]
            flat = k.startswith("manual:") or k not in cols
            beta = corr = corr_rest = None
            if not flat:
                if m_r is not None:
                    beta, corr = risk.beta_corr(r, m_r)
                others = [c for c in Rh.columns if c != k]
                if others and w[others].sum() > 0:
                    _, corr_rest = risk.beta_corr(r, risk.portfolio_returns(Rh[others], w[others]))
            dd = risk.drawdown(r) if not flat else None
            holdings.append({
                "key": k, "symbol": h["symbol"], "name": h["name"], "value": h["value"], "weight": w[k] * 100,
                "class": cls_, "flat": flat, "priced": h["priced"],
                "vol": risk.ann_vol(r) if not flat else None, "beta": beta, "corr_index": corr, "corr_rest": corr_rest,
                "risk_share": rc.get(k, 0.0) * 100,
                "max_dd": dd["max"] if dd else None, "dd_now": dd["current"] if dd else None,
                "fx_share": _fx_share(h["symbol"] or "", h, m, cls_, base, overrides),
                "history_from": (proxies[k]["until"] if k in proxies else
                                 (px[k].index[0].date().isoformat() if k in px else None)),
                "proxy": proxies.get(k),
            })
        top = [hh["key"] for hh in holdings if not hh["flat"]][:14]
        cm = Rh[top].corr(min_periods=40) if len(top) > 1 else None
        corr_matrix = ({"keys": top, "m": [[None if pd.isna(x) else round(float(x), 3) for x in row] for row in cm.to_numpy()]}
                       if cm is not None else None)

        conc = risk.concentration({hh["key"]: hh["value"] for hh in holdings})
        look = None
        try:
            ex = exposure_view(base)
            comp = [c for c in ex.get("companies", []) if not c.get("rest") and c.get("pct")]
            look = {"top5": sum(c["pct"] for c in comp[:5]),
                    "top": [{"name": c["name"], "symbol": c["symbol"], "pct": c["pct"],
                             "via": [v_["fund"] for v_ in c.get("via", [])][:3], "direct": c["direct"] > 0} for c in comp[:8]]}
        except Exception as e:  # noqa: BLE001
            log.info("look-through concentration failed: %s", e)

        # historical scenarios on today's mix (missing history → estimated from beta × index, or BTC for crypto)
        b_full = b_base
        btc = px.get("BTC-USD")
        scen = []
        for sc in risk.SCENARIOS:
            b_ret = risk.window_return(b_full, sc["start"], sc["end"])
            per, port, est_w = [], 0.0, 0.0
            for hh in holdings:
                k = hh["key"]
                r_ = None if hh["flat"] else risk.window_return(px.get(k), sc["start"], sc["end"])
                est = bool(r_ is not None and k in proxies and proxies[k]["until"]
                           and sc["start"] < proxies[k]["until"])
                if r_ is None and not hh["flat"]:
                    if hh["class"] == "crypto":
                        r_ = risk.window_return(btc, sc["start"], sc["end"])
                    elif hh["class"] == "equity" and b_ret is not None:
                        r_ = (hh["beta"] if hh["beta"] is not None else 1.0) * b_ret
                    est = r_ is not None
                if hh["flat"]:
                    r_ = 0.0
                if r_ is not None:
                    port += hh["weight"] / 100 * r_
                    if est:
                        est_w += hh["weight"]
                per.append({"key": k, "ret": r_, "est": est})
            known = [x for x in per if x["ret"] is not None]
            worst = min(known, key=lambda x: x["ret"]) if known else None
            scen.append({**sc, "portfolio": port, "loss": port * total, "bench": b_ret,
                         "estimated_weight": est_w, "missing": [x["key"] for x in per if x["ret"] is None],
                         "worst": worst, "per": per})
        return {
            "base": base, "years": years, "start": start.isoformat(), "total": total,
            "benchmark": {"symbol": b_sym, "name": b_name, "ok": b_base is not None},
            "mix": mix, "bench": bench_stats, "actual": actual, "fit": fit,
            "global_benchmark": (settings.get("benchmark") or DEFAULT_BENCHMARK).upper(), "holdings": holdings, "corr": corr_matrix,
            "concentration": conc, "lookthrough": look, "scenarios": scen,
            "proxies": proxies,
            "as_of": time.time(),
        }

    @app.post("/api/risk/mix")
    def risk_mix(body: MixIn):
        """Volatility of a weighted mix of tickers (base currency) — feeds the Monte Carlo projection."""
        base = base_or_default(body.base)
        wts = {k.upper(): float(v) for k, v in body.weights.items() if v and v > 0}
        if not wts:
            raise HTTPException(400, "weights required")
        start = date.today() - timedelta(days=int(body.years * 365.25))
        px, meta = _base_prices(base, sorted(wts), start - timedelta(days=10))
        _splice_proxies(base, px, sorted(wts), meta, {}, start)
        R = risk.business_returns({k: v for k, v in px.items() if k in wts}, start)
        used = [k for k in wts if k in R.columns and R[k].notna().sum() > 60]
        if not used:
            return {"vol": None, "used": [], "missing": sorted(wts)}
        w = pd.Series({k: wts[k] for k in used})
        w = w / w.sum()
        rp = risk.portfolio_returns(R[used], w)
        return {"vol": risk.ann_vol(rp), "ret": risk.ann_return(rp), "used": used,
                "missing": [k for k in wts if k not in used], "coverage": float(sum(wts[k] for k in used) / sum(wts.values())),
                "per": {k: risk.ann_vol(R[k]) for k in used}}

    # ------------------------------------------------------------------ ideas (screener)
    def _mix_returns(base: str, start: date):
        """Daily returns of today's holdings (base currency, proxies for short histories)."""
        lots, _sells, _divs, fr = _context(base)
        rows, _, _ = _open_rows(base, lots, fr)
        vals, info = {}, {}
        for r in rows:
            if r["ok"] and r["symbol"] and r["manual_price"] is None:
                vals[r["symbol"]] = vals.get(r["symbol"], 0.0) + r["value"]
                info[r["symbol"]] = r
        if not vals:
            return None
        px, meta = _base_prices(base, list(vals), start - timedelta(days=10))
        _splice_proxies(base, px, list(vals), meta, info, start)
        R = risk.business_returns({k: px[k] for k in vals if k in px}, start)
        if R.empty:
            return None
        w = pd.Series({k: vals[k] for k in R.columns})
        return risk.portfolio_returns(R, w / w.sum())

    _ideas_cache: dict = {}

    def _ideas_commodities(base: str) -> dict:
        st = db.get_settings()
        custom = list(dict.fromkeys(x.strip().upper() for x in
                                    (((st.get("ideas") or {}).get("custom") or {}).get("commodities") or []) if x.strip()))
        ck = ("commodities", base, tuple(custom))
        hit = _ideas_cache.get(ck)
        if hit and time.time() - hit[0] < 300:
            return hit[1]
        items = [dict(c) for c in ideas.COMMODITIES]
        known = {c["symbol"] for c in items}
        for x in custom:
            if x not in known:
                items.append({"symbol": x, "name": x, "group": "Your extras", "unit": "", "physical": True, "etc": [], "custom": True})
        syms = [c["symbol"] for c in items]
        today = date.today()
        hist_start = date(2019, 12, 1)                 # the crisis windows start in 2020
        raw = engine.history(syms, hist_start)
        meta = engine.meta(syms)
        bpx, _m = _base_prices(base, syms, hist_start)
        start = today - timedelta(days=365)
        CR = risk.business_returns(bpx, start) if bpx else pd.DataFrame()
        try:
            rp = _mix_returns(base, start)
        except Exception as e:  # noqa: BLE001
            log.info("portfolio returns for commodities failed: %s", e)
            rp = None
        b_sym, _bn, b_base, _bn2, _bc = _benchmark(base, start - timedelta(days=10), "IWDA.AS")
        bR = risk.business_returns({"b": b_base}, start)["b"] if b_base is not None else None
        scen = {sc["key"]: sc for sc in risk.SCENARIOS}
        cands = []
        for c in items:
            x = c["symbol"]
            h = raw.get(x)
            m = meta.get(x) or {}
            if c.get("custom"):
                c["name"] = m.get("name") or x
            c["currency"] = normalize_currency(m.get("currency"))[0] or "USD"
            if h is None or len(h.dropna()) < 60:
                c["missing"] = True
                cands.append(c)
                continue
            h = levels.clean(h)
            last = h.index[-1]

            def ret(days):
                b_ = h[h.index <= last - pd.Timedelta(days=days)]
                return float(h.iloc[-1] / b_.iloc[-1] - 1) if len(b_) else None
            ma200 = h.iloc[-200:].mean() if len(h) >= 200 else None
            ma50 = h.iloc[-50:].mean() if len(h) >= 50 else None
            y1 = h[h.index > last - pd.Timedelta(days=365)]
            p_1m = h[h.index <= last - pd.Timedelta(days=30)]
            p_13 = h[h.index <= last - pd.Timedelta(days=365)]
            c.update(price=float(h.iloc[-1]), ret_1d=float(h.iloc[-1] / h.iloc[-2] - 1), ret_1w=ret(7), ret_1m=ret(30),
                     ret_1y=ret(365), trend=(float(h.iloc[-1] / ma200 - 1) if ma200 else None),
                     golden=(bool(ma50 > ma200) if ma50 and ma200 else None),
                     mom=(float(p_1m.iloc[-1] / p_13.iloc[-1] - 1) if len(p_1m) and len(p_13) else None),
                     from_high=float(h.iloc[-1] / y1.max() - 1), vol=risk.ann_vol(y1.pct_change()))
            if rp is not None and x in CR:
                c["corr"] = risk.beta_corr(CR[x], rp)[1]
            if bR is not None and x in CR:
                c["corr_stocks"] = risk.beta_corr(CR[x], bR)[1]
            cr = {}
            for k_ in ideas.CRISES:
                sc = scen.get(k_)
                v = risk.window_return(bpx.get(x), sc["start"], sc["end"]) if sc else None
                if v is not None:
                    cr[sc["label"]] = v
            c["crises"] = cr
            c["crisis"] = (sum(cr.values()) / len(cr)) if cr else None
            c["crisis_n"] = len(cr)
            cands.append(c)
        rows_ = ideas.score_commodities([c for c in cands if not c.get("missing")])
        missing = [c["symbol"] for c in cands if c.get("missing")]
        # your asset mix (look-through): how much is already in commodities
        mix = {}
        try:
            ex = exposure_view(base)
            for r_ in ex.get("sectors", []):
                k_ = r_["key"]
                grp = ("Commodities" if k_ in ("Commodities", "Gold") else "Crypto" if k_ == "Crypto" else
                       "Bonds" if k_ == "Bonds" else "Cash & other" if k_ in ("Cash", "Other", "Unclassified", "Unknown", "Unknown (fund)")
                       else "Stocks")
                mix[grp] = mix.get(grp, 0.0) + r_["pct"]
        except Exception as e:  # noqa: BLE001
            log.info("asset mix failed: %s", e)
        held = {}
        for r_ in _open_rows(base, *(_context(base)[i] for i in (0, 3)))[0]:
            if r_.get("symbol") in syms and r_.get("value"):
                held[r_["symbol"]] = held.get(r_["symbol"], 0.0) + r_["value"]
        out = {"universe": "commodities", "base": base, "rows": rows_, "missing": missing,
               "broad": ideas.BROAD_COMMODITY_ETFS, "asset_mix": mix, "held": held,
               "has_portfolio": rp is not None, "progress": {"have": len(rows_), "total": len(items), "pending": 0},
               "custom": [{"symbol": x, "status": "added" if x not in missing else "not_found"} for x in custom],
               "as_of": time.time()}
        _ideas_cache[ck] = (time.time(), out)
        return out

    @app.get("/api/ideas")
    def ideas_view(universe: str = Query("spain", pattern="^(spain|world|commodities)$"), base: str | None = None):
        base = base_or_default(base)
        if universe == "commodities":
            return _ideas_commodities(base)
        st = db.get_settings()
        custom = list(dict.fromkeys(x.strip().upper() for x in
                                    (((st.get("ideas") or {}).get("custom") or {}).get(universe) or []) if x.strip()))
        ck = (universe, base, tuple(custom))          # a new extra ticker must not be answered from the cache
        hit = _ideas_cache.get(ck)
        if hit and time.time() - hit[0] < 300 and not hit[1]["progress"]["pending"]:
            return hit[1]
        if universe == "spain":
            base_list = list(seeds.IBEX35)
        else:
            base_list = [x for x in seeds.US_MEGACAPS + seeds.EUROPE_LEADERS if not x.endswith(".MC")] + ideas.WORLD_EXTRA
        base_list = [x.upper() for x in base_list]
        syms = list(dict.fromkeys(base_list + custom))
        fund, prog = engine.fundamentals(syms)
        today = date.today()
        hist = engine.history(syms, today - timedelta(days=400))
        # base-currency returns for the correlation with your portfolio
        ccy = {x: normalize_currency((fund.get(x) or {}).get("currency"))[0] for x in syms if fund.get(x)}
        fx = _fxbook(base, {c for c in ccy.values() if c}, today - timedelta(days=400))
        start = today - timedelta(days=365)
        bpx = {x: hist[x] * fx.on_index(ccy[x], hist[x].index) for x in syms if x in hist and x in ccy}
        CR = risk.business_returns(bpx, start) if bpx else pd.DataFrame()
        try:
            rp = _mix_returns(base, start)
        except Exception as e:  # noqa: BLE001
            log.info("portfolio returns for ideas failed: %s", e)
            rp = None
        # your look-through exposure: sectors, regions, and what you already own of each company
        my_sec, my_reg, held_sym, held_name = {}, {}, {}, {}
        try:
            ex = exposure_view(base)
            for r_ in ex.get("sectors", []):
                my_sec[r_["key"]] = r_["pct"]
            for r_ in ex.get("countries", []):
                if r_["key"] in ("Crypto (no country)", "Commodity (no country)", "Unclassified", "Unknown", "Other"):
                    continue
                reg = ideas.region_of(r_["key"])
                my_reg[reg] = my_reg.get(reg, 0.0) + r_["pct"]
            for c in ex.get("companies", []):
                if c.get("rest"):
                    continue
                if c.get("symbol"):
                    k_ = c["symbol"].upper()
                    held_sym[k_] = held_sym.get(k_, 0.0) + c["pct"]
                held_name[c["key"]] = held_name.get(c["key"], 0.0) + c["pct"]
        except Exception as e:  # noqa: BLE001
            log.info("exposure for ideas failed: %s", e)
        cands = []
        for x in syms:
            f = fund.get(x)
            if not f or (f.get("quote_type") and f["quote_type"] != "EQUITY"):
                continue
            h = hist.get(x)
            mom = from_high = vol = corr = None
            if h is not None and len(h) > 200:
                h = h.dropna()
                p_now, p_1m = float(h.iloc[-1]), float(h.iloc[-22])
                p_12m = h[h.index <= h.index[-1] - pd.Timedelta(days=365)]
                if len(p_12m):
                    mom = p_1m / float(p_12m.iloc[-1]) - 1
                hi = float(h[h.index >= h.index[-1] - pd.Timedelta(days=365)].max())
                from_high = p_now / hi - 1 if hi else None
                vol = risk.ann_vol(h.pct_change().iloc[-252:])
            if rp is not None and x in CR:
                _, corr = risk.beta_corr(CR[x], rp)
            meta_c = {"country": f.get("country")}
            country = exposure.country_of(x, meta_c)
            held = max(held_sym.get(x, 0.0), held_sym.get(x.split(".")[0], 0.0),
                       held_name.get(exposure.norm_name(f.get("name")), 0.0))
            cands.append({**f, "symbol": x, "country": country, "mom": mom, "from_high": from_high, "vol": vol,
                          "corr": corr, "held_pct": held})
        rows_ = ideas.score(cands, my_sec, my_reg, world=universe == "world")
        eq_tot = sum(v for k_, v in my_sec.items() if k_ in ideas.EQUITY_SECTORS)
        rg_tot = sum(my_reg.values())
        wsum = sum(ideas.WORLD_SECTORS.values())
        out = {"universe": universe, "base": base, "rows": rows_, "progress": prog,
               "my_sectors": {k_: my_sec.get(k_, 0.0) / eq_tot * 100 if eq_tot else 0.0 for k_ in ideas.WORLD_SECTORS},
               "ref_sectors": {k_: v / wsum * 100 for k_, v in ideas.WORLD_SECTORS.items()},
               "my_regions": {k_: my_reg.get(k_, 0.0) / rg_tot * 100 if rg_tot else 0.0 for k_ in ideas.WORLD_REGIONS},
               "ref_regions": ideas.WORLD_REGIONS, "has_portfolio": rp is not None, "as_of": time.time()}
        # what happened to each extra ticker, so the page can say so
        pend = set(getattr(engine, "_fund_job", set()) or set())
        scored = {r_["symbol"] for r_ in rows_}
        status = []
        for x in custom:
            f = fund.get(x)
            if x in base_list:
                st_ = "in_list"
            elif x in scored:
                st_ = "added"
            elif f and f.get("quote_type") and f["quote_type"] != "EQUITY":
                st_ = "not_stock"
            elif not f and x in pend:
                st_ = "loading"
            elif not f:
                st_ = "not_found"
            else:
                st_ = "no_data"
            status.append({"symbol": x, "status": st_, "name": (f or {}).get("name"),
                           "quote_type": (f or {}).get("quote_type")})
        out["custom"] = status
        _ideas_cache[ck] = (time.time(), out)
        return out

    # ------------------------------------------------------------------ Telegram alerts
    def _alert_snapshot():
        base = base_or_default(None)
        lots, _sells, _divs, fr = _context(base)
        rows, _tot, fx = _open_rows(base, lots, fr)
        try:
            lv = _levels()
        except Exception as e:  # noqa: BLE001
            log.info("levels for alerts failed: %s", e)
            lv = {}
        st = db.get_settings()
        near = (st.get("alerts") or {}).get("near_pct") or (st.get("sell_targets") or {}).get("near") or 5
        ev = alerts.evaluate(rows, fx, lv, float(near), st.get("account_fees") or {})
        try:
            earn = earnings_view().get("items", [])
        except Exception as e:  # noqa: BLE001
            log.info("earnings for alerts failed: %s", e)
            earn = []
        dist = {}
        for r in ev:
            if r["stop"] and r["price"]:
                d = (r["stop"] / r["price"] - 1) * 100
                if r["symbol"] not in dist or d > dist[r["symbol"]]:
                    dist[r["symbol"]] = d
        return {"base": base, "lots": ev, "earnings": earn, "stop_dist": dist}

    def _alert_summary() -> str:
        base = base_or_default(None)
        t = portfolio(base)["totals"]
        snap = _alert_snapshot()
        unmon = monitor.config()["events"].get("unmonitored")
        act = [r for r in snap["lots"] if r["status"] in alerts.TITLE and (r["has"] or unmon)]
        soon = [x for x in snap["earnings"] if x.get("days") is not None and 0 <= x["days"] <= 7]
        lines = [f"📊 <b>Portfolio</b> {alerts.fmt_money(t['value'], base)}",
                 f"Today {alerts.fmt_signed(t.get('day_pnl'), base)} ({alerts.fmt_pct(t.get('day_pct'), 2)}) · "
                 f"total {alerts.fmt_signed(t.get('pnl'), base)} ({alerts.fmt_pct(t.get('pnl_pct'))})"]
        if act:
            lines.append("")
            lines += [f"{alerts.EMO[r['status']]} {alerts.html.escape(r['symbol'] or '')} {alerts.title_of(r).lower()}{(' ' + alerts.direction_of(r)) if alerts.direction_of(r) else ''} · "
                      f"{alerts.fmt_money(r['price'], r['ccy'])}" for r in act]
        if soon:
            lines.append("")
            lines += [f"📅 {x['symbol']} earnings {x['next']}" for x in soon]
        return "\n".join(lines)

    monitor = alerts.Monitor(db, _alert_snapshot, _alert_summary)
    app.state.alerts = monitor
    if os.getenv("STONKS_NO_WARMUP") != "1":
        monitor.start()

    def _alerts_status():
        m = monitor
        cfg = m.config()
        me = None
        if m.token():
            try:
                me = m.tg.me()
            except Exception as e:  # noqa: BLE001
                m.last_error = str(e)
        p = m.pairing if m.pairing and time.time() < m.pairing["until"] else None
        st = m.state()
        return {"config": {k: v for k, v in cfg.items()}, "token": m.token_source(),
                "bot": {"username": me.get("username"), "name": me.get("first_name")} if me else None,
                "pairing": ({"code": p["code"], "until": p["until"],
                             "link": f"https://t.me/{me['username']}?start={p['code']}" if me else None} if p else None),
                "linked": bool(cfg.get("chat_id")), "last_check": m.last_check, "last_error": m.last_error,
                "muted_until": st.get("muted_until") or None, "log": m.log()[:20]}

    @app.get("/api/alerts")
    def alerts_get():
        return _alerts_status()

    @app.put("/api/alerts/config")
    def alerts_config(body: AlertCfgIn):
        patch = body.model_dump(exclude_unset=True)
        if "summary_time" in patch and not patch["summary_time"]:
            patch["summary_time"] = None
        if "events" in patch:
            patch["events"] = {**monitor.config()["events"], **patch["events"]}
        monitor.save_config(patch)
        return _alerts_status()

    @app.post("/api/alerts/token")
    def alerts_token(body: TokenIn):
        if monitor.token_source() == "env":
            raise HTTPException(400, "The token is set with TELEGRAM_BOT_TOKEN in the environment; change it there.")
        tok = (body.token or "").strip()
        if tok and not __import__("re").fullmatch(r"\d{5,}:[A-Za-z0-9_-]{30,}", tok):
            raise HTTPException(400, "That doesn't look like a bot token (123456789:AA…) — copy it from @BotFather.")
        old = monitor.token()
        monitor.set_token(tok or None)
        if tok:
            try:
                monitor.tg.me(refresh=True)
            except Exception as e:  # noqa: BLE001
                monitor.set_token(old)
                raise HTTPException(400, f"Telegram rejected the token: {e}") from None
        else:
            monitor.save_config({"chat_id": None, "chat_name": None})
        return _alerts_status()

    @app.post("/api/alerts/link")
    def alerts_link():
        if not monitor.token():
            raise HTTPException(400, "Set the bot token first.")
        monitor.new_pairing()
        return _alerts_status()

    @app.post("/api/alerts/unlink")
    def alerts_unlink():
        monitor.save_config({"chat_id": None, "chat_name": None})
        return _alerts_status()

    @app.post("/api/alerts/test")
    def alerts_test():
        if not monitor.config().get("chat_id"):
            raise HTTPException(400, "Link a chat first.")
        ok = monitor.send("🔔 Test from <b>stonks-dash</b>: alerts reach this chat.\n\n" + _alert_summary(), "test")
        if not ok:
            raise HTTPException(502, monitor.last_error or "Telegram send failed")
        return _alerts_status()

    @app.post("/api/alerts/check")
    def alerts_check_now():
        if not monitor.config().get("chat_id"):
            raise HTTPException(400, "Link a chat first.")
        sent = monitor.check(force=True)
        return {"sent": len(sent), **_alerts_status()}

    # ------------------------------------------------------------------ daily moves (Holdings)
    @app.get("/api/moves")
    def moves_view(extra: str = ""):
        """Per held symbol (plus `extra`, comma-separated tickers you don't hold): typical daily move over the last
        year, this week's best / worst day, and highs and lows over 15 days / 6 months / 1 year. A listing whose own
        Yahoo history is too short (common for Munich or other secondary listings) borrows the earlier part from
        another listing of the same fund or an ETF on the same index, like the Risk tab; `proxy` says which."""
        lots, _sells, _divs, fr = _context("EUR")
        held = sorted({x["symbol"] for x in lots if fr.remaining.get(x["id"], 0) > ledger.EPS
                       and x["symbol"] and x["manual_price"] is None})
        ext = [t for t in dict.fromkeys(t.strip().upper() for t in extra.split(",")) if t and SYMBOL_RE.match(t)][:40]
        ext = [t for t in ext if t not in held]
        _sync_sources(ext)
        syms = held + ext
        if not syms:
            return {"symbols": {}, "missing": {}, "extra": {}}
        since = date.today() - timedelta(days=380)
        hist = engine.history(syms, since - timedelta(days=20))
        meta = engine.meta(syms)
        quotes = engine.quotes(syms)
        px = {s_: ser.dropna() for s_, ser in hist.items() if ser is not None and not ser.dropna().empty}
        proxies = {}
        for s_ in syms:
            own = px.get(s_)
            if own is not None and len(own) and own.index[0] <= pd.Timestamp(since) + pd.Timedelta(days=30):
                continue
            q = quotes.get(s_)
            ccy = normalize_currency((meta.get(s_) or {}).get("currency") or (q.currency if q else None))[0]
            if not ccy:
                continue
            info = {s_: {"quote_type": (q.quote_type if q else None), "display_name": (q.name if q else None)}}
            try:     # in the fund's own currency: highs and lows are prices, not your FX
                used = _splice_proxies(ccy, px, [s_], meta, info, since)
            except Exception as e:  # noqa: BLE001
                log.warning("moves proxy for %s failed: %s", s_, e)
                used = {}
            if s_ in used:
                proxies[s_] = used[s_]
        bars = engine.bars([s_ for s_ in syms if s_ in px], since - timedelta(days=20))
        out, missing = {}, {}
        for s_ in syms:
            ser = px.get(s_)
            m = risk.daily_moves(levels.clean(ser), bars.get(s_)) if ser is not None and len(ser) else None
            if m:
                if s_ in proxies:
                    m["proxy"] = proxies[s_]
                if s_ in engine.sources:
                    m["source"] = engine.sources[s_]
                out[s_] = m
            else:
                missing[s_] = {"closes": int(len(ser)) if ser is not None else 0,
                               "first": ser.index[0].date().isoformat() if ser is not None and len(ser) else None}
        extra_info = {}
        for s_ in ext:
            q = quotes.get(s_)
            ok = bool(q and q.ok)
            extra_info[s_] = {"ok": ok or s_ in out, "name": (q.name if q else None) or s_,
                              "price": q.price if ok else None, "currency": q.currency if ok else None,
                              "day": (q.changes or {}).get("1D") if ok else None,
                              "quote_type": q.quote_type if q else None}
        return {"symbols": out, "missing": missing, "extra": extra_info, "as_of": time.time()}

    # ------------------------------------------------------------------ technical analysis
    @app.get("/api/ta")
    def ta_view(symbol: str, years: int = 10):
        """Daily OHLCV for the Analysis tab (indicators are computed in the browser), plus the support /
        resistance zones and volatility the Sell targets tab uses. Bad ticks are cleaned like everywhere else:
        closes by the Hampel filter, highs/lows that overshoot both closes by far fall back to the close, and an
        open outside the day's range is clipped into it (missing opens use the previous close)."""
        sym = symbol.strip().upper()
        if not SYMBOL_RE.match(sym):
            raise HTTPException(400, "Invalid ticker")
        years = max(1, min(int(years), 30))
        _sync_sources([sym])
        start = date.today() - timedelta(days=int(365.25 * years) + 10)
        b = engine.bars([sym], start).get(sym)
        meta = engine.meta([sym]).get(sym) or {}
        q = engine.quotes([sym]).get(sym)
        if b is None or b.empty or b["close"].dropna().empty:
            raise HTTPException(404, f"No price history for {sym}")
        b = b[b.index >= pd.Timestamp(start)]
        close = levels.clean(b["close"].dropna())
        hl = risk.intraday_hilo(close, b)
        hi = hl["high"] if hl is not None else close
        lo = hl["low"] if hl is not None else close
        prev = close.shift(1).fillna(close)
        op = pd.to_numeric(b["open"], errors="coerce").reindex(close.index) if "open" in b else prev
        op = op.where((op > 0) & (op <= hi * 1.5) & (op >= lo / 1.5), prev)
        op = np.minimum(np.maximum(op, lo), hi)
        vol = (pd.to_numeric(b["volume"], errors="coerce").reindex(close.index).fillna(0)
               if "volume" in b else pd.Series(0.0, index=close.index))
        r6 = lambda x: float(f"{float(x):.6g}")  # noqa: E731
        rows = [[d.date().isoformat(), r6(o), r6(h), r6(l_), r6(c), int(v)]
                for d, o, h, l_, c, v in zip(close.index, op, hi, lo, close, vol)]
        an = levels.analyze(close[close.index >= close.index[-1] - pd.Timedelta(days=levels.LOOKBACK_DAYS)],
                            q.price if q and q.ok else None)
        zones = None
        if an:
            zones = {"resistance": an["resistance"], "support": an["support"], "breakout": an["breakout"],
                     "breakdown": an["breakdown"], "vol": an["vol"]}
        ccy = normalize_currency(meta.get("currency") or (q.currency if q else None))[0]
        return {"symbol": sym, "name": meta.get("long_name") or meta.get("name") or sym, "currency": ccy,
                "quote_type": meta.get("quote_type"), "exchange": meta.get("exchange"),
                "sector": meta.get("sector"), "source": engine.sources.get(sym),
                "price": q.price if q and q.ok else rows[-1][4], "day": (q.changes or {}).get("1D") if q and q.ok else None,
                "has_volume": bool((vol > 0).sum() > len(vol) * 0.5), "bars": rows, "zones": zones, "as_of": time.time()}

    # ------------------------------------------------------------------ earnings calendar
    @app.get("/api/earnings")
    def earnings_view():
        lots, _sells, _divs, fr = _context("EUR")
        syms = sorted({x["symbol"] for x in lots if fr.remaining.get(x["id"], 0) > ledger.EPS
                       and x["symbol"] and x["manual_price"] is None})
        if not syms:
            return {"items": []}
        meta = engine.meta(syms)
        quotes = engine.quotes(syms)
        eq = [s_ for s_ in syms if (meta.get(s_) or {}).get("quote_type") == "EQUITY"
              or (quotes.get(s_) and quotes[s_].quote_type == "EQUITY")]
        if not eq:
            return {"items": []}
        cal = engine.earnings(eq)
        start = date.today() - timedelta(days=3 * 365)
        hist = engine.history(eq, start)
        today = date.today()
        items = []
        for s_ in eq:
            c = cal.get(s_) or {}
            nxt = [date.fromisoformat(d) for d in (c.get("next") or []) if d]
            nxt = [d for d in nxt if d >= today - timedelta(days=1)]
            past = [h for h in (c.get("history") or []) if h.get("date") and date.fromisoformat(h["date"]) < today]
            past.sort(key=lambda h: h["date"], reverse=True)
            # typical move: largest close-to-close change on the report day or the next session
            moves = []
            ser = hist.get(s_)
            if ser is not None and len(ser) > 30:
                r = ser.pct_change()
                for h in past[:8]:
                    d = pd.Timestamp(h["date"])
                    win = r[(r.index >= d) & (r.index <= d + pd.Timedelta(days=4))].dropna().iloc[:2]
                    if len(win):
                        moves.append({"date": h["date"], "move": float(win.iloc[win.abs().argmax()]) * 100})
            q = quotes.get(s_)
            items.append({
                "symbol": s_, "name": (q.name if q else None) or (meta.get(s_) or {}).get("name") or s_,
                "next": nxt[0].isoformat() if nxt else None,
                "next_to": nxt[-1].isoformat() if len(nxt) > 1 else None,
                "days": (nxt[0] - today).days if nxt else None,
                "eps_est": c.get("eps_est"), "rev_est": c.get("rev_est"),
                "history": past[:4], "moves": moves,
                "typical_move": float(np.mean([abs(m_["move"]) for m_ in moves])) if moves else None,
                "ex_div": c.get("ex_div"), "div_date": c.get("div_date"),
            })
        items.sort(key=lambda x: (x["days"] is None, x["days"] if x["days"] is not None else 0))
        return {"items": items, "as_of": time.time()}

    # ------------------------------------------------------------------ look-through exposure
    @app.get("/api/exposure")
    def exposure_view(base: str | None = None):
        base = base_or_default(base)
        lots, _sells, _divs, fr = _context(base)
        rows, _, _ = _open_rows(base, lots, fr)
        syms = sorted({r["symbol"] for r in rows if r.get("symbol") and r["manual_price"] is None})
        meta = engine.meta(syms) if syms else {}
        fund_syms = [s for s in syms if ((meta.get(s) or {}).get("quote_type") in ("ETF", "MUTUALFUND"))
                     or any(r["symbol"] == s and r.get("quote_type") in ("ETF", "MUTUALFUND") for r in rows)]
        funds = engine.funds(fund_syms) if fund_syms else {}
        st = db.get_settings()
        overrides = st.get("fund_profiles") or {}
        # funds Yahoo has no composition for (common for European listings) borrow it from a proxy ETF
        proxy_syms = set()
        for s_ in fund_syms:
            if exposure.needs_proxy(funds.get(s_)):
                row = next(r for r in rows if r["symbol"] == s_)
                _, prof = exposure.fund_profile(s_, row, meta.get(s_) or {}, funds.get(s_) or {}, overrides)
                px = exposure.PROFILES.get(prof, {}).get("proxy")
                if px:
                    proxy_syms.add(px)
        proxies = engine.funds(sorted(proxy_syms)) if proxy_syms else {}
        return {"base": base, **exposure.compute(rows, meta, funds, overrides, base, proxies=proxies,
                                                 ter_overrides=st.get("fund_ter") or {})}

    # ------------------------------------------------------------------ costs
    def _fee_rule(account: str | None):
        rules = db.get_settings().get("account_fees") or {}
        return rules.get(account or "") or None

    def _apply_rule(rule: dict, gross: float) -> float:
        fee = float(rule.get("fixed") or 0) + float(rule.get("pct") or 0) / 100 * gross
        if rule.get("min") is not None:
            fee = max(fee, float(rule["min"]))
        return round(fee, 4)

    @app.get("/api/costs")
    def costs(base: str | None = None):
        base = base_or_default(base)
        today = date.today()
        lots, sells, divs, fr = _context(base)
        dates = [ledger.lot_date(x) for x in lots] + [ledger.tx_date(t) for t in sells]
        ccys = {x["currency"] for x in lots} | {t["currency"] for t in sells}
        fx = _fxbook(base, ccys, min(dates) if dates else today)
        trades = []
        for x in lots:
            if x.get("manual_price") is not None and not x.get("symbol"):
                continue
            d = ledger.lot_date(x)
            rate = fx.at(x["currency"], d)
            gross = float(x["quantity"]) * float(x["avg_cost"])
            fee = x.get("fees")
            trades.append({"kind": "BUY", "id": x["id"], "date": d.isoformat(), "symbol": x["symbol"],
                           "account": x["account"], "amount": gross * rate,
                           "fee": None if fee is None else float(fee) * rate,
                           "pct": None if fee is None or not gross else float(fee) / gross * 100})
        for t in sells:
            d = ledger.tx_date(t)
            rate = fx.at(t["currency"], d)
            gross = float(t["quantity"]) * float(t["price"])
            fee = t.get("fees")
            trades.append({"kind": "SELL", "id": t["id"], "date": t["date"], "symbol": t["symbol"],
                           "account": t["account"], "amount": gross * rate,
                           "fee": None if fee is None else float(fee) * rate,
                           "pct": None if fee is None or not gross else float(fee) / gross * 100})

        def agg(key):
            out: dict = {}
            for tr in trades:
                k = key(tr)
                a = out.setdefault(k, {"key": k, "trades": 0, "with_fee": 0, "missing": 0, "fees": 0.0,
                                       "volume": 0.0, "volume_with_fee": 0.0})
                a["trades"] += 1
                a["volume"] += tr["amount"]
                if tr["fee"] is None:
                    a["missing"] += 1
                else:
                    a["with_fee"] += 1
                    a["fees"] += tr["fee"]
                    a["volume_with_fee"] += tr["amount"]
            for a in out.values():
                a["avg_pct"] = a["fees"] / a["volume_with_fee"] * 100 if a["volume_with_fee"] else None
            return out

        by_account = agg(lambda t: t["account"] or "")
        rules = db.get_settings().get("account_fees") or {}
        for k, a in by_account.items():
            a["rule"] = rules.get(k)
        by_year = agg(lambda t: t["date"][:4])
        with_fee = [t for t in trades if t["pct"] is not None]
        total_fees = sum(t["fee"] for t in with_fee)
        money_in = sum(t["amount"] for t in trades if t["kind"] == "BUY")

        rows, tot, _ = _open_rows(base, lots, fr)
        fund_syms = sorted({r["symbol"] for r in rows if r.get("quote_type") in ("ETF", "MUTUALFUND")})
        funds = engine.funds(fund_syms) if fund_syms else {}
        meta = engine.meta(fund_syms) if fund_syms else {}
        ongoing, fund_value = [], 0.0
        for s_ in fund_syms:
            v = sum(r["value"] or 0 for r in rows if r["symbol"] == s_)
            ter_o = (db.get_settings().get("fund_ter") or {}).get(s_)
            ter = (ter_o / 100) if ter_o is not None else ((funds.get(s_) or {}).get("ter") or (meta.get(s_) or {}).get("ter"))
            ongoing.append({"symbol": s_, "name": next((r["display_name"] for r in rows if r["symbol"] == s_), s_),
                            "value": v, "ter": ter, "per_year": v * ter if ter else None})
            fund_value += v
        ongoing.sort(key=lambda o: -(o["per_year"] or 0))
        ongoing_total = sum(o["per_year"] or 0 for o in ongoing)
        return {
            "base": base,
            "summary": {
                "total_fees": total_fees,
                "this_year": sum(t["fee"] for t in with_fee if t["date"].startswith(str(today.year))),
                "trades": len(trades), "missing": sum(1 for t in trades if t["fee"] is None),
                "avg_pct": total_fees / sum(t["amount"] for t in with_fee) * 100 if with_fee else None,
                "expensive": sum(1 for t in with_fee if t["pct"] > 1),
                "money_in": money_in, "pct_of_invested": total_fees / money_in * 100 if money_in else None,
                "ongoing_per_year": ongoing_total,
                "weighted_ter": ongoing_total / fund_value if fund_value else None,
                "portfolio_value": tot["value"],
            },
            "by_account": sorted(by_account.values(), key=lambda a: -a["volume"]),
            "by_year": sorted(by_year.values(), key=lambda a: a["key"], reverse=True),
            "top": sorted(with_fee, key=lambda t: -t["pct"])[:12],
            "ongoing": ongoing,
            "rules": rules,
            "fx_approx": sorted(fx.approx),
        }

    @app.post("/api/costs/fill")
    def fill_fees(body: FillIn):
        """Fill missing fees from the account's fee rule (buys and sales)."""
        rule = _fee_rule(body.account)
        if not rule:
            raise HTTPException(400, "set a fee rule for this account first")
        n = 0
        for x in db.list_positions():
            if (x["account"] or "") == (body.account or "") and (body.overwrite or x.get("fees") is None):
                db.update_position(x["id"], {"fees": _apply_rule(rule, float(x["quantity"]) * float(x["avg_cost"]))})
                n += 1
        for t in db.list_transactions():
            if t["type"] == "SELL" and (t["account"] or "") == (body.account or "") and (body.overwrite or t.get("fees") is None):
                db.update_transaction(t["id"], {"fees": _apply_rule(rule, float(t["quantity"]) * float(t["price"]))})
                n += 1
        return {"updated": n}

    # ------------------------------------------------------------------ backup
    @app.get("/api/export")
    def export():
        return JSONResponse(db.export_all(),
                            headers={"Content-Disposition": "attachment; filename=stonks-dash-backup.json"})

    @app.post("/api/import")
    def import_(data: dict, replace: bool = True):
        if not isinstance(data.get("boards", []), list) or not isinstance(data.get("positions", []), list):
            raise HTTPException(400, "invalid backup file")
        db.import_all(data, replace=replace)
        return {"ok": True}

    # ------------------------------------------------------------------ frontend
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        @app.get("/")
        def index():
            # cache-bust JS/CSS so a rebuilt container never runs with stale browser-cached assets
            html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
            for name in ("app.js", "hours.js", "planner.js", "portfolio.js", "insights.js", "targets.js", "telegram.js", "risk.js", "ideas.js", "ranges.js", "ta.js", "ta-ind.js", "app.css"):
                f = STATIC_DIR / name
                if f.exists():
                    v = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
                    html = html.replace(f"/static/{name}\"", f"/static/{name}?v={v}\"")
            return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    return app


app = build_app() if os.getenv("STONKS_NO_AUTOAPP") != "1" else None
