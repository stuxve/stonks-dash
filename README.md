# stonks-dash

A self-hosted market heatmap in the style of TradingView and finviz. The two heatmap sections share the same treemap UI:

- **Markets**: boards for world indices, index funds and ETFs, US mega caps, Europe, IBEX 35, macro (commodities, FX, rates) and crypto. You can create, rename, reorder and delete boards and add any Yahoo Finance symbol to them.
- **My portfolio**: your own positions with market value, invested amount, unrealized P&L and today's P&L. Each position is a tile sized by value and colored by total P&L % or by price change over a period.

A third section, **Market hours**, shows which exchanges are open right now, with countdowns to the next open or close, a 24-hour session timeline, lunch breaks, holidays and early closes.

All values can be shown in **EUR or USD**. Positions in other currencies are converted at live FX rates, and GBp/ZAc/ILA quotes are normalized to their major unit.

The backend is FastAPI with yfinance and SQLite. The frontend is vanilla JS with d3 (vendored, so no CDN is needed at runtime). Everything ships as a single Docker container.

## Run it

```bash
docker compose up -d --build
# open http://localhost:8000
```

To try it offline with synthetic prices and a demo portfolio:

```bash
STONKS_PROVIDER=mock docker compose up -d --build
```

On Windows with Docker Desktop, run the same commands in PowerShell. For environment variables there, use a `.env` file (copy `.env.example`) or `$env:STONKS_PROVIDER="mock"`.

The base image `python:3.12-slim` is multi-arch, so the same compose file also builds on a Raspberry Pi (arm64).

### Configuration (`.env` or environment)

| Variable | Default | Meaning |
|---|---|---|
| `STONKS_BIND` | `127.0.0.1` | Host interface. **The app has no authentication.** Keep it on localhost, or expose it only behind a VPN (WireGuard) or a reverse proxy with auth. |
| `STONKS_PORT` | `8000` | Host port |
| `STONKS_PROVIDER` | `yahoo` | `yahoo` for live data, or `mock` for offline demo data |
| `STONKS_QUOTE_TTL` | `60` | Seconds to cache the latest prices |
| `STONKS_HISTORY_TTL` | `21600` | Seconds to cache the 13-month daily history used for 1W…1Y changes |
| `TZ` | `Europe/Madrid` | Container timezone |

Data lives in the named volume `stonks-data` (`/data/stonks.db`). To back it up, use **Settings → Export JSON** in the UI or `docker cp stonks-dash:/data/stonks.db .`.

The container runs as a non-root user with a read-only root filesystem, `cap_drop: ALL` and `no-new-privileges`.

## Using it

**Tiles.** Hover a tile, or tap it on mobile, to see the price, a 30-day sparkline, the change for 1D, 1W, 1M, 3M, 6M, YTD and 1Y, and the market cap or AUM. Click a group header (for example "Technology ›") to zoom into that group. Press `Esc` to zoom back out.

**Toolbar.**

- **Period** sets which change colors the tiles (1D to 1Y).
- **Size** can be market cap, √ market cap (so mega caps don't swallow the map), equal, or a custom weight per symbol.
- **Group** can be your custom groups, sector, industry, asset type, or none.
- **Range** is the color saturation: auto, or fixed at ±1% up to ±50%.
- **Highlight** dims every tile that doesn't match the text you type.

The size and group choices are saved per board. Period, range and currency are global.

**Boards.** Use **+ Board** to create one and **Edit board** to change it. The symbol search accepts tickers, company names and **ISINs**, which is how you find European index funds. Yahoo lists many UCITS mutual funds under Morningstar IDs (`0P0000…`): search the fund's ISIN and pick the result.

**Portfolio.** Each position has these fields:

- **Quantity** and **average cost per unit**.
- **Cost currency**: the currency you paid in. If you bought a US stock from a EUR account, enter the EUR cost per share, and P&L will include the FX effect exactly. If the cost currency differs from the base currency, the cost is converted at today's FX rate.
- **Account** and **Group**, used to group the treemap.
- **Manual price**, for assets Yahoo doesn't cover (pension plans, some funds). Update it whenever you like.

**Market hours.** Each row shows the exchange's status (open, lunch break, pre-market or after-hours, closed or holiday), a live countdown, today's session times and its main index's 1D change. The timeline covers your day (or the next 24 hours), with a line marking the current time.

- **Times** switches the session times between your time zone and the exchange's local time.
- **Choose markets** picks from about 30 exchanges plus FX, CME Globex and crypto.
- Below the timeline is a list of holidays and early closes for the next 14 days.

Schedules come from [`exchange_calendars`](https://github.com/gerrymanoim/exchange_calendars). Its holiday data ships with each release, and a few exchanges (Shanghai, Mumbai, Singapore) only have holidays recorded through the current year. When that data runs out, the row shows "calendar outdated"; rebuild with `--pull` to update it. FX (Sunday 17:00 to Friday 17:00 New York time), CME Globex (Sunday to Thursday 18:00 to 17:00 New York time) and crypto (24/7) follow fixed weekly rules and ignore holidays. US pre-market (04:00) and after-hours (until 20:00 ET) are shown for NYSE / Nasdaq.

**Settings.** Choose between the classic red/green scheme and a colorblind-safe red/blue scheme, ticker or name labels, the auto-refresh interval (off, 30 s, 1 min, 5 min or 15 min), and JSON export/import.

## Data notes

- Yahoo Finance is an unofficial source. Some exchanges are delayed by about 15 minutes, and Yahoo rate-limits aggressive clients. The app batches downloads, caches prices for 60 s and history for 6 h, and caches metadata for 24 h in SQLite. A failed metadata lookup is retried after 10 minutes and never cached as a guess.
- Changes are price returns from closes (dividends are not included). 1D compares the latest bar with the previous close. YTD uses the last close of the previous year.
- Indices and futures have no market cap. In market-cap mode, tiles without a cap get the board's median cap; use Equal or Custom weight for those boards.
- If Yahoo changes its API and quotes stop loading, rebuild to pick up a newer yfinance: `docker compose build --pull --no-cache && docker compose up -d`.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/boards` | Boards with their items |
| POST/PATCH/DELETE | `/api/boards[/{id}]` | Board CRUD (`config.size_mode`, `config.group_mode`) |
| POST | `/api/boards/{id}/items` | Add a symbol (`symbol`, `label`, `group_name`, `weight`) |
| PATCH/DELETE | `/api/items/{id}` | Edit or remove a symbol |
| GET | `/api/boards/{id}/heatmap?base=EUR` | Tiles with price, changes and market cap in the base currency |
| GET/POST/PATCH/DELETE | `/api/positions[/{id}]` | Portfolio CRUD |
| GET | `/api/portfolio?base=USD` | Positions with value, cost, P&L, day P&L and totals |
| GET | `/api/search?q=` | Symbol search (ticker, name, ISIN) |
| GET | `/api/quote/{symbol}` | One quote |
| GET | `/api/quotes?symbols=a,b` | Several quotes |
| GET | `/api/sessions[?codes=XNYS,XMAD]` | Session schedule (UTC ms), holidays, early closes and the exchange catalog |
| GET/PUT | `/api/settings` | UI settings |
| GET/POST | `/api/export`, `/api/import` | JSON backup |

Interactive docs are at `/docs`.

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
STONKS_PROVIDER=mock STONKS_DATA_DIR=./data uvicorn app.main:app --reload
```
# stonks-dash
# stonks-dash
