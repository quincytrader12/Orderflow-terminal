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

## 5. Growth preset — compounding a small account

A small balance (say R500 ≈ $27) changes what matters. Three things decide
whether it grows, and none of them is the choice of setup:

1. **Fees.** A market order costs ~0.05 % per side on Binance Futures. On a
   scalp with a 0.2 % stop, the round trip costs about a quarter to a third of
   the risk, so a 2R winner keeps only ~1.7R. Many small trades bleed.
2. **Exchange minimums.** Every market has a smallest order (BTCUSDT
   perpetual: about $100; ETH and many alts far less). A $27 account can only
   meet a $100 minimum with leverage, and only if the stop is tight enough
   that the minimum does not blow the risk budget.
3. **Survival.** Fixed-dollar risk either never compounds or wipes the
   account. Growth comes from risking a *percentage* of the current balance:
   sizes grow after wins and shrink after losses.

The **Growth (small account)** preset is built around that:

| | |
|---|---|
| Sizing | 2 % of the current balance per trade (`sizing: balance`, `riskPct`) — compounding |
| Position cap | 5 × the balance (`maxLeverage`); futures are set to **isolated margin** at that leverage, so a position can never lose more than its own margin |
| Exchange minimum | read from the market; an order is rounded up to it only if that still fits the cap and risks at most 2× the plan, otherwise the setup is skipped and the reason logged |
| Trade quality | A+ only: delta ≥ 0.35, volume intensity ≥ 2×, book imbalance ≥ 0.15, spread ≤ 3 bps, reward ≥ 2R, target ≥ 4× round-trip costs (`targetCostX`) |
| Management | the trade manager (§5c½) instead of a fixed breakeven, 30 min time stop, 5 min cool-down after a loss, at most 4 trades an hour |
| Guards | pause 2 h after 3 losses in a row (`lossStreak`); stop for the day at −6 % (`dailyLossPct`); **stop for good at −20 % from the peak balance** (`maxDrawdownPct`) |

Paper trading and backtests start from `accountUsd`; a live bot reads the real
balance from the exchange when it starts, after every trade and every five
minutes. The settings show a preview of one trade at your balance — how much
goes to work, what is risked and what the fees take — in dollars and rand.

**Market choice matters more than settings.** Prefer a liquid perpetual with a
low minimum (ETH/USDT, SOL/USDT) over BTC/USDT, whose minimum forces leverage
on a small account.

A live bot **refuses to start** on a market whose smallest order is bigger
than it may hold (balance × `maxLeverage`), and says so, instead of running and
skipping every setup. With no balance in the futures wallet it explains that
Binance keeps spot and futures apart: convert the deposit to USDT and move it
from Spot to the USDⓈ-M Futures wallet (Wallet → Transfer). The small-account
presets start paper trading from $30 (about R550).

### Training

**Train** (bot toolbar) is a walk-forward parameter search on the trades the
terminal recorded for a market (Database panel → Record trades):

1. 40 variations of the order-flow, auction and trade-geometry settings are
   generated from the bot's current settings (risk settings never change).
2. Every variation replays the data; it is **ranked only on the first 70 %**,
   scoring log-growth of the balance minus a drawdown penalty, net of fees.
3. The five best are judged on the **last 30 %, which the ranking never saw**.
   A result is offered — "Apply to this bot" — only if it also grew the
   balance there. Otherwise the answer is "no edge on this data" and nothing
   changes.

Searching many settings on one stretch of data always finds something that
looks good on that stretch; the unseen part is what tells whether it was
real. Even a verified result is evidence from a few days of one market, not a
promise: paper-trade it before going live, and keep the drawdown stop on.

Training stays off the app's main thread, so the charts and feeds keep
running while it works:

- The recorded trades are read **inside a worker thread**, on its own
  read-only database connection, a page at a time, into typed columns in
  shared memory. The other workers read the same memory; nothing is copied.
- At most **two workers** run, and two CPU cores are always left for the
  charts, the feeds and the GPU. Each worker has a memory ceiling; if a run
  would exceed it, training stops with "choose fewer days" instead of taking
  the app down.
- Progress reaches the window at most four times a second.
- The Database panel and the Train tab read **kept per-market counts**
  (updated as trades are recorded and pruned) instead of counting millions of
  rows. A database from an older version is counted once, an hour of data at a
  time, in the background; its counts fill in over the first minutes.

## 5b. Order-flow hybrid — tape, footprint, book and liquidity map

The **Order-flow hybrid** style trades the way order-flow traders read a
market: who is aggressive on the tape, where the footprint shows one side
overwhelming the other, where real resting liquidity sits in the book, and
where stops collect. One bot runs three setups, and the market decides which
one fires.

| Setup | Reads | Entry | Stop | Target |
|---|---|---|---|---|
| **Absorption reversal** | tape aggression, a liquidity level (a standing **wall** in the book, VAL/VAH, prior value, swing or round-number pool) | aggressive volume ≥ 2× normal and ≥ 0.3 one-sided hits the level and makes ≤ 1 bin of progress, then the aggressors fade: delta over 5 s flips ≥ 0.2, price lifts a bin off the extreme, order-flow imbalance (OFI) turns | beyond the extreme (and the wall) + buffer; **exits at once if the wall is pulled** | POC when it is ≥ min R:R away, else 2R |
| **Imbalance continuation** | footprint: ≥ 3 stacked diagonal imbalances (3:1) in a bar with initiative delta and ≥ 1.5× volume | price leaves the stack, comes back into it, holds; delta since the retest ≥ 0.2 with the move, OFI with it, no absorbing wall in the way | beyond the far side of the stack | the nearest untouched liquidity pool ≥ min R:R away, else 2R |
| **Sweep & reclaim** | liquidity pools (swing highs/lows from footprint bars, prior session high/low, round numbers), tape bursts, **liquidations** | price runs a pool by ≥ 3 bps on a ≥ 2× burst (or liquidations worth ≥ ¼ of a normal 10 s of volume), then — within 90 s — the run has to be **over**: the reclaim holds 10 s, no liquidations in the sweep's direction for 10 s, the aggression that drove it is back to normal, delta and OFI have turned | beyond the sweep's extreme by ≥ half the one-minute range | POC or 2R |

**Regime filter** (on by default): absorption is never faded while value is
being accepted in the aggressors' direction, and continuation only joins
moves on the initiative side of the POC. A sweep that runs further than
25 bps is treated as a breakout and left alone. A sweep that goes with a trending
market (efficiency ratio ≥ 0.5 in its direction over 15 minutes), or with
value being accepted that way, is not faded either; and after a sweep trade
loses, sweeps in that direction sit out 20 minutes. (These came from live
paper trades on ETH: longs bought into a running liquidation cascade or a
steady sell-off, and a "sweep" on no volume with a $271 liquidation.)

**The order book** (5 snapshots a second, 500 levels):

- *Order-flow imbalance* at the best bid/ask, as defined by Cont, Kukanov &
  Stoikov (2014), summed over 10 s as net ÷ gross (−1…+1).
- *Queue imbalance* over the top three levels (Gould & Bonart 2016): a
  trade is skipped when it leans hard against it.
- *Walls*: levels ≥ 4× the median size within 50 bps. Each one's age is
  tracked, the volume traded into it (more than it showed and still there →
  iceberg ❄), and whether it disappeared **without trading** — a pull, the
  spoofing signature. Only walls that have stood 30 s count; a wall that
  halves as price approaches is ignored.

Book checks apply whenever the bot has a book less than 5 s old. **Backtests
and training replay recorded trades only**, so they test the trade-based core
of each setup (tape, footprint, pools); the book and liquidation layers are
judged in paper trading. Training searches the order-flow thresholds
(aggression ×, absorption delta, flip delta, imbalance ratio, stacked rows,
sweep distance and burst, stop buffer, R target, breakeven).

The preset sizes from the balance like Growth: 1.5 % risk, 5× cap, breakeven
at 1R, 20 min time stop, 3 min cool-down after a loss, ≤ 6 trades an hour,
pause after 3 losses, stop for good at −20 %. Entries are market orders, so
every target must clear 3× the round-trip taker cost.

What the evidence says: order-flow and queue imbalance are well documented
as short-horizon predictors; absorption, stacked imbalances and sweeps are
practitioner patterns without published backtests. Treat every setup as a
hypothesis — train it, paper-trade it, and only then go live.

## 5c. Adaptive scalper — the bot that reasons

The **Adaptive scalper** is the terminal's most complete bot. It takes every
trigger the other styles know — responsive fade, initiative breakout, the 80 %
rule, absorption, imbalance continuation, sweep & reclaim — and puts a layer of
judgement around them. Every decision is written to the activity log in plain
words, and the Monitor shows its current reasoning, the market regime, the
one-minute noise, its stop width and patience, and live momentum in a trade.

**Before a trade — is the evidence there?** Each trigger is scored: delta (the
last 5 s for reversals, 20 s otherwise), volume, order-flow and queue
imbalance (live book), the regime (Kaufman efficiency ratio over 15 minutes:
rotating markets favour fades, trending markets favour going with the trend),
location against the POC, and the setup's recent results. Below the
`minScore` bar it passes and says why.

**Where the stop goes.** Beyond the structure *and* beyond the noise: at least
`stopNoiseX` × the median one-minute range, and at least `stopCostX` × the
round-trip fees. The size shrinks to keep the same money at risk. If that stop
would be more than `maxStopNoise` × the noise, or the structure target is then
under the minimum R:R, it passes — "market too quiet for the fees" is a real
answer on a small account.

**In the trade — every second.** Momentum (10 s delta, order-flow imbalance,
15 s price velocity, in the trade's direction) decides:

| Situation | What it does |
|---|---|
| losing, momentum ≤ −`exitMomentum` *and* price moving against it for 5 s | cuts it before the stop ("flow turned") — selling into a long that will not move price is absorption, so it holds |
| no +0.5R within `stallSec` and flat momentum | gets out ("stalled") — scalps that need minutes rarely work |
| in profit from `trailAtR` | trails the stop `trailNoiseX` × the noise behind the best price, only once that locks in ≥ +0.25R after fees — never a reflex breakeven a wick takes out |
| ≥ +1R and momentum turns against | banks it ("momentum faded") |
| at the target with momentum ≥ `extendMomentum` | lets it run one more R at a time, trailing tighter |

**After the trade — learning.** It follows price for `watchSec` after each
stop-out and early exit:

- a stop-out that came back to the entry was noise; two of the last five →
  stops widen by 0.25× the noise (up to 2.5×); a real loss eases them back
- an early exit that went on to the target was impatience; two of the last
  five → 25 % more patience (up to 2×); one that went on to the stop was a save
- a setup that lost 2.5R over its last four trades is benched for `benchMin`

The preset sizes from the balance like Growth (1.5 % risk, 5× cap, pause
after 4 losses, stop for good at −20 %), with the fixed breakeven off.
Training searches the evidence bar, stop width, stall time, cut momentum,
trail distance and the main trigger thresholds; the adaptations above also
run during backtests and training, starting from the trained values.

## 5c½. The trade manager — every style except intraday

The in-trade judgement described above is not only the adaptive scalper's: it
runs on **Scalp, Growth and Order-flow bots** too (Settings → Trade manager,
on by default, and switched on automatically for bots saved before it
existed). Intraday keeps its own session-based management — it is meant to
hold for hours.

Every second it reads momentum in the trade's direction (10 s delta,
order-flow imbalance with a live book, 15 s price speed) and acts:

| The trade… | It… |
|---|---|
| is losing, and flow *and* price have turned against it for 5 s | cuts it early, at a fraction of the stop ("flow turned") |
| was working (≥ +`steamAtR`, 0.5R) and is losing steam — momentum below −`steamMomentum` for 3 s | takes the small win, or scratches it near breakeven, instead of riding it back to the stop ("losing steam") |
| has made no progress within the stall time | closes it ("stalled") |
| is well in profit | trails a noise-width behind the best price — never a reflex breakeven a wick takes out — and banks it when momentum fades |
| reaches its target with momentum behind it | lets it run, one more R at a time |

Stops are placed beyond the structure *and* the one-minute noise, with a
smaller size so the money at risk is the same; after each exit it watches
price and widens stops after noise stop-outs, gives trades more room after
early exits that would have worked, and benches a setup that keeps losing.
The fixed breakeven setting is ignored while the manager is on. Only the
adaptive style also scores the evidence before entering.

## 5c¾. Daily-trend filter — every futures bot

Every style except the spot trend bot (Scalp, Growth, Order-flow,
Adaptive, Intraday) can trade **with the coin's daily trend only** — on by
default, and switched on automatically for bots saved before it existed.

Once a day the bot reads the coin's daily closes on its own futures market
(no spot wallet, nothing to connect) and takes the same three votes as the
trend strategy: is the price above where it was 20, 60 and 120 days ago? When
most say up it takes **longs only** — the order-flow setups then buy dips,
absorption at support and stop runs below; when most say down, **shorts
only**. Only days that have closed count (today's candle never does), so
backtests and training — which fetch the coin's daily candles for the
recorded period — see exactly what the live bot would have seen.

Why: trends persisting over weeks and months is the best-documented effect
in crypto (§5e); intraday trades that fight it are the ones that pay fees and
lose, as in the paper trades that bought into a falling market. The Monitor
shows the current daily trend and the activity log says when it flips.

## 5d. Execution — limit orders to cut costs

**Execution → Limit first (maker fee)** is on in the Growth, Order-flow and
Adaptive presets. On Binance USDⓈ-M futures (regular tier) a limit order that
rests in the book pays the **maker fee, 0.02 %**; a market order pays the
**taker fee, 0.05 %**, plus slippage. A maker entry and a market exit cost
about 0.08 % round trip instead of 0.12 %: a third less on every trade, and
since the bot's filters count costs, it also accepts tighter, better trades.

How it keeps quality:

- **Entry**: a post-only limit on the bot's own side of the book (the best bid
  for a long). It can never cross the spread, so it never pays taker. This is
  used for **responsive** entries — fades, absorption, sweeps, the 80 % rule —
  where price usually trades back to the bid. **Initiative** entries
  (breakouts, continuation) go at market by default, the way order-flow
  traders do it: price rarely comes back for them, and missing a runner costs
  more than the fee saved ("Limits on breakout entries too" changes that).
- **Missed fills are the real risk** of limit entries: you get filled on the
  trades that come back to you and miss the ones that leave at once. So the
  bot does not wait long (`makerWaitSec`, 10 s) and reacts early (`makerChaseR`,
  0.15R): if price leaves, it takes the trade at market **only if, from there,
  it still meets every entry rule** — minimum R:R to the same stop and target,
  target clearing market fees, size. Otherwise it lets the trade go and says
  why. It never chases a second time.
- **Exits**: target, stall and time exits are offered as a post-only limit for
  `exitMakerSec` (6 s), then go at market. **Stops and every protective exit**
  (flow turned, trailing stop, wall pulled, momentum faded, flatten) always go
  at market at once — saving a fee is never worth a worse exit.
- **Live safety**: a resting order is followed every second; a cancel is
  confirmed with the exchange, and a fill that raced the cancel is kept (the
  bot never sends a market order on top of it). A post-only order the exchange
  refuses because it would have crossed is treated as a missed fill. Switching
  the bot off withdraws any resting order.
- **Paper, backtests and training model it the same way**: a resting limit
  fills only when a later trade prints *through* its price (the bot is assumed
  to be at the back of the queue), so results are not flattered by fills that
  would not have happened.

Live bots read the market's maker and taker fees from the exchange (a BNB fee
discount or VIP tier shows up there).

## 5e. Trend (daily, spot) — the evidence-based one

The scalping styles above trade a minutes-long edge that is hard to prove and
easy for fees to erase on a small account. **Trend** is the opposite: the one
crypto strategy with a consistent statistical record — **time-series
momentum** (returns over past weeks and months tend to continue).

- Evidence: time-series momentum across asset classes (Moskowitz, Ooi &
  Pedersen 2012); in crypto, Liu & Tsyvinski ("Risks and Returns of
  Cryptocurrency", 2021) find a strong time-series momentum effect, and later
  work that nets out trading costs finds it holds up while cross-sectional
  (coin-picking) momentum does not.
- Rules (fixed, not fitted): at each daily close three lookbacks — 20, 60 and
  120 days — vote "up" if the price is above where it was that many days ago.
  The coin is held in proportion to the up votes (0, ⅓, ⅔, all), scaled by
  60 % ÷ the 30-day realised volatility, never more than the balance. Trades
  only when the target moves more than 10 % of the balance.
- Market: **spot** (BTC/USDT, ETH/USDT): no leverage, no liquidation, no
  funding. It buys and sells with the USDT in the spot wallet.
- What to expect: a few trades a month, long periods out of the market, losing
  streaks in sideways years, and it gives back part of each trend before it
  steps aside. What it is for: staying in the big trends and out of the big
  crashes — a much smaller worst fall than holding.
- **Backtest on full history** downloads every daily candle since the year you
  pick from the exchange and runs these exact rules (signal at the close,
  trade at the next open, 0.1 % fee each trade) against buy-and-hold, with a
  per-year table. As a sanity check on real BTC prices (CoinGecko daily
  closes) from May 2017 to April 2018 — the 2017 run-up and the 2018 crash —
  the rules at a 40 % volatility target returned +245 % with a worst fall of
  −20 %, against +487 % and −66 % for holding; at 80 % they returned +569 %
  with a −31 % worst fall. One year is not proof: run the full-history
  backtest before trusting it.

## 5f. Telegram: the bot's story — the decision, then the numbers

Telegram gets the bots' **story** by default. Every message leads with the
decision in plain words, then the numbers behind it and the bot's own notes:

```
✅ Entered BTC long at 98,950
Why: sellers drove price below a recent low to grab the stops parked there,
then buyers took it straight back and the selling dried up — the traders who
chased the move are now trapped.
Stop: just beyond the far end of the stop run. From here I read the order
flow every second and get out early if it turns.
Plan: stop 98,800 (−0.15%, risking $0.23 = 0.8% of $30.00) · target 99,250
(+0.30%, 2.0R) · size $148.43 (4.9× the balance)
Bot's notes: swept the swing low 98,900 by 4.0 bps … score 2.5
```

- **Watching** — what it sees and what would make it trade, with the level,
  how far price ran through it, the force behind the run (× normal volume,
  liquidations) and the price now. Stop runs and absorption, the setups that
  have a waiting stage; only in the direction the daily trend allows.
- **Let go** — every announced watch is closed, with the reason in words and
  the measurement that decided it ("Detail: reclaim held 3 of 10 s").
- **Entry** — why, where the stop sits and why there, and the plan: stop,
  target, R, money at risk as a share of the balance, position size. It comes
  with a **chart**: the last hour of one-minute candles with the entry marked,
  the risk (to the stop) and reward (to the target) shaded from the entry on,
  the value area and POC, and the volume profile beside it. The story is the
  photo's caption when it fits Telegram's 1,024 characters; a longer one
  follows the photo as its own message.
- **Safe** — once, when the stop moves past the entry: old → new stop, what
  it locks in, price and R now.
- **Exit** — profit, about breakeven or loss in dollars and R, how long it was
  held, why it closed (target, losing steam, flow turned, stalled, trailing
  stop, stop), entry → exit, fees, the balance after, and the trade manager's
  reasoning at that moment.
- **Stopped** — why, the raw reason, and the run's trades and result.

The same setup in the same direction is announced at most once every 15
minutes. A bot error that needs a look is sent at most once an hour. Chart
alerts and hand-placed orders are no longer forwarded unless "Also forward my
chart alerts and the orders I place by hand" is ticked in the Telegram panel;
daily and weekly reports and the data-feed warning are unchanged.

Stop-outs still happen. The trade manager cuts most losing trades before the
stop when the order flow turns, so the losses that remain are smaller, but no
rule set removes them: a stop is the price at which the reason for the trade
is proven wrong, and it is what keeps one bad trade from becoming a big loss.

## 6. Safety behaviour of live bots

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

## 7. HFT: what is and isn't possible from a laptop

True high-frequency trading means co-located servers, sub-millisecond reaction, maker rebates and queue position. A desktop app talking to an exchange's public API over the internet sees **tens to hundreds of milliseconds** of latency, has to respect API rate limits, and pays **taker fees of roughly 2–10 bps per side**. One example: a round trip at Hyperliquid's base taker fee costs 0.09% of notional ([buildix](https://www.buildix.trade/blog/crypto-scalping-orderflow-realistic-guide)). Racing for single ticks under those conditions has negative expected value. Fees and slippage erase a small edge, and in thin markets book signals are easier to fake ([CoinAPI](https://www.coinapi.io/blog/crypto-scalping-trading-faq-profitability-tools-data-insights), [Block3](https://www.block3finance.com/scalping-in-crypto-techniques-risks-and-reality)).

So the AMT scalper is a **short-horizon order-flow scalper**. It decides on every trade as it arrives (tick by tick), but it holds positions for seconds to minutes and only takes setups whose target clears costs. This is the part of "HFT-style" trading that works from a laptop: fast reading of the auction, disciplined execution, hard risk limits.

### Ways to raise the odds

1. Paper-trade each symbol for days. Compare that with a backtest on the trades the terminal recorded.
2. Start live on a **testnet key**, then on small size.
3. Prefer liquid perpetuals (BTC, ETH, SOL) with low fees. Raise `minRR` on costly venues.
4. Tune `profileMinutes`, `acceptSec` and `deltaThreshold` per symbol. Turn off setups that backtest poorly on a market.
5. Nothing here is financial advice. AMT gives structure, not certainty.
