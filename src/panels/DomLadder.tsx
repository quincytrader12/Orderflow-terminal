import { useRef } from 'react';
import { fmtPrice, fmtTime, fmtVol } from '../core/format';
import { bucket } from '../core/orderbook';
import { RollingProfile } from '../core/rollingProfile';
import { TIME_RANGES } from '../core/types';
import { useTicket } from '../desktop/trading';
import { hub } from '../market/hub';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Chip, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { ink, rgba } from '../ui/theme';
import { baseTick } from './FootprintChart';

export interface DomConfig {
  tickMult: number;
  range: string;
  usd: boolean;
  showDelta: boolean;
  rowH: number;
}

export const DOM_DEFAULTS: DomConfig = { tickMult: 5, range: '1h', usd: false, showDelta: true, rowH: 17 };

const TICK_MULTS = [1, 2, 5, 10, 20, 50, 100];

export function DomLadder({ config: c, setConfig }: PanelProps<DomConfig>) {
  const profile = useRef<RollingProfile | null>(null);
  const view = useRef({ center: NaN, auto: true });
  // last drawn grid, so a click can be mapped back to a price
  const grid = useRef({ top: NaN, tick: NaN, rowH: 17, headerH: 20, priceX: [0, 0] as [number, number] });

  const draw = ({ ctx, w, h, pal, now }: DrawContext) => {
    const feed = hub().primary;
    const lp = feed.lastPrice();
    const mid = feed.book.mid();
    const ref = isFinite(lp) ? lp : mid;
    if (!isFinite(ref)) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for order book…', w / 2, h / 2);
      return;
    }
    const tick = Number((baseTick(ref) * c.tickMult).toPrecision(10));
    const windowMs = c.range === 'session' ? Infinity : TIME_RANGES[c.range] ?? 3_600_000;
    if (!profile.current) profile.current = new RollingProfile(feed.store, tick, windowMs);
    const prof = profile.current;
    prof.configure(feed.store, tick, windowMs);
    prof.update(now);

    // group the book onto the ladder grid
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (const [p, q] of feed.book.bids) {
      const k = bucket(p, tick, 'floor');
      bids.set(k, (bids.get(k) ?? 0) + q);
    }
    for (const [p, q] of feed.book.asks) {
      const k = bucket(p, tick, 'floor');
      asks.set(k, (asks.get(k) ?? 0) + q);
    }

    const rowH = c.rowH;
    const headerH = 20;
    const rows = Math.floor((h - headerH) / rowH);
    const v = view.current;
    const anchor = bucket(isFinite(mid) ? mid : ref, tick, 'floor');
    if (!isFinite(v.center)) v.center = anchor;
    if (v.auto && Math.abs(anchor - v.center) / tick > rows * 0.3) v.center = anchor;
    const topPrice = bucket(v.center + Math.floor(rows / 2) * tick, tick, 'round');

    // columns
    // narrow ladders drop the secondary columns instead of overlapping them
    const WEIGHT: Record<string, number> = { sold: 0.13, bid: 0.16, price: 0.17, ask: 0.16, bought: 0.13, delta: 0.1, vol: 0.15 };
    const LABEL: Record<string, string> = { sold: 'Sold', bid: 'Bid', price: 'Price', ask: 'Ask', bought: 'Bought', delta: 'Δ', vol: 'Volume' };
    const drop = w < 250 ? ['sold', 'bought', 'delta', 'vol'] : w < 310 ? ['delta', 'vol'] : w < 370 ? ['vol'] : [];
    const keys = ['sold', 'bid', 'price', 'ask', 'bought', ...(c.showDelta ? ['delta'] : []), 'vol'].filter((k) => !drop.includes(k));
    const sumW = keys.reduce((a, k) => a + WEIGHT[k], 0);
    const cols = keys.map((k) => ({ k, label: LABEL[k], w: WEIGHT[k] / sumW }));
    let x = 0;
    const colX: Record<string, [number, number]> = {};
    for (const col of cols) {
      const cw = col.w * w;
      colX[col.k] = [x, cw];
      x += cw;
    }

    let maxBook = 0;
    let maxTraded = 0;
    let maxDelta = 0;
    const visible: number[] = [];
    for (let r = 0; r < rows; r++) visible.push(bucket(topPrice - r * tick, tick, 'round'));
    for (const p of visible) {
      maxBook = Math.max(maxBook, bids.get(p) ?? 0, asks.get(p) ?? 0);
      const l = prof.levels.get(p);
      if (l) {
        maxTraded = Math.max(maxTraded, l.buy + l.sell);
        maxDelta = Math.max(maxDelta, Math.abs(l.buy - l.sell));
      }
    }

    grid.current = { top: topPrice, tick, rowH, headerH, priceX: colX.price };

    // header
    ctx.fillStyle = pal.header;
    ctx.fillRect(0, 0, w, headerH);
    ctx.font = font(10, 600);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = pal.muted;
    for (const col of cols) ctx.fillText(col.label, colX[col.k][0] + colX[col.k][1] / 2, headerH / 2);

    const fmtQ = (q: number, p: number) => fmtVol(c.usd ? q * p : q);
    const bestBid = feed.book.bestBid()?.price;
    const bestAsk = feed.book.bestAsk()?.price;
    const lastBucket = isFinite(lp) ? bucket(lp, tick, 'floor') : NaN;
    // font sized so a full price fits its column
    const fontPx = Math.max(8, Math.min(12, rowH - 5, colX.price[1] / (fmtPrice(topPrice, tick).length * 0.64)));
    ctx.font = font(fontPx);
    // text never spills into the next column
    const clipText = (text: string, tx: number, ty: number, [cx, cw]: [number, number]) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + 1, ty - rowH / 2, cw - 2, rowH);
      ctx.clip();
      ctx.fillText(text, tx, ty);
      ctx.restore();
    };
    visible.forEach((p, r) => {
      const y = headerH + r * rowH;
      const ym = y + rowH / 2;
      const bq = bids.get(p) ?? 0;
      const aq = asks.get(p) ?? 0;
      const l = prof.levels.get(p);
      if (r % 2 === 0) {
        ctx.fillStyle = pal.rowAlt;
        ctx.fillRect(0, y, w, rowH);
      }
      // bid / ask bars
      if (bq > 0) {
        const [cx, cw] = colX.bid;
        ctx.fillStyle = rgba(pal.buyRgb, 0.15 + 0.55 * (bq / (maxBook || 1)));
        ctx.fillRect(cx + cw - cw * (bq / (maxBook || 1)), y + 1, cw * (bq / (maxBook || 1)), rowH - 2);
        ctx.fillStyle = pal.text;
        ctx.textAlign = 'right';
        clipText(fmtQ(bq, p), cx + cw - 4, ym, colX.bid);
      }
      if (aq > 0) {
        const [cx, cw] = colX.ask;
        ctx.fillStyle = rgba(pal.sellRgb, 0.15 + 0.55 * (aq / (maxBook || 1)));
        ctx.fillRect(cx, y + 1, cw * (aq / (maxBook || 1)), rowH - 2);
        ctx.fillStyle = pal.text;
        ctx.textAlign = 'left';
        clipText(fmtQ(aq, p), cx + 4, ym, colX.ask);
      }
      // price
      const [px, pw] = colX.price;
      const isLast = p === lastBucket;
      const inSpread = bestBid !== undefined && bestAsk !== undefined && p > bucket(bestBid, tick, 'floor') && p < bucket(bestAsk, tick, 'floor');
      ctx.fillStyle = isLast ? pal.accent : inSpread ? pal.cellSpread : pal.cell;
      ctx.fillRect(px + 1, y + 1, pw - 2, rowH - 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = isLast ? ink(pal.accent) : bq > 0 ? pal.buy : aq > 0 ? pal.sell : pal.muted;
      ctx.font = font(fontPx, isLast ? 700 : 500);
      ctx.fillText(fmtPrice(p, tick), px + pw / 2, ym);
      ctx.font = font(fontPx);
      if (p === bucket(prof.high, tick, 'floor')) {
        ctx.fillStyle = pal.warn;
        ctx.fillRect(px + 1, y + 1, 3, rowH - 2);
      }
      if (p === bucket(prof.low, tick, 'floor')) {
        ctx.fillStyle = pal.warn;
        ctx.fillRect(px + pw - 4, y + 1, 3, rowH - 2);
      }
      if (l) {
        const flash = now - l.last < 700;
        if (l.sell > 0 && colX.sold) {
          const [sx, sw] = colX.sold;
          ctx.fillStyle = flash ? rgba(pal.sellRgb, 0.35) : 'transparent';
          ctx.fillRect(sx, y + 1, sw, rowH - 2);
          ctx.fillStyle = pal.sell;
          ctx.textAlign = 'right';
          clipText(fmtQ(l.sell, p), sx + sw - 4, ym, colX.sold);
        }
        if (l.buy > 0 && colX.bought) {
          const [bx, bw] = colX.bought;
          ctx.fillStyle = flash ? rgba(pal.buyRgb, 0.35) : 'transparent';
          ctx.fillRect(bx, y + 1, bw, rowH - 2);
          ctx.fillStyle = pal.buy;
          ctx.textAlign = 'left';
          clipText(fmtQ(l.buy, p), bx + 4, ym, colX.bought);
        }
        if (colX.delta) {
          const [dx, dw] = colX.delta;
          const d = l.buy - l.sell;
          ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, 0.1 + 0.5 * (Math.abs(d) / (maxDelta || 1)));
          ctx.fillRect(dx + 1, y + 1, dw - 2, rowH - 2);
          ctx.fillStyle = pal.text;
          ctx.textAlign = 'center';
          clipText((d > 0 ? '+' : '') + fmtQ(d, p), dx + dw / 2, ym, colX.delta);
        }
        if (colX.vol) {
          const [vx, vw] = colX.vol;
          const tot = l.buy + l.sell;
          const bw2 = (tot / (maxTraded || 1)) * (vw - 6);
          const sellW = (l.sell / (tot || 1)) * bw2;
          ctx.fillStyle = rgba(pal.sellRgb, 0.55);
          ctx.fillRect(vx + 3, y + 3, sellW, rowH - 6);
          ctx.fillStyle = rgba(pal.buyRgb, 0.55);
          ctx.fillRect(vx + 3 + sellW, y + 3, bw2 - sellW, rowH - 6);
          if (vw > 60) {
            ctx.fillStyle = pal.text;
            ctx.textAlign = 'right';
            clipText(fmtQ(tot, p), vx + vw - 4, ym, colX.vol);
          }
        }
      }
    });
    for (const col of cols.slice(1)) line(ctx, colX[col.k][0] + 0.5, 0, colX[col.k][0] + 0.5, h, pal.border);

    // footer: data window
    ctx.font = font(9);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'right';
    if (isFinite(prof.dataStart)) ctx.fillText(`traded since ${fmtTime(prof.dataStart)}`, w - 4, h - 6);
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={c.tickMult}
          options={TICK_MULTS.map((m) => {
            const lp = hub().primary.lastPrice();
            return { value: m, label: isFinite(lp) ? `tick ${fmtPrice(baseTick(lp) * m, baseTick(lp) * m)}` : `×${m}` };
          })}
          onChange={(tickMult) => setConfig({ tickMult })}
          title="Ladder tick"
        />
        <Select value={c.range} options={[...Object.keys(TIME_RANGES), 'session']} onChange={(range) => setConfig({ range })} title="Traded volume window" />
        <Select value={c.rowH} options={[13, 15, 17, 20, 24]} onChange={(rowH) => setConfig({ rowH })} title="Row height" />
        <Chip active={c.usd} onClick={() => setConfig({ usd: !c.usd })} title="USD notional">
          $
        </Chip>
        <Chip active={c.showDelta} onClick={() => setConfig({ showDelta: !c.showDelta })}>
          Δ
        </Chip>
        <Spacer />
        <Chip
          active={view.current.auto}
          onClick={() => {
            view.current.auto = true;
            view.current.center = NaN;
          }}
          title="Re-centre and auto-follow"
        >
          ⌖ centre
        </Chip>
      </Toolbar>
      <Canvas
        draw={draw}
        fps={20}
        cursor="pointer"
        onClick={(p) => {
          // click a level: send its price to the Order Ticket (bid side → buy, ask side → sell)
          const g = grid.current;
          if (!isFinite(g.top) || p.y < g.headerH) return;
          const r = Math.floor((p.y - g.headerH) / g.rowH);
          const price = Number((g.top - r * g.tick).toPrecision(12));
          const side = p.x < g.priceX[0] ? 'buy' : p.x > g.priceX[0] + g.priceX[1] ? 'sell' : undefined;
          useTicket.getState().send(price, side);
        }}
        onWheel={(e) => {
          const lp = hub().primary.lastPrice();
          const tick = baseTick(isFinite(lp) ? lp : 1) * c.tickMult;
          view.current.auto = false;
          view.current.center += (e.deltaY > 0 ? -3 : 3) * tick;
        }}
        onDoubleClick={() => {
          view.current.auto = true;
          view.current.center = NaN;
        }}
      />
    </div>
  );
}
