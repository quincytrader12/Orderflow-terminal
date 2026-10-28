import { useState } from 'react';
import { fmtAgo, fmtNum, fmtTime, fmtUsd } from '../core/format';
import { desktop } from '../desktop/bridge';
import { curveProgress, PUMP_MCAP_SOL_END } from '../meme/pump';
import { scanner, useMeme } from '../meme/scanner';
import { assess } from '../meme/score';
import { devActivity, flow, stageOf, toGraduate, type MemeToken as Token } from '../meme/token';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Empty, Spacer, Toolbar, useTicker, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { useMemeScanner } from './MemeScanner';

export interface MemeTokenConfig {
  /** a mint pasted in by hand, when nothing is selected in the scanner */
  pinned: string;
}

export const MEME_TOKEN_DEFAULTS: MemeTokenConfig = { pinned: '' };

const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const open = (url: string) => (desktop ? void desktop.app.openExternal(url) : void window.open(url, '_blank', 'noopener'));
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

export function MemeToken({ config: c, setConfig }: PanelProps<MemeTokenConfig>) {
  useMemeScanner();
  useTicker(1000);
  useMeme((s) => s.version);
  const { tokens, selected, solUsd, select } = useMeme();
  const [paste, setPaste] = useState('');
  const mint = selected ?? (c.pinned || null);
  const tok = mint ? tokens[mint] : undefined;
  const now = Date.now();

  const toolbar = (
    <Toolbar>
      <input className="ctl mono" placeholder="Paste a mint address…" value={paste} onChange={(e) => setPaste(e.target.value.trim())} style={{ width: 230 }} />
      <button
        className="chip"
        disabled={!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(paste)}
        onClick={() => {
          setConfig({ pinned: paste });
          scanner.watchMint(paste);
          select(paste);
          setPaste('');
        }}
      >
        Open
      </button>
      <Spacer />
      {tok && <span className="muted mono">{short(tok.mint)}</span>}
    </Toolbar>
  );
  if (!tok)
    return (
      <div className="panel meme">
        {toolbar}
        <Empty>{mint ? 'Loading this coin…' : 'Pick a coin in the Meme Scanner, or paste a mint address.'}</Empty>
      </div>
    );

  const a = assess(tok, now, solUsd);
  const stage = stageOf(tok);
  const p = curveProgress(tok.vTokens);
  const f1 = flow(tok, now, 60);
  const f5 = flow(tok, now, 300);
  const dev = devActivity(tok);
  const toGrad = toGraduate(tok);
  const s = tok.safety;
  const links: { label: string; url: string }[] = [
    ...(tok.source === 'pump' ? [{ label: 'pump.fun', url: `https://pump.fun/coin/${tok.mint}` }] : []),
    { label: 'DexScreener', url: tok.dex?.url || `https://dexscreener.com/solana/${tok.mint}` },
    { label: 'Solscan', url: `https://solscan.io/token/${tok.mint}` },
    ...(tok.dex?.socials ?? []).slice(0, 4).map((x) => ({ label: x.type, url: x.url })),
  ];
  const check = (ok: boolean | null, good: string, bad: string) => (
    <div className={`meme-check ${ok === null ? '' : ok ? 'up' : 'down'}`}>
      {ok === null ? '·' : ok ? '✓' : '✗'} {ok === false ? bad : good}
    </div>
  );

  return (
    <div className="panel meme">
      {toolbar}
      <div className="scroll meme-detail">
        <div className="meme-head">
          {tok.image ? <img className="meme-img big" src={tok.image} alt="" /> : <span className="meme-img big ph">{tok.symbol.slice(0, 2)}</span>}
          <div>
            <div className="meme-title">
              <b>{tok.symbol}</b> <span className="muted">{tok.name}</span> <span className="meme-tag">{stage === 'new' ? 'on the curve' : stage === 'final' ? 'final stretch' : tok.dex?.dexId || 'migrated'}</span>
            </div>
            <div className="meme-links">
              {links.map((l) => (
                <a key={l.label + l.url} onClick={() => open(l.url)}>
                  {l.label}
                </a>
              ))}
              <a onClick={() => void navigator.clipboard?.writeText(tok.mint)}>copy mint</a>
            </div>
          </div>
          <Spacer />
          <span className={`meme-heat big ${a.heat >= 70 ? 'hot' : a.heat >= 40 ? 'warm' : 'cold'}`} title="Heat: how strong the buying is (0–100)">
            {a.heat}
          </span>
        </div>

        <div className="stats meme-stats">
          <div className="stat">
            <div className="k">Market cap</div>
            <div className="v">{Number.isFinite(a.mcapUsd) ? fmtUsd(a.mcapUsd, 1) : '—'}</div>
            <div className="s">{fmtNum(tok.mcapSol, 1)} SOL</div>
          </div>
          <div className="stat">
            <div className="k">Age</div>
            <div className="v">{fmtAgo(tok.source === 'dex' && tok.dex?.pairCreatedAt ? tok.dex.pairCreatedAt : tok.createdAt, now)}</div>
            <div className="s">{tok.source === 'pump' ? 'since launch' : 'since the pool opened'}</div>
          </div>
          {stage !== 'migrated' ? (
            <div className="stat">
              <div className="k">Bonding curve</div>
              <div className="v">{Math.round(p * 100)}%</div>
              <div className="s">{toGrad !== null && Number.isFinite(toGrad) ? `${toGrad.toFixed(1)}× to graduate (~${fmtNum(PUMP_MCAP_SOL_END, 0)} SOL)` : ''}</div>
            </div>
          ) : (
            <div className="stat">
              <div className="k">Liquidity</div>
              <div className="v">{tok.dex ? fmtUsd(tok.dex.liquidityUsd, 1) : '—'}</div>
              <div className="s">{tok.dex ? `vol 1h ${fmtUsd(tok.dex.volume.h1, 1)}` : 'waiting for the pool on DexScreener'}</div>
            </div>
          )}
          <div className="stat">
            <div className="k">5 min flow</div>
            <div className={`v ${f5.netSol >= 0 ? 'up' : 'down'}`}>
              {f5.netSol >= 0 ? '+' : ''}
              {f5.netSol.toFixed(2)} SOL
            </div>
            <div className="s">
              {f5.buys} buys · {f5.sells} sells · {f5.buyers} wallets
            </div>
          </div>
        </div>
        {stage !== 'migrated' && (
          <div className="meme-curve big">
            <i style={{ width: `${p * 100}%` }} />
          </div>
        )}

        <div className="meme-summary">{a.summary || 'Reading the first trades…'}</div>
        {a.flags.length > 0 && (
          <div className="meme-flags">
            {a.flags.map((f) => (
              <div key={f.text} className={`meme-flagline ${f.level}`}>
                {f.level === 'danger' ? '⛔' : f.level === 'warn' ? '⚠' : 'ℹ'} {f.text}
              </div>
            ))}
          </div>
        )}

        <div className="meme-grid2">
          <div>
            <div className="section-title">Safety (on-chain)</div>
            {s ? (
              <>
                {check(s.mintRevoked, 'Mint authority revoked', 'Mint authority NOT revoked')}
                {check(s.freezeRevoked, 'Freeze authority revoked', 'Freeze authority NOT revoked')}
                {check(s.top10 === null ? null : s.top10 <= 0.3, `Top 10 holders ${pct(s.top10)}`, `Top 10 holders ${pct(s.top10)}`)}
                {check(s.top1 === null ? null : s.top1 <= 0.15, `Largest holder ${pct(s.top1)}`, `Largest holder ${pct(s.top1)}`)}
                <div className="muted">{s.error ? `Check failed: ${s.error}` : `checked ${fmtAgo(s.checkedAt, now)} ago · curve and pool excluded`}</div>
              </>
            ) : (
              <div className="muted">Checking on-chain…</div>
            )}
          </div>
          <div>
            <div className="section-title">Order flow</div>
            <FlowBar label="1 min" buy={f1.buySol} sell={f1.sellSol} />
            <FlowBar label="5 min" buy={f5.buySol} sell={f5.sellSol} />
            <div className="muted">
              top buyer {pct(f5.buys ? f5.topBuyerShare : null)} of 5 min buys · {f5.churners} bought & sold
            </div>
            {tok.source === 'pump' && (
              <div className={dev.sold ? 'down' : 'muted'}>
                Creator {short(tok.creator ?? '')}: bought {tok.devInitialSol.toFixed(2)} SOL at launch · {dev.sold ? `sold ${pct(dev.soldShare)}` : 'still holding'}
              </div>
            )}
          </div>
        </div>

        {tok.trades.length > 1 && (
          <div className="meme-chart">
            <Canvas draw={(d) => drawTrades(d, tok)} fps={4} />
          </div>
        )}

        <div className="section-title">
          Trades <span className="muted">{tok.source === 'pump' || tok.migrated ? 'live from pump.fun' : 'not streamed for this pool yet'}</span>
        </div>
        <table className="grid meme-tape">
          <tbody>
            {tok.trades
              .slice(-80)
              .reverse()
              .map((tr) => (
                <tr key={tr.signature + tr.t} className={tr.side === 'buy' ? 'up' : 'down'}>
                  <td className="mono muted">{fmtTime(tr.t)}</td>
                  <td>{tr.side === 'buy' ? 'BUY' : 'SELL'}</td>
                  <td className="mono">{tr.sol.toFixed(3)} SOL</td>
                  <td className="mono muted">{Number.isFinite(solUsd * tr.mcapSol) && solUsd > 0 ? fmtUsd(solUsd * tr.mcapSol, 1) : `${fmtNum(tr.mcapSol, 1)} SOL`}</td>
                  <td className="mono muted">
                    {short(tr.wallet)} {tr.dev && <span className="meme-tag dev">DEV</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>

        <div className="meme-trade-soon muted">Buying and selling with Phantom comes in the next step.</div>
      </div>
    </div>
  );
}

function FlowBar({ label, buy, sell }: { label: string; buy: number; sell: number }) {
  const tot = buy + sell || 1;
  return (
    <div className="meme-flowbar">
      <span className="muted">{label}</span>
      <div className="bar-split">
        <i className="buy" style={{ width: `${(buy / tot) * 100}%` }} />
        <i className="sell" style={{ width: `${(sell / tot) * 100}%` }} />
      </div>
      <span className="mono">
        <span className="up">{buy.toFixed(2)}</span> / <span className="down">{sell.toFixed(2)}</span> SOL
      </span>
    </div>
  );
}

/** Market cap over the coin's trades, a bubble per trade sized by SOL. */
function drawTrades({ ctx, w, h, pal }: DrawContext, tok: Token) {
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  const tr = tok.trades.slice(-300);
  if (tr.length < 2) return;
  const t0 = tr[0].t;
  const t1 = Math.max(tr[tr.length - 1].t, t0 + 1);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of tr) {
    lo = Math.min(lo, x.mcapSol);
    hi = Math.max(hi, x.mcapSol);
  }
  const pad = (hi - lo) * 0.1 || hi * 0.05 || 1;
  lo -= pad;
  hi += pad;
  const L = 8;
  const R = w - 64;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const Y = (v: number) => h - 14 - ((v - lo) / (hi - lo)) * (h - 24);
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  tr.forEach((x, i) => (i ? ctx.lineTo(X(x.t), Y(x.mcapSol)) : ctx.moveTo(X(x.t), Y(x.mcapSol))));
  ctx.stroke();
  const maxSol = Math.max(...tr.map((x) => x.sol), 1e-9);
  for (const x of tr) {
    ctx.fillStyle = rgba(x.side === 'buy' ? pal.buyRgb : pal.sellRgb, x.dev ? 0.95 : 0.55);
    ctx.beginPath();
    ctx.arc(X(x.t), Y(x.mcapSol), 2 + 8 * Math.sqrt(x.sol / maxSol), 0, Math.PI * 2);
    ctx.fill();
  }
  line(ctx, R + 4, 4, R + 4, h - 10, pal.grid);
  ctx.fillStyle = pal.muted;
  ctx.font = font(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${fmtNum(hi - pad, 1)} SOL`, R + 8, Y(hi - pad));
  ctx.fillText(`${fmtNum(lo + pad, 1)} SOL`, R + 8, Y(lo + pad));
  ctx.textBaseline = 'bottom';
  ctx.fillText(fmtTime(t0, false), L, h);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTime(t1, false), R, h);
}
