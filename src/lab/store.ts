// The Strategy Lab in the terminal: its state from the desktop process (the
// research runs there, in a worker), the last result, and the deployed list.
import { create } from 'zustand';
import { desktop, type FarmView } from '../desktop/bridge';
import type { StrategySpec } from './backtest';
import type { DeciderTest, Diag, Parts, Periods, ResearchResult } from './research';
import type { MonteCarlo, Perf } from './stats';

export interface LabConfig {
  coins: string[];
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  years: number;
  source: 'auto' | 'binance' | 'okx' | 'bybit' | 'hyperliquid';
  isShare: number;
  combos: number;
  sides: 'both' | 'long';
  feeBps: number;
  slipBps: number;
  meta: boolean;
  funding: boolean;
}

export interface LabDeployed {
  id: string;
  name: string;
  spec: StrategySpec;
  tfH: number;
  coins: string[];
  targets: { crypto: boolean; meme: boolean };
  stats: { sharpe: number; t: number; dsr: number; trades: number; verdict: string; winRate?: number; avgR?: number; perYear?: number; maxDD?: number };
  deployedAt: number;
  on: boolean;
  /** council: the swarm's council can block its signals · tested: only the safety bots (Guardian, Risk) can */
  authority?: Authority;
  /** its size: ¼ on probation (a new deployment, or one that fell behind), 1 once its live trades matched its test */
  scale?: number;
  probation?: { since: number; why?: string } | null;
  graduatedAt?: number;
  /** switched off by you, or paused by the health check (you are asked on the phone) */
  pausedBy?: 'you' | 'health' | null;
  /** its settings were re-tuned (with your tap) */
  retunedAt?: number;
  retuneNote?: string;
}
export type Authority = 'council' | 'tested';

export interface LabStatus {
  running: boolean;
  progress: { stage: string; done: number; total: number } | null;
  error: string | null;
  cfg: LabConfig;
  deployed: LabDeployed[];
  last: { at: number; trials: number; top: number; verdicts: string[] } | null;
  /** the fees and slippage every test charges: assumed, or raised to what your live trades measured */
  costs?: { feeBps: number; slipBps: number; measured: boolean; n: number; why: string };
}

export interface LabTest {
  is: Perf;
  oos: Perf;
  curve: { t: number; eq: number; bh: number }[];
  trades: number;
  mc: MonteCarlo | null;
  /** the unseen trades' results in R */
  rs?: number[];
  /** the unseen data by month (or week) */
  periods?: Periods;
  /** how its trades went on the training years */
  diag?: Diag;
  /** buy-and-hold over the unseen period */
  bh?: Perf;
  perCoin?: { coin: string; oos: Perf }[];
  /** the spec as tested (with the AI trade filter's model when it was kept) */
  spec?: StrategySpec;
  meta?: { used: boolean; before: number; after: number; trainedOn: number; kind?: 'forest' | 'nn' | 'both'; val?: { before: number; after: number; trades: number } | null } | null;
  /** each decision maker (forest, neural network, both) measured on the unseen data */
  deciders?: DeciderTest[];
  /** the parts of a combined strategy: each rule alone, how the rules relate, what each filter adds */
  parts?: Parts | null;
  /** Kelly sizing: the full Kelly fraction found in sample and the half used */
  kelly?: { f: number; target: number; trades: number } | null;
  /** when the unseen (out-of-sample) period starts, and the years of history tested */
  split?: number;
  years?: number;
}

interface LabStore {
  status: LabStatus | null;
  result: ResearchResult | null;
  loaded: boolean;
  /** the edge finder: the strategy farm running in the desktop process */
  farm: FarmView | null;
}

export const useLab = create<LabStore>(() => ({ status: null, result: null, loaded: false, farm: null }));

const api = () => desktop?.lab;

let linked = false;
/** follow the desktop process's Lab (once per window) */
export function startLabLink() {
  const L = api();
  if (!L || linked) return;
  linked = true;
  L.state()
    .then((status) => useLab.setState({ status, loaded: true }))
    .catch(() => useLab.setState({ loaded: true }));
  L.result()
    .then((result) => useLab.setState({ result }))
    .catch(() => {});
  L.onState((status) => useLab.setState({ status }));
  L.onEvent((e) => {
    if (e.kind === 'done') void L.result().then((result) => useLab.setState({ result }));
  });
  if (L.farm) {
    L.farm
      .state()
      .then((farm) => useLab.setState({ farm }))
      .catch(() => {});
    // only what changed arrives (see farmPush in lab.mjs): merged, so the lists that did not change keep their identity and are not redrawn
    L.farm.onState((part) => useLab.setState((s) => ({ farm: s.farm ? ({ ...s.farm, ...part } as FarmView) : (part as FarmView) })));
  }
}

export const labApi = api;
