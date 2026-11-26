// The Strategy Lab's screens in the professional terminal:
//
//   LIB   Library — every rule and filter, the papers behind it, and why it should work
//   RSCH  Research — run the search, watch it, read the top five and their tests, deploy
//   BT    Builder — put a strategy together by hand and backtest it
//   DEPL  Deployed — the strategies trading in the swarms, and what they have said
import { AuthoritySwitch, LabBookLine } from '../lab/Authority';
import { useEffect, useMemo, useState } from 'react';
import { useCSwarm } from '../cswarm/store';
import { desktop, type StrategyHealth } from '../desktop/bridge';
import type { StrategySpec } from '../lab/backtest';
import { EXIT_DEFAULT, FILTER_MAP, FILTERS, SIGNAL_MAP, SIGNALS, type ExitSpec } from '../lab/library';
import { PAPERS, type Paper } from '../lab/papers';
import { nameOf, rulesOf, type ForecastReport, type Learned, type Ranked } from '../lab/research';
import { startLabLink, useLab, type LabConfig, type LabTest } from '../lab/store';
import { Check, NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { Bars, Fan, LineChart } from './charts';
import { SpecOptimizer } from './Optimizer';
import { FarmStrip } from './FarmPanel';
import { openFunction } from './ProBar';

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

function NeedsDesktop() {
  return <div className="pro-empty">The Strategy Lab runs in the desktop app: it downloads years of candles and researches them in the background.</div>;
}

/** the Lab's status and last result — not the edge finder's state, which changes every few seconds (these panels do not show it) */
function useLabLink() {
  useEffect(() => startLabLink(), []);
  const status = useLab((s) => s.status);
  const result = useLab((s) => s.result);
  const loaded = useLab((s) => s.loaded);
  return { status, result, loaded };
}

export function PaperCite({ p }: { p: Paper }) {
  return (
    <div className="lab-paper">
      <b>{p.cite}</b> — <i>{p.title}</i>. {p.venue}.
      {p.ssrn && (
        <>
          {' '}
          <a href={`https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${p.ssrn}`} onClick={(e) => (e.preventDefault(), void desktop?.app.openExternal(`https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${p.ssrn}`))}>
            SSRN {p.ssrn}
          </a>
        </>
      )}
      <div className="muted">{p.finding}</div>
    </div>
  );
}

// ---------- LIB ----------

export interface LibConfig {
  family: string;
}
export const LIB_DEFAULTS: LibConfig = { family: 'all' };

export function LabLibrary({ config: c, setConfig }: PanelProps<LibConfig>) {
  const families = ['all', ...new Set(SIGNALS.map((s) => s.family))];
  const [open, setOpen] = useState<string | null>(SIGNALS[0].id);
  const list = SIGNALS.filter((s) => c.family === 'all' || s.family === c.family);
  return (
    <div className="pro-panel">
      <Toolbar>
        <Select value={c.family} options={families.map((f) => ({ value: f, label: f === 'all' ? 'All families' : f }))} onChange={(family) => setConfig({ family })} />
        <Spacer />
        <span className="pro-status">
          {SIGNALS.length} rules · {FILTERS.length} filters · {Object.keys(PAPERS).length} papers
        </span>
      </Toolbar>
      <div className="pro-scroll lab-lib">
        <div className="pro-section">ENTRY RULES</div>
        {list.map((s) => (
          <div key={s.id} className={`lab-rule${open === s.id ? ' open' : ''}`}>
            <button className="lab-rule-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="lab-fam">{s.family.toUpperCase()}</span>
              <b>{s.name}</b>
              <span className="muted">{s.papers.map((p) => PAPERS[p].cite).join('; ')}</span>
            </button>
            {open === s.id && (
              <div className="lab-rule-body">
                <p>
                  <b>Why it should work.</b> {s.rationale}
                </p>
                <p>
                  <b>Rule.</b> {s.describe(Object.fromEntries(Object.entries(s.grid).map(([k, v]) => [k, v[0]])))}
                </p>
                <p className="mono muted">
                  grid: {Object.entries(s.grid).map(([k, v]) => `${k} ∈ {${v.join(', ')}}`).join(' · ')}
                  {s.needsFunding ? ' · needs funding history' : ''}
                  {s.needsBench ? ' · needs BTC and another coin among the coins' : ''}
                  {s.intraday ? ' · intraday bars only' : ''}
                </p>
                {s.papers.map((p) => (
                  <PaperCite key={p} p={PAPERS[p]} />
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="pro-section">FILTERS</div>
        {FILTERS.map((f) => (
          <div key={f.id} className={`lab-rule${open === f.id ? ' open' : ''}`}>
            <button className="lab-rule-head" onClick={() => setOpen(open === f.id ? null : f.id)}>
              <span className="lab-fam">FILTER</span>
              <b>{f.name}</b>
              <span className="muted">{f.papers.map((p) => PAPERS[p].cite).join('; ')}</span>
            </button>
            {open === f.id && (
              <div className="lab-rule-body">
                <p>{f.rationale}</p>
                {f.papers.map((p) => (
                  <PaperCite key={p} p={PAPERS[p]} />
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="pro-section">THE TESTS</div>
        {['blp12', 'blp14', 'bblz17', 'hlz16', 'nw87', 'lp18', 'pr94', 'bre01'].map((p) => (
          <PaperCite key={p} p={PAPERS[p]} />
        ))}
      </div>
    </div>
  );
}

// ---------- RSCH ----------

export const RESEARCH_PANEL_DEFAULTS = {};

const verdictCls = (v: string) => (v === 'edge' ? 'v-edge' : v === 'promising' ? 'v-prom' : 'v-none');

function ConfigBar({ cfg, running }: { cfg: LabConfig; running: boolean }) {
  const L = desktop!.lab;
  const [coins, setCoins] = useState(cfg.coins.join(' '));
  useEffect(() => setCoins(cfg.coins.join(' ')), [cfg.coins]);
  const save = (p: Partial<LabConfig>) => void L.config(p);
  return (
    <Toolbar>
      <input className="ctl mono" value={coins} onChange={(e) => setCoins(e.target.value.toUpperCase())} onBlur={() => save({ coins: coins.split(/[\s,]+/).filter(Boolean).slice(0, 8) })} style={{ width: 130 }} title="Coins to research together (the same rules on each)" disabled={running} />
      <Select value={cfg.timeframe} options={[{ value: '15m', label: '15 minutes' }, { value: '1h', label: '1 hour' }, { value: '4h', label: '4 hours' }, { value: '1d', label: '1 day' }]} onChange={(timeframe) => save({ timeframe })} title="Candle timeframe (15-minute candles: at most a year of history)" />
      <Select value={cfg.years} options={[1, 2, 3, 5].map((y) => ({ value: y, label: `${y} yr` }))} onChange={(years) => save({ years })} title="Years of history" />
      <Select value={cfg.combos} options={[100, 400, 1000].map((n) => ({ value: n, label: `${n} mixes` }))} onChange={(combos) => save({ combos })} title="How many mixed strategies to try" />
      <Select value={cfg.sides} options={[{ value: 'both', label: 'Long + short' }, { value: 'long', label: 'Long only' }]} onChange={(sides) => save({ sides })} />
      <Select value={cfg.source} options={[{ value: 'auto', label: 'Auto source' }, ...['binance', 'okx', 'bybit', 'hyperliquid'].map((v) => ({ value: v, label: v }))]} onChange={(source) => save({ source: source as LabConfig['source'] })} title="Where the history comes from" />
      <Check checked={cfg.meta} onChange={(meta) => save({ meta })}>
        Forest filter
      </Check>
      <Check checked={cfg.funding} onChange={(funding) => save({ funding })}>
        Funding
      </Check>
      <Spacer />
      {running ? (
        <button className="btn ghost" onClick={() => void L.cancel()}>
          Cancel
        </button>
      ) : (
        <button className="btn" onClick={() => void L.run().catch(() => undefined)}>
          ▶ Run research
        </button>
      )}
    </Toolbar>
  );
}

function Detail({ r, tfH, onDeploy }: { r: Ranked; tfH: number; onDeploy: (targets: { crypto: boolean; meme: boolean }) => void }) {
  const split = r.curve.findIndex((p) => p.t >= r.split);
  return (
    <div className="lab-detail">
      <div className="lab-detail-head">
        <span className={`lab-verdict ${verdictCls(r.verdict)}`}>{r.verdict.toUpperCase()}</span>
        <b>
          #{r.rank} {r.spec.name}
        </b>
        <Spacer />
        <button className="btn" onClick={() => onDeploy({ crypto: true, meme: false })} title="Trade it in the crypto swarm: it proposes, the council votes, the risk manager sizes">
          Deploy → Crypto swarm
        </button>
      </div>
      <div className="lab-grid2">
        <div>
          <div className="pro-section">RULES</div>
          {r.rules.map((x) => (
            <div key={x} className="lab-line">
              {x}
            </div>
          ))}
          <div className="pro-section">WHY</div>
          {r.rationale.map((x) => (
            <div key={x} className="lab-line muted">
              {x}
            </div>
          ))}
          <div className="pro-section">TESTS (OUT OF SAMPLE)</div>
          <table className="pro-table compact">
            <tbody>
              {r.checks.map((c) => (
                <tr key={c.name}>
                  <td className={`l ${c.pass ? 'up' : 'down'}`}>{c.pass ? '✓' : '✗'}</td>
                  <td className="l">{c.name}</td>
                  <td className="mono">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="pro-section">EQUITY — STRATEGY vs BUY & HOLD (line = out-of-sample start)</div>
          <LineChart
            series={[
              { values: r.curve.map((p) => p.bh), color: 'var(--faint)', dash: '3 3' },
              { values: r.curve.map((p) => p.eq), color: 'var(--pro-accent, var(--accent))', width: 1.8 },
            ]}
            marker={split}
            labels={
              <>
                <span style={{ color: 'var(--pro-accent, var(--accent))' }}>■ strategy</span> <span className="muted">▫ buy & hold</span>
              </>
            }
          />
          <div className="pro-section">MONTE CARLO — {r.mc ? `${r.mc.paths} paths of ${r.mc.trades} trades at 1 % risk` : 'too few trades'}</div>
          {r.mc && <Fan fan={r.mc.fan} />}
          {r.mc && (
            <div className="lab-kv mono">
              <span>p5 {num(r.mc.p5)}×</span>
              <span>median {num(r.mc.p50)}×</span>
              <span>p95 {num(r.mc.p95)}×</span>
              <span>P(loss) {pct(r.mc.pLoss)}</span>
              <span>DD median {pct(r.mc.ddMed)}</span>
              <span>DD p95 {pct(r.mc.dd95)}</span>
            </div>
          )}
          <div className="pro-section">GARCH WORLDS — SAME VOLATILITY, NO EDGE</div>
          {r.garchNull ? (
            <div className="lab-line">
              In {r.garchNull.sims} simulated continuations of each coin (its own GARCH model driven by its own shocks: volatility clusters and fat tails, but no edge), the strategy's median Sharpe was {num(r.garchNull.median)} against {num(r.oos.sharpe)} on the real data —{' '}
              <span className={r.garchNull.p <= 0.1 ? 'up' : 'down'}>p = {num(r.garchNull.p)}</span>. {r.garchNull.p <= 0.1 ? 'Volatility alone does not explain it.' : 'Volatility clustering alone could produce a result like this.'}
            </div>
          ) : (
            <div className="lab-line muted">Run only for the leading eight strategies.</div>
          )}
        </div>
      </div>
      <div className="lab-grid2">
        <div>
          <div className="pro-section">IN SAMPLE vs OUT OF SAMPLE</div>
          <table className="pro-table compact">
            <thead>
              <tr>
                <th className="l" />
                <th>SHARPE</th>
                <th>SORTINO</th>
                <th>CAGR</th>
                <th>MAX DD</th>
                <th>TRADES</th>
                <th>WIN</th>
                <th>AVG R</th>
                <th>t (NW)</th>
              </tr>
            </thead>
            <tbody>
              {(['is', 'oos'] as const).map((k) => (
                <tr key={k}>
                  <td className="l b">{k === 'is' ? 'IN' : 'OUT'}</td>
                  <td className="mono">{num(r[k].sharpe)}</td>
                  <td className="mono">{num(r[k].sortino)}</td>
                  <td className={`mono ${r[k].cagr >= 0 ? 'up' : 'down'}`}>{pct(r[k].cagr, 1)}</td>
                  <td className="mono down">{pct(r[k].maxDD, 1)}</td>
                  <td className="mono">{r[k].trades}</td>
                  <td className="mono">{pct(r[k].winRate)}</td>
                  <td className="mono">{num(r[k].avgR)}</td>
                  <td className="mono">{num(r[k].t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="lab-kv mono">
            <span>Deflated Sharpe {pct(r.dsr)}</span>
            <span>α {pct(r.reg.alphaAnn, 1)}/yr (t {num(r.reg.tAlpha)})</span>
            <span>β {num(r.reg.beta)}</span>
            <span>random-entry p {r.nullTest ? num(r.nullTest.p, 3) : '—'}</span>
          </div>
          <div className="pro-section">PER COIN (OUT OF SAMPLE)</div>
          <Bars rows={r.perCoin.map((p) => ({ label: p.coin, value: p.oos.sharpe }))} format={(v) => `SR ${v.toFixed(2)}`} />
        </div>
        <div>
          <div className="pro-section">RANDOM-FOREST META-LABELLER</div>
          {r.meta ? (
            <>
              <div className="lab-line">
                {r.meta.used ? 'Kept: it helped in the training check' : r.meta.valBefore == null ? 'Not kept: too few training trades to check it' : 'Not kept: it did not help in the training check'}
                {r.meta.valBefore != null && r.meta.valAfter != null ? ` (Sharpe ${num(r.meta.valBefore)} → ${num(r.meta.valAfter)} on the last 30 % of the training years, fitted on the trades before them)` : ''}. Out of sample: {num(r.meta.oosSharpeBefore)} → {num(r.meta.oosSharpeAfter)} on {r.meta.tradesAfter} trades — a read-out; the choice never looks at it. Out-of-bag accuracy {r.meta.oob !== null ? pct(r.meta.oob) : '—'} against a base rate of {pct(r.meta.base)}.
              </div>
              <Bars rows={r.meta.importance.map(([f, w]) => ({ label: f, value: w, tone: 'up' }))} format={(v) => pct(v)} />
            </>
          ) : (
            <div className="lab-line muted">Too few in-sample trades to train it.</div>
          )}
          <div className="pro-section">PAPERS</div>
          {r.papers.map((p) => (
            <PaperCite key={p} p={PAPERS[p]} />
          ))}
          <div className="lab-line muted mono">timeframe {tfH < 1 ? `${Math.round(tfH * 60)}m` : `${tfH}h`} · {r.family}</div>
        </div>
      </div>
      <SpecOptimizer key={r.rank + r.spec.name} spec={r.spec} tfH={tfH} />
    </div>
  );
}

/** the adaptive search's account of each ingredient */
function LearnedView({ rows }: { rows: Learned[] }) {
  if (!rows.length) return <div className="pro-empty">This research ran before the adaptive search was added: run it again.</div>;
  const groups = ['sizing', 'hedge', 'stop', 'filter', 'rule'];
  const title: Record<string, string> = { sizing: 'SIZING — VOLATILITY TARGETING AND VALUE AT RISK', hedge: 'DELTA HEDGE AGAINST BITCOIN', stop: 'STOPS', filter: 'FILTERS (REGIMES, TREND, VOLATILITY, VOLUME)', rule: 'ENTRY RULES (DRAWN EVENLY)' };
  return (
    <>
      <div className="lab-line muted">
        The mixing step is an adaptive search (the cross-entropy method): every ingredient starts with even odds, and after each batch of 40 mixes the odds move toward what the best quarter used, in sample. The out-of-sample columns are the finalists only — data the search never saw. An ingredient that scores well in sample but not out of it was luck.
      </div>
      {groups.map((g) => {
        const rs = rows.filter((r) => r.group === g).sort((a, b) => b.isWith - b.isWithout - (a.isWith - a.isWithout));
        if (!rs.length) return null;
        return (
          <div key={g}>
            <div className="pro-section">{title[g]}</div>
            <table className="pro-table compact">
              <thead>
                <tr>
                  <th className="l">INGREDIENT</th>
                  <th>TRIED</th>
                  <th title="Mean in-sample score of the mixes with it, and without it">IN SAMPLE WITH / WITHOUT</th>
                  <th title="The odds the search gave it at the end">FINAL ODDS</th>
                  <th title="Mean out-of-sample Sharpe of the finalists with it, and without it">OUT OF SAMPLE WITH / WITHOUT</th>
                  <th className="l">READING</th>
                </tr>
              </thead>
              <tbody>
                {rs.map((r) => {
                  const isLift = r.isWith - r.isWithout;
                  const oosLift = r.oosWith !== null && r.oosWithout !== null ? r.oosWith - r.oosWithout : null;
                  const reading = oosLift === null ? (isLift > 0 ? 'helped in sample; no finalist used it' : 'did not help in sample') : isLift > 0 && oosLift > 0 ? 'helped in and out of sample' : isLift <= 0 && oosLift > 0 ? 'helped only out of sample' : isLift > 0 ? 'helped in sample only — likely luck' : 'did not help';
                  return (
                    <tr key={r.option}>
                      <td className="l b">{r.option}</td>
                      <td className="mono">{r.tried}</td>
                      <td className={`mono ${isLift > 0 ? 'up' : 'down'}`}>
                        {num(r.isWith)} / {num(r.isWithout)}
                      </td>
                      <td className="mono">{pct(r.prob)}</td>
                      <td className={`mono ${oosLift === null ? 'muted' : oosLift > 0 ? 'up' : 'down'}`}>{r.oosWith !== null ? `${num(r.oosWith)} / ${r.oosWithout !== null ? num(r.oosWithout) : '—'} (${r.nOos})` : '—'}</td>
                      <td className="l muted">{reading}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

const HEAT = (x: number) => (x < 0.75 ? 'h-0' : x < 0.95 ? 'h-1' : x < 1.15 ? 'h-2' : x < 1.4 ? 'h-3' : x < 1.8 ? 'h-4' : 'h-5');

/** each coin's GARCH model and candle forecasts: fitted in sample, scored on the years they never saw */
function Forecasting({ reports, tfH }: { reports: ForecastReport[]; tfH: number }) {
  if (!reports.length) return <div className="pro-empty">This research ran before forecasting was added: run it again.</div>;
  return (
    <>
      <div className="lab-line muted">
        Volatility is forecastable, direction mostly is not. GARCH (Bollerslev 1986; GJR 1993 for the extra response to falls) is fitted on the in-sample years and scored on the out-of-sample ones against an exponentially weighted average and a rolling one (QLIKE loss, Patton 2011). The candle model forecasts the next candle's high, low and direction from its shape, GARCH and momentum, and is scored the same way. Both feed the Lab: GARCH σ is an input to every learned rule and the meta-labeller, sets GARCH stops, gates the GARCH regime filter, scales volatility-adjusted momentum, and drives the simulated worlds every leader must beat.
      </div>
      <table className="pro-table">
        <thead>
          <tr>
            <th className="l">COIN</th>
            <th className="l">MODEL</th>
            <th>α</th>
            <th>β</th>
            <th>γ</th>
            <th title="α + β + γ/2">PERSIST</th>
            <th>HALF-LIFE</th>
            <th>LONG RUN</th>
            <th>NEXT DAY</th>
            <th>NEXT WEEK</th>
            <th title="1 day, 99 %">VaR 99</th>
            <th title="Mean QLIKE loss out of sample: GARCH / EWMA / rolling (lower is better)">QLIKE G / E / R</th>
            <th title="Diebold–Mariano t, GARCH vs the better simple forecast (negative: GARCH better)">DM t</th>
            <th className="l">BEST</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((f) => (
            <tr key={f.coin}>
              <td className="l b">{f.coin}</td>
              <td className="l muted">{f.garch ? `${f.garch.kind}, ${f.garch.dist}` : 'no fit'}</td>
              <td className="mono">{f.garch ? f.garch.alpha.toFixed(3) : '—'}</td>
              <td className="mono">{f.garch ? f.garch.beta.toFixed(3) : '—'}</td>
              <td className="mono">{f.garch && f.garch.gamma ? f.garch.gamma.toFixed(3) : '—'}</td>
              <td className="mono">{f.garch ? f.garch.persistence.toFixed(3) : '—'}</td>
              <td className="mono">{f.garch && Number.isFinite(f.garch.halfLifeH) ? `${f.garch.halfLifeH.toFixed(0)}h` : '—'}</td>
              <td className="mono muted">{f.garch ? pct(f.garch.longRunAnn) : '—'}</td>
              <td className={`mono ${f.garch && f.garch.nextDayAnn > f.garch.longRunAnn * 1.15 ? 'down' : f.garch && f.garch.nextDayAnn < f.garch.longRunAnn * 0.85 ? 'up' : ''}`}>{f.garch ? pct(f.garch.nextDayAnn) : '—'}</td>
              <td className="mono">{f.garch ? pct(f.garch.nextWeekAnn) : '—'}</td>
              <td className="mono down">{f.garch ? pct(f.garch.var99Day, 1) : '—'}</td>
              <td className="mono">{f.test ? `${num(f.test.qlike.garch, 3)} / ${num(f.test.qlike.ewma, 3)} / ${num(f.test.qlike.rolling, 3)}` : '—'}</td>
              <td className={`mono ${f.test && f.test.dm < -2 ? 'up' : ''}`}>{f.test ? num(f.test.dm) : '—'}</td>
              <td className={`l ${f.test?.winner === 'GARCH' ? 'up' : 'muted'}`}>{f.test?.winner ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tfH < 24 && reports.some((f) => f.garch?.hours.length) && (
        <>
          <div className="pro-section">HOUR OF DAY (UTC) — VOLATILITY AGAINST THE DAY'S AVERAGE</div>
          <div className="gv-cal" style={{ gridTemplateColumns: '64px repeat(24, minmax(9px, 1fr))' }}>
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="gv-hh">
                {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
              </span>
            ))}
            {reports.map((f) => (
              <div key={f.coin} style={{ display: 'contents' }}>
                <span className="gv-coin">{f.coin}</span>
                {(f.garch?.hours.length ? f.garch.hours : Array<number>(24).fill(NaN)).map((x, h) => (
                  <i key={h} className={`gv-cell ${Number.isFinite(x) ? HEAT(x) : 'h-none'}`} title={`${f.coin} ${String(h).padStart(2, '0')}:00 UTC — ${Number.isFinite(x) ? `${x.toFixed(2)}× the average hour` : 'no data'}`} />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="pro-section">CANDLE FORECASTING — OUT OF SAMPLE</div>
      <table className="pro-table">
        <thead>
          <tr>
            <th className="l">COIN</th>
            <th>CANDLES</th>
            <th title="Share of next-candle directions called right">HIT</th>
            <th title="Always calling the commoner side">BASE</th>
            <th title="1 − Brier / Brier of the base rate: above 0 means the odds carry information">BRIER SKILL</th>
            <th title="Mean absolute error of the next candle's high-to-low range (log)">RANGE ERROR MODEL</th>
            <th>GARCH</th>
            <th title="The last candle's range">NAIVE</th>
            <th className="l">TOP DRIVERS (RANGE)</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((f) => {
            const e = f.candles?.eval;
            return (
              <tr key={f.coin}>
                <td className="l b">{f.coin}</td>
                <td className="mono">{e ? e.n : '—'}</td>
                <td className={`mono ${e && e.hit > e.base + 0.01 ? 'up' : ''}`}>{e ? pct(e.hit, 1) : '—'}</td>
                <td className="mono muted">{e ? pct(e.base, 1) : '—'}</td>
                <td className={`mono ${e && e.skill > 0 ? 'up' : 'down'}`}>{e ? pct(e.skill, 1) : '—'}</td>
                <td className={`mono ${e && e.rangeMae.model < Math.min(e.rangeMae.garch, e.rangeMae.naive) ? 'up' : ''}`}>{e ? pct(e.rangeMae.model, 3) : '—'}</td>
                <td className="mono muted">{e ? pct(e.rangeMae.garch, 3) : '—'}</td>
                <td className="mono muted">{e ? pct(e.rangeMae.naive, 3) : '—'}</td>
                <td className="l muted">
                  {e
                    ? [...e.importance]
                        .sort((a, b) => b.range - a.range)
                        .slice(0, 3)
                        .map((x) => x.feature)
                        .join(' · ')
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {reports[0]?.candles?.eval && (
        <div className="lab-grid2">
          <div>
            <div className="pro-section">{reports[0].coin} — WHAT DRIVES THE DIRECTION CALL</div>
            <Bars rows={[...reports[0].candles.eval.importance].sort((a, b) => b.dir - a.dir).slice(0, 10).map((x) => ({ label: x.feature, value: x.dir, tone: 'up' as const }))} format={(v) => v.toExponential(1)} />
          </div>
          <div>
            <div className="pro-section">{reports[0].coin} — WHAT DRIVES THE RANGE</div>
            <Bars rows={[...reports[0].candles.eval.importance].sort((a, b) => b.range - a.range).slice(0, 10).map((x) => ({ label: x.feature, value: x.range, tone: 'up' as const }))} format={(v) => `${(v * 1e4).toFixed(2)}bp`} />
          </div>
        </div>
      )}
      <div className="lab-line muted">
        Read the range columns first: a candle's size is forecastable (volatility clusters), its colour rarely is. A Brier skill near zero means the direction odds are close to a coin toss — the Lab then leans on the range forecast for stops and sizing, not on the direction call. The candle rule (“Next-candle forest”) and every learned rule are tested like any other strategy.
      </div>
    </>
  );
}

export function LabResearch() {
  const { status, result } = useLabLink();
  const [sel, setSel] = useState(1);
  const [view, setView] = useState<'top' | 'lib' | 'fcst' | 'learn'>('top');
  const [msg, setMsg] = useState('');
  if (!desktop?.lab) return <NeedsDesktop />;
  if (!status) return <div className="pro-empty">Connecting to the Lab…</div>;
  const r = result?.top.find((x) => x.rank === sel) ?? result?.top[0];
  const deploy = (targets: { crypto: boolean; meme: boolean }) =>
    void desktop!.lab
      .deploy({ rank: r!.rank }, targets)
      .then(() => setMsg(`Deployed “${r!.spec.name}” to the crypto swarm — it trades when the swarm runs.`))
      .catch((e) => setMsg(String(e?.message ?? e)));
  const p = status.progress;
  return (
    <div className="pro-panel">
      <ConfigBar cfg={status.cfg} running={status.running} />
      <FarmStrip onOpen={() => openFunction('labfarm', 'lab')} />
      {p && (
        <div className="lab-progress">
          <span>{p.stage}</span>
          <span className="pro-progress">
            <i style={{ width: `${Math.round((p.done / Math.max(1, p.total)) * 100)}%` }} />
          </span>
          <span className="mono">
            {p.done}/{p.total}
          </span>
        </div>
      )}
      {status.error && <div className="lab-error">{status.error}</div>}
      {msg && (
        <div className="lab-note" onClick={() => setMsg('')}>
          {msg}
        </div>
      )}
      <div className="pro-scroll">
        {!result ? (
          <div className="pro-empty">
            No research yet. Pick the coins, timeframe and years above and press <b>Run research</b>: the Lab downloads the history, tests every rule in the library, mixes the best with other papers' filters and exits, and ranks the top five on data none of them was chosen on.
          </div>
        ) : (
          <>
            <div className="lab-summary">
              <span>
                {new Date(result.at).toLocaleString()} · {result.markets.map((m) => `${m.coin} ${m.bars}`).join(' · ')} bars · {result.trials} strategies tried
              </span>
              <span title="Probability of backtest overfitting (Bailey et al. 2017): how often the in-sample best lands in the bottom half out of sample">PBO {result.pbo !== null ? pct(result.pbo) : '—'}</span>
              <span className="lab-tabs">
                {(
                  [
                    ['top', 'Top five'],
                    ['lib', 'Library comparison'],
                    ['learn', 'What it learned'],
                    ['fcst', 'Forecasting'],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} className={`btn ghost${view === v ? ' on' : ''}`} onClick={() => setView(v)}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
            {result.notes.map((n) => (
              <div key={n} className="lab-note">
                {n}
              </div>
            ))}
            {view === 'learn' ? (
              <LearnedView rows={result.learned ?? []} />
            ) : view === 'fcst' ? (
              <Forecasting reports={result.forecasting ?? []} tfH={result.tfH} />
            ) : view === 'lib' ? (
              <>
              <div className="lab-line muted">Each rule at its best published parameters, chosen in sample, then run on the out-of-sample years it never saw. * learned rules are fitted on the in-sample data, so only their out-of-sample numbers are a test.</div>
              <table className="pro-table">
                <thead>
                  <tr>
                    <th className="l">RULE (AS PUBLISHED)</th>
                    <th className="l">FAMILY</th>
                    <th>BEST PARAMS</th>
                    <th>IN SR</th>
                    <th>OUT SR</th>
                    <th>OUT t</th>
                    <th>OUT TRADES</th>
                  </tr>
                </thead>
                <tbody>
                  {result.library.map((l) => (
                    <tr key={l.id}>
                      <td className="l b">{l.name}</td>
                      <td className="l muted">{l.family}</td>
                      <td className="mono muted">{l.skipped ?? Object.entries(l.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                      <td className="mono" title={l.family === 'ml' ? 'Learned rules are fitted on the in-sample data: their in-sample Sharpe is not a test — read the out-of-sample one' : undefined}>
                        {l.is ? num(l.is.sharpe) : '—'}
                        {l.family === 'ml' && l.is ? '*' : ''}
                      </td>
                      <td className={`mono ${(l.oos?.sharpe ?? 0) > 0 ? 'up' : 'down'}`}>{l.oos ? num(l.oos.sharpe) : '—'}</td>
                      <td className="mono">{l.oos ? num(l.oos.t) : '—'}</td>
                      <td className="mono">{l.oos?.trades ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </>
            ) : (
              <>
                <table className="pro-table">
                  <thead>
                    <tr>
                      <th className="l">#</th>
                      <th className="l">STRATEGY</th>
                      <th className="l">VERDICT</th>
                      <th>OUT SR</th>
                      <th>t (NW)</th>
                      <th>DSR</th>
                      <th>TRADES</th>
                      <th>MAX DD</th>
                      <th>P(LOSS) MC</th>
                      <th>α t</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.top.map((t) => (
                      <tr key={t.rank} className={t.rank === r?.rank ? 'sel' : ''} onClick={() => setSel(t.rank)}>
                        <td className="l mono">{t.rank}</td>
                        <td className="l b">{t.spec.name}</td>
                        <td className="l">
                          <span className={`lab-verdict ${verdictCls(t.verdict)}`}>{t.verdict}</span>
                        </td>
                        <td className={`mono ${t.oos.sharpe > 0 ? 'up' : 'down'}`}>{num(t.oos.sharpe)}</td>
                        <td className="mono">{num(t.oos.t)}</td>
                        <td className="mono">{pct(t.dsr)}</td>
                        <td className="mono">{t.oos.trades}</td>
                        <td className="mono down">{pct(t.oos.maxDD, 1)}</td>
                        <td className="mono">{t.mc ? pct(t.mc.pLoss) : '—'}</td>
                        <td className="mono">{num(t.reg.tAlpha)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r && <Detail r={r} tfH={result.tfH} onDeploy={deploy} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- BT ----------

export interface BuilderConfig {
  spec: StrategySpec;
}
const firstOf = (g: Record<string, number[]>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v[0]]));
export const BUILDER_DEFAULTS: BuilderConfig = {
  spec: { name: 'Time-series momentum', signal: { id: 'tsmom', p: { lookback: 168 } }, filters: [], exit: { ...EXIT_DEFAULT, stopAtr: 3, maxBars: 336 }, sides: 'both' },
};

export function LabBuilder({ config: c, setConfig }: PanelProps<BuilderConfig>) {
  const { status } = useLabLink();
  const [res, setRes] = useState<LabTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const s = c.spec;
  const tfH = status ? ({ '1m': 1 / 60, '5m': 1 / 12, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 } as const)[status.cfg.timeframe] : 1;
  const set = (patch: Partial<StrategySpec>) => {
    const next = { ...s, ...patch };
    setConfig({ spec: { ...next, name: nameOf(next) } });
    setRes(null);
  };
  const sig = SIGNAL_MAP[s.signal.id];
  const rules = useMemo(() => rulesOf(s, tfH), [s, tfH]);
  if (!desktop?.lab) return <NeedsDesktop />;
  const test = () => {
    setBusy(true);
    setErr('');
    desktop!.lab
      .test(s)
      .then(setRes)
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const exitSet = (p: Partial<ExitSpec>) => set({ exit: { ...s.exit, ...p } });
  return (
    <div className="pro-panel">
      <Toolbar>
        <b className="pro-title">{s.name}</b>
        <Spacer />
        <button className="btn" disabled={busy} onClick={test}>
          {busy ? 'Testing…' : '▶ Backtest'}
        </button>
        <button className="btn ghost" disabled={!res} onClick={() => void desktop!.lab.deploy({ spec: s, tfH, stats: res ? { sharpe: res.oos.sharpe, t: res.oos.t, dsr: res.oos.psr, trades: res.oos.trades, verdict: 'hand-built' } : undefined }, { crypto: true, meme: false }).then(() => setErr('Deployed to the crypto swarm.'))} title="Backtest first">
          Deploy → Crypto swarm
        </button>
      </Toolbar>
      <div className="pro-scroll lab-builder">
        <div className="lab-form">
          <label>
            ENTRY
            <Select value={s.signal.id} options={SIGNALS.map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => set({ signal: { id, p: firstOf(SIGNAL_MAP[id].grid) }, exit: { ...EXIT_DEFAULT, ...SIGNAL_MAP[id].exit, maxBars: Math.round((SIGNAL_MAP[id].exit.maxBars ?? 240) / tfH) } })} />
          </label>
          {Object.entries(sig.grid).map(([k, vs]) => (
            <label key={k}>
              {k.toUpperCase()}
              <Select value={s.signal.p[k] ?? vs[0]} options={vs.map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ signal: { ...s.signal, p: { ...s.signal.p, [k]: v } } })} />
            </label>
          ))}
          <label>
            SIDES
            <Select value={s.sides} options={[{ value: 'both', label: 'Long + short' }, { value: 'long', label: 'Long only' }, { value: 'short', label: 'Short only' }]} onChange={(sides) => set({ sides })} />
          </label>
          {[0, 1].map((k) => {
            const f = s.filters[k];
            return (
              <label key={k}>
                FILTER {k + 1}
                <Select
                  value={f?.id ?? 'none'}
                  options={[{ value: 'none', label: 'None' }, ...FILTERS.map((x) => ({ value: x.id, label: x.name }))]}
                  onChange={(id) => {
                    const fs = [...s.filters];
                    if (id === 'none') fs.splice(k, 1);
                    else fs[k] = { id, p: firstOf(FILTER_MAP[id].grid) };
                    set({ filters: fs.filter(Boolean) });
                  }}
                />
                {f &&
                  Object.entries(FILTER_MAP[f.id].grid).map(([pk, vs]) => (
                    <Select key={pk} value={f.p[pk] ?? vs[0]} options={vs.map((v) => ({ value: v, label: `${pk} ${v}` }))} onChange={(v) => set({ filters: s.filters.map((x, i) => (i === k ? { ...x, p: { ...x.p, [pk]: v } } : x)) })} />
                  ))}
              </label>
            );
          })}
          <label>
            STOP (ATR)
            <NumberInput value={s.exit.stopAtr} step={0.5} min={0.5} onChange={(stopAtr) => exitSet({ stopAtr })} />
          </label>
          <label title="Stop in GARCH forecast volatility instead of ATR: the stop widens before volatility arrives, not after. 0 uses the ATR stop.">
            GARCH STOP (σ, 0 = ATR)
            <NumberInput value={s.exit.stopVol ?? 0} step={0.5} min={0} onChange={(stopVol) => exitSet({ stopVol })} />
          </label>
          <label>
            TARGET (R, 0 none)
            <NumberInput value={s.exit.targetR} step={0.5} min={0} onChange={(targetR) => exitSet({ targetR })} />
          </label>
          <label>
            TRAIL (ATR, 0 none)
            <NumberInput value={s.exit.trailAtr} step={0.5} min={0} onChange={(trailAtr) => exitSet({ trailAtr })} />
          </label>
          <label>
            HOLD (BARS)
            <NumberInput value={s.exit.maxBars} step={1} min={1} onChange={(maxBars) => exitSet({ maxBars })} />
          </label>
          <label className="row">
            <Check checked={s.exit.onFlip} onChange={(onFlip) => exitSet({ onFlip })}>
              An opposite signal closes it
            </Check>
          </label>
          <label title="Unit: a fixed position. Volatility target: run the position at an annual volatility on the GARCH forecast (Moreira & Muir 2017). VaR budget: hold a day's 99 % GARCH value at risk to a share of capital.">
            SIZING
            <Select
              value={s.sizing?.mode ?? 'unit'}
              options={[
                { value: 'unit', label: 'Unit size' },
                { value: 'vol', label: 'Volatility target' },
                { value: 'var', label: 'VaR budget' },
              ]}
              onChange={(mode) => set({ sizing: mode === 'unit' ? undefined : { mode, target: mode === 'vol' ? 0.6 : 0.05 } })}
            />
          </label>
          {s.sizing && s.sizing.mode !== 'unit' && (
            <label>
              {s.sizing.mode === 'vol' ? 'TARGET VOL (% A YEAR)' : 'DAILY VaR 99 (% OF CAPITAL)'}
              <NumberInput value={Math.round(s.sizing.target * 100)} step={s.sizing.mode === 'vol' ? 10 : 1} min={1} onChange={(v) => set({ sizing: { mode: s.sizing!.mode, target: v / 100 } })} />
            </label>
          )}
          <label className="row" title="Short β × the position in bitcoin, so the result is the coin's own move. Needs BTC among the coins. The swarm does not place the hedge leg.">
            <Check checked={s.hedge === 'btc'} onChange={(on) => set({ hedge: on ? 'btc' : undefined })}>
              Delta-hedge against bitcoin
            </Check>
          </label>
        </div>
        <div className="pro-section">THE STRATEGY IN WORDS</div>
        {rules.map((x) => (
          <div key={x} className="lab-line">
            {x}
          </div>
        ))}
        <div className="lab-line muted">{sig.rationale}</div>
        {err && <div className="lab-note">{err}</div>}
        {res && (
          <>
            <div className="pro-section">RESULT — {status?.cfg.coins.join(', ')} · {status?.cfg.timeframe}</div>
            <table className="pro-table compact">
              <thead>
                <tr>
                  <th className="l" />
                  <th>SHARPE</th>
                  <th>CAGR</th>
                  <th>MAX DD</th>
                  <th>TRADES</th>
                  <th>WIN</th>
                  <th>t</th>
                  <th>PSR</th>
                </tr>
              </thead>
              <tbody>
                {(['is', 'oos'] as const).map((k) => (
                  <tr key={k}>
                    <td className="l b">{k === 'is' ? 'IN' : 'OUT'}</td>
                    <td className="mono">{num(res[k].sharpe)}</td>
                    <td className={`mono ${res[k].cagr >= 0 ? 'up' : 'down'}`}>{pct(res[k].cagr, 1)}</td>
                    <td className="mono down">{pct(res[k].maxDD, 1)}</td>
                    <td className="mono">{res[k].trades}</td>
                    <td className="mono">{pct(res[k].winRate)}</td>
                    <td className="mono">{num(res[k].t)}</td>
                    <td className="mono">{pct(res[k].psr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <LineChart series={[{ values: res.curve.map((p) => p.bh), color: 'var(--faint)', dash: '3 3' }, { values: res.curve.map((p) => p.eq), color: 'var(--pro-accent, var(--accent))', width: 1.8 }]} marker={Math.floor(res.curve.length * (status?.cfg.isShare ?? 0.7))} />
            {res.mc && <Fan fan={res.mc.fan} />}
            <div className="lab-line muted">One hand-built test is one trial: its probabilistic Sharpe (PSR) is not deflated for the other strategies you try here. The Research screen corrects for that.</div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- DEPL ----------

/** each deployed strategy's health (electron/care/health.mjs), fetched every minute */
function useHealth(n: number) {
  const [h, setH] = useState<Record<string, StrategyHealth>>({});
  useEffect(() => {
    if (!desktop?.care) return;
    let live = true;
    const load = () => void desktop!.care.health().then((xs) => live && setH(Object.fromEntries(xs.map((x) => [x.id, x])))).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [n]);
  return h;
}

const HEALTH_WORD: Record<StrategyHealth['status'], string> = { early: 'too early', ok: 'on track', behind: 'behind its test', stopped: 'may have stopped working', quiet: 'quiet' };
function HealthBadge({ h }: { h?: StrategyHealth }) {
  if (!h) return <span className="muted">—</span>;
  return (
    <span className={`health-badge health-${h.status}`} title={h.words}>
      {HEALTH_WORD[h.status]}
      <span className="muted">
        {' '}
        · {h.trades} trade{h.trades === 1 ? '' : 's'}
        {h.winRate !== null ? `, ${Math.round(h.winRate * 100)}% won` : ''}
        {h.tested.winRate !== null ? ` (test ${Math.round(h.tested.winRate * 100)}%)` : ''}
      </span>
    </span>
  );
}

export function LabDeployed() {
  const { status } = useLabLink();
  const lines = useCSwarm((s) => s.lines);
  if (!desktop?.lab) return <NeedsDesktop />;
  const L = desktop.lab;
  const dep = status?.deployed ?? [];
  const said = lines.filter((l) => l.agent === 'lab').slice(-30).reverse();
  const health = useHealth(dep.length);
  return (
    <div className="pro-panel">
      <div className="pro-scroll">
        <table className="pro-table">
          <thead>
            <tr>
              <th className="l">ON</th>
              <th className="l">STRATEGY</th>
              <th className="l">WHERE</th>
              <th>TF</th>
              <th className="l">COINS</th>
              <th>SR</th>
              <th>t</th>
              <th className="l">VERDICT</th>
              <th className="l" title="Its real trades since it was deployed, against what its test promised">HEALTH</th>
              <th className="l" title="Who decides its trades: the swarm's council, or the strategy as tested (only Guardian and Risk can stop it)">WHO DECIDES</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {dep.map((d) => (
              <tr key={d.id}>
                <td className="l">
                  <input type="checkbox" checked={d.on} onChange={(e) => void L.toggle(d.id, e.target.checked)} />
                </td>
                <td className="l b" title={rulesOf(d.spec, d.tfH).join('\n')}>
                  {d.name}
                </td>
                <td className="l">{d.targets.crypto ? 'Crypto swarm' : 'Meme swarm (retired: not trading)'}</td>
                <td className="mono">{d.tfH < 1 ? `${Math.round(d.tfH * 60)}m` : `${d.tfH}h`}</td>
                <td className="l mono">{d.coins.join(' ')}</td>
                <td className="mono">{num(d.stats.sharpe)}</td>
                <td className="mono">{num(d.stats.t)}</td>
                <td className="l">
                  <span className={`lab-verdict ${verdictCls(d.stats.verdict)}`}>{d.stats.verdict}</span>
                </td>
                <td className="l" data-health={health[d.id]?.status ?? 'none'}>
                  <HealthBadge h={health[d.id]} />
                  <div className="muted" data-size={Number.isFinite(d.scale) && d.scale! < 1 ? 'probation' : 'full'}>
                    {!d.on && d.pausedBy === 'health'
                      ? '⏸ paused by the health check (see Telegram)'
                      : Number.isFinite(d.scale) && d.scale! < 1
                        ? `on probation · ¼ size${d.probation?.why ? ` (${d.probation.why})` : ' until 12 live trades are on track'}`
                        : d.graduatedAt
                          ? 'full size · earned on live trades'
                          : 'full size'}
                    {d.retunedAt ? ` · re-tuned ${new Date(d.retunedAt).toISOString().slice(0, 10)}` : ''}
                  </div>
                </td>
                <td className="l">
                  <AuthoritySwitch d={d} compact />
                  <div>
                    <LabBookLine d={d} />
                  </div>
                </td>
                <td>
                  <button className="btn ghost" onClick={() => confirm(`Remove “${d.name}” from the swarm? An open trade it took stays open and is managed by the default rules.`) && void L.undeploy(d.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!dep.length && <div className="pro-empty">Nothing deployed. Run research (RSCH) or build a strategy (BT) and deploy it.</div>}
        {status?.costs && (
          <div className="lab-line muted" data-costs>
            Costs in every test: {status.costs.feeBps} bps fees + {status.costs.slipBps} bps slippage a fill — {status.costs.why}.
          </div>
        )}
        <div className="lab-line muted">HEALTH compares each strategy's real trades (paper and live) since it was deployed with its test. A new deployment trades at ¼ size (probation) until 12 trades are on track; one that falls behind goes back to ¼; one that clearly stopped working is paused and you are asked on Telegram to resume or retire it.</div>
        <div className="pro-section">WHAT THE LAB AGENT HAS SAID</div>
        {said.map((l) => (
          <div key={l.t} className="lab-line mono">
            <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.text}
          </div>
        ))}
        {!said.length && <div className="lab-line muted">The Lab agent speaks when a deployed strategy signals while the crypto swarm runs.</div>}
      </div>
    </div>
  );
}
