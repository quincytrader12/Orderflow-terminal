import { describe, expect, it } from 'vitest';
import { initialWindow, MIN_H, MIN_W } from './windowState.mjs';

// a scaled 1366×768 laptop (125 %): 1093×582 usable after the taskbar
const laptop = { x: 0, y: 0, width: 1093, height: 582 };
const fullHd = { x: 0, y: 0, width: 1920, height: 1040 };

describe('initial window placement', () => {
  it('first launch: maximised, sized from the screen, never larger than it', () => {
    const w = initialWindow(undefined, [laptop]);
    expect(w.maximized).toBe(true);
    expect(w.bounds.width).toBeLessThanOrEqual(laptop.width);
    expect(w.bounds.height).toBeLessThanOrEqual(laptop.height);
    expect(w.bounds.x).toBeGreaterThanOrEqual(0);
  });

  it('reuses the last size and position, shrunk to the display', () => {
    const w = initialWindow({ bounds: { x: 100, y: 50, width: 1600, height: 1000 }, maximized: false }, [laptop]);
    expect(w.maximized).toBe(false);
    expect(w.bounds).toEqual({ x: 0, y: 0, width: 1093, height: 582 });
    const ok = initialWindow({ bounds: { x: 200, y: 100, width: 1200, height: 800 }, maximized: false }, [fullHd]);
    expect(ok.bounds).toEqual({ x: 200, y: 100, width: 1200, height: 800 });
  });

  it('a window left on a monitor that is gone comes back to the primary display', () => {
    const w = initialWindow({ bounds: { x: 2500, y: 0, width: 1200, height: 800 }, maximized: false }, [fullHd]);
    expect(w.maximized).toBe(true);
    expect(w.bounds.x + w.bounds.width).toBeLessThanOrEqual(fullHd.width);
  });

  it('keeps the minimum size sensible and ignores junk', () => {
    const w = initialWindow({ bounds: { x: 0, y: 0, width: 300, height: 200 }, maximized: false }, [fullHd]);
    expect(w.bounds.width).toBe(MIN_W);
    expect(w.bounds.height).toBe(MIN_H);
    // a sliver too small to matter is treated as no saved position
    expect(initialWindow({ bounds: { x: 0, y: 0, width: 50, height: 20 }, maximized: false }, [fullHd]).maximized).toBe(true);
    expect(initialWindow({ bounds: { x: 'a' } }, [fullHd]).maximized).toBe(true);
  });
});

describe('full screen', () => {
  const fullHd = { x: 0, y: 0, width: 1920, height: 1040 };
  it('starts full screen (taskbar hidden) by default and for state saved before it was the default', () => {
    expect(initialWindow(undefined, [fullHd]).fullScreen).toBe(true);
    expect(initialWindow({ bounds: { x: 0, y: 0, width: 1500, height: 900 }, maximized: true, fullScreen: false }, [fullHd]).fullScreen).toBe(true);
  });
  it('remembers leaving full screen once that is a choice', () => {
    expect(initialWindow({ v: 2, bounds: { x: 0, y: 0, width: 1500, height: 900 }, maximized: true, fullScreen: false }, [fullHd]).fullScreen).toBe(false);
    expect(initialWindow({ v: 2, bounds: { x: 0, y: 0, width: 1500, height: 900 }, maximized: true, fullScreen: true }, [fullHd]).fullScreen).toBe(true);
  });
});
