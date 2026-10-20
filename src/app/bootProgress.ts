/**
 * Overall secure-boot progress. Every planned step has a weight and belongs
 * to one of three phases (the three segments of the boot ring). A finished
 * step counts fully; a running step counts its reported fraction, or eases
 * toward 90 % of its expected duration so the ring never looks frozen.
 */

export type Phase = 'core' | 'connectors' | 'markets';

export interface PlannedStep {
  id: string;
  phase: Phase;
  weight: number;
  /** typical duration, for the eased estimate while it runs */
  expectMs: number;
  desktopOnly?: boolean;
}

export const PHASES: { id: Phase; label: string }[] = [
  { id: 'core', label: 'Core assets' },
  { id: 'connectors', label: 'Exchange connectors' },
  { id: 'markets', label: 'Market data' },
];

export const BOOT_PLAN: PlannedStep[] = [
  { id: 'shell', phase: 'core', weight: 1, expectMs: 200 },
  { id: 'emblem', phase: 'core', weight: 1, expectMs: 300 },
  { id: 'fonts', phase: 'core', weight: 1, expectMs: 300 },
  { id: 'theme', phase: 'core', weight: 1, expectMs: 200 },
  { id: 'ledger', phase: 'core', weight: 2, expectMs: 400, desktopOnly: true },
  { id: 'vault', phase: 'core', weight: 1, expectMs: 300, desktopOnly: true },
  { id: 'ccxt', phase: 'connectors', weight: 3, expectMs: 1500, desktopOnly: true },
  { id: 'hub', phase: 'connectors', weight: 4, expectMs: 3000 },
  { id: 'venues', phase: 'markets', weight: 3, expectMs: 3000 },
  { id: 'history', phase: 'markets', weight: 4, expectMs: 6000 },
  { id: 'flow', phase: 'markets', weight: 1, expectMs: 200 },
  { id: 'layout', phase: 'markets', weight: 1, expectMs: 200 },
  { id: 'seal', phase: 'markets', weight: 1, expectMs: 200 },
];

export interface StepState {
  id: string;
  state: 'loading' | 'done' | 'warn';
  started: number;
  /** 0–1 when the step reports its own progress */
  frac?: number;
}

export function stepFraction(s: StepState | undefined, plan: PlannedStep, now: number): number {
  if (!s) return 0;
  if (s.state !== 'loading') return 1;
  if (s.frac !== undefined && Number.isFinite(s.frac)) return Math.max(0, Math.min(0.99, s.frac));
  // eased estimate: approaches 0.9 as the step runs past its expected time
  return 0.9 * (1 - Math.exp(-(now - s.started) / plan.expectMs));
}

export interface BootProgress {
  overall: number;
  phases: { id: Phase; label: string; frac: number; steps: number; done: number }[];
}

export function bootProgress(steps: StepState[], desktop: boolean, now: number, finished = false): BootProgress {
  const plan = BOOT_PLAN.filter((p) => desktop || !p.desktopOnly);
  const byId = new Map(steps.map((s) => [s.id, s]));
  let total = 0;
  let got = 0;
  const phases = PHASES.map((ph) => {
    const items = plan.filter((p) => p.phase === ph.id);
    let w = 0;
    let g = 0;
    let done = 0;
    for (const p of items) {
      const f = finished ? 1 : stepFraction(byId.get(p.id), p, now);
      w += p.weight;
      g += p.weight * f;
      if (f >= 1) done++;
    }
    total += w;
    got += g;
    return { id: ph.id, label: ph.label, frac: w ? g / w : 1, steps: items.length, done };
  });
  return { overall: finished ? 1 : total ? got / total : 0, phases };
}
