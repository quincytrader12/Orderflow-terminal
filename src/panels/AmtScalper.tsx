import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtPrice, fmtTime } from '../core/format';
import { AMT_STATE_LABEL, onAmtEvent, useAmtBots, useAmtLive } from '../desktop/amt';
import { desktop, DesktopOnlyError, type AmtBacktest, type AmtBot, type AmtBotInput, type AmtEvent, type AmtBrain, type AmtOrderFlow, type AmtParams, type AmtSnapshot, type AmtTrainResult, type AmtTrainRow, type AmtTrainSegment, type CcxtExchangeInfo } from '../desktop/bridge';
import { fetchJson } from '../exchanges/ws';
import { yahooChart } from '../shared/yahoo';
import { pickSymbol, unifiedCandidates } from '../desktop/trading';
import { useVaultKeys } from '../desktop/vault';
import { hub } from '../market/hub';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Check, Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';

export interface AmtConfig {
  botId: string;
  tab: 'live' | 'settings' | 'backtest' | 'train';
}

export const AMT_DEFAULTS: AmtConfig = { botId: '', tab: 'live' };

type NumKey = { [K in keyof AmtParams]: AmtParams[K] extends number ? K : never }[keyof AmtParams];

const BALANCE_FIELDS: [NumKey, string, string][] = [
  ['riskPct', 'Risk per trade (% of balance)', 'Loss if the stop is hit, as a share of the current balance — sizes grow with gains and shrink after losses'],
  ['maxLeverage', 'Max position (× balance)', 'Position value at most this many times the balance (futures margin is set to isolated at this leverage)'],
  ['dailyLossPct', 'Daily loss limit (% of balance)', 'The bot pauses until the next UTC day at this loss'],
  ['maxDrawdownPct', 'Max drawdown (%)', 'The bot stops for good this far below its peak balance (0 = off)'],
  ['lossStreak', 'Pause after losses in a row', 'Sit out after this many consecutive losses (0 = off)'],
  ['pauseMin', 'Pause length (min)', ''],
  ['maxTradesPerHour', 'Max trades / hour', ''],
];

const MAKER_FIELDS: [NumKey, string, string][] = [
  ['makerFeeBps', 'Maker fee (bps)', 'Binance USDⓈ-M futures: 2 (0.02 %); live bots read the exchange’s rate'],
  ['makerWaitSec', 'Entry limit wait (s)', 'How long an entry limit rests before the bot decides'],
  ['makerChaseR', 'Chase after (R)', 'Price this far from the limit: take it at market if it still pays, else let it go'],
  ['exitMakerSec', 'Exit limit wait (s)', 'How long a target / stall / time exit is offered before market'],
];

const RISK_FIELDS: [NumKey, string, string][] = [
  ['riskUsd', 'Risk per trade ($)', 'Loss if the stop is hit; size = risk ÷ stop distance'],
  ['maxPositionUsd', 'Max position ($)', 'Never larger than this, and never above the ticket’s order cap'],
  ['maxDailyLossUsd', 'Daily loss limit ($)', 'The bot switches itself off at this realised loss (UTC day)'],
  ['maxTradesPerHour', 'Max trades / hour', ''],
];

const ADVANCED_FIELDS: [string, [NumKey, string, string][]][] = [
  [
    'Value (profile)',
    [
      ['profileMinutes', 'Profile window (min)', 'Rolling volume profile that defines value'],
      ['valueAreaPct', 'Value area %', 'Classic 70%'],
      ['binBps', 'Bin width (bps)', 'Price bucket size relative to price'],
      ['sessionHours', 'Session length (h)', 'Prior-value session for the 80% rule (UTC aligned)'],
      ['warmupMinutes', 'Warm-up (min)', 'Data needed before trading'],
    ],
  ],
  [
    'Order flow',
    [
      ['flowSec', 'Flow window (s)', 'Aggressor delta and intensity window'],
      ['deltaThreshold', 'Delta threshold', '(buy−sell)/total needed to confirm, 0–1'],
      ['intensityMin', 'Volume intensity ×', 'Recent volume vs 10-min average for breakouts'],
      ['bookBandBps', 'Book band (bps)', 'Depth around mid used for imbalance'],
      ['bookImbalanceMin', 'Book imbalance', 'Needed in the trade’s direction, 0–1'],
      ['maxSpreadBps', 'Max spread (bps)', ''],
    ],
  ],
  [
    'Auction',
    [
      ['probeBins', 'Probe distance (bins)', 'How far beyond VAH/VAL counts as a probe'],
      ['acceptSec', 'Acceptance (s)', 'Time beyond value that counts as acceptance'],
      ['rejectSec', 'Rejection window (s)', 'A probe back inside value within this is a rejection'],
      ['reentrySec', '80% rule hold (s)', 'Time back inside prior value before the re-entry trade'],
    ],
  ],
  [
    'Trade management',
    [
      ['stopBufferBins', 'Stop buffer (bins)', 'Beyond the probe extreme / value edge'],
      ['minRR', 'Min reward : risk', ''],
      ['targetCostX', 'Target vs costs ×', 'The target must be at least this many times the round-trip fees + slippage'],
      ['maxHoldSec', 'Max hold (s)', 'Time stop'],
      ['breakevenAtR', 'Breakeven at R', 'Move the stop to entry + costs after this many R (0 = off)'],
      ['cooldownSec', 'Cooldown after loss (s)', ''],
      ['feeBps', 'Fee per side (bps)', 'Used for R:R checks and paper PnL (live uses the exchange taker fee if higher)'],
      ['slippageBps', 'Paper slippage (bps)', ''],
    ],
  ],
];

type Style = AmtParams['style'];
/** What the style chips show: the engine styles plus the small-account growth preset. */
type Preset = Style | 'growth';
const presetOf = (p: AmtParams): Preset => (p.sizing === 'balance' && p.style === 'scalp' ? 'growth' : p.style);
const PRESET_NAME: Record<Preset, string> = { scalp: 'Scalp', intraday: 'Intraday', growth: 'Growth (small account)', orderflow: 'Order-flow hybrid', adaptive: 'Adaptive scalper' };
const ADAPTIVE_TEXT =
  'The terminal’s most complete bot: every scalp and order-flow trigger, judged by a confluence score before it trades. Stops go beyond the one-minute noise (smaller size, same money at risk). In a trade it reads momentum every second — cuts trades the flow turns against, leaves ones that stall, trails winners without snapping to breakeven, and lets them run past the target while momentum lasts. After each exit it watches price and learns: wider stops after noise stop-outs, more patience after early exits that would have worked, a bench for setups that keep losing. It explains every decision in the activity log. Sizes from the balance like Growth.';
const ORDERFLOW_TEXT =
  'Reads the tape, the footprint, the order book and the liquidity map like an order-flow trader, and runs three setups in one bot — the market decides which fires. Sizes from the balance like Growth (1.5 % risk, pause after 3 losses, hard stop at a 20 % drawdown). Book checks (order-flow imbalance, queue, walls, spoofs) apply live; backtests and training test the trade-based core.';
const GROWTH_TEXT =
  'Compounds a small balance: risks a % of the current balance on A+ scalps only — stricter order-flow confirmation, 2R minimum, targets that clear fees 4×, the trade manager instead of a fixed breakeven, a pause after 3 losses in a row and a hard stop at a 20 % drawdown. Train it on recorded data before going live.';

const SETUPS: Record<Style, [keyof AmtParams['setups'], string, string][]> = {
  scalp: [
    ['fade', 'Responsive fade', 'Probe beyond VAH/VAL is rejected → trade back to POC'],
    ['breakout', 'Initiative breakout', 'Price accepted outside value with strong delta → trade the extension'],
    ['reentry', '80% rule', 'Session opens outside prior value, re-enters and holds → trade to the far edge'],
  ],
  intraday: [
    ['ibBreakout', 'Initial-balance extension', 'First-hour range broken and held → range extension of 1× IB (trend day)'],
    ['priorAccept', 'Prior-value acceptance', 'Accepted outside yesterday’s value → value migrating, trade one value-area width'],
    ['priorReject', 'Prior-value rejection', 'Probe beyond yesterday’s value fails → responsive trade back to prior POC'],
    ['reentry', '80% rule', 'Session opens outside prior value, re-enters and holds → trade to the far edge'],
  ],
  adaptive: [
    ['fade', 'Responsive fade', 'Rejected probe of VAH/VAL → back to POC'],
    ['breakout', 'Initiative breakout', 'Accepted outside value with strong delta → the extension'],
    ['reentry', '80% rule', 'Re-accepted prior value → the far edge'],
    ['absorption', 'Absorption reversal', 'Aggression absorbed at a wall / value edge / pool, then delta flips'],
    ['continuation', 'Imbalance continuation', 'Stacked footprint imbalances retested and held'],
    ['sweep', 'Sweep & reclaim', 'A liquidity pool run on a burst and reclaimed'],
  ],
  orderflow: [
    ['absorption', 'Absorption reversal', 'Heavy aggression into a wall / value edge / swing that does not move price, then delta flips → trade the reversal; exits if the wall is pulled'],
    ['continuation', 'Imbalance continuation', 'Stacked footprint imbalances on initiative volume, retested and held with delta and OFI → join toward the next liquidity'],
    ['sweep', 'Sweep & reclaim', 'A swing / prior extreme / round number is run on a tape or liquidation burst and reclaimed → fade the stop run'],
  ],
};

const STYLE_TEXT: Record<Style, string> = {
  scalp: 'Seconds to minutes. Rolling value area, order-flow confirmation, many small trades.',
  intraday: 'Hours. Session structure (initial balance, prior-day value), wider stops, at most a few trades a session, trailing stop, flat before the session closes.',
  orderflow: ORDERFLOW_TEXT,
  adaptive: ADAPTIVE_TEXT,
};

const ADAPTIVE_FIELDS: [NumKey, string, string][] = [
  ['minScore', 'Evidence needed (score)', 'Delta, volume, OFI, queue, regime, location and recent form add up; below this no trade'],
  ['erChop', 'Rotation below (efficiency)', 'Kaufman efficiency ratio of the last 15 minutes: below this the market is rotating'],
  ['erTrend', 'Trend above (efficiency)', 'Above this it is trending'],
];

const MANAGER_TEXT =
  'Reads every open trade each second — delta, order-flow imbalance and price speed in the trade’s direction. A losing trade the flow and price have both turned against is cut early; a trade that was working and loses steam is taken off with a small win or near breakeven; one that stalls is closed; a winner trails a noise-width behind the best price (no reflex breakeven that a wick takes out) and runs past its target while momentum lasts. Stops go beyond the one-minute noise with a smaller size, and after each exit it watches price and adjusts. Every decision is explained in the activity log.';

const MANAGER_FIELDS: [NumKey, string, string][] = [
  ['stopNoiseX', 'Stop beyond noise ×', 'Starting stop width in one-minute ranges (the bot widens it after noise stop-outs)'],
  ['stopCostX', 'Stop vs fees ×', 'The stop is at least this many times the round-trip fees + slippage'],
  ['maxStopNoise', 'Max stop (× noise)', 'Pass on trades whose stop would be wider than this'],
  ['stallSec', 'Stall time (s)', 'Out if a trade has not made +0.5R by then and momentum is flat'],
  ['exitMomentum', 'Cut a loser at momentum', 'A losing trade is cut when momentum stays below −this (and price moves against it) for 5 s'],
  ['extendMomentum', 'Run past target at', 'At the target, momentum above this lets the trade run'],
  ['trailAtR', 'Trail from (R)', 'Start trailing once the trade has been this far in profit'],
  ['trailNoiseX', 'Trail distance (× noise)', 'Trailing stop distance behind the best price'],
  ['watchSec', 'Watch after exit (s)', 'How long it follows price after an exit to learn from it'],
  ['benchMin', 'Bench a losing setup (min)', 'A setup that lost 2.5R over its last 4 trades sits out this long'],
  ['steamAtR', 'Losing steam after (R)', 'A trade that has been this far in profit is taken off when momentum fades'],
  ['steamMomentum', 'Losing steam at momentum', 'Momentum below −this for 3 s counts as losing steam'],
];

const ORDERFLOW_FIELDS: [string, [NumKey, string, string][]][] = [
  [
    'Footprint & tape',
    [
      ['barSec', 'Footprint bar (s)', 'Bar length for stacked imbalances and swing pools'],
      ['fpBinBps', 'Footprint row (bps)', 'Price row height of the footprint the bot reads'],
      ['imbalanceRatio', 'Imbalance ratio', 'Diagonal ask vs bid (or bid vs ask) volume — 3 means 300 %'],
      ['stackMin', 'Stacked rows', 'Consecutive imbalanced rows needed'],
      ['contRetestSec', 'Retest window (s)', 'How long a stacked-imbalance zone waits for its retest'],
      ['flipSec', 'Flip window (s)', 'Short delta window that must turn with the trade'],
      ['flipDelta', 'Flip delta', '(buy−sell)/total in that window, 0–1'],
    ],
  ],
  [
    'Absorption',
    [
      ['absorbSec', 'Window (s)', 'Aggression measured over this window'],
      ['absorbX', 'Aggression ×', 'Aggressive volume vs the normal 10-min rate'],
      ['absorbDelta', 'Aggression delta', 'How one-sided the aggression must be, 0–1'],
      ['absorbMaxBins', 'Max progress (bins)', 'New extreme allowed while being absorbed'],
      ['absorbConfirmSec', 'Confirm within (s)', 'Time for delta to flip after absorption'],
      ['levelBins', 'At a level within (bins)', 'How close to a wall / value edge / pool counts'],
    ],
  ],
  [
    'Liquidity pools & sweeps',
    [
      ['swingBars', 'Swing pivot (bars)', 'Bars either side of a swing high/low'],
      ['poolHours', 'Keep pools (h)', ''],
      ['roundBps', 'Round-number step (bps)', 'Rounded to 1/2/5 × 10ⁿ'],
      ['sweepMinBps', 'Sweep at least (bps)', 'Beyond the level'],
      ['sweepMaxBps', 'Sweep at most (bps)', 'Further than this is a breakout, not a stop run'],
      ['sweepReclaimSec', 'Reclaim within (s)', ''],
      ['sweepBurstX', 'Burst ×', 'Aggressive volume vs normal during the run'],
      ['sweepLiqShare', 'Liquidations alone (× normal)', 'Without a burst, liquidations must be this share of a normal 10 s of volume'],
      ['sweepHoldSec', 'Reclaim must hold (s)', 'Price back across the level this long — a poke back is not a reclaim'],
      ['sweepQuietSec', 'Cascade quiet (s)', 'No liquidations in the sweep’s direction for this long before fading it'],
      ['sweepCooloffMin', 'Sit out after a losing sweep (min)', 'No more sweeps that way for this long after one lost'],
    ],
  ],
  [
    'Order book & liquidity map',
    [
      ['ofiSec', 'OFI window (s)', 'Order-flow imbalance at the best bid/ask (Cont–Kukanov–Stoikov)'],
      ['ofiMin', 'OFI needed', 'Net/gross OFI in the trade’s direction, 0–1'],
      ['queueMin', 'Queue imbalance limit', 'Skip when the top 3 levels lean this hard against the trade'],
      ['wallX', 'Wall size ×', 'A wall is this many times the median level'],
      ['wallMinSec', 'Wall age (s)', 'Only walls that have stood this long count'],
      ['wallBandBps', 'Wall band (bps)', 'Walls tracked within this of the mid'],
      ['ofTargetR', 'Target (R)', 'When no POC / pool target is in reach'],
    ],
  ],
];

const INTRADAY_FIELDS: [NumKey, string, string][] = [
  ['ibMinutes', 'Initial balance (min)', 'Opening range length — 60 is the classic first hour'],
  ['ibAcceptMin', 'IB extension held (min)', 'Time beyond the IB edge before the extension counts'],
  ['priorAcceptMin', 'Prior-value acceptance (min)', 'Time outside yesterday’s value that counts as acceptance'],
  ['priorRejectMin', 'Prior-value rejection (min)', 'A probe back inside within this is a rejection'],
  ['intradayFlowSec', 'Flow window (s)', 'Delta window for intraday confirmation (max 590)'],
  ['intradayDelta', 'Delta threshold', '(buy−sell)/total needed, 0–1'],
  ['ibTargetX', 'IB target ×', 'Target = IB edge ± this many IB ranges'],
  ['maxTradesPerSession', 'Max trades / session', ''],
  ['flatBeforeCloseMin', 'Flat before close (min)', 'Exit open positions this long before the session ends'],
  ['trailAtR', 'Trail at R', 'Trail the stop to the developing session POC after this many R (0 = off)'],
];

const usd = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);

export function AmtScalper({ config: c, setConfig }: PanelProps<AmtConfig>) {
  const [bots, reload] = useAmtBots();
  const [defaults, setDefaults] = useState<AmtParams | null>(null);
  const snaps = useAmtLive((s) => s.snaps);
  const [snap, setSnap] = useState<AmtSnapshot | null>(null);
  const [events, setEvents] = useState<AmtEvent[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'live' | 'stop' | null>(null);

  useEffect(() => {
    desktop?.amt.defaults().then(setDefaults).catch(() => undefined);
  }, []);

  const bot = bots?.find((b) => b.id === c.botId) ?? null;
  useEffect(() => {
    if (bots && bots.length && !bot) setConfig({ botId: bots[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  // live status and event log for the selected bot
  useEffect(() => {
    setSnap(null);
    setEvents([]);
    if (!desktop || !c.botId) return;
    desktop.amt.snapshot(c.botId).then(setSnap).catch(() => undefined);
    desktop.amt.events(c.botId).then(setEvents).catch(() => undefined);
    return onAmtEvent((e) => e.id === c.botId && setEvents((l) => [...l, e].slice(-200)));
  }, [c.botId]);
  useEffect(() => {
    const s = snaps[c.botId];
    if (s) setSnap(s);
    else if (snap?.running) setSnap({ ...snap, running: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snaps, c.botId]);

  if (!desktop) return <Empty>{new DesktopOnlyError('The AMT scalper').message}</Empty>;
  if (!bots || !defaults) return <Empty>Loading…</Empty>;

  const running = Boolean(bot?.running && snaps[bot.id]?.running !== false) || Boolean(snap?.running);

  const create = async () => {
    const lastPrimary = hub().primary.inst;
    const sym = lastPrimary.venue === 'ccxt' ? lastPrimary.symbol.split('::')[1] : `${lastPrimary.base}/USDT:USDT`;
    const id = await desktop!.amt.save({ name: '', mode: 'paper', exchangeId: 'binance', symbol: sym, secretId: null, exchangeStop: true, params: defaults });
    reload();
    setConfig({ botId: id, tab: 'settings' });
  };

  const start = async () => {
    setConfirm(null);
    setMsg(null);
    try {
      await desktop!.amt.start(bot!.id);
      setConfig({ tab: 'live' });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
    reload();
  };

  const stop = async (flatten: boolean) => {
    setConfirm(null);
    await desktop!.amt.stop(bot!.id, flatten).catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
    reload();
  };

  const toggle = () => {
    if (!bot) return;
    if (running) {
      if (snap?.position) setConfirm('stop');
      else void stop(false);
    } else if (bot.mode === 'live') setConfirm('live');
    else void start();
  };

  return (
    <div className="panel amt">
      <Toolbar>
        <Select value={c.botId} options={[{ value: '', label: bots.length ? 'Choose bot…' : 'No bots yet' }, ...bots.map((b) => ({ value: b.id, label: `${b.running ? '● ' : ''}${b.name}${presetOf(b.params) === 'growth' ? ' · growth' : b.params.style === 'intraday' ? ' · intraday' : b.params.style === 'orderflow' ? ' · order flow' : b.params.style === 'adaptive' ? ' · adaptive' : ''}` }))]} onChange={(botId) => setConfig({ botId })} width={150} />
        <button className="chip" onClick={() => void create()} title="New AMT bot">
          + New
        </button>
        {bot && (
          <>
            {(['live', 'settings', 'backtest', 'train'] as const).map((t) => (
              <button key={t} className={`chip ${c.tab === t ? 'active' : ''}`} onClick={() => setConfig({ tab: t })}>
                {t === 'live' ? 'Monitor' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </>
        )}
        <Spacer />
        {bot && (
          <>
            <span className={`env-badge ${bot.mode === 'live' ? 'live' : 'test'}`}>{bot.mode === 'live' ? 'LIVE' : 'PAPER'}</span>
            <button className={`algo-switch ${running ? 'on' : ''}`} onClick={toggle} title={running ? 'Switch the bot off' : 'Switch the bot on'} aria-pressed={running}>
              <span className="knob" />
              <span className="lbl">{running ? 'ON' : 'OFF'}</span>
            </button>
          </>
        )}
      </Toolbar>
      {confirm === 'live' && bot && <LiveConfirm bot={bot} onCancel={() => setConfirm(null)} onStart={() => void start()} />}
      {confirm === 'stop' && (
        <div className="confirm-card sell amt-confirm">
          <div>The bot has an open position. Stop and leave it open (with its exchange stop, if placed), or close it at market?</div>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn ghost" onClick={() => void stop(false)}>
              Stop, keep position
            </button>
            <button className="btn sell" onClick={() => void stop(true)}>
              Stop & close position
            </button>
          </div>
        </div>
      )}
      {msg && <div className={`panel-note ${msg.ok ? 'up' : 'down'}`}>{msg.text}</div>}
      <div className="scroll amt-body">
        {!bot ? (
          <Intro onCreate={() => void create()} />
        ) : c.tab === 'settings' ? (
          <Settings key={bot.id} bot={bot} locked={running} onSaved={reload} />
        ) : c.tab === 'backtest' ? (
          <Backtest bot={bot} />
        ) : c.tab === 'train' ? (
          <Train key={bot.id} bot={bot} locked={running} onApplied={reload} />
        ) : (
          <Monitor bot={bot} snap={snap} running={running} events={events} />
        )}
      </div>
    </div>
  );
}

function Intro({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="amt-intro">
      <h3>Auction Market Theory bots</h3>
      <p>
        The bot builds a rolling volume profile (POC and the 70% value area), tracks whether price is in <b>balance</b> inside value, <b>probing</b> outside it, or has been <b>accepted</b> outside it, and
        waits for order flow — aggressor delta, volume intensity and the order book — to agree before it trades:
      </p>
      {(['adaptive', 'scalp', 'intraday', 'orderflow'] as Style[]).map((st) => (
        <div key={st}>
          <b>{PRESET_NAME[st]}</b> <span className="muted">— {STYLE_TEXT[st]}</span>
          <ul>
            {SETUPS[st].map(([k, name, text]) => (
              <li key={k}>
                <b>{name}</b> — {text}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div>
        <b>{PRESET_NAME.growth}</b> <span className="muted">— {GROWTH_TEXT}</span>
      </div>
      <p className="muted">Every bot starts in paper mode on the live market. Switch to live only after it has paper-traded and backtested well, and start on a testnet key.</p>
      <button className="btn" onClick={onCreate}>
        Create a bot
      </button>
    </div>
  );
}

function LiveConfirm({ bot, onCancel, onStart }: { bot: AmtBot; onCancel: () => void; onStart: () => void }) {
  const keys = useVaultKeys('exchange') ?? [];
  const key = keys.find((k) => k.id === bot.secretId);
  const p = bot.params;
  const test = key?.meta.fields.sandbox === 'true';
  return (
    <div className="confirm-card buy amt-confirm">
      <div>
        {!test && <span className="env-badge live">LIVE</span>} <b>{bot.name}</b> will send real market orders for <b className="mono">{bot.symbol}</b> on {key?.exchange ?? 'the exchange'}
        {test ? ' (testnet)' : ''} with key “{key?.label ?? '?'}”:{' '}
        {p.sizing === 'balance' ? (
          <>
            it reads your balance on the exchange and risks {p.riskPct}% of it per trade, positions up to {p.maxLeverage}× the balance on isolated margin, pauses after a {p.dailyLossPct}% loss in a day and stops for good at a {p.maxDrawdownPct}% drawdown or on any order error.
          </>
        ) : (
          <>
            risk ${p.riskUsd} per trade, positions up to ${p.maxPositionUsd} (or your ticket cap, whichever is lower), and it switches itself off after a ${p.maxDailyLossUsd} loss today or on any order error.
          </>
        )}{' '}
        The terminal must stay open while it runs.
      </div>
      <div className="confirm-actions">
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn buy" onClick={onStart}>
          Start live bot
        </button>
      </div>
    </div>
  );
}

function Settings({ bot, locked, onSaved }: { bot: AmtBot; locked: boolean; onSaved: () => void }) {
  const [d, setD] = useState<AmtBotInput>({ id: bot.id, name: bot.name, mode: bot.mode, exchangeId: bot.exchangeId, symbol: bot.symbol, secretId: bot.secretId, exchangeStop: bot.exchangeStop, params: bot.params });
  const [exchanges, setExchanges] = useState<CcxtExchangeInfo[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const keys = useVaultKeys('exchange') ?? [];
  const key = keys.find((k) => k.id === d.secretId);
  const ex = d.mode === 'live' ? key?.exchange ?? '' : d.exchangeId;

  useEffect(() => {
    desktop!.ccxt.exchanges().then(setExchanges).catch(() => undefined);
  }, []);
  useEffect(() => {
    setMarkets([]);
    if (!ex) return;
    desktop!.ccxt
      .markets(ex)
      .then((m) => setMarkets(m.map((x) => x.symbol)))
      .catch(() => undefined);
  }, [ex]);

  const [presets, setPresets] = useState<Record<Preset, AmtParams> | null>(null);
  useEffect(() => {
    desktop!.amt.presets().then(setPresets).catch(() => undefined);
  }, []);
  const P = d.params;
  const setP = (patch: Partial<AmtParams>) => setD({ ...d, params: { ...P, ...patch } });
  const num = (k: NumKey, label: string, hint: string) => (
    <label className="amt-field" key={k} title={hint}>
      <span>{label}</span>
      <input className="ctl mono" type="number" disabled={locked} value={P[k]} step="any" onChange={(e) => setP({ [k]: Number(e.target.value) } as Partial<AmtParams>)} />
    </label>
  );

  const save = async () => {
    try {
      await desktop!.amt.save({ ...d, exchangeId: d.mode === 'live' ? key?.exchange ?? d.exchangeId : d.exchangeId });
      setNote({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (e) {
      setNote({ ok: false, text: String((e as Error).message ?? e) });
    }
  };

  const chartSymbol = () => {
    const s = pickSymbol(unifiedCandidates(hub().primary.inst), markets);
    if (s) setD({ ...d, symbol: s });
    else setNote({ ok: false, text: `${ex || 'This exchange'} does not list the chart’s market` });
  };

  return (
    <fieldset className="amt-settings" disabled={locked}>
      {locked && <div className="muted">Switch the bot off to change its settings.</div>}
      <div className="amt-grid">
        <label className="amt-field">
          <span>Name</span>
          <input className="ctl" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={`AMT ${d.symbol}`} />
        </label>
        <label className="amt-field">
          <span>Mode</span>
          <div className="seg">
            {(['paper', 'live'] as const).map((m) => (
              <button key={m} type="button" className={`chip ${d.mode === m ? 'active' : ''}`} onClick={() => setD({ ...d, mode: m })}>
                {m === 'paper' ? 'Paper' : 'Live'}
              </button>
            ))}
          </div>
        </label>
        {d.mode === 'paper' ? (
          <label className="amt-field">
            <span>Exchange (market data)</span>
            <input className="ctl" list="amt-exchanges" value={d.exchangeId} onChange={(e) => setD({ ...d, exchangeId: e.target.value.trim().toLowerCase() })} />
            <datalist id="amt-exchanges">
              {exchanges.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.pro ? '' : ' (REST polling)'}
                </option>
              ))}
            </datalist>
          </label>
        ) : (
          <label className="amt-field">
            <span>Exchange key</span>
            <Select
              value={d.secretId ?? ''}
              options={[{ value: '', label: 'Choose key…' }, ...keys.map((k) => ({ value: k.id, label: `${k.label} · ${k.exchange}${k.meta.fields.sandbox === 'true' ? ' · testnet' : ''}${k.meta.fields.trading === 'enabled' ? '' : ' (read-only)'}` }))]}
              onChange={(secretId) => setD({ ...d, secretId: secretId || null })}
            />
          </label>
        )}
        <label className="amt-field">
          <span>Symbol</span>
          <div className="input-with-chips">
            <input className="ctl mono" list="amt-markets" value={d.symbol} onChange={(e) => setD({ ...d, symbol: e.target.value.trim().toUpperCase() })} placeholder="BTC/USDT:USDT" />
            <button type="button" className="chip" onClick={chartSymbol} title="Use the market on the chart">
              chart
            </button>
          </div>
          <datalist id="amt-markets">
            {markets.slice(0, 4000).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>
      {d.mode === 'live' && key && key.meta.fields.trading !== 'enabled' && <div className="down amt-warn">This key is read-only. Tick “Allow trading” on it in 🔌 Connect before starting a live bot.</div>}
      {d.mode === 'live' && (
        <Check checked={d.exchangeStop} onChange={(exchangeStop) => setD({ ...d, exchangeStop })}>
          Place a protective stop on the exchange for each derivatives position (survives the app closing)
        </Check>
      )}

      <div className="section-title">Style</div>
      <div className="seg">
        {(['adaptive', 'scalp', 'intraday', 'growth', 'orderflow'] as Preset[]).map((st) => (
          <button
            key={st}
            type="button"
            className={`chip ${presetOf(P) === st ? 'active' : ''}`}
            onClick={() => {
              if (presetOf(P) === st || !presets) return;
              // load the preset but keep the owner's cost settings, and their
              // fixed-$ risk unless the preset sizes from the balance
              const keep = { riskUsd: P.riskUsd, maxPositionUsd: P.maxPositionUsd, maxDailyLossUsd: P.maxDailyLossUsd, allowShort: P.allowShort, useBook: P.useBook, feeBps: P.feeBps, slippageBps: P.slippageBps };
              setD({ ...d, params: { ...presets[st], ...keep, ...(st === 'growth' || st === 'orderflow' || st === 'adaptive' ? { maxPositionUsd: presets[st].maxPositionUsd } : {}) } });
            }}
          >
            {PRESET_NAME[st]}
          </button>
        ))}
      </div>
      <div className="muted amt-hint">{presetOf(P) === 'growth' ? GROWTH_TEXT : STYLE_TEXT[P.style]}</div>

      <div className="section-title">Setups</div>
      {SETUPS[P.style].map(([k, name, text]) => (
        <Check key={k} checked={P.setups[k]} onChange={(v) => setP({ setups: { ...P.setups, [k]: v } })}>
          <b>{name}</b> <span className="muted">— {text}</span>
        </Check>
      ))}

      <div className="section-title">Risk</div>
      <div className="seg">
        {(['fixed', 'balance'] as const).map((m) => (
          <button key={m} type="button" className={`chip ${P.sizing === m ? 'active' : ''}`} onClick={() => setP({ sizing: m })}>
            {m === 'fixed' ? 'Fixed $ risk' : '% of balance (compounding)'}
          </button>
        ))}
      </div>
      {P.sizing === 'balance' ? (
        <>
          <BalanceInput value={P.accountUsd} locked={locked} live={d.mode === 'live'} onChange={(accountUsd) => setP({ accountUsd })} />
          <div className="amt-grid">
            {BALANCE_FIELDS.map(([k, l, h]) => num(k, l, h))}
            {num('maxPositionUsd', 'Max position ($)', 'Hard cap in dollars, and never above the ticket’s order cap')}
          </div>
          <SizingPreview p={P} />
        </>
      ) : (
        <div className="amt-grid">{RISK_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
      )}
      {P.style !== 'intraday' && (
        <>
          <div className="section-title">Trade manager</div>
          <Check checked={P.manageTrades || P.style === 'adaptive'} onChange={(manageTrades) => P.style !== 'adaptive' && setP({ manageTrades })}>
            <b>Manage trades on momentum</b>
            {P.style === 'adaptive' && <span className="muted"> (always on for this style)</span>}
          </Check>
          <div className="muted amt-hint">{P.manageTrades || P.style === 'adaptive' ? MANAGER_TEXT : 'Off: fixed stop, breakeven at the set R, target and time stop only.'}</div>
        </>
      )}
      <div className="section-title">Execution</div>
      <div className="seg">
        {(['maker', 'market'] as const).map((m) => (
          <button key={m} type="button" className={`chip ${P.orderMode === m ? 'active' : ''}`} onClick={() => setP({ orderMode: m })}>
            {m === 'maker' ? 'Limit first (maker fee)' : 'Market'}
          </button>
        ))}
      </div>
      <div className="muted amt-hint">
        {P.orderMode === 'maker'
          ? 'Fades, absorption, sweeps and 80%-rule entries rest as post-only limits on the bot’s own side of the book and pay the maker fee. If price leaves without filling it, the bot takes it at market only while the trade still meets every rule from there (R:R, fees, size) — otherwise it lets it go rather than chase. Target, stall and time exits are offered as limits for a few seconds first; stops and every protective exit always go at market.'
          : 'Every order goes at market and pays the taker fee: always filled, at a higher cost.'}
      </div>
      {P.orderMode === 'maker' && (
        <>
          <div className="amt-grid">{MAKER_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
          <Check checked={P.makerInitiative} onChange={(makerInitiative) => setP({ makerInitiative })}>
            Limits on breakout entries too <span className="muted">— off: breakouts and continuations go at market, because price rarely comes back to fill them and missing those runners costs more than the fee saved</span>
          </Check>
        </>
      )}
      <Check checked={P.allowShort} onChange={(allowShort) => setP({ allowShort })}>
        Allow shorts (ignored on spot markets)
      </Check>
      <Check checked={P.useBook} onChange={(useBook) => setP({ useBook })}>
        Require the order book to confirm (imbalance and spread)
      </Check>

      <details className="amt-adv">
        <summary>Advanced AMT parameters</summary>
        {P.style === 'intraday' && (
          <div>
            <div className="section-title">Intraday session</div>
            <div className="amt-grid">{INTRADAY_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
          </div>
        )}
        {P.style === 'adaptive' && (
          <div>
            <div className="section-title">Judgement</div>
            <div className="amt-grid">{ADAPTIVE_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
          </div>
        )}
        {P.style !== 'intraday' && (P.manageTrades || P.style === 'adaptive') && (
          <div>
            <div className="section-title">Trade manager</div>
            <div className="amt-grid">{MANAGER_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
          </div>
        )}
        {(P.style === 'orderflow' || P.style === 'adaptive') && (
          <>
            {ORDERFLOW_FIELDS.map(([group, fields]) => (
              <div key={group}>
                <div className="section-title">{group}</div>
                <div className="amt-grid">{fields.map(([k, l, h]) => num(k, l, h))}</div>
              </div>
            ))}
            <Check checked={P.ofRegime} onChange={(ofRegime) => setP({ ofRegime })}>
              Regime filter — no absorption fades against accepted value, continuation only on the initiative side of the POC
            </Check>
          </>
        )}
        {ADVANCED_FIELDS.map(([group, fields]) => (
          <div key={group}>
            <div className="section-title">{group}</div>
            <div className="amt-grid">{fields.map(([k, l, h]) => num(k, l, h))}</div>
          </div>
        ))}
      </details>

      <div className="confirm-actions">
        {note && <span className={note.ok ? 'up' : 'down'}>{note.text}</span>}
        <button
          type="button"
          className="btn ghost"
          onClick={async () => {
            if (!confirm(`Delete “${bot.name}”?`)) return;
            await desktop!.amt.remove(bot.id);
            onSaved();
          }}
        >
          Delete bot
        </button>
        <button type="button" className="btn" onClick={() => void save()}>
          Save
        </button>
      </div>
    </fieldset>
  );
}

/** The adaptive scalper's state of mind: noise, regime, how it has adapted, momentum in the trade. */
function BrainStats({ br, p }: { br: AmtBrain; p: number }) {
  const regime = br.regime && br.regime.kind !== 'unknown' ? `${br.regime.kind === 'trend' ? `trend ${br.regime.dir > 0 ? 'up' : 'down'}` : br.regime.kind} (${fmtNum(br.regime.er ?? 0, 2)})` : 'reading…';
  return (
    <>
      <Stat label="Market" value={regime} />
      <Stat label="1-min noise" value={br.noise === null ? '—' : `${fmtNum((br.noise / p) * 1e4, 1)} bps`} />
      <Stat label="Stop width" value={`${fmtNum(br.noiseX, 2)}× noise`} />
      <Stat label="Patience" value={`${fmtNum(br.patience, 2)}×`} />
      {br.momentum !== null && <Stat label="Momentum" value={fmtNum(br.momentum, 2)} tone={br.momentum} />}
      {br.benched.length > 0 && <Stat label="Benched" value={br.benched.map((b) => `${b.setup} ${b.minutes}m`).join(' · ')} />}
    </>
  );
}

/** What the order-flow hybrid sees: book pressure, walls, and the setups it is tracking. */
function OrderFlowStats({ of }: { of: AmtOrderFlow }) {
  const side = (d: number) => (d > 0 ? 'long' : 'short');
  const watching = [
    of.absorb && `absorption ${side(of.absorb.dir)} at ${of.absorb.level}`,
    of.zone && `${of.zone.dir > 0 ? 'buy' : 'sell'} imbalance zone ${fmtPrice(of.zone.lo)}–${fmtPrice(of.zone.hi)}${of.zone.touched ? ' (retesting)' : ''}`,
    of.sweep && `sweep of ${of.sweep.kind} ${fmtPrice(of.sweep.level)} — waiting for the reclaim`,
  ].filter(Boolean);
  const wall = (w: AmtOrderFlow['walls'][number]) => `${fmtPrice(w.price)} ${w.side}${w.iceberg ? ' ❄' : ''} ${w.ageSec}s`;
  return (
    <>
      <Stat label="OFI" value={of.ofi === null ? 'no book' : fmtNum(of.ofi, 2)} tone={of.ofi ?? 0} />
      <Stat label="Queue imb." value={of.queue === null ? '—' : fmtNum(of.queue, 2)} tone={of.queue ?? 0} />
      <Stat label="Walls" value={of.walls.length ? of.walls.slice(0, 2).map(wall).join(' · ') : '—'} />
      <Stat label="Pulled (5 min)" value={String(of.pulls)} />
      <Stat label="Swing pools" value={String(of.pools)} />
      <Stat label="Watching" value={watching.length ? watching.join(' · ') : 'no setup forming'} />
    </>
  );
}

function Monitor({ bot, snap, running, events }: { bot: AmtBot; snap: AmtSnapshot | null; running: boolean; events: AmtEvent[] }) {
  const s = snap;
  const stats = s?.stats;
  const pos = s?.position;
  return (
    <div className="amt-monitor">
      <div className="amt-head">
        <b className="mono">{bot.symbol}</b>
        <span className="muted">
          {s?.exchange ?? (bot.mode === 'live' ? 'key exchange' : bot.exchangeId)}
          {s?.sandbox ? ' · testnet' : ''}
        </span>
        <Spacer />
        {running ? <span className={`status-dot status-${s?.feed === 'open' ? 'open' : s?.feed === 'error' ? 'error' : 'connecting'}`} title={s?.feedError ?? s?.feed ?? ''} /> : <span className="muted">off</span>}
      </div>
      {running && s?.feed === 'error' && <div className="down amt-hint">Market data: {s.feedError ?? 'error'} — retrying.</div>}
      {!running && !s && <div className="muted amt-hint">Switch the bot on to start reading the auction. Settings and a backtest on recorded data are in the tabs above.</div>}
      {s && (
        <>
          <div className="amt-state">
            <span className={`amt-state-pill st-${s.state}`}>{AMT_STATE_LABEL[s.state] ?? s.state}</span>
            {s.state === 'warmup' && s.warmupSec > 0 && <span className="muted"> {Math.ceil(s.warmupSec / 60)} min left</span>}
            {s.halted && <span className="down"> · {s.halted}</span>}
          </div>
          <div className="amt-cards">
            <Stat label="Last" value={fmtPrice(s.last)} />
            <Stat label="VAH" value={s.va ? fmtPrice(s.va.vah) : '—'} />
            <Stat label="POC" value={s.va ? fmtPrice(s.va.poc) : '—'} />
            <Stat label="VAL" value={s.va ? fmtPrice(s.va.val) : '—'} />
            <Stat label="Delta (flow)" value={s.flow ? fmtNum(s.flow.deltaRatio, 2) : '—'} tone={s.flow ? s.flow.deltaRatio : 0} />
            <Stat label="Intensity" value={s.flow?.intensity ? `${fmtNum(s.flow.intensity, 1)}×` : '—'} />
            <Stat label="Book imb." value={s.book ? fmtNum(s.book.imbalance, 2) : '—'} tone={s.book?.imbalance ?? 0} />
            <Stat label="Prior value" value={s.prior ? `${fmtPrice(s.prior.val)}–${fmtPrice(s.prior.vah)}` : 'after 1 session'} />
            {s.brain && <BrainStats br={s.brain} p={s.last} />}
            {s.orderflow && <OrderFlowStats of={s.orderflow} />}
            {s.style === 'intraday' && s.session && (
              <>
                <Stat label="Initial balance" value={s.session.ib ? `${fmtPrice(s.session.ib.low)}–${fmtPrice(s.session.ib.high)}${s.session.ib.done ? '' : ' (forming)'}` : 'next session'} />
                <Stat label="Session range" value={`${fmtPrice(s.session.low)}–${fmtPrice(s.session.high)}`} />
                <Stat label="Session POC" value={s.session.value ? fmtPrice(s.session.value.poc) : '—'} />
                <Stat label="Trades / session" value={`${s.session.trades}/${bot.params.maxTradesPerSession}`} />
                <Stat label="Session closes" value={new Date(s.session.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
              </>
            )}
          </div>
          {s.profile.length > 0 && <ProfileView snap={s} />}
          {pos ? (
            <div className={`amt-pos ${pos.side}`}>
              <b>{pos.side === 'buy' ? 'LONG' : 'SHORT'}</b> {fmtNum(pos.qty, 6)} @ {fmtPrice(pos.entry)} · stop {fmtPrice(pos.stop)}
              {pos.be ? ' (breakeven)' : ''} · target {fmtPrice(pos.target)} · <span className={pos.upnl >= 0 ? 'up' : 'down'}>{usd(pos.upnl)}</span>
              <div className="muted">
                {pos.setup}: {pos.why}
              </div>
            </div>
          ) : (
            <div className="muted amt-hint">{s.working ? `Limit ${s.working.side} resting at ${fmtPrice(s.working.price)} for ${s.working.ageSec} s (post-only, maker fee) — ${s.working.kind === 'entry' ? 'joining the queue' : 'offering the exit'}` : s.pending ? `Order ${s.pending} in flight…` : s.lastSkip ? `Last setup skipped (${s.lastSkip.event}): ${s.lastSkip.reason}` : 'Flat — waiting for a setup.'}</div>
          )}
          {s.brain && s.brain.thoughts.length > 0 && (
            <div className="amt-thoughts">
              <div className="section-title">Reasoning</div>
              {[...s.brain.thoughts]
                .reverse()
                .slice(0, 6)
                .map((th, i) => (
                  <div key={i} className="amt-thought">
                    <span className="muted mono">{fmtTime(th.t)}</span> {th.text}
                  </div>
                ))}
            </div>
          )}
          {stats && (
            <div className="amt-cards">
              {s.balance !== null && s.balance !== undefined && <BalanceStat balance={s.balance} start={bot.params.accountUsd} pnl={stats.pnl} />}
              <Stat label="Trades" value={String(stats.trades)} />
              <Stat label="Win rate" value={stats.winRate === null ? '—' : `${Math.round(stats.winRate * 100)}%`} />
              <Stat label="Net PnL" value={usd(stats.pnl)} tone={stats.pnl} />
              <Stat label="Today" value={usd(stats.pnlToday)} tone={stats.pnlToday} />
              <Stat label="Profit factor" value={stats.profitFactor === null ? '—' : fmtNum(stats.profitFactor, 2)} />
              <Stat label="Max drawdown" value={`$${fmtNum(stats.maxDrawdown, 2)}`} />
              <Stat label="Fees" value={`$${fmtNum(stats.fees, 2)}`} />
            </div>
          )}
        </>
      )}
      <div className="section-title">Activity</div>
      {events.length === 0 ? (
        <div className="muted">Nothing yet.</div>
      ) : (
        [...events]
          .reverse()
          .slice(0, 60)
          .map((e, i) => (
            <div key={i} className={`log-row amt-ev ev-${e.kind}`}>
              <span className="muted mono">{fmtTime(e.t)}</span>
              <span className={`tag ev-tag-${e.kind}`}>{e.kind}</span>
              <span>{e.text}</span>
            </div>
          ))
      )}
    </div>
  );
}

function BalanceStat({ balance, start, pnl }: { balance: number; start: number; pnl: number }) {
  const rate = useZarRate();
  // growth since the bot started, from the balance it started with
  const base = balance - pnl || start;
  const g = base > 0 ? (pnl / base) * 100 : 0;
  return <Stat label={`Balance${zar(balance, rate) ? ` · ${zar(balance, rate)}` : ''}`} value={`$${fmtNum(balance, 2)} (${g >= 0 ? '+' : ''}${fmtNum(g, 1)}%)`} tone={g} />;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="amt-stat">
      <span>{label}</span>
      <b className={`mono ${tone === undefined || tone === 0 ? '' : tone > 0 ? 'up' : 'down'}`}>{value}</b>
    </div>
  );
}

/** Volume profile around price with value area, POC and the open trade. */
function ProfileView({ snap }: { snap: AmtSnapshot }) {
  const ref = useRef(snap);
  ref.current = snap;
  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const s = ref.current;
    const rows = s.profile;
    if (!rows.length) return;
    const lo = rows[0][0];
    const hi = rows[rows.length - 1][0];
    const y = (p: number) => h - 6 - ((p - lo) / (hi - lo || 1)) * (h - 12);
    const rowH = Math.max(1, (h - 12) / rows.length - 1);
    const max = Math.max(...rows.map((r) => r[1]), 1e-12);
    const va = s.va;
    if (va) {
      ctx.fillStyle = rgba(pal.buyRgb, 0.06);
      ctx.fillRect(0, y(va.vah) - rowH / 2, w, y(va.val) - y(va.vah) + rowH);
    }
    const labelW = 64;
    for (const [p, v, d] of rows) {
      const bw = (v / max) * (w - labelW - 8);
      const inVa = va && p <= va.vah && p >= va.val;
      ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, inVa ? 0.7 : 0.35);
      ctx.fillRect(labelW, y(p) - rowH / 2, bw, rowH);
    }
    ctx.font = font(10);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // value levels labelled on the left, the trade's levels on the right
    const mark = (p: number | undefined, color: string, label: string, dash?: number[], right = false) => {
      if (p === undefined || !isFinite(p) || p < lo - (hi - lo) || p > hi + (hi - lo)) return;
      const yy = Math.min(h - 6, Math.max(6, y(p)));
      line(ctx, labelW, yy, w, yy, color, 1, dash);
      const text = `${label} ${fmtPrice(p)}`;
      ctx.textAlign = right ? 'right' : 'left';
      if (right) {
        ctx.fillStyle = pal.tooltip;
        ctx.fillRect(w - ctx.measureText(text).width - 6, yy - 6, ctx.measureText(text).width + 6, 12);
      }
      ctx.fillStyle = color;
      ctx.fillText(text, right ? w - 3 : 2, yy);
    };
    if (va) {
      mark(va.vah, pal.muted, 'VAH', [3, 3]);
      mark(va.val, pal.muted, 'VAL', [3, 3]);
      mark(va.poc, pal.poc, 'POC');
    }
    if (s.position) {
      mark(s.position.stop, pal.sell, 'SL', [2, 2], true);
      mark(s.position.target, pal.buy, 'TP', [2, 2], true);
      mark(s.position.entry, pal.accent, 'IN', undefined, true);
    }
    mark(s.last, pal.text, '▶');
  };
  return (
    <div className="amt-profile">
      <Canvas draw={draw} fps={4} cursor="default" />
    </div>
  );
}

/** Rand per US dollar, for showing balances the way the owner thinks about them. */
let zarCache: { rate: number; at: number } | null = null;
function useZarRate() {
  const [rate, setRate] = useState(zarCache?.rate ?? NaN);
  useEffect(() => {
    if (zarCache && Date.now() - zarCache.at < 30 * 60_000) return;
    yahooChart(fetchJson, 'ZAR=X', '1d')
      .then((c) => {
        if (!(c.quote.price > 0)) return;
        zarCache = { rate: c.quote.price, at: Date.now() };
        setRate(c.quote.price);
      })
      .catch(() => undefined);
  }, []);
  return rate;
}

const zar = (usd: number, rate: number) => (isFinite(rate) && isFinite(usd) ? `R${fmtNum(usd * rate, usd * rate >= 1000 ? 0 : 2)}` : '');

function BalanceInput({ value, onChange, locked, live }: { value: number; onChange: (v: number) => void; locked: boolean; live: boolean }) {
  const rate = useZarRate();
  return (
    <div className="amt-balance">
      <label className="amt-field" title="Paper trading and backtests start from this; a live bot reads the real balance from the exchange instead">
        <span>{live ? 'Balance (live reads the exchange; used for backtests)' : 'Starting balance (USDT)'}</span>
        <input className="ctl mono" type="number" min={1} step="any" disabled={locked} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
      <span className="muted">{zar(value, rate) && `≈ ${zar(value, rate)}`}</span>
      {isFinite(rate) && (
        <span className="chip-row">
          {[500, 1000, 5000].map((r) => (
            <button key={r} type="button" className="chip" disabled={locked} onClick={() => onChange(Number((r / rate).toFixed(2)))} title={`R${r} at ${rate.toFixed(2)} ZAR/USD`}>
              R{r}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** What one trade looks like at this balance, including what fees take. */
function SizingPreview({ p }: { p: AmtParams }) {
  const rate = useZarRate();
  const bal = p.accountUsd;
  const risk = (bal * p.riskPct) / 100;
  // a typical scalp stop of 0.2 % of price
  const stopPct = 0.2;
  const notional = Math.min(risk / (stopPct / 100), bal * p.maxLeverage, p.maxPositionUsd);
  // limit entries pay the maker fee; exits are counted at market (stops always are)
  const fees = (notional * (p.orderMode === 'maker' ? p.makerFeeBps + p.feeBps + p.slippageBps : 2 * (p.feeBps + p.slippageBps))) / 1e4;
  const realRisk = (notional * stopPct) / 100;
  return (
    <div className="amt-preview">
      With {usd(bal).replace('+', '')}
      {zar(bal, rate) && ` (${zar(bal, rate)})`}: a trade with a {stopPct}% stop puts about <b>${fmtNum(notional, 2)}</b> to work ({fmtNum(notional / Math.max(bal, 1e-9), 1)}× the balance), risks <b>${fmtNum(realRisk, 2)}</b>
      {zar(realRisk, rate) && ` (${zar(realRisk, rate)})`} and pays about <b>${fmtNum(fees, 2)}</b> in fees and slippage — {fmtNum((fees / Math.max(realRisk, 1e-9)) * 100, 0)}% of the risk. A 2R winner nets about ${fmtNum(2 * realRisk - fees, 2)}.
      {fees / Math.max(realRisk, 1e-9) > 0.3 && <span className="down"> Fees are a large share of each trade: fewer, larger-target trades matter more than many small ones.</span>}
    </div>
  );
}

/** Walk-forward training on recorded trades. */
function Train({ bot, locked, onApplied }: { bot: AmtBot; locked: boolean; onApplied: () => void }) {
  const [instruments, setInstruments] = useState<{ venue: string; symbol: string; n: number; first: number; last: number }[]>([]);
  const [pick, setPick] = useState('');
  const [days, setDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [res, setRes] = useState<AmtTrainResult | null>(null);
  const [err, setErr] = useState('');
  const [applied, setApplied] = useState(false);
  const [appliedRow, setAppliedRow] = useState<string | null>(null);
  useEffect(() => {
    desktop!.db
      .stats()
      .then((s) => {
        setInstruments(s);
        if (s[0]) setPick(`${s[0].venue}|${s[0].symbol}`);
      })
      .catch(() => undefined);
    return desktop!.amt.onTrain((m) => setProgress(m.progress));
  }, []);
  const run = async () => {
    const [venue, symbol] = pick.split('|');
    setBusy(true);
    setErr('');
    setRes(null);
    setApplied(false);
    setAppliedRow(null);
    setProgress(0);
    try {
      setRes(await desktop!.amt.train(bot.params, venue, symbol, { days }));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const isBest = (l: AmtTrainRow) => Boolean(res?.best) && JSON.stringify(l.params) === JSON.stringify(res!.best!.params);
  /** Apply one row's settings. A row that did not hold up on the unseen data needs an explicit yes. */
  const applyRow = async (l: AmtTrainRow) => {
    if (!isBest(l)) {
      const u = l.test;
      const sure = confirm(
        `These settings did NOT pass the unseen-data check.\n\nOn the last 30% of the data (which the ranking never saw) they made ${u.trades} trades, ${u.winRate === null ? '—' : Math.round(u.winRate * 100) + '%'} wins, and ${u.growthPct >= 0 ? 'grew' : 'shrank'} the balance by ${fmtNum(Math.abs(u.growthPct), 1)}% after fees.\n\nA good win rate on the earlier data alone is often luck. Apply anyway and paper-trade it first?`,
      );
      if (!sure) return;
    }
    await apply(l.params);
    setAppliedRow(isBest(l) ? 'the verified settings' : `settings #${res!.leaders.indexOf(l) + 1} (they did not pass the unseen-data check — paper-trade them first)`);
  };
  const apply = async (patch: Partial<AmtParams> = res!.best!.params) => {
    if (!res) return;
    // only the searched knobs change; the owner's risk settings stay
    await desktop!.amt.save({ id: bot.id, name: bot.name, mode: bot.mode, exchangeId: bot.exchangeId, symbol: bot.symbol, secretId: bot.secretId, exchangeStop: bot.exchangeStop, params: { ...bot.params, ...patch } });
    setApplied(true);
    onApplied();
  };
  const seg = (label: string, m: AmtTrainSegment) => (
    <>
      <td className="muted">{label}</td>
      <td>{m.trades}</td>
      <td>{m.winRate === null ? '—' : `${Math.round(m.winRate * 100)}%`}</td>
      <td className={m.growthPct >= 0 ? 'up' : 'down'}>
        {m.growthPct >= 0 ? '+' : ''}
        {fmtNum(m.growthPct, 1)}%
      </td>
      <td>{fmtNum(m.maxDrawdownPct, 1)}%</td>
      <td>{m.profitFactor === null ? '—' : fmtNum(m.profitFactor, 2)}</td>
    </>
  );
  const sel = instruments.find((i) => `${i.venue}|${i.symbol}` === pick);
  return (
    <div className="amt-backtest">
      <p className="muted" style={{ marginTop: 0 }}>
        Tries {40} variations of this bot’s order-flow, auction and trade settings on the trades the terminal recorded. Each is ranked on the <b>first 70%</b> of the data only; the best few are then checked on
        the <b>last 30%</b>, which the ranking never saw. A result is marked verified only if it also grew the balance there, after fees. You can apply any row; one that was not verified asks you to confirm. Your risk
        settings are never altered. Recorded data has no order book, so book filters are skipped.
      </p>
      {instruments.length === 0 ? (
        <div className="muted">No recorded trades yet — keep “Record trades” on in the Database panel and let the terminal run for a day or more on the market you want to trade.</div>
      ) : (
        <div className="input-with-chips">
          <Select value={pick} options={instruments.map((i) => ({ value: `${i.venue}|${i.symbol}`, label: `${i.venue} ${i.symbol} · ${fmtNum(i.n, 0)} trades` }))} onChange={setPick} />
          <Select value={days} options={[1, 2, 3, 5, 7].map((d) => ({ value: d, label: `last ${d} day${d > 1 ? 's' : ''}` }))} onChange={setDays} />
          <button className="btn" disabled={busy || !pick} onClick={() => void run()}>
            {busy ? `Training… ${Math.round(progress * 100)}%` : 'Train'}
          </button>
        </div>
      )}
      {sel && sel.n < 10_000 && (
        <div className="down amt-hint">
          Only {fmtNum(sel.n, 0)} trades recorded for {sel.venue} {sel.symbol} — training needs at least 10,000 in the chosen period. Keep it on the main chart with “Record trades” on for longer, or pick a busier market.
        </div>
      )}
      {locked && !busy && <div className="muted amt-hint">The bot is running: you can train now; switch it off only to apply a result.</div>}
      {busy && (
        <div className="muted amt-hint">
          Replaying {bot.params.style === 'scalp' || bot.params.style === 'intraday' ? '' : 'every trigger of '}the recorded trades 40 times — this can take a few minutes on several days of data. The bot is not changed until you press Apply.
        </div>
      )}
      {sel && sel.last - sel.first < 12 * 3_600_000 && <div className="muted amt-hint">Only {fmtNum((sel.last - sel.first) / 3_600_000, 1)} h recorded for this market — results from less than a day of data are weak evidence.</div>}
      {busy && (
        <div className="ph-bar amt-train-bar">
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {err && <div className="down amt-hint">{err}</div>}
      {res && (
        <>
          <div className="muted amt-hint">
            {fmtNum(res.count, 0)} trades of {res.venue} {res.symbol} · {new Date(res.from).toLocaleString()} → {new Date(res.to).toLocaleString()} · unseen part from {new Date(res.splitT).toLocaleString()} ·{' '}
            {res.searched} settings tried
          </div>
          {res.verdict === 'verified' && res.best ? (
            <div className="confirm-card buy">
              <div>
                <b>Found settings that held up on unseen data.</b> On the last 30% they {res.best.test.growthPct >= 0 ? 'grew' : 'changed'} the balance {fmtNum(res.best.test.growthPct, 1)}% over {res.best.test.trades} trades
                (max drawdown {fmtNum(res.best.test.maxDrawdownPct, 1)}%), against {fmtNum(res.baseline.test.growthPct, 1)}% for the current settings. Paper-trade it before going live: a few days of one market is not a
                guarantee.
              </div>
              <div className="confirm-actions">
                {applied ? (
                  <span className="up">Applied to {bot.name}.</span>
                ) : (
                  <>
                    {locked && <span className="muted">Switch the bot off to apply — its settings cannot change while it trades.</span>}
                    <button className="btn buy" disabled={locked} onClick={() => void apply(res.best!.params)}>
                      Apply to this bot
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : res.leaders.length === 0 ? (
            <div className="confirm-card sell">
              <b>None of the {res.searched} settings took enough trades to judge</b> (at least 8 in the training part) — nothing was changed. The growth filters are deliberately strict; record more days of this
              market, or try a busier one.
            </div>
          ) : (
            <div className="confirm-card sell">
              <b>No settings grew the balance on the unseen part of the data</b> — nothing was changed. Each row below shows how it did on the earlier (train) and the unseen part; you can still apply one, and the bot asks you to confirm. That is a real answer: on this market and period the setups did not beat fees. Try another market, more
              recorded days, or the other style.
            </div>
          )}
          {appliedRow && (
            <div className="up amt-hint">
              Applied {appliedRow} to {bot.name}.
            </div>
          )}
          {res.leaders.length > 0 && (
          <table className="grid amt-train">
            <thead>
              <tr>
                <th>Settings</th>
                <th>Part</th>
                <th>Trades</th>
                <th>Win</th>
                <th>Growth</th>
                <th>Max DD</th>
                <th>PF</th>
              </tr>
            </thead>
            <tbody>
              {res.leaders.map((l, i) => (
                <Fragment key={i}>
                  <tr className={isBest(l) ? 'best' : ''}>
                    <td rowSpan={2} className="mono amt-train-params" title={JSON.stringify(l.params)}>
                      {l.base ? 'current' : `#${i + 1}`}
                      {isBest(l) && <span className="up"> ✓ held up on unseen data</span>}
                      <div className="muted">
                        {Object.entries(l.params)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(' · ')}
                      </div>
                      {!l.base && !applied && (
                        <button
                          className={`chip ${isBest(l) ? 'buy' : ''}`}
                          disabled={locked}
                          title={locked ? 'Switch the bot off to apply' : isBest(l) ? 'Apply these settings' : 'Did not pass the unseen-data check — asks to confirm'}
                          onClick={() => void applyRow(l)}
                        >
                          Apply #{i + 1}
                        </button>
                      )}
                    </td>
                    {seg('train', l.train)}
                  </tr>
                  <tr className={isBest(l) ? 'best' : ''}>{seg('unseen', l.test)}</tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          )}
        </>
      )}
    </div>
  );
}

function Backtest({ bot }: { bot: AmtBot }) {
  const [instruments, setInstruments] = useState<{ venue: string; symbol: string; n: number; first: number; last: number }[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AmtBacktest | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    desktop!.db
      .stats()
      .then((s) => {
        setInstruments(s);
        if (s[0]) setPick(`${s[0].venue}|${s[0].symbol}`);
      })
      .catch(() => undefined);
  }, []);
  const run = async () => {
    const [venue, symbol] = pick.split('|');
    setBusy(true);
    setErr('');
    setRes(null);
    try {
      setRes(await desktop!.amt.backtest(bot.params, venue, symbol));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const st = res?.stats;
  return (
    <div className="amt-backtest">
      <p className="muted" style={{ marginTop: 0 }}>
        Replays trades the terminal recorded in its database through this bot’s settings with paper fills ({bot.params.feeBps} bps fees, {bot.params.slippageBps} bps slippage). Recorded data has no order book, so book filters are skipped.
      </p>
      {instruments.length === 0 ? (
        <div className="muted">No recorded trades yet — keep “Record trades” on in the Database panel and let the terminal run.</div>
      ) : (
        <div className="input-with-chips">
          <Select value={pick} options={instruments.map((i) => ({ value: `${i.venue}|${i.symbol}`, label: `${i.venue} ${i.symbol} · ${fmtNum(i.n, 0)} trades` }))} onChange={setPick} />
          <button className="btn" disabled={busy || !pick} onClick={() => void run()}>
            {busy ? 'Running…' : 'Run backtest'}
          </button>
        </div>
      )}
      {err && <div className="down amt-hint">{err}</div>}
      {res && st && (
        <>
          <div className="muted amt-hint">
            {fmtNum(res.count, 0)} trades replayed{res.from && res.to ? ` · ${new Date(res.from).toLocaleString()} → ${new Date(res.to).toLocaleString()}` : ''} · bin {res.bin}
          </div>
          <div className="amt-cards">
            <Stat label="Trades" value={String(st.trades)} />
            <Stat label="Win rate" value={st.winRate === null ? '—' : `${Math.round(st.winRate * 100)}%`} />
            <Stat label="Net PnL" value={usd(st.pnl)} tone={st.pnl} />
            <Stat label="Profit factor" value={st.profitFactor === null ? '—' : fmtNum(st.profitFactor, 2)} />
            <Stat label="Max drawdown" value={`$${fmtNum(st.maxDrawdown, 2)}`} />
            <Stat label="Fees" value={`$${fmtNum(st.fees, 2)}`} />
          </div>
          <Equity points={res.equity} />
          {res.trades.length > 0 && (
            <table className="grid">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Setup</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Why out</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {[...res.trades]
                  .reverse()
                  .slice(0, 50)
                  .map((t, i) => (
                    <tr key={i} title={t.why}>
                      <td className="muted">{fmtTime(t.closed)}</td>
                      <td>{t.setup}</td>
                      <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? 'LONG' : 'SHORT'}</td>
                      <td>{fmtPrice(t.entry)}</td>
                      <td>{fmtPrice(t.exit)}</td>
                      <td className="muted">{t.reason}</td>
                      <td className={t.pnl >= 0 ? 'up' : 'down'}>{usd(t.pnl)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function Equity({ points }: { points: [number, number][] }) {
  const path = useMemo(() => {
    const pts: [number, number][] = [[0, 0], ...points.map(([, v], i) => [i + 1, v] as [number, number])];
    const min = Math.min(...pts.map((p) => p[1]));
    const max = Math.max(...pts.map((p) => p[1]));
    const n = pts.length - 1 || 1;
    return {
      d: pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * 100).toFixed(2)},${(36 - ((v - min) / (max - min || 1)) * 32).toFixed(2)}`).join(' '),
      zero: 36 - ((0 - min) / (max - min || 1)) * 32,
      up: (points.at(-1)?.[1] ?? 0) >= 0,
    };
  }, [points]);
  if (points.length < 2) return null;
  return (
    <svg className="amt-equity" viewBox="0 0 100 40" preserveAspectRatio="none">
      <line x1="0" x2="100" y1={path.zero} y2={path.zero} className="zero" />
      <path d={path.d} className={path.up ? 'up' : 'down'} />
    </svg>
  );
}
