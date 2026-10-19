import type { HeatmapRecorder } from '../../core/heatmap';

/** 256-entry RGB lookup per colour ramp (cached by ramp identity). */
const LUTS = new WeakMap<[number, number, number][], Uint8ClampedArray>();
function lutFor(ramp: [number, number, number][]) {
  let lut = LUTS.get(ramp);
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (ramp.length - 1);
    const k = Math.floor(x);
    const f = x - k;
    const a = ramp[k];
    const b = ramp[Math.min(ramp.length - 1, k + 1)];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  LUTS.set(ramp, lut);
  return lut;
}

export interface HeatmapView {
  width: number;
  height: number;
  /** css px → time; return NaN for columns without data */
  xToTime: (x: number) => number;
  /** price at the top of the plot and price per pixel row */
  priceTop: number;
  pricePerPx: number;
  /** quantity mapped to full intensity */
  norm: number;
  /** gamma (<1 brightens small liquidity) */
  gamma?: number;
  /** background alpha 0..255 for empty cells */
  baseAlpha?: number;
  /** colour ramp, low → high */
  ramp: [number, number, number][];
}

/**
 * Rasterises recorded order book snapshots into an offscreen canvas at 1 css
 * pixel resolution and returns it for drawImage. Each column samples the
 * snapshot active at that column's time.
 */
export class HeatmapRaster {
  private canvas: HTMLCanvasElement = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private image: ImageData | null = null;
  private col = new Float32Array(0);

  render(rec: HeatmapRecorder, v: HeatmapView): HTMLCanvasElement {
    const w = Math.max(1, Math.floor(v.width));
    const h = Math.max(1, Math.floor(v.height));
    if (this.canvas.width !== w || this.canvas.height !== h || !this.image) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
    }
    if (this.col.length !== h) this.col = new Float32Array(h);
    const data = this.image.data;
    data.fill(0);
    const snaps = rec.snapshots;
    const gamma = v.gamma ?? 0.6;
    const baseAlpha = v.baseAlpha ?? 0;
    const LUT = lutFor(v.ramp);
    let lastIdx = -2;
    for (let x = 0; x < w; x++) {
      const t = v.xToTime(x + 0.5);
      if (!isFinite(t)) continue;
      const idx = rec.indexAt(t);
      if (idx < 0) continue;
      const s = snaps[idx];
      // stop extending a snapshot more than 5s past its time (gaps in data)
      if (t - s.time > Math.max(5000, rec.intervalMs * 4) && idx === snaps.length - 1) continue;
      if (idx !== lastIdx) {
        this.col.fill(0);
        const fill = (arr: Float32Array) => {
          for (let i = 0; i < arr.length; i += 2) {
            const p = arr[i];
            const q = arr[i + 1];
            const yTop = Math.floor((v.priceTop - (p + s.res)) / v.pricePerPx);
            const yBot = Math.ceil((v.priceTop - p) / v.pricePerPx);
            if (yBot < 0 || yTop >= h) continue;
            for (let y = Math.max(0, yTop); y < Math.min(h, Math.max(yBot, yTop + 1)); y++) this.col[y] += q;
          }
        };
        fill(s.bids);
        fill(s.asks);
        lastIdx = idx;
      }
      for (let y = 0; y < h; y++) {
        const q = this.col[y];
        const o = (y * w + x) * 4;
        if (q <= 0) {
          if (baseAlpha) {
            data[o] = LUT[0];
            data[o + 1] = LUT[1];
            data[o + 2] = LUT[2];
            data[o + 3] = baseAlpha;
          }
          continue;
        }
        const k = Math.min(255, Math.floor(Math.pow(Math.min(1, q / v.norm), gamma) * 255));
        data[o] = LUT[k * 3];
        data[o + 1] = LUT[k * 3 + 1];
        data[o + 2] = LUT[k * 3 + 2];
        data[o + 3] = 60 + Math.min(195, k);
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
    return this.canvas;
  }
}
