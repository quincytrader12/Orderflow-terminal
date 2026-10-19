import { useRef } from 'react';
import { valueArea, volumeProfile } from '../core/footprint';
import { fmtPrice, fmtTime, fmtVol } from '../core/format';
import { bucket } from '../core/orderbook';
import { hub } from '../market/hub';
import { Canvas, font, label, line, type DrawContext, type PointerState } from '../ui/canvas';
import { Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { baseTick, drawTooltip } from './FootprintChart';

export interface VProfileConfig {
  range: 'session' | '4h' | '1h' | '15m';
  tickMult: number;
  mode: 'volume' | 'delta' | 'split';
}

export const VPROFILE_DEFAULTS: VProfileConfig = { range: 'session', tickMult: 10, mode: 'split' };

const RANGES: Record<string, number> = { '4h': 14400e3, '1h': 3600e3, '15m': 900e3 };

export function VolumeProfilePanel({ config: c, setConfig }: PanelProps<VProfileConfig>) {
  const pointer = useRef<PointerState | null>(null);
  const cache = useRef({ at: 0, key: '', levels: new Map<number, { buy: number; sell: number }>() });

  const draw = ({ ctx, w, h, pal, now }: DrawContext) => {
    const f = hub().primary;
    const lp = f.lastPrice();
    if (!isFinite(lp)) return;
    const tick = Number((baseTick(lp) * c.tickMult).toPrecision(10));
    const from = c.range === 'session' ? Math.floor(now / 86400e3) * 86400e3 : now - RANGES[c.range];
    const key = `${f.key}|${tick}|${c.range}`;
    if (now - cache.current.at > 1000 || cache.current.key !== key) {
      cache.current = { at: now, key, levels: volumeProfile(f.store, from, now + 1, tick) };
    }
    const levels = cache.current.levels;
    if (!levels.size) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('No trades in range yet', w / 2, h / 2);
      return;
    }
    const prices = [...levels.keys()];
    const lo = Math.min(...prices, lp);
    const hi = Math.max(...prices, lp) + tick;
    const axisW = 70;
    const plotW = w - axisW;
    const pad = 8;
    const rowH = Math.max(1, (h - pad * 2) / ((hi - lo) / tick));
    const y = (p: number) => pad + ((hi - p) / (hi - lo)) * (h - pad * 2);
    let maxV = 0;
    let maxD = 0;
    for (const l of levels.values()) {
      maxV = Math.max(maxV, l.buy + l.sell);
      maxD = Math.max(maxD, Math.abs(l.buy - l.sell));
    }
    const va = valueArea(new Map([...levels].map(([p, l]) => [p, l.buy + l.sell])), 0.7);
    if (va) {
      ctx.fillStyle = pal.dark ? 'rgba(79,140,255,0.06)' : 'rgba(41,98,255,0.06)';
      ctx.fillRect(0, y(va.vah + tick), plotW, y(va.val) - y(va.vah + tick));
    }
    for (const [p, l] of levels) {
      const yt = y(p + tick);
      const rh = Math.max(1, rowH - (rowH > 3 ? 1 : 0));
      if (c.mode === 'delta') {
        const d = l.buy - l.sell;
        const len = (Math.abs(d) / (maxD || 1)) * (plotW / 2 - 4);
        ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, 0.7);
        ctx.fillRect(d >= 0 ? plotW / 2 : plotW / 2 - len, yt, len, rh);
      } else {
        const tot = l.buy + l.sell;
        const len = (tot / (maxV || 1)) * (plotW - 8);
        const inVa = va && p >= va.val && p <= va.vah;
        if (c.mode === 'split') {
          const sl = (l.sell / (tot || 1)) * len;
          ctx.fillStyle = rgba(pal.sellRgb, inVa ? 0.75 : 0.4);
          ctx.fillRect(4, yt, sl, rh);
          ctx.fillStyle = rgba(pal.buyRgb, inVa ? 0.75 : 0.4);
          ctx.fillRect(4 + sl, yt, len - sl, rh);
        } else {
          ctx.fillStyle = inVa ? 'rgba(79,140,255,0.7)' : 'rgba(79,140,255,0.35)';
          ctx.fillRect(4, yt, len, rh);
        }
      }
    }
    if (c.mode === 'delta') line(ctx, plotW / 2, 0, plotW / 2, h, pal.muted, 1, [2, 3]);
    ctx.fillStyle = pal.panel;
    ctx.fillRect(plotW, 0, axisW, h);
    line(ctx, plotW + 0.5, 0, plotW + 0.5, h, pal.border);
    if (va) {
      for (const [p, lbl, col] of [
        [va.poc, 'POC', pal.poc],
        [va.vah, 'VAH', pal.muted],
        [va.val, 'VAL', pal.muted],
      ] as const) {
        const yy = y(p + (lbl === 'VAL' ? 0 : lbl === 'VAH' ? tick : tick / 2));
        line(ctx, 0, yy, plotW, yy, col, lbl === 'POC' ? 1.5 : 1, lbl === 'POC' ? undefined : [3, 3]);
        label(ctx, `${lbl} ${fmtPrice(p, tick)}`, plotW + 1, yy, lbl === 'POC' ? pal.poc : pal.border, lbl === 'POC' ? '#000' : pal.text, 'left', 9);
      }
    }
    label(ctx, fmtPrice(lp), plotW + 1, y(lp), pal.accent, '#fff', 'left', 10);
    line(ctx, 0, y(lp), plotW, y(lp), pal.accent, 1, [2, 2]);
    ctx.font = font(9);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`${c.range === 'session' ? 'UTC session' : c.range} · data from ${fmtTime(Math.max(from, f.store.firstTime() || from))}`, 6, h - 6);
    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW) {
      const p = bucket(hi - ((pt.y - pad) / (h - pad * 2)) * (hi - lo), tick, 'floor');
      const l = levels.get(p);
      line(ctx, 0, pt.y, plotW, pt.y, pal.crosshair, 1, [3, 3]);
      if (l) drawTooltip(ctx, [`${fmtPrice(p, tick)}`, `Vol ${fmtVol(l.buy + l.sell)}`, `Buy ${fmtVol(l.buy)} Sell ${fmtVol(l.sell)}`, `Δ ${fmtVol(l.buy - l.sell)}`], pt.x, pt.y, plotW, h, pal);
    }
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={c.range}
          options={[
            { value: 'session', label: 'Session (UTC)' },
            { value: '4h', label: 'Rolling 4h' },
            { value: '1h', label: 'Rolling 1h' },
            { value: '15m', label: 'Rolling 15m' },
          ]}
          onChange={(range) => setConfig({ range })}
        />
        <Select
          value={c.tickMult}
          options={[2, 5, 10, 20, 50, 100, 250].map((m) => {
            const lp = hub().primary.lastPrice();
            return { value: m, label: isFinite(lp) ? `row ${fmtPrice(baseTick(lp) * m, baseTick(lp) * m)}` : `×${m}` };
          })}
          onChange={(tickMult) => setConfig({ tickMult })}
        />
        <Select
          value={c.mode}
          options={[
            { value: 'split', label: 'Buy/Sell' },
            { value: 'volume', label: 'Volume' },
            { value: 'delta', label: 'Delta' },
          ]}
          onChange={(mode) => setConfig({ mode })}
        />
        <Spacer />
      </Toolbar>
      <Canvas draw={draw} fps={10} pointerRef={pointer} />
    </div>
  );
}
