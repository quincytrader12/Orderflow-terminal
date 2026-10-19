import { useEffect, useRef, type CSSProperties, type MutableRefObject } from 'react';
import { ink, palette, type Palette } from './theme';

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  dpr: number;
  pal: Palette;
  now: number;
}

export interface PointerState {
  x: number;
  y: number;
  inside: boolean;
  down: boolean;
  /** canvas css size */
  w: number;
  h: number;
}

/**
 * Canvas that redraws on requestAnimationFrame at most `fps` times per
 * second, sized to its container with devicePixelRatio scaling. Drawing is
 * skipped while the canvas is not visible (hidden tab in a tabset).
 */
export function useCanvas(draw: (d: DrawContext) => void, fps = 30) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const pointer = useRef<PointerState>({ x: -1, y: -1, inside: false, down: false, w: 0, h: 0 });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { alpha: true })!;
    let raf = 0;
    let last = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      last = 0;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    resize();
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 1000 / fps - 1) return;
      if (canvas.offsetParent === null || w < 2 || h < 2) return;
      last = t;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pal = palette();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = pal.panel;
      ctx.fillRect(0, 0, w, h);
      try {
        drawRef.current({ ctx, w, h, dpr, pal, now: Date.now() });
      } catch (e) {
        console.error('draw error', e);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fps]);

  return { canvasRef, pointer };
}

interface CanvasProps {
  draw: (d: DrawContext) => void;
  fps?: number;
  style?: CSSProperties;
  onWheel?: (e: WheelEvent, p: PointerState) => void;
  onDrag?: (dx: number, dy: number, e: PointerEvent, p: PointerState) => void;
  onClick?: (p: PointerState, e: PointerEvent) => void;
  onDoubleClick?: (p: PointerState) => void;
  pointerRef?: MutableRefObject<PointerState | null>;
  cursor?: string;
}

/** Canvas element with pointer tracking, drag and wheel helpers. */
export function Canvas({ draw, fps = 30, style, onWheel, onDrag, onClick, onDoubleClick, pointerRef, cursor = 'crosshair' }: CanvasProps) {
  const { canvasRef, pointer } = useCanvas(draw, fps);
  const handlers = useRef({ onWheel, onDrag, onClick, onDoubleClick });
  handlers.current = { onWheel, onDrag, onClick, onDoubleClick };
  if (pointerRef) pointerRef.current = pointer.current;

  useEffect(() => {
    const c = canvasRef.current!;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = c.getBoundingClientRect();
      pointer.current.x = e.clientX - r.left;
      pointer.current.y = e.clientY - r.top;
      pointer.current.w = r.width;
      pointer.current.h = r.height;
    };
    const move = (e: PointerEvent) => {
      pos(e);
      pointer.current.inside = true;
      if (pointer.current.down) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = e.clientX;
        lastY = e.clientY;
        handlers.current.onDrag?.(dx, dy, e, pointer.current);
      }
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointer.current.down = true;
      lastX = e.clientX;
      lastY = e.clientY;
      moved = 0;
      c.setPointerCapture(e.pointerId);
    };
    const up = (e: PointerEvent) => {
      if (!pointer.current.down) return;
      pointer.current.down = false;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (moved < 4) {
        pos(e);
        handlers.current.onClick?.(pointer.current, e);
      }
    };
    const leave = () => {
      pointer.current.inside = false;
    };
    const wheel = (e: WheelEvent) => {
      if (!handlers.current.onWheel) return;
      e.preventDefault();
      pos(e);
      handlers.current.onWheel(e, pointer.current);
    };
    const dbl = (e: MouseEvent) => {
      pos(e);
      handlers.current.onDoubleClick?.(pointer.current);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointerleave', leave);
    c.addEventListener('wheel', wheel, { passive: false });
    c.addEventListener('dblclick', dbl);
    return () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointerleave', leave);
      c.removeEventListener('wheel', wheel);
      c.removeEventListener('dblclick', dbl);
    };
  }, [canvasRef, pointer]);

  return (
    <div className="canvas-host" style={style}>
      <canvas ref={canvasRef} style={{ cursor, display: 'block', touchAction: 'none' }} />
    </div>
  );
}

// ---------- drawing helpers ----------

/** Cover a region (axis gutters) so chart content underneath does not show through. */
export function mask(ctx: CanvasRenderingContext2D, pal: Palette, x: number, y: number, w: number, h: number) {
  ctx.clearRect(x, y, w, h);
  ctx.fillStyle = pal.panel;
  ctx.fillRect(x, y, w, h);
}

export function font(px: number, weight = 400, mono = true) {
  return `${weight} ${px}px ${mono ? "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : 'Inter, system-ui, sans-serif'}`;
}

/** Nice axis ticks between min and max. */
export function axisTicks(min: number, max: number, target: number): number[] {
  if (!(max > min)) return [];
  const raw = (max - min) / Math.max(1, target);
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * 10 ** exp;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function timeTicks(from: number, to: number, target: number): number[] {
  const steps = [1e3, 5e3, 15e3, 30e3, 60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, 86400e3, 7 * 86400e3];
  const span = to - from;
  const step = steps.find((s) => span / s <= target) ?? steps[steps.length - 1];
  const out: number[] = [];
  const offset = new Date().getTimezoneOffset() * 60_000;
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) out.push(t);
  return out;
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg: string, align: 'left' | 'right' | 'center' = 'left', px = 11) {
  // '#fff' / '#000' mean "contrast with bg": pick whichever reads on this theme's colour
  if (fg === '#fff' || fg === '#000') fg = ink(bg);
  ctx.font = font(px, 600);
  const tw = ctx.measureText(text).width + 8;
  const bx = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2;
  ctx.fillStyle = bg;
  ctx.fillRect(bx, y - px / 2 - 3, tw, px + 6);
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 4, y + 0.5);
}

export function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1, dash?: number[]) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

/** Simple line-series chart into a rect with auto y-range. */
export function drawSeries(
  ctx: CanvasRenderingContext2D,
  series: { points: { time: number; value: number }[]; color: string; width?: number; fill?: string }[],
  rect: { x: number; y: number; w: number; h: number },
  range: { from: number; to: number },
  pal: Palette,
  fmt: (v: number) => string,
  opts: { zeroLine?: boolean; yMin?: number; yMax?: number } = {},
) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series)
    for (const p of s.points) {
      if (p.time < range.from || !isFinite(p.value)) continue;
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
  if (opts.yMin !== undefined) min = Math.min(min, opts.yMin);
  if (opts.yMax !== undefined) max = Math.max(max, opts.yMax);
  if (!isFinite(min)) return null;
  if (max === min) {
    max += Math.abs(max) * 0.001 + 1e-9;
    min -= Math.abs(min) * 0.001 + 1e-9;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const axisW = 64;
  const plotW = rect.w - axisW;
  const x = (t: number) => rect.x + ((t - range.from) / (range.to - range.from)) * plotW;
  const y = (v: number) => rect.y + rect.h - ((v - min) / (max - min)) * rect.h;
  ctx.font = font(10);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const v of axisTicks(min, max, Math.max(2, rect.h / 40))) {
    const yy = Math.round(y(v)) + 0.5;
    line(ctx, rect.x, yy, rect.x + plotW, yy, pal.grid);
    ctx.fillStyle = pal.muted;
    ctx.fillText(fmt(v), rect.x + plotW + 6, yy);
  }
  if (opts.zeroLine && min < 0 && max > 0) line(ctx, rect.x, y(0), rect.x + plotW, y(0), pal.muted, 1, [3, 3]);
  for (const s of series) {
    const pts = s.points.filter((p) => p.time >= range.from && isFinite(p.value));
    if (pts.length < 1) continue;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.time), y(p.value)) : ctx.moveTo(x(p.time), y(p.value))));
    if (s.fill) {
      ctx.save();
      ctx.lineTo(x(pts[pts.length - 1].time), rect.y + rect.h);
      ctx.lineTo(x(pts[0].time), rect.y + rect.h);
      ctx.closePath();
      ctx.fillStyle = s.fill;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x(p.time), y(p.value)) : ctx.moveTo(x(p.time), y(p.value))));
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.5;
    ctx.stroke();
    const lp = pts[pts.length - 1];
    label(ctx, fmt(lp.value), rect.x + plotW + 2, y(lp.value), s.color, pal.dark ? '#000' : '#fff', 'left', 10);
  }
  return { x, y, min, max, plotW };
}

export function drawTimeAxis(ctx: CanvasRenderingContext2D, from: number, to: number, x0: number, plotW: number, y: number, pal: Palette) {
  ctx.font = font(10);
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const span = to - from;
  for (const t of timeTicks(from, to, Math.max(2, plotW / 90))) {
    const xx = x0 + ((t - from) / span) * plotW;
    const d = new Date(t);
    const txt = span > 2 * 86400e3 && d.getHours() === 0 && d.getMinutes() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${span < 300e3 ? ':' + String(d.getSeconds()).padStart(2, '0') : ''}`;
    ctx.fillText(txt, xx, y);
  }
}
