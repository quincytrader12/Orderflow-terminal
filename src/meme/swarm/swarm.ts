// The swarm: five bots working the meme-coin chain together, every two seconds.
//
//   Scout      — every launch, migration and DexScreener listing (the scanner)
//   Sentinel   — viability: rejects the rugs, bundles, dumps and wash trades
//   Herald     — virality: new wallets arriving, the meme's narrative, socials
//   Strategist — enters when heat, virality and viability all line up
//   Manager    — runs the trade: take profits, trailing stop, stop loss, rug exits
//
// Trades are on paper until live execution through Phantom is added. Every
// pick (and a sample of passed-but-not-picked coins) is followed for an hour,
// so the hit rates per conviction level show whether the strategy works.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { fetchJson } from '../../exchanges/ws';
import { escapeHtml } from '../../shared/telegram';
import { getSettings } from '../../store/settings';
import { telegram } from '../../desktop/telegram';
import { scanner, useMeme } from '../scanner';
import { assess } from '../score';
import type { MemeToken } from '../token';
import { herald, Narratives, sentinel, strategist, STRATEGY_DEFAULTS, type CreatorRecord, type StrategyConfig, type Viability, type Virality } from './agents';
import { managePosition, MANAGER_DEFAULTS, multiple, openPosition, pnlSol, type ManagerConfig, type Position } from './book';
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

interface SwarmState {
  enabled: boolean;
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

export const useSwarm = create<SwarmState>()(
  persist(
    (set) => ({
      enabled: false,
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
      partialize: (s) => ({ enabled: s.enabled, strategy: s.strategy, manager: s.manager, positions: s.positions.slice(-300), outcomes: s.outcomes.slice(-2000) }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SwarmState>;
        return { ...current, ...p, strategy: { ...STRATEGY_DEFAULTS, ...p.strategy }, manager: { ...MANAGER_DEFAULTS, ...p.manager } };
      },
    },
  ),
);

const TICK_MS = 2000;

class Swarm {
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
      for (const p of useSwarm.getState().positions) if (!p.closedAt) scanner.pin(p.mint);
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.say('scout', 'Swarm on — watching every pump.fun launch, migration and DexScreener listing (paper trading).');
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.release?.();
      this.release = null;
      this.say('scout', 'Swarm off.');
    }
  }

  private say(agent: AgentId, text: string, mint?: string) {
    useSwarm.setState((s) => ({ log: [...s.log.slice(-199), { t: Date.now(), agent, text, mint }] }));
  }

  private tell(text: string) {
    const s = getSettings();
    if (!s.telegramBotStory || !s.telegramSecretId) return;
    const [head, ...rest] = text.split('\n');
    telegram.send(s.telegramSecretId, [`<b>${escapeHtml(head)}</b>`, ...rest.map(escapeHtml)].join('\n')).catch(() => undefined);
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
        const room = open.length + newPositions.length < sw.manager.maxOpen;
        const budget = lostToday < sw.manager.dailyLossSol;
        if (room && budget) {
          const p = openPosition(tok, sw.manager.sizeSol, now, solUsd, d.why, d.conviction);
          if (p) {
            newPositions.push(p);
            const mc = Number.isFinite(a.mcapUsd) ? ` at $${Math.round(a.mcapUsd).toLocaleString('en-US')} market cap` : '';
            this.say('manager', `${tok.symbol}: bought ${p.costSol} SOL (paper)${mc}`, tok.mint);
            this.tell(`🐝 Swarm bought ${tok.symbol} (paper)${mc}\nWhy: ${d.why}\nPlan: ${sw.manager.takeProfits.map((t) => `sell ${Math.round(t.sell * 100)}% at ${t.at}×`).join(', ')}, trail ${Math.round(sw.manager.trail * 100)}% from the peak, stop −${Math.round(sw.manager.stopLoss * 100)}%`);
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

    // Manager: every open position
    const positions = [...sw.positions, ...newPositions];
    for (const p of positions) {
      if (p.closedAt) continue;
      const tok = tokens[p.mint];
      if (!tok) continue;
      const dangers = assess(tok, now, solUsd).flags.filter((f) => f.level === 'danger').map((f) => f.text);
      for (const f of managePosition(p, tok, now, solUsd, sw.manager, dangers)) {
        const pnl = pnlSol(p, tok, solUsd);
        this.say('manager', `${p.symbol}: sold ${f.sol.toFixed(3)} SOL — ${f.why}${p.closedAt ? ` · closed ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL` : ''}`, p.mint);
        if (p.closedAt) {
          scanner.pin(p.mint, false);
          this.tell(`${pnl >= 0 ? '💰' : '🔻'} Swarm closed ${p.symbol} (paper) ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL (${(((p.realizedSol / p.costSol) - 1) * 100).toFixed(0)}%)\nWhy: ${f.why}\nPeak ${p.peakMult.toFixed(2)}× · held ${Math.max(1, Math.round((now - p.openedAt) / 60_000))} min`);
        }
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
