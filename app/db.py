"""SQLite persistence: boards, board items, portfolio positions, settings, metadata cache."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any

from . import seeds

SCHEMA = """
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS board_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    label TEXT,
    group_name TEXT,
    weight REAL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_items_board ON board_items(board_id);
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    name TEXT,
    quantity REAL NOT NULL,
    avg_cost REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    account TEXT,
    group_name TEXT,
    manual_price REAL,
    notes TEXT,
    bought_at TEXT,
    fees REAL,
    target_price REAL,      -- sell objective (take profit), in the quote currency
    stop_price REAL,        -- stop loss, in the quote currency
    trail_pct REAL,         -- trailing stop: % below the highest close since the buy
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('SELL', 'DIVIDEND')),
    symbol TEXT NOT NULL,
    account TEXT,
    date TEXT NOT NULL,
    quantity REAL,          -- SELL: units sold
    price REAL,             -- SELL: price per unit
    amount REAL,            -- DIVIDEND: gross amount received
    withholding REAL,       -- DIVIDEND: tax withheld at source
    currency TEXT NOT NULL,
    fees REAL,
    notes TEXT,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta_cache (
    symbol TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
"""

BOARD_ITEM_FIELDS = ("symbol", "label", "group_name", "weight", "position")
POSITION_FIELDS = ("symbol", "name", "quantity", "avg_cost", "currency", "account",
                   "group_name", "manual_price", "notes", "bought_at", "fees",
                   "target_price", "stop_price", "trail_pct")
TX_FIELDS = ("type", "symbol", "account", "date", "quantity", "price", "amount", "withholding",
             "currency", "fees", "notes")

# columns added after the first release: (table, column, type)
MIGRATIONS = [("positions", "bought_at", "TEXT"), ("positions", "fees", "REAL"),
              ("positions", "target_price", "REAL"), ("positions", "stop_price", "REAL"),
              ("positions", "trail_pct", "REAL")]


class DB:
    def __init__(self, path: str):
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.executescript(SCHEMA)
        for table, col, typ in MIGRATIONS:
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        self._conn.commit()

    @contextmanager
    def tx(self):
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def q(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, args).fetchall()]

    # ---------- seeding ----------
    def seed_if_empty(self, demo_portfolio: bool = False) -> None:
        if self.q("SELECT COUNT(*) AS n FROM boards")[0]["n"] == 0:
            for i, b in enumerate(seeds.DEFAULT_BOARDS):
                bid = self.create_board(b["name"], b["config"], position=i)
                for j, it in enumerate(b["items"]):
                    self.add_item(bid, {**it, "position": j})
        if not self.q("SELECT key FROM settings"):
            self.update_settings(seeds.DEFAULT_SETTINGS)
        if demo_portfolio and self.q("SELECT COUNT(*) AS n FROM positions")[0]["n"] == 0:
            for sym, qty, cost, ccy, acct, grp in seeds.DEMO_POSITIONS:
                self.create_position({"symbol": sym, "quantity": qty, "avg_cost": cost,
                                      "currency": ccy, "account": acct, "group_name": grp})

    # ---------- boards ----------
    def list_boards(self) -> list[dict]:
        boards = self.q("SELECT * FROM boards ORDER BY position, id")
        items = self.q("SELECT * FROM board_items ORDER BY position, id")
        by_board: dict[int, list] = {}
        for it in items:
            by_board.setdefault(it["board_id"], []).append(it)
        for b in boards:
            b["config"] = json.loads(b["config"] or "{}")
            b["items"] = by_board.get(b["id"], [])
        return boards

    def get_board(self, board_id: int) -> dict | None:
        rows = self.q("SELECT * FROM boards WHERE id = ?", (board_id,))
        if not rows:
            return None
        b = rows[0]
        b["config"] = json.loads(b["config"] or "{}")
        b["items"] = self.q("SELECT * FROM board_items WHERE board_id = ? ORDER BY position, id",
                            (board_id,))
        return b

    def create_board(self, name: str, config: dict | None = None, position: int | None = None) -> int:
        with self.tx() as c:
            if position is None:
                position = c.execute("SELECT COALESCE(MAX(position)+1, 0) FROM boards").fetchone()[0]
            cur = c.execute("INSERT INTO boards(name, position, config) VALUES (?,?,?)",
                            (name, position, json.dumps(config or {})))
            return cur.lastrowid

    def update_board(self, board_id: int, data: dict) -> None:
        with self.tx() as c:
            if "name" in data and data["name"] is not None:
                c.execute("UPDATE boards SET name = ? WHERE id = ?", (data["name"], board_id))
            if "position" in data and data["position"] is not None:
                c.execute("UPDATE boards SET position = ? WHERE id = ?", (data["position"], board_id))
            if "config" in data and data["config"] is not None:
                row = c.execute("SELECT config FROM boards WHERE id = ?", (board_id,)).fetchone()
                cfg = json.loads(row[0] or "{}") if row else {}
                cfg.update(data["config"])
                c.execute("UPDATE boards SET config = ? WHERE id = ?", (json.dumps(cfg), board_id))

    def delete_board(self, board_id: int) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM boards WHERE id = ?", (board_id,))

    def add_item(self, board_id: int, data: dict) -> int:
        with self.tx() as c:
            pos = data.get("position")
            if pos is None:
                pos = c.execute("SELECT COALESCE(MAX(position)+1, 0) FROM board_items WHERE board_id=?",
                                (board_id,)).fetchone()[0]
            cur = c.execute(
                "INSERT INTO board_items(board_id, symbol, label, group_name, weight, position) "
                "VALUES (?,?,?,?,?,?)",
                (board_id, data["symbol"].strip().upper(), data.get("label"), data.get("group_name"),
                 data.get("weight"), pos))
            return cur.lastrowid

    def update_item(self, item_id: int, data: dict) -> None:
        sets, args = [], []
        for k in BOARD_ITEM_FIELDS:
            if k in data:
                v = data[k]
                if k == "symbol" and v:
                    v = v.strip().upper()
                sets.append(f"{k} = ?")
                args.append(v)
        if not sets:
            return
        with self.tx() as c:
            c.execute(f"UPDATE board_items SET {', '.join(sets)} WHERE id = ?", (*args, item_id))

    def delete_item(self, item_id: int) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM board_items WHERE id = ?", (item_id,))

    # ---------- positions ----------
    def list_positions(self) -> list[dict]:
        return self.q("SELECT * FROM positions ORDER BY id")

    def create_position(self, data: dict) -> int:
        vals = {k: data.get(k) for k in POSITION_FIELDS}
        if vals["bought_at"] is not None:
            vals["bought_at"] = str(vals["bought_at"])
        if vals["symbol"]:
            vals["symbol"] = vals["symbol"].strip().upper()
        vals["currency"] = (vals["currency"] or "EUR").upper()
        with self.tx() as c:
            cur = c.execute(
                f"INSERT INTO positions({', '.join(POSITION_FIELDS)}, created_at) "
                f"VALUES ({', '.join('?' * len(POSITION_FIELDS))}, ?)",
                (*vals.values(), time.time()))
            return cur.lastrowid

    def update_position(self, pos_id: int, data: dict) -> None:
        sets, args = [], []
        for k in POSITION_FIELDS:
            if k in data:
                v = data[k]
                if k in ("symbol", "currency") and v:
                    v = v.strip().upper()
                if k == "bought_at" and v is not None:
                    v = str(v)
                sets.append(f"{k} = ?")
                args.append(v)
        if not sets:
            return
        with self.tx() as c:
            c.execute(f"UPDATE positions SET {', '.join(sets)} WHERE id = ?", (*args, pos_id))

    def delete_position(self, pos_id: int) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM positions WHERE id = ?", (pos_id,))

    # ---------- transactions (sells, dividends) ----------
    def list_transactions(self) -> list[dict]:
        return self.q("SELECT * FROM transactions ORDER BY date, id")

    def get_transaction(self, tx_id: int) -> dict | None:
        rows = self.q("SELECT * FROM transactions WHERE id = ?", (tx_id,))
        return rows[0] if rows else None

    @staticmethod
    def _clean_tx(data: dict) -> dict:
        out = {}
        for k in TX_FIELDS:
            if k in data:
                v = data[k]
                if k in ("symbol", "currency", "type") and v:
                    v = str(v).strip().upper()
                if k == "date" and v is not None:
                    v = str(v)
                out[k] = v
        return out

    def create_transaction(self, data: dict) -> int:
        vals = self._clean_tx({k: data.get(k) for k in TX_FIELDS})
        with self.tx() as c:
            cur = c.execute(f"INSERT INTO transactions({', '.join(TX_FIELDS)}, created_at) "
                            f"VALUES ({', '.join('?' * len(TX_FIELDS))}, ?)", (*vals.values(), time.time()))
            return cur.lastrowid

    def update_transaction(self, tx_id: int, data: dict) -> None:
        vals = self._clean_tx(data)
        vals.pop("type", None)
        if not vals:
            return
        with self.tx() as c:
            c.execute(f"UPDATE transactions SET {', '.join(f'{k} = ?' for k in vals)} WHERE id = ?",
                      (*vals.values(), tx_id))

    def delete_transaction(self, tx_id: int) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))

    def get_position(self, pos_id: int) -> dict | None:
        rows = self.q("SELECT * FROM positions WHERE id = ?", (pos_id,))
        return rows[0] if rows else None

    # ---------- settings ----------
    def get_settings(self) -> dict[str, Any]:
        out = dict(seeds.DEFAULT_SETTINGS)
        for r in self.q("SELECT key, value FROM settings"):
            out[r["key"]] = json.loads(r["value"])
        return out

    def update_settings(self, data: dict) -> None:
        with self.tx() as c:
            for k, v in data.items():
                c.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, json.dumps(v)))

    # ---------- metadata cache ----------
    def get_meta(self, symbols: list[str], max_age: float) -> dict[str, dict]:
        if not symbols:
            return {}
        cutoff = time.time() - max_age
        ph = ",".join("?" * len(symbols))
        rows = self.q(f"SELECT symbol, data FROM meta_cache WHERE symbol IN ({ph}) AND fetched_at >= ?",
                      (*symbols, cutoff))
        return {r["symbol"]: json.loads(r["data"]) for r in rows}

    def put_meta(self, symbol: str, data: dict) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO meta_cache(symbol, data, fetched_at) VALUES (?,?,?) "
                      "ON CONFLICT(symbol) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at",
                      (symbol, json.dumps(data), time.time()))

    # ---------- export / import ----------
    def export_all(self) -> dict:
        boards = self.list_boards()
        for b in boards:
            b.pop("id", None)
            b["items"] = [{k: it[k] for k in ("symbol", "label", "group_name", "weight")} for it in b["items"]]
        positions = [{k: p[k] for k in POSITION_FIELDS} for p in self.list_positions()]
        txs = [{k: t[k] for k in TX_FIELDS} for t in self.list_transactions()]
        return {"version": 2, "boards": boards, "positions": positions, "transactions": txs,
                "settings": self.get_settings()}

    def import_all(self, data: dict, replace: bool = True) -> None:
        with self.tx() as c:
            if replace:
                if "boards" in data:
                    c.execute("DELETE FROM board_items")
                    c.execute("DELETE FROM boards")
                if "positions" in data:
                    c.execute("DELETE FROM positions")
                if "positions" in data or "transactions" in data:
                    c.execute("DELETE FROM transactions")
        for i, b in enumerate(data.get("boards", [])):
            bid = self.create_board(b["name"], b.get("config") or {}, position=b.get("position", i))
            for j, it in enumerate(b.get("items", [])):
                self.add_item(bid, {**it, "position": j})
        for p in data.get("positions", []):
            self.create_position(p)
        if data.get("settings"):
            self.update_settings(data["settings"])
        for t in data.get("transactions", []):
            self.create_transaction(t)
