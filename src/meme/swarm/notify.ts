// What the swarm tells you on Telegram while you are away: a picture of the
// coin (its logo and market-cap chart, with the entry and any exit marked) and
// the reasoning — on the buy, at each new multiple (2×, 5×, 10×, 25×, 50×,
// 100× …), and on every exit. Through the swarm's own channels, so it keeps
// reporting while the terminal is locked.
import { fmtNum, fmtTime } from '../../core/format';
import { desktop } from '../../desktop/bridge';
import { telegram } from '../../desktop/telegram';
import { escapeHtml } from '../../shared/telegram';
import { getSettings } from '../../store/settings';
import { font, line } from '../../ui/canvas';
import { palette, rgba } from '../../ui/theme';
import type { MemeToken } from '../token';
import type { Position } from './book';

const logos = new Map<string, HTMLImageElement | null>();

/** The coin's logo as an image that keeps the canvas exportable (fetched as data by the main process). */
async function logo(url?: string): Promise<HTMLImageElement | null> {
  if (!url || !desktop) return null;
  if (logos.has(url)) return logos.get(url)!;
  try {
    const src = await desktop.swarm.fetchImage(url.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${url.slice(7)}` : url);
    const img = new Image();
    img.src = src;
    await img.decode();
    logos.set(url, img);
    return img;
  } catch {
    logos.set(url, null);
    return null;
  }
}

/** A 960×540 card: logo, name, headline, market-cap chart with the trade on it, numbers. */
export async function coinCard(tok: MemeToken, p: Position | null, headline: string, solUsd: number): Promise<Uint8Array> {
  const W = 960;
  const H = 540;
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  const ctx = c.getContext('2d')!;
  ctx.scale(2, 2);
  const pal = palette();
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);
  // header: logo, ticker, name, headline
  const img = await logo(tok.image);
  const L = 24;
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(L, 18, 56, 56, 12);
    ctx.clip();
    ctx.drawImage(img, L, 18, 56, 56);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.roundRect(L, 18, 56, 56, 12);
    ctx.fill();
    ctx.fillStyle = pal.text;
    const initials = tok.symbol.slice(0, 3).toUpperCase();
    ctx.font = font(initials.length > 2 ? 16 : 20, 800, false);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, L + 28, 46);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = pal.text;
  ctx.font = font(26, 800, false);
  ctx.fillText(tok.symbol, L + 72, 44);
  const symW = ctx.measureText(tok.symbol).width;
  ctx.fillStyle = pal.muted;
  ctx.font = font(15, 500, false);
  ctx.fillText(tok.name.slice(0, 40), L + 84 + symW, 44);
  ctx.fillStyle = headline.startsWith('−') || /loss|stop|rug|out$/i.test(headline) ? pal.sell : pal.buy;
  ctx.font = font(17, 700, false);
  ctx.fillText(headline, L + 72, 68);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.muted;
  ctx.font = font(12, 500);
  ctx.fillText(`${tok.mint.slice(0, 6)}…${tok.mint.slice(-6)}`, W - 24, 36);
  ctx.fillText(p?.live ? 'LIVE · swarm wallet' : 'PAPER', W - 24, 56);

  // chart: market cap (USD when known) over the coin's trades
  const tr = tok.trades.slice(-400);
  const top = 96;
  const bottom = H - 84;
  const right = W - 90;
  const usd = solUsd > 0;
  const v = (mc: number) => (usd ? mc * solUsd : mc);
  if (tr.length >= 2) {
    const t0 = Math.min(tr[0].t, p?.openedAt ?? Infinity);
    const t1 = Math.max(tr[tr.length - 1].t, t0 + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of tr) {
      lo = Math.min(lo, v(x.mcapSol));
      hi = Math.max(hi, v(x.mcapSol));
    }
    const pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
    // a market cap is never below zero: no negative axis labels from the padding
    lo = Math.max(0, lo - pad);
    hi += pad;
    const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (right - L);
    const Y = (val: number) => bottom - ((val - lo) / (hi - lo)) * (bottom - top);
    for (let i = 0; i <= 4; i++) {
      const val = lo + ((hi - lo) * i) / 4;
      line(ctx, L, Y(val), right, Y(val), 'rgba(255,255,255,0.06)');
      ctx.fillStyle = pal.muted;
      ctx.font = font(11);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${usd ? '$' : ''}${fmtNum(val, 1)}${usd ? '' : ' SOL'}`, right + 8, Y(val));
    }
    // area under the line
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, rgba(pal.buyRgb, 0.28));
    grad.addColorStop(1, rgba(pal.buyRgb, 0));
    ctx.beginPath();
    tr.forEach((x, i) => (i ? ctx.lineTo(X(x.t), Y(v(x.mcapSol))) : ctx.moveTo(X(x.t), Y(v(x.mcapSol)))));
    ctx.lineTo(X(tr[tr.length - 1].t), bottom);
    ctx.lineTo(X(tr[0].t), bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    tr.forEach((x, i) => (i ? ctx.lineTo(X(x.t), Y(v(x.mcapSol))) : ctx.moveTo(X(x.t), Y(v(x.mcapSol)))));
    ctx.strokeStyle = pal.buy;
    ctx.lineWidth = 2;
    ctx.stroke();
    // the trade: entry, sells
    if (p) {
      const near = (t: number) => tr.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), tr[0]);
      const e = near(p.openedAt);
      ctx.fillStyle = pal.accent;
      ctx.beginPath();
      ctx.arc(X(p.openedAt), Y(v(e.mcapSol)), 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = font(12, 700);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      // labels flip to the left of their marker near the right edge, clear of the axis
      const tag = (text: string, x: number, y: number) => {
        const flip = x > right - 110;
        ctx.textAlign = flip ? 'right' : 'left';
        ctx.fillText(text, flip ? x - 10 : x + 9, y - 6);
      };
      tag('BUY', X(p.openedAt), Y(v(e.mcapSol)));
      for (const f of p.fills.filter((f) => f.side === 'sell')) {
        const s = near(f.t);
        ctx.fillStyle = f.mult >= 1 ? pal.buy : pal.sell;
        ctx.beginPath();
        ctx.arc(X(f.t), Y(v(s.mcapSol)), 6, 0, Math.PI * 2);
        ctx.fill();
        tag(`SELL ${f.mult.toFixed(1)}×`, X(f.t), Y(v(s.mcapSol)));
      }
    }
    ctx.fillStyle = pal.muted;
    ctx.font = font(11);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtTime(t0, false), L, bottom + 6);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(t1, false), right, bottom + 6);
  }
  // footer numbers
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(15, 700, false);
  ctx.fillStyle = pal.text;
  const mc = tok.dex?.mcapUsd && (tok.migrated || tok.source === 'dex') ? tok.dex.mcapUsd : tok.mcapSol * solUsd;
  const parts = [`Market cap ${usd ? `$${fmtNum(mc, 1)}` : `${fmtNum(tok.mcapSol, 1)} SOL`}`];
  if (p) parts.push(`paid ${p.costSol.toFixed(3)} SOL`, `taken out ${p.realizedSol.toFixed(3)} SOL`, `peak ${p.peakMult.toFixed(2)}×`);
  ctx.fillText(parts.join('   ·   '), L, H - 30);
  ctx.font = font(11, 600);
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'right';
  ctx.fillText('NOVUS ORDO · SWARM', W - 24, H - 12);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('could not draw the coin card');
  return new Uint8Array(await blob.arrayBuffer());
}

const html = (text: string) => {
  const [head, ...rest] = text.split('\n');
  return [`<b>${escapeHtml(head)}</b>`, ...rest.map((l) => escapeHtml(l).replace(/^([A-Z][\w ']{1,18}):/, '<i>$1:</i>'))].join('\n');
};

/** Send a coin card with a caption (text alone when the picture cannot be made). */
export async function tellWithCard(tok: MemeToken | undefined, p: Position | null, headline: string, text: string, solUsd: number) {
  const s = getSettings();
  if (!s.telegramBotStory || !s.telegramSecretId) return;
  const caption = html(text);
  try {
    if (!tok || !desktop) throw new Error('no card');
    const png = await coinCard(tok, p, headline, solUsd);
    if (caption.length <= 1024) return await desktop.swarm.notifyPhoto(s.telegramSecretId, png, caption);
    await desktop.swarm.notifyPhoto(s.telegramSecretId, png, `<b>${escapeHtml(headline)}</b>`);
  } catch {
    /* fall through to text */
  }
  const send = desktop ? (h: string) => desktop!.swarm.notify(s.telegramSecretId, h) : (h: string) => telegram.send(s.telegramSecretId, h);
  await send(caption).catch(() => undefined);
}
