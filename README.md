# Orderflow Terminal

A free, browser-based crypto order-flow terminal. Your browser connects directly to each exchange's public WebSocket — no backend, no account, no data leaving your device — and renders footprint charts, a liquidity heatmap, a DOM ladder, the tape, TPO profiles, liquidations, options flow and more in a dockable multi-panel workspace.

Modelled on the feature set of [Cryexc](https://cryexc.josedonato.com/) (whose docs and open-source [backend protocol](https://github.com/jose-donato/cryexc-backend) / [history protocol](https://github.com/jose-donato/cryexc-history) informed this build). This is an independent implementation in TypeScript + React + Canvas 2D.

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

## Panels (24)

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
| Tools | **Alerts** | 12 types evaluated in-browser: price above/below, large trade, liquidation, liquidation cascade, CVD divergence, absorption, wall appears, wall pulled, volume spike, delta spike, OI change — sound, browser notifications, cooldowns, log |
| | **Journal** | Timestamped notes with price and tags; export Markdown/JSON |
| | **Calculator** | Risk-based position size with fees and R:R, isolated liquidation estimate, market-cap ↔ price |

## URL parameters

```
/?base=ETH&venue=bybit&agg=binancef,okx,hyperliquid&history=none&theme=light
```

### Embed a single panel

```html
<iframe src="https://your-host/?embed=footprint&base=BTC&venue=binancef&interval=5m&style=delta" width="900" height="600"></iframe>
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
src/panels/      24 panels (canvas renderers for charts, React tables elsewhere) + registry
src/app/         top bar, docking layout, presets, modals, embed mode
server/          self-hosted history server
e2e/             browser tests
```

## Known limitations

- Exchange APIs evolve; adapters follow each venue's public documentation. Venues without a public liquidation stream (Hyperliquid, Coinbase, Kraken, Bitget, Bitfinex) don't contribute to liquidation panels.
- Footprint/DOM history comes only from the selected history source; venues without public trade history start live unless you run a history server.
- Live data, adapters and parsing are covered by tests against each venue's documented message formats, but not against the live exchanges themselves. If a venue's REST API rejects browser requests (CORS) or changes format, that venue's candles/watchlist entry shows an error while other panels keep working.
- Alerts run in the open tab only.
- Book depth is limited to what each venue publishes (e.g. Hyperliquid 20 levels).
