"""stonks-dash API + static frontend."""
from __future__ import annotations

import hashlib
import logging
import os
import time
import datetime as dt
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import DB
from . import exposure, ledger, tax
from .market import PERIODS, MockProvider, QuoteEngine, YahooProvider, normalize_currency
from .sessions import CATALOG, DEFAULT_EXCHANGES, SessionService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stonks")

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

    def _benchmark(base: str, start: date):
        """(symbol, name, series in base currency, native series, currency) — or Nones when unavailable."""
        sym = (db.get_settings().get("benchmark") or DEFAULT_BENCHMARK).upper()
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

    def _context(base: str):
        lots = db.list_positions()
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
                 "spark": [], "display_name": p["name"] or p["symbol"]}
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
    @app.get("/api/targets/peaks")
    def target_peaks():
        """Highest close since each open, dated buy (quote currency) — for trailing stops and drawdown."""
        lots, _sells, _divs, fr = _context("EUR")
        open_lots = [x for x in lots if fr.remaining.get(x["id"], 0) > ledger.EPS
                     and x["symbol"] and x["manual_price"] is None and x.get("bought_at")]
        if not open_lots:
            return {"peaks": {}}
        start = min(ledger.lot_date(x) for x in open_lots)
        hist = engine.history(sorted({x["symbol"] for x in open_lots}), start)
        quotes = engine.quotes(sorted({x["symbol"] for x in open_lots}))
        out = {}
        for x in open_lots:
            ser = hist.get(x["symbol"])
            if ser is None or ser.empty:
                continue
            d0 = ledger.lot_date(x)
            ser = ser[ser.index >= pd.Timestamp(d0)].dropna()
            if ser.empty:
                continue
            i = ser.idxmax()
            peak, when = float(ser.loc[i]), i.date().isoformat()
            q = quotes.get(x["symbol"])
            if q and q.ok and q.price and q.price > peak:
                peak, when = float(q.price), (q.last_date or date.today().isoformat())
            low_i = ser.idxmin()
            out[str(x["id"])] = {"peak": peak, "peak_date": str(when)[:10],
                                 "low": float(ser.loc[low_i]), "low_date": low_i.date().isoformat()}
        return {"peaks": out}

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
            for name in ("app.js", "hours.js", "planner.js", "portfolio.js", "insights.js", "targets.js", "app.css"):
                f = STATIC_DIR / name
                if f.exists():
                    v = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
                    html = html.replace(f"/static/{name}\"", f"/static/{name}?v={v}\"")
            return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    return app


app = build_app() if os.getenv("STONKS_NO_AUTOAPP") != "1" else None
