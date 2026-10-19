import type { IJsonModel, IJsonRowNode, IJsonTabNode, IJsonTabSetNode } from 'flexlayout-react';
import { PANEL_MAP } from '../panels/registry';
import { safeStorage } from '../store/settings';

let seq = 0;
export function tab(component: string, config: Record<string, unknown> = {}, name?: string): IJsonTabNode {
  const def = PANEL_MAP[component];
  return {
    type: 'tab',
    id: `${component}-${Date.now().toString(36)}-${seq++}`,
    name: name ?? def?.title ?? component,
    component,
    config: { ...(def?.defaults ?? {}), ...config },
  };
}
const ts = (weight: number, ...children: IJsonTabNode[]): IJsonTabSetNode => ({ type: 'tabset', weight, children });
const row = (weight: number, ...children: (IJsonRowNode | IJsonTabSetNode)[]): IJsonRowNode => ({ type: 'row', weight, children });

export const GLOBAL: IJsonModel['global'] = {
  tabEnableRename: true,
  tabEnablePopout: false,
  tabEnableFloat: false,
  tabSetMinWidth: 160,
  tabSetMinHeight: 90,
  tabSetEnableMaximize: true,
  enableEdgeDock: true,
  borderEnableAutoHide: true,
};

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** schematic used for the gallery thumbnail: grid-template + labelled cells */
  thumb: { cols: string; rows: string; cells: [string, string][] };
  build: () => IJsonModel;
}

/** Collapsible dock edges; hidden until a panel is placed in them. */
export const BORDERS: IJsonModel['borders'] = (['left', 'right', 'bottom'] as const).map((location) => ({ type: 'border', location, enableAutoHide: true, size: location === 'bottom' ? 260 : 340, children: [] }));

const model = (layout: IJsonRowNode): IJsonModel => ({ global: GLOBAL, borders: BORDERS, layout });

export const PRESETS: Preset[] = [
  {
    id: 'center',
    name: 'Chart Center',
    description: 'The footprint chart in the middle, DOM and order ticket on the left, flow and account on the right — every split is draggable.',
    thumb: { cols: '1fr 3fr 1.3fr', rows: '2.4fr 1fr', cells: [['DOM', '1/1/2/2'], ['Ticket · Book', '2/1/3/2'], ['CHART', '1/2/2/3'], ['CVD · Liqs', '2/2/3/3'], ['Tape', '1/3/2/4'], ['Summary · Wallet', '2/3/3/4']] },
    build: () =>
      model(
        row(
          100,
          row(17, ts(52, tab('dom')), ts(48, tab('ticket'), tab('orderbook'), tab('obstats'))),
          row(59, ts(72, tab('footprint'), tab('historical'), tab('heatmap')), ts(28, tab('cvd'), tab('liquidations'), tab('vprofile'), tab('accounts'))),
          row(24, ts(46, tab('tape'), tab('whales')), ts(30, tab('summary'), tab('flowpulse'), tab('funding')), ts(24, tab('wallet'), tab('alerts'), tab('database'))),
        ),
      ),
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Footprint, DOM, tape and heatmap with CVD and symbol summary.',
    thumb: { cols: '2fr 1fr 1fr', rows: '2fr 1fr', cells: [['Footprint', '1/1/2/2'], ['DOM', '1/2/3/3'], ['Tape', '1/3/2/4'], ['Heatmap', '2/1/3/2'], ['Summary', '2/3/3/4']] },
    build: () =>
      model(
        row(
          100,
          row(58, ts(65, tab('footprint'), tab('historical')), ts(35, tab('heatmap'), tab('cvd'), tab('vprofile'))),
          ts(20, tab('dom')),
          row(22, ts(60, tab('tape'), tab('whales')), ts(40, tab('summary'), tab('flowpulse'), tab('alerts'))),
        ),
      ),
  },
  {
    id: 'flow',
    name: 'Flow Desk',
    description: 'Footprint, tape, Flow Pulse, CVD and liquidations.',
    thumb: { cols: '2fr 1fr', rows: '1fr 1fr 1fr', cells: [['Footprint', '1/1/3/2'], ['Tape', '1/2/2/3'], ['Flow Pulse', '2/2/3/3'], ['CVD', '3/1/4/2'], ['Liquidations', '3/2/4/3']] },
    build: () =>
      model(
        row(
          100,
          row(66, ts(68, tab('footprint', { style: 'delta' })), ts(32, tab('cvd'))),
          row(34, ts(45, tab('tape')), ts(25, tab('flowpulse')), ts(30, tab('liquidations'))),
        ),
      ),
  },
  {
    id: 'scalper',
    name: 'Scalper',
    description: 'DOM ladder next to a fast footprint, heatmap and tape.',
    thumb: { cols: '1fr 2fr 1fr', rows: '1fr 1fr', cells: [['DOM', '1/1/3/2'], ['Footprint 15s', '1/2/2/3'], ['Heatmap', '2/2/3/3'], ['Tape', '1/3/3/4']] },
    build: () =>
      model(
        row(
          100,
          ts(22, tab('dom', { range: '15m' })),
          row(53, ts(55, tab('footprint', { interval: '15s', lookback: '1h', ovHeatmap: true })), ts(45, tab('heatmap', { span: '5m' }))),
          ts(25, tab('tape', { minNotional: 5000 })),
        ),
      ),
  },
  {
    id: 'liquidity',
    name: 'Liquidity',
    description: 'Composite heatmap, aggregated book, depth and book stats.',
    thumb: { cols: '2fr 1fr', rows: '2fr 1fr', cells: [['Heatmap Σ', '1/1/2/2'], ['Orderbook Σ', '1/2/3/3'], ['Depth', '2/1/3/2']] },
    build: () =>
      model(
        row(
          100,
          row(68, ts(68, tab('heatmap', { composite: true, span: '30m' })), row(32, ts(50, tab('depth')), ts(50, tab('obstats')))),
          ts(32, tab('orderbook')),
        ),
      ),
  },
  {
    id: 'derivs',
    name: 'Derivatives',
    description: 'Funding, open interest, liquidations, spreads and summary.',
    thumb: { cols: '1fr 1fr', rows: '1fr 1fr 1fr', cells: [['Summary', '1/1/2/2'], ['Funding', '1/2/2/3'], ['Open interest', '2/1/3/3'], ['Liqs', '3/1/4/2'], ['Spread', '3/2/4/3']] },
    build: () =>
      model(
        row(
          100,
          row(50, ts(34, tab('summary')), ts(33, tab('oi')), ts(33, tab('liquidations'))),
          row(50, ts(34, tab('funding')), ts(33, tab('spread')), ts(33, tab('options'))),
        ),
      ),
  },
  {
    id: 'macro',
    name: 'Market Overview',
    description: 'Historical chart with TPO, screener, watchlist and news.',
    thumb: { cols: '2fr 1fr', rows: '1fr 1fr', cells: [['Historical', '1/1/3/2'], ['Screener', '1/2/2/3'], ['News', '2/2/3/3']] },
    build: () =>
      model(
        row(
          100,
          row(62, ts(65, tab('historical', { interval: '1h', svp: true }), tab('historical', { mode: 'tpo' }, 'TPO Profile')), ts(35, tab('watchlist'), tab('summary'))),
          row(38, ts(55, tab('screener')), ts(45, tab('news'))),
        ),
      ),
  },
  {
    id: 'whales',
    name: 'Whale Watch',
    description: 'Whale tracker, large-print tape, liquidations and composite heatmap.',
    thumb: { cols: '1fr 1fr', rows: '1fr 1fr', cells: [['Whales', '1/1/2/2'], ['Heatmap Σ', '1/2/3/3'], ['Tape $100k+', '2/1/3/2']] },
    build: () =>
      model(
        row(
          100,
          row(50, ts(55, tab('whales')), ts(45, tab('tape', { minNotional: 100_000 }))),
          row(50, ts(60, tab('heatmap', { composite: true, tradeMin: 100_000 })), ts(40, tab('liquidations', { minNotional: 25_000 }))),
        ),
      ),
  },
  {
    id: 'options',
    name: 'Options',
    description: 'Deribit options flow with spot context.',
    thumb: { cols: '2fr 1fr', rows: '1fr', cells: [['Options flow', '1/1/2/2'], ['Historical', '1/2/2/3']] },
    build: () => model(row(100, ts(60, tab('options')), row(40, ts(55, tab('historical', { interval: '1h' })), ts(45, tab('summary'), tab('funding'))))),
  },
];

// bumped when the default layout changes so existing installs get the new default once
const LAYOUT_KEY = 'novus-layout-v2';
const SAVED_KEY = 'oft-saved-layouts';

export function loadLayout(): IJsonModel {
  try {
    const raw = safeStorage.getItem(LAYOUT_KEY) as string | null;
    if (raw) {
      const json = JSON.parse(raw) as IJsonModel;
      if (json?.layout) return sanitize(json);
    }
  } catch {
    /* fall through to default */
  }
  return PRESETS[0].build();
}

/** Drop tabs whose component no longer exists and fill in new config defaults. */
export function sanitize(json: IJsonModel): IJsonModel {
  const walk = (n: any): any => {
    if (n.type === 'tab') {
      const def = PANEL_MAP[n.component];
      if (!def) return null;
      return { ...n, config: { ...def.defaults, ...(n.config ?? {}) } };
    }
    if (n.children) n.children = n.children.map(walk).filter(Boolean);
    return n;
  };
  const borders = (json.borders ?? []).map((b) => walk(b));
  for (const def of BORDERS ?? []) if (!borders.some((b: { location: string }) => b.location === def.location)) borders.push(def);
  return { ...json, global: { ...GLOBAL, ...(json.global ?? {}) }, borders, layout: walk(json.layout) };
}

export function saveLayout(json: IJsonModel) {
  safeStorage.setItem(LAYOUT_KEY, JSON.stringify(json));
}

export interface SavedLayout {
  name: string;
  time: number;
  json: IJsonModel;
}

export function listSaved(): SavedLayout[] {
  try {
    return JSON.parse((safeStorage.getItem(SAVED_KEY) as string | null) ?? '[]');
  } catch {
    return [];
  }
}

export function saveNamed(name: string, json: IJsonModel) {
  const list = listSaved().filter((l) => l.name !== name);
  list.unshift({ name, time: Date.now(), json });
  safeStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 30)));
}

export function deleteNamed(name: string) {
  safeStorage.setItem(SAVED_KEY, JSON.stringify(listSaved().filter((l) => l.name !== name)));
}
