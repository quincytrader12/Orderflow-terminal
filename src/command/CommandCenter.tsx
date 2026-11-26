// The Command Center: the crypto swarm at a glance, on one black-and-chrome
// screen — the look the meme swarm had, carried over to the crypto swarm.
//
//   top      what is happening now, scrolling past · start and stop
//   left     account and P&L · the coin in focus · the feeds · capital at risk
//   centre   the swarm core (core.ts / core3d.ts): what the bots read flows in,
//            each coin is a sphere of particles, trades flow out
//   right    the account · results · the execution tape
//   bottom   the gauges (the agents, the deploy gate, the council, the forest,
//            the risk manager and its limits) · the live feed
//
// The deploy gate: Strategy Lab strategies plug in here. A deployed strategy
// only proposes — when its own rules fire — and the council, the forest and
// the risk manager decide, size and can veto, exactly as for the swarm's own
// agents. It can never overrule them.
import { canPopOut, popOut } from '../pro/Screens';
import { AuthoritySwitch, LabBookLine } from '../lab/Authority';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtPrice, fmtTime, fmtUsd } from '../core/format';
import type { Kline } from '../core/types';
import { useBoot } from '../app/boot';
import { useCSwarm } from '../cswarm/store';
import { desktop, type CSwarmPosition, type CSwarmState } from '../desktop/bridge';
import { startLabLink, useLab } from '../lab/store';
import { PANEL_MAP } from '../panels/registry';
import { takePendingDrawer } from './drawer';
import { useSettings } from '../store/settings';
import { Canvas, font, type PointerState } from '../ui/canvas';
import { useTicker, type PanelProps } from '../ui/controls';
import { FILTERS, isProTheme, rgba, THEME_IDS, THEMES, themeOf, type Palette } from '../ui/theme';
import { coreMemory, drawCore, type CoreInput } from './core';
import { Core3D, webglAvailable } from './core3d';

const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const usd = (x: number, d = 2) => `${x >= 0 ? '+' : '−'}${fmtUsd(Math.abs(x), d)}`;
const AGENT: Record<string, string> = { scalper: 'Scalper', auction: 'Auctioneer', trend: 'Trend', lab: 'Lab', tape: 'Tape', micro: 'Micro', crowd: 'Crowd', guardian: 'Guardian', forest: 'Forest', risk: 'Risk', swarm: 'Swarm', council: 'Council' };

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

/** A small area chart. */
function drawArea(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, pts: { t: number; v: number }[], o: { color: [number, number, number]; cap?: number; zero?: boolean; marks?: { t: number; v: number; side: 'buy' | 'sell' }[]; levels?: { v: number; color: [number, number, number] }[]; label?: (v: number) => string; hover?: PointerState | null; fmt?: (v: number) => string; empty?: string }) {
  if (pts.length < 2) {
    ctx.fillStyle = pal.muted;
    ctx.font = font(11, 500, false);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.empty ?? 'waiting for data', w / 2, h / 2);
    return;
  }
  const t0 = pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const extra = [...(o.levels ?? []).map((l) => l.v), ...(o.marks ?? []).map((m) => m.v)].filter(Number.isFinite);
  let lo = Math.min(...pts.map((p) => p.v), ...extra, o.zero ? 0 : Infinity);
  let hi = Math.max(...pts.map((p) => p.v), ...extra, o.cap ?? -Infinity, o.zero ? 0 : -Infinity);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.12;
  lo -= o.zero && lo >= 0 ? 0 : pad;
  hi += pad;
  const padR = o.label ? 58 : 4;
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
  for (const l of o.levels ?? []) {
    if (!Number.isFinite(l.v)) continue;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = rgba(l.color, 0.7);
    ctx.beginPath();
    ctx.moveTo(0, Y(l.v));
    ctx.lineTo(w - padR, Y(l.v));
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
    if (m.t < t0) continue;
    ctx.beginPath();
    ctx.arc(X(m.t), Y(m.v), 4, 0, Math.PI * 2);
    ctx.fillStyle = m.side === 'buy' ? pal.buy : pal.sell;
    ctx.fill();
  }
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

/** The gauges' colours in the theme in use (one per gauge). */
export function gaugeColors(theme: string) {
  const g = themeOf(theme).swarm.gauges;
  return g;
}

/** Themes and filters, from the Command Center's own bar (the classic look). */
function ThemePicker() {
  const theme = useSettings((st) => st.theme);
  const filter = useSettings((st) => st.filter);
  const set = useSettings((st) => st.set);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return (
    <div className="cc-theme">
      <button className="chip cc-theme-btn" onClick={() => setOpen(!open)} title="Theme and filter">
        <i style={{ background: THEMES[theme]?.swatch }} /> {THEMES[theme]?.name ?? 'Theme'}
      </button>
      {open && (
        <div className="cc-theme-pop" onMouseLeave={() => setOpen(false)}>
          <div className="cc-theme-head">Theme</div>
          <div className="cc-theme-grid">
            {THEME_IDS.filter((id) => !isProTheme(id)).map((id) => (
              <button key={id} className={`cc-theme-item ${theme === id ? 'on' : ''}`} onClick={() => set({ theme: id })}>
                <span className="cc-theme-sw" style={{ background: THEMES[id].swatch }} />
                <span className="cc-theme-dots">
                  {THEMES[id].swarm.gauges.slice(0, 6).map((c, k) => (
                    <i key={k} style={{ background: c }} />
                  ))}
                </span>
                <b>{THEMES[id].name}</b>
              </button>
            ))}
          </div>
          <div className="cc-theme-head">Filter</div>
          <div className="cc-theme-filters">
            {FILTERS.map((f) => (
              <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => set({ filter: f.id })}>
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A dial in its own colour; `dim` when its condition is not met. Clickable when it opens something. */
function Gauge({ value, label, sub, color, dim, text, onClick, title }: { value: number | null; label: string; sub: string; color: string; dim?: boolean; text?: string; onClick?: () => void; title?: string }) {
  const v = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className={`cc-gauge tinted${dim ? ' dim' : ''}${onClick ? ' clickable' : ''}`} style={{ '--g': color } as React.CSSProperties} onClick={onClick} title={title} role={onClick ? 'button' : undefined}>
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

// ---------- the deploy gate: Lab strategies into the swarm ----------

/** Deploy Strategy Lab strategies into the swarm, switch them on and off — and the rule they follow. */
export function DeployGate() {
  useEffect(() => startLabLink(), []);
  const status = useLab((s) => s.status);
  const result = useLab((s) => s.result);
  const lines = useCSwarm((s) => s.lines);
  const [msg, setMsg] = useState('');
  if (!desktop?.lab) return <div className="muted cc-empty">The Strategy Lab runs in the desktop app.</div>;
  const L = desktop.lab;
  const dep = (status?.deployed ?? []).filter((d) => d.targets.crypto);
  const run = (what: string, f: () => Promise<unknown>) => void f().then(() => setMsg(`${what}: done`), (e) => setMsg(`${what}: ${(e as Error)?.message ?? e}`));
  const deployedNames = new Set(dep.map((d) => d.spec.name));
  return (
    <div className="cc-deploy">
      <div className="cc-gate">
        {['Strategy’s own rules fire', 'Council votes (or advises)', 'Forest odds', 'Guardian + Risk: safety', 'Execute'].map((s, i) => (
          <span key={s} className="cc-gate-step">
            <b>{i + 1}</b> {s}
          </span>
        ))}
      </div>
      <div className="muted cc-gate-note">
        When a deployed strategy's tested entry rules fire on a closed candle, it puts the trade to the swarm. Each strategy has a switch: <b>Council decides</b> — the council votes, the forest can veto, and a no means no trade; or <b>Trade as tested</b> — its statistics were proven on years of data the council was never part of, so the council's votes are only advice on the record. Either way <b>Guardian</b> (spreads, volatility spikes) and <b>Risk</b> (daily loss, drawdown, the size of every trade) can always stop it, and a strategy can only ask for a smaller size, never a bigger one. Signals the council blocks are followed anyway, so each strategy shows whether the council saved or cost it money. Once open, the strategy's own exits (stop, target, trail, time, flip) manage it.
      </div>
      <div className="section-title">Deployed in the crypto swarm ({dep.filter((d) => d.on).length} on)</div>
      {dep.length ? (
        dep.map((d) => {
          const last = [...lines].reverse().find((l) => l.agent === 'lab' && l.text.includes(d.spec.name));
          return (
            <div key={d.id} className={`cc-dep${d.on ? ' on' : ''}`}>
              <button className={`chip${d.on ? ' active' : ''}`} onClick={() => run(d.on ? 'paused' : 'switched on', () => L.toggle(d.id, !d.on))} title={d.on ? 'Pause: it stops proposing; its open trade is still managed' : 'Switch on: it proposes when its rules fire'}>
                {d.on ? '● ON' : '○ OFF'}
              </button>
              <div className="cc-dep-main">
                <b>{d.spec.name}</b>
                <span className="mono muted">
                  {d.tfH < 1 ? `${Math.round(d.tfH * 60)}m` : `${d.tfH}h`} · {d.coins.join(' ')} · tested Sharpe {d.stats.sharpe.toFixed(2)}, t {d.stats.t.toFixed(1)} · {d.stats.verdict}
                </span>
                <LabBookLine d={d} />
                {last && <span className="muted cc-dep-last">{fmtTime(last.t)} — {last.text}</span>}
              </div>
              <AuthoritySwitch d={d} compact />
              <button className="chip" onClick={() => confirm(`Remove “${d.spec.name}” from the swarm? Its open trade, if any, is still managed.`) && run('removed', () => L.undeploy(d.id))}>
                Remove
              </button>
            </div>
          );
        })
      ) : (
        <div className="muted cc-empty">Nothing deployed yet. Deploy a strategy from the Lab's latest research below, or from RSCH in the professional terminal.</div>
      )}
      <div className="section-title">From the Lab's latest research</div>
      {result?.top?.length ? (
        result.top.map((r) => (
          <div key={r.rank} className="cc-dep">
            <span className={`lab-verdict ${r.verdict === 'edge' ? 'edge' : r.verdict === 'promising' ? 'prom' : 'none'}`}>{r.verdict}</span>
            <div className="cc-dep-main">
              <b>
                #{r.rank} {r.spec.name}
              </b>
              <span className="mono muted">
                out of sample: Sharpe {r.oos.sharpe.toFixed(2)} · t {r.oos.t.toFixed(1)} · {r.oos.trades} trades · max drawdown {(r.oos.maxDD * 100).toFixed(1)}%
              </span>
            </div>
            <button className="chip cc-dep-btn" disabled={deployedNames.has(r.spec.name)} onClick={() => run(`deployed #${r.rank}`, () => L.deploy({ rank: r.rank }, { crypto: true, meme: false }))} title="Deploy into the crypto swarm: it proposes, the council votes, the risk manager sizes">
              {deployedNames.has(r.spec.name) ? 'Deployed' : 'Deploy →'}
            </button>
          </div>
        ))
      ) : (
        <div className="muted cc-empty">No research yet — run it in the Strategy Lab (F2 · RSCH in the professional terminal).</div>
      )}
      {msg && <div className="muted cc-gate-note">{msg}</div>}
    </div>
  );
}

/** the swarm view's tools: the deploy gate, the swarm's rules and everything that trades your accounts */
const DRAWER_TABS: { id: string; label: string; panel?: string }[] = [
  { id: 'deploy', label: '⇢ Deploy strategies' },
  { id: 'rules', label: 'Swarm · rules', panel: 'cswarm' },
  { id: 'accounts', label: 'Accounts', panel: 'accounts' },
  { id: 'ticket', label: 'Order ticket', panel: 'ticket' },
  { id: 'amt', label: 'AMT bots', panel: 'amt' },
  { id: 'alerts', label: 'Alerts', panel: 'alerts' },
  { id: 'telegram', label: 'Telegram', panel: 'telegram' },
  { id: 'wallet', label: 'Wallet', panel: 'wallet' },
  { id: 'luno', label: 'Luno', panel: 'luno' },
  { id: 'calculator', label: 'Calculator', panel: 'calculator' },
  { id: 'tradebook', label: 'Trade journal', panel: 'tradebook' },
  { id: 'journal', label: 'Notes', panel: 'journal' },
  { id: 'database', label: 'Database', panel: 'database' },
];
const tabOf = (t: string) => DRAWER_TABS.find((x) => x.id === t || x.panel === t)?.id ?? 'deploy';

function Drawer({ tab, onTab, onClose }: { tab: string; onTab: (t: string) => void; onClose: () => void }) {
  // each tool keeps its settings while the drawer is open
  const [cfgs, setCfgs] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const t = DRAWER_TABS.find((x) => x.id === tab) ?? DRAWER_TABS[0];
  const def = t.panel ? PANEL_MAP[t.panel] : null;
  const Comp = def?.component as ((p: PanelProps<Record<string, unknown>>) => React.ReactElement) | undefined;
  return (
    <aside className="cc-drawer" aria-label="Drawer">
      <header className="cc-drawer-head">
        {DRAWER_TABS.map((x) => (
          <button key={x.id} className={`chip${tab === x.id ? ' active' : ''}`} onClick={() => onTab(x.id)}>
            {x.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {def && canPopOut(t.panel!) && (
          <button className="chip" onClick={() => void popOut(t.panel!, def.title, { ...(def.defaults as Record<string, unknown>), ...(cfgs[t.id] ?? {}) })} title="Open this tool in its own window — send it to another screen with ⧉ Screens">
            ⧉ Window
          </button>
        )}
        <button className="chip" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="cc-drawer-body padded">
        {t.id === 'deploy' && <DeployGate />}
        {def && Comp && <Comp key={t.id} config={{ ...(def.defaults as Record<string, unknown>), ...(cfgs[t.id] ?? {}) }} setConfig={(p) => setCfgs((c) => ({ ...c, [t.id]: { ...(c[t.id] ?? {}), ...p } }))} nodeId={`cc-${t.id}`} />}
      </div>
    </aside>
  );
}

// ---------- the numbers ----------

interface Fill {
  key: string;
  t: number;
  side: 'buy' | 'sell';
  coin: string;
  agent: string;
  px: number;
  usd: number;
  pnl: number | null;
  r: number | null;
  live: boolean;
  why: string;
}

function numbers(st: CSwarmState | null) {
  const open = st?.open ?? [];
  const closed = st?.closed ?? [];
  // the state carries the last 40 closed trades; the totals are all-time
  const recentPnl = closed.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const realised = st ? st.totals.pnl : recentPnl;
  const unreal = open.reduce((a, p) => a + (p.upnl ?? 0), 0);
  const eqStart = st?.book.start ?? st?.cfg.paperStartUsd ?? 0;
  const curve: { t: number; v: number }[] = [];
  // start the recent curve from what was banked before those trades, so it ends at the true total
  let acc = realised - recentPnl;
  for (const p of [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))) {
    acc += p.pnl ?? 0;
    curve.push({ t: p.closedAt ?? p.openedAt, v: acc });
  }
  if (curve.length) curve.push({ t: Date.now(), v: acc + unreal });
  const trades = st?.totals.trades ?? closed.length;
  const wins = st ? st.totals.wins : closed.filter((p) => (p.pnl ?? 0) > 0).length;
  const bestR = closed.reduce((m, p) => Math.max(m, p.r ?? -Infinity), -Infinity);
  const fills: Fill[] = [];
  for (const p of [...open, ...closed]) {
    const side = p.side;
    fills.push({ key: `${p.id}-in`, t: p.openedAt, side, coin: p.coin, agent: p.agentName ?? AGENT[p.agent] ?? p.agent, px: p.entry, usd: p.notional, pnl: null, r: null, live: p.mode === 'live', why: p.summary || p.why });
    if (p.closedAt) fills.push({ key: `${p.id}-out`, t: p.closedAt, side: side === 'buy' ? 'sell' : 'buy', coin: p.coin, agent: p.agentName ?? AGENT[p.agent] ?? p.agent, px: p.exit ?? p.entry, usd: p.notional, pnl: p.pnl ?? 0, r: p.r ?? null, live: p.mode === 'live', why: p.reason ?? '' });
  }
  fills.sort((a, b) => b.t - a.t);
  const dayStart = st?.book.dayStart ?? 0;
  const lostToday = st && st.equity !== null && dayStart > 0 ? Math.max(0, dayStart - st.equity) : 0;
  const lossCap = st ? (dayStart * st.cfg.risk.dailyLossPct) / 100 : 0;
  const atRisk = open.reduce((a, p) => a + p.riskUsd, 0);
  return { open, closed, realised, unreal, total: realised + unreal, eqStart, curve, winRate: trades ? wins / trades : null, bestR: Number.isFinite(bestR) ? bestR : null, fills: fills.slice(0, 40), lostToday, lossCap, atRisk };
}

const rOf = (p: CSwarmPosition) => (p.riskUsd > 0 && p.upnl !== undefined ? p.upnl / p.riskUsd : NaN);

// ---------- the screen ----------

export function CommandCenter() {
  useTicker(1000);
  useEffect(() => startLabLink(), []);
  const st = useCSwarm((s) => s.state);
  const lines = useCSwarm((s) => s.lines);
  const error = useCSwarm((s) => s.error);
  const lab = useLab((s) => s.status);
  const theme = useSettings((s) => s.theme);
  const pro = useSettings((s) => s.ui) === 'pro';
  const now = Date.now();
  const n = useMemo(() => numbers(st), [st]);
  const live = st?.mode === 'live';
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(() => {
    const p = takePendingDrawer();
    return p ? tabOf(p) : null;
  });
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      takePendingDrawer();
      setDrawer(tabOf((e as CustomEvent<string>).detail));
    };
    window.addEventListener('novus:drawer', open);
    return () => window.removeEventListener('novus:drawer', open);
  }, []);

  // the coin in focus: the one picked in the core, else the newest open trade, else the latest signal, else the first coin
  const coins = st?.coins ?? [];
  const lastSig = (c: CSwarmState['coins'][number]) => Math.max(0, ...Object.values(c.engines).map((e) => e.lastSignal?.t ?? 0));
  const focusCoin = pick ?? [...n.open].reverse()[0]?.coin ?? [...coins].sort((a, b) => lastSig(b) - lastSig(a))[0]?.coin ?? null;
  const focus = coins.find((c) => c.coin === focusCoin) ?? null;
  const focusPos = [...n.open, ...n.closed].filter((p) => p.coin === focusCoin).sort((a, b) => b.openedAt - a.openedAt)[0];

  // the focus chart: 5-minute candles from the swarm's exchange, refreshed every minute
  const [candles, setCandles] = useState<{ coin: string; k: Kline[] } | null>(null);
  useEffect(() => {
    if (!focus || !st || !desktop?.ccxt) return;
    let alive = true;
    const load = () =>
      desktop!.ccxt
        .ohlcv(st.cfg.exchangeId, focus.symbol, '5m', 288)
        .then((k) => alive && setCandles({ coin: focus.coin, k }))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [focus?.coin, st?.cfg.exchangeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = useMemo(() => {
    const k = candles?.coin === focusCoin ? candles.k : [];
    const pts = k.map((x) => ({ t: x.time, v: x.close }));
    if (focus && Number.isFinite(focus.price) && focus.price > 0) pts.push({ t: now, v: focus.price });
    return pts;
  }, [candles, focusCoin, focus?.price]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };

  // ---------- the core ----------
  const GC = gaugeColors(theme);
  // the Trend agent reads daily candles (no tape engine): it is warm on a coin once it has read that coin's daily trend
  const warm = (agent: string) => coins.filter((c) => (agent === 'trend' ? !!c.daily : c.engines[agent]?.warm)).length;
  const feedsOk = coins.filter((c) => c.feed === 'open').length;
  const fundingApr = coins.length ? coins.reduce((a, c) => a + Math.abs(c.funding ?? 0), 0) / coins.length / 1e-4 : 0;
  const recent = lines.filter((l) => now - l.t < 60 * 60_000);
  const proposals = recent.filter((l) => l.kind === 'propose').length;
  const trades = recent.filter((l) => l.kind === 'trade').length;
  const passes = recent.filter((l) => l.kind === 'pass').length;
  const councilRate = trades + passes ? trades / (trades + passes) : null;
  const depOn = (lab?.deployed ?? []).filter((d) => d.on && d.targets.crypto);
  const labOpen = n.open.filter((p) => (p.agent as string) === 'lab').length;
  const maxOpen = st?.cfg.risk.maxOpen ?? 1;
  const ft = st?.forest.trained;
  const dd = st && st.equity !== null && st.book.peak > 0 ? Math.max(0, 1 - st.equity / st.book.peak) : 0;
  const held = new Set(n.open.map((p) => p.coin));
  const input = useRef<CoreInput>(null!);
  input.current = {
    on: !!st?.running,
    activity: Math.min(1, (st?.running ? 0.25 : 0) + proposals / 20 + feedsOk / Math.max(1, coins.length) / 3),
    title: 'SWARM CORE',
    caption: st?.running ? `${coins.length} coins in the core · ${proposals} proposals in the last hour · ${depOn.length} Lab strateg${depOn.length === 1 ? 'y' : 'ies'} deployed` : 'swarm off — start it to fill the core',
    inputs: [
      { label: 'Feeds live', value: `${feedsOk}/${coins.length}`, rate: coins.length ? feedsOk / coins.length : 0 },
      { label: 'Auctioneer', value: `${warm('auction')} warm`, rate: coins.length ? warm('auction') / coins.length : 0 },
      { label: 'Trend', value: `${warm('trend')} warm`, rate: coins.length ? warm('trend') / coins.length : 0 },
      { label: 'Lab strategies', value: `${depOn.length} on`, rate: Math.min(1, depOn.length / 3) },
      { label: 'Funding', value: `${fmtNum(fundingApr * 24 * 365 / 100, 0)}% a yr`, rate: Math.min(1, fundingApr / 2) },
    ],
    outputs: [
      { label: 'Proposals / h', value: String(proposals), rate: Math.min(1, proposals / 10) },
      { label: 'Open', value: `${n.open.length} / ${maxOpen}`, rate: n.open.length / Math.max(1, maxOpen) },
      { label: 'Win rate', value: n.winRate === null ? '—' : `${Math.round(n.winRate * 100)}%`, rate: n.winRate ?? 0, tone: n.winRate !== null ? (n.winRate >= 0.5 ? 'up' : 'down') : undefined },
      { label: 'P&L', value: usd(n.total), rate: Math.min(1, Math.abs(n.total) / Math.max(1, n.eqStart) * 5), tone: n.total >= 0 ? 'up' : 'down' },
      { label: 'Best', value: n.bestR === null ? '—' : `${n.bestR.toFixed(1)}R`, rate: Math.min(1, (n.bestR ?? 0) / 4) },
      { label: 'Loss left today', value: fmtUsd(Math.max(0, n.lossCap - n.lostToday), 2), rate: n.lossCap ? 1 - Math.min(1, n.lostToday / n.lossCap) : 1, tone: n.lossCap && n.lostToday >= n.lossCap ? 'warn' : undefined },
    ],
    blobs: coins.map((c) => {
      const sigAge = now - lastSig(c);
      const heat = sigAge < 15 * 60_000 ? 90 - (sigAge / (15 * 60_000)) * 50 : 25;
      const warmShare = Object.values(c.engines).filter((e) => e.warm).length / Math.max(1, Object.keys(c.engines).length);
      return {
        id: c.coin,
        label: c.coin,
        conviction: held.has(c.coin) ? 90 : Math.round(heat * (0.5 + 0.5 * warmShare)),
        viability: c.daily ? Math.round((c.daily.dir > 0 ? c.daily.up / 3 : (3 - c.daily.up) / 3) * 100) : 40,
        virality: Math.round(Math.min(100, Math.abs(c.funding ?? 0) / 1e-4 * 40 + (sigAge < 15 * 60_000 ? 40 : 0))),
        enter: sigAge < 5 * 60_000,
        held: held.has(c.coin),
      };
    }),
  };

  const ticker = useMemo(() => {
    const items = [...lines].slice(-24).reverse();
    return items.length ? items : [{ t: now, agent: 'swarm' as const, text: st?.running ? 'reading the markets…' : 'swarm off — press Start', kind: 'info' as const }];
  }, [lines, st?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!desktop?.cswarm) return <div className="cc"><div className="cc-empty muted" style={{ gridColumn: '1 / -1', padding: 40 }}>The crypto swarm runs in the desktop app.</div></div>;
  if (!st) return <div className="cc"><div className="cc-empty muted" style={{ gridColumn: '1 / -1', padding: 40 }}>{error || 'Connecting to the crypto swarm…'}</div></div>;

  const by = st.byAgent as Record<string, { trades: number; wins: number; pnl: number; avgR: number | null } | undefined>;
  const agentGauge = (id: 'auction' | 'trend', i: number) => {
    const b = by[id];
    const on = st.cfg.agents[id];
    const wr = b && b.trades ? b.wins / b.trades : null;
    return <Gauge key={id} value={wr ?? (on ? warm(id) / Math.max(1, coins.length) : 0)} text={wr !== null ? `${Math.round(wr * 100)}%` : on ? `${warm(id)}/${coins.length}` : 'off'} label={AGENT[id]} sub={b && b.trades ? `${b.trades} trades · ${usd(b.pnl)}` : on ? 'coins warm · no trades yet' : 'switched off'} color={GC[i]} dim={!on} />;
  };
  return (
    <div className={`cc ${st.running ? 'on' : ''}`}>
      <div className="cc-top">
        <div className="cc-brand">
          <span className="cc-brand-name">SWARM COMMAND</span>
          <span className={`cc-mode ${live ? 'live' : 'paper'}`}>{live ? `● LIVE · ${st.cfg.exchangeId}${st.sandbox ? ' testnet' : ''}` : 'PAPER'}</span>
          {!pro && <ThemePicker />}
        </div>
        <div className="cc-ticker" aria-label="Live feed">
          <div className="cc-ticker-track" style={{ animationDuration: `${Math.max(30, ticker.length * 6)}s` }}>
            {[0, 1].map((k) => (
              <span key={k} className="cc-ticker-run" aria-hidden={k === 1}>
                {ticker.map((l, i) => (
                  <span key={i} className={`cc-tick a-${l.agent}`}>
                    <b>{(AGENT[l.agent] ?? l.agent).toUpperCase()}</b> {l.text}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
        <button className="chip cc-deploy-open" onClick={() => setDrawer('deploy')} title="Deploy Strategy Lab strategies into the swarm">
          ⇢ Deploy
        </button>
        <button className="chip cc-tools-open" onClick={() => setDrawer('accounts')} title="Accounts, order ticket, AMT bots, alerts, Telegram, wallet, Luno, calculator, journal, database">
          ☰ Accounts &amp; tools
        </button>
        <button className={`chip cc-power ${st.running ? 'on' : ''}`} disabled={busy} onClick={() => run(() => (st.running ? desktop!.cswarm.stop(false) : desktop!.cswarm.start()))}>
          {st.running ? '■ Stop swarm' : '▶ Start swarm'}
        </button>
      </div>

      <div className="cc-left">
        <Card n="01" title="Account · P&L" right={<span className="mono muted">{live ? st.cfg.exchangeId : 'paper book'}</span>}>
          <div className={`cc-big mono ${n.total >= 0 ? 'up' : 'down'}`}>
            <Num value={n.total} format={(v) => usd(v)} />
          </div>
          <div className="cc-sub mono muted">
            banked {usd(n.realised)} · open {usd(n.unreal)} · equity {st.equity !== null ? fmtUsd(st.equity, 2) : '—'}
          </div>
          <div className="cc-spark">
            <Chart draw={(ctx, w, h, pal, hover) => drawArea(ctx, w, h, pal, n.curve.length === 1 ? [{ t: n.curve[0].t - 60_000, v: 0 }, ...n.curve] : n.curve, { color: n.total >= 0 ? pal.buyRgb : pal.sellRgb, zero: true, hover, fmt: (v) => usd(v), empty: 'no closed trades yet' })} />
          </div>
          <div className="cc-row mono">
            <span>
              <span className="muted">floor </span>
              {fmtUsd(st.book.floor, 2)}
            </span>
            <span>
              <span className="muted">closed </span>
              {n.closed.length}
            </span>
          </div>
        </Card>

        <Card n="02" title={focus ? `Focus · ${focus.coin}` : 'Focus'} right={focus && <span className="mono">{fmtPrice(focus.price)}</span>} className="cc-focus">
          <div className="cc-chart">
            <Chart
              draw={(ctx, w, h, pal, hover) =>
                drawArea(ctx, w, h, pal, series, {
                  color: pal.accentRgb,
                  marks: focusPos ? [{ t: focusPos.openedAt, v: focusPos.entry, side: focusPos.side }, ...(focusPos.closedAt ? [{ t: focusPos.closedAt, v: focusPos.exit ?? focusPos.entry, side: (focusPos.side === 'buy' ? 'sell' : 'buy') as 'buy' | 'sell' }] : [])] : [],
                  levels: focusPos && !focusPos.closedAt ? [{ v: focusPos.stop, color: pal.sellRgb }, { v: focusPos.target, color: pal.buyRgb }] : [],
                  label: (v) => fmtPrice(v),
                  hover,
                  empty: focus ? 'loading candles…' : 'press Start swarm',
                })
              }
            />
          </div>
          <div className="cc-row mono">
            <span className="muted">{focusPos && !focusPos.closedAt ? `${focusPos.side === 'buy' ? 'long' : 'short'} · ${focusPos.agentName ?? AGENT[focusPos.agent] ?? focusPos.agent} · stop ${fmtPrice(focusPos.stop)}` : focus?.daily ? `daily trend ${focus.daily.dir > 0 ? 'up' : 'down'} (${focus.daily.dir > 0 ? focus.daily.up : 3 - focus.daily.up}/3)` : 'watching'}</span>
            {focusPos && !focusPos.closedAt && <span className={rOf(focusPos) >= 0 ? 'up' : 'down'}>{Number.isFinite(rOf(focusPos)) ? `${rOf(focusPos).toFixed(2)}R` : ''}</span>}
          </div>
        </Card>

        <Card n="03" title="Feeds · markets">
          {coins.map((c) => (
            <div key={c.coin} className="cc-feed cc-mkt" title={c.feedError ?? c.feed} onClick={() => setPick(c.coin)}>
              <span className={`status-dot status-${c.feed === 'open' ? 'open' : c.feedError ? 'error' : 'connecting'}`} />
              <span className="cc-feed-name">{c.coin}</span>
              <span className={`mono ${c.daily ? (c.daily.dir > 0 ? 'up' : 'down') : 'muted'}`}>{c.daily ? (c.daily.dir > 0 ? '▲' : '▼') : '·'}</span>
              <span className="mono">{fmtPrice(c.price)}</span>
              <span className="mono muted cc-feed-age">{c.funding !== null ? `${((c.funding ?? 0) * 24 * 365 * 100).toFixed(0)}%/y` : '—'}</span>
            </div>
          ))}
        </Card>

        <Card n="04" title="At risk" right={<span className="mono">{fmtUsd(n.atRisk, 2)}</span>}>
          {n.open.length ? (
            n.open.map((p) => (
              <div key={p.id} className="cc-risk" onClick={() => setPick(p.coin)}>
                <span className="cc-risk-sym">
                  {p.coin} {p.side === 'buy' ? '▲' : '▼'}
                  {p.mode === 'live' ? <i className="cc-live-dot" title="live" /> : null}
                </span>
                <span className="cc-risk-bar">
                  <i style={{ width: `${Math.min(100, (Math.abs(rOf(p)) || 0) * 50)}%` }} className={rOf(p) >= 0 ? 'up' : 'down'} />
                </span>
                <span className={`mono ${rOf(p) >= 0 ? 'up' : 'down'}`}>{Number.isFinite(rOf(p)) ? `${rOf(p).toFixed(2)}R` : '—'}</span>
              </div>
            ))
          ) : (
            <div className="muted cc-empty">
              Nothing open. At most {maxOpen} position{maxOpen > 1 ? 's' : ''}, risking {st.cfg.risk.riskPct}% of the account each (the risk manager moves it between {st.cfg.risk.minRiskPct}% and {st.cfg.risk.maxRiskPct}%).
            </div>
          )}
        </Card>
      </div>

      <section className="cc-core cc-card" aria-label="Swarm core">
        <CoreView key={theme} input={input} onSelect={setPick} />
        <div className="cc-core-agents">
          {(['auction', 'trend', 'lab', 'tape', 'micro', 'crowd', 'guardian', 'forest', 'risk'] as const).map((a) => (
            <span key={a} className={`cc-agent ${st.running && (a !== 'lab' || depOn.length) ? 'on' : ''}`}>
              <i /> {AGENT[a]}
            </span>
          ))}
        </div>
      </section>

      <div className="cc-right">
        <Card n="05" title="Account" className="cc-wallet-card" right={<span className={`cc-mode ${live ? 'live' : 'paper'}`}>{live ? '● LIVE' : 'PAPER'}</span>}>
          <div className="cc-wallet-row">
            <span className="cc-wallet-bal mono">{st.equity !== null ? fmtUsd(st.equity, 2) : '—'}</span>
            <span className="muted">{live ? `${st.cfg.exchangeId}${st.sandbox ? ' · testnet' : ''}` : `paper · started ${fmtUsd(st.cfg.paperStartUsd, 0)}`}</span>
          </div>
          <div className="cc-wallet-row muted">
            <span>peak {fmtUsd(st.book.peak, 2)} · drawdown {(dd * 100).toFixed(1)}%</span>
            <span>{st.book.pausedUntil > now ? `paused until ${fmtTime(st.book.pausedUntil)}` : `streak ${st.book.streak}`}</span>
          </div>
          <button className="chip cc-wallet-open" onClick={() => setDrawer('rules')}>
            Account · rules
          </button>
        </Card>
        <Card n="06" title="Results">
          <div className="cc-tiles">
            <div className="cc-tile">
              <span className="muted">Trades</span>
              <b className="mono">
                <Num value={st.totals.trades} format={(v) => String(Math.round(v))} />
              </b>
            </div>
            <div className="cc-tile">
              <span className="muted">Win rate</span>
              <b className="mono">{n.winRate === null ? '—' : <Num value={n.winRate * 100} format={(v) => `${Math.round(v)}%`} />}</b>
            </div>
            <div className="cc-tile">
              <span className="muted">Best</span>
              <b className="mono up">{n.bestR === null ? '—' : <Num value={n.bestR} format={(v) => `${v.toFixed(1)}R`} />}</b>
            </div>
            <div className="cc-tile">
              <span className="muted">Open</span>
              <b className="mono">
                {n.open.length}/{maxOpen}
              </b>
            </div>
          </div>
        </Card>
        <Card n="07" title="Execution tape" className="cc-tape-card" right={<span className="muted">{n.fills.length ? `${n.fills.length} fills` : ''}</span>}>
          <div className="cc-tape">
            {n.fills.length ? (
              n.fills.map((f) => (
                <div key={f.key} className={`cc-fill ${f.side}`} onClick={() => setPick(f.coin)} title={f.why}>
                  <span className="mono muted">{fmtTime(f.t)}</span>
                  <span className={`cc-side ${f.side}`}>{f.side.toUpperCase()}</span>
                  <b>{f.coin}</b>
                  <span className="mono">{fmtUsd(f.usd, 0)}</span>
                  <span className={`mono ${f.pnl === null ? 'muted' : f.pnl >= 0 ? 'up' : 'down'}`}>{f.pnl === null ? `${f.agent}${f.live ? '' : ' · paper'}` : `${usd(f.pnl)}${f.r !== null ? ` · ${f.r.toFixed(1)}R` : ''}`}</span>
                </div>
              ))
            ) : (
              <div className="muted cc-empty">No fills yet. Every entry and exit the swarm makes lands here.</div>
            )}
          </div>
        </Card>
      </div>

      <div className="cc-bottom">
        <Card n="08" title="Swarm gauges" className="cc-gauges-card">
          <div className="cc-gauges">
            <Gauge value={coins.length ? feedsOk / coins.length : null} text={`${feedsOk}/${coins.length}`} label="Guardian" sub={st.running ? 'feeds live · spreads and spikes watched' : 'watching when the swarm runs'} color={GC[0]} dim={!st.running} />
            {agentGauge('auction', 1)}
            {agentGauge('trend', 2)}
            <Gauge
              value={depOn.length ? Math.min(1, depOn.length / 3) : null}
              text={`${depOn.length} on`}
              label="Lab · deploy"
              sub={depOn.length ? `${labOpen} open · as tested or by the council` : 'click to deploy a strategy'}
              color={GC[3]}
              dim={!depOn.length}
              onClick={() => setDrawer('deploy')}
              title="The deploy gate: Strategy Lab strategies plug in here. Each trades as tested or lets the council decide; Guardian and Risk always check every trade."
            />
            <Gauge value={councilRate} text={councilRate === null ? '—' : `${Math.round(councilRate * 100)}%`} label="Council" sub={`${trades} traded · ${passes} passed (1 h)`} color={GC[4]} dim={councilRate === null} />
            <Gauge value={ft ? ft.accuracy : st.forest.samples ? Math.min(1, st.forest.samples / 200) : null} text={ft?.accuracy != null ? `${Math.round(ft.accuracy * 100)}%` : `${st.forest.samples}`} label="Forest" sub={ft ? `accuracy · ${ft.n} trades learned` : `${st.forest.samples} samples · learning`} color={GC[5]} dim={!ft} />
            <Gauge value={1 - Math.min(1, dd / Math.max(0.01, st.cfg.risk.ddCut2))} text={`${st.cfg.risk.riskPct}%`} label="Optimizer" sub={`risk a trade · drawdown ${(dd * 100).toFixed(1)}%`} color={dd >= st.cfg.risk.ddCut1 ? GC[8] : GC[7]} dim={dd >= st.cfg.risk.ddCut1} />
            <Gauge value={n.open.length / Math.max(1, maxOpen)} text={`${n.open.length}/${maxOpen}`} label="Exposure" sub={`positions · ${fmtUsd(n.open.reduce((a, p) => a + p.notional, 0), 0)} notional`} color={GC[6]} dim={!n.open.length} />
            <Gauge value={n.lossCap ? n.lostToday / n.lossCap : null} label="Loss limit" sub={`${fmtUsd(n.lostToday, 2)} / ${fmtUsd(n.lossCap, 2)} today`} color={GC[8]} dim={n.lostToday <= 0} />
            <Gauge value={st.equity !== null && st.book.start > st.book.floor ? (st.equity - st.book.floor) / (st.book.start - st.book.floor) : null} label="Floor" sub={`stops at ${fmtUsd(st.book.floor, 2)}`} color={GC[9]} />
          </div>
        </Card>
        <Card n="09" title="Live feed" className="cc-log-card">
          <div className="cc-log">
            {[...lines]
              .reverse()
              .slice(0, 40)
              .map((l, i) => (
                <div key={l.t + l.text + i} className={`cc-logline a-${l.agent} k-${l.kind}`}>
                  <span className="mono muted">{fmtTime(l.t)}</span> <b>{AGENT[l.agent] ?? l.agent}</b> {l.text}
                </div>
              ))}
            {!lines.length && <div className="muted cc-empty">The agents and the council report here as they work.</div>}
          </div>
        </Card>
      </div>
      {drawer && <Drawer tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}
