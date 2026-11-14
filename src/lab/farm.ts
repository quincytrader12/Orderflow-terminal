// The edge finder: a strategy farm that runs by itself.
//
// Every bot is treated as curve-fitted until it proves it is not. Bots are
// bred from the bot builder's own blocks — the Strategy Lab's rules and the
// Quant desk's models (GARCH, regimes, Kalman, VaR and volatility sizing, the
// bitcoin hedge, the neural network) — so every one of them opens in the bot
// builder as a chain of blocks. Each is:
//
//   1  trained   scored on the first 70 % of the history only (its fitness:
//                the Sharpe ratio there, marked down when one half of the
//                training years carried it, when few coins did, or when it
//                needs many blocks); the best breed the next generation
//                (selection, crossover, mutation, merging), new random bots
//                keep arriving, and the best of every KIND of bot is kept in
//                an archive of niches so the search does not collapse onto one
//                idea. The farm also learns which blocks have been working
//                and draws them more often.
//   2  holdout   then examined on the last 30 % it never saw: it must make
//                money there and do at least half as well as in training
//   3  steady    not one lucky stretch, coin or trade: in profit in two of the
//                three thirds of the unseen stretch, on at least half its
//                coins, and still in profit without its best 5 % of trades
//   4  costs     still in profit at double the fees and slippage
//   5  random    it must beat at least 75 of 100 random bots — the same
//                number of trades, held as long, entered at random
//   6  nudged    every setting is nudged one step each way; if fewer than half
//                of those versions still make money on the unseen data, it
//                was luck in its exact settings, and it is thrown out
//   7  shuffled  its trades are shuffled 1,000 times; if the unlucky orders
//                cause too deep a drawdown, it is thrown out
//   8  proof     the bar for "significant" rises with every bot that has
//                reached the unseen data (Benjamini–Hochberg: at most 1 in 10
//                of the bots called significant should be flukes). The rest
//                are candidates and must prove themselves forward.
//
// Survivors are then forward-tested on candles that arrive after they were
// found (data no test has seen at all) and climb the incubation ladder — new,
// incubating, proving, proven — or fade and drop out. The top five are the
// best that are still standing; deploying one is the user's call. The farm
// also picks THE TEAM: the survivors that fit together best as one portfolio
// (little correlated, weighted by risk), and measures how overfit its own
// search is (the probability of backtest overfitting, by combinatorially
// symmetric cross-validation over each generation).
//
// The selection is on the training years only; the unseen 30 % is a gate it
// passes or fails, never a score it is bred for. Every bot tried is counted,
// and the "chance it is real" of each survivor allows for all of them.
import {
  buildSpec,
  checkFlow,
  COMBINES,
  FORECASTS,
  HOLDS,
  MODELS,
  RISKS,
  STOP_WIDTHS,
  STRATEGIES,
  STYLE_MAP,
  TAKE_PROFIT,
  type Flow,
  type StyleId,
} from "./flow";
import {
  barsPerYear,
  ctxOf,
  SIGNAL_MAP,
  type Ctx,
  type Market,
  type Params,
} from "./library";
import { rngOf } from "./ml";
import {
  periodsOf,
  pool,
  runAll,
  withBench,
  type Periods,
} from "./research";
import {
  COSTS,
  backtest,
  regimeSide,
  type Costs,
  type StrategySpec,
} from "./backtest";
import {
  deflatedSharpe,
  monteCarlo,
  ncdf,
  pbo,
  perf,
  randomEntryTest,
  type Perf,
} from "./stats";

export interface FarmCfg {
  coins: string[];
  /** the trading styles bred (each needs its candles: 15 m, 1 h, 4 h, 1 d) */
  styles: StyleId[];
  sides: "both" | "long";
  /** gentle: uses about half of one processor core, so the terminal stays smooth; full: as fast as it can */
  pace: "gentle" | "full";
  /** the deepest drawdown allowed in the unlucky 1-in-20 shuffle, at 1 % risk a trade */
  maxDD: number;
  /** the version of these settings (2: scalping is bred beside intraday and swing) */
  v?: number;
}

/** the share of the history held back as the vault: the most recent candles, which no bot is bred or checked on */
export const VAULT = 0.15;

/** the paces a top five is kept for, and the bot builder's styles in each */
export const PACES: { id: string; name: string; styles: StyleId[] }[] = [
  { id: "scalp", name: "Scalping", styles: ["scalp15", "scalp"] },
  { id: "intraday", name: "Intraday", styles: ["intraday15", "intraday"] },
  { id: "swing", name: "Swing", styles: ["swing", "week"] },
  { id: "position", name: "Position", styles: ["position", "hold"] },
];
export const paceIdOf = (style: StyleId): string =>
  PACES.find((p) => p.styles.includes(style))?.id ?? "swing";
export const FARM_DEFAULTS: FarmCfg = {
  coins: ["BTC", "ETH", "SOL"],
  styles: ["scalp", "intraday", "swing"],
  sides: "both",
  pace: "gentle",
  maxDD: 0.2,
};

export type Stage =
  | "bred"
  | "trained"
  | "holdout"
  | "steady"
  | "costs"
  | "random"
  | "nudge"
  | "shuffle"
  | "vault"
  | "proof";
export const STAGES: { id: Stage; name: string; plain: string }[] = [
  {
    id: "bred",
    name: "Bred and trained",
    plain:
      "Every bot tried: built from the blocks, scored on the first 70 % of the history.",
  },
  {
    id: "trained",
    name: "Good enough in training",
    plain:
      "A training score of 0.7 or more: the Sharpe ratio on the training years, marked down when one half of them carried it, when few of the coins did, or when it needs many blocks.",
  },
  {
    id: "holdout",
    name: "Held up on the unseen 30 %",
    plain:
      "Made money on the last 30 % of the history it never saw, and at least half as well as in training.",
  },
  {
    id: "steady",
    name: "Not one lucky stretch, coin or trade",
    plain:
      "In profit in at least two of the three thirds of the unseen stretch, on at least half of its coins, and still in profit with its best 5 % of trades taken away.",
  },
  {
    id: "costs",
    name: "Survived double costs",
    plain:
      "Tested again on the unseen data with twice the fees and slippage: an edge that only exists at perfect prices is not an edge.",
  },
  {
    id: "random",
    name: "Beat 75 of 100 random bots",
    plain:
      "The same number of trades, held as long, entered at random: it had to beat at least 75 of them.",
  },
  {
    id: "nudge",
    name: "Survived its settings nudged",
    plain:
      "Every setting one step each way: at least half of those versions still made money on the unseen data.",
  },
  {
    id: "shuffle",
    name: "Survived 1,000 shuffles",
    plain:
      "Its trades in 1,000 random orders: the unlucky orders’ drawdown stayed within the limit.",
  },
  {
    id: "vault",
    name: "Made money in the vault",
    plain:
      "The most recent 15 % of the history is locked away: no bot is bred or checked on it. A bot that passes everything else is tested on it once — its first result on data nothing has seen. If it loses there, it is out, and so is its kind: one look each.",
  },
  {
    id: "proof",
    name: "Significant after every kind tried",
    plain:
      "The more ideas are tried, the better the luckiest of them looks — so the bar for “significant” rises with every kind of bot (pace, strategies, filters) that reaches the unseen data (Benjamini–Hochberg: of those called significant, at most 1 in 10 should be flukes). Copies of a kind are one idea, counted once. Those that miss the bar are candidates: listed, and tested on fresh data all the same.",
  },
];

export type Ladder = "new" | "incubating" | "proving" | "proven" | "faded";
export const LADDER: { id: Ladder; name: string; plain: string }[] = [
  {
    id: "new",
    name: "New",
    plain: "Just passed the gauntlet; no candles have arrived since.",
  },
  {
    id: "incubating",
    name: "Incubating",
    plain:
      "Trading on fresh candles that arrived after it was found: fewer than 5 trades so far.",
  },
  {
    id: "proving",
    name: "Proving",
    plain: "5 to 14 trades on fresh data, still making money.",
  },
  {
    id: "proven",
    name: "Proven",
    plain: "15 or more trades on fresh data, and still making money.",
  },
  {
    id: "faded",
    name: "Faded",
    plain:
      "Lost money on fresh data, or fell further than it ever did in testing: dropped.",
  },
];

export interface Forward {
  bars: number;
  trades: number;
  ret: number;
  sharpe: number;
  maxDD: number;
  /** months (or weeks) of fresh data */
  days: number;
}

export interface Survivor {
  id: string;
  key: string;
  flow: Flow;
  name: string;
  style: StyleId;
  tfH: number;
  coins: string[];
  /** when it passed the gauntlet, and the last candle it had seen then (its forward test starts after it) */
  foundAt: number;
  seenTo: number;
  is: Perf;
  oos: Perf;
  /** how many of 100 random bots it beat */
  beat: number;
  nudge: { kept: number; tried: number };
  mc: { dd95: number; pLoss: number };
  periods: Periods;
  /** the chance its unseen-data Sharpe is real, allowing for every bot tried before it */
  dsr: number;
  tried: number;
  score: number;
  forward: Forward | null;
  stage: Ladder;
  summary: string[];
  /** significant on the unseen data after allowing for every bot that reached it (false-discovery rate 10 %): the top five is drawn from these, and from those proven on fresh data */
  sig: boolean;
  /** the chance a bot with no edge would show this unseen result, and the same allowing for every bot that reached the unseen data (the q-value) */
  p?: number;
  q?: number;
  /** steady: thirds of the unseen stretch in profit, coins in profit, the total R without its best 5 % of trades; costs: the unseen Sharpe at double fees and slippage */
  checks?: {
    thirds: number;
    coinsUp: number;
    coins: number;
    noBest: number;
    cost2: number;
  };
  /** its return each day of the unseen stretch (how survivors fit together is read from these) */
  daily?: { d0: number; r: number[] };
  /** its result in the vault, the moment it was found (its fresh-data record starts with this) */
  vault?: { bars: number; trades: number; ret: number; days: number };
  /** the equity curve over the whole history, thinned (for the panel) */
  curve: number[];
  split: number;
}

export interface Reject {
  name: string;
  at: Stage;
  why: string;
  t: number;
}

export interface FleetItem {
  id: string;
  name: string;
  tfH: number;
  coins: string[];
  status: "no data" | "watching" | "healthy" | "slipping" | "fading";
  forward: Forward | null;
  tested: number;
  text: string;
  /** a top-five strategy at the same pace that could replace it */
  replace: string | null;
}

export interface FarmState {
  running: boolean;
  cfg: FarmCfg;
  startedAt: number;
  gen: number;
  tried: number;
  /** bots tried a minute, recently */
  rate: number;
  population: number;
  funnel: Record<Stage, number>;
  ladder: Record<Ladder, number>;
  top: Survivor[];
  /** passed the video's four checks but not (yet) significant: forward-tested, promoted if they prove themselves */
  watch: Survivor[];
  survivors: number;
  recent: Reject[];
  fleet: FleetItem[];
  /** the newest candle in the data, and when the data was loaded */
  dataTo: number;
  dataAt: number;
  note: string;
  error: string;
  /** bots that reached the unseen data (the count the significance bar allows for) */
  entrants?: number;
  /** how overfit the search is: the probability of backtest overfitting over recent generations (null until measured) */
  pbo?: number | null;
  /** kinds of bot kept in the archive (pace × families of strategy × sides) */
  niches?: number;
  /** the blocks that have been working: tried, trained well enough to face the gauntlet, survived it */
  blocks?: BlockStat[];
  /** the survivors that fit together best as one portfolio */
  team?: Team | null;
  /** the five best still standing at each pace: proven on fresh data first, then significant, then by score */
  tops?: PaceBoard[];
  /** bots that trained well but are copies of a kind already held or already ruled out: not tested again */
  dupes?: number;
  /** kinds of bot that reached the unseen data (what the significance bar allows for) */
  kinds?: number;
  /** how the candles are doing (set by the desktop service): stale or missing markets, and when it tries again */
  data?: {
    ok: boolean;
    stale: string[];
    missing: string[];
    error: string;
    tries: number;
    lastOkAt: number;
    checkedAt: number;
    nextTryAt: number;
  } | null;
}

export interface PaceBoard {
  id: string;
  name: string;
  rows: Survivor[];
  /** survivors held at this pace, and how many are still standing */
  held: number;
  live: number;
}

export interface BlockStat {
  id: string;
  kind: "strategy" | "model" | "join" | "risk";
  name: string;
  tried: number;
  passed: number;
  survived: number;
}

export interface Team {
  members: {
    id: string;
    name: string;
    /** its share of the risk (inverse volatility) */
    weight: number;
    /** its Sharpe ratio alone, on the team's days */
    sharpe: number;
    /** what is needed to open it in the bot builder or deploy it */
    flow: Flow;
    tfH: number;
    coins: string[];
    stage: Ladder;
    sig: boolean;
    oos: { sharpe: number; t: number; trades: number };
    dsr: number;
  }[];
  /** the team as one portfolio over the days every member has */
  sharpe: number;
  maxDD: number;
  /** a year's return at the members' tested sizes */
  ret: number;
  /** the average correlation between members' daily results */
  corr: number;
  days: number;
  /** the best member alone over the same days */
  solo: { name: string; sharpe: number; maxDD: number };
}

/** what is saved between sessions */
export interface FarmSave {
  v: 1 | 2 | 3;
  cfg: FarmCfg;
  gen: number;
  tried: number;
  funnel: Record<Stage, number>;
  survivors: Survivor[];
  population: Flow[];
  seen: string[];
  startedAt: number;
  recent: Reject[];
  /** block → [tried, passed training, survived] */
  stats?: Record<string, [number, number, number]>;
  /** the best bot of each niche */
  archive?: { flow: Flow; fit: number }[];
  pbo?: number[];
  /** kinds that had their one look at the vault and lost, or faded on fresh data (hashed) */
  burned?: string[];
  /** kinds that reached the unseen data (hashed) */
  entered?: string[];
  dupes?: number;
  kindsFloor?: number;
}

const keyOf = (f: Flow) =>
  JSON.stringify([
    f.style,
    // “setup, then trigger” depends on which strategy comes first
    f.combine === "then" ? f.strategies : [...f.strategies].sort(),
    f.strategies.length > 1 ? f.combine : "",
    [...f.models].sort(),
    [...f.forecasts].sort(),
    [...f.risks].sort(),
    f.stopWidth,
    f.takeProfit,
    f.hold,
    f.sides,
    f.flip,
    f.tunes ?? null,
  ]);
const familyOf = (f: Flow) =>
  JSON.stringify([f.style, [...f.strategies].sort(), [...f.models].sort()]);

const famOfStrategy = (id: string) => {
  const o = STRATEGIES.find((s) => s.id === id);
  return (o && SIGNAL_MAP[o.signal]?.family) ?? "trend";
};
/** the kind of bot: its pace, the families of its strategies, the sides it trades */
const nicheOf = (f: Flow) =>
  `${f.style}|${[...new Set(f.strategies.map(famOfStrategy))].sort().join("+")}|${f.sides}`;

/** the blocks a bot is made of, as keys for what the farm learns about them */
const blockKeys = (f: Flow): string[] => [
  ...f.strategies.map((id) => `strategy:${id}`),
  ...f.models.map((id) => `model:${id}`),
  ...f.risks.map((id) => `risk:${id}`),
  ...(f.strategies.length > 1 ? [`join:${f.combine}`] : []),
];

/** a short fingerprint of a kind (two 32-bit FNV-1a hashes) */
const hash = (x: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5) + 0x9e3779b9;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
};
const kindOf = (f: Flow) => hash(familyOf(f));

const STAGE_RANK: Record<Ladder, number> = {
  proven: 4,
  proving: 3,
  incubating: 2,
  new: 1,
  faded: 0,
};

/** one pace's own population: the paces are bred side by side, so each has its own top five */
interface Island {
  style: StyleId;
  pop: Ind[];
  cursor: number;
  best: number;
  stale: number;
}

interface Ind {
  flow: Flow;
  key: string;
  fit: number;
  done: boolean;
}

/** the blocks a bot may be bred from, given the coins, the funding history and the candles */
interface Pool {
  strategies: string[];
  models: string[];
  forecasts: string[];
  risks: string[];
}

const ML = new Set(["nn", "rf", "ols", "candle"]);
/** a bot with a learned part: an AI strategy, or an AI second opinion */
const usesML = (f: Flow) =>
  f.strategies.some((s) => ML.has(s)) || f.forecasts.some((x) => x !== "kalman");
const TRAIN_MIN_SHARPE = 0.7;
/** the false-discovery rate allowed among the bots called significant */
const FDR = 0.1;

export class Farm {
  cfg: FarmCfg;
  private rnd: () => number;
  private ctxs: Record<string, Ctx[]> = {};
  /** the same markets with the models fitted on the first 70 % of the TRAINING bars only: the last 30 % of them scores a learned rule honestly */
  private inner: Record<string, Ctx[]> = {};
  private funding = false;
  private islands = new Map<StyleId, Island>();
  private cur: Island = {
    style: "intraday",
    pop: [],
    cursor: 0,
    best: -Infinity,
    stale: 0,
  };
  private turn = -1;
  private get pop(): Ind[] {
    return this.cur.pop;
  }
  private set pop(v: Ind[]) {
    this.cur.pop = v;
  }
  private get cursor(): number {
    return this.cur.cursor;
  }
  private set cursor(v: number) {
    this.cur.cursor = v;
  }
  private get best(): number {
    return this.cur.best;
  }
  private set best(v: number) {
    this.cur.best = v;
  }
  private get stale(): number {
    return this.cur.stale;
  }
  private set stale(v: number) {
    this.cur.stale = v;
  }
  /** the whole history (vault included), for the forward tests: the same models as the search's own, fitted on the same training bars */
  private fwd: Record<string, Ctx[]> = {};
  /** kinds that hold a survivor, kinds ruled out for good, and kinds that reached the unseen data */
  private heldKinds = new Set<string>();
  private burned = new Set<string>();
  private entered = new Set<string>();
  dupes = 0;
  /** a save from before kinds were counted: how many it is taken to have tried (its gauntlet entrants, 2,000 at most) */
  private kindsFloor = 0;
  /** the lists on the screen: worked out again on a steady clock, not at every bot */
  private board: { at: number; ids: Record<string, string[]> } | null = null;
  private boardDirty = true;
  private teamAt = 0;
  private seen = new Map<string, number>();
  private queue: Ind[] = [];
  survivors: Survivor[] = [];
  gen = 0;
  tried = 0;
  funnel: Record<Stage, number> = {
    bred: 0,
    trained: 0,
    holdout: 0,
    steady: 0,
    costs: 0,
    random: 0,
    nudge: 0,
    shuffle: 0,
    vault: 0,
    proof: 0,
  };
  recent: Reject[] = [];
  startedAt: number;
  private stamps: number[] = [];
  fleet: FleetItem[] = [];
  dataTo = 0;
  dataAt = 0;
  private costs: Costs;
  private stress: number;
  private now: () => number;
  /** what the farm has learned about each block: tried, trained well enough for the gauntlet, survived it */
  private stats = new Map<string, { n: number; pass: number; surv: number }>();
  /** the best bot of each kind (niche), kept across restarts of the population */
  private archive = new Map<string, { flow: Flow; fit: number }>();
  /** the latest bots that made money in training, by timeframe: each one's mean return in eight stretches of the training years (for the overfit meter) */
  private genBlocks: Record<string, number[][]> = {};
  private pboHist: number[] = [];
  private teamCache: Team | null = null;

  constructor(
    cfg: Partial<FarmCfg> = {},
    o: {
      seed?: number;
      now?: () => number;
      costs?: Costs;
      save?: FarmSave | null;
      /** the multiple of the fees and slippage a bot must survive (2) */
      stress?: number;
    } = {},
  ) {
    this.cfg = { ...FARM_DEFAULTS, ...cfg };
    this.now = o.now ?? Date.now;
    this.rnd = rngOf(o.seed ?? (this.now() % 1_000_000) + 7);
    this.costs = o.costs ?? COSTS;
    this.stress = o.stress ?? 2;
    this.startedAt = this.now();
    if (o.save && [1, 2, 3].includes(o.save.v)) this.restore(o.save);
  }

  // ---------- data ----------

  /**
   * The candles, by timeframe ('1h', '4h' …); called again with fresher
   * candles to forward-test the survivors.
   *
   * The most recent 15 % of each timeframe's history is the VAULT: it is cut
   * off before anything is bred, trained or put through the gauntlet, so no
   * choice the farm makes can lean on it. A bot that passes the gauntlet is
   * tested on it once — a fresh-data result the moment it is found, instead
   * of weeks later — and its forward test then carries on into the candles
   * that arrive. As new candles come in the vault moves forward with them.
   */
  setMarkets(byTf: Record<string, Market[]>) {
    this.ctxs = {};
    this.inner = {};
    this.fwd = {};
    // other candles: the stretches of the training years the overfit meter compares are no longer the same
    this.genBlocks = {};
    for (const [tf, ms] of Object.entries(byTf)) {
      const ok = ms.filter((m) => m.bars.length >= 500);
      if (!ok.length) continue;
      // one cut in time for every coin: where the longest history's last 15 % begins
      const longest = ok.reduce((a, b) =>
        b.bars.length > a.bars.length ? b : a,
      );
      const tCut =
        longest.bars[Math.floor(longest.bars.length * (1 - VAULT))].time;
      const short = ok
        .map((m) => {
          const i = m.bars.findIndex((b) => b.time >= tCut);
          const k = i < 0 ? m.bars.length : i;
          return {
            ...m,
            bars: m.bars.slice(0, k),
            funding: m.funding ? m.funding.slice(0, k) : m.funding,
          };
        })
        .filter((m) => m.bars.length >= 400);
      if (!short.length) continue;
      const names = new Set(short.map((m) => m.coin));
      const sB = withBench(short);
      const fB = withBench(ok.filter((m) => names.has(m.coin)));
      this.ctxs[tf] = sB.map((m, k) =>
        ctxOf(m, Math.floor(m.bars.length * 0.7), 42 + k),
      );
      this.inner[tf] = sB.map((m, k) =>
        ctxOf(m, Math.floor(Math.floor(m.bars.length * 0.7) * 0.7), 42 + k),
      );
      this.fwd[tf] = fB.map((m, k) =>
        ctxOf(m, this.ctxs[tf][k].trainEnd, 42 + k),
      );
    }
    this.funding = Object.values(byTf).some((ms) =>
      ms.some((m) => m.funding && m.funding.some((x) => x !== 0)),
    );
    this.dataTo = Math.max(
      0,
      ...Object.values(byTf).flatMap((ms) =>
        ms.map((m) => m.bars[m.bars.length - 1]?.time ?? 0),
      ),
    );
    this.dataAt = this.now();
    this.forwardAll();
  }

  /** the styles that can be bred with the candles there are */
  private styles(): StyleId[] {
    return this.cfg.styles.filter(
      (s) => STYLE_MAP[s] && this.ctxs[STYLE_MAP[s].timeframe]?.length,
    );
  }

  private pool(style: StyleId): Pool {
    const st = STYLE_MAP[style];
    const coins = (this.ctxs[st.timeframe] ?? []).map((c) =>
      c.m.coin.toUpperCase(),
    );
    const btcPair = coins.includes("BTC") && coins.some((c) => c !== "BTC");
    const strategies = STRATEGIES.filter((s) => {
      const sig = SIGNAL_MAP[s.signal];
      if (
        !sig ||
        (sig.intraday && st.tfH >= 24) ||
        (sig.needsFunding && !this.funding) ||
        (s.needsBtc && !btcPair)
      )
        return false;
      return true;
    }).map((s) => s.id);
    const models = MODELS.filter(
      (m) =>
        !(m.lean === "session" && st.tfH >= 24) &&
        !(m.lean === "crowd" && !this.funding),
    ).map((m) => m.id);
    const forecasts = FORECASTS.map((f) => f.id);
    const risks = RISKS.filter(
      (r) => r.id !== "kelly" && !(r.hedge && !btcPair),
    ).map((r) => r.id);
    return { strategies, models, forecasts, risks };
  }

  // ---------- breeding ----------

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)];
  }

  private some<T>(xs: readonly T[], n: number): T[] {
    const a = [...xs];
    const out: T[] = [];
    while (out.length < n && a.length)
      out.push(a.splice(Math.floor(this.rnd() * a.length), 1)[0]);
    return out;
  }

  // ---------- what the farm learns about its blocks ----------

  /**
   * How often a block is drawn. A block that keeps producing bots good enough
   * to face the gauntlet (and more so, survivors) is drawn more; one that has
   * had many tries and produced nothing is drawn less — never dropped, since
   * what fails alone may work in a combination not yet tried.
   */
  private weight(key: string): number {
    const st = this.stats.get(key);
    if (!st) return 1;
    return Math.max(0.15, Math.min(4, (10 * (st.pass + 2 * st.surv + 1)) / (st.n + 10)));
  }

  /** one of the ids, drawn by what the farm has learned about them */
  private pickW(ids: readonly string[], kind: string): string {
    const w = ids.map((id) => this.weight(`${kind}:${id}`));
    let x = this.rnd() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < ids.length; i++) {
      x -= w[i];
      if (x <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  private someW(ids: readonly string[], n: number, kind: string): string[] {
    const left = [...ids];
    const out: string[] = [];
    while (out.length < n && left.length) {
      const id = this.pickW(left, kind);
      out.push(id);
      left.splice(left.indexOf(id), 1);
    }
    return out;
  }

  private note(f: Flow, what: "n" | "pass" | "surv") {
    for (const k of blockKeys(f)) {
      const st = this.stats.get(k) ?? { n: 0, pass: 0, surv: 0 };
      st[what]++;
      this.stats.set(k, st);
    }
  }

  /** the blocks that have been working, best first */
  blocks(): BlockStat[] {
    const nameOf = (kind: string, id: string) =>
      kind === "strategy"
        ? STRATEGIES.find((x) => x.id === id)?.name
        : kind === "model"
          ? MODELS.find((x) => x.id === id)?.name
          : kind === "risk"
            ? RISKS.find((x) => x.id === id)?.name
            : COMBINES.find((x) => x.id === id)?.name;
    return [...this.stats.entries()]
      .map(([key, st]) => {
        const [kind, id] = key.split(":");
        return {
          id,
          kind: kind as BlockStat["kind"],
          name: nameOf(kind, id) ?? id,
          tried: st.n,
          passed: st.pass,
          survived: st.surv,
        };
      })
      .filter((b) => b.tried >= 5 && b.passed > 0)
      .sort(
        (a, b) =>
          b.survived - a.survived ||
          b.passed / b.tried - a.passed / a.tried,
      )
      .slice(0, 12);
  }

  /** how two or more strategies are joined: the regime switch when there is something to switch between */
  private joinFor(strategies: string[]): Flow["combine"] {
    if (strategies.length < 2) return "all";
    const sides = strategies.map((id) => regimeSide(famOfStrategy(id)));
    const canSwitch = sides.includes("trend") && sides.includes("range");
    const opts: Flow["combine"][] = canSwitch
      ? ["switch", "all"]
      : strategies.length > 2
        ? ["majority", "any", "then"]
        : ["all", "majority", "any", "then"];
    return this.pickW(opts, "join") as Flow["combine"];
  }

  /** a strategy's settings: each one from its published grid, or the style's default */
  private tuneFor(style: StyleId, id: string): Params | null {
    const opt = STRATEGIES.find((s) => s.id === id);
    const sig = opt && SIGNAL_MAP[opt.signal];
    if (!opt || !sig) return null;
    const base = opt.params(STYLE_MAP[style]);
    const out: Params = {};
    for (const [k, grid] of Object.entries(sig.grid))
      if (k in base && grid.length > 1 && this.rnd() < 0.5)
        out[k] = this.pick(grid);
    return Object.keys(out).length ? out : null;
  }

  /** a random bot built from the blocks */
  randomFlow(only?: StyleId): Flow | null {
    const styles = this.styles().filter((x) => !only || x === only);
    if (!styles.length) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const style = this.pick(styles);
      const P = this.pool(style);
      // the learned rules are slower: drawn less often
      const plain = P.strategies.filter((s) => !ML.has(s));
      const draw = () =>
        this.pickW(this.rnd() < 0.12 || !plain.length ? P.strategies : plain, "strategy");
      const u = this.rnd();
      const n = u < 0.5 ? 1 : u < 0.92 ? 2 : 3;
      const strategies = [...new Set(Array.from({ length: n }, draw))];
      const tunes: Record<string, Params> = {};
      for (const s of strategies) {
        const t = this.tuneFor(style, s);
        if (t) tunes[`strategy:${s}`] = t;
      }
      const flow: Flow = {
        style,
        strategies,
        combine: this.joinFor(strategies),
        models: this.someW(P.models, this.pick([0, 1, 1, 2]), "model"),
        forecasts:
          this.rnd() < 0.2
            ? [
                this.pick(
                  P.forecasts
                    .filter((f) => f === "kalman" || this.rnd() < 0.3)
                    .concat("kalman"),
                ),
              ]
            : [],
        decider: "none",
        risks: this.some(P.risks, this.pick([0, 1, 1, 2])),
        portfolio: "equal",
        stopWidth: this.pick(STOP_WIDTHS).id,
        sides:
          this.cfg.sides === "long"
            ? "long"
            : this.rnd() < 0.7
              ? "both"
              : "long",
        takeProfit: this.pick(TAKE_PROFIT).id,
        hold: this.pick(HOLDS).id,
        flip: this.rnd() < 0.6,
        coins: this.cfg.coins.join(" "),
        authority: "council",
        ...(Object.keys(tunes).length ? { tunes } : {}),
      };
      if (this.valid(flow)) return flow;
    }
    return null;
  }

  private valid(f: Flow): boolean {
    if (!f.strategies.length) return false;
    // never more than two sizing rules (the smaller wins)
    if (
      f.risks.filter((id) => RISKS.find((r) => r.id === id)?.sizing).length > 2
    )
      return false;
    return !checkFlow(f).some((x) => x.tone === "clash");
  }

  /** one thing changed */
  mutate(f0: Flow): Flow {
    for (let attempt = 0; attempt < 20; attempt++) {
      const f: Flow = { ...f0, tunes: f0.tunes ? { ...f0.tunes } : undefined };
      const P = this.pool(f.style);
      switch (Math.floor(this.rnd() * 10)) {
        case 0: {
          // a strategy swapped, added or removed
          const pool = P.strategies.filter(
            (x) => !ML.has(x) || this.rnd() < 0.15,
          );
          const s = this.pickW(pool.length ? pool : P.strategies, "strategy");
          const at = Math.floor(this.rnd() * f.strategies.length);
          if (f.strategies.length > 1 && this.rnd() < 0.35)
            f.strategies = f.strategies.filter((_, i) => i !== at);
          else if (f.strategies.length < 3 && this.rnd() < 0.5)
            f.strategies = [...new Set([...f.strategies, s])];
          else
            f.strategies = [
              ...new Set(f.strategies.map((x, i) => (i === at ? s : x))),
            ];
          // the join must still suit what is joined
          if (f.strategies.length > 1 && this.rnd() < 0.5)
            f.combine = this.joinFor(f.strategies);
          break;
        }
        case 1: {
          // a setting of one strategy, one step along its grid
          const s = this.pick(f.strategies);
          const t = this.tuneFor(f.style, s);
          if (t)
            f.tunes = {
              ...(f.tunes ?? {}),
              [`strategy:${s}`]: {
                ...(f.tunes?.[`strategy:${s}`] ?? {}),
                ...t,
              },
            };
          break;
        }
        case 2: {
          const m = this.pickW(P.models, "model");
          f.models = f.models.includes(m)
            ? f.models.filter((x) => x !== m)
            : f.models.length < 2
              ? [...f.models, m]
              : [f.models[0], m];
          break;
        }
        case 3: {
          const r = this.pick(P.risks);
          f.risks = f.risks.includes(r)
            ? f.risks.filter((x) => x !== r)
            : [...f.risks, r];
          break;
        }
        case 4:
          f.stopWidth = this.pick(STOP_WIDTHS).id;
          break;
        case 5:
          f.takeProfit = this.pick(TAKE_PROFIT).id;
          break;
        case 6:
          f.hold = this.pick(HOLDS).id;
          break;
        case 7:
          f.flip = !f.flip;
          if (this.cfg.sides !== "long" && this.rnd() < 0.3)
            f.sides = f.sides === "both" ? "long" : "both";
          break;
        case 8:
          // how the strategies are joined; with “setup, then trigger”, which one sets up
          if (f.strategies.length > 1) {
            if (f.combine === "then" && this.rnd() < 0.5)
              f.strategies = [...f.strategies].reverse();
            else
              f.combine = this.pick(
                ["all", "majority", "any", "switch", "then"] as const,
              );
          } else f.stopWidth = this.pick(STOP_WIDTHS).id;
          break;
        default:
          f.forecasts = f.forecasts.length ? [] : ["kalman"];
      }
      // settings only for the strategies it has
      if (f.tunes) {
        const keep = Object.fromEntries(
          Object.entries(f.tunes).filter(([k]) =>
            f.strategies.some((s) => k === `strategy:${s}`),
          ),
        );
        f.tunes = Object.keys(keep).length ? keep : undefined;
      }
      if (this.valid(f) && keyOf(f) !== keyOf(f0)) return f;
    }
    return this.randomFlow(f0.style) ?? f0;
  }

  /** a child of two bots: each block from one or the other */
  cross(a: Flow, b: Flow): Flow {
    if (a.style !== b.style) return this.mutate(a);
    for (let attempt = 0; attempt < 10; attempt++) {
      const from = () => (this.rnd() < 0.5 ? a : b);
      const s = from();
      const f: Flow = {
        ...a,
        strategies: s.strategies,
        combine: s.combine,
        tunes: s.tunes,
        models: from().models,
        forecasts: from().forecasts,
        risks: from().risks,
        stopWidth: from().stopWidth,
        takeProfit: from().takeProfit,
        hold: from().hold,
        flip: from().flip,
        sides: from().sides,
      };
      if (this.valid(f)) return f;
    }
    return this.mutate(a);
  }

  /** two bots merged into one: the strategies of both, joined — how separate edges are put together */
  merge(a: Flow, b: Flow): Flow {
    if (a.style !== b.style) return this.mutate(a);
    for (let attempt = 0; attempt < 6; attempt++) {
      const strategies = [...new Set([...a.strategies, ...b.strategies])];
      while (strategies.length > 3)
        strategies.splice(Math.floor(this.rnd() * strategies.length), 1);
      if (strategies.length < 2) break;
      const from = () => (this.rnd() < 0.5 ? a : b);
      const tunes = { ...(b.tunes ?? {}), ...(a.tunes ?? {}) };
      const keep = Object.fromEntries(
        Object.entries(tunes).filter(([k]) =>
          strategies.some((x) => k === `strategy:${x}`),
        ),
      );
      const f: Flow = {
        ...a,
        strategies,
        combine: this.joinFor(strategies),
        tunes: Object.keys(keep).length ? keep : undefined,
        models: from().models,
        risks: from().risks,
        forecasts: from().forecasts,
      };
      if (this.valid(f) && keyOf(f) !== keyOf(a) && keyOf(f) !== keyOf(b))
        return f;
    }
    return this.cross(a, b);
  }

  private seedPop(n: number) {
    const out: Ind[] = [];
    for (let i = 0; i < n * 3 && out.length < n; i++) {
      const f = this.randomFlow(this.cur.style);
      if (f) out.push({ flow: f, key: keyOf(f), fit: NaN, done: false });
    }
    return out;
  }

  private tournament(): Ind {
    const a = this.pick(this.pop);
    const b = this.pick(this.pop);
    return (a.fit ?? -Infinity) >= (b.fit ?? -Infinity) ? a : b;
  }

  /**
   * How overfit the search is: the probability of backtest overfitting (Bailey,
   * Borwein, López de Prado & Zhu 2017) over the latest bots that made money
   * in training. The training years are cut into eight stretches; for every
   * way of calling four of them "in sample", the bot that did best there is
   * looked up on the other four — PBO is how often it lands in the bottom
   * half. Only bots in profit in training are compared: a bot that loses to
   * its costs loses everywhere, and that sameness would hide the overfitting.
   */
  private measureOverfit() {
    let sum = 0;
    let k = 0;
    for (const rows of Object.values(this.genBlocks)) {
      if (rows.length < 10) continue;
      const v = pbo(rows);
      if (v === null) continue;
      sum += v * rows.length;
      k += rows.length;
    }
    if (!k) return;
    this.pboHist.push(sum / k);
    if (this.pboHist.length > 5) this.pboHist.shift();
  }

  /** the probability of backtest overfitting of the search, over recent generations */
  overfit(): number | null {
    return this.pboHist.length
      ? this.pboHist.reduce((a, b) => a + b, 0) / this.pboHist.length
      : null;
  }

  /** a parent for the next generation: mostly the fitter of two from the population, sometimes the champion of a random niche */
  private parent(): Flow {
    if (this.rnd() < 0.3) {
      const mine = [...this.archive.values()].filter(
        (a) => a.flow.style === this.cur.style,
      );
      if (mine.length) return this.pick(mine).flow;
    }
    return this.tournament().flow;
  }

  /** the next generation: the best of each kind carried over, children of the fitter and of the niches' champions, bots bred from the survivors, and new random bots */
  private breed() {
    const N = 40;
    this.gen++;
    this.measureOverfit();
    const scored = this.pop
      .filter((x) => Number.isFinite(x.fit))
      .sort((a, b) => b.fit - a.fit);
    const top = scored[0]?.fit ?? -Infinity;
    if (top > this.best + 0.05) {
      this.best = top;
      this.stale = 0;
    } else this.stale++;
    const next: Ind[] = [];
    const keys = new Set<string>();
    const add = (flow: Flow, fit = NaN) => {
      const k = keyOf(flow);
      if (keys.has(k)) return false;
      keys.add(k);
      next.push({
        flow,
        key: k,
        fit: Number.isFinite(fit) ? fit : (this.seen.get(k) ?? NaN),
        done: Number.isFinite(fit) || this.seen.has(k),
      });
      return true;
    };
    // stuck for a while: start over with fresh bots — the niches' champions keep what was learned
    const restart = this.stale >= 8 || scored.length < 4;
    if (restart) {
      this.stale = 0;
      this.best = -Infinity;
      for (const x of scored.slice(0, 2)) add(x.flow, x.fit);
      const champs = [...this.archive.values()]
        .filter((a) => a.flow.style === this.cur.style)
        .sort((a, b) => b.fit - a.fit);
      for (const c of this.some(champs.slice(0, 24), 8)) add(this.mutate(c.flow));
    } else {
      // the best carried over: no more than two of a kind
      const perNiche = new Map<string, number>();
      for (const x of scored) {
        if (next.length >= 6) break;
        const nk = nicheOf(x.flow);
        if ((perNiche.get(nk) ?? 0) >= 2) continue;
        perNiche.set(nk, (perNiche.get(nk) ?? 0) + 1);
        add(x.flow, x.fit);
      }
      let guard = 0;
      while (next.length < N - 12 && guard++ < 300) {
        const u = this.rnd();
        add(
          u < 0.4
            ? this.cross(this.parent(), this.parent())
            : u < 0.55
              ? this.merge(this.parent(), this.parent())
              : this.mutate(this.parent()),
        );
      }
    }
    // bred from the survivors of this pace: two of them merged into one, or one changed into a new kind
    // (a copy of a kind that already holds its place would never be tested, so only new kinds are kept)
    const live = this.survivors.filter(
      (x) => x.stage !== "faded" && x.style === this.cur.style,
    );
    let guard = 0;
    const want = Math.min(4, live.length);
    let made = 0;
    while (made < want && guard++ < 60) {
      const a = this.pick(live);
      const mates = live.filter((x) => x !== a);
      const child =
        mates.length && this.rnd() < 0.6
          ? this.merge(a.flow, this.pick(mates).flow)
          : this.mutate(a.flow);
      if (
        !this.taken(child) &&
        !this.seen.has(keyOf(child)) &&
        add(child)
      )
        made++;
    }
    for (const x of this.seedPop(N - next.length)) add(x.flow);
    this.pop = next;
    this.cursor = 0;
  }

  // ---------- testing ----------

  private ctxFor(
    f: Flow,
  ): { ctxs: Ctx[]; spec: StrategySpec; tfH: number; coins: string[] } | null {
    const built = buildSpec(f);
    const all = this.ctxs[built.timeframe];
    if (!all) return null;
    const want = new Set(built.coins.map((c) => c.toUpperCase()));
    const ctxs = all.filter((c) => want.has(c.m.coin.toUpperCase()));
    if (!ctxs.length) return null;
    return {
      ctxs,
      spec: { ...built.spec, name: built.spec.name },
      tfH: built.style.tfH,
      coins: ctxs.map((c) => c.m.coin),
    };
  }

  /** a learned bot on the last 30 % of the training bars, its models fitted on the 70 % before them */
  private runInner(
    f: Flow,
    x: NonNullable<ReturnType<Farm["ctxFor"]>>,
  ): {
    per: { bt: ReturnType<typeof backtest> }[];
    rets: Float64Array;
    trades: ReturnType<typeof backtest>["trades"];
    exposure: number;
  } | null {
    const inner = this.inner[buildSpec(f).timeframe];
    if (!inner) return null;
    const per = x.ctxs.map((outer) => {
      const c = inner.find((q) => q.m.coin === outer.m.coin)!;
      return {
        m: c.m,
        bt: backtest(c, x.spec, c.trainEnd, outer.trainEnd, this.costs),
      };
    });
    return {
      per,
      rets: pool(per).rets,
      trades: per.flatMap((q) => q.bt.trades),
      exposure: per.reduce((a, q) => a + q.bt.exposure, 0) / (per.length || 1),
    };
  }

  /**
   * The training score. The Sharpe ratio on the training years, but:
   *   · half of it is the WORSE half of those years — a bot carried by one
   *     stretch scores low (stability is the best single predictor of a bot
   *     holding up on new data);
   *   · it is marked down when few of the coins were in profit;
   *   · every block beyond two costs a little (a simple bot that scores the
   *     same as a complicated one is the better bet).
   * A bot with a learned part (an AI strategy or second opinion) is scored
   * on training bars its models never saw. Also returns the bot's mean
   * return in eight stretches of the training years, for the overfit meter.
   */
  train(f: Flow): {
    fit: number;
    is: Perf | null;
    tf?: string;
    blocks?: number[];
  } {
    const x = this.ctxFor(f);
    if (!x) return { fit: -Infinity, is: null };
    const bpy = barsPerYear(x.tfH);
    // a learned rule scored on the bars it learned from looks better than it is: its models are fitted on
    // the first 70 % of the training bars and it is scored on the last 30 % of them
    const learned = usesML(f);
    const r = learned ? this.runInner(f, x) : runAll(x.ctxs, x.spec, "is", this.costs);
    if (!r) return { fit: -Infinity, is: null };
    const p = perf(r.rets, r.trades, bpy, r.exposure);
    const coinsUp =
      r.per.filter((q) => q.bt.rets.reduce((a, b) => a + b, 0) > 0).length /
      r.per.length;
    const minTrades = learned
      ? Math.max(12, 4 * x.ctxs.length)
      : Math.max(20, 8 * x.ctxs.length);
    if (p.trades < minTrades) return { fit: -Infinity, is: p };
    const n = r.rets.length;
    const sharpeOf = (from: number, to: number) => {
      let sum = 0;
      let sq = 0;
      for (let i = from; i < to; i++) {
        sum += r.rets[i];
        sq += r.rets[i] * r.rets[i];
      }
      const k = to - from;
      const m = sum / k;
      const sd = Math.sqrt(Math.max(0, sq / k - m * m));
      return sd > 0 ? (m / sd) * Math.sqrt(bpy) : 0;
    };
    const half = Math.floor(n / 2);
    const worse = Math.min(sharpeOf(0, half), sharpeOf(half, n));
    const size =
      f.strategies.length + f.models.length + f.forecasts.length + f.risks.length;
    const fit =
      (0.5 * p.sharpe + 0.5 * worse) * (0.5 + 0.5 * coinsUp) -
      0.04 * Math.max(0, size - 2);
    // eight equal stretches of the training years: the mean return in each, in units of the bot's own volatility
    const S = 8;
    const sd = p.vol / Math.sqrt(bpy);
    const blocks: number[] = [];
    if (sd > 0 && n >= S * 20 && !learned)
      for (let b = 0; b < S; b++) {
        const a = Math.floor((b * n) / S);
        const z = Math.floor(((b + 1) * n) / S);
        let sum = 0;
        for (let i = a; i < z; i++) sum += r.rets[i];
        blocks.push(sum / (z - a) / sd);
      }
    return {
      fit,
      is: p,
      tf: buildSpec(f).timeframe,
      blocks: blocks.length === S ? blocks : undefined,
    };
  }

  /** the settings one step away: each strategy setting up and down its grid, the stop, the hold, the profit target */
  neighbours(f: Flow): Flow[] {
    const out: Flow[] = [];
    const st = STYLE_MAP[f.style];
    for (const id of f.strategies) {
      const opt = STRATEGIES.find((s) => s.id === id);
      const sig = opt && SIGNAL_MAP[opt.signal];
      if (!opt || !sig) continue;
      const now: Params = {
        ...opt.params(st),
        ...(f.tunes?.[`strategy:${id}`] ?? {}),
      };
      for (const [k, grid] of Object.entries(sig.grid)) {
        if (grid.length < 2 || !(k in now)) continue;
        const sorted = [...grid].sort((a, b) => a - b);
        const steps = [
          sorted.filter((v) => v < now[k]).pop(),
          sorted.find((v) => v > now[k]),
        ];
        for (const v of steps)
          if (v !== undefined)
            out.push({
              ...f,
              tunes: {
                ...(f.tunes ?? {}),
                [`strategy:${id}`]: {
                  ...(f.tunes?.[`strategy:${id}`] ?? {}),
                  [k]: v,
                },
              },
            });
      }
    }
    const step = <T extends { id: string }>(
      xs: readonly T[],
      cur: string,
      set: (id: string) => Partial<Flow>,
    ) => {
      const i = xs.findIndex((x) => x.id === cur);
      for (const j of [i - 1, i + 1])
        if (j >= 0 && j < xs.length) out.push({ ...f, ...set(xs[j].id) });
    };
    step(STOP_WIDTHS, f.stopWidth, (id) => ({ stopWidth: id }));
    step(HOLDS, f.hold, (id) => ({ hold: id }));
    step(TAKE_PROFIT, f.takeProfit, (id) => ({ takeProfit: id }));
    return out.filter((x) => this.valid(x));
  }

  /** the gauntlet, stage by stage; the first stage failed ends it */
  gauntlet(
    f: Flow,
    is: Perf,
  ): { ok: true; s: Survivor } | { ok: false; at: Stage; why: string } {
    const x = this.ctxFor(f)!;
    const bpy = barsPerYear(x.tfH);
    // 2 — the unseen 30 %
    const run = runAll(x.ctxs, x.spec, "oos", this.costs);
    const oos = perf(run.rets, run.trades, bpy, run.exposure);
    const enough = Math.max(12, 4 * x.ctxs.length);
    if (oos.trades < enough)
      return {
        ok: false,
        at: "holdout",
        why: `only ${oos.trades} trades on the unseen 30 % (needs ${enough})`,
      };
    if (!(oos.totalReturn > 0) || oos.sharpe < 0.5)
      return {
        ok: false,
        at: "holdout",
        why: `lost or barely made money on data it never saw (Sharpe ${oos.sharpe.toFixed(2)})`,
      };
    if (is.sharpe > 0 && oos.sharpe < 0.5 * is.sharpe)
      return {
        ok: false,
        at: "holdout",
        why: `did far worse on new data than in training (Sharpe ${is.sharpe.toFixed(2)} → ${oos.sharpe.toFixed(2)})`,
      };
    // 3 — steady: not one lucky stretch, coin or trade
    const third = Math.floor(run.rets.length / 3);
    let thirds = 0;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      const to = k === 2 ? run.rets.length : (k + 1) * third;
      for (let i = k * third; i < to; i++) sum += run.rets[i];
      if (sum > 0) thirds++;
    }
    const coinsUp = run.per.filter(
      (q) => q.bt.rets.reduce((a, b) => a + b, 0) > 0,
    ).length;
    const rs = run.trades.map((t) => t.r).sort((a, b) => b - a);
    const drop = Math.max(1, Math.round(rs.length * 0.05));
    const noBest = rs.slice(drop).reduce((a, b) => a + b, 0);
    if (thirds < 2)
      return {
        ok: false,
        at: "steady",
        why: `in profit in only ${thirds} of the 3 thirds of the unseen stretch — one stretch carried it`,
      };
    if (coinsUp < Math.ceil(run.per.length / 2))
      return {
        ok: false,
        at: "steady",
        why: `in profit on only ${coinsUp} of its ${run.per.length} coins`,
      };
    if (!(noBest > 0))
      return {
        ok: false,
        at: "steady",
        why: `without its best ${drop} trade${drop === 1 ? "" : "s"} (5 %) it loses — a few lucky trades made the result`,
      };
    // 4 — double costs
    const dear = runAll(x.ctxs, x.spec, "oos", {
      feeBps: this.costs.feeBps * this.stress,
      slipBps: this.costs.slipBps * this.stress,
    });
    const cost2 = perf(dear.rets, dear.trades, bpy, dear.exposure);
    if (!(cost2.totalReturn > 0))
      return {
        ok: false,
        at: "costs",
        why: `loses at double the fees and slippage (Sharpe ${cost2.sharpe.toFixed(2)}) — the edge is thinner than its costs`,
      };
    // 5 — 100 random bots
    const nul = randomEntryTest(
      run.per.map((q) => ({
        logClose: Float64Array.from(q.c.m.bars, (b) => Math.log(b.close)),
        trades: q.bt.trades,
        from: q.c.trainEnd,
        to: q.c.m.bars.length,
      })),
      (2 * (this.costs.feeBps + this.costs.slipBps)) / 1e4,
      100,
      7,
    );
    const beat = nul
      ? Math.max(0, Math.min(100, 100 - Math.round(nul.p * 101 - 1)))
      : 0;
    if (beat < 75)
      return {
        ok: false,
        at: "random",
        why: `beat only ${beat} of 100 random bots (needs 75)`,
      };
    // 6 — every setting nudged
    const nb = this.neighbours(f);
    let kept = 0;
    for (const n of nb) {
      const y = this.ctxFor(n);
      if (!y) continue;
      const r2 = runAll(y.ctxs, y.spec, "oos", this.costs);
      if (r2.rets.reduce((a, b) => a + b, 0) > 0) kept++;
    }
    if (nb.length < 2)
      return { ok: false, at: "nudge", why: "too few settings to nudge" };
    if (kept < nb.length / 2)
      return {
        ok: false,
        at: "nudge",
        why: `only ${kept} of ${nb.length} nudged versions still made money`,
      };
    // 7 — 1,000 shuffles
    const mc = monteCarlo(
      run.trades.map((t) => t.r),
      1000,
      0.01,
      11,
    );
    if (!mc)
      return { ok: false, at: "shuffle", why: "too few trades to shuffle" };
    if (mc.dd95 > this.cfg.maxDD)
      return {
        ok: false,
        at: "shuffle",
        why: `the unlucky orders fell ${(mc.dd95 * 100).toFixed(0)} % at 1 % risk a trade (limit ${(this.cfg.maxDD * 100).toFixed(0)} %)`,
      };
    const built = buildSpec(f);
    const full = runAll(x.ctxs, x.spec, "all", this.costs);
    let eq = 1;
    const curve: number[] = [];
    const every = Math.max(1, Math.floor(full.rets.length / 160));
    full.rets.forEach((r, i) => {
      eq *= 1 + r;
      if (i % every === 0) curve.push(eq);
    });
    const dsr = deflatedSharpe(
      oos,
      Math.max(1, this.tried),
      (1 + 0.5 * oos.srBar ** 2) / Math.max(1, oos.bars),
    );
    const s: Survivor = {
      id: `${this.now().toString(36)}-${Math.floor(this.rnd() * 1e6).toString(36)}`,
      key: keyOf(f),
      flow: f,
      name: built.spec.name,
      style: f.style,
      tfH: x.tfH,
      coins: x.coins,
      foundAt: this.now(),
      seenTo: Math.max(
        ...x.ctxs.map((c) => c.m.bars[c.m.bars.length - 1].time),
      ),
      is,
      oos,
      beat,
      nudge: { kept, tried: nb.length },
      mc: { dd95: mc.dd95, pLoss: mc.pLoss },
      periods: periodsOf(run.rets, run.times),
      dsr,
      tried: this.tried,
      score: 0,
      forward: null,
      stage: "new",
      sig: false,
      p: 1 - ncdf(oos.t),
      checks: {
        thirds,
        coinsUp,
        coins: run.per.length,
        noBest,
        cost2: cost2.sharpe,
      },
      daily: dailyOf(run.rets, run.times),
      summary: built.summary,
      curve,
      split: Math.min(
        ...x.ctxs.map((c) => c.m.bars[c.trainEnd]?.time ?? Infinity),
      ),
    };
    // 8 — the vault: the most recent candles, which nothing above has touched
    const fw = this.forwardOf(x.spec, x.tfH, x.coins, s.seenTo);
    if (fw && fw.bars > 0) {
      s.forward = fw;
      s.vault = { bars: fw.bars, trades: fw.trades, ret: fw.ret, days: fw.days };
      s.stage = ladderOf(s);
      if (s.stage === "faded")
        return {
          ok: false,
          at: "vault",
          why:
            fw.ret < 0
              ? `lost ${(-fw.ret * 100).toFixed(1)} % over ${fw.trades} trades in the vault — the ${Math.round(fw.days)} most recent days, which nothing had seen`
              : `fell ${(fw.maxDD * 100).toFixed(0)} % in the vault, further than it ever did before`,
        };
    }
    s.score = scoreOf(s);
    return { ok: true, s };
  }

  // ---------- forward test: candles that arrived after a survivor was found ----------

  private forwardOf(
    spec: StrategySpec,
    tfH: number,
    coins: string[],
    after: number,
  ): Forward | null {
    const tf =
      tfH === 24 ? "1d" : tfH < 1 ? `${Math.round(tfH * 60)}m` : `${tfH}h`;
    const all = this.fwd[tf];
    if (!all) return null;
    const want = new Set(coins.map((c) => c.toUpperCase()));
    const ctxs = all.filter((c) => want.has(c.m.coin.toUpperCase()));
    if (!ctxs.length) return null;
    const per = ctxs.map((c) => {
      const from = c.m.bars.findIndex((b) => b.time > after);
      return {
        m: c.m,
        bt: backtest(
          c,
          spec,
          from < 0 ? c.m.bars.length : Math.max(2, from),
          c.m.bars.length,
          this.costs,
        ),
      };
    });
    const trades = per.flatMap((q) => q.bt.trades);
    const acc = new Map<number, [number, number]>();
    for (const { bt } of per)
      for (let i = 0; i < bt.rets.length; i++) {
        const a = acc.get(bt.times[i]) ?? [0, 0];
        a[0] += bt.rets[i];
        a[1]++;
        acc.set(bt.times[i], a);
      }
    const times = [...acc.keys()].filter(Boolean).sort((a, b) => a - b);
    const rets = times.map((t) => acc.get(t)![0] / acc.get(t)![1]);
    const p = perf(rets, trades, barsPerYear(tfH), 0);
    return {
      bars: rets.length,
      trades: trades.length,
      ret: p.totalReturn,
      sharpe: p.sharpe,
      maxDD: p.maxDD,
      days: times.length
        ? (times[times.length - 1] - times[0]) / 86_400_000
        : 0,
    };
  }

  private forwardAll() {
    for (const s of this.survivors) {
      const x = this.ctxFor(s.flow);
      if (!x) continue;
      const fw = this.forwardOf(x.spec, s.tfH, s.coins, s.seenTo);
      s.forward = fw && fw.bars > 0 ? fw : s.forward;
      s.stage = ladderOf(s);
      s.score = scoreOf(s);
      // a kind that faded on fresh data has had its chance
      if (s.stage === "faded") this.burn(s.flow);
    }
    this.prune();
    this.rank();
    this.boardDirty = true;
    this.teamAt = 0;
  }

  // ---------- one survivor of a kind ----------

  /** this kind already holds a survivor, or has been ruled out: a copy of it is not tested again */
  taken(f: Flow): boolean {
    const k = kindOf(f);
    return this.heldKinds.has(k) || this.burned.has(k);
  }

  private burn(f: Flow) {
    this.burned.add(kindOf(f));
    if (this.burned.size > 20_000)
      this.burned.delete(this.burned.values().next().value as string);
  }

  private reindex() {
    this.heldKinds = new Set(this.survivors.map((s) => kindOf(s.flow)));
  }

  /** the strategies deployed in the swarm, checked on the candles since they were deployed */
  checkFleet(
    deployed: {
      id: string;
      name: string;
      spec: StrategySpec;
      tfH: number;
      coins: string[];
      deployedAt: number;
      stats?: { sharpe: number };
    }[],
  ) {
    const top = this.top();
    this.fleet = deployed.map((d) => {
      const fw = this.forwardOf(d.spec, d.tfH, d.coins, d.deployedAt);
      const tested = d.stats?.sharpe ?? NaN;
      const alt = top.find((t) => t.tfH === d.tfH && t.name !== d.spec.name);
      const item: FleetItem = {
        id: d.id,
        name: d.name,
        tfH: d.tfH,
        coins: d.coins,
        status: "no data",
        forward: fw,
        tested,
        text: "",
        replace: null,
      };
      if (!fw || fw.bars < 2)
        item.text =
          "The edge finder has no candles for its coins and pace yet — add them to the edge finder’s coins and paces to watch it.";
      else if (fw.trades < 5) {
        item.status = "watching";
        item.text = `${fw.trades} trade${fw.trades === 1 ? "" : "s"} since it was deployed: too few to judge.`;
      } else if (fw.ret < 0 && (fw.trades >= 10 || fw.maxDD > 0.15)) {
        item.status = "fading";
        item.text = `Losing on fresh data: ${(fw.ret * 100).toFixed(1)} % over ${fw.trades} trades since it was deployed (Sharpe ${fw.sharpe.toFixed(2)}, tested ${Number.isFinite(tested) ? tested.toFixed(2) : "—"}).${alt ? " A top-five strategy at the same pace could replace it." : ""}`;
        item.replace = alt?.id ?? null;
      } else if (Number.isFinite(tested) && fw.sharpe < 0.5 * tested) {
        item.status = "slipping";
        item.text = `Still making money, but well short of its test: Sharpe ${fw.sharpe.toFixed(2)} on fresh data against ${tested.toFixed(2)} tested. Watch it.`;
        item.replace = alt?.id ?? null;
      } else {
        item.status = "healthy";
        item.text = `Holding up on fresh data: ${(fw.ret * 100).toFixed(1)} % over ${fw.trades} trades (Sharpe ${fw.sharpe.toFixed(2)}).`;
      }
      return item;
    });
  }

  // ---------- the loop ----------

  /**
   * One unit of work: the next bot of the generation is trained and, if it is
   * good enough, sent through the gauntlet. Returns what happened, for the log.
   */
  step(): {
    what: "idle" | "trained" | "rejected" | "survived";
    name?: string;
  } {
    const styles = this.styles();
    if (!styles.length) return { what: "idle" };
    // the gauntlet runs on the bots that trained well, one at a time
    const g = this.queue.shift();
    if (g) return this.runGauntlet(g);
    // each pace has its own population; they take turns, one bot at a time
    this.turn = (this.turn + 1) % styles.length;
    const style = styles[this.turn];
    let isl = this.islands.get(style);
    if (!isl) {
      isl = { style, pop: [], cursor: 0, best: -Infinity, stale: 0 };
      this.islands.set(style, isl);
    }
    this.cur = isl;
    if (!this.pop.length) {
      this.pop = this.seedPop(40);
      this.cursor = 0;
    }
    while (this.cursor < this.pop.length && this.pop[this.cursor].done)
      this.cursor++;
    if (this.cursor >= this.pop.length) {
      this.breed();
      return { what: "idle" };
    }
    const ind = this.pop[this.cursor++];
    ind.done = true;
    const had = this.seen.get(ind.key);
    if (had !== undefined) {
      ind.fit = had;
      return { what: "idle" };
    }
    let r: ReturnType<Farm["train"]>;
    try {
      r = this.train(ind.flow);
    } catch {
      r = { fit: -Infinity, is: null };
    }
    ind.fit = r.fit;
    this.seen.set(ind.key, r.fit);
    this.note(ind.flow, "n");
    if (r.tf && r.blocks && r.is && r.is.sharpe > 0) {
      const rows = (this.genBlocks[r.tf] ??= []);
      rows.push(r.blocks);
      if (rows.length > 80) rows.shift();
    }
    // the best of its kind so far goes in the archive
    if (Number.isFinite(r.fit)) {
      const nk = nicheOf(ind.flow);
      const had = this.archive.get(nk);
      if (!had || r.fit > had.fit)
        this.archive.set(nk, { flow: ind.flow, fit: r.fit });
      if (this.archive.size > 300) {
        const worst = [...this.archive.entries()].sort(
          (a, b) => a[1].fit - b[1].fit,
        )[0];
        this.archive.delete(worst[0]);
      }
    }
    if (this.seen.size > 20_000)
      this.seen.delete(this.seen.keys().next().value as string);
    this.tried++;
    this.funnel.bred++;
    this.stamps.push(this.now());
    if (this.stamps.length > 200) this.stamps.shift();
    if (r.is && r.fit >= TRAIN_MIN_SHARPE) {
      // a copy of a kind that already holds its place (or was ruled out) is not put through the gauntlet again:
      // the copies were most of the work, and each one was another look at the same data for the same idea
      if (this.taken(ind.flow)) {
        this.dupes++;
        return { what: "trained", name: buildSpec(ind.flow).spec.name };
      }
      this.funnel.trained++;
      this.entered.add(kindOf(ind.flow));
      this.note(ind.flow, "pass");
      (ind as Ind & { is?: Perf }).fit = r.fit;
      this.queue.push({ ...ind, is: r.is } as Ind & { is: Perf });
    }
    return { what: "trained", name: buildSpec(ind.flow).spec.name };
  }

  private runGauntlet(g: Ind & { is?: Perf }): {
    what: "rejected" | "survived";
    name: string;
  } {
    const name = buildSpec(g.flow).spec.name;
    let res: ReturnType<Farm["gauntlet"]>;
    try {
      res = this.gauntlet(g.flow, g.is!);
    } catch (e) {
      res = {
        ok: false,
        at: "holdout",
        why: `could not be tested (${String((e as Error)?.message ?? e).slice(0, 80)})`,
      };
    }
    if (!res.ok) {
      // its one look at the vault is used up
      if (res.at === "vault") this.burn(g.flow);
      this.noteFail(res.at);
      this.recent.unshift({ name, at: res.at, why: res.why, t: this.now() });
      this.recent = this.recent.slice(0, 12);
      return { what: "rejected", name };
    }
    // every check passed; fresh data and significance (allowing for every kind tried) decide where it stands in its pace's top five
    for (const st of [
      "holdout",
      "steady",
      "costs",
      "random",
      "nudge",
      "shuffle",
      "vault",
    ] as Stage[])
      this.funnel[st]++;
    this.note(g.flow, "surv");
    // one survivor of a kind: a second bot of the same kind that slipped into the queue is not kept
    const twin = this.heldKinds.has(kindOf(res.s.flow));
    if (!twin) this.survivors.push(res.s);
    this.reindex();
    this.prune();
    this.rank();
    const sig = !twin && res.s.sig;
    this.recent.unshift({
      name,
      at: sig ? "proof" : "shuffle",
      why: sig
        ? `SURVIVED every check — beat ${res.s.beat} of 100 random bots, ${res.s.nudge.kept} of ${res.s.nudge.tried} nudges kept, ${vaultWords(res.s)}, t = ${res.s.oos.t.toFixed(1)}: significant even after ${Math.max(this.entered.size, this.kindsFloor).toLocaleString()} kinds of bot tried`
        : `passed every check — ${vaultWords(res.s)}; t = ${res.s.oos.t.toFixed(1)} is not yet significant after ${Math.max(this.entered.size, this.kindsFloor).toLocaleString()} kinds tried: a candidate, forward-testing`,
      t: this.now(),
    });
    this.recent = this.recent.slice(0, 12);
    this.prune();
    return { what: "survived", name };
  }

  /**
   * Which survivors are significant, allowing for every bot that reached the
   * unseen data (Benjamini & Hochberg 1995). Each survivor's one-sided
   * p-value is ranked against the number of gauntlet entrants: the k-th
   * smallest must be below k / entrants × 10 %. So the bar rises as more bots
   * are tried — a survivor can lose its place to the search going on — and of
   * those called significant, at most about 1 in 10 should be flukes.
   */
  rank() {
    // one idea, one test: the count is of KINDS of bot that reached the unseen data, not of every copy
    const M = Math.max(
      1,
      this.entered.size,
      this.kindsFloor,
      this.survivors.length,
    );
    const byP = [...this.survivors]
      .map((s) => {
        if (!(s.p! >= 0)) s.p = 1 - ncdf(s.oos.t);
        return s;
      })
      .sort((a, b) => a.p! - b.p!);
    // q-values: the smallest false-discovery rate at which each would be called significant
    let q = 1;
    let flipped = false;
    for (let k = byP.length - 1; k >= 0; k--) {
      q = Math.min(q, (byP[k].p! * M) / (k + 1));
      byP[k].q = q;
      if (byP[k].sig !== q <= FDR) flipped = true;
      byP[k].sig = q <= FDR;
    }
    if (flipped) this.boardDirty = true;
    // the last step of the funnel is how many stand as significant NOW (it can fall as more bots are tried)
    this.funnel.proof = byP.filter((x) => x.sig).length;
  }

  /** the funnel counts each stage a bot PASSED; a rejection at a stage means it passed the ones before */
  noteFail(at: Stage) {
    const order: Stage[] = [
      "holdout",
      "steady",
      "costs",
      "random",
      "nudge",
      "shuffle",
      "vault",
      "proof",
    ];
    for (const st of order) {
      if (st === at) break;
      this.funnel[st]++;
    }
  }

  /** at most 40 standing and 8 faded at each pace: those with the least behind them go first */
  private prune() {
    const keep: Survivor[] = [];
    for (const p of PACES) {
      const mine = this.survivors.filter((s) => paceIdOf(s.style) === p.id);
      const order = (a: Survivor, b: Survivor) =>
        STAGE_RANK[b.stage] - STAGE_RANK[a.stage] ||
        Number(b.sig) - Number(a.sig) ||
        b.score - a.score;
      keep.push(
        ...mine.filter((s) => s.stage !== "faded").sort(order).slice(0, 40),
        ...mine
          .filter((s) => s.stage === "faded")
          .sort((a, b) => b.foundAt - a.foundAt)
          .slice(0, 8),
      );
    }
    if (keep.length !== this.survivors.length) {
      const ids = new Set(keep.map((s) => s.id));
      this.survivors = this.survivors.filter((s) => ids.has(s.id));
      this.reindex();
    }
  }

  /**
   * The five best still standing at each pace: proven on fresh data first,
   * then proving, then the rest; significant ahead of not; then by score.
   *
   * The lists are worked out on a steady clock (every 20 seconds, or at once
   * when fresh candles arrive, a stage or a significance changes, or a pace
   * has fewer than five to show) — not at every bot — and a strategy already
   * listed keeps its place unless a newcomer is clearly better (15 % on the
   * score, or further up the ladder). A screen that reshuffles every second
   * cannot be read.
   */
  tops(): PaceBoard[] {
    const t = this.now();
    const groups = PACES.filter(
      (p) =>
        p.styles.some((x) => this.cfg.styles.includes(x)) ||
        this.survivors.some((s) => paceIdOf(s.style) === p.id),
    );
    const liveOf = (id: string) =>
      this.survivors.filter(
        (s) => s.stage !== "faded" && paceIdOf(s.style) === id,
      );
    const byId = new Map(this.survivors.map((s) => [s.id, s]));
    const stale =
      !this.board ||
      this.boardDirty ||
      t - this.board.at >= 20_000 ||
      t < this.board.at ||
      groups.some((p) => {
        const ids = this.board!.ids[p.id] ?? [];
        return (
          ids.some((id) => !byId.has(id) || byId.get(id)!.stage === "faded") ||
          (ids.length < 5 && liveOf(p.id).length > ids.length)
        );
      });
    if (stale) {
      const ids: Record<string, string[]> = {};
      for (const p of groups) {
        const was = new Set(this.board?.ids[p.id] ?? []);
        const adj = (s: Survivor) => s.score * (was.has(s.id) ? 1.15 : 1);
        ids[p.id] = liveOf(p.id)
          .sort(
            (a, b) =>
              STAGE_RANK[b.stage] - STAGE_RANK[a.stage] ||
              Number(b.sig) - Number(a.sig) ||
              adj(b) - adj(a),
          )
          .slice(0, 5)
          .map((s) => s.id);
      }
      this.board = { at: t, ids };
      this.boardDirty = false;
    }
    return groups.map((p) => ({
      id: p.id,
      name: p.name,
      rows: (this.board!.ids[p.id] ?? [])
        .map((id) => byId.get(id))
        .filter((s): s is Survivor => !!s),
      held: this.survivors.filter((s) => paceIdOf(s.style) === p.id).length,
      live: liveOf(p.id).length,
    }));
  }

  /** the five best over every pace (the research strip, and what a fading deployed strategy is replaced with) */
  top(): Survivor[] {
    return this.tops()
      .flatMap((p) => p.rows)
      .sort(
        (a, b) =>
          STAGE_RANK[b.stage] - STAGE_RANK[a.stage] ||
          Number(b.sig) - Number(a.sig) ||
          b.score - a.score,
      )
      .slice(0, 5);
  }

  /** (the watch list is now part of each pace's top five, marked as candidates) */
  watch(): Survivor[] {
    return [];
  }

  /**
   * The team: the survivors that fit together best as one portfolio. Starting
   * from the best survivor, it adds — one at a time — whichever other survivor
   * raises the portfolio's Sharpe ratio the most (members weighted by inverse
   * volatility, so each carries the same risk), as long as it is of a
   * different family and not closely correlated (under 0.7) with a member.
   * Read on the days of the unseen stretch every member has. The team is
   * chosen on that same stretch, so its numbers flatter it a little; the
   * forward test is the judge.
   */
  team(fresh = false): Team | null {
    // worked out at most once a minute (and when fresh candles arrive): its members should not change by the second
    const t = this.now();
    if (!fresh && this.teamAt && t - this.teamAt < 60_000 && t >= this.teamAt)
      return this.teamCache;
    this.teamAt = t || 1;
    this.teamCache = null;
    const live = this.survivors
      .filter((s) => s.stage !== "faded" && s.daily && s.daily.r.length >= 45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);
    if (live.length < 2) return null;
    const cut = (ms: Survivor[]): number[][] | null => {
      const a = Math.max(...ms.map((m) => m.daily!.d0));
      const b = Math.min(...ms.map((m) => m.daily!.d0 + m.daily!.r.length - 1));
      if (b - a + 1 < 45) return null;
      return ms.map((m) => m.daily!.r.slice(a - m.daily!.d0, b - m.daily!.d0 + 1));
    };
    const mean = (x: number[]) => x.reduce((p, q) => p + q, 0) / x.length;
    const sdOf = (x: number[]) => {
      const m = mean(x);
      return Math.sqrt(x.reduce((p, q) => p + (q - m) ** 2, 0) / x.length);
    };
    const corr = (x: number[], y: number[]) => {
      const mx = mean(x);
      const my = mean(y);
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < x.length; i++) {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) ** 2;
        syy += (y[i] - my) ** 2;
      }
      return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    const stat = (ms: Survivor[]) => {
      const xs = cut(ms);
      if (!xs) return null;
      const sds = xs.map(sdOf);
      if (sds.some((v) => !(v > 0))) return null;
      const iv = sds.map((v) => 1 / v);
      const tot = iv.reduce((p, q) => p + q, 0);
      const w = iv.map((v) => v / tot);
      const port = xs[0].map((_, i) => xs.reduce((p, x, k) => p + w[k] * x[i], 0));
      const sd = sdOf(port);
      let eq = 1;
      let peak = 1;
      let dd = 0;
      for (const r of port) {
        eq *= 1 + r;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, 1 - eq / peak);
      }
      let cs = 0;
      let ck = 0;
      let cmax = 0;
      for (let i = 0; i < xs.length; i++)
        for (let j = i + 1; j < xs.length; j++) {
          const c = corr(xs[i], xs[j]);
          cs += c;
          ck++;
          cmax = Math.max(cmax, c);
        }
      const each = xs.map((x) => {
        const v = sdOf(x);
        let e = 1;
        let pk = 1;
        let d = 0;
        for (const r of x) {
          e *= 1 + r;
          pk = Math.max(pk, e);
          d = Math.max(d, 1 - e / pk);
        }
        return { sharpe: v > 0 ? (mean(x) / v) * Math.sqrt(365) : 0, maxDD: d };
      });
      return {
        w,
        sharpe: sd > 0 ? (mean(port) / sd) * Math.sqrt(365) : 0,
        maxDD: dd,
        ret: mean(port) * 365,
        corr: ck ? cs / ck : 0,
        cmax,
        days: port.length,
        each,
      };
    };
    let best: { ms: Survivor[]; st: NonNullable<ReturnType<typeof stat>> } | null = null;
    // every survivor in turn as the first member; the best team found is kept
    for (const seed of live.slice(0, 8)) {
      const ms = [seed];
      let cur = stat(ms);
      // a team is built only from members that made money on the days it is read on
      if (!cur || !(cur.sharpe > 0)) continue;
      while (ms.length < 5) {
        let add: { c: Survivor; st: NonNullable<ReturnType<typeof stat>> } | null = null;
        for (const c of live) {
          if (ms.includes(c) || ms.some((m) => familyOf(m.flow) === familyOf(c.flow))) continue;
          const st = stat([...ms, c]);
          if (!st || st.cmax >= 0.7 || st.each.some((e) => !(e.sharpe > 0))) continue;
          if (st.sharpe > (add?.st.sharpe ?? cur.sharpe * 1.03)) add = { c, st };
        }
        if (!add) break;
        ms.push(add.c);
        cur = add.st;
      }
      if (ms.length >= 2 && (!best || cur.sharpe > best.st.sharpe)) best = { ms: [...ms], st: cur };
    }
    if (!best) return null;
    const { ms, st } = best;
    const top = st.each.reduce((a, b, i) => (b.sharpe > st.each[a].sharpe ? i : a), 0);
    this.teamCache = {
      members: ms.map((m, i) => ({
        id: m.id,
        name: m.name,
        weight: st.w[i],
        sharpe: st.each[i].sharpe,
        flow: m.flow,
        tfH: m.tfH,
        coins: m.coins,
        stage: m.stage,
        sig: m.sig,
        oos: { sharpe: m.oos.sharpe, t: m.oos.t, trades: m.oos.trades },
        dsr: m.dsr,
      })),
      sharpe: st.sharpe,
      maxDD: st.maxDD,
      ret: st.ret,
      corr: st.corr,
      days: st.days,
      solo: {
        name: ms[top].name,
        sharpe: st.each[top].sharpe,
        maxDD: st.each[top].maxDD,
      },
    };
    return this.teamCache;
  }

  rate(): number {
    const t = this.stamps;
    if (t.length < 2) return 0;
    const span = (t[t.length - 1] - t[0]) / 60_000;
    return span > 0 ? (t.length - 1) / span : 0;
  }

  state(running: boolean, note = "", error = ""): FarmState {
    const ladder: Record<Ladder, number> = {
      new: 0,
      incubating: 0,
      proving: 0,
      proven: 0,
      faded: 0,
    };
    for (const s of this.survivors) ladder[s.stage]++;
    return {
      running,
      cfg: this.cfg,
      startedAt: this.startedAt,
      gen: this.gen,
      tried: this.tried,
      rate: this.rate(),
      population: [...this.islands.values()].reduce(
        (a, i) => a + i.pop.length,
        0,
      ),
      funnel: { ...this.funnel },
      ladder,
      top: this.top(),
      watch: this.watch(),
      survivors: this.survivors.length,
      recent: this.recent,
      fleet: this.fleet,
      dataTo: this.dataTo,
      dataAt: this.dataAt,
      note,
      error,
      entrants: this.funnel.trained,
      kinds: Math.max(this.entered.size, this.kindsFloor),
      dupes: this.dupes,
      tops: this.tops(),
      pbo: this.overfit(),
      niches: this.archive.size,
      blocks: this.blocks(),
      team: this.team(),
    };
  }

  save(): FarmSave {
    return {
      v: 3,
      cfg: this.cfg,
      gen: this.gen,
      tried: this.tried,
      funnel: { ...this.funnel },
      survivors: this.survivors,
      population: [...this.islands.values()].flatMap((i) =>
        i.pop.map((x) => x.flow),
      ),
      seen: [...this.seen.keys()].slice(-5000),
      startedAt: this.startedAt,
      recent: this.recent,
      stats: Object.fromEntries(
        [...this.stats.entries()].map(([k, v]) => [k, [v.n, v.pass, v.surv]]),
      ),
      archive: [...this.archive.values()]
        .sort((a, b) => b.fit - a.fit)
        .slice(0, 80),
      pbo: this.pboHist,
      burned: [...this.burned].slice(-20_000),
      entered: [...this.entered].slice(-50_000),
      dupes: this.dupes,
      kindsFloor: this.kindsFloor,
    };
  }

  private restore(s: FarmSave) {
    this.gen = s.gen;
    this.tried = s.tried;
    this.funnel = { ...this.funnel, ...s.funnel };
    // one survivor of a kind: of the copies an earlier version kept, the one with the most behind it stays
    const best = new Map<string, Survivor>();
    for (const x of [...(s.survivors ?? [])].sort(
      (a, b) =>
        STAGE_RANK[b.stage] - STAGE_RANK[a.stage] ||
        (b.forward?.trades ?? 0) - (a.forward?.trades ?? 0) ||
        b.score - a.score,
    )) {
      const k = kindOf(x.flow);
      if (!best.has(k)) best.set(k, x);
    }
    this.survivors = [...best.values()];
    this.reindex();
    for (const flow of s.population ?? []) {
      if (!STYLE_MAP[flow?.style]) continue;
      let isl = this.islands.get(flow.style);
      if (!isl) {
        isl = { style: flow.style, pop: [], cursor: 0, best: -Infinity, stale: 0 };
        this.islands.set(flow.style, isl);
      }
      if (isl.pop.length < 40)
        isl.pop.push({ flow, key: keyOf(flow), fit: NaN, done: false });
    }
    for (const k of s.seen ?? []) this.seen.set(k, NaN);
    // the population's own bots are trained again (their scores were not saved)
    for (const isl of this.islands.values())
      for (const x of isl.pop) this.seen.delete(x.key);
    for (const k of s.burned ?? []) this.burned.add(k);
    for (const k of s.entered ?? []) this.entered.add(k);
    // a save from before kinds were counted: the kinds it is known to have tried
    this.kindsFloor = s.kindsFloor ?? 0;
    if (!s.entered) {
      this.kindsFloor = Math.min(2000, s.funnel?.trained ?? 0);
      for (const x of this.survivors) this.entered.add(kindOf(x.flow));
      for (const a of s.archive ?? []) if (a?.flow) this.entered.add(kindOf(a.flow));
    }
    for (const x of this.survivors) if (x.stage === "faded") this.burn(x.flow);
    this.dupes = s.dupes ?? 0;
    this.startedAt = s.startedAt ?? this.startedAt;
    this.recent = s.recent ?? [];
    for (const [k, v] of Object.entries(s.stats ?? {}))
      if (Array.isArray(v))
        this.stats.set(k, { n: v[0] ?? 0, pass: v[1] ?? 0, surv: v[2] ?? 0 });
    for (const a of s.archive ?? [])
      if (a?.flow && Number.isFinite(a.fit))
        this.archive.set(nicheOf(a.flow), { flow: a.flow, fit: a.fit });
    this.pboHist = (s.pbo ?? []).filter(Number.isFinite).slice(-5);
    // an earlier version called a survivor significant at t ≥ 2: every one is ranked again, allowing for every bot tried
    this.rank();
  }
}

/** where a survivor stands on the incubation ladder, from its forward test */
export function ladderOf(s: Pick<Survivor, "forward" | "oos">): Ladder {
  const f = s.forward;
  if (!f || f.bars < 2) return "new";
  // fell further than it ever did in testing, or lost over a fair number of trades
  if (
    (f.trades >= 5 && f.maxDD > Math.max(0.05, 1.5 * s.oos.maxDD)) ||
    (f.trades >= 10 && f.ret < 0)
  )
    return "faded";
  if (f.trades < 5) return "incubating";
  if (f.trades < 15) return f.ret >= 0 ? "proving" : "incubating";
  return f.ret > 0 ? "proven" : "faded";
}

/** the leaderboard score: the unseen Sharpe, worth more when it survived its nudges well, beat more random bots, traded enough and kept its edge at double costs; fresh data counts on top */
export function scoreOf(
  s: Pick<Survivor, "oos" | "nudge" | "beat" | "forward" | "checks">,
): number {
  const nudge = s.nudge.tried ? s.nudge.kept / s.nudge.tried : 0;
  let v =
    Math.max(0, s.oos.sharpe) *
    (0.5 + 0.5 * nudge) *
    Math.min(1, s.oos.trades / 30) *
    (0.75 + 0.25 * ((s.beat - 75) / 25));
  // an edge that mostly survives double costs is worth more than one that barely does
  if (s.checks && s.oos.sharpe > 0)
    v *= 0.7 + 0.3 * Math.max(0, Math.min(1, s.checks.cost2 / s.oos.sharpe));
  if (s.forward && s.forward.trades >= 5)
    v += 0.5 * Math.max(-2, Math.min(3, s.forward.sharpe));
  return v;
}

/** a survivor's vault result in words */
const vaultWords = (s: Survivor) =>
  s.vault && s.vault.trades
    ? `${s.vault.ret >= 0 ? "+" : ""}${(s.vault.ret * 100).toFixed(1)} % over ${s.vault.trades} trade${s.vault.trades === 1 ? "" : "s"} in the vault`
    : "no trades in the vault yet";

export const farmKey = keyOf;
export const farmKind = kindOf;
export const farmNiche = nicheOf;

/** a bar-by-bar return series as one return a day (UTC), for comparing strategies of different paces */
export function dailyOf(
  rets: ArrayLike<number>,
  times: ArrayLike<number>,
): { d0: number; r: number[] } | undefined {
  let d0 = Infinity;
  let d1 = -Infinity;
  for (let i = 0; i < times.length; i++)
    if (times[i]) {
      const d = Math.floor(times[i] / 86_400_000);
      if (d < d0) d0 = d;
      if (d > d1) d1 = d;
    }
  if (!Number.isFinite(d0)) return undefined;
  const r = new Array<number>(d1 - d0 + 1).fill(0);
  for (let i = 0; i < times.length; i++)
    if (times[i] && Number.isFinite(rets[i]))
      r[Math.floor(times[i] / 86_400_000) - d0] += rets[i];
  return { d0, r: r.map((x) => Math.round(x * 1e6) / 1e6) };
}
