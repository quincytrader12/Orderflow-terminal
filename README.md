# Novus Ordo — by Quincy Gininda

A browser-based crypto order-flow terminal with a liquid-glass interface. Your browser connects directly to each exchange's public WebSocket — no backend, no account, no data leaving your device — and renders footprint charts, a liquidity heatmap, a DOM ladder, the tape, TPO profiles, liquidations, options flow and more in a dockable multi-panel workspace.

Modelled on the feature set of [Cryexc](https://cryexc.josedonato.com/) (whose docs and open-source [backend protocol](https://github.com/jose-donato/cryexc-backend) / [history protocol](https://github.com/jose-donato/cryexc-history) informed this build). This is an independent implementation in TypeScript + React + Canvas 2D.

## Secure boot

The app opens on a black lock screen showing the Novus Ordo emblem, "Welcome to Novus Ordo — a construction by Quincy Gininda", and an **ENTER LEDGER KEY** prompt. While it waits, the terminal really loads in the background, and the bottom-right corner lists each asset as it arrives: emblem, typefaces, theme, ledger database, key vault, CCXT connectors, market hub, aggregate venues, history backfill, order-flow collectors and workspace layout. The terminal opens once the 8-digit ledger key is entered.

- Only a salted SHA-256 digest of the key ships with the app.
- The desktop process enforces the lock on its own side: API keys, trading, bots, wallets, reports and Telegram stay sealed until it verifies the key. Only public market data and trade recording run before that.
- Five wrong attempts lock input for 30 s, doubling after each further miss.
- **Settings → Ledger key** changes the key. It needs the current key, and a new 8-digit key that isn't all one digit or a straight run. The new key is stored as a digest with a fresh random salt, and the built-in key stops working.
- **⛨ Seal** in the top bar returns to the lock screen immediately. AMT bots keep running while the terminal is sealed.
- The tests never use the owner's key: each run seeds a throwaway key, so CI needs no secret.

## Desktop app (Windows .exe)

Novus Ordo ships as a desktop app built with Electron. The desktop app adds:

- **CCXT**: any of CCXT's 100+ exchanges as a venue (pick **CCXT (any exchange)** as the primary venue or add it to Σ, then choose the exchange, Spot/Perp and quote in the top bar). Streams use ccxt.pro WebSockets where the exchange has them, REST polling otherwise. All REST calls run in the desktop process, so browser CORS limits disappear.
- **Database**: a local SQLite file (`novus-ordo.sqlite` in the app data folder) holding recorded trades, the encrypted key vault and connected wallets. Live trades of the primary (or all Σ venues) are recorded and used as the **Local database** history source on the next launch, with any gap filled from the exchange. The **Database** panel shows size, instruments and retention, and exports CSV.
- **Key vault** (top bar → 🔑 Keys): stores any API key — exchange credentials (fields follow each CCXT exchange's requirements, with testnet toggle and a **Test** button), Solana RPC URLs, or any other named key with custom fields. Values are encrypted with the OS keychain (Windows DPAPI, macOS Keychain) before they reach the database; the UI only shows masked values and **copy** puts a value on the clipboard (cleared after 30 s) without displaying it. Exchange keys are used only by CCXT in the desktop process (**Exchange Accounts** panel: balances, positions, open orders, fills) and are read-only in the app until you tick **Allow trading** on the key.
- **Trading** (**Order Ticket** panel, under the DOM in the Chart Center layout): market, limit, stop and stop-limit orders on any CCXT exchange, sized in the base asset or in USD (with 10/25/50/100 % of your free balance), with post-only, reduce-only, GTC/IOC/FOK and leverage on derivatives. Click a DOM level to send its price to the ticket (bid side → buy, ask side → sell). **Exchange Accounts** gets **Cancel**, **Cancel all** and **Close** (reduce-only market) buttons. Safety rules run in the desktop process, not the UI, so nothing can bypass them:
  - a key places orders only after you tick **Allow trading** on it in 🔑 Keys (cancelling always works);
  - every order is checked against a **maximum order value** (default $1,000), a **rate limit** (default 10 orders/minute) and a **maximum distance from the market** (default 50 %), all editable under ⚙ in the ticket; reduce-only and close orders skip the value cap because they can only shrink a position;
  - stops that would trigger immediately, post-only on non-limit orders, and reduce-only on spot are refused;
  - a **confirmation** step shows the full order (with a LIVE/TESTNET badge) before it is sent; you can switch it off under ⚙;
  - keys marked **testnet / sandbox** trade on the exchange's testnet and never fall back to live if the exchange has no testnet;
  - every attempt — placed, rejected or failed — is written to the `orders_log` table in the database and shown in the ticket's order log; placed orders are also forwarded to Telegram when alert forwarding is on.

  Start on a testnet key. Create exchange keys with trade permission only — never enable withdrawals.
- **Telegram reports** (Telegram Bot panel → Reports): a **daily report** (default 16:00, your computer's local time) and a **weekly overview** (default Sunday 16:00), both editable. They're sent while the app is open, and a report missed earlier the same day is sent when the app reopens.
  - **Daily:** price, 24 h change/range/volume, funding (with APR) and OI change; watchlist prices; the 24 h value area (VAH/POC/VAL, high- and low-volume nodes); an AMT reading of where today opened against prior-day value (initiative/responsive, 80 % rule setups); liquidation totals and the largest liquidations and prints; AMT bot trades, win rate, PnL, fees and drawdown, with best and worst trade; orders placed/cancelled/rejected/failed; exchange balances and positions; Phantom wallet value; alerts fired by type; recorded-data size and feed health. It comes with a **chart image**: 15 m candles, volume, value-area band, POC, prior value and the volume profile.
  - **Weekly:** the same for 7 days, plus weekly value and its migration against the prior week, bot results by setup, a 1 h chart image and an **equity-curve image** of the bots.
  - **Instant messages:** alerts, placed orders, AMT bot entries (sent as an image of the profile with entry, stop and target), exits, stops and errors, and a notice when the data feed has been down for 2 minutes and again when it recovers.
  - **Preview daily/weekly** shows the exact message and images in the app without sending; **Send … now** sends immediately. Value areas use recorded trades only when they cover the period; otherwise they're estimated from candles and marked "from candles".
- **AMT Bots** (panel → Algo): Auction Market Theory bots in two styles — **Scalp** (below) and **Intraday** (initial-balance extension, prior-day value acceptance/rejection, 80 % rule; holds for hours with a trailing stop to the session POC and is flat before the session closes). The scalp style is a scalping bot you can run on any symbol of any CCXT exchange, one bot per symbol, each with its own **ON/OFF switch**. It builds a rolling volume profile (POC, 70 % value area), tracks balance → probe → acceptance/rejection, and trades three setups when order flow (aggressor delta, volume intensity, book imbalance) agrees: **responsive fade** of a rejected probe back to POC, **initiative breakout** after acceptance outside value, and the **80 % rule** re-entry into prior value. Size comes from risk per trade; breakeven at 1R, a time stop, cooldown, trades-per-hour and a daily loss limit that switches the bot off. **Paper** mode (default) simulates fills with fees and slippage; **Live** mode trades through the same protected path as the Order Ticket and places a reduce-only exchange stop on derivatives. Any failed live order switches the bot off. The top bar shows **ALGO n · PnL ⏹** while bots run — click it to stop all. **Backtest** replays trades the terminal recorded in its database. Theory, sources and an honest note on what “HFT” means from a laptop: [docs/AMT.md](docs/AMT.md).
- **Phantom wallet**: **Connect Phantom** in the **Phantom Wallet** panel opens a one-time local page in your default browser (where the Phantom extension lives). You approve the connection and sign a message; the app verifies the ed25519 signature before saving the address. It is read-only — the app never sees a private key and cannot move funds — and shows SOL, SPL tokens and USD value (Jupiter prices). You can also watch any address, and add a private RPC in the vault.

### Get the .exe

- **Zip (fastest start)**: `NovusOrdo-<version>-win-x64.zip`. Extract it once, for example to `C:\Novus Ordo` (not inside the zip viewer), then run `Novus Ordo.exe`. It opens in a couple of seconds; pin it to the taskbar.
- **Installer**: `NovusOrdo-<version>-setup.exe` installs it with a Start-menu shortcut and starts just as fast. It is built on Windows (see below).
- **Portable**: `NovusOrdo-<version>-portable.exe` is a single file, but it unpacks the whole app (~350 MB) into a temp folder on **every** launch. With Windows Defender scanning, that can take 20–60 s before the window appears.

**If it won't open properly:**

- The window starts black (the lock screen) and should show the emblem within a few seconds.
- If it stays blank because of a graphics-driver problem, the app notices and restarts itself in **safe mode** (no GPU acceleration). You can also choose **Help → Restart in safe mode**, or start it with `--safe-mode`.
- **Help → Open log folder** shows `novus.log`, with startup timings and any errors. Send that file when reporting a problem.
- Clicking the icon again while it is starting does not open a second copy; it brings the running window to the front.

Build them yourself on Windows with `npm ci && npm run dist:win` (outputs to `release/`), or run the **Desktop app** GitHub Actions workflow (Actions → Desktop app → Run workflow, or push a `v*` tag) which builds Windows, macOS and Linux packages and attaches them as artifacts. Builds are unsigned, so Windows SmartScreen shows *More info → Run anyway* the first time.

Development: `npm run desktop:dev` (Vite + Electron with hot reload) or `npm run desktop` (production build).

- **Yahoo Finance**: stocks, ETFs, indices (^GSPC), futures (NQ=F, GC=F), FX (EURUSD=X) and crypto in the **Yahoo Finance** panel — quote board, symbol search and candles (1d → 5y). Yahoo blocks browser requests, so this panel needs the desktop app; quotes may be delayed depending on the exchange.
- **Telegram bot**: create a bot with @BotFather, add its token in 🔑 Keys (**+ Telegram bot**), press Start on your bot, then **Detect chat** and **Send test message** in the **Telegram Bot** panel. Fired alerts are forwarded to your chat, and you can let the bot answer `/price`, `/status` and `/help` — only from your own chat, while the app is open.
- **Phantom data**: the wallet panel reads your address's SOL and SPL token balances, their USD value and the 25 most recent transactions (Activity tab, linked to Solscan) from the Solana blockchain. Phantom itself only shares your public address and a signature; nothing can read or move funds.

The layout defaults to **Chart Center**: the footprint chart in the middle, DOM and book on the left, tape, summary and wallet on the right. Every split is draggable; **⤢ Chart** maximises the main chart and **🔓/🔒** locks tabs in place (splits stay resizable).

**Put anything anywhere.** Drag any tab by its title onto the top, bottom, left, right or centre of any panel, or onto the window edge. **+ Panel** also asks where to place it: as a tab in the active area, a new column on the left or right, a new row at the bottom, or in a collapsible **left / right / bottom dock**. Panels redraw to whatever size they are given, and you can open the same panel type several times with different settings. Layouts save automatically; name and reload them under ▦ Layouts.

## Themes, filters and glass

Switch from the swatches in the top bar or **⚙ Settings → Theme**:

| Theme | Look |
|---|---|
| **Grey** (default) | graphite grey workspace with soft glass cards |
| **White** | bright frosted glass on a pale backdrop |
| **Black** | deep black with dark glass |
| **Neon Green** | black-green backdrop, green glow, green heatmap ramp |
| **Neon Orange** | black-amber backdrop, orange glow, orange heatmap ramp |

Every theme recolours both the interface and the canvas charts (candles, clusters, heatmap ramp, ladders).

**Filters** (top-bar ◐ menu or Settings): None, Vivid, Soft, Mono, Warm, Cool, Night, CRT (scanlines + vignette).

**Glass** levels: Solid, Light, Glass (default), Frosted. Panels are rounded cards with hairline borders, a 1px top highlight and soft shadows. Menus, modals and toasts blur what is behind them; *Frosted* also adds a live backdrop blur under every panel (GPU-heavy while charts animate).

Theme and filter can be set from the URL: `/?theme=neon-orange&filter=crt`.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Production build (static files, deployable to any static host — paths are relative):

```bash
npm run build        # outputs dist/
npm run preview
```

Requires Node 22+.

## Venues

| Venue | Symbol format | Trades | Order book | Liquidations | Funding / OI | Klines | REST history backfill |
|---|---|---|---|---|---|---|---|
| Binance Futures | `BTCUSDT` | ✓ aggTrade | ✓ diff-depth, snapshot sync (`pu` continuity) | ✓ forceOrder | ✓ markPrice / REST OI, L/S ratio, OI history | ✓ | ✓ aggTrades |
| Binance Spot | `BTCUSDT` | ✓ | ✓ diff-depth, snapshot sync | — | — | ✓ | ✓ aggTrades |
| Bybit Perp | `BTCUSDT` | ✓ | ✓ 200 levels, seq checked | ✓ allLiquidation | ✓ tickers / account ratio / OI history | ✓ | — |
| OKX Perp | `BTC-USDT-SWAP` | ✓ (contracts → base via `ctVal`) | ✓ 400 levels, `seqId` gap → resubscribe | ✓ liquidation-orders | ✓ funding / OI / mark / index | ✓ | — |
| Hyperliquid | `BTC` | ✓ | ✓ 20-level snapshots | — (not public) | ✓ activeAssetCtx (1h funding) | ✓ | — |
| Coinbase | `BTC-USD` | ✓ (maker side inverted to aggressor) | ✓ level2 | — | — | ✓ | — |
| Kraken | `BTC/USD` | ✓ v2 | ✓ 1000 levels, truncated per spec | — | — | ✓ | — |
| Bitget Perp | `BTCUSDT` | ✓ | ✓ full depth | — | ✓ ticker | ✓ | — |
| Bitfinex | `tBTCUSD` | ✓ | ✓ P0 / 250 | — | — | ✓ | — |
| Deribit (options) | `BTC`, `ETH` | ✓ option trades → Options Flow panel | | | | | ✓ recent trades |
| Tree of Alpha (news) | | headlines → News panel | | | | | ✓ recent |
| **Simulator** | `BTC-SIM` | synthetic | synthetic | synthetic | synthetic | synthetic | synthetic |

The **Simulator** venue produces a self-consistent synthetic market (book with walls, aggression that consumes liquidity, liquidations, funding, 3h of history). It is clearly labelled "Simulator (synthetic data)" and exists for offline exploration and automated tests. Open `/?venue=sim&agg=sim` to use it.

Some venues are geo-restricted (e.g. Binance in the US); pick a venue that works in your region.

## Concepts

- **Primary instrument** — base asset + venue chosen in the top bar. Drives the footprint chart, DOM ladder, historical chart, volume profile and history backfill.
- **Aggregate set (Σ)** — additional venues streamed for the same base. Trades tape, CVD, open interest, liquidations, spread chart, composite orderbook/depth/heatmap, flow pulse, whale tracker and funding read every visible member.
- **Per-panel venue mask** — each aggregated panel has its own Σ chip to hide venues *in that panel only*. Hidden venues keep streaming.
- **History source** (top bar → History):
  - *Exchange REST backfill* — pulls recent aggregated trades from the venue's public REST API on load (Binance spot/futures, simulator).
  - *Custom (BYOD)* — your own history server speaking the v1 protocol (see below).
  - *Live only*.
- **Layouts** — dockable tabs/splits (drag tabs, double-click a header to maximise). Layout, per-panel settings, alerts, journal and watchlist persist in your browser. A gallery of presets (Terminal, Flow Desk, Scalper, Liquidity, Derivatives, Market Overview, Whale Watch, Options), named saved layouts and JSON import/export are under **▦ Layouts**.

## Panels (31)

| Category | Panel | Highlights |
|---|---|---|
| Charts | **Footprint Chart** | Bid×Ask / Delta / Volume / Profile cluster styles; time, tick, volume and range bars; tick grouping; USD toggle; diagonal & stacked imbalances; bar POC; volume/delta strip; overlays: orderbook heatmap, CVD subplot, visible-range volume profile with value area, volume bubbles, period levels (PDH/PDL/PDC/DO/PWH/PWL/WO), session VWAP, EMA/SMA; zoom/pan, crosshair tooltip |
| | **Liquidity Heatmap** | Bookmap-style historical depth (primary or composite), trade bubbles, best bid/ask lines, live book profile, contrast control |
| | **Historical Chart** | Candles with buy/sell volume, session VWAP ±1σ, session volume profiles, EMA 20 / SMA 50 / SMA 200, EMA 8/21 cloud; **TPO** mode with letters per 30m period, POC, value area, initial balance, single prints, open/close |
| | **Volume Profile** | Session (UTC) or rolling profile, buy/sell, volume or delta, POC/VAH/VAL |
| Order book | **DOM Ladder** | Sold / Bid / Price / Ask / Bought / Δ / Volume, traded-volume window, session high/low markers, print flashes, auto-centre |
| | **Orderbook** | Composite multi-venue book grouped by tick with per-venue contribution and cumulative depth |
| | **Depth Chart** | Cumulative USD depth ±range, optional per-venue curves |
| | **Orderbook Stats** | Spread and depth within 0.5% / 2% / 10% per venue + Σ, imbalance bars |
| Orderflow | **Trades Tape** | Multi-venue time & sales, min notional, side filter, same-ms sweep aggregation, size tiers, whale sound |
| | **Flow Pulse** | Rolling 30s / 1m / 5m / 15m bought vs sold notional; last-minute volume and delta per venue |
| | **CVD** | Per-venue and aggregated cumulative volume delta with price strip |
| | **Whale Tracker** | Large prints and liquidations, net whale flow 5m/15m/1h, timeline |
| Derivatives | **Liquidations** | Feed, long/short totals, timeline |
| | **Open Interest** | Per-venue OI (USD), share, Δ1h/Δ4h, aggregated or per-venue chart |
| | **Funding** | Rate, interval, 8h-equivalent, APR, countdown, mark, basis, OI-weighted average |
| | **Options Flow** | Deribit prints: premium, IV, side, blocks, call/put premium, P/C ratio, top strikes |
| Market | **Spread Chart** | Each venue's mid vs the primary in bps or price |
| | **Symbol Summary** | Last, 24h range/volume, mark/index, basis (bps), funding + APR + countdown, OI, L/S accounts, feed health |
| | **Screener** | All perps on a venue (Binance, Bybit, OKX, Hyperliquid, Bitget): price, 24h, volume, funding, OI — click to load |
| | **Watchlist** | Any symbol on any venue |
| | **News** | Real-time headlines, filter by coin |
| | **Yahoo Finance** | Stocks, indices, futures, FX: quote board, search, candles (desktop) |
| Account | **Order Ticket** | Market/limit/stop/stop-limit orders on any CCXT exchange with value cap, rate limit, confirmation and order log; click a DOM level to price it (desktop) |
| | **Exchange Accounts** | Balances, positions, open orders and fills from any CCXT exchange; cancel orders and close positions (desktop) |
| | **Phantom Wallet** | Connect Phantom or watch an address: SOL, tokens, USD value, recent activity |
| | **Database** | Recorded trades per instrument, retention, CSV export |
| Algo | **AMT Bots** | Auction Market Theory bots for any symbol — Scalp or Intraday style: value area, initial balance, prior-day value, acceptance/rejection, order-flow confirmation, paper/live, on/off switch, backtest (desktop) |
| Tools | **Telegram Bot** | Forward alerts, answer /price and /status |
| | **Alerts** | 12 types evaluated in-browser: price above/below, large trade, liquidation, liquidation cascade, CVD divergence, absorption, wall appears, wall pulled, volume spike, delta spike, OI change — sound, browser notifications, cooldowns, log |
| | **Journal** | Timestamped notes with price and tags; export Markdown/JSON |
| | **Calculator** | Risk-based position size with fees and R:R, isolated liquidation estimate, market-cap ↔ price |

## URL parameters

```
/?base=ETH&venue=bybit&agg=binancef,okx,hyperliquid&history=none&theme=light
```

### Embed a single panel

```html
<iframe src="https://your-host/?embed=footprint&base=BTC&venue=binancef&interval=5m&style=delta&theme=black" width="900" height="600"></iframe>
```

Any panel id from the table above works (`footprint`, `heatmap`, `dom`, `tape`, `historical`, `cvd`, …), and any panel config key can be passed as a query parameter.

## Self-hosted history server (BYOD)

`server/history-server.mjs` is a zero-dependency Node server that ingests live trades (and liquidations where public) and serves them over the v1 history protocol, compatible with [cryexc-history](https://github.com/jose-donato/cryexc-history).

```bash
npm run history-server -- --exchange binancef --symbols BTCUSDT
# or: node server/history-server.mjs --exchange bybit --symbols BTCUSDT --port 8081 --auth-token $(openssl rand -hex 32)
```

| Flag | Default | Notes |
|---|---|---|
| `--bind` | `127.0.0.1` | Set `0.0.0.0` only with `--auth-token` |
| `--port` | `8080` | |
| `--exchange` | `binancef` | `binancef`, `binance`, `bybit`, `hyperliquid` |
| `--symbols` | `BTCUSDT` | comma-separated venue symbols (`BTC` for Hyperliquid) |
| `--auth-token` | — | require `Authorization: Bearer <token>` on `/v1/*` |
| `--retention-hours` | `24` | pruned every 5 minutes |
| `--backfill-minutes` | `60` | Binance REST backfill on start |
| `--data-dir` | — | persist to disk every 5 min and on shutdown; reload on start |

Unlike cryexc-history, Binance reconnects are **gap-filled** from REST `aggTrades` (live trades are buffered until the fill completes).

Endpoints: `GET /health`, `GET /v1/info`, `GET /v1/trades?exchange&symbol&start_ms&end_ms[&limit]`, `GET /v1/liquidations?…`. Errors are `{"error":{"code","message"}}`. Results over the limit return the most recent rows with `"truncated": true`.

Then in the terminal: **History → Custom (BYOD)** → URL `http://localhost:8080` (+ token) → **Test connection** → Apply.

## Development

```bash
npm run typecheck    # tsc
npm test             # vitest: core engines, adapters (fake WebSocket), alerts, panels, history server + BYOD client
npm run e2e          # Playwright (playwright-core) against Chromium:
                     #   e2e/desktop.mjs — launches the Electron app (xvfb-run on Linux): vault, database, CCXT, wallet, layout
                     #   e2e/smoke.mjs  — every layout preset and every panel on the simulator, fails on page errors
                     #   e2e/venues.mjs — mocks all 8 venues' WebSocket/REST in the browser and checks each real adapter streams
```

For e2e outside the dev container, install a browser once with `npx playwright-core install chromium` (or set `CHROMIUM_PATH`). Screenshots land in `e2e/screenshots/`.

### Layout of the code

```
src/core/        domain types, TradeStore (columnar typed arrays), OrderBook, footprint/volume-profile/value-area,
                 rolling DOM profile, heatmap recorder, indicators (EMA/SMA/VWAP/TPO/CVD), formatting
src/exchanges/   one adapter per venue + reconnecting WebSocket, Deribit options, news, simulator
src/market/      MarketHub (feeds for primary + aggregate set, tape, heatmap recorders, backfill), whale collector
src/history/     BYOD v1 client
src/alerts/      alert engine (12 types), toasts, sound
src/panels/      31 panels (canvas renderers for charts, React tables elsewhere) + registry
src/app/         top bar, docking layout, presets, modals, embed mode
electron/        desktop main process: CCXT service, order rules (trading.mjs), AMT engine and bots (amt/), SQLite database, key vault, Phantom
src/desktop/     renderer side of the desktop bridge (vault, wallet, Telegram, order ticket helpers)
server/          self-hosted history server
e2e/             browser and desktop tests
```

## Known limitations

- Exchange APIs evolve; adapters follow each venue's public documentation. Venues without a public liquidation stream (Hyperliquid, Coinbase, Kraken, Bitget, Bitfinex) don't contribute to liquidation panels.
- Footprint/DOM history comes only from the selected history source; venues without public trade history start live unless you run a history server.
- Live data, adapters and parsing are covered by tests against each venue's documented message formats, but not against the live exchanges themselves. If a venue's REST API rejects browser requests (CORS) or changes format, that venue's candles/watchlist entry shows an error while other panels keep working.
- Alerts run in the open tab only.
- Book depth is limited to what each venue publishes (e.g. Hyperliquid 20 levels).
