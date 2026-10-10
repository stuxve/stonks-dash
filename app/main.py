"""stonks-dash API + static frontend."""
from __future__ import annotations

import hashlib
import logging
import os
import time
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import DB
from .market import PERIODS, MockProvider, QuoteEngine, YahooProvider
from .sessions import CATALOG, DEFAULT_EXCHANGES, SessionService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stonks")

DATA_DIR = os.getenv("STONKS_DATA_DIR", "/data")
PROVIDER = os.getenv("STONKS_PROVIDER", "yahoo").lower()
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
BASES = ("EUR", "USD")


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


def _seed_mock_portfolio(db: DB, engine: QuoteEngine) -> None:
    """Demo positions whose cost basis is plausible relative to the synthetic prices."""
    from .seeds import DEMO_POSITIONS
    quotes = engine.quotes([p[0] for p in DEMO_POSITIONS])
    factors = [0.82, 0.91, 1.08, 0.64, 0.88, 1.15, 0.73, 1.21, 0.95]
    held_days = [812, 540, 400, 365, 210, 95, 61, 23, 4]
    for (sym, qty, _cost, _ccy, acct, grp), f, days in zip(DEMO_POSITIONS, factors, held_days):
        q = quotes[sym]
        if q.ok:
            db.create_position({"symbol": sym, "quantity": qty, "avg_cost": round(q.price * f, 4),
                                "currency": q.currency, "account": acct, "group_name": grp,
                                "bought_at": (date.today() - timedelta(days=days)).isoformat()})


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

    @app.get("/api/positions")
    def list_positions():
        return db.list_positions()

    @app.post("/api/positions", status_code=201)
    def create_position(p: PositionIn):
        d = p.model_dump()
        _validate_position(d, partial=False)
        return {"id": db.create_position(d)}

    @app.patch("/api/positions/{pos_id}")
    def update_position(pos_id: int, p: PositionIn):
        d = p.model_dump(exclude_unset=True)
        _validate_position(d, partial=True)
        db.update_position(pos_id, d)
        return {"ok": True}

    @app.delete("/api/positions/{pos_id}", status_code=204)
    def delete_position(pos_id: int):
        db.delete_position(pos_id)

    @app.get("/api/portfolio")
    def portfolio(base: str | None = None):
        base = base_or_default(base)
        positions = db.list_positions()
        syms = [p["symbol"] for p in positions if p["symbol"] and p["manual_price"] is None]
        quotes = engine.quotes(syms) if syms else {}
        ccys = {p["currency"] for p in positions} | {q.currency for q in quotes.values()}
        fx = engine.fx_rates(ccys, base)
        rows = []
        tot = {"value": 0.0, "cost": 0.0, "day_pnl": 0.0}
        for p in positions:
            q = quotes.get(p["symbol"]) if p["manual_price"] is None else None
            r = {**p, "ok": False, "price": None, "price_currency": p["currency"], "changes": {},
                 "value": None, "cost": None, "pnl": None, "pnl_pct": None, "day_pnl": None,
                 "quote_type": None, "sector": None, "industry": None, "spark": [],
                 "display_name": p["name"] or p["symbol"]}
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
                value = p["quantity"] * price * fx_price
                cost = p["quantity"] * p["avg_cost"] * fx_cost
                r.update(ok=True, price=price, price_currency=pccy, value=value, cost=cost,
                         pnl=value - cost, pnl_pct=((value / cost - 1) * 100) if cost else None)
                if prev:
                    r["day_pnl"] = p["quantity"] * (price - prev) * fx_price
                    tot["day_pnl"] += r["day_pnl"]
                tot["value"] += value
                tot["cost"] += cost
            rows.append(r)
        tot["pnl"] = tot["value"] - tot["cost"]
        tot["pnl_pct"] = (tot["pnl"] / tot["cost"] * 100) if tot["cost"] else None
        prev_val = tot["value"] - tot["day_pnl"]
        tot["day_pct"] = (tot["day_pnl"] / prev_val * 100) if prev_val else None
        tot["count"] = len(rows)
        tot["missing"] = sum(1 for r in rows if not r["ok"])
        return {"base": base, "positions": rows, "totals": tot, "fx": fx, "periods": PERIODS,
                "provider": prov.name, "as_of": time.time()}

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
            for name in ("app.js", "hours.js", "app.css"):
                f = STATIC_DIR / name
                if f.exists():
                    v = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
                    html = html.replace(f"/static/{name}\"", f"/static/{name}?v={v}\"")
            return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    return app


app = build_app() if os.getenv("STONKS_NO_AUTOAPP") != "1" else None
