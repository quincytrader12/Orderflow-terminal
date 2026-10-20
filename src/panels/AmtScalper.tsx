import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtPrice, fmtTime } from '../core/format';
import { AMT_STATE_LABEL, onAmtEvent, useAmtBots, useAmtLive } from '../desktop/amt';
import { desktop, DesktopOnlyError, type AmtBacktest, type AmtBot, type AmtBotInput, type AmtEvent, type AmtParams, type AmtSnapshot, type CcxtExchangeInfo } from '../desktop/bridge';
import { pickSymbol, unifiedCandidates } from '../desktop/trading';
import { useVaultKeys } from '../desktop/vault';
import { hub } from '../market/hub';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Check, Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';

export interface AmtConfig {
  botId: string;
  tab: 'live' | 'settings' | 'backtest';
}

export const AMT_DEFAULTS: AmtConfig = { botId: '', tab: 'live' };

type NumKey = { [K in keyof AmtParams]: AmtParams[K] extends number ? K : never }[keyof AmtParams];

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
      ['maxHoldSec', 'Max hold (s)', 'Time stop'],
      ['breakevenAtR', 'Breakeven at R', 'Move the stop to entry + costs after this many R (0 = off)'],
      ['cooldownSec', 'Cooldown after loss (s)', ''],
      ['feeBps', 'Fee per side (bps)', 'Used for R:R checks and paper PnL (live uses the exchange taker fee if higher)'],
      ['slippageBps', 'Paper slippage (bps)', ''],
    ],
  ],
];

type Style = AmtParams['style'];

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
};

const STYLE_TEXT: Record<Style, string> = {
  scalp: 'Seconds to minutes. Rolling value area, order-flow confirmation, many small trades.',
  intraday: 'Hours. Session structure (initial balance, prior-day value), wider stops, at most a few trades a session, trailing stop, flat before the session closes.',
};

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
        <Select value={c.botId} options={[{ value: '', label: bots.length ? 'Choose bot…' : 'No bots yet' }, ...bots.map((b) => ({ value: b.id, label: `${b.running ? '● ' : ''}${b.name}${b.params.style === 'intraday' ? ' · intraday' : ''}` }))]} onChange={(botId) => setConfig({ botId })} width={150} />
        <button className="chip" onClick={() => void create()} title="New AMT bot">
          + New
        </button>
        {bot && (
          <>
            {(['live', 'settings', 'backtest'] as const).map((t) => (
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
      {(['scalp', 'intraday'] as Style[]).map((st) => (
        <div key={st}>
          <b>{st === 'scalp' ? 'Scalp' : 'Intraday'}</b> <span className="muted">— {STYLE_TEXT[st]}</span>
          <ul>
            {SETUPS[st].map(([k, name, text]) => (
              <li key={k}>
                <b>{name}</b> — {text}
              </li>
            ))}
          </ul>
        </div>
      ))}
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
        {test ? ' (testnet)' : ''} with key “{key?.label ?? '?'}”: risk ${p.riskUsd} per trade, positions up to ${p.maxPositionUsd} (or your ticket cap, whichever is lower), and it switches itself off after
        a ${p.maxDailyLossUsd} loss today or on any order error. The terminal must stay open while it runs.
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

  const [presets, setPresets] = useState<Record<Style, AmtParams> | null>(null);
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
        {(['scalp', 'intraday'] as Style[]).map((st) => (
          <button
            key={st}
            type="button"
            className={`chip ${P.style === st ? 'active' : ''}`}
            onClick={() => {
              if (P.style === st || !presets) return;
              // load the style's preset but keep the owner's risk and cost settings
              const keep = { riskUsd: P.riskUsd, maxPositionUsd: P.maxPositionUsd, maxDailyLossUsd: P.maxDailyLossUsd, allowShort: P.allowShort, useBook: P.useBook, feeBps: P.feeBps, slippageBps: P.slippageBps };
              setD({ ...d, params: { ...presets[st], ...keep } });
            }}
          >
            {st === 'scalp' ? 'Scalp' : 'Intraday'}
          </button>
        ))}
      </div>
      <div className="muted amt-hint">{STYLE_TEXT[P.style]}</div>

      <div className="section-title">Setups</div>
      {SETUPS[P.style].map(([k, name, text]) => (
        <Check key={k} checked={P.setups[k]} onChange={(v) => setP({ setups: { ...P.setups, [k]: v } })}>
          <b>{name}</b> <span className="muted">— {text}</span>
        </Check>
      ))}

      <div className="section-title">Risk</div>
      <div className="amt-grid">{RISK_FIELDS.map(([k, l, h]) => num(k, l, h))}</div>
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
            <div className="muted amt-hint">{s.pending ? `Order ${s.pending} in flight…` : s.lastSkip ? `Last setup skipped (${s.lastSkip.event}): ${s.lastSkip.reason}` : 'Flat — waiting for a setup.'}</div>
          )}
          {stats && (
            <div className="amt-cards">
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
