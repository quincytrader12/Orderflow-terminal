import { useEffect, useMemo, useState } from 'react';
import { fmtAgo, fmtNum, fmtUsd } from '../core/format';
import { scanner, useMeme } from '../meme/scanner';
import { assess, roomTo, type Assessment } from '../meme/score';
import { curveProgress } from '../meme/pump';
import { flow, stageOf, type MemeStage, type MemeToken } from '../meme/token';
import { Check, Chip, Empty, NumberInput, Select, Spacer, Toolbar, useTicker, type PanelProps } from '../ui/controls';

export interface MemeScannerConfig {
  view: 'pulse' | 'runners';
  minHeat: number;
  hideDanger: boolean;
  /** your target market cap (USD) and the room you want to it */
  targetUsd: number;
  minRoom: number;
}

export const MEME_SCANNER_DEFAULTS: MemeScannerConfig = { view: 'pulse', minHeat: 0, hideDanger: true, targetUsd: 1_000_000, minRoom: 0 };

const COLUMNS: { stage: MemeStage; title: string; hint: string }[] = [
  { stage: 'new', title: 'New', hint: 'just launched on the pump.fun curve' },
  { stage: 'final', title: 'Final stretch', hint: '70 %+ of the curve sold — close to graduating' },
  { stage: 'migrated', title: 'Migrated', hint: 'graduated to a pool, or listed on DexScreener' },
];

interface Row {
  tok: MemeToken;
  a: Assessment;
  stage: MemeStage;
  room: number;
}

export function useMemeScanner() {
  useEffect(() => scanner.use(), []);
}

export function MemeScanner({ config: c, setConfig }: PanelProps<MemeScannerConfig>) {
  useMemeScanner();
  useTicker(1000);
  const version = useMeme((s) => s.version);
  const { tokens, solUsd, feed, selected, select } = useMeme();
  const [q, setQ] = useState('');
  const now = Date.now();

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const tok of Object.values(tokens)) {
      const a = assess(tok, now, solUsd);
      const room = roomTo(a.mcapUsd, c.targetUsd);
      if (a.heat < c.minHeat) continue;
      if (c.hideDanger && a.flags.some((f) => f.level === 'danger')) continue;
      if (c.minRoom > 0 && !(room >= c.minRoom)) continue;
      if (q && !`${tok.symbol} ${tok.name} ${tok.mint}`.toLowerCase().includes(q.toLowerCase())) continue;
      out.push({ tok, a, stage: stageOf(tok), room });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, Math.floor(now / 2000), solUsd, c.minHeat, c.hideDanger, c.minRoom, c.targetUsd, q]);

  const dot = (s: string) => <span className={`meme-dot ${s === 'open' ? 'ok' : s.startsWith('error') ? 'bad' : ''}`} title={s} />;

  return (
    <div className="panel meme">
      <Toolbar>
        <Chip active={c.view === 'pulse'} onClick={() => setConfig({ view: 'pulse' })}>
          Pulse
        </Chip>
        <Chip active={c.view === 'runners'} onClick={() => setConfig({ view: 'runners' })}>
          Runners
        </Chip>
        <input className="ctl" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 90 }} />
        <NumberInput value={c.minHeat} onChange={(minHeat) => setConfig({ minHeat })} width={60} min={0} step={10} suffix="min heat" title="Only coins at least this hot (0–100)" />
        <Select
          value={c.minRoom}
          options={[0, 5, 10, 100, 1000].map((v) => ({ value: v, label: v ? `${v}× room` : 'any room' }))}
          onChange={(minRoom) => setConfig({ minRoom })}
        />
        <NumberInput value={c.targetUsd} onChange={(targetUsd) => setConfig({ targetUsd })} width={84} min={1000} step={100000} suffix="$ target" title="Room = this market cap ÷ the coin's market cap now — your target, not a prediction" />
        <Check checked={c.hideDanger} onChange={(hideDanger) => setConfig({ hideDanger })}>
          hide ⛔
        </Check>
        <Spacer />
        <span className="muted meme-feeds">
          {dot(feed.pump)} pump {dot(feed.dex)} dex {dot(feed.rpc)} rpc · SOL {solUsd > 0 ? fmtUsd(solUsd, 2) : '—'}
        </span>
      </Toolbar>
      {c.view === 'pulse' ? (
        <div className="meme-pulse">
          {COLUMNS.map((col) => {
            const list = rows.filter((r) => r.stage === col.stage).sort((x, y) => (col.stage === 'new' ? y.tok.createdAt - x.tok.createdAt : y.a.heat - x.a.heat));
            return (
              <div key={col.stage} className="meme-col">
                <div className="meme-col-head" title={col.hint}>
                  {col.title} <span className="muted">{list.length}</span>
                </div>
                <div className="scroll">
                  {list.length ? list.slice(0, 80).map((r) => <Card key={r.tok.mint} r={r} now={now} active={selected === r.tok.mint} onClick={() => select(r.tok.mint)} />) : <Empty>{feed.pump === 'open' || feed.dex === 'open' ? 'Waiting for coins…' : 'Connecting…'}</Empty>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Runners rows={rows} now={now} selected={selected} onSelect={select} />
      )}
    </div>
  );
}

function heatClass(h: number) {
  return h >= 70 ? 'hot' : h >= 40 ? 'warm' : 'cold';
}

function FlagIcon({ a }: { a: Assessment }) {
  const d = a.flags.find((f) => f.level === 'danger');
  const w = a.flags.find((f) => f.level === 'warn');
  if (d) return <span className="meme-flag danger" title={a.flags.map((f) => f.text).join('\n')}>⛔</span>;
  if (w) return <span className="meme-flag warn" title={a.flags.map((f) => f.text).join('\n')}>⚠</span>;
  return null;
}

function Card({ r, now, active, onClick }: { r: Row; now: number; active: boolean; onClick: () => void }) {
  const { tok, a } = r;
  const f5 = flow(tok, now, 300);
  const p = curveProgress(tok.vTokens);
  return (
    <div className={`meme-card ${active ? 'active' : ''}`} onClick={onClick} title={a.summary}>
      <div className="meme-card-top">
        {tok.image ? <img className="meme-img" src={tok.image} alt="" /> : <span className="meme-img ph">{tok.symbol.slice(0, 2)}</span>}
        <div className="meme-id">
          <b>{tok.symbol || '—'}</b> <span className="muted">{tok.name}</span>
          <div className="muted mono">
            {fmtAgo(tok.dex?.pairCreatedAt && tok.source === 'dex' ? tok.dex.pairCreatedAt : tok.createdAt, now)} · MC {Number.isFinite(a.mcapUsd) ? fmtUsd(a.mcapUsd, 1) : `${fmtNum(tok.mcapSol, 1)} SOL`}
            {tok.dex ? ` · liq ${fmtUsd(tok.dex.liquidityUsd, 1)}` : ''}
          </div>
        </div>
        <FlagIcon a={a} />
        <span className={`meme-heat ${heatClass(a.heat)}`} title="Heat: how strong the buying is (0–100)">
          {a.heat}
        </span>
      </div>
      {r.stage !== 'migrated' && (
        <div className="meme-curve" title={`Curve ${Math.round(p * 100)} % sold`}>
          <i style={{ width: `${p * 100}%` }} />
        </div>
      )}
      <div className="meme-card-bot mono">
        {tok.source === 'pump' && !tok.migrated ? (
          <>
            <span>{f5.buyers} buyers</span>
            <span className={f5.netSol >= 0 ? 'up' : 'down'}>
              {f5.netSol >= 0 ? '+' : ''}
              {f5.netSol.toFixed(1)} SOL
            </span>
          </>
        ) : tok.dex ? (
          <>
            <span>
              {tok.dex.txns.m5.buys}/{tok.dex.txns.m5.sells} 5m
            </span>
            <span className={tok.dex.change.m5 >= 0 ? 'up' : 'down'}>{tok.dex.change.m5.toFixed(0)}% 5m</span>
          </>
        ) : null}
        {Number.isFinite(r.room) && <span title="Room to your target market cap">{r.room >= 10 ? Math.round(r.room) : r.room.toFixed(1)}× room</span>}
        {a.tags.slice(0, 2).map((t) => (
          <span key={t} className="meme-tag">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Runners({ rows, now, selected, onSelect }: { rows: Row[]; now: number; selected: string | null; onSelect: (m: string) => void }) {
  const sorted = [...rows].sort((a, b) => b.a.heat - a.a.heat).slice(0, 150);
  if (!sorted.length) return <Empty>No coins match the filters yet.</Empty>;
  return (
    <div className="scroll">
      <table className="grid meme-table">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Stage</th>
            <th>Age</th>
            <th>Mkt cap</th>
            <th>Liq</th>
            <th>5m flow</th>
            <th>Heat</th>
            <th>Room</th>
            <th>Read</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ tok, a, stage, room }) => {
            const f5 = flow(tok, now, 300);
            return (
              <tr key={tok.mint} className={selected === tok.mint ? 'sel' : ''} onClick={() => onSelect(tok.mint)}>
                <td>
                  <b>{tok.symbol}</b> <FlagIcon a={a} />
                </td>
                <td className="muted">{stage === 'new' ? `curve ${Math.round(curveProgress(tok.vTokens) * 100)}%` : stage === 'final' ? `final ${Math.round(curveProgress(tok.vTokens) * 100)}%` : tok.dex?.dexId || tok.pool}</td>
                <td className="mono">{fmtAgo(tok.dex?.pairCreatedAt && tok.source === 'dex' ? tok.dex.pairCreatedAt : tok.createdAt, now)}</td>
                <td className="mono">{Number.isFinite(a.mcapUsd) ? fmtUsd(a.mcapUsd, 1) : '—'}</td>
                <td className="mono">{tok.dex ? fmtUsd(tok.dex.liquidityUsd, 1) : 'curve'}</td>
                <td className="mono">
                  {tok.source === 'pump' && f5.buys + f5.sells ? (
                    <span className={f5.netSol >= 0 ? 'up' : 'down'}>
                      {f5.netSol >= 0 ? '+' : ''}
                      {f5.netSol.toFixed(1)} SOL · {f5.buyers}w
                    </span>
                  ) : tok.dex ? (
                    `${fmtUsd(tok.dex.volume.m5, 1)} · ${tok.dex.txns.m5.buys}/${tok.dex.txns.m5.sells}`
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <span className={`meme-heat ${heatClass(a.heat)}`}>{a.heat}</span>
                </td>
                <td className="mono">{Number.isFinite(room) ? `${room >= 10 ? Math.round(room) : room.toFixed(1)}×` : '—'}</td>
                <td className="muted meme-read">{a.tags.join(' · ') || a.summary}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
