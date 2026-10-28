import { useSettings } from '../store/settings';

export type ThemeId = 'void' | 'grey' | 'white' | 'black' | 'neon-green' | 'neon-orange';
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
  textRgb: RGB;
  accentRgb: RGB;
  warnRgb: RGB;
  pocRgb: RGB;
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
  tabbar: string;
  rowLine: string;
  accentSoft: string;
  focus: string;
  onAccent: string;
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
      '--tabbar': s.tabbar,
      '--row-line': s.rowLine,
      '--accent-soft': s.accentSoft,
      '--focus': s.focus,
      '--on-accent': s.onAccent,
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
      textRgb: hexRgb(s.text),
      accentRgb: hexRgb(s.accent),
      warnRgb: hexRgb(s.warn),
      pocRgb: hexRgb(s.poc),
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
  // pure black, chrome edges, cyan and magenta light — the Command Center look
  void: build({
    id: 'void',
    name: 'Void Chrome',
    swatch: 'linear-gradient(135deg,#e9edf2 0%,#5d646e 30%,#000000 62%,#00e5ff 100%)',
    dark: true,
    bg: '#000000',
    bgImage: 'radial-gradient(1200px 520px at 50% -18%, rgba(190,205,225,0.07), transparent 70%), radial-gradient(900px 600px at 50% 120%, rgba(0,229,255,0.035), transparent 70%), #000000',
    glass: 'rgba(5,6,8,0.94)',
    glassStrong: 'rgba(7,8,10,0.97)',
    glassBorder: 'rgba(214,222,235,0.10)',
    glassHi: 'rgba(255,255,255,0.05)',
    shadow: '0 1px 2px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.6)',
    control: 'rgba(255,255,255,0.03)',
    raised: 'rgba(255,255,255,0.055)',
    border: 'rgba(214,222,235,0.09)',
    border2: 'rgba(214,222,235,0.18)',
    text: '#eef1f5',
    muted: '#8c939e',
    faint: '#4f5560',
    buy: '#2cf0b0',
    sell: '#ff3d7f',
    accent: '#38e1ff',
    warn: '#ffc53d',
    poc: '#f5c542',
    glow: 'rgba(56,225,255,0.30)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(214,222,235,0.045)',
    header: 'rgba(255,255,255,0.03)',
    rowAlt: 'rgba(255,255,255,0.014)',
    cell: 'rgba(0,0,0,0.4)',
    cellSpread: 'rgba(255,255,255,0.045)',
    tooltip: 'rgba(6,7,9,0.97)',
    tabbar: 'rgba(255,255,255,0.018)',
    rowLine: 'rgba(214,222,235,0.05)',
    accentSoft: 'rgba(56,225,255,0.10)',
    focus: 'rgba(56,225,255,0.30)',
    onAccent: '#001218',
    ramp: [
      [6, 10, 22],
      [20, 40, 90],
      [0, 150, 210],
      [56, 225, 255],
      [210, 120, 255],
      [255, 61, 127],
      [255, 255, 255],
    ],
  }),
  grey: build({
    id: 'grey',
    name: 'Grey',
    swatch: 'linear-gradient(135deg,#5a5f68,#2a2d33)',
    dark: true,
    bg: '#24272c',
    bgImage: 'linear-gradient(180deg, #2a2d33 0%, #222429 100%)',
    glass: 'rgba(46,49,55,0.94)',
    glassStrong: 'rgba(44,47,53,0.97)',
    glassBorder: 'rgba(255,255,255,0.08)',
    glassHi: 'rgba(255,255,255,0.05)',
    shadow: '0 1px 2px rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.18)',
    control: 'rgba(255,255,255,0.04)',
    raised: 'rgba(255,255,255,0.07)',
    border: 'rgba(255,255,255,0.08)',
    border2: 'rgba(255,255,255,0.16)',
    text: '#e7e9ec',
    muted: '#9aa1ab',
    faint: '#6b717b',
    buy: '#2ebd85',
    sell: '#f6465d',
    accent: '#5b9cff',
    warn: '#f0b90b',
    poc: '#f5c542',
    glow: 'rgba(91,156,255,0.3)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,255,255,0.045)',
    header: 'rgba(255,255,255,0.035)',
    rowAlt: 'rgba(255,255,255,0.018)',
    cell: 'rgba(0,0,0,0.12)',
    cellSpread: 'rgba(255,255,255,0.05)',
    tooltip: 'rgba(32,34,39,0.97)',
    tabbar: 'rgba(255,255,255,0.025)',
    rowLine: 'rgba(255,255,255,0.045)',
    accentSoft: 'rgba(91,156,255,0.12)',
    focus: 'rgba(91,156,255,0.28)',
    onAccent: '#ffffff',
  }),
  white: build({
    id: 'white',
    name: 'White',
    swatch: 'linear-gradient(135deg,#ffffff,#dfe3e8)',
    dark: false,
    bg: '#eceef1',
    bgImage: 'linear-gradient(180deg, #f1f3f5 0%, #e6e9ed 100%)',
    glass: 'rgba(255,255,255,0.95)',
    glassStrong: 'rgba(255,255,255,0.97)',
    glassBorder: 'rgba(15,23,42,0.09)',
    glassHi: 'rgba(255,255,255,1)',
    shadow: '0 1px 2px rgba(15,23,42,0.06), 0 6px 18px rgba(15,23,42,0.06)',
    control: 'rgba(15,23,42,0.035)',
    raised: 'rgba(15,23,42,0.06)',
    border: 'rgba(15,23,42,0.09)',
    border2: 'rgba(15,23,42,0.18)',
    text: '#14171c',
    muted: '#5b6370',
    faint: '#9aa1ab',
    buy: '#089981',
    sell: '#e5374d',
    accent: '#2563eb',
    warn: '#c98a00',
    poc: '#b8860b',
    glow: 'rgba(37,99,235,0.2)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(15,23,42,0.06)',
    header: 'rgba(15,23,42,0.035)',
    rowAlt: 'rgba(15,23,42,0.018)',
    cell: 'rgba(15,23,42,0.025)',
    cellSpread: 'rgba(15,23,42,0.06)',
    tooltip: 'rgba(255,255,255,0.98)',
    tabbar: 'rgba(15,23,42,0.025)',
    rowLine: 'rgba(15,23,42,0.06)',
    accentSoft: 'rgba(37,99,235,0.1)',
    focus: 'rgba(37,99,235,0.22)',
    onAccent: '#ffffff',
  }),
  black: build({
    id: 'black',
    name: 'Black',
    swatch: 'linear-gradient(135deg,#2a2c31,#000000)',
    dark: true,
    bg: '#08090b',
    bgImage: 'linear-gradient(180deg, #0c0d10 0%, #060708 100%)',
    glass: 'rgba(18,19,22,0.95)',
    glassStrong: 'rgba(20,21,24,0.97)',
    glassBorder: 'rgba(255,255,255,0.07)',
    glassHi: 'rgba(255,255,255,0.04)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.4)',
    control: 'rgba(255,255,255,0.035)',
    raised: 'rgba(255,255,255,0.06)',
    border: 'rgba(255,255,255,0.07)',
    border2: 'rgba(255,255,255,0.14)',
    text: '#e8eaed',
    muted: '#8b919a',
    faint: '#565b63',
    buy: '#2ebd85',
    sell: '#f6465d',
    accent: '#6ea8ff',
    warn: '#f0b90b',
    poc: '#f5c542',
    glow: 'rgba(110,168,255,0.28)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,255,255,0.04)',
    header: 'rgba(255,255,255,0.03)',
    rowAlt: 'rgba(255,255,255,0.015)',
    cell: 'rgba(0,0,0,0.25)',
    cellSpread: 'rgba(255,255,255,0.045)',
    tooltip: 'rgba(14,15,18,0.97)',
    tabbar: 'rgba(255,255,255,0.02)',
    rowLine: 'rgba(255,255,255,0.04)',
    accentSoft: 'rgba(110,168,255,0.12)',
    focus: 'rgba(110,168,255,0.28)',
    onAccent: '#06101f',
  }),
  'neon-green': build({
    id: 'neon-green',
    name: 'Neon Green',
    swatch: 'linear-gradient(135deg,#39ff14,#07100a)',
    dark: true,
    bg: '#050a07',
    bgImage: 'radial-gradient(1400px 500px at 50% -15%, rgba(57,255,20,0.07), transparent 70%), linear-gradient(180deg, #07100a 0%, #040805 100%)',
    glass: 'rgba(9,17,12,0.95)',
    glassStrong: 'rgba(10,19,13,0.97)',
    glassBorder: 'rgba(57,255,20,0.14)',
    glassHi: 'rgba(57,255,20,0.06)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45)',
    control: 'rgba(57,255,20,0.04)',
    raised: 'rgba(57,255,20,0.08)',
    border: 'rgba(57,255,20,0.11)',
    border2: 'rgba(57,255,20,0.24)',
    text: '#d8f5dc',
    muted: '#7fa886',
    faint: '#46634c',
    buy: '#39ff14',
    sell: '#ff3d6e',
    accent: '#39ff14',
    warn: '#e4ff3a',
    poc: '#e4ff3a',
    glow: 'rgba(57,255,20,0.35)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(57,255,20,0.055)',
    header: 'rgba(57,255,20,0.04)',
    rowAlt: 'rgba(57,255,20,0.02)',
    cell: 'rgba(0,0,0,0.3)',
    cellSpread: 'rgba(57,255,20,0.06)',
    tooltip: 'rgba(6,14,9,0.97)',
    tabbar: 'rgba(57,255,20,0.03)',
    rowLine: 'rgba(57,255,20,0.06)',
    accentSoft: 'rgba(57,255,20,0.1)',
    focus: 'rgba(57,255,20,0.25)',
    onAccent: '#04120a',
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
    swatch: 'linear-gradient(135deg,#ff7a00,#140902)',
    dark: true,
    bg: '#0b0603',
    bgImage: 'radial-gradient(1400px 500px at 50% -15%, rgba(255,122,0,0.08), transparent 70%), linear-gradient(180deg, #120904 0%, #080402 100%)',
    glass: 'rgba(20,12,6,0.95)',
    glassStrong: 'rgba(22,13,7,0.97)',
    glassBorder: 'rgba(255,122,0,0.16)',
    glassHi: 'rgba(255,122,0,0.06)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45)',
    control: 'rgba(255,122,0,0.045)',
    raised: 'rgba(255,122,0,0.09)',
    border: 'rgba(255,122,0,0.12)',
    border2: 'rgba(255,122,0,0.26)',
    text: '#fbe8d6',
    muted: '#bf946f',
    faint: '#6e5038',
    buy: '#00e5c0',
    sell: '#ff3b3b',
    accent: '#ff7a00',
    warn: '#ffd000',
    poc: '#ffd000',
    glow: 'rgba(255,122,0,0.38)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,122,0,0.055)',
    header: 'rgba(255,122,0,0.045)',
    rowAlt: 'rgba(255,122,0,0.02)',
    cell: 'rgba(0,0,0,0.3)',
    cellSpread: 'rgba(255,122,0,0.07)',
    tooltip: 'rgba(16,9,4,0.97)',
    tabbar: 'rgba(255,122,0,0.03)',
    rowLine: 'rgba(255,122,0,0.065)',
    accentSoft: 'rgba(255,122,0,0.12)',
    focus: 'rgba(255,122,0,0.28)',
    onAccent: '#1a0b00',
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
  { id: 'medium', name: 'Glass', blur: 16, cardBlur: false },
  { id: 'heavy', name: 'Frosted', blur: 22, cardBlur: true },
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
  ccxt: '#7f8cff',
  sim: '#b39ddb',
};
