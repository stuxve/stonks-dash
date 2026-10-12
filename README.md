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
| `TELEGRAM_BOT_TOKEN` | — | Bot token for Telegram alerts (optional; it can also be pasted in Sell targets). |
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

**Portfolio sub-tabs.**

- **Holdings** is the heatmap and table. Each row has **Sell**, **Edit** and **Delete**. A **Vs index** column shows each position's return minus the benchmark's return over the same dates, in percentage points. It only appears for buys that have a purchase date.
- **Sell targets** monitors every open buy (lot) separately. You always type your own **target**, **stop loss** and **trailing stop** (as a price or a % of the buy price); everything else is a clickable suggestion:
  - **Resistance and support zones** from daily closes of the last 3 years, with bad ticks removed (Hampel filter plus one-day spikes that revert). Turning points are found with 5-, 10- and 20-day look-backs and kept only if at least two agree. They are grouped into zones as wide as the asset's typical daily move, and ranked by touches, with recent touches weighted more (half-life one year). Chips under the target show the strongest zones above the price with their touch count (`3×`). Chips under the stop sit half a daily move below the strongest supports. Closes are the prices as traded (not adjusted for dividends).
  - **Analyst consensus**: Yahoo's mean target, its upside and the number of analysts for stocks. For **ETFs** an **implied target**: each top holding's consensus upside weighted by its share of the fund, with the coverage shown (e.g. top 10 = 38% of an S&P 500 fund); funds Yahoo has no holdings for use the holdings of an ETF on the same index (as in Exposure). The uncovered part is assumed to behave like the covered part, and FX is not included unless the fund is hedged. Crypto has no analyst coverage. It says **likely to break** when the consensus is more than 5% above the nearest resistance, and **★ agrees** when a resistance zone is within 3% of it.
  - **Volatility (chandelier) trailing stop**: switch the trailing stop from **%** to **×ATR**, which means the highest close since the buy minus k × the typical daily move (22-day average of close-to-close changes). The highest of the fixed stop, % trailing and ×ATR trailing is used.
  - **Chance to touch** the target, the stop or any zone within 3 months, 6 months or 1 year, from the asset's own volatility, assuming no trend.
  - **Broke out**: the price closed for 2 days more than one daily move above your target, or above a resistance it was under in the last 4 weeks. **Raise stop** moves the stop half a daily move under that level and the target to the next resistance, instead of selling.
  - Each row also shows the peak since the buy, a stop · buy · now · target bar with the zones shaded, the distance to the target and the stop, the P/L at the target after the account's sell fee, and a status: *Broke out*, *Target hit*, *Stop hit*, *Near target*, *Near stop*, *Watching* or *No exit set*. Alerts show as a count on the tab.
  - **Sell** opens the sale dialog prefilled. **All buys** copies a lot's exits to every buy of the same asset. **Fill buys that have no exit yet** sets default exits in one go. Nothing is sold automatically. Later buys of an asset are flagged **FIFO n/m**, because a sale always uses the oldest buy first.
- **Telegram alerts** (panel at the top of Sell targets). The Pi checks your buys every 15 minutes, using the same rules as the tab, even when no browser is open. It sends a message only when something **changes**: a target hit, a stop hit (fixed, % trailing or ×ATR), a breakout with the suggested new stop and target, near target or near stop (optional), and earnings within N days. There's a cooldown so a price flapping around a level doesn't spam you, and an optional daily summary at a time you choose. Setup:
  1. Create a bot with **@BotFather** (`/newbot`).
  2. Paste the token in the panel, or set `TELEGRAM_BOT_TOKEN` in `.env`, which is safer. The token is stored only on the Pi and is never returned by the API or included in backups.
  3. Press **Link my Telegram** and **Start** in the bot. Only the chat that sends the one-time code is linked; messages from any other chat are ignored.

  Commands in the chat: `/status`, `/summary`, `/mute [hours]`, `/unmute`. Buys without any exit set are skipped unless you tick that option. Remember the app has no login: anyone on your network can open it and change these settings.
- **Risk** replays today's holdings and weights over the last 1, 3 or 5 years of prices, in your base currency. It has its own benchmark picker (MSCI World by default), and each option shows its correlation with your portfolio, with ★ on the best fit. If the benchmark used by Performance and "Vs index" fits much worse, a button lets you switch that one too. Holdings with a short price history (for example a Munich listing Yahoo barely covers) borrow the earlier part from a proxy. The app tries, in order: a ticker you type in the table, another listing of the same fund (same root ticker, currency and price), then an ETF on the same index (in its local currency if your fund is hedged). This way they're never treated as cash.
  - Volatility, max drawdown (peak, trough, recovery and how long it lasted), distance from the last peak, worst month and beta/correlation vs the benchmark, next to the same figures for the benchmark. There's also the max drawdown of the portfolio you actually held, time-weighted so contributions don't count. It starts on the first day you held at least 3 effective positions with none above 50% of cost, so a period when you owned a single stock doesn't count as a portfolio drawdown. That earlier figure is shown alongside.
  - A drawdown chart, your mix against the benchmark.
  - Per holding: weight vs **share of the risk** (variance contribution), volatility, beta, correlation with the index and with the rest of the portfolio, max drawdown, distance from its peak, and foreign-currency exposure.
  - A correlation heatmap.
  - **Concentration**: top 5 holdings, effective number of holdings, and the top companies once funds are looked through.
  - A **stress test**: choose the moves for stocks, crypto, bonds, gold and foreign currencies, or a preset. Each stock or equity fund moves by its beta.
  - **Past crises** (COVID 2020, 2022 bear, crypto winter, Aug 2024, 2025 tariffs) replayed on today's portfolio. Holdings bought or listed later are estimated from beta × index (BTC for crypto).
  - An **earnings calendar** for your stocks: the next report date, expected EPS, the last 4 surprises, the typical price move after a report, and how far your stop is. The Risk tab shows a count when a report is within the warning window (7 days by default), and Sell targets rows show an *earnings* pill in the 14 days before. The pill turns amber when the stop sits inside the typical earnings move.
- **Ideas** is a stock screener that changes with your portfolio. It is a screen, not advice. There are two lists: **Spain** (the IBEX 35) and **World** (about 100 large caps from the US, Europe, Japan, Asia, Canada and Australia). You can add your own tickers to either list. Each stock gets eight 0–100 factor scores, each a percentile within its list:
  - **Fit**: sectors and regions where your stocks (with funds looked through) are below a global index; low correlation with your current holdings; a penalty for companies you already own, directly or through funds.
  - **Value**: P/E, P/B and EV/EBITDA, each compared with the same sector.
  - **Quality**: ROE, operating margin and debt.
  - **Growth**: sales and earnings growth.
  - **Momentum**: 12-month return excluding the last month, and distance from the 52-week high.
  - **Analysts**: consensus upside and recommendation.
  - **Income**: dividend yield **net of the foreign withholding a Spanish resident can't credit**, which is the part above the usual 15% treaty rate. Spanish dividends lose nothing.
  - **Low risk**: low volatility.

  Presets (Balanced, Diversify me, Value, Quality, Growth, Dividends) or Custom sliders weight the factors, and the ranking updates instantly. Each row explains why it ranks there and flags problems: high debt, payout above 100%, falling earnings, a sector you're already heavy in, or a stock you already hold. Company data comes from Yahoo and is fetched in the background the first time each day (about 100 calls for World); prices, momentum and fit update with the page.
- **Performance vs index** compares your portfolio with a "shadow portfolio". Every euro you invested or took out on a date is treated as a buy or sell of the benchmark on that same date. It shows both gains, the difference, and the money-weighted annual return (XIRR) for you and for the index. The chart plots your portfolio value, the index value and the net amount invested. The default benchmark is IWDA.AS (MSCI World in EUR), and you can switch to VWCE, the S&P 500, the Nasdaq-100, emerging markets, the Stoxx 600 or any other ticker. Manual or unpriced assets are carried at cost.
- **Allocation** lets you pick what to allocate by (my groups, asset type, account, sector or each asset) and set a target % for each bucket. It shows the current %, how far each bucket has drifted, and how much to buy or sell to reach the target. **Measure by** compares against market value or money invested.
- **Next order** (in **Allocation**): you enter a goal for total money invested, your monthly contribution and the maximum number of orders per month (1–3), and it tells you what to buy this month. It works on the money you've invested in each bucket, buys only, and uses whole orders to keep fixed fees low.
  - **How it picks:**
    1. Each bucket's remaining need towards your target % of the goal is worked out by "water-filling". Buckets already above their share get no new money.
    2. The money is cut into whole orders, so each bucket gets a whole number of them.
    3. This month's order goes to the bucket furthest below its target.
  - After you record the buy (the **Buy…** button pre-fills ticker, quantity and fee), the next order updates. It works for any horizon.
- **Monthly plan** (below **Next order**, using the same inputs) shows the whole path to the goal:
  - the month you reach it and the number of orders;
  - estimated fees, compared with splitting every month across every asset;
  - a month-by-month list (12 months at a time) and the final allocation against your targets.
  - Plans longer than 100 years are only listed for their first 1,200 months.
  - **Projection (Monte Carlo):** 2,000 simulated futures, month by month, using your expected yearly return (default 6%) and the volatility of the mix. That volatility comes from 3 years of prices of your target mix when you allocate by asset, or of today's portfolio otherwise; you can also type your own. Monthly returns are fat-tailed (Student-t, 5 degrees of freedom). You get the median path with bands for half and 80% of the paths, the **chance of reaching a value you choose** by the goal date (default: the goal), the chance of ending below the money invested, and the same figures per year in the table.
  - **Projected allocation:** a stacked chart (as % or as money) of what you'll have invested in each asset, month by month, plus a table with each asset's share (and €) now, at the end of each year and at the goal, next to its target.
- **Allocation targets for real assets:** in **Allocation**, "Add an asset you don't hold yet" searches real tickers on Yahoo, by name, ticker or ISIN.
  - With "Allocate by: Each asset", the asset gets its own target.
  - With "Asset type" or "Sector", it counts toward its type or sector bucket.
  - With "My groups" or "Account", you can still type a label of your own. Picking a ticker there switches to "Each asset".
  - In **Next order**, the **Buy…** button opens a buy pre-filled with the ticker, price, quantity and fee.
- **Exposure** shows what you really own once your funds are broken down into their holdings, by company, sector, country or currency, split into "direct" and "through funds".
  - It flags overlaps, for example a stock you hold directly that is also inside your S&P 500 ETF.
  - Fund holdings come from Yahoo's published top holdings (usually the top 10); the rest of each fund is shown as "Other holdings of …".
  - Countries and currencies for funds use approximate index weights, detected from the fund name, and you can change the profile per fund.
  - Hedged share classes count as their hedge currency.
- **Costs** shows the fees you've paid (total, this year, and as a share of traded volume), broken down by account and by year, plus your most expensive trades by fee %.
  - It also shows the yearly running cost of your funds (TER).
  - You can set a fee rule per account: a fixed €, a %, a minimum. The buy and sell dialogs then pre-fill the fee, and **Fill missing** applies the rule to past trades that have no fee.
- **Taxes · ES** is an IRPF estimate for the base del ahorro, in EUR. It is not tax advice.
  - It uses the 2025+ savings scale (19/21/23/27/30%) and FIFO cost at the FX rate of each date.
  - It applies the **2-month rule** (losses deferred when the same security is bought 2 months before or after, and released when those shares are sold).
  - It applies the 25% offset between gains/losses and dividends, and carries losses forward for 4 years. You can add losses from years before you used the app.
  - Withholding on dividends is deducted up to the Spanish tax on them.
  - For the current year it also shows "if you sold today" (extra tax per position), losses you could sell to offset gains, and the date until which you shouldn't buy back what you sold at a loss.
- **Transactions** lists every buy, sale and dividend, with a yearly summary: gains, losses, net realized, gross dividends, tax withheld, net dividends and fees.
  - Sales are matched to your oldest buys first (**FIFO**) per asset and account.
  - Costs and proceeds are converted at the **FX rate of each date**. Buy fees are added to the cost and sale fees are subtracted from the proceeds.
  - The app won't save a sale (or an edit or deletion of a buy) that would leave you selling more than you held on that date.
  - Hacienda applies FIFO across all your brokers for the same security. If you hold the same ISIN in two accounts, check the result.

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
| GET | `/api/risk?base=EUR&years=3` | Risk of today's mix: volatility, drawdowns, beta, per-holding risk share and correlation, concentration, crisis scenarios |
| POST | `/api/risk/mix` | Volatility of any weighted mix of tickers (`{"weights": {"IWDA.AS": 60, "BTC-EUR": 10}}`) |
| GET | `/api/ideas?universe=spain\|world` | Screener: factor scores (0–100), reasons and flags per stock, your sector/region exposure vs the world; company data loads in the background (`progress`) |
| GET/PUT/POST | `/api/alerts`, `/api/alerts/config`, `/api/alerts/token`, `/api/alerts/link`, `/api/alerts/unlink`, `/api/alerts/test`, `/api/alerts/check` | Telegram alerts: status and log, settings, write-only bot token, one-time link code, test message, check now |
| GET | `/api/earnings` | Earnings calendar for the stocks you hold: next date, estimates, past surprises, typical move |
| GET | `/api/targets/levels` | Per symbol: resistance and support zones, typical daily move and volatility, breakout, analyst consensus. Per buy: peak and low since the buy. Exits are the `target_price`, `stop_price`, `trail_pct` and `atr_k` fields of a position |
| GET | `/api/targets/peaks` | Peak and low close since each open, dated buy |
| GET | `/api/portfolio?base=USD` | Positions with value, cost, P&L, day P&L and totals |
| GET | `/api/search?q=` | Symbol search (ticker, name, ISIN) |
| GET | `/api/quote/{symbol}` | One quote |
| GET | `/api/quotes?symbols=a,b` | Several quotes |
| GET/POST/PATCH/DELETE | `/api/transactions[/{id}]` | Sales (`SELL`: quantity, price, fees) and dividends (`DIVIDEND`: amount, withholding) |
| GET | `/api/ledger?base=EUR` | Buys, sales (with FIFO lots and realized gain) and dividends, plus totals per year |
| GET | `/api/performance?base=EUR` | Daily portfolio value, net invested and the benchmark shadow portfolio, plus XIRR |
| GET | `/api/exposure?base=EUR` | Exposure by company, sector, country and currency, with funds broken down into their holdings |
| GET | `/api/costs?base=EUR` | Fees by account and year, most expensive trades, fund running costs |
| POST | `/api/costs/fill` | Apply an account's fee rule to its trades that have no fee |
| GET | `/api/tax?year=2026` | Spanish IRPF estimate: per-year base and tax, 2-month rule, carry-forward, what-if and losses to harvest |
| GET | `/api/sessions[?codes=XNYS,XMAD]` | Session schedule (UTC ms), holidays, early closes and the exchange catalog |
| GET/PUT | `/api/settings` | UI settings |
| GET/POST | `/api/export`, `/api/import` | JSON backup |

Interactive docs are at `/docs`.

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
node tests/js/planner.test.js
STONKS_PROVIDER=mock STONKS_DATA_DIR=./data uvicorn app.main:app --reload
```
# stonks-dash
# stonks-dash
