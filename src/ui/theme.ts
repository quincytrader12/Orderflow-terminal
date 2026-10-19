import { useSettings } from '../store/settings';

export interface Palette {
  bg: string;
  panel: string;
  grid: string;
  border: string;
  text: string;
  muted: string;
  buy: string;
  sell: string;
  buyRgb: [number, number, number];
  sellRgb: [number, number, number];
  accent: string;
  warn: string;
  poc: string;
  vwap: string;
  crosshair: string;
  dark: boolean;
}

const DARK: Palette = {
  bg: '#0b0e13',
  panel: '#0f131a',
  grid: 'rgba(255,255,255,0.045)',
  border: '#232a35',
  text: '#d6dbe3',
  muted: '#7d8796',
  buy: '#26a69a',
  sell: '#ef5350',
  buyRgb: [38, 166, 154],
  sellRgb: [239, 83, 80],
  accent: '#4f8cff',
  warn: '#ffb74d',
  poc: '#ffd54f',
  vwap: '#ab47bc',
  crosshair: 'rgba(255,255,255,0.35)',
  dark: true,
};

const LIGHT: Palette = {
  bg: '#f6f7f9',
  panel: '#ffffff',
  grid: 'rgba(0,0,0,0.06)',
  border: '#d9dee5',
  text: '#1d232c',
  muted: '#68717f',
  buy: '#0f8a7e',
  sell: '#d63c39',
  buyRgb: [15, 138, 126],
  sellRgb: [214, 60, 57],
  accent: '#2962ff',
  warn: '#e08a00',
  poc: '#c79100',
  vwap: '#8e24aa',
  crosshair: 'rgba(0,0,0,0.35)',
  dark: false,
};

export function palette(): Palette {
  return useSettings.getState().theme === 'light' ? LIGHT : DARK;
}

export const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;

/** Heatmap colour ramp (dark blue → cyan → yellow → white) for t in [0,1]. */
const RAMP: [number, number, number][] = [
  [8, 16, 40],
  [20, 60, 140],
  [0, 170, 220],
  [120, 230, 120],
  [255, 230, 60],
  [255, 120, 40],
  [255, 255, 255],
];

export function heatColor(t: number, alpha = 1): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[Math.min(RAMP.length - 1, i + 1)];
  return `rgba(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)},${alpha})`;
}

export const VENUE_COLORS: Record<string, string> = {
  binancef: '#f0b90b',
  binance: '#c99a0a',
  bybit: '#f7a600',
  okx: '#cfd3dc',
  hyperliquid: '#50e3c2',
  coinbase: '#3f7bff',
  kraken: '#8d5cff',
  bitget: '#00d4e6',
  bitfinex: '#16b157',
  sim: '#b39ddb',
};
