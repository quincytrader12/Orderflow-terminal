import { describe, expect, it } from 'vitest';
import { BOOT_PLAN, bootProgress, stepFraction } from './bootProgress';

const plan = (id: string) => BOOT_PLAN.find((p) => p.id === id)!;

describe('boot progress', () => {
  it('starts at zero and is complete when the boot finishes', () => {
    expect(bootProgress([], true, 0).overall).toBe(0);
    expect(bootProgress([], true, 0, true).overall).toBe(1);
  });

  it('counts finished steps by weight and splits into three phases', () => {
    const t = 1_000;
    const done = ['shell', 'emblem', 'fonts', 'theme', 'ledger', 'vault'].map((id) => ({ id, state: 'done' as const, started: 0 }));
    const p = bootProgress(done, true, t);
    expect(p.phases.map((x) => x.id)).toEqual(['core', 'connectors', 'markets']);
    expect(p.phases[0]).toMatchObject({ frac: 1, done: 6, steps: 6 });
    expect(p.phases[1].frac).toBe(0);
    const core = BOOT_PLAN.filter((x) => x.phase === 'core').reduce((a, x) => a + x.weight, 0);
    const all = BOOT_PLAN.reduce((a, x) => a + x.weight, 0);
    expect(p.overall).toBeCloseTo(core / all, 6);
  });

  it('uses reported fractions, and eases toward 90% when a step cannot report', () => {
    expect(stepFraction({ id: 'history', state: 'loading', started: 0, frac: 0.4 }, plan('history'), 5_000)).toBe(0.4);
    const early = stepFraction({ id: 'hub', state: 'loading', started: 0 }, plan('hub'), 300);
    const late = stepFraction({ id: 'hub', state: 'loading', started: 0 }, plan('hub'), 60_000);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThanOrEqual(0.9);
    expect(stepFraction({ id: 'hub', state: 'warn', started: 0 }, plan('hub'), 1)).toBe(1);
  });

  it('leaves desktop-only steps out of browser builds', () => {
    const web = bootProgress([], false, 0);
    expect(web.phases[0].steps).toBe(4);
    expect(web.phases[1].steps).toBe(1);
  });
});
