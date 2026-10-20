import { useEffect, useRef, useState } from 'react';
import { fmtNum, fmtPct, fmtPrice } from '../core/format';
import { desktop } from '../desktop/bridge';
import { yahooChart, yahooSearch, type JsonFetcher, type YahooChart, type YahooQuote, type YahooSearchHit } from '../shared/yahoo';
import { axisTicks, Canvas, drawTimeAxis, font, label, line, mask, type DrawContext, type PointerState } from '../ui/canvas';
import { Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { drawTooltip } from './FootprintChart';

export interface YahooConfig {
  symbols: string[];
  selected: string;
  range: string;
}

export const YAHOO_DEFAULTS: YahooConfig = {
  symbols: ['^GSPC', '^NDX', '^DJI', '^VIX', 'DX-Y.NYB', 'NQ=F', 'ES=F', 'GC=F', 'CL=F', 'EURUSD=X', 'AAPL', 'NVDA', 'TSLA', 'MSTR', 'COIN'],
  selected: '^GSPC',
  range: '1d',
};

/** Desktop: through the main process (Yahoo has no CORS). Browser: direct, usually blocked. */
const fetchJson: JsonFetcher = async (url, init) => {
  if (desktop) return desktop.net.fetchJson(url, init);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

const BLOCKED = 'Yahoo Finance blocks direct browser requests — use the Novus Ordo desktop app.';

export function YahooPanel({ config: c, setConfig }: PanelProps<YahooConfig>) {
  const [quotes, setQuotes] = useState<Record<string, YahooQuote | { error: string }>>({});
  const [chart, setChart] = useState<YahooChart | null>(null);
  const [chartErr, setChartErr] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<YahooSearchHit[]>([]);
  const pointer = useRef<PointerState | null>(null);

  // quote board (30s)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        c.symbols.map(async (s) => {
          try {
            return [s, (await yahooChart(fetchJson, s, '1d')).quote] as const;
          } catch (e) {
            return [s, { error: desktop ? String((e as Error).message ?? e) : BLOCKED }] as const;
          }
        }),
      );
      if (alive) setQuotes(Object.fromEntries(entries));
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.symbols.join()]);

  // selected chart (refresh 60s)
  useEffect(() => {
    let alive = true;
    const load = () =>
      yahooChart(fetchJson, c.selected, c.range)
        .then((r) => {
          if (!alive) return;
          setChart(r);
          setChartErr('');
        })
        .catch((e) => alive && setChartErr(desktop ? String(e?.message ?? e) : BLOCKED));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.selected, c.range]);

  // symbol search (debounced)
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      yahooSearch(fetchJson, q.trim())
        .then(setHits)
        .catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const add = (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (s && !c.symbols.includes(s)) setConfig({ symbols: [...c.symbols, s], selected: s });
    else if (s) setConfig({ selected: s });
    setQ('');
    setHits([]);
  };

  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const bars = chart?.bars ?? [];
    if (!bars.length) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText(chartErr || 'Loading…', w / 2, h / 2);
      return;
    }
    const axisW = 70;
    const plotW = w - axisW;
    const timeH = 18;
    const volH = (h - timeH) * 0.16;
    const priceH = h - timeH - volH;
    let lo = Infinity;
    let hi = -Infinity;
    let maxV = 0;
    for (const b of bars) {
      lo = Math.min(lo, b.low);
      hi = Math.max(hi, b.high);
      maxV = Math.max(maxV, b.volume);
    }
    const pad = (hi - lo) * 0.06 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const y = (p: number) => 6 + ((hi - p) / (hi - lo)) * (priceH - 12);
    const bw = plotW / bars.length;
    for (const p of axisTicks(lo, hi, priceH / 44)) line(ctx, 0, Math.round(y(p)) + 0.5, plotW, Math.round(y(p)) + 0.5, pal.grid);
    const prev = chart!.quote.prevClose;
    if (c.range === '1d' && isFinite(prev) && prev > lo && prev < hi) line(ctx, 0, y(prev), plotW, y(prev), pal.muted, 1, [4, 4]);
    bars.forEach((b, i) => {
      const x = i * bw + bw / 2;
      const up = b.close >= b.open;
      const col = up ? pal.buy : pal.sell;
      line(ctx, Math.round(x) + 0.5, y(b.high), Math.round(x) + 0.5, y(b.low), col);
      ctx.fillStyle = col;
      const body = Math.max(1, bw * 0.7);
      ctx.fillRect(Math.round(x - body / 2), Math.min(y(b.open), y(b.close)), Math.max(1, Math.round(body)), Math.max(1, Math.abs(y(b.close) - y(b.open))));
      const vh = maxV ? (b.volume / maxV) * (volH - 4) : 0;
      ctx.fillStyle = rgba(up ? pal.buyRgb : pal.sellRgb, 0.4);
      ctx.fillRect(Math.round(x - body / 2), priceH + volH - vh, Math.max(1, Math.round(body)), vh);
    });
    mask(ctx, pal, plotW, 0, axisW, h);
    line(ctx, plotW + 0.5, 0, plotW + 0.5, h, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const p of axisTicks(lo, hi, priceH / 44)) ctx.fillText(fmtPrice(p), plotW + 6, y(p));
    const last = bars[bars.length - 1];
    label(ctx, fmtPrice(chart!.quote.price), plotW + 1, y(chart!.quote.price), chart!.quote.change >= 0 ? pal.buy : pal.sell, '#fff');
    line(ctx, 0, h - timeH + 0.5, w, h - timeH + 0.5, pal.border);
    drawTimeAxis(ctx, bars[0].time, last.time, 0, plotW, h - timeH / 2, pal);
    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW) {
      const b = bars[Math.min(bars.length - 1, Math.max(0, Math.floor(pt.x / bw)))];
      line(ctx, pt.x, 0, pt.x, h - timeH, pal.crosshair, 1, [3, 3]);
      drawTooltip(ctx, [new Date(b.time).toLocaleString(), `O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}`, `L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}`, `Vol ${fmtNum(b.volume)}`], pt.x, pt.y, plotW, h, pal);
    }
  };

  const sel = quotes[c.selected];
  const selQ = sel && 'price' in sel ? sel : chart?.quote;
  return (
    <div className="panel">
      <Toolbar>
        <div className="venue-mask">
          <input className="ctl" placeholder="Search stocks, indices, FX, futures…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(hits[0]?.symbol ?? q)} style={{ width: 210 }} />
          {hits.length > 0 && (
            <div className="popover" style={{ minWidth: 300 }}>
              {hits.map((hit) => (
                <div key={hit.symbol} className="list-row" style={{ cursor: 'pointer' }} onMouseDown={() => add(hit.symbol)}>
                  <b className="mono" style={{ width: 90 }}>
                    {hit.symbol}
                  </b>
                  <span style={{ flex: 1 }}>{hit.name}</span>
                  <span className="muted">{hit.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <Select value={c.range} options={Object.keys({ '1d': 1, '5d': 1, '1mo': 1, '6mo': 1, '1y': 1, '5y': 1 })} onChange={(range) => setConfig({ range })} />
        <Spacer />
        {selQ && (
          <span className="mono">
            <b>{selQ.symbol}</b> {fmtPrice(selQ.price)} <span className={selQ.change >= 0 ? 'up' : 'down'}>{fmtPct(selQ.changePct)}</span> <span className="muted">{selQ.currency}</span>
          </span>
        )}
      </Toolbar>
      <div className="yahoo-body">
        <div className="yahoo-board scroll">
          {c.symbols.length === 0 ? (
            <Empty>Search to add symbols.</Empty>
          ) : (
            <table className="grid">
              <tbody>
                {c.symbols.map((s) => {
                  const v = quotes[s];
                  const ok = v && 'price' in v;
                  return (
                    <tr key={s} className="clickable" onClick={() => setConfig({ selected: s })} style={s === c.selected ? { background: 'var(--accent-soft)' } : undefined}>
                      <td className="l" title={ok ? (v as YahooQuote).name : v ? (v as { error: string }).error : ''}>
                        <b>{s}</b>
                        <div className="muted" style={{ fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {ok ? (v as YahooQuote).name : v ? 'unavailable' : '…'}
                        </div>
                      </td>
                      <td>{ok ? fmtPrice((v as YahooQuote).price) : ''}</td>
                      <td className={ok && (v as YahooQuote).change >= 0 ? 'up' : 'down'}>{ok ? fmtPct((v as YahooQuote).changePct) : ''}</td>
                      <td>
                        <button
                          className="link"
                          title="Remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfig({ symbols: c.symbols.filter((x) => x !== s) });
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="yahoo-chart">
          <Canvas draw={draw} fps={10} pointerRef={pointer} />
        </div>
      </div>
    </div>
  );
}
