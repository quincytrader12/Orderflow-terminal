# Meme coins — scanner (step 1)

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

## Next steps

2. **Trading with Phantom**: buy and sell from the token panel (preset SOL
   amounts, slippage, priority fee) through Jupiter. The terminal builds the
   swap, Phantom shows it and signs it; nothing is signed without the wallet's
   own approval. Positions and P&L from the wallet.
3. **Exits**: take-profit ladders (e.g. sell half at 2×, a quarter at 5×) and a
   stop, prompted for approval in Phantom.
4. **Alerts and wallets**: Telegram alerts for coins matching your filters, a
   creator dumping, a coin about to graduate; follow wallets that buy early.
