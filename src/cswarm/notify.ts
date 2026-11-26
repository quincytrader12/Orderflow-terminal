// The crypto swarm on the phone: three messages per trade, each with a picture
// of the chart it trades on.
//   1. the setup    — what it is taking, where, why, what it can make, the council's votes
//   2. managing     — the decisions it has made since (break-even, trail, holding)
//   3. the result   — profit in green or loss in red, the breakdown and the reasoning
import type { CSwarmNotify, CSwarmPosition } from '../desktop/bridge';
import { desktop } from '../desktop/bridge';
import { escapeHtml } from '../shared/telegram';
import { bullets, card, head, note, section, table } from '../shared/tgcard';
import { getSettings } from '../store/settings';
import { alertHere } from '../alerts/here';

const MARK = { for: '✓', against: '✗', abstain: '–', veto: '⛔' } as const;
const NAME: Record<string, string> = { scalper: 'Scalper', auction: 'Auctioneer', trend: 'Trend', tape: 'Tape', micro: 'Micro', crowd: 'Crowd', guardian: 'Guardian', forest: 'Forest', risk: 'Risk' };

export const px = (p: number | null | undefined) => {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  return p.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 4 : 6 });
};
export const usd = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const signedR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
const held = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`;
};

export function sideWord(p: Pick<CSwarmPosition, 'side'>) {
  return p.side === 'buy' ? 'LONG' : 'SHORT';
}

/** The text of each message (HTML for Telegram): the headline, the numbers in a table, then the reasoning. */
export function captionOf(n: CSwarmNotify): { title: string; html: string; short: string } {
  const p = n.position;
  const tag = n.mode === 'live' ? '<b>LIVE</b>' : 'paper';
  const who = `${p.agentName ?? NAME[p.agent] ?? p.agent} · ${tag}`;
  const rr = Math.abs(p.target - p.entry) / Math.max(1e-12, Math.abs(p.entry - p.stop0));
  const e = escapeHtml;
  const name = `${e(p.coin)} ${sideWord(p)}`;
  if (n.stage === 'setup') {
    const pot = p.potential ?? Math.abs(p.target - p.entry) * p.qty;
    const top = head('🔵', `${name} — taking it`, who);
    const nums = table([
      ['Entry', px(p.entry)],
      ['Stop', px(p.stop)],
      ['Target', px(p.target)],
      ['At risk', `${usd(p.riskUsd)} · ${p.riskPct.toFixed(2)}%`],
      ['Potential', `${signedUsd(pot)} · ${signedR(rr)}`],
      ['Position', `${usd(p.notional)} · ${p.lev.toFixed(1)}×`],
    ]);
    const html = card([
      top,
      nums,
      section('📐 Why', [`${e(p.setup)} — ${e(p.why)}`, note(`Stop beyond the level that proves it wrong; target at ${rr.toFixed(1)}× the risk.`)]),
      section('🎲 Odds', [`<b>${Math.round(p.odds.pWin * 100)}%</b> to win · expects <b>${signedR(p.odds.expR)}</b> after costs ${note(`(forest trust ${Math.round(p.odds.trust * 100)}%)`)}`]),
      section(`🗳 Council — ${e(p.summary)}`, p.votes.map((v) => `${MARK[v.stance]} <i>${NAME[v.bot] ?? v.bot}:</i> ${e(v.why)}`)),
    ]);
    return { title: `${p.coin} ${sideWord(p)} — taking it`, html, short: card([top, nums]) };
  }
  if (n.stage === 'manage') {
    const now = p.price ?? p.entry;
    const dir = p.side === 'buy' ? 1 : -1;
    const openUsd = (now - p.entry) * p.qty * dir;
    const openR = ((now - p.entry) * dir) / Math.max(1e-12, Math.abs(p.entry - p.stop0));
    const top = head('🟡', `${name} — managing`, who);
    const nums = table([
      ['Now', px(now)],
      ['Open', `${signedUsd(openUsd)} · ${signedR(openR)}`],
      ['Stop', `${px(p.stop)}${p.stop !== p.stop0 ? ` (was ${px(p.stop0)})` : ''}`],
      ['Target', px(p.target)],
    ]);
    const html = card([top, nums, section('🧭 Decisions so far', bullets(p.mgmt.length ? p.mgmt.map((m) => e(m.text)) : ['holding as planned']))]);
    return { title: `${p.coin} ${sideWord(p)} — managing`, html, short: card([top, nums]) };
  }
  const win = (p.pnl ?? 0) >= 0;
  const r = p.r ?? 0;
  const top = head(win ? '🟢' : '🔴', `${name} — closed ${signedUsd(p.pnl ?? 0)} (${signedR(r)})`, `${who} · held ${held((p.closedAt ?? Date.now()) - p.openedAt)}`);
  const nums = table([
    ['Entry', px(p.entry)],
    ['Exit', px(p.exit)],
    ['Gross', signedUsd((p.pnl ?? 0) + p.fees)],
    ['Fees', usd(p.fees)],
    ['Risked', usd(p.riskUsd)],
    ...(n.equity !== null ? [['Account', usd(n.equity)]] : []),
  ]);
  const html = card([
    top,
    nums,
    section(win ? '✅ Verdict' : '📉 Verdict', [reasonWords(p)]),
    section('📐 Why it was taken', [`${e(p.setup)} — ${e(p.why)}`]),
    section('🧭 How it was managed', bullets(p.mgmt.length ? p.mgmt.map((m) => e(m.text)) : ['held to the end as planned'])),
  ]);
  return { title: `${p.coin} ${sideWord(p)} ${win ? 'won' : 'lost'} ${signedUsd(p.pnl ?? 0)}`, html, short: card([top, nums]) };
}

function reasonWords(p: CSwarmPosition): string {
  const r = p.r ?? 0;
  switch (p.reason) {
    case 'target':
      return `The plan worked — it reached its target for ${signedR(r)}.`;
    case 'stop':
      return `The level failed and the stop did its job: a ${signedR(r)} loss, as planned before the trade.`;
    case 'breakeven':
      return 'It went in favour, the stop was moved to entry, and it came back: a scratch instead of a loss.';
    case 'trail':
      return `The trailing stop banked the move: ${signedR(r)}.`;
    case 'time':
      return `It ran out of time without reaching stop or target: ${signedR(r)}.`;
    case 'exchange stop':
      return 'The exchange-side stop closed it (the app was not in time, or not running).';
    default:
      return `${p.reason ?? 'closed'}: ${signedR(r)}.`;
  }
}

// ---------- the picture ----------

const C = { bg: '#07080a', panel: '#0d0f13', grid: '#1a1d24', text: '#e8ecf2', muted: '#8a93a3', up: '#2fe39b', down: '#ff5d6c', blue: '#5aa9ff', amber: '#ffc35a', gold: '#d9b45a', chrome: '#c9d1dc' };

/** The chart card: candles with entry, stop, target and value; numbers on the right. */
export async function cardOf(n: CSwarmNotify): Promise<Uint8Array> {
  const W = 1200;
  const H = 675;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const p = n.position;
  const dir = p.side === 'buy' ? 1 : -1;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#22262e';
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  // header
  const stageColor = n.stage === 'setup' ? C.blue : n.stage === 'manage' ? C.amber : (p.pnl ?? 0) >= 0 ? C.up : C.down;
  ctx.fillStyle = C.muted;
  ctx.font = '600 14px Inter, system-ui, sans-serif';
  ctx.fillText(`NOVUS ORDO · CRYPTO SWARM · ${n.mode === 'live' ? 'LIVE' : 'PAPER'} · HYPERLIQUID`, 28, 34);
  ctx.fillStyle = C.text;
  ctx.font = '700 34px Inter, system-ui, sans-serif';
  const title = `${p.coin}  ${sideWord(p)}`;
  ctx.fillText(title, 28, 76);
  const titleW = ctx.measureText(title).width;
  ctx.fillStyle = dir > 0 ? C.up : C.down;
  ctx.fillRect(28, 88, 120, 3);
  ctx.fillStyle = C.muted;
  ctx.font = '500 18px Inter, system-ui, sans-serif';
  ctx.fillText(`${p.agentName ?? NAME[p.agent]} · ${p.setup}`, 28 + titleW + 22, 76);
  const badge = n.stage === 'setup' ? 'SETUP' : n.stage === 'manage' ? 'MANAGING' : `${(p.pnl ?? 0) >= 0 ? 'PROFIT' : 'LOSS'} ${signedUsd(p.pnl ?? 0)}`;
  ctx.font = '700 22px Inter, system-ui, sans-serif';
  const bw = ctx.measureText(badge).width + 36;
  ctx.fillStyle = stageColor + '22';
  ctx.strokeStyle = stageColor;
  roundRect(ctx, W - 28 - bw, 40, bw, 44, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = stageColor;
  ctx.fillText(badge, W - 28 - bw + 18, 70);

  // chart
  const X0 = 28;
  const Y0 = 112;
  const CW = 800;
  const CH = 500;
  ctx.fillStyle = C.panel;
  ctx.fillRect(X0, Y0, CW, CH);
  const k = n.candles.filter((c) => c.every((v) => Number.isFinite(v)));
  const levels = [p.entry, p.stop, p.target, p.stop0, ...(p.exit ? [p.exit] : []), ...(n.va ? [n.va.vah, n.va.val, n.va.poc] : [])];
  let lo = Math.min(...levels, ...k.map((c) => c[3]));
  let hi = Math.max(...levels, ...k.map((c) => c[2]));
  const pad = (hi - lo) * 0.08 || p.entry * 0.002;
  lo -= pad;
  hi += pad;
  const y = (v: number) => Y0 + CH - ((v - lo) / (hi - lo)) * CH;
  // grid and price scale
  ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
  for (let i = 0; i <= 5; i++) {
    const v = lo + ((hi - lo) * i) / 5;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(X0, y(v));
    ctx.lineTo(X0 + CW, y(v));
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.fillText(px(v), X0 + 6, i === 5 ? y(v) + 14 : y(v) - 4);
  }
  // value area
  if (n.va && n.va.vah > n.va.val) {
    ctx.fillStyle = 'rgba(201,209,220,0.05)';
    ctx.fillRect(X0, y(n.va.vah), CW, y(n.va.val) - y(n.va.vah));
    hline(ctx, X0, CW, y(n.va.poc), C.gold, [4, 4], 'POC', px(n.va.poc));
  }
  // candles
  const n0 = Math.max(1, k.length);
  const step = (CW - 90) / n0;
  k.forEach((c, i) => {
    const xm = X0 + 10 + i * step + step / 2;
    const up = c[4] >= c[1];
    ctx.strokeStyle = up ? C.up : C.down;
    ctx.fillStyle = up ? C.up : C.down;
    ctx.beginPath();
    ctx.moveTo(xm, y(c[2]));
    ctx.lineTo(xm, y(c[3]));
    ctx.stroke();
    const top = y(Math.max(c[1], c[4]));
    ctx.fillRect(xm - Math.max(1, step * 0.32), top, Math.max(2, step * 0.64), Math.max(1, y(Math.min(c[1], c[4])) - top));
  });
  // the trade's levels
  hline(ctx, X0, CW, y(p.target), C.up, [], 'TARGET', px(p.target));
  if (p.stop0 !== p.stop) hline(ctx, X0, CW, y(p.stop0), C.down + '88', [3, 5], 'FIRST STOP', px(p.stop0));
  // a stop at (or near) the entry: its label goes under the line, clear of the entry's
  hline(ctx, X0, CW, y(p.stop), C.down, [], p.be ? 'STOP (BREAK-EVEN)' : p.trailed ? 'STOP (TRAILING)' : 'STOP', px(p.stop), Math.abs(y(p.stop) - y(p.entry)) < 16 && (p.stop - p.entry) * dir <= 0);
  hline(ctx, X0, CW, y(p.entry), C.chrome, [6, 4], 'ENTRY', px(p.entry));
  // reward and risk zones beside the last candle
  const zx = X0 + CW - 78;
  ctx.fillStyle = 'rgba(47,227,155,0.14)';
  ctx.fillRect(zx, Math.min(y(p.entry), y(p.target)), 60, Math.abs(y(p.target) - y(p.entry)));
  ctx.fillStyle = 'rgba(255,93,108,0.14)';
  ctx.fillRect(zx, Math.min(y(p.entry), y(p.stop)), 60, Math.abs(y(p.stop) - y(p.entry)));
  if (p.exit) {
    ctx.fillStyle = (p.pnl ?? 0) >= 0 ? C.up : C.down;
    ctx.beginPath();
    ctx.arc(zx + 30, y(p.exit), 9, 0, Math.PI * 2);
    ctx.fill();
  } else if (Number.isFinite(p.price ?? NaN)) {
    ctx.fillStyle = C.text;
    ctx.beginPath();
    ctx.arc(zx + 30, y(p.price as number), 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = C.muted;
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText(`${n.timeframe === '1h' ? 'hourly' : '1-minute'} candles · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, X0, Y0 + CH + 24);

  // numbers
  const RX = 852;
  let ry = 136;
  const row = (label: string, value: string, color = C.text, big = false) => {
    ctx.fillStyle = C.muted;
    ctx.font = '500 14px Inter, system-ui, sans-serif';
    ctx.fillText(label, RX, ry);
    ctx.fillStyle = color;
    ctx.font = `${big ? '700 30px' : '600 20px'} "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillText(value, RX, ry + (big ? 34 : 26));
    ry += big ? 64 : 52;
  };
  const rr = Math.abs(p.target - p.entry) / Math.max(1e-12, Math.abs(p.entry - p.stop0));
  if (n.stage === 'result') {
    row('RESULT', `${signedUsd(p.pnl ?? 0)}  ${signedR(p.r ?? 0)}`, (p.pnl ?? 0) >= 0 ? C.up : C.down, true);
    row('ENTRY → EXIT', `${px(p.entry)} → ${px(p.exit)}`);
    row('HELD · REASON', `${held((p.closedAt ?? Date.now()) - p.openedAt)} · ${p.reason ?? ''}`);
    row('FEES · RISKED', `${usd(p.fees)} · ${usd(p.riskUsd)}`);
    if (n.equity !== null) row('ACCOUNT NOW', usd(n.equity));
  } else {
    const pot = p.potential ?? Math.abs(p.target - p.entry) * p.qty;
    row('POTENTIAL GAIN', `${signedUsd(pot)}  ${signedR(rr)}`, C.up, true);
    if (n.stage === 'manage') row('STOP NOW', `${px(p.stop)}${p.be ? ' · no loss' : p.trailed ? ' · trailing' : ''}`, p.be || p.trailed ? C.up : C.down);
    else row('AT RISK', `${usd(p.riskUsd)} · ${p.riskPct.toFixed(2)}%`, C.down);
    if (n.stage === 'manage' && Number.isFinite(p.price ?? NaN)) {
      const open = ((p.price as number) - p.entry) * p.qty * dir;
      row('OPEN P&L', signedUsd(open), open >= 0 ? C.up : C.down);
    } else row('POSITION', `${usd(p.notional)} · ${p.lev.toFixed(1)}×`);
    row('ODDS', `${Math.round(p.odds.pWin * 100)}% win · ${signedR(p.odds.expR)}`);
    row('COUNCIL', p.summary.split(' — ')[0] + (p.summary.includes('—') ? ` ${p.votes.filter((v) => v.stance === 'for').length}✓ ${p.votes.filter((v) => v.stance === 'against').length}✗` : ''));
  }
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new Error('could not draw the card');
  return new Uint8Array(await blob.arrayBuffer());
}

function hline(ctx: CanvasRenderingContext2D, x: number, w: number, yy: number, color: string, dash: number[], label: string, value: string, below = false) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, yy);
  ctx.lineTo(x + w - 84, yy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  const t = `${label} ${value}`;
  ctx.fillText(t, x + w - 90 - ctx.measureText(t).width, below ? yy + 14 : yy - 5);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One trade moment: a pop-up here, and the card plus its text on Telegram. */
export async function tellTrade(n: CSwarmNotify) {
  const s = getSettings();
  const cap = captionOf(n);
  const q = n.position;
  if (n.stage !== 'manage') alertHere(cap.title, n.stage === 'setup' ? `Entry ${px(q.entry)} · Stop ${px(q.stop)} · Target ${px(q.target)}` : `Entry ${px(q.entry)} → exit ${px(q.exit)} · ${signedR(q.r ?? 0)}`, n.stage === 'setup' ? 'buy' : (q.pnl ?? 0) >= 0 ? 'buy' : 'sell');
  if (!desktop || !s.telegramCrypto || !s.telegramSecretId) return;
  try {
    const png = await cardOf(n);
    if (cap.html.length <= 1024) return await desktop.swarm.notifyPhoto(s.telegramSecretId, png, cap.html);
    await desktop.swarm.notifyPhoto(s.telegramSecretId, png, cap.short);
    await desktop.swarm.notify(s.telegramSecretId, cap.html);
  } catch {
    await desktop.swarm.notify(s.telegramSecretId, cap.html).catch(() => undefined);
  }
}
