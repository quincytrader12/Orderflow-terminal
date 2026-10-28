# Meme coins — scanner and swarm

Two panels under **Meme** in the add-panel menu:

- **Meme Scanner** — every Solana meme coin the terminal can see, live.
  - **Pulse** (like Axiom's): three columns — **New** (on the pump.fun curve),
    **Final stretch** (70 %+ of the curve sold, close to graduating) and
    **Migrated** (graduated to a pool, or listed on DexScreener).
  - **Runners**: everything in one table, hottest first.
  - Filters: minimum heat, hide coins with a ⛔ flag, and **room**: your target
    market cap ÷ the coin's market cap now (5×, 10×, 100×, 1000×). Room is
    *your* target, not a prediction.
- **Meme Token** — one coin: market cap, age, bonding curve and how far it is
  from graduating, on-chain safety, buy/sell flow over 1 and 5 minutes, the
  creator's activity, a market-cap chart with a bubble per trade, and the live
  trade tape. Pick a coin in the scanner or paste a mint address.

## Where the data comes from

| Source | What | Key |
|---|---|---|
| PumpPortal (`wss://pumpportal.fun/api/data`) | every pump.fun launch, migration, and the trades of the coins being followed (one socket, as PumpPortal asks; at most 80 coins followed at once, quiet ones dropped) | none |
| DexScreener API | boosted and newly profiled Solana coins every 30 s; pool price, market cap, liquidity, volume, buys/sells, change; SOL in USD | none |
| Solana RPC | mint and freeze authority, holder concentration (bonding curve and pool vaults left out) | public RPC by default; a Helius/QuickNode URL from the key vault is faster |

The desktop app makes the RPC calls from the main process with a fixed list of
read-only methods; an RPC URL holding an API key never reaches the window.

## Reading a coin

**Heat (0–100)** is what early runners share:

- On the curve: net SOL bought in 5 min, distinct buying wallets, buys versus
  sells in the last minute, how fast the curve is filling, how spread out the
  buying is.
- On a pool: volume against its hourly pace, the share of buys, 5 min and 1 h
  change, trade count, liquidity against market cap, socials.

Heat drops when the coin goes quiet, when one wallet is most of the buying,
when wallets churn in and out (bots, wash trading), and sharply when the
creator sells.

**Flags**:
- ⛔ danger: the creator dumped the launch bag, mint or freeze authority still
  live, the top 10 wallets hold over 50 %, or liquidity under $5k.
- ⚠ warning: the creator sold part of the bag, a creator buy of 3+ SOL at
  launch, one wallet holding 15 %+, the top 10 holding over 30 %, or
  concentrated or churning buyers.

**Tags**: Early runner (heat 60+, under 20 min old, no ⛔), Fresh, Graduating,
Volume surge, Boosted (paid DexScreener promotion).

**pump.fun maths**: launch ≈ 28 SOL market cap, graduation ≈ 411 SOL — about
14.7× along the curve. "× to graduate" is how much the market cap still has to
grow before the coin leaves the curve.

None of this predicts a 10× or a 1000×. Most new coins go to zero; the scanner
finds the ones with real buying and rules out the obvious rugs, so the time
goes on the few worth a look.

## The swarm

**Meme Swarm** (Meme category) runs five bots over everything the scanner sees,
every two seconds, whether or not its panel is open (switch it on in the panel;
it remembers):

| Bot | Job | How |
|---|---|---|
| **Scout** | finds every new coin | the scanner's feeds: pump.fun launches and migrations, DexScreener listings |
| **Sentinel** | viability — rejects the rugs | rejects: live mint or freeze authority; top 10 wallets over 50 %; the creator buying 20 %+ at launch or selling half the bag; 4+ wallets taking 10 %+ of supply within 3 s of launch (bundled or sniped); most buyers also selling (wash trading); 3 minutes without a trade; pool liquidity under $5k; a creator whose earlier coin rugged. Penalises: top 10 over 30 %, one wallet over 15 %, a big creator bag, partial creator sells, concentrated buying, serial launchers. Waits for the on-chain check before passing anything. |
| **Herald** | virality — is it catching on | new buyers per minute and whether they are arriving faster; the meme's narrative (how many coins share its name this hour, and whether this one leads them); linked X / Telegram / website; DexScreener profile or paid boosts; total wallets in |
| **Strategist** | picks the entries | Sentinel pass, viability 60+, heat 55+, virality 40+, under 45 min old, market cap under $250k, 12–85 % of the curve sold (not the bundle seconds, not the graduation top); pools need $20k liquidity. Conviction = 40 % heat + 35 % virality + 25 % viability. All adjustable under Rules. |
| **Manager** | runs the trades | 0.1 SOL a trade, at most 4 open, 0.5 SOL daily loss limit. Exits: rug (creator dumps, danger flag, trading stops) → stop loss −35 % → take profits (half at 2×, half the rest at 5×) → trailing 40 % from the peak once up 1.5× → out after 20 min without a new high under 1.3×. Multiples are the price against the price paid. |

Trades are **on paper**: fills priced exactly on the bonding curve (1.25 % fee
and price impact) or against the pool with an impact estimate, so paper
results are not flattered. Live execution through Phantom is the next step.

**Results** follows every pick for an hour — and, as a control, a sample of
coins that passed the Sentinel but were not picked — and reports, by
conviction, how often each reached 2×, 5×, 10×, graduated, or ended the hour
dead (a fifth of the entry market cap or less). If picks do not beat the
control row, the rules are not adding anything yet.

### What the rules are built on

- Under 1 % of pump.fun coins graduate (0.6–0.9 % through 2025), and about
  four in five stop trading on day one ([Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex), [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/), [Bitbase](https://www.bitbase.com/news/pump-fun-memecoin-trader-fatigue-token-survival)).
- Dev-linked wallets buy in the launch block of about one coin in five (median ~10 % of supply); bundles took far more profit than snipers ([Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)).
- High-risk launches: fewer buyers buying more each, concentrated holdings, bundled early accounts ([MemeTrans / MELT](https://arxiv.org/html/2602.13480v1)).
- Rugs are visible within minutes as idle gaps between trades, and on pools as liquidity pulled ([Catching the Rug](https://arxiv.org/html/2608.20271v1)).
- Wash trading: one address buying and selling against the same curve ([Meme Coin Factories](https://arxiv.org/html/2609.10246v1)); about a quarter of coins launch off a social post.
- Filtering on "safe" launches alone still lost money in one backtest of 1,411 launches ([Arrow Algo](https://arrowalgo.com/solana-memecoin-trading/)) — which is why the swarm measures its own results instead of trusting its rules.

## Next steps

2. **Trading with Phantom** (for the swarm's picks and by hand): buy and sell from the token panel (preset SOL
   amounts, slippage, priority fee) through Jupiter. The terminal builds the
   swap, Phantom shows it and signs it; nothing is signed without the wallet's
   own approval. Positions and P&L from the wallet.
3. **Exits**: take-profit ladders (e.g. sell half at 2×, a quarter at 5×) and a
   stop, prompted for approval in Phantom.
4. **Alerts and wallets**: Telegram alerts for coins matching your filters, a
   creator dumping, a coin about to graduate; follow wallets that buy early.
