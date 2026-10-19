import { useSettings } from '../store/settings';

export type ThemeId = 'grey' | 'white' | 'black' | 'neon-green' | 'neon-orange';
export type FilterId = 'none' | 'vivid' | 'soft' | 'mono' | 'warm' | 'cool' | 'night' | 'crt';
export type GlassLevel = 'off' | 'light' | 'medium' | 'heavy';

type RGB = [number, number, number];

/** Colours used by canvas renderers. */
export interface Palette {
  bg: string;
  /** translucent tint laid over the glass card behind each canvas */
  panel: string;
  grid: string;
  border: string;
  text: string;
  muted: string;
  buy: string;
  sell: string;
  buyRgb: RGB;
  sellRgb: RGB;
  accent: string;
  warn: string;
  poc: string;
  vwap: string;
  crosshair: string;
  /** table header strip, alternating rows, price cells, spread cells, tooltips */
  header: string;
  rowAlt: string;
  cell: string;
  cellSpread: string;
  tooltip: string;
  /** heatmap colour ramp, low → high liquidity */
  ramp: RGB[];
  dark: boolean;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  /** swatch gradient for the picker */
  swatch: string;
  /** CSS custom properties applied to :root */
  css: Record<string, string>;
  pal: Palette;
}

const hexRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const DEFAULT_RAMP: RGB[] = [
  [10, 20, 48],
  [24, 70, 150],
  [0, 170, 220],
  [110, 225, 120],
  [255, 225, 60],
  [255, 120, 40],
  [255, 255, 255],
];

interface Spec {
  id: ThemeId;
  name: string;
  swatch: string;
  dark: boolean;
  bg: string;
  bgImage: string;
  glass: string;
  glassStrong: string;
  glassBorder: string;
  glassHi: string;
  shadow: string;
  control: string;
  raised: string;
  border: string;
  border2: string;
  text: string;
  muted: string;
  faint: string;
  buy: string;
  sell: string;
  accent: string;
  warn: string;
  poc: string;
  glow: string;
  canvasTint: string;
  grid: string;
  header: string;
  rowAlt: string;
  cell: string;
  cellSpread: string;
  tooltip: string;
  ramp?: RGB[];
}

function build(s: Spec): ThemeDef {
  return {
    id: s.id,
    name: s.name,
    swatch: s.swatch,
    css: {
      '--bg': s.bg,
      '--bg-image': s.bgImage,
      '--glass': s.glass,
      '--glass-strong': s.glassStrong,
      '--glass-border': s.glassBorder,
      '--glass-hi': s.glassHi,
      '--glass-shadow': s.shadow,
      '--panel': s.glass,
      '--panel2': s.control,
      '--raised': s.raised,
      '--border': s.border,
      '--border2': s.border2,
      '--text': s.text,
      '--muted': s.muted,
      '--faint': s.faint,
      '--buy': s.buy,
      '--sell': s.sell,
      '--accent': s.accent,
      '--warn': s.warn,
      '--poc': s.poc,
      '--glow': s.glow,
      'color-scheme': s.dark ? 'dark' : 'light',
    },
    pal: {
      bg: s.bg,
      panel: s.canvasTint,
      grid: s.grid,
      border: s.border,
      text: s.text,
      muted: s.muted,
      buy: s.buy,
      sell: s.sell,
      buyRgb: hexRgb(s.buy),
      sellRgb: hexRgb(s.sell),
      accent: s.accent,
      warn: s.warn,
      poc: s.poc,
      vwap: '#c77dff',
      crosshair: s.dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
      header: s.header,
      rowAlt: s.rowAlt,
      cell: s.cell,
      cellSpread: s.cellSpread,
      tooltip: s.tooltip,
      ramp: s.ramp ?? DEFAULT_RAMP,
      dark: s.dark,
    },
  };
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  grey: build({
    id: 'grey',
    name: 'Grey',
    swatch: 'linear-gradient(135deg,#8a9099,#4a4f57)',
    dark: true,
    bg: '#4b5058',
    bgImage:
      'radial-gradient(1100px 700px at 12% -8%, rgba(255,255,255,0.20), transparent 60%), radial-gradient(900px 650px at 105% 110%, rgba(255,255,255,0.12), transparent 60%), radial-gradient(600px 400px at 60% 40%, rgba(160,180,210,0.10), transparent 70%), linear-gradient(160deg, #70757e 0%, #4d525a 45%, #3a3e45 100%)',
    glass: 'rgba(40,44,51,0.50)',
    glassStrong: 'rgba(46,50,58,0.86)',
    glassBorder: 'rgba(255,255,255,0.16)',
    glassHi: 'rgba(255,255,255,0.28)',
    shadow: '0 20px 44px rgba(0,0,0,0.32), 0 3px 8px rgba(0,0,0,0.22)',
    control: 'rgba(255,255,255,0.07)',
    raised: 'rgba(255,255,255,0.13)',
    border: 'rgba(255,255,255,0.10)',
    border2: 'rgba(255,255,255,0.22)',
    text: '#f0f2f6',
    muted: '#b0b6c0',
    faint: '#80868f',
    buy: '#34d1a5',
    sell: '#ff6b6b',
    accent: '#93bbff',
    warn: '#ffc46b',
    poc: '#ffe082',
    glow: 'rgba(147,187,255,0.35)',
    canvasTint: 'rgba(18,20,25,0.20)',
    grid: 'rgba(255,255,255,0.06)',
    header: 'rgba(255,255,255,0.06)',
    rowAlt: 'rgba(255,255,255,0.025)',
    cell: 'rgba(0,0,0,0.18)',
    cellSpread: 'rgba(255,255,255,0.08)',
    tooltip: 'rgba(36,40,47,0.94)',
  }),
  white: build({
    id: 'white',
    name: 'White',
    swatch: 'linear-gradient(135deg,#ffffff,#d7dce4)',
    dark: false,
    bg: '#e6e9ee',
    bgImage:
      'radial-gradient(1100px 700px at 10% -10%, rgba(255,255,255,0.95), transparent 60%), radial-gradient(900px 650px at 105% 105%, rgba(190,205,230,0.55), transparent 60%), linear-gradient(160deg, #f6f7fa 0%, #e4e8ee 50%, #d5dae2 100%)',
    glass: 'rgba(255,255,255,0.52)',
    glassStrong: 'rgba(255,255,255,0.9)',
    glassBorder: 'rgba(255,255,255,0.85)',
    glassHi: 'rgba(255,255,255,1)',
    shadow: '0 20px 44px rgba(40,55,80,0.14), 0 3px 8px rgba(40,55,80,0.08)',
    control: 'rgba(20,30,45,0.05)',
    raised: 'rgba(20,30,45,0.09)',
    border: 'rgba(20,30,45,0.10)',
    border2: 'rgba(20,30,45,0.22)',
    text: '#161b23',
    muted: '#5a6370',
    faint: '#99a1ad',
    buy: '#0e9f84',
    sell: '#e0413e',
    accent: '#2f6bff',
    warn: '#d98a00',
    poc: '#c79100',
    glow: 'rgba(47,107,255,0.25)',
    canvasTint: 'rgba(255,255,255,0.18)',
    grid: 'rgba(20,30,45,0.07)',
    header: 'rgba(20,30,45,0.05)',
    rowAlt: 'rgba(20,30,45,0.025)',
    cell: 'rgba(255,255,255,0.55)',
    cellSpread: 'rgba(20,30,45,0.07)',
    tooltip: 'rgba(255,255,255,0.96)',
  }),
  black: build({
    id: 'black',
    name: 'Black',
    swatch: 'linear-gradient(135deg,#2a2c31,#000000)',
    dark: true,
    bg: '#030304',
    bgImage:
      'radial-gradient(1000px 650px at 12% -10%, rgba(255,255,255,0.07), transparent 60%), radial-gradient(800px 600px at 100% 110%, rgba(120,130,160,0.06), transparent 60%), linear-gradient(160deg, #0d0e11 0%, #050506 60%, #000 100%)',
    glass: 'rgba(18,19,23,0.62)',
    glassStrong: 'rgba(20,21,25,0.92)',
    glassBorder: 'rgba(255,255,255,0.09)',
    glassHi: 'rgba(255,255,255,0.14)',
    shadow: '0 20px 44px rgba(0,0,0,0.65), 0 3px 8px rgba(0,0,0,0.5)',
    control: 'rgba(255,255,255,0.05)',
    raised: 'rgba(255,255,255,0.09)',
    border: 'rgba(255,255,255,0.08)',
    border2: 'rgba(255,255,255,0.16)',
    text: '#e9ebee',
    muted: '#8d939c',
    faint: '#555a62',
    buy: '#26c6a0',
    sell: '#f0524f',
    accent: '#a3adff',
    warn: '#ffb74d',
    poc: '#ffd54f',
    glow: 'rgba(163,173,255,0.3)',
    canvasTint: 'rgba(0,0,0,0.25)',
    grid: 'rgba(255,255,255,0.045)',
    header: 'rgba(255,255,255,0.04)',
    rowAlt: 'rgba(255,255,255,0.018)',
    cell: 'rgba(0,0,0,0.35)',
    cellSpread: 'rgba(255,255,255,0.06)',
    tooltip: 'rgba(12,13,16,0.95)',
  }),
  'neon-green': build({
    id: 'neon-green',
    name: 'Neon Green',
    swatch: 'linear-gradient(135deg,#39ff14,#04220a)',
    dark: true,
    bg: '#010703',
    bgImage:
      'radial-gradient(900px 600px at 10% -10%, rgba(57,255,20,0.20), transparent 60%), radial-gradient(800px 600px at 105% 105%, rgba(0,255,140,0.14), transparent 60%), radial-gradient(500px 300px at 55% 45%, rgba(57,255,20,0.05), transparent 70%), linear-gradient(160deg, #041509 0%, #010703 60%, #000 100%)',
    glass: 'rgba(4,24,11,0.55)',
    glassStrong: 'rgba(5,26,12,0.92)',
    glassBorder: 'rgba(57,255,20,0.28)',
    glassHi: 'rgba(170,255,150,0.32)',
    shadow: '0 0 26px rgba(57,255,20,0.14), 0 20px 44px rgba(0,0,0,0.6)',
    control: 'rgba(57,255,20,0.06)',
    raised: 'rgba(57,255,20,0.13)',
    border: 'rgba(57,255,20,0.14)',
    border2: 'rgba(57,255,20,0.32)',
    text: '#dcffe0',
    muted: '#82cf8e',
    faint: '#3d7a48',
    buy: '#39ff14',
    sell: '#ff2e63',
    accent: '#39ff14',
    warn: '#eaff00',
    poc: '#eaff00',
    glow: 'rgba(57,255,20,0.55)',
    canvasTint: 'rgba(0,10,4,0.25)',
    grid: 'rgba(57,255,20,0.07)',
    header: 'rgba(57,255,20,0.06)',
    rowAlt: 'rgba(57,255,20,0.025)',
    cell: 'rgba(0,0,0,0.35)',
    cellSpread: 'rgba(57,255,20,0.08)',
    tooltip: 'rgba(3,18,8,0.95)',
    ramp: [
      [2, 14, 6],
      [6, 60, 22],
      [18, 140, 40],
      [57, 255, 20],
      [190, 255, 120],
      [235, 255, 0],
      [255, 255, 255],
    ],
  }),
  'neon-orange': build({
    id: 'neon-orange',
    name: 'Neon Orange',
    swatch: 'linear-gradient(135deg,#ff7a00,#2a1003)',
    dark: true,
    bg: '#080301',
    bgImage:
      'radial-gradient(900px 600px at 10% -10%, rgba(255,122,0,0.24), transparent 60%), radial-gradient(800px 600px at 105% 105%, rgba(255,60,0,0.16), transparent 60%), radial-gradient(500px 300px at 55% 45%, rgba(255,140,0,0.05), transparent 70%), linear-gradient(160deg, #1a0a02 0%, #080301 60%, #000 100%)',
    glass: 'rgba(28,13,3,0.55)',
    glassStrong: 'rgba(30,14,4,0.92)',
    glassBorder: 'rgba(255,122,0,0.30)',
    glassHi: 'rgba(255,190,120,0.32)',
    shadow: '0 0 26px rgba(255,122,0,0.15), 0 20px 44px rgba(0,0,0,0.6)',
    control: 'rgba(255,122,0,0.07)',
    raised: 'rgba(255,122,0,0.14)',
    border: 'rgba(255,122,0,0.15)',
    border2: 'rgba(255,122,0,0.34)',
    text: '#ffe9d4',
    muted: '#d9a072',
    faint: '#7d5434',
    buy: '#00f5d4',
    sell: '#ff3d3d',
    accent: '#ff7a00',
    warn: '#ffd000',
    poc: '#ffd000',
    glow: 'rgba(255,122,0,0.55)',
    canvasTint: 'rgba(10,4,0,0.25)',
    grid: 'rgba(255,122,0,0.07)',
    header: 'rgba(255,122,0,0.07)',
    rowAlt: 'rgba(255,122,0,0.025)',
    cell: 'rgba(0,0,0,0.35)',
    cellSpread: 'rgba(255,122,0,0.09)',
    tooltip: 'rgba(22,10,2,0.95)',
    ramp: [
      [16, 6, 2],
      [70, 22, 4],
      [160, 55, 0],
      [255, 122, 0],
      [255, 190, 60],
      [255, 230, 120],
      [255, 255, 255],
    ],
  }),
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export const FILTERS: { id: FilterId; name: string; css: string }[] = [
  { id: 'none', name: 'None', css: 'none' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.4) contrast(1.08)' },
  { id: 'soft', name: 'Soft', css: 'contrast(0.9) saturate(0.85) brightness(1.04)' },
  { id: 'mono', name: 'Mono', css: 'grayscale(1) contrast(1.05)' },
  { id: 'warm', name: 'Warm', css: 'sepia(0.28) saturate(1.2) hue-rotate(-8deg)' },
  { id: 'cool', name: 'Cool', css: 'saturate(1.1) hue-rotate(12deg) brightness(1.02)' },
  { id: 'night', name: 'Night', css: 'brightness(0.72) contrast(1.06) saturate(0.9)' },
  { id: 'crt', name: 'CRT', css: 'contrast(1.12) saturate(1.15) brightness(1.05)' },
];

/**
 * Glass levels. Cards sit over a static, pre-blurred backdrop, so translucency
 * plus rim and highlights read as glass without a live blur; only "Frosted"
 * adds a real backdrop blur under every card (GPU-heavy while charts animate).
 * Floating overlays (menus, modals, toasts) always blur what is behind them.
 */
export const GLASS_LEVELS: { id: GlassLevel; name: string; blur: number; cardBlur: boolean }[] = [
  { id: 'off', name: 'Solid', blur: 0, cardBlur: false },
  { id: 'light', name: 'Light', blur: 10, cardBlur: false },
  { id: 'medium', name: 'Liquid', blur: 18, cardBlur: false },
  { id: 'heavy', name: 'Frosted', blur: 26, cardBlur: true },
];

export function themeOf(id: string | undefined): ThemeDef {
  return THEMES[(id as ThemeId) in THEMES ? (id as ThemeId) : 'grey'];
}

export function palette(): Palette {
  return themeOf(useSettings.getState().theme).pal;
}

/** Push a theme's CSS variables onto the document root. */
export function applyTheme(id: string, filter: FilterId, glass: GlassLevel) {
  const t = themeOf(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.css)) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
  root.dataset.filter = filter;
  root.dataset.glass = glass;
  root.style.setProperty('--app-filter', FILTERS.find((f) => f.id === filter)?.css ?? 'none');
  const level = GLASS_LEVELS.find((g) => g.id === glass) ?? GLASS_LEVELS[2];
  root.style.setProperty('--blur', `${level.blur}px`);
  root.style.setProperty('--card-backdrop', level.cardBlur ? `blur(${level.blur}px) saturate(170%)` : 'none');
  root.style.setProperty('--panel-fill', glass === 'off' ? 'var(--glass-strong)' : 'var(--glass)');
}

/** Black or white text, whichever reads better on a #rrggbb background. */
export function ink(bg: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return '#fff';
  const [r, g, b] = hexRgb(bg).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}

export const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;

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
