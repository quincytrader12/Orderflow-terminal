// The crypto swarm: a team of agents trading crypto perpetuals on Hyperliquid,
// beside (and independent of) the meme swarm. It has its own account (the
// Hyperliquid wallet), its own paper book, its own record and its own forest.
//
// Per coin there is one market feed (trades, book, liquidations, funding),
// shared by every agent on it:
//   Scalper     an AMT engine in the adaptive (order-flow) style
//   Auctioneer  an AMT engine in the intraday (value area, IB) style
//   Trend       hourly breakouts in the daily trend's direction (agents.mjs)
// Each proposal goes to the council (brain.mjs) with the Tape, Crowd, Guardian,
// Forest and Risk votes. One position per coin, a few at most in all, sized by
// the compounding risk manager (risk.mjs). The engine that proposed a trade
// manages it (break-even, trails, its own judgement); the Trend agent manages
// its own. Every decision is logged in plain words, and the three moments of a
// trade — the setup, how it is being managed, the result — are sent to the
// app to draw and send to Telegram.
//
// Trades the council turned down are followed anyway (the shadow book), so the
// forest learns from paper, live and refused trades alike.
import { randomUUID } from 'node:crypto';
import { AmtEngine, INTRADAY_PRESET } from '../amt/engine.mjs';
import { AGENT_NAME, CCOUNCIL_DEFAULTS, councilR, dirOf, features, MARK, oddsR, PROPOSERS, rClass, trainForest } from './brain.mjs';
import { newBook, recordClose, RISK_DEFAULTS, riskGate, shiftBook, sizeTrade, updateBook } from './risk.mjs';
import { atrOf, dailyTrendOf, manageTrend, Shadow, TREND_AGENT_DEFAULTS, trendCandidate } from './agents.mjs';
import { entryStyle, MicroWatch, microVote } from './micro.mjs';
import { liveDirection, liveMarket, liveSignal, manageLab, specNeeds } from '../../src/lab/live.ts';
import { alignFunding, spliceCandles } from '../lab/lab.mjs';

/**
 * How many candles a deployed strategy is kept warm on: at least 3,000, and at least eight days
 * of them — many rules look back a week (a week of 1-minute candles is 10,080), so a
 * 1-minute strategy on 3,000 candles would never be warmed up and never fire. A strategy that
 * learns from the feature table (which reads a 30-day volatility) gets 32 days. At most 12,000.
 */
export const labBarsFor = (tfH, features = false) => Math.min(12_000, Math.max(3000, Math.ceil(((features ? 32 : 8) * 24) / tfH)));

const MIN = 60_000;
const HOUR = 3_600_000;

export const CSWARM_DEFAULTS = {
  exchangeId: 'hyperliquid',
  coins: ['BTC', 'ETH', 'SOL'],
  agents: { auction: true, trend: true, lab: true },
  /** the paper account starts with this (USDC) */
  paperStartUsd: 30,
  /** taker fee and slippage per side, bps (Hyperliquid base tier: 4.5 bps taker) */
  feeBps: 4.5,
  slippageBps: 2,
  /** the fee for an order that rests in the book and is filled there (Hyperliquid base tier: 1.5 bps maker) */
  makerFeeBps: 1.5,
  /**
   * Smarter entries: rest at the best bid (or offer) for a maker fill, timed by the order book;
   * not filled within waitMs, the price is taken if it has moved no more than chaseBps — further,
   * the entry is skipped (chasing would cost more than the edge). Exits are never delayed.
   * holdSec: when the Microstructure agent says the timing is bad (a liquidation cascade against the
   * trade, a burst of selling into a long, a book leaning against it), the entry waits up to this
   * long for it to clear — for every trade, a strategy deployed "as tested" included (0 = off).
   */
  entry: { maker: true, waitMs: 5000, chaseBps: 5, holdSec: 30 },
  risk: { ...RISK_DEFAULTS },
  council: { ...CCOUNCIL_DEFAULTS },
};

export function mergeCfg(p = {}) {
  const c = { ...CSWARM_DEFAULTS, ...(p ?? {}) };
  c.agents = { ...CSWARM_DEFAULTS.agents, ...(p?.agents ?? {}) };
  // the Scalper agent is retired: deployed Lab strategies do that job, under the council
  delete c.agents.scalper;
  c.risk = { ...RISK_DEFAULTS, ...(p?.risk ?? {}) };
  c.council = { ...CCOUNCIL_DEFAULTS, ...(p?.council ?? {}) };
  c.entry = { ...CSWARM_DEFAULTS.entry, ...(p?.entry ?? {}) };
  c.coins = Array.isArray(p?.coins) && p.coins.length ? p.coins.map((x) => String(x).toUpperCase().trim()).filter(Boolean).slice(0, 8) : CSWARM_DEFAULTS.coins;
  return c;
}

/** a fee charged in dollars (or a dollar coin) can be added up with the rest */
const isUsdish = (c) => !c || /^(USD|USDC|USDT)$/i.test(String(c));
export const symbolFor = (coin, exchangeId = 'hyperliquid') => (exchangeId === 'hyperliquid' ? `${coin}/USDC:USDC` : `${coin}/USDT:USDT`);
const tidy = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
/** an entry not taken on purpose (the price ran away while waiting at the bid): said, not an error */
const skipped = (why) => Object.assign(new Error(why), { skip: true });
const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

export class CryptoSwarm {
  /**
   * @param o.ccxt CcxtService (subscribe, unsubscribe, ohlcv, placeOrder, cancelOrder, marketInfo, accountBalance, prepareMargin, positionContracts)
   * @param o.db { get(key), set(key, value) }
   * @param o.emit (channel, payload) => void — 'state' and 'event' to the app
   */
  constructor({ ccxt, db, emit = () => {}, now = Date.now, log = () => {}, labDeployed = () => [], onClosed = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.ccxt = ccxt;
    /** waiting for a resting entry to fill (tests pass their own) */
    this.sleep = sleep;
    /** each closed position, for the trade journal */
    this.onClosed = onClosed;
    /** the Strategy Lab's strategies deployed into this swarm */
    this.labDeployed = labDeployed;
    this.db = db;
    this.emitFn = emit;
    this.now = now;
    this.logFn = log;
    this.cfg = mergeCfg(db.get('cswarm:cfg'));
    const m = db.get('cswarm:mode') ?? {};
    this.mode = m.mode === 'live' ? 'live' : 'paper';
    this.secretId = m.secretId ?? null;
    this.paper = db.get('cswarm:paper') ?? { cash: this.cfg.paperStartUsd, book: newBook(this.cfg.paperStartUsd, now()) };
    this.liveBook = db.get('cswarm:liveBook') ?? null;
    this.positions = db.get('cswarm:positions') ?? [];
    this.samples = db.get('cswarm:samples') ?? [];
    /** per deployed Lab strategy: signals, trades taken, signals blocked (and what they would have made), signals refused because the coin was taken */
    this.labBook = db.get('cswarm:labBook') ?? {};
    this.lines = [];
    this.running = false;
    this.coins = new Map();
    this.forest = null;
    this.trainedN = 0;
    this.shadow = new Shadow();
    this.liveEquity = NaN;
    this.sandbox = false;
    this.lastSaid = new Map();
    this.lastState = 0;
    /** paused for new trades (open trades are still managed), kept across restarts */
    this.holding = !!db.get('cswarm:hold');
    // anything left open from before a restart is managed by the swarm itself
    for (const p of this.positions) if (!p.closedAt) p.owner = 'swarm';
  }

  // ---------- the books ----------

  book() {
    return this.mode === 'live' ? this.liveBook ?? newBook(this.liveEquity > 0 ? this.liveEquity : 0, this.now()) : this.paper.book;
  }
  setBook(b) {
    if (this.mode === 'live') this.liveBook = b;
    else this.paper.book = b;
  }
  open(mode = this.mode) {
    return this.positions.filter((p) => !p.closedAt && p.mode === mode);
  }
  openOn(coin) {
    return this.open().find((p) => p.coin === coin) ?? null;
  }
  upnl(p) {
    const px = this.coins.get(p.coin)?.price;
    return Number.isFinite(px) ? (px - p.entry) * p.qty * dirOf(p.side) : 0;
  }
  equity() {
    if (this.mode === 'live') return this.liveEquity;
    return this.paper.cash + this.open('paper').reduce((a, p) => a + this.upnl(p), 0);
  }

  // ---------- control ----------

  /** pause (or resume) new trades; open trades are managed either way */
  hold(on) {
    this.holding = !!on;
    this.db.set('cswarm:hold', this.holding);
    this.say('swarm', on ? 'Paused for new trades — open trades are still managed to their stops and targets.' : 'Resumed — new trades allowed again.', on ? 'warn' : 'info');
    this.pushState(true);
    return this.holding;
  }

  setConfig(patch) {
    if (this.running) throw new Error('stop the crypto swarm before changing its settings');
    this.cfg = mergeCfg({ ...this.cfg, ...patch, agents: { ...this.cfg.agents, ...(patch?.agents ?? {}) }, risk: { ...this.cfg.risk, ...(patch?.risk ?? {}) }, council: { ...this.cfg.council, ...(patch?.council ?? {}) }, entry: { ...this.cfg.entry, ...(patch?.entry ?? {}) } });
    this.db.set('cswarm:cfg', this.cfg);
    this.pushState(true);
    return this.cfg;
  }

  setMode(mode, secretId = null) {
    if (this.running) throw new Error('stop the crypto swarm before switching between paper and live');
    this.mode = mode === 'live' ? 'live' : 'paper';
    this.secretId = this.mode === 'live' ? secretId : this.secretId;
    if (this.mode === 'live' && !this.secretId) throw new Error('choose your Hyperliquid key for live trading');
    this.db.set('cswarm:mode', { mode: this.mode, secretId: this.secretId });
    this.pushState(true);
  }

  resetPaper() {
    if (this.running && this.mode === 'paper') throw new Error('stop the crypto swarm first');
    this.paper = { cash: this.cfg.paperStartUsd, book: newBook(this.cfg.paperStartUsd, this.now()) };
    this.positions = this.positions.filter((p) => p.mode !== 'paper');
    this.persist();
    this.say('risk', `paper account reset to ${usd(this.cfg.paperStartUsd)} — the forest keeps what it learned`);
  }

  async start() {
    if (this.running) return true;
    const c = this.cfg;
    if (this.mode === 'live') {
      if (!this.secretId) throw new Error('choose your Hyperliquid key for live trading');
      const info = await this.ccxt.marketInfo(this.secretId, symbolFor(c.coins[0], c.exchangeId));
      if (!info.trading) throw new Error('Trading is off for this key — tick “Allow trading” on it under 🔌 Connect');
      if (!info.contract) throw new Error('the crypto swarm trades perpetual futures — choose a Hyperliquid key');
      this.sandbox = Boolean(info.sandbox);
      await this.refreshEquity();
      if (!(this.liveEquity > 0)) throw new Error('no USDC on the Hyperliquid account yet — deposit first (at least 5 USDC)');
      if (!this.liveBook || !(this.liveBook.start > 0)) this.liveBook = newBook(this.liveEquity, this.now());
      for (const coin of c.coins) {
        const notes = await this.ccxt.prepareMargin(this.secretId, symbolFor(coin, c.exchangeId), c.risk.perCoinLeverage).catch((e) => [String(e?.message ?? e)]);
        for (const n of notes) this.say('risk', `${coin}: ${n}`, 'warn');
      }
    } else this.sandbox = false;
    this.running = true;
    this.startedAt = this.now();
    for (const coin of c.coins) this.setupCoin(coin);
    this.timer = setInterval(() => this.tick(), 1000);
    this.slowTimer = setInterval(() => void this.slow(), MIN);
    void this.slow();
    void this.retrain(true);
    const agents = PROPOSERS.filter((a) => c.agents[a]).map((a) => AGENT_NAME[a]).join(', ');
    this.say('swarm', `${this.mode === 'live' ? `LIVE${this.sandbox ? ' (testnet)' : ''}` : 'Paper'} — ${c.coins.join(', ')} on ${c.exchangeId}; ${agents} propose, the council decides. Account ${usd(this.equity())}.`);
    this.pushState(true);
    return true;
  }

  async stop({ flatten = false } = {}) {
    if (!this.running) return false;
    if (flatten) for (const p of this.open()) await this.close(p, 'stopped by you', this.coins.get(p.coin)?.price);
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.slowTimer);
    for (const cs of this.coins.values()) this.ccxt.unsubscribe(cs.sid);
    this.coins.clear();
    const left = this.open().length;
    this.say('swarm', `Stopped${left ? ` — ${left} position${left > 1 ? 's' : ''} left open${this.mode === 'live' ? ' with the exchange stop in place' : ''}; the swarm manages ${left > 1 ? 'them' : 'it'} again when started` : ''}.`);
    this.persist();
    this.pushState(true);
    return true;
  }

  setupCoin(coin) {
    const c = this.cfg;
    const cs = { coin, symbol: symbolFor(coin, c.exchangeId), sid: `cswarm-${coin}`, price: NaN, funding: null, daily: null, dailyAt: 0, hourly: [], hourlyAt: 0, lastBar: 0, lab: {}, labLast: {}, engines: {}, busy: false, feed: 'connecting', feedError: null, micro: new MicroWatch() };
    const eq = this.equity() > 0 ? this.equity() : c.paperStartUsd;
    for (const agent of ['auction']) {
      if (!c.agents[agent]) continue;
      const e = new AmtEngine({ ...INTRADAY_PRESET, orderMode: 'taker', sizing: 'balance', accountUsd: eq, feeBps: c.feeBps, slippageBps: c.slippageBps, minNotionalUsd: 0, maxLeverage: c.risk.perCoinLeverage, dailyLossPct: 100, maxDrawdownPct: 100, lossStreak: 0, trendFilter: true });
      e.liveBalance = eq;
      cs.engines[agent] = e;
    }
    this.coins.set(coin, cs);
    this.ccxt.subscribe(cs.sid, c.exchangeId, cs.symbol, (m) => this.onMessage(coin, m), { sandbox: this.sandbox, liquidations: true });
  }

  // ---------- market data ----------

  onMessage(coin, m) {
    const cs = this.coins.get(coin);
    if (!cs || !this.running) return;
    if (m.kind === 'status') {
      cs.feed = m.state;
      cs.feedError = m.error ?? null;
      if (m.state === 'error') this.sayOnce(`feed:${coin}`, 'guardian', `${coin} market data: ${m.error}`, 'warn', 5 * MIN);
      return;
    }
    if (m.kind === 'stats') {
      if (Number.isFinite(m.stats?.fundingRate)) cs.funding = m.stats.fundingRate;
      return;
    }
    // the Microstructure agent's own view of the last seconds
    if (m.kind === 'book') cs.micro.onBook(m.bids, m.asks, cs.micro.lastT || this.now());
    else if (m.kind === 'liquidations') cs.micro.onLiquidations(m.items);
    else if (m.kind === 'trades') for (const t of m.trades) cs.micro.onTrade(t);
    for (const [agent, e] of Object.entries(cs.engines)) {
      if (m.kind === 'book') e.onBook(m.bids, m.asks);
      else if (m.kind === 'liquidations') e.onLiquidations(m.items);
      else if (m.kind === 'trades') {
        for (const t of m.trades) this.handle(coin, agent, e.onTrade(t));
      }
    }
    if (m.kind === 'trades' && m.trades.length) {
      const t = m.trades[m.trades.length - 1];
      cs.price = t.p;
      this.onPrice(coin, t.p, t.t);
    }
  }

  /** Every price: the shadow book, the Trend agent's management, decisions on engine-managed trades. */
  onPrice(coin, p, t) {
    for (const s of this.shadow.onPrice(coin, p, t)) {
      this.learn(s.x, s.r, 'shadow', s.agent);
      if (s.labId)
        this.labNote(s.labId, (b) => {
          b.shadowN++;
          b.shadowR += s.r;
        });
    }
    const pos = this.openOn(coin);
    if (!pos || pos.closing) return;
    const cs = this.coins.get(coin);
    const lab = pos.agent === 'lab' ? this.labDeployed().find((d) => d.id === pos.labId) ?? null : null;
    if (lab) {
      // the Lab's trade follows the exits it was tested with
      const r = manageLab(pos, lab.spec, lab.tfH, p, t);
      if (r?.note) this.decision(pos, r.note);
      if (r?.exit) void this.close(pos, r.exit, p);
    } else if (pos.owner === 'swarm') {
      const r = manageTrend(pos, p, t, { ...TREND_AGENT_DEFAULTS, maxHoldH: pos.agent === 'trend' ? TREND_AGENT_DEFAULTS.maxHoldH : 12 });
      if (r?.note) this.decision(pos, r.note);
      if (r?.exit) void this.close(pos, r.exit, p);
    } else {
      const e = cs?.engines[pos.agent];
      const ep = e?.pos;
      if (ep && Math.abs(ep.stop - pos.stop) > pos.risk * 0.05) {
        const why = ep.trailed && !pos.trailed ? `trailing the stop to the session's point of control (${tidy(ep.stop)})` : ep.be && !pos.be ? `stop to break-even plus costs (${tidy(ep.stop)}): this trade can no longer lose` : `stop moved to ${tidy(ep.stop)}`;
        pos.stop = ep.stop;
        pos.be = Boolean(ep.be);
        pos.trailed = Boolean(ep.trailed);
        this.decision(pos, why);
      }
    }
    // no decision yet, but halfway to the target: say why it is held
    const dir = dirOf(pos.side);
    const prog = ((p - pos.entry) * dir) / Math.abs(pos.target - pos.entry);
    if (!pos.notified?.manage && prog >= 0.5) this.decision(pos, `halfway to the target (${tidy(pos.target)}), up ${(((p - pos.entry) * dir) / pos.risk).toFixed(1)}R — holding: the reason for the trade still stands, stop at ${tidy(pos.stop)}`);
    if (this.mode === 'live') void this.syncStop(pos);
  }

  /** A management decision on an open trade: logged, and the first one goes to the phone. */
  decision(pos, text) {
    pos.mgmt = [...(pos.mgmt ?? []), { t: this.now(), text }].slice(-12);
    this.say(pos.agent, `${pos.coin}: ${text}`);
    if (!pos.notified?.manage) {
      pos.notified = { ...pos.notified, manage: true };
      this.notify('manage', pos);
    }
    this.persist();
  }

  tick() {
    if (!this.running) return;
    const now = this.now();
    for (const [coin, cs] of this.coins) for (const [agent, e] of Object.entries(cs.engines)) this.handle(coin, agent, e.tick(now));
    if (now - this.lastState >= 1000) this.pushState();
  }

  /** Every minute: candles, the Trend agent, the account, the books, learning. */
  /**
   * The once-a-minute look at candles and deployed strategies. Only one runs at
   * a time: a first run that is still downloading history when the next minute
   * comes is joined, not doubled.
   */
  slow() {
    if (this.slowRun) return this.slowRun;
    this.slowRun = this.slowOnce().finally(() => {
      this.slowRun = null;
    });
    return this.slowRun;
  }

  async slowOnce() {
    if (!this.running) return;
    const now = this.now();
    const c = this.cfg;
    for (const cs of this.coins.values()) {
      try {
        if (now - cs.dailyAt >= 6 * HOUR) {
          const rows = await this.ccxt.ohlcv(c.exchangeId, cs.symbol, '1d', 200);
          const closed = rows.filter((r) => r.time + 24 * HOUR <= now);
          cs.daily = dailyTrendOf(closed);
          for (const e of Object.values(cs.engines)) e.setDaily(rows);
          cs.dailyAt = now;
        }
        if (c.agents.trend && now - cs.hourlyAt >= 15 * MIN) {
          cs.hourly = await this.ccxt.ohlcv(c.exchangeId, cs.symbol, '1h', 60);
          cs.hourlyAt = now;
        }
        if (c.agents.trend && cs.hourly.length) {
          const cand = trendCandidate(cs.hourly, cs.daily, TREND_AGENT_DEFAULTS, now);
          if (cand && cand.bar > cs.lastBar) {
            cs.lastBar = cand.bar;
            const price = Number.isFinite(cs.price) ? cs.price : cand.price;
            const shift = price - cand.price;
            this.propose(cs.coin, 'trend', { ...cand, price, stop: cand.stop + shift, target: cand.target + shift });
          }
        }
      } catch (err) {
        this.sayOnce(`candles:${cs.coin}`, 'trend', `${cs.coin}: candles unavailable (${err?.message ?? err}) — trying again`, 'warn', 30 * MIN);
      }
      if (c.agents.lab !== false) await this.labTick(cs, now);
    }
    if (this.mode === 'live') await this.refreshEquity();
    const eq = this.equity();
    if (eq > 0) {
      this.setBook(updateBook(this.book(), eq, c.risk, now));
      for (const cs of this.coins.values()) for (const e of Object.values(cs.engines)) e.liveBalance = eq;
    }
    if (now - (this.trainedAt ?? 0) >= 10 * MIN) await this.retrain();
    this.persist();
  }

  /**
   * The Lab agent: each strategy deployed from the Strategy Lab reads its
   * signal on this coin's closed candles of its own timeframe, proposes new
   * signals to the council, and closes its trade on an opposite signal when
   * its rules say so.
   */
  async labTick(cs, now) {
    const strategies = this.labDeployed().filter((d) => !d.coins?.length || d.coins.includes(cs.coin));
    if (!strategies.length) return;
    for (const tfH of [...new Set(strategies.map((d) => d.tfH))]) {
      const tf = tfH === 24 ? '1d' : tfH < 1 ? `${Math.round(tfH * 60)}m` : `${tfH}h`;
      // look again soon enough to catch each candle's close: every minute on 15-minute candles, every ten on daily ones
      const every = Math.min(10 * MIN, Math.max(MIN, (tfH * HOUR) / 15));
      const L = (cs.lab[tfH] ??= { bars: [], at: 0, want: 0 });
      const mine = strategies.filter((x) => x.tfH === tfH);
      const needs = mine.map((d) => specNeeds(d.spec));
      const want = labBarsFor(tfH, needs.some((x) => x.features));
      try {
        // the first look, or a newly deployed strategy that needs a longer history than is held
        if (!L.bars.length || want > (L.want ?? 0)) {
          L.bars = await this.labHistory(cs.coin, cs.symbol, tf, tfH, now, want);
          L.at = now;
          L.want = want;
        } else if (now - L.at >= every) {
          const fresh = await this.ccxt.ohlcv(this.cfg.exchangeId, cs.symbol, tf, 10);
          const last = L.bars[L.bars.length - 1]?.time ?? 0;
          L.bars = [...L.bars.filter((b) => b.time < (fresh[0]?.time ?? Infinity)), ...fresh].filter((b, i, a) => i === 0 || b.time > a[i - 1].time).slice(-want);
          L.at = now;
          if ((L.bars[L.bars.length - 1]?.time ?? 0) <= last) continue;
        } else continue;
      } catch (err) {
        this.sayOnce(`lab:${cs.coin}:${tf}`, 'lab', `${cs.coin}: ${tf} history unavailable for the Lab's strategies (${err?.message ?? err}) — trying again`, 'warn', 30 * MIN);
        continue;
      }
      const closed = L.bars.filter((b) => b.time + tfH * HOUR <= now);
      // what these strategies read beside the coin's candles: bitcoin's price (pairs, bitcoin's lead, the
      // market filter) and the funding history (carry, crowding) — as in their backtest
      const btc = needs.some((x) => x.bench) && cs.coin !== 'BTC' ? await this.labBench(tfH, tf, now) : null;
      const funding = needs.some((x) => x.funding) ? await this.labFunding(cs, closed, tfH, now) : null;
      const market = liveMarket(cs.coin, tfH, closed, { btc, funding });
      for (const d of mine) {
        // a breath between strategies: one slow calculation (a learned rule on many candles) never holds up the app
        await new Promise((r) => setImmediate(r));
        if (!this.running) return;
        const pos = this.openOn(cs.coin);
        // an opposite signal closes the Lab's own trade, if the rules say so
        if (pos && pos.agent === 'lab' && pos.labId === d.id && d.spec.exit.onFlip && !pos.closing) {
          if (liveDirection(d.spec, market) === -dirOf(pos.side)) void this.close(pos, 'flip', Number.isFinite(cs.price) ? cs.price : closed[closed.length - 1].close);
          continue;
        }
        const sig = liveSignal(d.spec, market);
        if (!sig || sig.bar <= (cs.labLast[d.id] ?? 0)) continue;
        cs.labLast[d.id] = sig.bar;
        const price = Number.isFinite(cs.price) ? cs.price : sig.price;
        const shift = price - sig.price;
        const stats = d.stats ? ` (tested: Sharpe ${d.stats.sharpe.toFixed(2)}, t ${d.stats.t.toFixed(1)}, ${d.stats.verdict})` : '';
        this.propose(cs.coin, 'lab', { ...sig, price, stop: sig.stop + shift, target: sig.target + shift, setup: `Lab · ${sig.setup}`, why: `${sig.why}${stats}`, labId: d.id, labTfH: tfH, labHoldMs: d.spec.exit.maxBars * tfH * HOUR, authority: d.authority === 'tested' ? 'tested' : 'council', probation: Number.isFinite(d.scale) ? d.scale : 1 });
      }
    }
  }

  /**
   * A deployed strategy's history: enough candles to warm it up (labBarsFor). Hyperliquid keeps
   * only its last 5,000 candles of each size, so on fast candles the older ones come from Binance,
   * scaled to Hyperliquid's price where they overlap — the same joined history the edge finder
   * tested the strategy on.
   */
  async labHistory(coin, symbol, tf, tfH, now, want = labBarsFor(tfH)) {
    const ex = this.cfg.exchangeId;
    const bars = await this.ccxt.history(ex, symbol, tf, now - want * tfH * HOUR, want);
    // only where Hyperliquid's 5,000-candle limit is the reason it came back short (1-minute candles)
    if (bars.length >= want * 0.9 || ex !== 'hyperliquid' || want <= 5000) return bars;
    try {
      const long = await this.ccxt.history('binance', `${coin}/USDT`, tf, now - want * tfH * HOUR, want);
      return long.length > bars.length ? spliceCandles(long, bars).bars.slice(-want) : bars;
    } catch {
      return bars;
    }
  }

  /** bitcoin's candles on a timeframe, shared by every coin's Lab strategies that read them */
  async labBench(tfH, tf, now) {
    const B = ((this.bench ??= {})[tfH] ??= { bars: [], at: 0 });
    const symbol = symbolFor('BTC', this.cfg.exchangeId);
    try {
      if (!B.bars.length) {
        B.bars = await this.labHistory('BTC', symbol, tf, tfH, now);
        B.want = labBarsFor(tfH);
        B.at = now;
      } else if (now - B.at >= Math.min(10 * MIN, Math.max(MIN, (tfH * HOUR) / 15))) {
        const fresh = await this.ccxt.ohlcv(this.cfg.exchangeId, symbol, tf, 10);
        B.bars = [...B.bars.filter((b) => b.time < (fresh[0]?.time ?? Infinity)), ...fresh].filter((b, i, a) => i === 0 || b.time > a[i - 1].time).slice(-labBarsFor(tfH));
        B.at = now;
      }
    } catch (err) {
      this.sayOnce(`lab:bench:${tf}`, 'lab', `bitcoin's ${tf} candles are unavailable (${err?.message ?? err}) — strategies that read bitcoin beside a coin wait for them`, 'warn', 30 * MIN);
    }
    return B.bars.length ? B.bars.filter((b) => b.time + tfH * HOUR <= now) : null;
  }

  /** the funding paid per candle on this coin (the exchange's history, refreshed hourly), lined up with its candles */
  async labFunding(cs, closed, tfH, now) {
    const F = (cs.fund ??= { rows: [], at: 0 });
    if (!F.rows.length || now - F.at >= HOUR) {
      try {
        if (!this.ccxt.fundingHistory) throw new Error('no funding history on this connection');
        F.rows = await this.ccxt.fundingHistory(this.cfg.exchangeId, cs.symbol, now - 45 * 24 * HOUR, 3000);
        F.at = now;
      } catch (err) {
        this.sayOnce(`lab:fund:${cs.coin}`, 'lab', `${cs.coin}: funding history unavailable (${err?.message ?? err}) — funding rules cannot fire without it`, 'warn', 60 * MIN);
      }
    }
    return F.rows.length && closed.length ? alignFunding(closed, F.rows, tfH) : null;
  }

  async refreshEquity() {
    try {
      const prev = this.liveEquity;
      const v = await this.ccxt.accountBalance(this.secretId, symbolFor(this.cfg.coins[0], this.cfg.exchangeId));
      if (!(v >= 0)) return;
      this.liveEquity = v;
      // a change no trade explains is a deposit or a withdrawal: the record moves with it
      if (prev > 0 && this.liveBook && !this.open('live').length && !this.inFlight) {
        const moved = v - prev - (this.liveFlow ?? 0);
        if (Math.abs(moved) >= Math.max(1, prev * 0.05)) {
          this.liveBook = shiftBook(this.liveBook, moved);
          this.say('risk', `${moved > 0 ? 'deposit' : 'withdrawal'} of ${usd(Math.abs(moved))} noticed — counted as money moved, not as a ${moved > 0 ? 'gain' : 'loss'}`);
        }
      }
      this.liveFlow = 0;
    } catch (err) {
      this.sayOnce('equity', 'risk', `account value unavailable: ${err?.message ?? err}`, 'warn', 10 * MIN);
    }
  }

  // ---------- decisions ----------

  handle(coin, agent, intents) {
    const cs = this.coins.get(coin);
    const e = cs?.engines[agent];
    if (!e) return;
    if (e.brain) {
      const pos = this.openOn(coin);
      for (const th of e.brain.drain()) if (pos && pos.owner === 'engine' && pos.agent === agent && /cut|stall|trail|bank|run|steam|stop/i.test(th.text)) this.decision(pos, th.text);
    }
    for (const it of intents) {
      if (it.type === 'enter') this.propose(coin, agent, { side: it.side, price: it.price, stop: it.stop, target: it.target, setup: it.setup, why: it.reason });
      else if (it.type === 'exit') {
        const pos = this.openOn(coin);
        if (pos && pos.owner === 'engine' && pos.agent === agent) void this.close(pos, it.reason, it.price);
        else e.failed('no open swarm position');
      }
    }
  }

  ctxOf(cs, agent) {
    const e = cs.engines[agent] ?? cs.engines.auction ?? null;
    const flow = e ? e.flowStats() : null;
    const book = e ? e.bookStats() : null;
    const k = e?.candles?.slice(-16) ?? [];
    let tr = 0;
    for (let i = 1; i < k.length; i++) tr += Math.max(k[i][2] - k[i][3], Math.abs(k[i][2] - k[i - 1][4]), Math.abs(k[i][3] - k[i - 1][4]));
    const volBps = k.length > 2 && cs.price > 0 ? (tr / (k.length - 1) / cs.price) * 1e4 : null;
    const mine = this.positions.filter((p) => p.closedAt && p.agent === agent).slice(-20);
    return {
      daily: cs.daily ? { dir: cs.daily.dir, up: cs.daily.up } : null,
      flow: flow && flow.buy + flow.sell > 0 ? { deltaRatio: flow.deltaRatio, intensity: flow.intensity } : null,
      book: book ? { imbalance: book.imbalance, spreadBps: book.spreadBps } : null,
      funding: Number.isFinite(cs.funding) ? cs.funding : null,
      volBps,
      va: e?.sessionVa ?? e?.va ?? null,
      agentWin: mine.length >= 5 ? mine.filter((p) => p.pnl > 0).length / mine.length : 0.5,
      micro: cs.micro ? cs.micro.read(cs.micro.lastT || this.now()) : null,
    };
  }

  /** A strategy agent proposes; the council decides; the risk manager sizes; it is executed. */
  propose(coin, agent, p) {
    const cs = this.coins.get(coin);
    const e = cs?.engines[agent] ?? null;
    const c = this.cfg;
    if (!cs || !this.running || cs.busy || this.openOn(coin)) {
      e?.failed(cs?.busy || this.openOn(coin) ? `the swarm already holds ${coin}` : 'stopped');
      if (p.labId && this.running) this.labNote(p.labId, (b) => b.refused++);
      return;
    }
    // paused by you (from the phone or the screen): no new trades; open ones are still managed
    if (this.holding) {
      e?.failed('paused by you — no new trades');
      this.sayOnce(`hold:${coin}:${agent}`, agent, `${coin}: a ${p.side === 'buy' ? 'LONG' : 'SHORT'} signal, not taken — the swarm is paused for new trades`, 'pass', 30 * MIN);
      return;
    }
    const t = this.now();
    const cand = { agent, coin, symbol: cs.symbol, side: p.side, price: p.price, stop: p.stop, target: p.target, setup: p.setup, why: p.why, t, ctx: this.ctxOf(cs, agent), authority: p.authority ?? 'council' };
    const x = features(cand);
    const costBps = 2 * (c.feeBps + c.slippageBps);
    const odds = oddsR(x, this.forest, costBps);
    const equity = this.equity();
    const book = this.book();
    const open = this.open();
    const gate = riskGate(book, equity, open.length, c.risk, t);
    const size = gate ? null : sizeTrade({ price: p.price, stop: p.stop, side: p.side, equity, book, openNotional: open.reduce((a, q) => a + q.notional, 0), expR: odds.expR, maxLev: c.risk.perCoinLeverage, sizeMult: p.sizeMult, probation: p.probation }, c.risk);
    const sizeNote = size && !size.skip ? `risking ${size.riskPct.toFixed(2)}% of the account (${usd(size.riskUsd)}) on a ${usd(size.notional)} position, ${size.lev.toFixed(1)}× the account${size.why ? ` — ${size.why}` : ''}` : '';
    const v = councilR({ cand, odds, riskGate: gate ?? size?.skip ?? null, sizeNote }, c.council);
    this.discuss(cand, v);
    if (p.labId)
      this.labNote(p.labId, (b) => {
        b.signals++;
        if (!v.trade) {
          const by = v.votes.find((q) => q.stance === 'veto')?.bot ?? 'score';
          b.blocked++;
          b.blockedBy[by] = (b.blockedBy[by] ?? 0) + 1;
        }
      });
    if (!v.trade) {
      e?.failed(`council: ${v.summary}`);
      this.shadow.add({ coin, side: p.side, entry: p.price, stop: p.stop, target: p.target, t, maxHoldMs: agent === 'lab' ? p.labHoldMs ?? 72 * HOUR : agent === 'trend' ? 72 * HOUR : agent === 'auction' ? 8 * HOUR : 15 * MIN, x, agent, costR: odds.costR, labId: p.labId ?? null });
      return;
    }
    const risk = Math.abs(p.price - p.stop);
    const pos = {
      id: randomUUID(),
      mode: this.mode,
      coin,
      symbol: cs.symbol,
      agent,
      owner: agent === 'trend' || agent === 'lab' ? 'swarm' : 'engine',
      labId: p.labId ?? null,
      labTfH: p.labTfH ?? null,
      side: p.side,
      setup: p.setup,
      why: p.why,
      entry: p.price,
      qty: size.qty,
      notional: size.notional,
      stop: p.stop,
      target: p.target,
      stop0: p.stop,
      target0: p.target,
      risk,
      riskUsd: size.riskUsd,
      riskPct: size.riskPct,
      lev: size.lev,
      atr: p.atr ?? risk / 2,
      openedAt: t,
      fees: 0,
      votes: v.votes,
      summary: v.summary,
      odds: { pWin: odds.pWin, pLoss: odds.pLoss, expR: odds.expR, trust: odds.trust },
      x,
      mgmt: [],
      notified: {},
      be: false,
      trailed: false,
      equityAtEntry: equity,
    };
    cs.busy = true;
    // the Microstructure agent times the entry (a tested strategy's too): bad timing waits, the trade itself stands
    const exec = this.timingHold(cs, pos).then(() => (pos.mode === 'live' ? this.openLive(pos) : this.openPaper(pos)));
    this.inFlight = true;
    exec
      .then(() => {
        cs.busy = false;
        this.inFlight = false;
        if (!this.running && this.mode === 'live') this.say('risk', `${coin}: entry filled as the swarm stopped — the position stays open with its exchange stop`, 'warn');
        e?.filled({ price: pos.entry, qty: pos.qty, fee: pos.fees });
        this.positions.push(pos);
        this.positions = this.positions.slice(-400);
        this.say(agent, `${coin}: ${pos.side === 'buy' ? 'LONG' : 'SHORT'} ${tidy(pos.qty)} @ ${tidy(pos.entry)} — stop ${tidy(pos.stop)}, target ${tidy(pos.target)}, risking ${usd(pos.riskUsd)} to make ${usd(this.potential(pos))}${pos.heldHow ? ` · ${pos.heldHow}` : ''}${pos.entryHow ? ` · ${pos.entryHow}` : ''}`, 'trade');
        this.notify('setup', pos);
        this.persist();
      })
      .catch((err) => {
        cs.busy = false;
        this.inFlight = false;
        e?.failed(err?.skip ? 'entry skipped' : err);
        if (err?.skip) this.say(agent, `${coin}: entry skipped — ${err.message}`, 'pass');
        else this.say('risk', `${coin}: entry order failed — ${err?.message ?? err}`, 'error');
      });
  }

  /** The fill: the stop and target stay at their levels (structure, not distance); the risk is re-measured from the fill. */
  filledAt(pos, fill, feeBps = this.cfg.feeBps) {
    pos.entry = fill;
    pos.notional = fill * pos.qty;
    pos.fees = (pos.notional * feeBps) / 1e4;
    pos.risk = Math.abs(fill - pos.stop) || pos.risk;
    pos.riskUsd = pos.risk * pos.qty;
  }

  /** What the trade makes at its target, fees out. */
  potential(pos) {
    const gross = Math.abs(pos.target - pos.entry) * pos.qty;
    return gross - pos.notional * (2 * this.cfg.feeBps) / 1e4;
  }

  /**
   * How to enter (smarter entries): rest at the best bid (offer) for a maker fill, or take the
   * price now — when there is no book to time it, when the book and tape are pushing hard its way
   * (a resting order would be left behind), or when the best price is already past the stop.
   */
  entryPlan(cs, pos) {
    const e = this.cfg.entry;
    const top = cs?.micro?.top();
    if (!e?.maker || !top) return { take: true, why: '' };
    const dir = dirOf(pos.side);
    const st = entryStyle(cs.micro.read(cs.micro.lastT || this.now()), dir);
    if (st.take) return { take: true, why: st.why };
    const price = dir > 0 ? top.bid : top.ask;
    if (!(price > 0) || (price - pos.stop) * dir <= 0) return { take: true, why: '' };
    return { take: false, price, why: st.why };
  }

  /**
   * Timing (the Microstructure agent at work on every entry, "as tested" included): if the last
   * seconds say now is a bad moment — a cascade against the trade, a burst the other way, a book
   * leaning against it — wait for that to clear, up to entry.holdSec, checking once a second. The
   * trade is not cancelled for timing alone; it is skipped only if the setup itself breaks while it
   * waits (the stop or the target is reached, or the price runs further away than the chase limit).
   */
  async timingHold(cs, pos) {
    const e = this.cfg.entry;
    const hold = e?.holdSec ?? 0;
    if (!(hold > 0) || !cs?.micro) return;
    const dir = dirOf(pos.side);
    const read = () => cs.micro.read(Math.max(cs.micro.lastT, this.now()));
    let v = microVote(read(), dir);
    if (v.stance !== 'against') return;
    const why = v.why.split(' — ')[0];
    const from = pos.entry;
    pos.askEntry = from;
    let waited = 0;
    while (v.stance === 'against' && waited < hold) {
      await this.sleep(1000);
      waited++;
      if (!this.running) throw skipped('the swarm stopped while the entry waited for better timing');
      const px = cs.price;
      if (px > 0 && (px - pos.stop) * dir <= 0) throw skipped(`the price reached the stop (${tidy(pos.stop)}) while it waited for better timing — the setup failed before it was entered`);
      if (px > 0 && (px - pos.target) * dir >= 0) throw skipped(`the price reached the target (${tidy(pos.target)}) while it waited for better timing — the move happened without it`);
      v = microVote(read(), dir);
    }
    const now = cs.price > 0 ? cs.price : from;
    const moved = (((now - from) * dir) / from) * 1e4;
    // a held trade that runs away is often a winner: it is still taken unless a quarter of its room to the stop is gone
    const room = Math.max(e.chaseBps, (0.25 * Math.abs(from - pos.stop) * 1e4) / from);
    if (moved > room) throw skipped(`the price moved ${moved.toFixed(1)} bps away while it waited for better timing (more than a quarter of the way to the stop gone) — chasing would cost more than the edge`);
    pos.entry = now;
    const better = -moved >= 0.5 ? `, ${(-moved).toFixed(1)} bps better` : '';
    pos.heldHow = v.stance === 'against' ? `Micro held it ${waited} s (${why}); still not clear, entered${better}` : `Micro held it ${waited} s until the timing cleared (${why})${better}`;
  }

  /** what an entry saved: the maker fee against the taker fee and the slippage, in bps */
  makerSaving() {
    const c = this.cfg;
    return (c.feeBps + c.slippageBps - c.makerFeeBps).toFixed(1);
  }

  openPaper(pos) {
    const c = this.cfg;
    const dir = dirOf(pos.side);
    pos.askEntry ??= pos.entry;
    const cs = this.coins.get(pos.coin);
    const plan = this.entryPlan(cs, pos);
    const taker = (why) => {
      this.filledAt(pos, pos.entry * (1 + (dir * c.slippageBps) / 1e4));
      this.paper.cash -= pos.fees;
      if (why) pos.entryHow = why;
    };
    if (plan.take) return taker(plan.why);
    // resting at the best price: filled only if trades print through it while it waits (the queue ahead is cleared)
    return (async () => {
      const from = cs.micro.lastT;
      await this.sleep(c.entry.waitMs);
      const { lo, hi } = cs.micro.rangeSince(from + 1);
      if (dir > 0 ? lo < plan.price : hi > plan.price) {
        this.filledAt(pos, plan.price, c.makerFeeBps);
        this.paper.cash -= pos.fees;
        pos.entryHow = `filled resting at the ${dir > 0 ? 'bid' : 'offer'} (maker) — about ${this.makerSaving()} bps cheaper than taking it`;
        return;
      }
      const now = cs.price > 0 ? cs.price : plan.price;
      const moved = (((now - plan.price) * dir) / plan.price) * 1e4;
      if (moved > c.entry.chaseBps) throw skipped(`the price moved ${moved.toFixed(1)} bps away while it waited at ${tidy(plan.price)} — chasing would cost more than the edge`);
      pos.entry = now;
      taker(`not filled resting at ${tidy(plan.price)} within ${c.entry.waitMs / 1000} s — taken at the price`);
    })();
  }

  /** Live, resting: a post-only limit at the best price, watched for a few seconds, cancelled if not filled. */
  async liveMaker(pos, plan) {
    const c = this.cfg;
    let r;
    try {
      r = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: pos.side, type: 'limit', sizeMode: 'base', size: pos.qty, price: plan.price, postOnly: true });
    } catch (err) {
      return { filled: 0, amount: 0, avg: plan.price, note: `resting order refused (${err?.message ?? err})` };
    }
    const per = r.baseQty && r.amount ? r.baseQty / r.amount : 1;
    let st = null;
    const done = (x) => x && (x.status === 'closed' || x.filled >= (r.amount ?? 0) * 0.999);
    for (let i = 0; i < Math.ceil(c.entry.waitMs / 1000); i++) {
      await this.sleep(1000);
      st = await this.ccxt.orderStatus(this.secretId, r.id, pos.symbol).catch(() => st);
      if (done(st)) break;
    }
    if (!done(st)) {
      await this.ccxt.cancelOrder(this.secretId, r.id, pos.symbol).catch(() => undefined);
      st = await this.ccxt.orderStatus(this.secretId, r.id, pos.symbol).catch(() => st);
    }
    const amount = st?.filled ?? 0;
    return { filled: amount * per, amount, avg: st?.average > 0 ? st.average : plan.price };
  }

  async openLive(pos) {
    const c = this.cfg;
    const dir = dirOf(pos.side);
    // the price the decision was made at: the gap to the fill is the real slippage (the journal measures it)
    pos.askEntry ??= pos.entry;
    const cs = this.coins.get(pos.coin);
    const plan = this.entryPlan(cs, pos);
    let qty = 0;
    let amount = 0;
    let cost = 0;
    let fees = 0;
    let real = true;
    let how = plan.why;
    const market = async (size) => {
      const r = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: pos.side, type: 'market', sizeMode: 'base', size });
      const got = r.baseQty ?? size;
      qty += got;
      amount += r.amount ?? got;
      cost += got * (r.price ?? pos.entry);
      if (r.fee && isUsdish(r.fee.currency)) fees += r.fee.cost;
      else {
        fees += (got * (r.price ?? pos.entry) * c.feeBps) / 1e4;
        real = false;
      }
      pos.fillsReal = r.average !== null && r.average !== undefined;
    };
    if (plan.take) await market(pos.qty);
    else {
      const m = await this.liveMaker(pos, plan);
      if (m.filled > 0) {
        qty += m.filled;
        amount += m.amount;
        cost += m.filled * m.avg;
        fees += (m.filled * m.avg * c.makerFeeBps) / 1e4;
        real = false;
      }
      const left = pos.qty - qty;
      const px = cs?.price > 0 ? cs.price : plan.price;
      if (left * px < 1) how = `filled resting at the ${dir > 0 ? 'bid' : 'offer'} (maker) — about ${this.makerSaving()} bps cheaper than taking it`;
      else {
        const moved = (((px - plan.price) * dir) / plan.price) * 1e4;
        if (moved <= c.entry.chaseBps) {
          await market(left);
          how = m.filled > 0 ? 'part filled resting at the best price, the rest taken' : `not filled resting at ${tidy(plan.price)} within ${c.entry.waitMs / 1000} s${m.note ? ` (${m.note})` : ''} — taken at the price`;
        } else if (qty * px >= c.risk.minNotional * 1.02) how = `part filled resting at the best price; the price then moved ${moved.toFixed(1)} bps away and the rest was not chased`;
        else {
          // too little to keep (under the exchange's smallest order): closed again, and the entry skipped
          if (amount > 0) await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'market', sizeMode: 'contracts', size: amount, reduceOnly: true }).catch(() => undefined);
          throw skipped(`the price moved ${moved.toFixed(1)} bps away while it waited at ${tidy(plan.price)} — chasing would cost more than the edge`);
        }
      }
    }
    pos.qty = qty;
    pos.amount = amount;
    this.filledAt(pos, cost / qty);
    pos.fees = fees;
    pos.feeReal = real;
    if (how) pos.entryHow = how;
    this.liveFlow = (this.liveFlow ?? 0) - pos.fees;
    // the exchange-side disaster stop, half a risk unit beyond the swarm's own stop
    pos.stopTrigger = pos.stop - dir * 0.5 * pos.risk;
    try {
      const s = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'stop-market', sizeMode: 'contracts', size: pos.amount, triggerPrice: pos.stopTrigger, reduceOnly: true });
      pos.stopOrderId = s.id;
    } catch (err) {
      this.say('risk', `${pos.coin}: protective stop not placed on the exchange (${err?.message ?? err}) — the swarm's own stop still applies`, 'warn');
    }
  }

  /** Live: the exchange stop follows the swarm's stop (at most every 30 s, only for a real move). */
  async syncStop(pos) {
    if (!pos.stopOrderId || pos.closing || pos.syncing) return;
    const dir = dirOf(pos.side);
    const want = pos.stop - dir * 0.5 * pos.risk * (pos.be ? 0.2 : 1);
    if ((want - pos.stopTrigger) * dir <= pos.risk * 0.2 || this.now() - (pos.stopSyncedAt ?? 0) < 30_000) return;
    pos.syncing = true;
    try {
      await this.ccxt.cancelOrder(this.secretId, pos.stopOrderId, pos.symbol);
      const s = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'stop-market', sizeMode: 'contracts', size: pos.amount, triggerPrice: want, reduceOnly: true });
      pos.stopOrderId = s.id;
      pos.stopTrigger = want;
      pos.stopSyncedAt = this.now();
    } catch (err) {
      this.sayOnce(`stop:${pos.id}`, 'risk', `${pos.coin}: could not move the exchange stop (${err?.message ?? err})`, 'warn', 10 * MIN);
    } finally {
      pos.syncing = false;
    }
  }

  async close(pos, reason, price) {
    if (pos.closing || pos.closedAt) return;
    pos.closing = true;
    const c = this.cfg;
    const dir = dirOf(pos.side);
    const cs = this.coins.get(pos.coin);
    const e = pos.owner === 'engine' ? cs?.engines[pos.agent] : null;
    let exit = Number.isFinite(price) ? price : cs?.price ?? pos.entry;
    pos.askExit = exit;
    let exitFeeReal = null;
    try {
      if (pos.mode === 'live') {
        try {
          const r = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'market', sizeMode: 'contracts', size: pos.amount, reduceOnly: true });
          exit = r.price ?? exit;
          if (!(r.average > 0)) pos.fillsReal = false;
          if (r.fee && isUsdish(r.fee.currency) && pos.feeReal) exitFeeReal = r.fee.cost;
        } catch (err) {
          // the exchange stop may already have closed it
          const left = await this.ccxt.positionContracts(this.secretId, pos.symbol).catch(() => null);
          if (left !== 0) throw err;
          exit = pos.stopTrigger ?? exit;
          reason = 'exchange stop';
          // the exchange's stop filled it at a price this side never saw: not a measurable fill
          pos.fillsReal = false;
          pos.stopOrderId = null;
        }
        if (pos.stopOrderId) await this.ccxt.cancelOrder(this.secretId, pos.stopOrderId, pos.symbol).catch((err) => this.say('risk', `${pos.coin}: could not cancel the exchange stop: ${err?.message ?? err}`, 'warn'));
      } else exit = exit * (1 - (dir * c.slippageBps) / 1e4);
    } catch (err) {
      pos.closing = false;
      e?.failed(err);
      this.say('risk', `${pos.coin}: EXIT FAILED — ${err?.message ?? err}. Check the position on Hyperliquid.`, 'error');
      return;
    }
    const gross = (exit - pos.entry) * pos.qty * dir;
    const exitFee = exitFeeReal ?? (exit * pos.qty * c.feeBps) / 1e4;
    if (exitFeeReal === null) pos.feeReal = false;
    pos.fees += exitFee;
    pos.exit = exit;
    pos.pnl = gross - pos.fees;
    pos.r = pos.riskUsd > 0 ? pos.pnl / pos.riskUsd : 0;
    pos.reason = reason;
    pos.closedAt = this.now();
    pos.closing = false;
    if (pos.mode === 'paper') this.paper.cash += gross - exitFee;
    else this.liveFlow = (this.liveFlow ?? 0) + gross - exitFee;
    if (e) {
      if (!e.pending) e.pending = { kind: 'exit', reason };
      if (e.pos) e.filled({ price: exit, qty: pos.qty, fee: exitFee });
    }
    if (pos.mode === this.mode) this.setBook(recordClose(this.book(), pos.r, c.risk, this.now()));
    this.learn(pos.x, pos.r, pos.mode, pos.agent);
    if (pos.labId)
      this.labNote(pos.labId, (b) => {
        b.taken++;
        b.takenR += pos.r;
      });
    this.say(pos.agent, `${pos.coin}: closed (${reason}) @ ${tidy(exit)} — ${pos.pnl >= 0 ? '+' : '−'}${usd(Math.abs(pos.pnl))} (${pos.r >= 0 ? '+' : ''}${pos.r.toFixed(2)}R)`, pos.pnl >= 0 ? 'win' : 'loss');
    this.notify('result', pos);
    try {
      this.onClosed(pos);
    } catch (err) {
      this.logFn('warn', `journal: ${err?.message ?? err}`);
    }
    if (pos.mode === 'live') void this.refreshEquity();
    this.persist();
  }

  // ---------- learning ----------

  learn(x, r, src, agent) {
    if (!Array.isArray(x)) return;
    this.samples.push({ x, y: rClass(r), r, src, agent, t: this.now() });
    if (this.samples.length > 3000) this.samples = this.samples.slice(-3000);
  }

  async retrain(force = false) {
    this.trainedAt = this.now();
    if (this.samples.length < 30 || (!force && this.samples.length === this.trainedN)) return;
    try {
      this.forest = await trainForest(this.samples, this.now());
      this.trainedN = this.samples.length;
      const s = this.forest.stats;
      this.say('forest', `retrained on ${s.n} trades (paper, live and the ones refused): ${s.accuracy !== null ? `${Math.round(s.accuracy * 100)}% right out of sample against ${Math.round((s.baseline ?? 0) * 100)}% for always guessing the commonest outcome` : 'not enough for an honest score yet'}`);
    } catch (err) {
      this.say('forest', `training failed: ${err?.message ?? err}`, 'warn');
    }
  }

  // ---------- talk ----------

  discuss(cand, v) {
    // the same proposal turned down again within 10 minutes stays quiet
    const key = `${cand.coin}:${cand.agent}:${cand.setup}:${cand.side}:${v.trade}:${v.summary.split(' ')[0]}`;
    if (!v.trade && this.now() - (this.lastSaid.get(key) ?? 0) < 10 * MIN) return;
    this.lastSaid.set(key, this.now());
    this.say(cand.agent, `${cand.coin}: proposes a ${cand.side === 'buy' ? 'LONG' : 'SHORT'} @ ${tidy(cand.price)} — ${cand.setup}: ${cand.why}`, 'propose');
    for (const vt of v.votes.slice(1)) this.say(vt.bot, `${MARK[vt.stance]} ${vt.why}`, 'vote');
    this.say('council', `${cand.coin}: ${v.summary}`, v.trade ? 'trade' : 'pass');
  }

  say(agent, text, kind = 'info') {
    const line = { t: this.now(), agent, text, kind };
    this.lines.push(line);
    if (this.lines.length > 300) this.lines.shift();
    this.emitFn('event', { kind: 'line', line });
    this.logFn(kind === 'error' ? 'warn' : 'info', `cswarm ${agent}: ${text}`);
  }

  sayOnce(key, agent, text, kind, everyMs) {
    if (this.now() - (this.lastSaid.get(key) ?? 0) < everyMs) return;
    this.lastSaid.set(key, this.now());
    this.say(agent, text, kind);
  }

  /** The three moments of a trade, with what the app needs to draw its chart. */
  notify(stage, pos) {
    const cs = this.coins.get(pos.coin);
    const e = cs?.engines[pos.agent] ?? cs?.engines.auction ?? null;
    const minute = (e?.candles ?? []).slice(-90).map(([t, o, h, l, c]) => [t, o, h, l, c]);
    const hourly = (cs?.hourly ?? []).slice(-60).map((r) => [r.time, r.open, r.high, r.low, r.close]);
    const candles = pos.agent === 'trend' || minute.length < 20 ? hourly : minute;
    const va = e?.sessionVa ?? e?.va ?? null;
    const { x: _x, ...p } = pos;
    this.emitFn('event', { kind: 'notify', stage, mode: pos.mode, position: { ...p, potential: this.potential(pos), price: cs?.price ?? null, agentName: AGENT_NAME[pos.agent] }, candles, timeframe: candles === hourly ? '1h' : '1m', va, equity: this.equity() });
  }

  // ---------- state ----------

  /** update a Lab strategy's book (what the council did with its signals) */
  labNote(id, fn) {
    const b = (this.labBook[id] ??= { signals: 0, blocked: 0, blockedBy: {}, refused: 0, taken: 0, takenR: 0, shadowN: 0, shadowR: 0 });
    fn(b);
    this.db.set('cswarm:labBook', this.labBook);
  }

  persist() {
    this.db.set('cswarm:paper', this.paper);
    if (this.liveBook) this.db.set('cswarm:liveBook', this.liveBook);
    this.db.set('cswarm:positions', this.positions.map(({ closing: _c, syncing: _s, ...p }) => p));
    this.db.set('cswarm:samples', this.samples);
  }

  state() {
    const eq = this.equity();
    const book = this.book();
    const all = this.positions.filter((p) => p.mode === this.mode);
    const closed = all.filter((p) => p.closedAt);
    const byAgent = {};
    for (const a of PROPOSERS) {
      const mine = closed.filter((p) => p.agent === a);
      byAgent[a] = { trades: mine.length, wins: mine.filter((p) => p.pnl > 0).length, pnl: mine.reduce((s, p) => s + p.pnl, 0), avgR: mine.length ? mine.reduce((s, p) => s + p.r, 0) / mine.length : null };
    }
    const coins = [...this.coins.values()].map((cs) => ({
      coin: cs.coin,
      symbol: cs.symbol,
      price: cs.price,
      feed: cs.feed,
      feedError: cs.feedError,
      funding: cs.funding,
      daily: cs.daily ? { dir: cs.daily.dir, up: cs.daily.up } : null,
      engines: Object.fromEntries(Object.entries(cs.engines).map(([a, e]) => [a, { state: e.state, warm: e.state !== 'warmup', lastSkip: e.lastSkip, lastSignal: e.lastSignal ? { setup: e.lastSignal.setup, side: e.lastSignal.side, t: e.lastSignal.t } : null }])),
    }));
    const fs = this.forest?.stats;
    return {
      running: this.running,
      holding: this.holding,
      mode: this.mode,
      secretId: this.secretId,
      sandbox: this.sandbox,
      cfg: this.cfg,
      equity: Number.isFinite(eq) ? eq : null,
      book: { start: book.start, peak: book.peak, floor: book.floor, dayStart: book.dayStart, streak: book.streak, pausedUntil: book.pausedUntil },
      open: this.open().map(({ x: _x, closing: _c, syncing: _s, ...p }) => ({ ...p, upnl: this.upnl(p), price: this.coins.get(p.coin)?.price ?? null })),
      closed: closed.slice(-40).reverse().map(({ x: _x, ...p }) => p),
      totals: { trades: closed.length, wins: closed.filter((p) => p.pnl > 0).length, pnl: closed.reduce((s, p) => s + p.pnl, 0) },
      byAgent,
      labBook: this.labBook,
      coins,
      lines: this.lines.slice(-150),
      forest: { samples: this.samples.length, trained: fs ? { n: fs.n, accuracy: fs.accuracy, baseline: fs.baseline, trainedAt: fs.trainedAt } : null, shadowOpen: this.shadow.open.length },
    };
  }

  pushState(force = false) {
    if (!force && this.now() - this.lastState < 1000) return;
    this.lastState = this.now();
    this.emitFn('state', this.state());
  }
}
