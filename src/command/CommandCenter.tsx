// The Command Center: the swarm at a glance, on one black-and-chrome screen.
//
//   top      what is happening now, scrolling past
//   left     wallet and P&L · the coin in focus · the feeds · capital at risk
//   centre   the swarm core (core.ts)
//   right    results · the execution tape
//   bottom   today's budget · the bots' gauges · their live log
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtTime, fmtUsd } from '../core/format';
import { fetchJson } from '../exchanges/ws';
import { ensureHistory, priceSeries } from '../meme/history';
import { meters, scanner, useMeme } from '../meme/scanner';
import { useSwarm } from '../meme/swarm/swarm';
import type { MemeToken } from '../meme/token';
import { useBoot } from '../app/boot';
import { Canvas, font, type PointerState } from '../ui/canvas';
import { rgba, type Palette } from '../ui/theme';
import { useTicker } from '../ui/controls';
import { MemeScanner, MEME_SCANNER_DEFAULTS, type MemeScannerConfig } from '../panels/MemeScanner';
import { MemeToken as MemeTokenPanel, MEME_TOKEN_DEFAULTS, type MemeTokenConfig } from '../panels/MemeToken';
import { Rules, Wallet } from '../panels/MemeSwarm';
import { coreMemory, drawCore, type CoreInput } from './core';
import { Core3D, webglAvailable } from './core3d';
import { commandStats, Rate, type CommandStats } from './stats';

const sol = (x: number, d = 3) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that glides to its new value. */
function Num({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const cur = useRef(value);
  useEffect(() => {
    if (!Number.isFinite(value) || !Number.isFinite(cur.current) || reduced) {
      cur.current = value;
      setShown(value);
      return;
    }
    from.current = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from.current + (value - from.current) * e;
      setShown(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{Number.isFinite(shown) ? format(shown) : '—'}</>;
}

/** Tilt a card a few degrees towards the pointer, with a light that follows it. */
function tilt(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
  el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  if (reduced) return;
  el.style.setProperty('--ry', `${((x - 0.5) * 4).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${((0.5 - y) * 3).toFixed(2)}deg`);
}
function untilt(e: React.PointerEvent<HTMLElement>) {
  e.currentTarget.style.setProperty('--rx', '0deg');
  e.currentTarget.style.setProperty('--ry', '0deg');
}

function Card({ n, title, right, className = '', children }: { n: string; title: string; right?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`cc-card ${className}`} style={{ animationDelay: `${Number(n) * 60}ms` }} onPointerMove={tilt} onPointerLeave={untilt}>
      <header className="cc-card-head">
        <span className="cc-idx">{n}</span>
        <span className="cc-title">{title}</span>
        <span className="cc-head-right">{right}</span>
      </header>
      <div className="cc-card-body">{children}</div>
    </section>
  );
}

/** How long a read keeps the focus chart before a stronger one takes it. */
const FOCUS_HOLD_MS = 20_000;

/** Feed rates, sampled once a second for as long as the app runs. */
const rates = { pump: new Rate(90), dex: new Rate(90), rpc: new Rate(90) };
let sampling = false;
function startSampling() {
  if (sampling) return;
  sampling = true;
  setInterval(() => {
    rates.pump.push(meters.pump);
    rates.dex.push(meters.dex);
    rates.rpc.push(meters.rpc);
  }, 1000);
}

/** A small area chart. */
function drawArea(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, pts: { t: number; v: number }[], o: { color: [number, number, number]; cap?: number; zero?: boolean; t0?: number; t1?: number; marks?: { t: number; side: 'buy' | 'sell' }[]; label?: (v: number) => string; hover?: PointerState | null; fmt?: (v: number) => string; empty?: string }) {
  if (pts.length < 2) {
    ctx.fillStyle = pal.muted;
    ctx.font = font(11, 500, false);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.empty ?? 'waiting for data', w / 2, h / 2);
    return;
  }
  const t0 = o.t0 ?? pts[0].t;
  const t1 = Math.max(o.t1 ?? pts[pts.length - 1].t, t0 + 1);
  let lo = Math.min(...pts.map((p) => p.v), o.zero ? 0 : Infinity);
  let hi = Math.max(...pts.map((p) => p.v), o.cap ?? -Infinity, o.zero ? 0 : -Infinity);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.12;
  lo -= o.zero && lo >= 0 ? 0 : pad;
  hi += pad;
  const padR = o.label ? 46 : 4;
  const X = (t: number) => 2 + ((t - t0) / (t1 - t0)) * (w - 2 - padR);
  const Y = (v: number) => h - 4 - ((v - lo) / (hi - lo)) * (h - 10);
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 4);
    ctx.lineTo(w - padR, (h * i) / 4);
    ctx.stroke();
  }
  if (o.zero && lo < 0 && hi > 0) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = rgba(pal.textRgb, 0.25);
    ctx.beginPath();
    ctx.moveTo(0, Y(0));
    ctx.lineTo(w - padR, Y(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.cap !== undefined) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = rgba(pal.sellRgb, 0.6);
    ctx.beginPath();
    ctx.moveTo(0, Y(o.cap));
    ctx.lineTo(w - padR, Y(o.cap));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgba(o.color, 0.35));
  g.addColorStop(1, rgba(o.color, 0));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
  ctx.lineTo(X(pts[pts.length - 1].t), h);
  ctx.lineTo(X(pts[0].t), h);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
  ctx.strokeStyle = rgba(o.color, 0.95);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(X(last.t), Y(last.v), 3 + Math.sin(performance.now() / 260), 0, Math.PI * 2);
  ctx.fillStyle = rgba(o.color, 1);
  ctx.fill();
  for (const m of o.marks ?? []) {
    const p = pts.reduce((a, b) => (Math.abs(b.t - m.t) < Math.abs(a.t - m.t) ? b : a), pts[0]);
    ctx.beginPath();
    ctx.arc(X(m.t), Y(p.v), 4, 0, Math.PI * 2);
    ctx.fillStyle = m.side === 'buy' ? pal.accent : pal.buy;
    ctx.fill();
  }
  // crosshair: the nearest point to the pointer, its value and time
  const hp = o.hover;
  if (hp?.inside && hp.x >= 0 && hp.x <= w - padR) {
    const p = pts.reduce((a, b) => (Math.abs(X(b.t) - hp.x) < Math.abs(X(a.t) - hp.x) ? b : a), pts[0]);
    const px = X(p.t);
    const py = Y(p.v);
    ctx.strokeStyle = rgba(pal.textRgb, 0.35);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.moveTo(0, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = pal.text;
    ctx.fill();
    const text = `${(o.fmt ?? o.label ?? ((v: number) => v.toFixed(3)))(p.v)}  ${fmtTime(p.t)}`;
    ctx.font = font(10, 600);
    const tw = ctx.measureText(text).width + 12;
    const bx = Math.min(w - tw - 2, Math.max(2, px - tw / 2));
    const by = py > 26 ? py - 24 : py + 8;
    ctx.fillStyle = pal.tooltip;
    ctx.strokeStyle = pal.border;
    ctx.beginPath();
    ctx.roundRect(bx, by, tw, 17, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 6, by + 9);
  }
  if (o.label) {
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.label(hi - pad), w - padR + 4, 8);
    ctx.fillText(o.label(last.v), w - padR + 4, Math.max(14, Math.min(h - 8, Y(last.v))));
  }
}

/** A canvas chart that follows the pointer (crosshair and value). */
function Chart({ draw, fps = 20, cursor = 'crosshair' }: { draw: (ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, hover: PointerState | null) => void; fps?: number; cursor?: string }) {
  const ptr = useRef<PointerState | null>(null);
  return <Canvas fps={fps} cursor={cursor} pointerRef={ptr} draw={({ ctx, w, h, pal }) => draw(ctx, w, h, pal, ptr.current)} />;
}

/** The swarm core: 3D when the machine draws WebGL (not in safe mode), else the flat version. */
function CoreView({ input, onSelect }: { input: React.MutableRefObject<CoreInput>; onSelect: (id: string) => void }) {
  const safe = useBoot((s) => s.safeMode);
  const host = useRef<HTMLDivElement>(null);
  const [flat, setFlat] = useState(() => safe || !webglAvailable());
  const flatMem = useRef(coreMemory());
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    if (flat || !host.current) return;
    let core: Core3D | null = null;
    try {
      core = new Core3D(host.current, () => input.current, (id) => select.current(id));
    } catch (e) {
      console.warn('3D core unavailable, using the flat one', e);
      setFlat(true);
    }
    return () => core?.dispose();
  }, [flat, input]);
  if (flat) return <Canvas fps={reduced ? 20 : 60} cursor="default" draw={({ ctx, w, h, pal }) => drawCore(ctx, w, h, pal, input.current, flatMem.current, performance.now(), reduced ? 0.3 : 1)} />;
  return <div className="cc3d" ref={host} />;
}

function Gauge({ value, label, sub, tone, text }: { value: number | null; label: string; sub: string; tone: 'cyan' | 'magenta' | 'chrome' | 'mint'; text?: string }) {
  const v = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className={`cc-gauge ${tone}`}>
      <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden>
        <circle cx="40" cy="40" r="38" className="cc-gauge-bezel" />
        {Array.from({ length: 40 }, (_, i) => {
          const an = (i / 40) * Math.PI * 2 - Math.PI / 2;
          const lit = i / 40 < v;
          const r1 = i % 5 ? 34.5 : 33.5;
          return <line key={i} x1={40 + Math.cos(an) * r1} y1={40 + Math.sin(an) * r1} x2={40 + Math.cos(an) * 36} y2={40 + Math.sin(an) * 36} className={`cc-gauge-tick${lit ? ' lit' : ''}`} />;
        })}
        <circle cx="40" cy="40" r={r} className="cc-gauge-track" />
        <circle cx="40" cy="40" r={r} className="cc-gauge-arc" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 40 40)" />
      </svg>
      <div className="cc-gauge-val mono">{text ?? (value === null ? '—' : `${Math.round(v * 100)}%`)}</div>
      <div className="cc-gauge-label">{label}</div>
      <div className="cc-gauge-sub muted">{sub}</div>
    </div>
  );
}

export type DrawerTab = 'wallet' | 'scanner' | 'coin' | 'rules';
const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: 'wallet', label: '◎ Wallet' },
  { id: 'scanner', label: '⌕ Scanner' },
  { id: 'coin', label: 'Coin' },
  { id: 'rules', label: 'Rules' },
];

/** Open a Command Center drawer from anywhere (the top bar's Wallet and Scanner buttons). */
export function openDrawer(tab: DrawerTab) {
  window.dispatchEvent(new CustomEvent('novus:drawer', { detail: tab }));
}

/** Wallet, scanner, a coin's detail and the rules, sliding in over the right side. */
function Drawer({ tab, onTab, onClose }: { tab: DrawerTab; onTab: (t: DrawerTab) => void; onClose: () => void }) {
  const [scan, setScan] = useState<MemeScannerConfig>({ ...MEME_SCANNER_DEFAULTS });
  const [coin, setCoin] = useState<MemeTokenConfig>({ ...MEME_TOKEN_DEFAULTS });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <aside className="cc-drawer" aria-label="Drawer">
      <header className="cc-drawer-head">
        {DRAWER_TABS.map((t) => (
          <button key={t.id} className={`chip${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="chip" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className={`cc-drawer-body${tab === 'wallet' || tab === 'rules' ? ' padded' : ''}`}>
        {tab === 'wallet' && <Wallet />}
        {tab === 'rules' && <Rules />}
        {tab === 'scanner' && <MemeScanner config={scan} setConfig={(p) => setScan((c) => ({ ...c, ...p }))} nodeId="cc-scanner" />}
        {tab === 'coin' && <MemeTokenPanel config={coin} setConfig={(p) => setCoin((c) => ({ ...c, ...p }))} nodeId="cc-coin" />}
      </div>
    </aside>
  );
}

export function CommandCenter() {
  useTicker(1000);
  useEffect(startSampling, []);
  // the feeds run while this screen is open, swarm on or off
  useEffect(() => scanner.use(), []);
  const sw = useSwarm();
  const { tokens, solUsd, feed, select, selected } = useMeme();
  const now = Date.now();
  const st: CommandStats = useMemo(() => commandStats(sw.positions, tokens, solUsd, now), [sw.positions, tokens, solUsd, now]);
  const live = sw.mode === 'live';
  const armed = Boolean(sw.wallet?.limits.armed);
  const budget = sw.wallet?.limits.dailySpendSol ?? 0.5;
  const spentToday = live && sw.wallet ? sw.wallet.spentToday : st.spentToday;

  // the coin in focus: the newest open trade, else the strongest read, else the one picked in the scanner
  // a read holds the focus for at least FOCUS_HOLD_MS, so the chart is not swapped every tick
  const focusHold = useRef<{ mint: string; at: number } | null>(null);
  const openMint = [...sw.positions].reverse().find((p) => !p.closedAt)?.mint;
  const readMint = sw.reads.find((r) => r.enter)?.mint ?? sw.reads[0]?.mint ?? selected ?? undefined;
  const nowMs = Date.now();
  if (!openMint && readMint && (!focusHold.current || !tokens[focusHold.current.mint] || (focusHold.current.mint !== readMint && nowMs - focusHold.current.at > FOCUS_HOLD_MS))) focusHold.current = { mint: readMint, at: nowMs };
  const focusMint = openMint ?? focusHold.current?.mint ?? readMint;
  const focus: MemeToken | undefined = focusMint ? tokens[focusMint] : undefined;
  const focusPos = focus ? [...sw.positions].reverse().find((p) => p.mint === focus.mint) : undefined;

  // pool coins have no trade feed: their chart comes from the pool's candles, refreshed while in focus
  useEffect(() => {
    if (!focus) return;
    const load = () => {
      if (focus.trades.length < 2) void ensureHistory(focus, useMeme.getState().solUsd, fetchJson).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [focus?.mint, solUsd > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  useEffect(() => {
    const open = (e: Event) => setDrawer((e as CustomEvent<DrawerTab>).detail);
    window.addEventListener('novus:drawer', open);
    return () => window.removeEventListener('novus:drawer', open);
  }, []);
  /** a coin, anywhere on this screen: its detail in the drawer */
  const openCoin = (mint?: string) => {
    if (!mint) return;
    select(mint);
    setDrawer('coin');
  };
  const w = sw.wallet;
  const bestRead = sw.reads.reduce((m, r) => Math.max(m, r.conviction), 0);

  const pumpRate = rates.pump.mean(5);
  const age = (t: number) => (t ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : '—');
  const ok = (s: string) => (s === 'open' ? 'open' : s.startsWith('error') ? 'error' : s === 'idle' ? 'idle' : 'connecting');

  const input = useRef<CoreInput>(null!);
  const ss = sw.stats;
  const passRate = ss.sentinel.checked ? ss.sentinel.pass / ss.sentinel.checked : null;
  const viralShare = ss.herald.scored ? ss.herald.viral / ss.herald.scored : null;
  const held = new Set(sw.positions.filter((p) => !p.closedAt).map((p) => p.mint));
  input.current = {
    on: sw.enabled,
    activity: Math.min(1, pumpRate / 25 + (sw.reads.length ? 0.15 : 0)),
    title: 'SWARM CORE',
    caption: sw.enabled ? `${sw.reads.length} coins in the core · ${ss.herald.narratives[0] ? `“${ss.herald.narratives[0].word}” running hot` : 'reading the chain'}` : 'swarm off — start it to fill the core',
    inputs: [
      { label: 'Scout · new coins', value: `${ss.scout.perMin}/min`, rate: Math.min(1, ss.scout.perMin / 20) },
      { label: 'pump.fun feed', value: `${fmtNum(pumpRate, 1)} msg/s`, rate: Math.min(1, pumpRate / 30) },
      { label: 'Sentinel · pass', value: passRate === null ? '—' : `${Math.round(passRate * 100)}%`, rate: passRate ?? 0 },
      { label: 'Herald · viral', value: `${ss.herald.viral}`, rate: Math.min(1, ss.herald.viral / 8) },
      { label: 'Narrative', value: ss.herald.narratives[0] ? `${ss.herald.narratives[0].word} ×${ss.herald.narratives[0].count}` : '—', rate: Math.min(1, (ss.herald.narratives[0]?.count ?? 0) / 10) },
      { label: 'SOL', value: solUsd > 0 ? fmtUsd(solUsd, 2) : '—', rate: 0.3 },
    ],
    outputs: [
      { label: 'Picks', value: `${sw.outcomes.filter((o) => o.kind === 'pick').length}`, rate: Math.min(1, sw.reads.filter((r) => r.enter).length / 2 + 0.1) },
      { label: 'Open', value: `${st.open.length} / ${sw.manager.maxOpen}`, rate: st.open.length / Math.max(1, sw.manager.maxOpen) },
      { label: 'Win rate', value: st.winRate === null ? '—' : `${Math.round(st.winRate * 100)}%`, rate: st.winRate ?? 0, tone: st.winRate !== null ? (st.winRate >= 0.5 ? 'up' : 'down') : undefined },
      { label: 'P&L', value: `${sol(st.pnlSol)} SOL`, rate: Math.min(1, Math.abs(st.pnlSol) * 4), tone: st.pnlSol >= 0 ? 'up' : 'down' },
      { label: 'Best', value: st.bestMult ? `${st.bestMult.toFixed(2)}×` : '—', rate: Math.min(1, st.bestMult / 10) },
      { label: 'Budget left', value: `${Math.max(0, budget - spentToday).toFixed(2)} SOL`, rate: 1 - Math.min(1, spentToday / budget), tone: spentToday >= budget ? 'warn' : undefined },
    ],
    blobs: [
      ...sw.reads.slice(0, 14).map((r) => ({ id: r.mint, label: r.symbol, conviction: r.conviction || r.heat * 0.6, viability: r.viability.score, virality: r.virality?.score ?? 0, enter: r.enter, held: held.has(r.mint) })),
      ...st.open.filter((o) => !sw.reads.some((r) => r.mint === o.mint)).map((o) => ({ id: o.mint, label: o.symbol, conviction: 90, viability: 60, virality: 60, enter: false, held: true })),
    ],
  };

  const ticker = useMemo(() => {
    const items = [...sw.log].slice(-24).reverse();
    return items.length ? items : [{ t: now, agent: 'scout' as const, text: sw.enabled ? 'reading the chain…' : 'swarm off — press Start', mint: undefined }];
  }, [sw.log, sw.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`cc ${sw.enabled ? 'on' : ''}`}>
      <div className="cc-top">
        <div className="cc-brand">
          <span className="cc-brand-name">SWARM COMMAND</span>
          <span className={`cc-mode ${live ? (armed ? 'live' : 'unarmed') : 'paper'}`}>{live ? (armed ? '● LIVE · autonomous' : 'LIVE · not armed') : 'PAPER'}</span>
        </div>
        <div className="cc-ticker" aria-label="Live feed">
          <div className="cc-ticker-track" style={{ animationDuration: `${Math.max(30, ticker.length * 6)}s` }}>
            {[0, 1].map((k) => (
              <span key={k} className="cc-ticker-run" aria-hidden={k === 1}>
                {ticker.map((l, i) => (
                  <span key={i} className={`cc-tick a-${l.agent}`} onClick={() => openCoin(l.mint)}>
                    <b>{l.agent.toUpperCase()}</b> {l.text}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
        <button className={`chip cc-power ${sw.enabled ? 'on' : ''}`} onClick={() => sw.set({ enabled: !sw.enabled })}>
          {sw.enabled ? '■ Stop swarm' : '▶ Start swarm'}
        </button>
      </div>

      <div className="cc-left">
        <Card n="01" title="Wallet · P&L" right={<span className="mono muted">{live && sw.wallet ? `${sw.wallet.address.slice(0, 4)}…${sw.wallet.address.slice(-4)}` : 'paper book'}</span>}>
          <div className={`cc-big mono ${st.pnlSol >= 0 ? 'up' : 'down'}`}>
            <Num value={st.pnlSol} format={(v) => sol(v)} />
            <small> SOL</small>
          </div>
          <div className="cc-sub mono muted">
            {solUsd > 0 ? <Num value={st.pnlSol * solUsd} format={(v) => `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v), 2)}`} /> : '—'} · banked {sol(st.realizedSol)} · open {sol(st.unrealizedSol)}
          </div>
          <div className="cc-spark">
            <Chart draw={(ctx, w, h, pal, hover) => drawArea(ctx, w, h, pal, st.equity.length === 1 ? [{ t: st.equity[0].t - 60_000, v: 0 }, ...st.equity] : st.equity, { color: st.pnlSol >= 0 ? pal.buyRgb : pal.sellRgb, zero: true, hover, fmt: (v) => `${sol(v)} SOL`, empty: 'no trades yet' })} />
          </div>
          <div className="cc-row mono">
            <span>
              <span className="muted">balance </span>
              {live && sw.wallet?.sol != null ? `${sw.wallet.sol.toFixed(3)} SOL` : '—'}
            </span>
            <span>
              <span className="muted">closed </span>
              {st.closed}
            </span>
          </div>
        </Card>

        <Card n="02" title={focus ? `Focus · ${focus.symbol}` : 'Focus'} right={focus && <span className="mono">{fmtUsd(focus.dex?.mcapUsd && focus.migrated ? focus.dex.mcapUsd : focus.mcapSol * solUsd, 1)}</span>} className="cc-focus">
          <div className="cc-chart" onClick={() => openCoin(focus?.mint)}>
            <Chart
              cursor="pointer"
              draw={(ctx, w, h, pal, hover) =>
                drawArea(
                  ctx,
                  w,
                  h,
                  pal,
                  (focus ? priceSeries(focus) : []).slice(-300).map((x) => ({ t: x.t, v: x.mcapSol * (solUsd || 1) })),
                  { color: pal.accentRgb, marks: focusPos?.fills.map((f) => ({ t: f.t, side: f.side })), label: (v) => (solUsd ? `$${fmtNum(v, 1)}` : `${fmtNum(v, 1)}◎`), hover, empty: focus ? 'loading this coin’s price history…' : sw.enabled ? 'reading coins — the strongest shows here' : 'start the swarm — its strongest coin shows here' },
                )
              }
            />
          </div>
          <div className="cc-row mono">
            <span className="muted">{focus ? (focusPos ? (focusPos.closedAt ? 'traded' : 'held') : 'reading') : 'no coin yet'}</span>
            {focusPos && !focusPos.closedAt && <span className="up">{st.open.find((o) => o.id === focusPos.id)?.mult.toFixed(2)}×</span>}
          </div>
        </Card>

        <Card n="03" title="Feeds · latency">
          {(
            [
              ['pump.fun', feed.pump, `${fmtNum(pumpRate, 1)} msg/s`, age(meters.pumpAt), rates.pump],
              ['DexScreener', feed.dex, meters.dexMs ? `${meters.dexMs} ms` : '—', age(meters.dexAt), rates.dex],
              ['Solana RPC', feed.rpc, meters.rpcMs ? `${meters.rpcMs} ms` : '—', age(meters.rpcAt), rates.rpc],
            ] as const
          ).map(([name, state, v, last, rate]) => (
            <div key={name} className="cc-feed" title={state}>
              <span className={`status-dot status-${ok(state)}`} />
              <span className="cc-feed-name">{name}</span>
              <span className="cc-bars" aria-hidden>
                {rate.samples.slice(-24).map((x, i, arr) => (
                  <i key={i} style={{ height: `${Math.min(100, (x / Math.max(1, ...arr)) * 100)}%` }} />
                ))}
              </span>
              <span className="mono">{v}</span>
              <span className="mono muted cc-feed-age">{last}</span>
            </div>
          ))}
        </Card>

        <Card n="04" title="At risk" right={<span className="mono">{st.atRiskSol.toFixed(3)} SOL</span>}>
          {st.open.length ? (
            st.open.slice(0, 5).map((o) => (
              <div key={o.id} className="cc-risk" onClick={() => openCoin(o.mint)}>
                <span className="cc-risk-sym">
                  {o.symbol}
                  {o.live ? <i className="cc-live-dot" title="live" /> : null}
                </span>
                <span className="cc-risk-bar">
                  <i style={{ width: `${Math.min(100, (o.valueSol / Math.max(...st.open.map((x) => x.valueSol), 1e-9)) * 100)}%` }} className={o.mult >= 1 ? 'up' : 'down'} />
                </span>
                <span className={`mono ${o.mult >= 1 ? 'up' : 'down'}`}>{Number.isFinite(o.mult) ? `${o.mult.toFixed(2)}×` : '—'}</span>
              </div>
            ))
          ) : (
            <div className="muted cc-empty">Nothing open. The Manager holds at most {sw.manager.maxOpen} coins, {sw.manager.sizeSol} SOL each.</div>
          )}
        </Card>
      </div>

      <section className="cc-core cc-card" aria-label="Swarm core">
        <CoreView input={input} onSelect={openCoin} />
        <div className="cc-core-agents">
          {(['scout', 'sentinel', 'herald', 'strategist', 'manager'] as const).map((a) => (
            <span key={a} className={`cc-agent ${sw.enabled ? 'on' : ''}`}>
              <i /> {a}
            </span>
          ))}
        </div>
      </section>

      <div className="cc-right">
        <Card n="05" title="Wallet" className="cc-wallet-card" right={<span className={`cc-mode ${live ? (armed ? 'live' : 'unarmed') : 'paper'}`}>{live ? (armed ? '● LIVE' : 'not armed') : 'PAPER'}</span>}>
          {w ? (
            <>
              <div className="cc-wallet-row">
                <span className="cc-wallet-bal mono">{w.sol === null ? '—' : `${w.sol.toFixed(3)}`}</span>
                <span className="muted">SOL{w.sol !== null && solUsd > 0 ? ` · ${fmtUsd(w.sol * solUsd, 0)}` : ''}</span>
              </div>
              <div className="cc-wallet-row muted">
                <span>{w.home ? `→ Phantom ${w.home.slice(0, 4)}…${w.home.slice(-4)}` : 'Phantom not connected'}</span>
                <span>{w.limits.sweepAboveSol > 0 ? `profits home over ${w.limits.sweepAboveSol}` : ''}</span>
              </div>
            </>
          ) : (
            <div className="muted cc-wallet-row">No swarm wallet yet — set it up in a minute: create it, send SOL from Phantom, done.</div>
          )}
          <button className="chip cc-wallet-open" onClick={() => setDrawer('wallet')}>
            {w ? 'Open wallet' : 'Set up wallet'}
          </button>
        </Card>
        <Card n="06" title="Results">
          <div className="cc-tiles">
            <div className="cc-tile">
              <span className="muted">Picks</span>
              <b className="mono">
                <Num value={sw.outcomes.filter((o) => o.kind === 'pick').length} format={(v) => String(Math.round(v))} />
              </b>
            </div>
            <div className="cc-tile">
              <span className="muted">Win rate</span>
              <b className="mono">{st.winRate === null ? '—' : <Num value={st.winRate * 100} format={(v) => `${Math.round(v)}%`} />}</b>
            </div>
            <div className="cc-tile">
              <span className="muted">Best</span>
              <b className="mono up">{st.bestMult ? <Num value={st.bestMult} format={(v) => `${v.toFixed(2)}×`} /> : '—'}</b>
            </div>
            <div className="cc-tile">
              <span className="muted">Open</span>
              <b className="mono">
                {st.open.length}/{sw.manager.maxOpen}
              </b>
            </div>
          </div>
        </Card>
        <Card n="07" title="Execution tape" className="cc-tape-card" right={<span className="muted">{st.tape.length ? `${st.tape.length} fills` : ''}</span>}>
          <div className="cc-tape">
            {st.tape.length ? (
              st.tape.map((f) => (
                <div key={f.key} className={`cc-fill ${f.side}`} onClick={() => openCoin(f.mint)} title={f.why}>
                  <span className="mono muted">{fmtTime(f.t)}</span>
                  <span className={`cc-side ${f.side}`}>{f.side.toUpperCase()}</span>
                  <b>{f.symbol}</b>
                  <span className="mono">{f.sol.toFixed(3)}</span>
                  <span className={`mono ${f.side === 'sell' ? (f.mult >= 1 ? 'up' : 'down') : 'muted'}`}>{f.side === 'sell' ? `${f.mult.toFixed(2)}×` : f.live ? 'live' : 'paper'}</span>
                </div>
              ))
            ) : (
              <div className="muted cc-empty">No fills yet. Every buy and sell the Manager makes lands here.</div>
            )}
          </div>
        </Card>
      </div>

      <div className="cc-bottom">
        <Card n="08" title="Swarm gauges" className="cc-gauges-card">
          <div className="cc-gauges">
            <Gauge value={Math.min(1, ss.scout.perMin / 30)} text={`${ss.scout.perMin}`} label="Scout" sub="new coins / min" tone="cyan" />
            <Gauge value={passRate} label="Sentinel" sub="pass rate" tone="cyan" />
            <Gauge value={viralShare} label="Herald" sub="viral share" tone="magenta" />
            <Gauge value={sw.reads.length ? bestRead / 100 : null} text={sw.reads.length ? String(bestRead) : '—'} label="Strategist" sub={`best read · buys at ${sw.strategy.minConviction}+`} tone={bestRead >= sw.strategy.minConviction ? 'mint' : 'cyan'} />
            <Gauge value={ss.strategist.insiderBest / 100} text={String(ss.strategist.insiderBest)} label="Insiders" sub={`${ss.strategist.proven} proven wallets · buys at ${sw.strategy.insiderMin}+`} tone={sw.strategy.insiderMin > 0 && ss.strategist.insiderBest >= sw.strategy.insiderMin ? 'mint' : 'magenta'} />
            <Gauge value={st.open.length / Math.max(1, sw.manager.maxOpen)} text={`${st.open.length}/${sw.manager.maxOpen}`} label="Manager" sub="positions open" tone="mint" />
            <Gauge value={sw.manager.dailyLossSol ? st.lostToday / sw.manager.dailyLossSol : null} label="Loss limit" sub={`${st.lostToday.toFixed(2)} / ${sw.manager.dailyLossSol} SOL`} tone="chrome" />
            <Gauge value={spentToday / budget} label="Budget" sub={`${spentToday.toFixed(2)} / ${budget} SOL`} tone="chrome" />
          </div>
        </Card>
        <Card n="09" title="Live feed" className="cc-log-card">
          <div className="cc-log">
            {[...sw.log]
              .reverse()
              .slice(0, 40)
              .map((l, i) => (
                <div key={l.t + l.text + i} className={`cc-logline a-${l.agent}`} onClick={() => openCoin(l.mint)}>
                  <span className="mono muted">{fmtTime(l.t)}</span> <b>{l.agent}</b> {l.text}
                </div>
              ))}
            {!sw.log.length && <div className="muted cc-empty">The bots report here as they work.</div>}
          </div>
        </Card>
      </div>
      {drawer && <Drawer tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}
