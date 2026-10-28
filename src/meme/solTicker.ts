// SOL in USD, live: Binance's 24 h mini-ticker for SOLUSDT (about one update
// a second), with DexScreener's on-chain price (the scanner's) as the backup.
// The Command Center's top bar shows it, and while it is fresh it is also the
// SOL price the swarm values its coins with.
import { create } from 'zustand';
import { ManagedSocket } from '../exchanges/ws';
import { useMeme } from './scanner';

export const SOL_TICKER_WS = 'wss://stream.binance.com:9443/ws/solusdt@miniTicker';

export interface SolTicker {
  price: number;
  open: number;
  high: number;
  low: number;
  /** 24 h volume in USD */
  volUsd: number;
  at: number;
  source: 'Binance' | 'DexScreener' | '';
  state: string;
  /** a price every 5 s, the last 10 minutes */
  spark: number[];
}

export const useSolTicker = create<SolTicker>(() => ({ price: 0, open: 0, high: 0, low: 0, volUsd: 0, at: 0, source: '', state: 'idle', spark: [] }));

/** A Binance miniTicker message, or null when it is something else. */
export function parseMiniTicker(m: unknown): Pick<SolTicker, 'price' | 'open' | 'high' | 'low' | 'volUsd'> | null {
  const x = m as Record<string, string> | null;
  if (!x || x.e !== '24hrMiniTicker') return null;
  const price = Number(x.c);
  if (!(price > 0)) return null;
  return { price, open: Number(x.o), high: Number(x.h), low: Number(x.l), volUsd: Number(x.q) };
}

let users = 0;
let sock: ManagedSocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function start() {
  sock = new ManagedSocket({
    url: SOL_TICKER_WS,
    staleMs: 30_000,
    onMessage: (m) => {
      const t = parseMiniTicker(m);
      if (!t) return;
      useSolTicker.setState({ ...t, at: Date.now(), source: 'Binance' });
      useMeme.setState({ solUsd: t.price });
    },
    onState: (state, err) => useSolTicker.setState({ state: state === 'error' && err ? `error: ${err}` : state }),
  });
  void sock.connect();
  timer = setInterval(() => {
    const s = useSolTicker.getState();
    // Binance quiet or blocked: fall back to the scanner's on-chain price
    if (Date.now() - s.at > 20_000) {
      const px = useMeme.getState().solUsd;
      if (px > 0) useSolTicker.setState({ price: px, source: 'DexScreener', at: Date.now() });
    }
    const p = useSolTicker.getState().price;
    if (p > 0) useSolTicker.setState((x) => ({ spark: [...x.spark.slice(-119), p] }));
  }, 5_000);
}

/** Components call this while they show the ticker. */
export function solTickerFeed() {
  if (users++ === 0) start();
  return () => {
    if (--users > 0) return;
    sock?.close();
    sock = null;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
