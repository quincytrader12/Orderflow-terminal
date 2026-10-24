// The bot's story in plain English, for Telegram: what it is watching and
// why, when it takes a trade, when the trade is safe, and how and why it
// ended. No prices, ratios or jargon — the activity log keeps those.
//
// A watched setup that never becomes a trade gets one line saying why it was
// let go, so every "watching" message is closed. To keep the phone quiet, the
// same setup in the same direction is announced at most once per quiet period
// (15 minutes); its let-go line only follows a watch that was announced.

const MIN = 60_000;

export function coinName(symbol = '') {
  return String(symbol).replace(/[:/].*$/, '').replace(/(USDT|USDC|USD|BUSD)$/, '') || String(symbol);
}

const levelWords = (kind) =>
  ({
    'swing high': 'a recent high',
    'swing low': 'a recent low',
    'prior high': "the previous session's high",
    'prior low': "the previous session's low",
    'round number': 'a round-number price',
  })[kind] ?? 'a key level';

/** Where an absorption level sits, in words. */
function absorbWords(level = '') {
  if (/wall/.test(level)) return /bid/.test(level) ? 'a large buy order sitting in the book' : 'a large sell order sitting in the book';
  if (/prior VAL/.test(level)) return "the bottom of the previous session's fair-value area";
  if (/prior VAH/.test(level)) return "the top of the previous session's fair-value area";
  if (/VAL/.test(level)) return "the bottom of today's fair-value area";
  if (/VAH/.test(level)) return "the top of today's fair-value area";
  return 'a key level';
}

const sideWord = (side) => (side === 'buy' ? 'long' : 'short');
const buyers = (dir) => (dir > 0 ? 'buyers' : 'sellers');
const sellers = (dir) => (dir > 0 ? 'sellers' : 'buyers');

/** Why the bot liked the trade, in words, by setup. */
export function setupWords(setup, side, extra = {}) {
  const d = side === 'buy' ? 1 : -1;
  const up = d > 0;
  switch (setup) {
    case 'sweep':
      return `${sellers(d)} drove price ${up ? 'below' : 'above'} ${extra.level ? levelWords(extra.level) : 'a key level'} to grab the stops parked there, then ${buyers(d)} took it straight back and the ${up ? 'selling' : 'buying'} dried up — the traders who chased the move are now trapped`;
    case 'absorption':
      return `${sellers(d)} kept hitting ${extra.level ? absorbWords(extra.level) : 'a key level'} but could not push price any ${up ? 'lower' : 'higher'}, and now ${buyers(d)} have taken over`;
    case 'continuation':
      return `${buyers(d)} are clearly in control — price is being ${up ? 'bought' : 'sold'} aggressively level after level and the move is holding`;
    case 'fade':
      return `price reached the ${up ? 'bottom' : 'top'} of today's fair-value area and was rejected there — it usually rotates back toward the middle`;
    case 'breakout':
      return `price broke ${up ? 'above' : 'below'} today's fair-value area with real ${up ? 'buying' : 'selling'} behind it, and it is being accepted out there`;
    case 'ibBreakout':
      return `price broke ${up ? 'above' : 'below'} the opening range with real ${up ? 'buying' : 'selling'} behind it`;
    case 'priorAccept':
      return `price moved into the previous session's fair-value area and is being accepted there`;
    case 'priorReject':
      return `price tested the edge of the previous session's fair-value area and was turned away`;
    case 'reentry':
      return `a break out of value failed and price fell back inside — it usually travels to the other side of value`;
    default:
      return 'the order flow lined up behind the move';
  }
}

function stopWords(setup) {
  if (setup === 'sweep') return 'just beyond the far end of the stop run';
  if (setup === 'absorption') return 'just beyond the level that was being defended';
  return 'outside the normal back-and-forth, so ordinary wiggles will not knock me out';
}

/** Plain-English reason a candidate was let go (from the engine's skip text). */
export function passWords(reason = '') {
  const r = String(reason);
  if (/breakout, not a sweep/.test(r)) return 'price kept pushing through the level — that is a real breakout, not a stop run, so I am not fighting it';
  if (/reclaim held/.test(r)) return 'price never settled back on the other side of the level';
  if (/liquidated|cascade/.test(r)) return 'traders were still being forced out of their positions — the move was not finished';
  if (/still pushing/.test(r)) return 'the other side kept pushing — the move had not run out of fuel';
  if (/has not turned|delta/.test(r)) return 'the other side never took control';
  if (/imbalance|queue/.test(r)) return 'the order book did not back it up';
  if (/pulled/.test(r)) return 'the big order it depended on was pulled — it was not real';
  if (/daily trend/.test(r)) return 'it would go against the bigger daily trend';
  if (/not enough agreement/.test(r)) return 'the overall order flow did not agree strongly enough';
  if (/benched/.test(r)) return 'this setup has lost a few times in a row here, so it is resting for a while';
  if (/too quiet/.test(r)) return 'the market is too quiet — the fees would eat most of the profit';
  if (/too far for a scalp/.test(r)) return 'a safe stop would have to sit too far away for a quick trade';
  if (/exchange minimum/.test(r)) return 'the smallest order the exchange accepts is too big for this balance with a stop that safe';
  if (/no chasing/.test(r)) return 'my order did not fill at a good price, and I do not chase';
  if (/R:R|not worth it|fees|costs/.test(r)) return 'the profit on offer was not worth the risk once fees are counted';
  if (/rising market|falling market|accepted (higher|lower)|continuation is more likely/.test(r)) return 'the market is trending that way, so the move is more likely to continue than reverse';
  if (/lost .* min ago/.test(r)) return 'the last trade like this lost, so I am sitting the next few out';
  return 'the conditions I wanted did not all line up';
}

/** How a trade ended, in words. */
export function exitWords(reason = '', profit) {
  const r = String(reason);
  if (/^target/.test(r)) return 'it reached the profit target I set';
  if (/^trail/.test(r)) return profit ? 'it eased back from its best and hit my trailing stop, which had already locked in profit' : 'it turned and hit my trailing stop';
  if (/^breakeven/.test(r)) return 'it came back to my breakeven stop';
  if (/^stop/.test(r)) return 'price went through the level that should have held, so the safety stop closed it — the loss was the small, planned amount';
  if (/flow turned/.test(r)) return 'the order flow turned against it, so I cut it early instead of waiting for the stop';
  if (/losing steam/.test(r)) return 'the move was running out of steam, so I took what it had given instead of letting it slip back';
  if (/stalled/.test(r)) return 'it went nowhere for too long — quick trades that stall usually fail, so I stepped aside';
  if (/momentum faded/.test(r)) return 'the push behind it faded, so I banked it';
  if (/^time/.test(r)) return 'it ran out of time without reaching the target';
  if (/wall pulled/.test(r)) return 'the big order it was leaning on was pulled, so the reason for the trade was gone';
  if (/session close/.test(r)) return 'the session was closing';
  if (/kill switch|stopped/.test(r)) return 'the bot was stopped';
  return 'the reason for the trade had played out';
}

/** Why a bot stopped, in words. */
export function stoppedWords(reason = '') {
  const r = String(reason);
  if (/daily loss limit/.test(r)) return 'it reached today’s loss limit, so it is resting until tomorrow to protect the account';
  if (/drawdown limit/.test(r)) return 'it reached its safety limit for losses from the peak — please look over its trades before starting it again';
  if (/kill switch/.test(r)) return 'you stopped it with the kill switch';
  if (/by you/.test(r)) return /flatten/.test(r) ? 'you stopped it and closed its position' : 'you stopped it';
  if (/app closed/.test(r)) return 'the terminal was closed';
  if (/deleted/.test(r)) return 'it was deleted';
  if (/insufficient|margin|balance/i.test(r)) return 'the exchange turned down an order because there was not enough margin — check the futures wallet balance';
  if (/order|exchange|failed|rejected/i.test(r)) return 'the exchange turned down an order it could not work around — the bot’s log in the terminal has the details';
  return 'it was stopped';
}

export class Narrator {
  constructor({ symbol, mode = 'paper', quietMin = 15 } = {}) {
    this.coin = coinName(symbol);
    this.paper = mode === 'paper';
    this.quietMs = quietMin * MIN;
    this.sweepObj = null;
    this.absorbObj = null;
    this.watching = null; // { setup, dir, t, announced, level }
    this.lastAnnounced = new Map(); // `${setup}|${dir}` → t
    this.lockSent = false;
  }

  tag() {
    return this.paper ? ' (paper)' : '';
  }

  /** Daily-trend permission for a direction (watching what it may not take is noise). */
  allowed(e, dir, t) {
    if (!e.cfg?.trendFilter || e.cfg.style === 'trend') return true;
    const h = e.dailyTrend?.(t);
    return !h || h.dir === dir || h.dir === 0;
  }

  /** Start watching; returns a line when it is worth announcing. */
  watch(setup, dir, t, text, level) {
    const key = `${setup}|${dir}`;
    const last = this.lastAnnounced.get(key);
    const announced = last === undefined || t - last >= this.quietMs;
    this.watching = { setup, dir, t, announced, level };
    if (!announced) return null;
    this.lastAnnounced.set(key, t);
    return { kind: 'watch', text };
  }

  /** The watched setup ended without a trade. */
  pass(why) {
    const w = this.watching;
    this.watching = null;
    if (!w?.announced) return null;
    return { kind: 'pass', text: `✋ Let the ${this.coin} ${w.dir > 0 ? 'long' : 'short'} go${this.tag()} — ${why}.` };
  }

  /**
   * After each engine step: new watches, watches that ended, and the moment an
   * open trade becomes safe. Returns plain-English lines.
   */
  step(e, t) {
    const out = [];
    const push = (l) => l && out.push(l);
    const of = e.of;
    const skip = e.lastSkip && e.lastSkip !== this.seenSkip && t - e.lastSkip.t < 5000 ? e.lastSkip : null;
    if (e.lastSkip) this.seenSkip = e.lastSkip;
    // a watched setup turned down at the last check (gate, daily trend, evidence, fees)
    if (skip && this.watching && skip.event.startsWith(this.watching.setup === 'absorption' ? 'absorb' : this.watching.setup)) push(this.pass(passWords(skip.reason)));
    // a trade on its way in: the entry line closes the watch, not a "let go"
    const entering = Boolean(e.pos) || e.pending?.kind === 'entry';
    if (of) {
      // 1. a stop run: wait for the reclaim
      const s = of.sweep;
      if (s && s !== this.sweepObj && !entering) {
        this.sweepObj = s;
        const dir = -s.dir;
        if (this.allowed(e, dir, t))
          push(
            this.watch(
              'sweep',
              dir,
              t,
              `👀 Watching ${this.coin} for a ${sideWord(dir > 0 ? 'buy' : 'sell')}${this.tag()}. Price just ran ${s.dir > 0 ? 'above' : 'below'} ${levelWords(s.level?.kind)} and knocked out the stops parked there. If it ${s.dir > 0 ? 'falls back under' : 'climbs back over'} that level, stays there, and the ${s.dir > 0 ? 'buying' : 'selling'} dries up, I'll ${dir > 0 ? 'buy' : 'sell'} — the traders who chased it would be trapped.`,
              s.level?.kind,
            ),
          );
      } else if (!s && this.sweepObj) {
        const gone = this.sweepObj;
        this.sweepObj = null;
        if (this.watching?.setup === 'sweep' && !entering) push(this.pass(passWords(skip?.event === 'sweep' ? skip.reason : gone.why)));
      }
      // 2. aggression soaked up at a level: wait for the other side to take over
      const a = of.absorb;
      if (a && a !== this.absorbObj && !entering) {
        this.absorbObj = a;
        if (this.allowed(e, a.dir, t))
          push(
            this.watch(
              'absorption',
              a.dir,
              t,
              `👀 Watching ${this.coin} for a ${sideWord(a.dir > 0 ? 'buy' : 'sell')}${this.tag()}. ${a.dir > 0 ? 'Sellers' : 'Buyers'} are hitting ${absorbWords(a.level)} hard, but price is not ${a.dir > 0 ? 'dropping' : 'rising'} — someone is soaking it all up. If ${a.dir > 0 ? 'buyers' : 'sellers'} take over from here, I'll ${a.dir > 0 ? 'buy' : 'sell'}.`,
              a.level,
            ),
          );
      } else if (!a && this.absorbObj) {
        const gone = this.absorbObj;
        this.absorbObj = null;
        if (this.watching?.setup === 'absorption' && !entering) {
          const broke = gone.dir > 0 ? e.last < gone.extreme : e.last > gone.extreme;
          push(this.pass(skip?.event === 'absorption' ? passWords(skip.reason) : broke ? 'price broke through the level after all — the defence failed' : `the ${gone.dir > 0 ? 'buyers' : 'sellers'} never took over`));
        }
      }
    }
    // the trade is safe: the stop has moved past the entry
    const pos = e.pos;
    if (pos && !this.lockSent) {
      const dir = pos.side === 'buy' ? 1 : -1;
      if ((pos.stop - pos.entry) * dir >= 0) {
        this.lockSent = true;
        out.push({ kind: 'manage', text: `🔒 The ${this.coin} ${sideWord(pos.side)} is working${this.tag()}. I've moved the stop past my entry, so it should not turn into a loss now. Still watching the order flow every second.` });
      }
    }
    return out;
  }

  entry(intent) {
    this.lockSent = false;
    const w = this.watching;
    this.watching = null;
    const extra = { level: w?.setup === intent.setup ? w.level : undefined };
    return {
      kind: 'entry',
      text: `✅ ${intent.side === 'buy' ? 'Bought' : 'Sold'} ${this.coin} — went ${sideWord(intent.side)}${this.tag()}. Why: ${setupWords(intent.setup, intent.side, extra)}. My safety stop is ${stopWords(intent.setup)}. From here I watch the order flow every second and get out early if it turns.`,
    };
  }

  /** trade: the engine's closed trade record. */
  exit(trade, reason) {
    this.lockSent = false;
    const R = trade.risk > 0 && trade.qty > 0 ? trade.pnl / (trade.risk * trade.qty) : trade.pnl > 0 ? 1 : trade.pnl < 0 ? -1 : 0;
    const outcome = R >= 0.15 ? 'profit' : R > -0.15 ? 'even' : 'loss';
    const head = outcome === 'profit' ? `💰 Closed the ${this.coin} ${sideWord(trade.side)} in profit` : outcome === 'even' ? `➖ Closed the ${this.coin} ${sideWord(trade.side)} at about breakeven` : `🔻 Closed the ${this.coin} ${sideWord(trade.side)} at a ${R > -0.8 ? 'small ' : ''}loss`;
    return { kind: 'exit', outcome, text: `${head}${this.tag()} — ${exitWords(reason ?? trade.reason, outcome === 'profit')}.` };
  }
}
