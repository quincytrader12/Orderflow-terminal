# Auction Market Theory and the Novus Ordo AMT Scalper

## 1. What Auction Market Theory says

Auction Market Theory (AMT) comes from J. Peter Steidlmayer's Market Profile work at the Chicago Board of Trade. James Dalton (with Eric Jones and Robert Dalton) turned it into a trading discipline in *Mind Over Markets* and *Markets in Profile*. Its premise is that a market is a continuous two-way auction whose job is to **facilitate trade**:

- Price advertises an opportunity. Time regulates it. Volume shows whether the auction found trade there.
- The price range where most trade takes place is **value**. On a volume (or TPO) profile, the busiest price is the **point of control (POC)**. The band holding about 70% of the volume is the **value area**, bounded by **VAH** (value-area high) and **VAL** (value-area low).
- Markets alternate between two states:
  - **Balance.** Both sides agree on value, and price rotates inside a range. *Responsive* traders sell above value and buy below it, betting on a return.
  - **Imbalance.** One side is aggressive enough to push the auction away from value in search of new two-sided trade. *Initiative* traders buy above value or sell below it.
- When price leaves value, the auction either **accepts** the new prices (time and volume build there, and value migrates) or **rejects** them (a quick return inside value, often leaving *excess*, such as a sharp tail or a "look above and fail").
- **The 80% rule** (Market Profile lore): if a session opens outside the prior session's value area, then re-enters and is accepted there (classically two 30-minute periods), it often traverses to the far side of that value area.

Two caveats from the sources:

- AMT is a **way of reasoning about price, not a signal system**. Profiles depend on session definitions and value-area conventions. "Acceptance" and "excess" involve judgement. There is no rigorous public evidence that the framework predicts returns on its own ([LuxAlgo — AMT](https://www.luxalgo.com/library/concept/auction-market-theory/), [NexusFi](https://nexusfi.com/a/market-structure/auction-theory-futures-trading), [ATAS](https://atas.net/market-theory/the-auction-market-theory/)).
- The "80%" is a **folk label, not an audited statistic**. No independent backtest of re-entry success rates turned up, and measured rates vary by market and era. It fails most often on trend days and news ([LuxAlgo — 80% rule](https://www.luxalgo.com/library/concept/80-percent-rule/), [MetroTrade](https://www.metrotrade.com/what-is-the-80-rule-in-futures-trading/), [NexusFi](https://nexusfi.com/a/concepts/80-percent-rule)).

That is why the scalper below makes you **paper trade and backtest** before it will trade live, and why every rule is a parameter you can change.

## 2. Adapting AMT to crypto

- **24/7 markets have no opening bell.** The bot defines value two ways:
  - a **rolling profile** (default: the last 240 minutes), which is the value the scalper trades around;
  - **UTC-aligned sessions** (default 24 h; 8 h gives Asia/London/NY), which supply *prior value* for the 80% rule. A session only counts once the bot has seen it from its open.
- **Order flow replaces TPO letters.** Crypto venues publish every trade with its aggressor side, plus the order book. The bot confirms the auction with three measures:
  - **aggressor delta**, (buy − sell) / total volume over the last 20 s;
  - **volume intensity**, recent volume against the 10-minute average;
  - **book imbalance**, bid against ask depth within ±10 bps of mid.

## 3. How the bot trades

The bot runs in the desktop process, one per symbol, with as many bots as you like. It streams trades and the book of its market through ccxt.pro and works through this state machine:

```
warm-up ──► balance ──(price > VAH + 2 bins)──► probe-up ──(60 s beyond VAH)──► accepted-up  ⇒ BREAKOUT long
                ▲                                  │
                └──(back inside value within 120 s)┘                          ⇒ FADE short (rejection)
```

The probe-down side mirrors this. Value is frozen when a probe starts, so the bot judges the move against the value it left.

| Setup | AMT idea | Entry needs | Stop | Target |
|---|---|---|---|---|
| **Responsive fade** | failed auction / rejection at a value edge | probe beyond VAH/VAL that returns inside within `rejectSec`; delta ≥ threshold *against* the probe; book agrees | beyond the probe extreme + buffer | POC |
| **Initiative breakout** | acceptance outside value → imbalance | `acceptSec` beyond the edge; delta ≥ threshold *with* the move; volume ≥ `intensityMin`×; book agrees | back inside value (edge − buffer) | value-area width projected from entry |
| **80% rule** | open outside prior value, re-accept it | `reentrySec` inside prior value; delta not strongly against | beyond the prior edge it came from | far edge of prior value |

All setups must also pass:

- reward : risk ≥ `minRR` (default 1.5);
- a target far enough away to clear round-trip fees and slippage;
- spread ≤ `maxSpreadBps`;
- no open position, no cooldown after a loss, and under `maxTradesPerHour`.

**Trade management:**

- **Size** is `riskUsd ÷ stop distance`, capped by `maxPositionUsd` and by the Order Ticket's maximum order value.
- After **1R** the stop moves to entry plus costs.
- A **time stop** applies (`maxHoldSec`).
- At the **daily loss limit** the bot switches itself off.

### Paper and live

- **Paper** (the default) fills market orders at the last trade price plus `slippageBps` and charges `feeBps` per side.
- **Live** sends market orders through the same code path as the Order Ticket, so the terminal's protections all apply:
  - the key must have **Allow trading** ticked;
  - the maximum order value and the per-minute order limit;
  - testnet keys never fall back to live;
  - every attempt goes into the `orders_log` table.
- On derivatives, each live position also gets a **reduce-only stop-market order on the exchange** at the initial stop, so it stays protected if the terminal closes. The bot cancels that order when it exits.
- **Any failed live order switches the bot off** and reports what happened, so a person can check the account.

### Switches

- Each bot has an **ON/OFF switch** in its panel. Turning a live bot on asks for confirmation. Turning it off with a position open lets you keep the position or close it at market.
- The top bar shows **ALGO n · PnL ⏹** while any bot runs. Clicking it stops every bot (the kill switch).
- Bots never start by themselves. After a restart every bot is off.
- Entries, exits, stops and errors are forwarded to Telegram when alert forwarding is on.

### Backtest

The **Backtest** tab replays trades the terminal recorded into its SQLite database through the bot's current settings, with paper fills. It reports the trade list, win rate, net PnL, profit factor, maximum drawdown, fees and an equity curve. Recorded data has no order book, so book filters are skipped there.

## 4. Intraday style — longer holds

The same engine has a second **style**, chosen per bot under **Settings → Style**. It trades the session's auction structure instead of the rolling value, and it holds positions for hours. Running a scalp bot and an intraday bot on the same market spreads the automation across two timeframes and two kinds of edge.

| Setup | AMT idea | Entry needs | Stop | Target |
|---|---|---|---|---|
| **Initial-balance extension** | The first hour (IB) is where the day's early buyers and sellers set the range. An extension beyond it that holds signals a trend day. | Price spends `ibAcceptMin` (15 min) beyond the IB high or low. 5-minute delta confirms. The trade isn't against prior-day value. | Back inside the IB by 25 % of its range | IB edge ± 1× IB range |
| **Prior-value acceptance** | Price accepted outside yesterday's value means value is migrating. | `priorAcceptMin` (30 min) outside prior VAH or VAL. Delta confirms. | Back inside prior value | One value-area width beyond the edge, or the prior high/low if further |
| **Prior-value rejection** | A failed auction beyond yesterday's value is a responsive opportunity. | A probe beyond prior VAH or VAL returns inside within `priorRejectMin` (30 min). Delta confirms. | Beyond the probe extreme | Prior POC |
| **80 % rule** | Same as the scalp style | | | |

**Trade management for the intraday style:**

- Stops are wider and fewer trades are taken: at most `maxTradesPerSession` (3), with R:R ≥ 2 and a 15-minute cooldown after a loss.
- At +1R the stop moves to breakeven. At +2R it **trails to the developing session POC**.
- Every position is closed **15 minutes before the session ends** (UTC midnight with 24 h sessions), so nothing is carried overnight. The maximum hold is 8 h.
- The IB setup only arms when the bot has seen the session from its open. The prior-value setups need one complete session first, so a fresh intraday bot spends its first day building context. Run it in paper mode alongside the scalp bot meanwhile.

## 5. Safety behaviour of live bots

- **Exact sizing.** Live positions are tracked in exchange units (contracts) exactly as filled. Exits and the exchange stop close what was opened.
- **Exchange stop placement.**
  - The protective stop sits half a risk unit beyond the bot's own stop, so the bot normally exits first.
  - The stop is cancelled only **after** the exit has filled.
  - If the exchange stop already closed the position, the bot records that and carries on.
- **Order rules.**
  - Reduce-only orders are trimmed to the open position.
  - Spot exits may only sell what is actually held.
  - Risk-reducing orders are never held back by the per-minute rate limit.
- **Switching off.** If you click **Stop & close position** while an entry is still in flight, the bot closes that entry as soon as it fills.
- **Entry filters.**
  - No entry is taken on stale data (no trades for 30 s, or for the flow window if that is longer).
  - No entry is taken when the stop would sit inside round-trip costs.
  - Breakeven never moves the stop past the current price.
- **Keys.** A key used by a running live bot cannot be edited or deleted until the bot stops.

## 6. HFT: what is and isn't possible from a laptop

True high-frequency trading means co-located servers, sub-millisecond reaction, maker rebates and queue position. A desktop app talking to an exchange's public API over the internet sees **tens to hundreds of milliseconds** of latency, has to respect API rate limits, and pays **taker fees of roughly 2–10 bps per side**. One example: a round trip at Hyperliquid's base taker fee costs 0.09% of notional ([buildix](https://www.buildix.trade/blog/crypto-scalping-orderflow-realistic-guide)). Racing for single ticks under those conditions has negative expected value. Fees and slippage erase a small edge, and in thin markets book signals are easier to fake ([CoinAPI](https://www.coinapi.io/blog/crypto-scalping-trading-faq-profitability-tools-data-insights), [Block3](https://www.block3finance.com/scalping-in-crypto-techniques-risks-and-reality)).

So the AMT scalper is a **short-horizon order-flow scalper**. It decides on every trade as it arrives (tick by tick), but it holds positions for seconds to minutes and only takes setups whose target clears costs. This is the part of "HFT-style" trading that works from a laptop: fast reading of the auction, disciplined execution, hard risk limits.

### Ways to raise the odds

1. Paper-trade each symbol for days. Compare that with a backtest on the trades the terminal recorded.
2. Start live on a **testnet key**, then on small size.
3. Prefer liquid perpetuals (BTC, ETH, SOL) with low fees. Raise `minRR` on costly venues.
4. Tune `profileMinutes`, `acceptSec` and `deltaThreshold` per symbol. Turn off setups that backtest poorly on a market.
5. Nothing here is financial advice. AMT gives structure, not certainty.
