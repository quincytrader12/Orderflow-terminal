import { fmtPrice, fmtUsd, fmtVol } from '../core/format';
import { bucket } from '../core/orderbook';
import type { VenueId } from '../core/types';
import { hub, type Feed } from '../market/hub';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Chip, Select, Spacer, Toolbar, VenueMask, type PanelProps } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';
import { baseTick } from './FootprintChart';

export interface OrderbookConfig {
  hiddenVenues: VenueId[];
  tickMult: number;
  usd: boolean;
  cumulative: boolean;
}

export const ORDERBOOK_DEFAULTS: OrderbookConfig = { hiddenVenues: [], tickMult: 10, usd: false, cumulative: true };

export interface CompositeLevel {
  price: number;
  total: number;
  byVenue: Map<VenueId, number>;
}

/** Merge several books onto a common tick grid (bids floor, asks ceil). */
export function compositeBook(feeds: Feed[], tick: number, maxLevels: number) {
  const bids = new Map<number, CompositeLevel>();
  const asks = new Map<number, CompositeLevel>();
  for (const f of feeds) {
    const v = f.inst.venue;
    const add = (m: Map<number, CompositeLevel>, p: number, q: number) => {
      let l = m.get(p);
      if (!l) {
        l = { price: p, total: 0, byVenue: new Map() };
        m.set(p, l);
      }
      l.total += q;
      l.byVenue.set(v, (l.byVenue.get(v) ?? 0) + q);
    };
    for (const l of f.book.getBids().slice(0, 2000)) add(bids, bucket(l.price, tick, 'floor'), l.qty);
    for (const l of f.book.getAsks().slice(0, 2000)) add(asks, bucket(l.price, tick, 'ceil'), l.qty);
  }
  const b = [...bids.values()].sort((x, y) => y.price - x.price).slice(0, maxLevels);
  const a = [...asks.values()].sort((x, y) => x.price - y.price).slice(0, maxLevels);
  return { bids: b, asks: a };
}

export function Orderbook({ config: c, setConfig }: PanelProps<OrderbookConfig>) {
  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const H = hub();
    const feeds = H.visible(c.hiddenVenues).filter((f) => !f.book.empty);
    const lp = H.primary.lastPrice();
    if (!feeds.length || !isFinite(lp)) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for order books…', w / 2, h / 2);
      return;
    }
    const tick = Number((baseTick(lp) * c.tickMult).toPrecision(10));
    const rowH = 16;
    const half = Math.max(3, Math.floor((h - rowH - 18) / 2 / rowH));
    const { bids, asks } = compositeBook(feeds, tick, half);
    const val = (q: number, p: number) => (c.usd ? q * p : q);
    let maxQ = 0;
    for (const l of [...bids, ...asks]) maxQ = Math.max(maxQ, l.total);
    let cumB = 0;
    let cumA = 0;
    const cumBids = bids.map((l) => (cumB += l.total));
    const cumAsks = asks.map((l) => (cumA += l.total));
    const maxCum = Math.max(cumB, cumA);
    const priceW = 0.3 * w;
    const qtyW = 0.22 * w;
    const barX = priceW + qtyW;
    const barW = w - barX - (c.cumulative ? 0.2 * w : 0) - 4;
    ctx.font = font(10, 600);
    ctx.fillStyle = pal.muted;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Price', 6, 9);
    ctx.textAlign = 'right';
    ctx.fillText(c.usd ? 'Size $' : 'Size', priceW + qtyW - 6, 9);
    ctx.textAlign = 'left';
    ctx.fillText('By venue', barX, 9);
    if (c.cumulative) {
      ctx.textAlign = 'right';
      ctx.fillText('Total', w - 6, 9);
    }
    const drawRow = (l: { price: number; total: number; byVenue: Map<VenueId, number> }, y: number, side: 'bid' | 'ask', cum: number) => {
      const col = side === 'bid' ? pal.buy : pal.sell;
      if (c.cumulative) {
        ctx.fillStyle = side === 'bid' ? 'rgba(38,166,154,0.08)' : 'rgba(239,83,80,0.08)';
        const cw = (cum / (maxCum || 1)) * w;
        ctx.fillRect(w - cw, y, cw, rowH - 1);
      }
      let x = barX;
      for (const [v, q] of l.byVenue) {
        const bw = (q / (maxQ || 1)) * barW;
        ctx.fillStyle = VENUE_COLORS[v];
        ctx.globalAlpha = 0.65;
        ctx.fillRect(x, y + 3, bw, rowH - 6);
        ctx.globalAlpha = 1;
        x += bw;
      }
      ctx.font = font(11, 500);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(l.price, tick), 6, y + rowH / 2);
      ctx.fillStyle = pal.text;
      ctx.textAlign = 'right';
      ctx.fillText(c.usd ? fmtUsd(val(l.total, l.price)) : fmtVol(l.total), priceW + qtyW - 6, y + rowH / 2);
      if (c.cumulative) {
        ctx.fillStyle = pal.muted;
        ctx.fillText(c.usd ? fmtUsd(val(cum, l.price)) : fmtVol(cum), w - 6, y + rowH / 2);
      }
    };
    const top = 18;
    for (let i = 0; i < asks.length; i++) drawRow(asks[i], top + (half - 1 - i) * rowH, 'ask', cumAsks[i]);
    const spreadY = top + half * rowH;
    const bb = bids[0]?.price;
    const ba = asks[0]?.price;
    ctx.fillStyle = pal.dark ? '#141922' : '#eef1f5';
    ctx.fillRect(0, spreadY, w, rowH);
    ctx.font = font(11, 700);
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.text;
    ctx.fillText(fmtPrice(lp), 6, spreadY + rowH / 2);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'right';
    if (bb !== undefined && ba !== undefined) ctx.fillText(`spread ${fmtPrice(ba - bb, tick)} · ${feeds.length} venues`, w - 6, spreadY + rowH / 2);
    for (let i = 0; i < bids.length; i++) drawRow(bids[i], spreadY + rowH + i * rowH, 'bid', cumBids[i]);
    line(ctx, priceW + 0.5, 18, priceW + 0.5, h, pal.grid);
  };

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select
          value={c.tickMult}
          options={[1, 2, 5, 10, 25, 50, 100, 250, 500].map((m) => {
            const lp = hub().primary.lastPrice();
            return { value: m, label: isFinite(lp) ? `group ${fmtPrice(baseTick(lp) * m, baseTick(lp) * m)}` : `×${m}` };
          })}
          onChange={(tickMult) => setConfig({ tickMult })}
        />
        <Chip active={c.usd} onClick={() => setConfig({ usd: !c.usd })}>
          $
        </Chip>
        <Chip active={c.cumulative} onClick={() => setConfig({ cumulative: !c.cumulative })}>
          Cum
        </Chip>
        <Spacer />
      </Toolbar>
      <Canvas draw={draw} fps={10} cursor="default" />
    </div>
  );
}
