# The Strategy Lab

The Strategy Lab turns published trading research into strategies you can
test, rank and deploy into the swarms. It is the **STRATEGY LAB** workspace of
the professional terminal (F2, or type `RSCH`, `LIB`, `BT` or `DEPL` on the
command line).

It never promises an edge. It looks for one the way academic finance does, and
says plainly when it finds none.

## The edge finder (FARM) — strategies found for you, all the time

The edge finder is a strategy farm that runs by itself for as long as the
terminal is open. **Every bot is treated as curve-fitted until it proves it is
not.** It starts a minute and a half after the terminal opens (so it never
slows the start), carries on from where it was, and stays stopped once you
press **Stop**.

**Breeding.** Bots are built from the bot builder's own blocks — the Lab's
rules and filters and the Quant desk's models (GARCH filters and stops,
hidden-Markov, Hurst and variance-ratio regimes, the Kalman trend, the
Ornstein–Uhlenbeck rule, VaR and volatility sizing, the bitcoin hedge, the
neural network and the other learned rules) — one to three strategies joined
in any of five ways (all agree, majority, any one, the **regime switch**, or
**setup, then trigger**). Each one is scored on the first 70 % of the history
before the vault (the most recent 15 %, which is locked away — see below)
only. The unseen data is never used to choose.

- **The training score** is the Sharpe ratio on the training years, but half
  of it is the *worse half* of those years (a bot carried by one stretch
  scores low), it is marked down when few of the coins were in profit, and
  every block beyond two costs a little (parsimony). A bot with a learned part
  (an AI strategy or second opinion) is scored on training candles its models
  never saw — the models are fitted on the first 70 % of the training bars and
  the bot is scored on the last 30 % of them — so a model that memorised its
  training data no longer looks like an edge.
- **Selection** is by tournament; children are a crossover (blocks from two
  parents), a **merge** (the strategies of both, joined — how separate edges
  are put together) or a mutation (one block, setting or join changed). New
  random bots arrive every generation.
- **Niches (quality-diversity).** The best bot of every *kind* — pace ×
  families of strategy × sides — is kept in an archive. Parents are drawn from
  it too, no more than two of a kind are carried over, and when the population
  stops improving it starts over from the niches' champions rather than from
  nothing. The search cannot collapse onto one idea.
- **It learns which blocks work.** For every block it counts bots tried, bots
  that trained well enough to face the gauntlet, and survivors, and draws the
  blocks that keep producing more often. Nothing is dropped: what fails alone
  may work in a combination not tried yet. The FARM screen lists what is
  working.
- **Bred from the survivors.** Each generation a few bots are refinements of
  survivors, or two survivors of the same pace merged into one.

**The gauntlet.** A bot that trains well (a score of 0.7 or more, enough
trades) and is not a copy of a kind already held or ruled out then faces, in
order:

1. **The unseen 30 %** — it must make money there, with a Sharpe of 0.5 or
   more and at least half its training Sharpe.
2. **Steady** — not one lucky stretch, coin or trade: in profit in at least
   two of the three thirds of the unseen stretch, on at least half its coins,
   and still in profit with its best 5 % of trades taken away.
3. **Double costs** — tested again on the unseen data with twice the fees and
   slippage: it must still make money.
4. **100 random bots** — the same number of trades, held as long, entered at
   random: it must beat at least 75.
5. **Its settings nudged** — every setting one step each way (each strategy's
   look-backs and thresholds, the stop, the hold, the profit target): at least
   half of those versions must still make money on the unseen data.
6. **1,000 shuffles** — its trades in 1,000 random orders at 1 % risk a trade:
   the unlucky 1-in-20 drawdown must stay within the limit (20 % by default).
7. **The vault** — the most recent 15 % of each timeframe's history is cut off
   *before* anything is bred, trained or checked (one cut in time for every
   coin), so no choice the farm makes can lean on it. A bot that passes the
   six checks above is tested on it once. If it has 5 or more trades there and
   lost money, or fell half as far again as it ever did on the unseen 30 %, it
   is out. The vault moves forward as candles arrive. Because of it a survivor
   has a fresh-data record the moment it is found, rather than weeks later.
8. **Significant after every kind tried** — the more ideas are tried, the
   better the luckiest looks, so the bar rises with every *kind* of bot (pace,
   strategies, filters) that reaches the unseen data. Survivors' one-sided
   p-values (Newey–West t on the unseen returns) go through the
   Benjamini–Hochberg procedure against that count at a false-discovery rate
   of 10 %: of those called significant, at most about 1 in 10 should be
   flukes. Each survivor shows its *fluke odds* (the q-value). Those that miss
   the bar are **candidates**: listed, and tested on fresh data all the same.

**One survivor of a kind.** Variations of one idea — another stop, another
look-back — are one idea. The first bot of a kind to survive holds the kind's
place; a later bot of that kind that trains well is counted as a copy and is
not put through the gauntlet again, and a kind that lost in the vault or faded
on fresh data is ruled out for good (one look each). In a day-long run of the
earlier version about 29,000 bots passed every check, nearly all of them
copies of a few ideas: the copies took most of the work, replaced one another
in the lists every second or two, and — each counted as a separate test —
pushed the significance bar out of reach. Counting kinds fixes all three.
(A save from before kinds were counted is taken to have tried as many kinds as
it had gauntlet entrants, 2,000 at most; its copies are reduced to one a kind.)

**The overfit meter.** The farm measures how overfit its own search is: the
probability of backtest overfitting (Bailey, Borwein, López de Prado & Zhu
2017) by combinatorially symmetric cross-validation. The training years are
cut into eight stretches; for every way of calling four of them "in sample",
the bot that did best there is looked up on the other four, and PBO is how
often it lands in the bottom half. Only the latest bots that made money in
training are compared (a bot that loses to its costs loses everywhere, and
that sameness would hide the overfitting). In the Lab's tests it reads
50–85 % on markets with no edge and under 5 % on markets with a real trend.

**The team.** Survivors that make money at different times smooth each other
out. From each of the strongest survivors in turn the farm builds a team,
adding one at a time whichever other survivor lifts the portfolio's Sharpe
most (by at least 3 %), never two of the same family, never two whose daily
results correlate at 0.7 or more, never one that lost on the days compared;
the best team found is shown. Members are weighted by inverse volatility
(equal risk). It reports the team's Sharpe, worst drop and a year's return
against the best member alone, and the average correlation, on the days of
the unseen stretch every member has (45 at least). The team is chosen on the
stretch its numbers are read on, so they flatter it; the forward test is the
judge. **Deploy the team** deploys each member — after you confirm.

**Fresh data.** A survivor's fresh-data record starts with the vault and
carries on into the candles that arrive after it was found (the history is
refreshed every half hour, every quarter of an hour for 15-minute paces). The
ladder: **new** (no candles yet), **incubating** (fewer than 5 trades),
**proving** (5–14, in profit), **proven** (15 or more, in profit) — or
**faded** (losing over 10 or more trades, or falling half as far again as it
ever did in testing): dropped, and its kind ruled out.

**A top five for each pace.** Scalping, intraday, swing and position are bred
side by side, each in its own population of forty (they take turns, one bot at
a time), and each has its own top five: proven on fresh data first, then
proving, then the rest; significant ahead of not; then by score. Up to forty
standing survivors are kept at each pace. Each row shows its evidence (proven,
proving, significant or candidate), its return a year, Sharpe, worst drop and
months up on the unseen 30 %, its fresh-data result, its fluke odds and its
place on the ladder; open one for its rules in words, its curve and every
check with its numbers, then **Open in the bot builder** or **Deploy to the
crypto swarm**, choosing who decides its trades. Deploying is always yours to
do.

**Steady lists.** The boards are worked out every 20 seconds — at once when
fresh candles arrive, a stage or a significance changes, or a pace has fewer
than five to show — not at every bot, and a listed strategy keeps its place
unless a newcomer is further up the ladder or 15 % better on the score. The
team is worked out once a minute. The strategy on show stays on show until
another is clicked.

**It heals itself.** The farm is meant to run for days unattended.

- *Data.* Every exchange is tried for each coin (the Lab's chosen one first),
  each download with a 90-second limit and one quick second try. If none
  answers, the candles on disk are used and the market is marked stale; a coin
  is never dropped from a running farm. While anything is stale or missing it
  tries again after 1, 2, 5 and 10 minutes and then every 15, for as long as
  it takes, and the DATA tile says what it is doing; when the exchange is back
  the fresh candles reach the farm and the tile clears. Nothing needs doing.
- *The engine.* If its thread dies, or says nothing for five minutes, it is
  started again from what was last saved (after 15 seconds, a minute, then
  every five minutes). Stopping it by hand cancels a pending restart.

**The live fleet.** Every strategy deployed to the swarm is watched on the
candles since it was deployed: watching (too few trades), healthy, slipping
(well short of its test) or fading (losing) — with a top-five strategy at the
same pace offered as its replacement.

**Settings**: the coins (up to 8), the paces bred (any of the bot builder's
styles — each needs its candles), long and short or long only, the speed
(*gentle*, about half of one processor core, the default; or *full*) and
the shuffle drawdown limit. `FARM` is in the Strategy Lab and on the Quant
desk; the Research screen shows it at a glance.

What it cannot do: a bot that survived every check on history can still stop
working — markets change. The fresh-data ladder and the fleet watch are there
because of that, and the checks lower the odds of a lucky bot, they do not
make them zero.

## The screens

| Code | Screen | What it does |
|---|---|---|
| `LIB` | Library | Every rule and filter, the papers behind it, and why it should work |
| `RSCH` | Research | Downloads history, tests the library, mixes rules, ranks the top five, deploys |
| `BT` | Backtest builder | Build a strategy by hand from the library and test it |
| `DEPL` | Deployed | The strategies trading in the swarms, on/off, and what they have said |
| `GV` | GARCH volatility | Each coin's fitted GARCH model: the hours ahead as a heat calendar, long run, value at risk |
| `FCST` | Candle forecast | The next candle's expected high, low and odds of closing up, with its out-of-sample record |

## The bot builder (BOT) — the easy way

**BOT** is a workflow canvas, like n8n: eight blocks wired in order. Click a
block and its options open in the inspector on the right, all in plain
English (tick **Explain** to see what each one does). A block can hold
**several picks**:

1. **Trading style** — scalping or intraday on **15-minute candles**, scalping
   (hours) or intraday on 1-hour candles, swing (a few days), one-week
   trades, position (weeks to months) or a long-term hold (up to a year). The
   style sets everything else's pace: the candles (15 min, 1 h, 4 h or 1 day), the
   look-backs, the holding time, the stop width and the years of history.
2. **Strategies** — every entry rule in the library (trend following,
   breakouts, buy the dip / sell the rip, timing, funding, AI — the neural
   network included). Pick one or several; several are joined: **all must
   agree**, **majority vote**, **any one** (unless another disagrees), the
   **regime switch** (Wilder's ADX with hysteresis — trending once it rises
   through 25, ranging once it falls through 20: trend, momentum and breakout
   rules are read only while the market trends, reversion rules only while
   it ranges, the rest always) or **setup, then trigger** (the first pick
   sets the direction; the others must confirm it within a quarter of the
   style's look-back, 2 to 24 candles).
3. **Market models** — when it may trade: the big trend, ADX trend or range,
   the variance-ratio, Hurst and hidden-Markov regimes, GARCH volatility, calm
   or busy days, volume, trading hours, crowded funding. Every filter picked
   must allow the trade.
4. **Forecasts & AI** — second opinions that must agree (the Kalman trend, the
   neural network, the random forest, the linear forecast, the next-candle
   forecast), and an **AI decision maker** that learns from the bot's own past
   trades which signals to skip: the decision forest, the neural network, or
   **both paired** (their odds averaged). It is kept only if it passes a check
   **inside the training years**: fitted on the earlier training trades, it must
   lift the Sharpe ratio on the last 30 % of them. The unseen data is never
   used to choose it — choosing there would flatter the very result the test
   reports. Where a network is picked (strategy, second opinion or decision
   maker) its **size** (small 8→4, medium 16→8, large 32→16) and, for a
   strategy or second opinion, **how far ahead it looks** can be set.
5. **Risk management** — steady risk (volatility targeting), a cap on the daily
   loss (value at risk), **half Kelly** (found from the bot's training-years
   trades), GARCH stops, a bitcoin hedge (CAPM beta); two sizing rules combine
   (the smaller size wins). The stop width, and how the money is **split across
   coins**: equally, more on calmer coins, minimum variance, or the efficient
   frontier's best return for the risk (fitted on the training years).
6. **Rules of engagement** — long and short, long only or short only; let
   winners run or take profit at 1.5, 2 or 3 times the risk; shorter, usual or
   longer holds; exit on an opposite signal or not.
7. **Backtest** — built on the first 70 % of the history and judged on the last
   30 % it never saw, with fees and slippage.
8. **Deploy** — only after the backtest, with a choice of who decides its trades
   in the swarm (below).

**The compatibility check.** Every pick is read against the others as it is
made: **✕ clash** (they work against each other — a trend rule only allowed in
a range, a breakout only in calm, two opposite filters), **≈ overlap** (they say
the same thing — two trend rules, three "calm" filters, a second opinion from
the same model) or **+ pairs well** (a trend rule and a dip rule with "all must
agree" = buy the dips in an uptrend; the neural network and the forest paired;
steady risk capped by value at risk). Each option in the inspector is tagged
with what adding it would do, and the blocks carry a badge.

**Measured on the data.** The backtest then measures the parts on the unseen
30 %: each strategy alone against them together, how two strategies relate
(correlation, how often they agree when both are on), what each filter adds
(Sharpe with and without it, and how often it lets the bot trade), each AI
decision maker (forest, network, both — only your pick can be kept), the Kelly
fraction found and the coin split. The results: a verdict (Looks good / Maybe /
Not yet), the return a year against buy-and-hold, the worst drop, the win rate,
the trades, the Sharpe ratio, the chance it is luck and of a losing run, the
equity curve and each coin.

## 15-minute candles and the intraday rules

The Lab runs on 15-minute candles as well as 1-hour, 4-hour and daily ones: in
the research run (`15 minutes`, a year of history at most — 35,000 candles a
coin), in two bot builder styles (**scalping** and **intraday** on 15-minute
candles) and live, where a deployed strategy reads its own timeframe from the
exchange and is looked at every minute. Rules timed by the clock (the evening
hours, end-of-day momentum, the Monday rule) fire on the candle that closes at
the hour, whatever the candle size.

Four rules trade the day's own structure (the "day" starts at 00:00 UTC, or
with the US session at 13:00):

| Rule | Family | Papers | What it does |
|---|---|---|---|
| VWAP trend | trend | Aziz & Zarattini (2023); Zarattini, Aziz & Barbon (2024) | long while price is above the day's volume-weighted average price, short while below |
| Opening range breakout | breakout | Zarattini & Aziz (2023); Zarattini, Barbon & Aziz (2024); Crabel (1990) | the first hour or two set a range; trade the first close beyond it for the rest of the day |
| Intraday momentum beyond the noise | momentum | Zarattini, Aziz & Barbon (2024) | trade a move from the day's open bigger than the average move by that time of day over the last 14 days |
| Fade a stretched candle | reversion | Kitron & Wengrowicz (2026, preprint); Wen et al. (2022) | after one candle of more than k ATR (on heavy volume), trade against it for an hour |
| Volatility squeeze breakout | breakout | Bollinger (2001); Crabel (1990); Bollerslev (1986) |
| ATR trend line (Supertrend) | trend | Wilder (1978); Faith (2007); Hudson & Urquhart (2021) |
| Relative strength against bitcoin | relative | Liu, Tsyvinski & Wu (2022); Dobrynskaya (2023); Fieberg et al. (2025) |

The first three were published on US index funds and stocks by authors with a
trading business; the fourth is a crypto preprint whose own finding is that the
edge (about 1.3 basis points a trade) is smaller than the fees. They are in the
library because they are what intraday traders actually use — and the Lab's
test, with fees and slippage counted, is what decides. At 15 minutes costs take
a large share of every trade: the diagnosis under each test says how large.

## The optimizer: what a test shows, and what to try

Under every bot test (and every research result) the Lab now reads the result
back:

- **What the test shows**, in words — from how the trades went on the
  *training* years: what ended them (stop, target, trailing stop, time, an
  opposite signal) and what each ending made, longs against shorts, winners'
  and losers' holding times, each coin, the trades a month, and the share of
  the profit that fees and slippage took.
- **Month by month** (week by week on short histories) on the unseen data:
  each period's return, the share that made money, the worst one. A yearly
  figure made by two good months is not a monthly income, and this shows it.
- **Try changes.** `Find improvements` makes every sensible one-step change to
  the bot — a wider or tighter stop, each exit, long only, each market filter
  added or removed, a second opinion, volatility sizing, each strategy's
  settings one step up and down the values its paper used, another pace on the
  same candles, a losing coin left out — and measures each one **inside the
  training years**: models are fitted on the first 70 % of them and every
  version is scored on the last 30 %. The unseen data is not read. Changes are
  ranked by the goal chosen — more return for the risk, steadier (more winning
  weeks, a milder worst week), or smaller drawdowns — and marked when they
  also beat the bot on the earlier training years.
- **Apply & test** makes one change and tests the new bot on the unseen data.
  Every version tested there is counted, and the "chance the result is real"
  is deflated for the number tried (Bailey & López de Prado 2014): the tenth
  version of a bot to look good is worth much less than the first.

What it cannot do is promise a return every month. It can show how regular a
bot has been and rank changes by regularity; markets decide the rest.

**Deploy** is in the bot builder's header and beside the verdict as soon as a
test is back — the test is the same one the backtester runs, so nothing else
is needed first.

## From the Quant desk into a bot ("Use in a bot")

Every Quant desk function has a **⇢ Use in a bot** button. It sends the model
on screen — with the settings it is being studied with — into the bot builder,
as the kind of pick it is:

| From | Becomes |
|---|---|
| `NNET` | the bot's **strategy** (replacing or joining the others), a **second opinion**, or the **decision maker** (alone or paired with the forest) — with the panel's network size, horizon, candles and coin |
| `GV` | a calm or stormy **volatility filter**, **GARCH stops**, or volatility-scaled momentum |
| `VAR` · `VTGT` · `KELLY` | a **sizing rule**: a value-at-risk cap, volatility targeting at the panel's target, half Kelly |
| `DHG` · `CAPM` | the **bitcoin hedge**; CAPM also offers the bitcoin market-trend filter |
| `EF` | the **split across coins**: efficient frontier, minimum variance, inverse volatility |
| `MOM` · `REGM` · `FCST` | momentum / Kalman rules; Hurst, variance-ratio and hidden-Markov **filters**; the OU rule; the next-candle forecast |
| `PAIR` | a **hedged pairs trade** on the coin, window and threshold on screen |
| `SEAS` | the hour picked on the map as a **strategy**; weekday, weekend and session **filters** |

The bot builder opens, says what arrived, and shows the settings beside the
pick (a "reset" returns it to the style's defaults). The bot is then tested
like any other: the Lab fits the model **on the training years only** — the
same network, the same size and horizon, but not the weights trained on the
desk, which have seen the period the test must keep unseen. `MC` goes the
other way: it resamples the unseen-data trades of the last bot tested.

## Deployed strategies and the crypto swarm

A deployed strategy reads its rules on each coin's closed candles of its own
timeframe inside the crypto swarm. When it signals, it puts the trade to the
swarm. Each deployed strategy has a switch (in the bot builder's Deploy block,
DEPL, and the swarm view's deploy gate):

- **Council decides** — the council (trend, tape, crowd) votes and the forest
  can veto; a no means no trade.
- **Trade as tested** — the strategy's statistics were measured on years of
  data the council was never part of, so the council's votes are kept as
  advice on the record, never binding.

Either way **Guardian** (wide spreads, volatility spikes) and **Risk** (the
daily-loss and drawdown limits, the size of every trade) can stop any trade, a
strategy can only ask for a smaller size, and the strategy's own exits manage
the trade. Each strategy keeps a record: its signals, the trades taken and
their R, the signals the council blocked — followed to their exits anyway, so
it says whether the council saved or cost it money — and the signals missed
because the swarm already held the coin.

## The library

Thirty-six entry rules and thirteen filters, each written from its paper:

| Rule | Family | Papers |
|---|---|---|
| Time-series momentum | momentum | Moskowitz, Ooi & Pedersen (2012); Liu & Tsyvinski (2021); Kakushadze & Serur (2018) |
| Moving-average crossover | trend | Brock, Lakonishok & LeBaron (1992); Kakushadze & Serur; Grobys, Ahmed & Sapkota (2020); Corbet et al. (2019) |
| Three moving averages | trend | Kakushadze & Serur (2018) |
| Price-to-moving-average ratio | trend | Detzel, Liu, Strauss, Zhou & Zhu (2021) |
| Channel breakout | breakout | Brock et al. (1992); Faith (2007); Kakushadze & Serur; Hudson & Urquhart (2021) |
| Support and resistance (pivot points) | breakout | Kakushadze & Serur (2018) |
| Mean reversion (z-score) | reversion | Kakushadze & Serur; Jegadeesh (1990); Lo & MacKinlay (1990) |
| RSI extremes | reversion | Connors & Alvarez (2009); Wilder (1978) |
| Bollinger band breakout | breakout | Bollinger (2001); Hudson & Urquhart (2021) |
| MACD trend | trend | Appel (2005); Hudson & Urquhart (2021) |
| Intraday time-series momentum | momentum | Shen, Urquhart & Wang (2022); Wen, Bouri, Xu & Zhao (2022) |
| Monday effect | seasonal | Caporale & Plastun (2019); Baur, Cahill, Godfrey & Liu (2019) |
| Weekly reversal | reversion | Dobrynskaya (2023); Jegadeesh (1990) |
| Funding carry | carry | He, Manela, Ross & von Wachter (2022); Christin, Routledge, Soska & Zetlin-Jones (2023) |
| Volume-confirmed move | volume | Llorente, Michaely, Saar & Wang (2002); Blume, Easley & O'Hara (1994) |
| Linear forecast (ridge regression) | ml | Gu, Kelly & Xiu (2020); Kakushadze & Serur (2018), the bitcoin ANN |
| Random-forest direction | ml | Breiman (2001); Gu, Kelly & Xiu (2020) |
| Volatility-scaled momentum (GARCH) | momentum | Moskowitz, Ooi & Pedersen (2012); Bollerslev (1986); Liu & Tsyvinski (2021) |
| Next-candle forecast | ml | Nison (1991); Marshall, Young & Rose (2006); Lu, Shiu & Liu (2012); Breiman (2001) |
| Kalman-filter trend | trend | Kalman (1960); Harvey (1990) |
| Ornstein–Uhlenbeck reversion | reversion | Uhlenbeck & Ornstein (1930); Avellaneda & Lee (2010); Bertram (2010) |

Crypto-specific rules (added from the crypto literature):

| Rule | Family | Papers | What it does |
|---|---|---|---|
| Volume-weighted momentum | momentum | Huang et al. (2024); Moskowitz et al. (2012); Llorente et al. (2002) | the trend with each candle weighted by its volume |
| Trend composite (17 indicators) | trend | Fieberg, Liedtke, Poddig, Walker & Zaremba (2025, JFQA); Hudson & Urquhart (2021) | RSI, stochastic, CCI, seven moving averages, MACD, volume trends, money flow and Bollinger bands vote; the published factor weights them by machine learning across 3,000 coins, here each has one vote on one coin |
| New high / new low | breakout | Padyšák & Vojtko (2022) | buys a close at a new 10-day high (trend) and at a new 10-day low (bounce); never shorts |
| Big-day follow-through | momentum | Li, Urquhart, Wang & Zhang (2021); Caporale & Plastun (2019) | trades with a 1-day move beyond k standard deviations — the published edge could not be told from luck after costs, so the Lab's test decides |
| Late-evening hours | seasonal | Padyšák & Vojtko (2022); Baur et al. (2019) | long 21:00–23:00 UTC; the pattern weakened after 2021 |
| Pairs: the coin against bitcoin | relative | Gatev, Goetzmann & Rouwenhorst (2006); Fil & Kristoufek (2020); Avellaneda & Lee (2010) | rolling regression of the coin on bitcoin; buys the coin when it is k standard deviations cheap, sells when rich, only while the fit explains half the moves. With the bitcoin hedge it is the true pairs trade |
| Bitcoin leads, the coin catches up | relative | Guo, Sang, Tu & Wang (2024); Liu, Tsyvinski & Wu (2022) | when bitcoin has moved and the coin has not done its beta's share, trade the coin in bitcoin's direction |

The last two read bitcoin's price beside the coin's: BTC joins the coins
tested (it is not traded by them), and the crypto swarm gives a deployed
strategy bitcoin's candles live. Two more filters: **bitcoin's market trend**
(Liu, Tsyvinski & Wu 2022; Faber 2007 — longs only while bitcoin is above its
long average) and **weekdays or weekends** (Kinateder & Papavassiliou 2021;
Aharon & Qadan 2019 — lower risk and volume at weekends).

Rules with a holding time of their own (the two evening hours, a day for the
Monday effect, the new high/low and the big-day rule) are never held longer
than that by the bot builder's style.

Filters: long-term trend (Faber 2007), volatility regime (Moreira & Muir 2017;
Barroso & Santa-Clara 2015), trend strength ADX (Wilder 1978), participation
(Blume, Easley & O'Hara 1994), trading session (Baur et al. 2019; Wen et al.
2022), funding crowding (He et al. 2022; Christin et al. 2023), GARCH
volatility regime (Bollerslev 1986; Moreira & Muir 2017; Hansen & Lunde 2005),
variance-ratio regime (Lo & MacKinlay 1988; Hurst 1951), hidden-Markov regime
(Hamilton 1989; Ang & Timmermann 2012).

Exits: a stop in ATR **or in GARCH forecast volatility** (σ for the next bar,
known at the bar's close: the stop widens before a storm, not after), an
optional target in R, a trailing stop from +1R, a time limit, and whether an
opposite signal closes the trade. A third of the mixed strategies try a GARCH
stop; the builder has a **GARCH STOP (σ)** box.

## Sizing and hedging

Every strategy can also choose how big to be and whether to hedge:

- **Unit size** — a fixed position, as before.
- **Volatility target** — the position runs at an annual volatility (30, 60 or
  100 %) on the GARCH forecast, capped at 3× notional and rebalanced when the
  weight drifts a quarter (Moreira & Muir 2017; Harvey et al. 2018).
- **VaR budget** — the position carries the same 1-day 99 % value at risk (3,
  6 or 10 % of capital) from the GARCH forecast and its fitted tails.
- **Delta hedge against bitcoin** — short β × the position in BTC, β
  re-estimated on 30 days of returns, so what is left is the coin's own move
  (needs BTC among the coins).

Rebalancing and the hedge leg pay the same fees and slippage. In the crypto
swarm the tested sizing carries over: the risk manager scales a Lab trade by
the long-run GARCH σ over today's (0.5–1.5×). The swarm does not place the
bitcoin hedge leg; its message says so, with the size, so you can place it
with `TKT`.

## How the engine chooses ingredients

The mixing step is an adaptive search (the cross-entropy method). Each
ingredient — each filter, ATR or GARCH stop, the sizing, the hedge — starts
with even odds; after every batch of 40 mixes the odds move toward what the
best quarter used, in sample. The rule is drawn evenly from the seeds:
learned rules score flatteringly on the data they were fitted to, and chasing
that would chase overfitting. **What it learned** on the Research screen shows,
for every ingredient, how often it was tried, the in-sample score of the mixes
with and without it, the final odds, and — among the finalists, on data the
search never saw — the out-of-sample Sharpe with and without it.

New inputs for every learned rule and the meta-labeller: the Kalman slope's t,
the Ornstein–Uhlenbeck s-score, the variance ratio, the hidden-Markov odds of
turbulence and Yang–Zhang volatility against GARCH's.

## GARCH

Volatility clusters: calm follows calm and storms follow storms (Engle 1982;
Bollerslev 1986), and in crypto the clustering is strong and the tails are fat
(Katsiampa 2017). The Lab fits four models to each coin's in-sample returns —
GARCH(1,1) and GJR-GARCH (Glosten, Jagannathan & Runkle 1993: falls move
volatility more than rises), each with normal or Student-t errors — by maximum
likelihood, and keeps the one with the lowest BIC. GARCH(1,1) is hard to beat
(Hansen & Lunde 2005), so the Lab goes no further.

From the fit it reads:

- **σ for the next bar**, known at each bar's close — an input to every learned
  rule and the meta-labeller (with σ against its long-run level), the scale of
  volatility-scaled momentum, the GARCH stop and the GARCH regime filter;
- **the forecast path**: σ reverts to its long-run level at the speed of the
  persistence (α + β + γ/2), with a half-life in hours;
- **value at risk** over any horizon, from the fitted error distribution;
- **the hour-of-day pattern** (Andersen & Bollerslev 1997), shown as a heat
  calendar on `GV` and on the Research screen.

It is tested, not assumed: out of sample, GARCH's one-step forecasts are scored
against an exponentially weighted average (RiskMetrics, λ = 0.94) and a rolling
one with the QLIKE loss (Patton 2011) and a Diebold–Mariano t.

**GARCH worlds.** The eight leading strategies face one more test. For each
coin the Lab keeps the real history up to the split and simulates the rest from
the coin's own GARCH model driven by its own standardised shocks (filtered
historical simulation, Barone-Adesi, Giannopoulos & Vosper 1999), borrowing
candle shapes and volume from the bars those shocks came from. These worlds
have the coin's volatility clusters and fat tails but no edge. The strategy
runs unchanged in 19 of them; if it beat its real out-of-sample Sharpe in more
than 10 % of them, volatility alone could explain the result and the check
fails.

## Candle forecasting

A candle's **size** is forecastable — volatility clusters — while its
**colour** mostly is not. The Lab treats both honestly. For each coin it
describes every candle by its shape (body, upper and lower wick, where it
closed in its range, range and gap in ATR, run of same-coloured candles, and
the engulfing, doji and hammer/shooting-star patterns of Nison 1991; Caginalp &
Laurent 1998; Lu, Shiu & Liu 2012), adds GARCH σ and the usual momentum and
volume inputs, and trains in sample:

- a **random forest** for the odds that the next candle closes up;
- two **ridge regressions** for the next candle's high and low, as distances
  from its open.

Out of sample it reports the hit rate against always calling the commoner
side, the **Brier skill** of the odds (above zero: they carry information), and
the error of the range forecast against GARCH alone and against the last
candle's range, with **permutation importance** for each input. The
next-candle forest is also a rule in the library (“Next-candle forecast”),
tested like any other; Marshall, Young & Rose (2006) found candlestick patterns
alone had no value, which is why the Lab tests rather than trusts them. The
candle features are inputs to the ridge and forest rules and the meta-labeller.

The **Forecasting** tab on the Research screen shows all of it per coin, and
`FCST` shows the live forecast of the next candle for the board's coin.

From *151 Trading Strategies* (Kakushadze & Serur, SSRN 3247865) the Lab takes
the strategies that apply to a single crypto market: the moving-average,
three-average, channel, support-and-resistance and mean-reversion rules, and a
linear stand-in for its bitcoin neural network. Its cross-sectional stock
strategies, options, fixed income, real estate and the rest need data a crypto
perpetual does not have.

## How a research run works

1. **History.** Years of candles for the chosen coins (Binance spot first for
   the longest history, then OKX, Bybit, Hyperliquid), cached on disk so the
   next run only fetches what is new; funding history when it can find it.
2. **Split.** The first 70 % of each coin's history trains and selects (in
   sample). The last 30 % is never looked at until the end (out of sample).
3. **The library as published.** Every rule over its parameter grid, in
   sample, on all coins at once with the same rules — a rule that works on
   one coin only is likely luck. **Library comparison** on the Research screen
   shows each paper's best version in and out of sample, side by side.
4. **Mix and match.** The strongest rules are combined with other papers'
   filters and different exits: hundreds of new strategies, still in sample.
5. **The finalists meet unseen data.** The best two dozen (no more than four
   of any one rule, to keep the list varied) run out of sample and face:
   - **Sharpe ratio** out of sample (after fees, slippage and funding)
   - **Newey–West t-statistic** of the mean return (honest when returns are
     autocorrelated)
   - **Deflated Sharpe ratio**: the chance the Sharpe beats the best that
     luck alone would give when choosing among the finalists over this many
     bars (Bailey & López de Prado 2014)
   - **Random-entry Monte Carlo**: the same trades, held as long, on the same
     sides, entered at random times, 500 times — the p-value is how often
     luck did as well
   - **Trade Monte Carlo**: 2,000 shuffles of the trade sequence at 1 % risk
     per trade — the spread of outcomes, the chance of a loss, the drawdowns
   - **Regression on buy-and-hold**: alpha (and its t) and beta — is it more
     than the market's drift?
   - **Random-forest meta-labelling** (López de Prado 2018): a forest learns,
     in sample, which of the strategy's signals tend to fail. Whether it is
     kept is decided inside the training data: fitted on the trades of the
     first 70 % of the training bars, it must lift the Sharpe ratio on the last
     30 % of them. The out-of-sample numbers are read afterwards and decide
     nothing (deciding there would bias them upward)
   - **Probability of backtest overfitting** for the group (Bailey, Borwein,
     López de Prado & Zhu 2017)
   - **GARCH worlds** (the leading eight): does it beat simulated markets with
     the coin's own volatility but no edge? (see GARCH above)
6. **The top five**, each with a verdict:
   - **EDGE** — passes all but one of its tests, including the Sharpe and the
     deflated Sharpe
   - **PROMISING** — out-of-sample Sharpe above 0.5, t above 1.5, deflated
     Sharpe above 50 %
   - **NO EDGE** — everything else, said plainly

On pure noise the Lab finds lucky strategies with out-of-sample Sharpe ratios
above 2. The deflated Sharpe and the random-entry test are what stop those
being called an edge; the tests check this.

## Deploying

- **Deploy → Crypto swarm** puts a strategy into the crypto swarm as the
  **Lab** agent. On each closed candle of its own timeframe it reads its signal
  on every coin it was researched on. A new signal is proposed to the council
  like any other agent's: the other agents vote, the risk manager sizes it
  (1 % of the account, compounding), and the trade follows the exits it was
  tested with (stop, target, trail, time limit, opposite signal). Its messages
  carry the tested Sharpe, t and verdict.
- It only **proposes**: the council, the forest, the guardian and the risk
  manager decide, and any of them can veto. Its tested sizing can only make a
  trade smaller, never bigger. The swarm's Command Center has a **deploy gate**
  (the **Lab · deploy** gauge) to deploy, pause and remove strategies.
- **DEPL** lists what is deployed; switch each on or off, or remove it.

## Honest limits

- Past performance in any backtest, however carefully tested, does not
  guarantee future results. Markets change; edges decay once published.
- Out-of-sample tests on one history are one draw; more coins, more years and
  another timeframe make the verdict firmer.
- The backtester fills at the next bar's open plus slippage and checks the stop
  before the target inside a bar. Real fills in fast markets can be worse.
- A hand-built test (BT) is one trial: its probabilistic Sharpe is not deflated
  for the other strategies you tried. The Research screen corrects for that.
