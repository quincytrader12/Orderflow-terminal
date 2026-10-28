// The live meme-coin scanner: one PumpPortal socket for every pump.fun launch,
// migration and the trades of the coins worth following; DexScreener polled
// for boosted / newly listed Solana coins and pool data; SOL in USD; and
// on-chain safety checks queued against the Solana RPC (public RPCs are slow
// and rate-limited, so one at a time).
import { create } from 'zustand';
import { desktop } from '../desktop/bridge';
import { fetchJson, ManagedSocket } from '../exchanges/ws';
import { DEFAULT_RPC } from '../shared/solana';
import { getSettings } from '../store/settings';
import { dexListings, dexTokens, solPriceUsd, type DexListing } from './dexscreener';
import { parsePumpMessage, pumpSub, PUMPPORTAL_WS, vTokensAtMcap, type PumpEvent } from './pump';
import { checkSafety, type Rpc } from './safety';
import { assess } from './score';
import { applyTrade, tokenFromCreate, type MemeToken } from './token';

export interface ScannerState {
  tokens: Record<string, MemeToken>;
  solUsd: number;
  feed: { pump: string; dex: string; rpc: string };
  selected: string | null;
  /** bumps when anything changed (renders are throttled to it) */
  version: number;
  select(mint: string | null): void;
}

export const useMeme = create<ScannerState>((set) => ({
  tokens: {},
  solUsd: 0,
  feed: { pump: 'idle', dex: 'idle', rpc: 'idle' },
  selected: null,
  version: 0,
  select: (mint) => {
    set({ selected: mint });
    if (mint) scanner.focus(mint);
  },
}));

/** Most coins followed trade by trade at once (PumpPortal: one socket, many keys). */
const MAX_FOLLOW = 80;
/** Most coins kept in memory. */
const MAX_TOKENS = 400;

const get = (url: string) => fetchJson(url);

const rpc: Rpc = async (method, params) => {
  if (desktop) return desktop.solana.rpc(method, params, getSettings().memeRpcSecretId || undefined);
  const res = await fetch(DEFAULT_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'RPC error');
  return j.result;
};

class Scanner {
  private users = 0;
  private sock: ManagedSocket | null = null;
  private followed = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private dirty = false;
  private safetyQueue: string[] = [];
  private checking = false;
  private listings = new Map<string, DexListing>();

  /** Panels call this on mount; the scanner runs while any is open. */
  use() {
    if (this.users++ === 0) this.start();
    return () => {
      if (--this.users === 0) this.stop();
    };
  }

  private start() {
    this.sock = new ManagedSocket({
      url: PUMPPORTAL_WS,
      staleMs: 60_000,
      onOpen: (ws) => {
        ws.send(pumpSub.newTokens());
        ws.send(pumpSub.migrations());
        if (this.followed.size) ws.send(pumpSub.trades([...this.followed]));
      },
      onMessage: (m) => this.onPump(parsePumpMessage(m)),
      onState: (st, err) => this.setFeed('pump', st === 'error' && err ? `error: ${err}` : st),
    });
    void this.sock.connect();
    void this.pollDex();
    void this.pollSol();
    this.timers.push(
      setInterval(() => void this.pollDex(), 30_000),
      setInterval(() => void this.pollSol(), 60_000),
      setInterval(() => this.housekeep(), 15_000),
      // renders at most twice a second, however busy the feed
      setInterval(() => {
        if (!this.dirty) return;
        this.dirty = false;
        useMeme.setState((s) => ({ version: s.version + 1 }));
      }, 500),
    );
  }

  private stop() {
    this.sock?.close();
    this.sock = null;
    this.followed.clear();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private setFeed(k: keyof ScannerState['feed'], v: string) {
    useMeme.setState((s) => ({ feed: { ...s.feed, [k]: v } }));
  }

  private put(tok: MemeToken) {
    useMeme.getState().tokens[tok.mint] = tok;
    this.dirty = true;
  }

  onPump(ev: PumpEvent | null) {
    if (!ev) return;
    const tokens = useMeme.getState().tokens;
    if (ev.kind === 'create') {
      if (tokens[ev.mint]) return;
      this.put(tokenFromCreate(ev));
      this.follow(ev.mint);
    } else if (ev.kind === 'trade') {
      let tok = tokens[ev.mint];
      if (!tok && this.watching.has(ev.mint)) {
        // a coin opened by its address: its trades are the first we hear of it
        tok = this.blank(ev.mint, 'pump', ev.mcapSol);
        this.put(tok);
      }
      if (!tok) return;
      applyTrade(tok, ev);
      this.dirty = true;
    } else {
      const tok = tokens[ev.mint];
      if (tok) {
        tok.migrated = true;
        tok.migratedAt = ev.t;
        tok.pool = ev.pool;
        this.dirty = true;
        // its pool appears on DexScreener shortly
        setTimeout(() => void this.refreshDex([ev.mint]), 60_000);
      }
    }
  }

  private follow(mint: string) {
    if (this.followed.has(mint)) return;
    if (this.followed.size >= MAX_FOLLOW) this.dropOne();
    this.followed.add(mint);
    this.sock?.send(pumpSub.trades([mint]));
  }

  private unfollow(mints: string[]) {
    if (!mints.length) return;
    for (const m of mints) this.followed.delete(m);
    this.sock?.send(pumpSub.untrades(mints));
  }

  /** Stop following the least interesting coin (never the selected one). */
  private dropOne() {
    const { tokens, selected, solUsd } = useMeme.getState();
    const now = Date.now();
    let worst: string | null = null;
    let low = Infinity;
    for (const m of this.followed) {
      if (m === selected) continue;
      const tok = tokens[m];
      const h = tok ? assess(tok, now, solUsd).heat - (now - tok.lastTradeAt) / 60_000 : -Infinity;
      if (h < low) {
        low = h;
        worst = m;
      }
    }
    if (worst) this.unfollow([worst]);
  }

  private watching = new Set<string>();

  /** A coin opened by its mint address: pool data from DexScreener, trades from pump.fun. */
  watchMint(mint: string) {
    this.watching.add(mint);
    this.follow(mint);
    void this.refreshDex([mint]).catch(() => undefined);
    this.queueSafety(mint, true);
  }

  private blank(mint: string, source: 'pump' | 'dex', mcapSol: number): MemeToken {
    const now = Date.now();
    return {
      mint,
      name: '',
      symbol: '',
      createdAt: now,
      source,
      pool: source === 'pump' ? 'pump' : '',
      vTokens: source === 'pump' ? vTokensAtMcap(mcapSol) : 0,
      vSol: 0,
      mcapSol,
      firstMcapSol: mcapSol,
      migrated: source === 'dex',
      devInitialSol: 0,
      devInitialTokens: 0,
      trades: [],
      lastTradeAt: now,
      progressMarks: [],
    };
  }

  /** The user opened a coin: follow its trades and check it on-chain first. */
  focus(mint: string) {
    const tok = useMeme.getState().tokens[mint];
    if (tok?.source === 'pump' || tok?.migrated) this.follow(mint);
    this.queueSafety(mint, true);
  }

  private housekeep() {
    const st = useMeme.getState();
    const now = Date.now();
    // quiet coins stop being followed; hot ones get checked on-chain
    const quiet: string[] = [];
    for (const m of this.followed) {
      const tok = st.tokens[m];
      if (!tok || (m !== st.selected && now - tok.lastTradeAt > 10 * 60_000)) quiet.push(m);
    }
    this.unfollow(quiet);
    const all = Object.values(st.tokens);
    for (const tok of all) if (!tok.safety && assess(tok, now, st.solUsd).heat >= 40) this.queueSafety(tok.mint);
    // memory: drop the oldest quiet coins beyond the cap
    if (all.length > MAX_TOKENS) {
      const drop = all
        .filter((t) => t.mint !== st.selected && !this.followed.has(t.mint))
        .sort((a, b) => a.lastTradeAt - b.lastTradeAt)
        .slice(0, all.length - MAX_TOKENS);
      for (const t of drop) delete st.tokens[t.mint];
      if (drop.length) this.dirty = true;
    }
  }

  private async pollSol() {
    try {
      useMeme.setState({ solUsd: await solPriceUsd(get) });
    } catch {
      /* keep the last price */
    }
  }

  private async pollDex() {
    try {
      const list = await dexListings(get);
      for (const l of list) this.listings.set(l.mint, l);
      // newly listed coins, plus pools for coins that have migrated
      const st = useMeme.getState();
      const migrated = Object.values(st.tokens)
        .filter((t) => t.migrated)
        .map((t) => t.mint);
      await this.refreshDex([...new Set([...list.map((l) => l.mint), ...migrated])].slice(0, 90));
      this.setFeed('dex', 'open');
    } catch (e) {
      this.setFeed('dex', `error: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private async refreshDex(mints: string[]) {
    if (!mints.length) return;
    const rows = await dexTokens(get, mints);
    const tokens = useMeme.getState().tokens;
    for (const r of rows) {
      const l = this.listings.get(r.mint);
      const pair = l?.links.length && !r.pair.socials.length ? { ...r.pair, socials: l.links } : r.pair;
      const tok = tokens[r.mint];
      // DexScreener lists pump.fun coins still on their curve as 'pumpfun'
      const onCurve = pair.dexId === 'pumpfun';
      if (tok) {
        tok.dex = pair;
        tok.image ??= pair.imageUrl ?? l?.icon;
        if (!tok.symbol) {
          tok.symbol = r.symbol;
          tok.name = r.name;
        }
        if (onCurve && !tok.trades.length) tok.createdAt = pair.pairCreatedAt ?? tok.createdAt;
      } else {
        const solUsd = useMeme.getState().solUsd;
        const mcapSol = solUsd > 0 ? pair.mcapUsd / solUsd : 0;
        const fresh = this.blank(r.mint, onCurve ? 'pump' : 'dex', mcapSol);
        Object.assign(fresh, { name: r.name, symbol: r.symbol, image: pair.imageUrl ?? l?.icon, createdAt: pair.pairCreatedAt ?? Date.now(), pool: onCurve ? 'pump' : pair.dexId, dex: pair });
        this.put(fresh);
        // on the curve: its trades come from pump.fun
        if (onCurve) this.follow(r.mint);
        this.queueSafety(r.mint);
      }
    }
    this.dirty = true;
  }

  private queueSafety(mint: string, first = false) {
    const tok = useMeme.getState().tokens[mint];
    if (!tok || (tok.safety && Date.now() - tok.safety.checkedAt < 10 * 60_000)) return;
    this.safetyQueue = this.safetyQueue.filter((m) => m !== mint);
    if (first) this.safetyQueue.unshift(mint);
    else this.safetyQueue.push(mint);
    void this.drainSafety();
  }

  private async drainSafety() {
    if (this.checking) return;
    this.checking = true;
    try {
      while (this.safetyQueue.length && this.users > 0) {
        const mint = this.safetyQueue.shift()!;
        const tok = useMeme.getState().tokens[mint];
        if (!tok) continue;
        const s = await checkSafety(rpc, mint, [tok.bondingCurve, tok.dex?.pairAddress]);
        tok.safety = s;
        this.setFeed('rpc', s.error ? `error: ${s.error}` : 'open');
        this.dirty = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      this.checking = false;
    }
  }
}

export const scanner = new Scanner();
