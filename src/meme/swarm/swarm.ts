// The swarm: five bots working the meme-coin chain together, every two seconds.
//
//   Scout      — every launch, migration and DexScreener listing (the scanner)
//   Sentinel   — viability: rejects the rugs, bundles, dumps and wash trades
//   Herald     — virality: new wallets arriving, the meme's narrative, socials
//   Strategist — enters when heat, virality and viability all line up
//   Manager    — runs the trade: take profits, trailing stop, stop loss, rug exits
//
// Trades are on paper, or live from the swarm's own wallet (signed in the main
// process within hard limits, no approval clicks). Every pick (and a sample of
// passed-but-not-picked coins) is followed for an hour, so the hit rates per
// conviction level show whether the strategy works.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { desktop, type SwarmLimits } from '../../desktop/bridge';
import { fetchJson } from '../../exchanges/ws';
import { getSettings } from '../../store/settings';
import { scanner, useMeme } from '../scanner';
import { assess } from '../score';
import type { MemeToken } from '../token';
import { herald, Narratives, sentinel, strategist, STRATEGY_DEFAULTS, type CreatorRecord, type StrategyConfig, type Viability, type Virality } from './agents';
import { applySell, decideExit, managePosition, MANAGER_DEFAULTS, multiple, newMilestone, openPosition, pnlSol, type ExitDecision, type ManagerConfig, type Position } from './book';
import { tellWithCard } from './notify';
import { follow, newOutcome, type Outcome } from './outcomes';

export type AgentId = 'scout' | 'sentinel' | 'herald' | 'strategist' | 'manager';

export interface LogLine {
  t: number;
  agent: AgentId;
  text: string;
  mint?: string;
}

export interface CoinRead {
  mint: string;
  symbol: string;
  heat: number;
  viability: Viability;
  virality: Virality | null;
  conviction: number;
  decision: string;
  enter: boolean;
  mcapUsd: number;
}

export interface SwarmWallet {
  address: string;
  limits: SwarmLimits;
  spentToday: number;
  sol: number | null;
  /** the owner's Phantom wallet: withdrawals and profits go there, nowhere else */
  home?: string | null;
}

interface SwarmState {
  enabled: boolean;
  /** paper, or live: real trades from the swarm wallet, no approval click */
  mode: 'paper' | 'live';
  wallet: SwarmWallet | null;
  strategy: StrategyConfig;
  manager: ManagerConfig;
  positions: Position[];
  outcomes: Outcome[];
  // runtime (not saved)
  log: LogLine[];
  reads: CoinRead[];
  stats: {
    scout: { seen: number; perMin: number };
    sentinel: { checked: number; pass: number; watch: number; reject: number; top: { why: string; n: number }[] };
    herald: { scored: number; viral: number; narratives: { word: string; count: number }[] };
    strategist: { signals: number; last: string };
    manager: { open: number; closed: number; pnlSol: number; winRate: number | null };
  };
  set(p: Partial<SwarmState>): void;
  setStrategy(p: Partial<StrategyConfig>): void;
  setManager(p: Partial<ManagerConfig>): void;
  reset(): void;
}

const emptyStats = (): SwarmState['stats'] => ({
  scout: { seen: 0, perMin: 0 },
  sentinel: { checked: 0, pass: 0, watch: 0, reject: 0, top: [] },
  herald: { scored: 0, viral: 0, narratives: [] },
  strategist: { signals: 0, last: '' },
  manager: { open: 0, closed: 0, pnlSol: 0, winRate: null },
});

/** The saved swarm over the defaults. A sell in flight when the app closed is not in flight any more: those positions are managed again. */
export function mergeSwarm(persisted: unknown, current: SwarmState): SwarmState {
  const p = (persisted ?? {}) as Partial<SwarmState>;
  const positions = (p.positions ?? []).map((x) => ({ ...x, pending: false, retryAt: undefined }));
  return { ...current, ...p, positions, strategy: { ...STRATEGY_DEFAULTS, ...p.strategy }, manager: { ...MANAGER_DEFAULTS, ...p.manager } };
}

export const useSwarm = create<SwarmState>()(
  persist(
    (set) => ({
      enabled: false,
      mode: 'paper',
      wallet: null,
      strategy: { ...STRATEGY_DEFAULTS },
      manager: { ...MANAGER_DEFAULTS },
      positions: [],
      outcomes: [],
      log: [],
      reads: [],
      stats: emptyStats(),
      set: (p) => set(p),
      setStrategy: (p) => set((s) => ({ strategy: { ...s.strategy, ...p } })),
      setManager: (p) => set((s) => ({ manager: { ...s.manager, ...p } })),
      reset: () => set({ positions: [], outcomes: [], log: [] }),
    }),
    {
      name: 'novus-swarm',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled, mode: s.mode, strategy: s.strategy, manager: s.manager, positions: s.positions.slice(-300), outcomes: s.outcomes.slice(-2000) }),
      merge: (persisted, current) => mergeSwarm(persisted, current),
    },
  ),
);

const TICK_MS = 2000;

class Swarm {
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private walletTimer: ReturnType<typeof setInterval> | null = null;
  private narratives = new Narratives();
  private creators = new Map<string, CreatorRecord>();
  private seen = new Set<string>();
  private seenTimes: number[] = [];
  private rugged = new Set<string>();
  private traded = new Set<string>();
  private controls = new Set<string>();
  private lastControl = 0;
  private metaInFlight = 0;
  private verdicts = new Map<string, Viability['verdict']>();

  /** Run while enabled; the scanner runs with it, whatever panels are open. */
  sync() {
    const on = useSwarm.getState().enabled;
    if (on && !this.timer) {
      this.release = scanner.use();
      // coins already traded (before a restart too) are not bought again
      for (const p of useSwarm.getState().positions) {
        this.traded.add(p.mint);
        if (!p.closedAt) scanner.pin(p.mint);
      }
      this.timer = setInterval(() => this.tick(), TICK_MS);
      void this.refreshWallet();
      this.walletTimer = setInterval(() => void this.refreshWallet(), 30_000);
      const live = useSwarm.getState().mode === 'live';
      this.say('scout', `Swarm on — watching every pump.fun launch, migration and DexScreener listing (${live ? 'LIVE trading from the swarm wallet' : 'paper trading'}).`);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.walletTimer) clearInterval(this.walletTimer);
      this.walletTimer = null;
      this.release?.();
      this.release = null;
      this.say('scout', 'Swarm off.');
    }
  }

  private say(agent: AgentId, text: string, mint?: string) {
    useSwarm.setState((s) => ({ log: [...s.log.slice(-199), { t: Date.now(), agent, text, mint }] }));
  }

  private rpcId() {
    return getSettings().memeRpcSecretId || undefined;
  }

  /** The swarm wallet's state (live mode), refreshed every half minute. */
  async refreshWallet() {
    if (!desktop) return;
    try {
      const w = await desktop.swarm.wallet();
      if (!w) return useSwarm.setState({ wallet: null });
      const b = await desktop.swarm.balance(this.rpcId()).catch(() => null);
      const wallet = { address: w.address, limits: b?.limits ?? w.limits, spentToday: b?.spentToday ?? w.spentToday, sol: b ? b.sol : null, home: w.home ?? null };
      useSwarm.setState({ wallet });
      void this.sweepHome(wallet);
    } catch {
      /* keep the last state */
    }
  }

  private sweeping = false;

  /** Profits home: when switched on, SOL over the amount kept goes to the owner's Phantom (main checks the address and the amounts). */
  private async sweepHome(w: SwarmWallet) {
    if (!desktop || this.sweeping || this.buying.size || !w.home || !(w.limits.sweepAboveSol > 0) || w.sol === null) return;
    if (w.sol < w.limits.sweepAboveSol + 0.05) return;
    this.sweeping = true;
    try {
      const r = await desktop.swarm.sweep(this.rpcId());
      if (r) {
        this.say('manager', `sent ${r.sol.toFixed(4)} SOL of profit to your Phantom (kept ${w.limits.sweepAboveSol} SOL for trading)`);
        void tellWithCard(undefined, null, '', `💸 Swarm sent ${r.sol.toFixed(4)} SOL to your Phantom\nKept ${w.limits.sweepAboveSol} SOL in the swarm wallet for trading\nTx: https://solscan.io/tx/${r.signature}`, 0);
        void this.refreshWallet();
      }
    } catch (e) {
      this.say('manager', `could not send profits to Phantom — ${String((e as Error)?.message ?? e)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private buying = new Set<string>();

  /** Buy for real from the swarm wallet; the position books what the chain says happened. */
  private async liveBuy(tok: MemeToken, sizeSol: number, why: string, conviction: number, mc: string) {
    this.buying.add(tok.mint);
    this.say('manager', `${tok.symbol}: buying ${sizeSol} SOL live${mc}…`, tok.mint);
    try {
      const r = await desktop!.swarm.buy(tok.mint, sizeSol, this.rpcId());
      const decimals = r.decimals ?? 6;
      const raw = BigInt(r.tokenDelta ?? '0');
      const tokens = Number(raw) / 10 ** decimals;
      const cost = r.solDelta !== null ? -r.solDelta : sizeSol;
      if (!(tokens > 0)) throw new Error(`the buy went through (${r.signature}) but no tokens showed up — check the wallet`);
      const now = Date.now();
      const p: Position = {
        id: `${tok.mint}-${now}`,
        mint: tok.mint,
        symbol: tok.symbol,
        openedAt: now,
        costSol: cost,
        entryPx: cost / tokens,
        tokens,
        left: tokens,
        realizedSol: 0,
        peakMult: 1,
        peakAt: now,
        tpDone: 0,
        fills: [{ t: now, side: 'buy', sol: cost, tokens, mult: 1, why }],
        why,
        conviction,
        live: { rawLeft: raw.toString(), decimals, buyTx: r.signature },
      };
      useSwarm.setState((s) => ({ positions: [...s.positions, p] }));
      this.say('manager', `${tok.symbol}: bought live — ${cost.toFixed(4)} SOL for ${tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens via ${r.via}`, tok.mint);
      void tellWithCard(tok, p, `Bought — ${cost.toFixed(3)} SOL`, `🐝 Swarm bought ${tok.symbol} (LIVE)${mc}\nWhy: ${why}\nPaid: ${cost.toFixed(4)} SOL incl. fees, via ${r.via}\nPlan: ${this.plan()}\nTx: https://solscan.io/tx/${r.signature}`, useMeme.getState().solUsd);
      void this.refreshWallet();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.say('manager', `${tok.symbol}: live buy failed — ${msg}`, tok.mint);
      void tellWithCard(undefined, null, '', `⚠️ Swarm could not buy ${tok.symbol}\nWhy: ${msg}`, 0);
    } finally {
      this.buying.delete(tok.mint);
    }
  }

  /** Sell for real; books the SOL that really came back. */
  private async liveSell(p: Position, d: ExitDecision) {
    if (!p.live) return;
    p.pending = true;
    const sym = p.symbol;
    try {
      const left = BigInt(p.live.rawLeft);
      const raw = d.share >= 1 ? 'all' : ((left * BigInt(Math.round(d.share * 1_000_000))) / 1_000_000n).toString();
      const r = await desktop!.swarm.sell(p.mint, raw, this.rpcId());
      // the chain's amounts when it reported them, else what was asked for (and SOL at the price now)
      const reported = r.tokenDelta !== null;
      const sold = reported ? -BigInt(r.tokenDelta!) : raw === 'all' ? left : BigInt(raw);
      const rest = left - sold > 0n ? left - sold : 0n;
      p.live.rawLeft = rest.toString();
      const tokens = Number(sold) / 10 ** p.live.decimals;
      const sol = r.solDelta ?? tokens * p.entryPx * (Number.isFinite(d.mult) ? d.mult : 0);
      if (!reported || r.solDelta === null) this.say('manager', `${sym}: the RPC did not report the sale's amounts yet — booked at the price now`, p.mint);
      applySell(p, Date.now(), tokens, sol, d.why, d.mult, d.share >= 1 || rest === 0n);
      if (d.tp) p.tpDone++;
      p.retryAt = undefined;
      this.say('manager', `${sym}: sold live — ${sol.toFixed(4)} SOL back — ${d.why}`, p.mint);
      if (r.rentBack) this.say('manager', `${sym}: closed the empty token account — ${r.rentBack.toFixed(4)} SOL of rent back`, p.mint);
      this.afterSell(p, d, `https://solscan.io/tx/${r.signature}`);
      void this.refreshWallet();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/no tokens to sell/.test(msg)) {
        applySell(p, Date.now(), p.left, 0, 'no tokens left in the wallet — closed', d.mult, true);
        this.say('manager', `${sym}: nothing left in the wallet — position closed`, p.mint);
      } else {
        p.retryAt = Date.now() + 15_000;
        this.say('manager', `${sym}: live sell failed, retrying in 15 s — ${msg}`, p.mint);
      }
    } finally {
      p.pending = false;
      useSwarm.setState((s) => ({ positions: [...s.positions] }));
    }
  }

  private plan() {
    const m = useSwarm.getState().manager;
    return `${m.takeProfits.map((t) => `sell ${Math.round(t.sell * 100)}% at ${t.at}×`).join(', ')}, trail ${Math.round(m.trail * 100)}% from the peak once up ${m.trailFrom}×, stop −${Math.round(m.stopLoss * 100)}%`;
  }

  /** Telegram after a sell: a progress note for a take-profit, the result for a close. */
  private afterSell(p: Position, d: ExitDecision, tx?: string) {
    const { tokens, solUsd } = useMeme.getState();
    const tok = tokens[p.mint];
    const tag = p.live ? 'LIVE' : 'paper';
    if (p.closedAt) {
      const pnl = p.realizedSol - p.costSol;
      void tellWithCard(
        tok,
        p,
        `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(3)} SOL (${(((p.realizedSol / p.costSol) - 1) * 100).toFixed(0)}%)`,
        `${pnl >= 0 ? '💰' : '🔻'} Swarm closed ${p.symbol} (${tag}) ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(4)} SOL\nWhy: ${d.why}\nResult: paid ${p.costSol.toFixed(4)} SOL, got back ${p.realizedSol.toFixed(4)} SOL · peak ${p.peakMult.toFixed(2)}× · held ${Math.max(1, Math.round((Date.now() - p.openedAt) / 60_000))} min${tx ? `\nTx: ${tx}` : ''}`,
        solUsd,
      );
    } else
      void tellWithCard(
        tok,
        p,
        `${d.mult.toFixed(2)}× — profit taken`,
        `✅ ${p.symbol} at ${d.mult.toFixed(2)}× (${tag}) — ${d.why}\nBanked so far: ${p.realizedSol.toFixed(4)} SOL of ${p.costSol.toFixed(4)} paid · still holding ${Math.round((p.left / p.tokens) * 100)}%${tx ? `\nTx: ${tx}` : ''}`,
        solUsd,
      );
  }

  /** Sell a position now (the panel's button). */
  sellNow(id: string) {
    const p = useSwarm.getState().positions.find((x) => x.id === id);
    const { tokens, solUsd } = useMeme.getState();
    const tok = p ? tokens[p.mint] : undefined;
    if (!p || p.closedAt || p.pending) return;
    const mult = tok ? multiple(p, tok, solUsd) : NaN;
    const d: ExitDecision = { share: 1, why: 'sold by you', mult: Number.isFinite(mult) ? mult : 0, tp: false };
    if (p.live) void this.liveSell(p, d);
    else if (tok) {
      const sol = Number.isFinite(mult) ? p.left * p.entryPx * mult * 0.98 : 0;
      applySell(p, Date.now(), p.left, sol, d.why, d.mult, true);
      this.afterSell(p, d);
      useSwarm.setState((s) => ({ positions: [...s.positions] }));
    }
  }

  /** Socials from the coin's metadata file (fetched only for coins worth a look). */
  private fetchMeta(tok: MemeToken) {
    if (tok.meta || !tok.uri || this.metaInFlight >= 2) return;
    const url = tok.uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${tok.uri.slice(7)}` : tok.uri;
    if (!/^https:\/\//.test(url)) {
      tok.meta = { fetchedAt: Date.now(), error: 'no https metadata' };
      return;
    }
    this.metaInFlight++;
    fetchJson(url)
      .then((m: any) => {
        tok.meta = { twitter: m?.twitter || undefined, telegram: m?.telegram || undefined, website: m?.website || undefined, description: typeof m?.description === 'string' ? m.description.slice(0, 280) : undefined, fetchedAt: Date.now() };
        if (!tok.image && typeof m?.image === 'string') tok.image = m.image;
      })
      .catch((e) => (tok.meta = { fetchedAt: Date.now(), error: String(e?.message ?? e) }))
      .finally(() => this.metaInFlight--);
  }

  tick(now = Date.now()) {
    const sw = useSwarm.getState();
    const { tokens, solUsd } = useMeme.getState();
    const all = Object.values(tokens);
    // Scout: what is new
    for (const tok of all) {
      if (this.seen.has(tok.mint)) continue;
      this.seen.add(tok.mint);
      this.seenTimes.push(now);
      this.narratives.add(tok.mint, tok.name, tok.symbol, tok.createdAt);
      if (tok.creator) {
        const r = this.creators.get(tok.creator) ?? { launches: 0, rugs: 0 };
        r.launches++;
        this.creators.set(tok.creator, r);
      }
    }
    this.narratives.prune(now);
    this.seenTimes = this.seenTimes.filter((t) => now - t < 60_000);
    const leaderOf = (mints: string[]) => {
      let best: string | null = null;
      let cap = -1;
      for (const m of mints) {
        const t = tokens[m];
        if (t && t.mcapSol > cap) {
          cap = t.mcapSol;
          best = m;
        }
      }
      return best;
    };

    const reads: CoinRead[] = [];
    const tally = { checked: 0, pass: 0, watch: 0, reject: 0 };
    // reasons grouped with their numbers ignored; shown as the first one seen
    const why = new Map<string, { text: string; n: number }>();
    let scored = 0;
    let viral = 0;
    const open = sw.positions.filter((p) => !p.closedAt);
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const lostToday = -sw.positions.filter((p) => p.closedAt && p.closedAt >= dayStart).reduce((a, p) => a + pnlSol(p, tokens[p.mint], solUsd), 0);
    const newPositions: Position[] = [];
    const newOutcomes: Outcome[] = [];

    for (const tok of all) {
      const a = assess(tok, now, solUsd);
      // only coins with something going on are worth the bots' time
      if (tok.trades.length < 3 && !tok.dex) continue;
      const v = sentinel(tok, now, tok.creator ? this.creators.get(tok.creator) : undefined);
      tally.checked++;
      tally[v.verdict]++;
      if (v.verdict !== 'pass' && v.reasons[0]) {
        const key = v.reasons[0].replace(/\d+(\.\d+)?%?/g, '#');
        const g = why.get(key) ?? { text: v.reasons[0], n: 0 };
        g.n++;
        why.set(key, g);
      }
      // a rejected coin's creator is remembered for their next launch
      if (v.verdict === 'reject' && tok.creator && !this.rugged.has(tok.mint) && /dumped|sold|bundled|idle|wash/.test(v.reasons.join(' '))) {
        this.rugged.add(tok.mint);
        const r = this.creators.get(tok.creator);
        if (r) r.rugs++;
      }
      const prev = this.verdicts.get(tok.mint);
      if (prev !== v.verdict && a.heat >= 50) {
        if (v.verdict === 'reject' && prev) this.say('sentinel', `${tok.symbol}: rejected — ${v.reasons[0]}`, tok.mint);
        else if (v.verdict === 'pass' && prev === 'watch') this.say('sentinel', `${tok.symbol}: cleared — on-chain checks and early buyers look clean (viability ${v.score})`, tok.mint);
      }
      this.verdicts.set(tok.mint, v.verdict);
      // the on-chain check for anything with heat and no check yet
      if (!tok.safety && a.heat >= 35) scanner.check(tok.mint);
      let x: Virality | null = null;
      if (v.verdict !== 'reject') {
        if (a.heat >= 35) this.fetchMeta(tok);
        x = herald(tok, now, this.narratives, leaderOf);
        scored++;
        if (x.score >= 60) viral++;
      }
      const d = x ? strategist(tok, a, v, x, sw.strategy) : { enter: false, conviction: 0, why: `rejected: ${v.reasons[0] ?? ''}` };
      if (a.heat >= 30 || d.enter) reads.push({ mint: tok.mint, symbol: tok.symbol, heat: a.heat, viability: v, virality: x, conviction: d.conviction, decision: d.why, enter: d.enter, mcapUsd: a.mcapUsd });

      if (d.enter && !this.traded.has(tok.mint)) {
        this.traded.add(tok.mint);
        newOutcomes.push(newOutcome({ mint: tok.mint, symbol: tok.symbol, t0: now, mcap0: tok.mcapSol, kind: 'pick', conviction: d.conviction, heat: a.heat, virality: x!.score, viability: v.score }));
        scanner.pin(tok.mint);
        this.say('strategist', `${tok.symbol}: PICK (conviction ${d.conviction}) — ${d.why}`, tok.mint);
        // buys still in flight count as open
        const room = open.length + newPositions.length + this.buying.size < sw.manager.maxOpen;
        const budget = lostToday < sw.manager.dailyLossSol;
        const mc = Number.isFinite(a.mcapUsd) ? ` at $${Math.round(a.mcapUsd).toLocaleString('en-US')} market cap` : '';
        if (room && budget && sw.mode === 'live') {
          const w = sw.wallet;
          if (!desktop || !w) this.say('manager', `${tok.symbol}: not bought — live mode needs the swarm wallet (Wallet tab)`, tok.mint);
          else if (!w.limits.armed) this.say('manager', `${tok.symbol}: not bought — live trading is not armed (Wallet tab)`, tok.mint);
          else if (!this.buying.has(tok.mint)) void this.liveBuy(tok, Math.min(sw.manager.sizeSol, w.limits.maxBuySol), d.why, d.conviction, mc);
        } else if (room && budget) {
          const p = openPosition(tok, sw.manager.sizeSol, now, solUsd, d.why, d.conviction);
          if (p) {
            newPositions.push(p);
            this.say('manager', `${tok.symbol}: bought ${p.costSol} SOL (paper)${mc}`, tok.mint);
            void tellWithCard(tok, p, `Bought — ${p.costSol} SOL (paper)`, `🐝 Swarm bought ${tok.symbol} (paper)${mc}\nWhy: ${d.why}\nPlan: ${this.plan()}`, solUsd);
          }
        } else this.say('manager', `${tok.symbol}: not bought — ${room ? `daily loss limit (${sw.manager.dailyLossSol} SOL) reached` : `${sw.manager.maxOpen} positions already open`}`, tok.mint);
      } else if (!d.enter && v.verdict === 'pass' && a.heat >= 30 && !this.traded.has(tok.mint) && !this.controls.has(tok.mint) && now - this.lastControl > 30_000) {
        // the comparison sample: coins that passed but were not picked
        this.controls.add(tok.mint);
        this.lastControl = now;
        scanner.pin(tok.mint);
        newOutcomes.push(newOutcome({ mint: tok.mint, symbol: tok.symbol, t0: now, mcap0: tok.mcapSol, kind: 'control', conviction: d.conviction, heat: a.heat, virality: x?.score ?? 0, viability: v.score }));
      }
    }

    // Manager: every open position (paper fills at once; live sells wait for the chain)
    const positions = [...sw.positions, ...newPositions];
    for (const p of positions) {
      if (p.closedAt) continue;
      const tok = tokens[p.mint];
      if (!tok) continue;
      const dangers = assess(tok, now, solUsd).flags.filter((f) => f.level === 'danger').map((f) => f.text);
      if (p.live) {
        // a failed sell waits 15 s of wall-clock time (the sell itself can take a minute)
        if (p.pending || (p.retryAt && Date.now() < p.retryAt)) continue;
        const d = decideExit(p, tok, now, solUsd, sw.manager, dangers);
        if (d) void this.liveSell(p, d);
      } else {
        const tpBefore = p.tpDone;
        for (const f of managePosition(p, tok, now, solUsd, sw.manager, dangers)) {
          const pnl = pnlSol(p, tok, solUsd);
          this.say('manager', `${p.symbol}: sold ${f.sol.toFixed(3)} SOL — ${f.why}${p.closedAt ? ` · closed ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL` : ''}`, p.mint);
          if (p.closedAt || p.tpDone > tpBefore) this.afterSell(p, { share: 1, why: f.why, mult: f.mult, tp: p.tpDone > tpBefore && !p.closedAt });
        }
      }
      if (p.closedAt) scanner.pin(p.mint, false);
      // progress on Telegram as the price multiplies: 2×, 5×, 10×, 25×, 50×, 100× …
      const m = multiple(p, tok, solUsd);
      const hit = !p.closedAt && Number.isFinite(m) ? newMilestone(p, m) : null;
      if (hit) {
        const value = p.realizedSol + p.left * p.entryPx * m;
        this.say('manager', `${p.symbol}: ${hit}× — position worth ${value.toFixed(3)} SOL (paid ${p.costSol.toFixed(3)})`, p.mint);
        void tellWithCard(tok, p, `${m.toFixed(1)}× and running`, `🚀 ${p.symbol} is ${m.toFixed(2)}× (${p.live ? 'LIVE' : 'paper'})\nPosition: worth ${value.toFixed(4)} SOL · paid ${p.costSol.toFixed(4)} SOL · banked ${p.realizedSol.toFixed(4)} SOL\nNext: ${this.plan()}`, solUsd);
      }
    }

    // outcomes: follow each call for an hour
    const outcomes = [...sw.outcomes, ...newOutcomes];
    for (const o of outcomes) {
      if (o.done) continue;
      const tok = tokens[o.mint];
      follow(o, tok?.mcapSol ?? 0, Boolean(tok?.migrated), now);
      if (o.done && !positions.some((p) => p.mint === o.mint && !p.closedAt)) scanner.pin(o.mint, false);
    }

    const closed = positions.filter((p) => p.closedAt);
    const wins = closed.filter((p) => p.realizedSol > p.costSol).length;
    useSwarm.setState({
      positions,
      outcomes,
      reads: reads.sort((a, b) => b.conviction - a.conviction).slice(0, 60),
      stats: {
        scout: { seen: this.seen.size, perMin: this.seenTimes.length },
        sentinel: { ...tally, top: [...why.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((g) => ({ why: g.text, n: g.n })) },
        herald: { scored, viral, narratives: this.narratives.top(8) },
        strategist: { signals: positions.length, last: sw.stats.strategist.last },
        manager: {
          open: positions.filter((p) => !p.closedAt).length,
          closed: closed.length,
          pnlSol: positions.reduce((a, p) => a + pnlSol(p, tokens[p.mint], solUsd), 0),
          winRate: closed.length ? wins / closed.length : null,
        },
      },
    });
  }
}

export const swarm = new Swarm();

/** Start the swarm when it was left on, and follow the on/off switch. */
export function startSwarmService() {
  swarm.sync();
  useSwarm.subscribe((s, p) => s.enabled !== p.enabled && swarm.sync());
}

export { multiple };
