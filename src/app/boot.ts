import { create } from 'zustand';
import emblem from '../assets/emblem.png';
import { fmtNum } from '../core/format';
import { desktop } from '../desktop/bridge';
import { startCollectors } from '../market/collectors';
import { hub } from '../market/hub';
import { getSettings } from '../store/settings';
import { THEMES } from '../ui/theme';
import { loadLayout } from './layouts';

/**
 * Secure-boot sequence shown on the lock screen: the terminal really loads
 * these assets while it waits for the ledger key, so the panels open warm.
 */

export type StepState = 'loading' | 'done' | 'warn';

export interface BootStep {
  id: string;
  label: string;
  detail: string;
  state: StepState;
  started: number;
  ms?: number;
}

interface BootStore {
  steps: BootStep[];
  done: boolean;
  put(step: BootStep): void;
  finish(): void;
}

export const useBoot = create<BootStore>((set) => ({
  steps: [],
  done: false,
  put: (step) =>
    set((s) => {
      const i = s.steps.findIndex((x) => x.id === step.id);
      const steps = i < 0 ? [...s.steps, step] : s.steps.map((x, j) => (j === i ? step : x));
      return { steps };
    }),
  finish: () => set({ done: true }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a value or the timeout passes. */
async function until<T>(fn: () => T | undefined | null | false, timeoutMs: number, every = 150): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return undefined;
    await sleep(every);
  }
}

async function step(id: string, label: string, run: (progress: (detail: string) => void) => Promise<string | { detail: string; warn: boolean }>) {
  const { put } = useBoot.getState();
  const started = Date.now();
  put({ id, label, detail: '…', state: 'loading', started });
  try {
    const out = await run((detail) => put({ id, label, detail, state: 'loading', started }));
    // keep each line on screen long enough to read
    const ms = Date.now() - started;
    if (ms < 220) await sleep(220 - ms);
    const r = typeof out === 'string' ? { detail: out, warn: false } : out;
    put({ id, label, detail: r.detail, state: r.warn ? 'warn' : 'done', started, ms: Date.now() - started });
  } catch (e) {
    put({ id, label, detail: String((e as Error).message ?? e).slice(0, 80), state: 'warn', started, ms: Date.now() - started });
  }
}

let started = false;

export function runBoot() {
  if (started) return;
  started = true;
  void (async () => {
    const s = getSettings();
    await step('shell', 'Interface shell', async () => `React runtime · ${navigator.hardwareConcurrency || '?'} cores`);
    await step('emblem', 'Emblem asset', async () => {
      const img = new Image();
      img.src = emblem;
      await img.decode();
      return `emblem.png · ${img.naturalWidth}×${img.naturalHeight}`;
    });
    await step('fonts', 'Typefaces', async () => {
      await document.fonts.ready;
      return `${document.fonts.size || 0} faces ready`;
    });
    await step('theme', 'Theme', async () => `${THEMES[s.theme]?.name ?? s.theme}${s.filter !== 'none' ? ` · ${s.filter} filter` : ''}`);
    if (desktop) {
      const info = await desktop.app.info().catch(() => null);
      await step('ledger', 'Ledger database', async () => (info ? `novus-ordo.sqlite · ${fmtNum(info.db.trades, 1)} trades · ${(info.db.size / 1e6).toFixed(0)} MB` : { detail: 'unavailable', warn: true }));
      await step('vault', 'Key vault', async () => (info ? `${info.db.secrets} keys sealed · ${info.vaultBackend === 'os' ? 'OS keychain' : 'AES-256 local key'}` : { detail: 'unavailable', warn: true }));
      await step('ccxt', 'Exchange connectors', async () => `${(await desktop!.ccxt.exchanges()).length} CCXT exchanges indexed`);
    }
    await step('hub', 'Market hub', async (progress) => {
      const H = hub();
      const f = H.primary;
      progress(`${f.adapter.name} ${f.inst.symbol} · connecting`);
      const ok = await until(() => f.status.state === 'open', 10_000);
      return ok ? `${f.adapter.name} ${f.inst.symbol} · live` : { detail: `${f.adapter.name} ${f.inst.symbol} · ${f.status.state}${f.status.error ? ` (${f.status.error.slice(0, 40)})` : ''}`, warn: true };
    });
    await step('venues', 'Aggregate venues', async (progress) => {
      const H = hub();
      const count = () => H.aggregate.filter((x) => x.status.state === 'open').length;
      await until(() => {
        progress(`${count()}/${H.aggregate.length} streaming`);
        return count() === H.aggregate.length;
      }, 5000);
      const n = count();
      return { detail: `${n}/${H.aggregate.length} venues streaming`, warn: n < H.aggregate.length };
    });
    await step('history', 'History backfill', async (progress) => {
      const H = hub();
      if (s.historySource === 'none') return 'live only (no backfill)';
      await until(() => {
        const b = H.backfill;
        if (b.state === 'loading') progress(`${Math.round(b.progress * 100)}% · ${fmtNum(b.count, 1)} trades`);
        return b.state === 'done' || b.state === 'error';
      }, 15_000);
      const b = H.backfill;
      return b.state === 'error' ? { detail: b.message.slice(0, 60) || 'failed', warn: true } : b.state === 'done' ? `${fmtNum(b.count, 1)} trades · ${s.historySource}` : { detail: 'continuing in background', warn: false };
    });
    await step('flow', 'Order-flow collectors', async () => {
      startCollectors();
      return 'whales · liquidations · tape';
    });
    await step('layout', 'Workspace layout', async () => {
      const json = loadLayout();
      let tabs = 0;
      const walk = (n: any) => {
        if (n?.type === 'tab') tabs++;
        (n?.children ?? []).forEach(walk);
      };
      walk(json.layout);
      (json.borders ?? []).forEach(walk);
      return `${tabs} panels restored`;
    });
    await step('seal', 'Ledger seal', async () => 'armed — awaiting key');
    useBoot.getState().finish();
  })();
}
