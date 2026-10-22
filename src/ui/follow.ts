/**
 * Live follow for charts: a chart follows the market until the owner pans
 * it, then returns to live on its own once they have left it alone for
 * RESUME_MS — but not while the pointer is still moving over the chart
 * (they are reading it).
 */
export const RESUME_MS = 10_000;
const READING_MS = 3_000;

export interface Follow {
  live: boolean;
  /** last manual pan or scroll */
  touchedAt: number;
  /** last pointer movement over the chart */
  hoverAt: number;
}

export const newFollow = (): Follow => ({ live: true, touchedAt: 0, hoverAt: 0 });

/** The owner moved the view: stop following for now. */
export function pause(f: Follow, now = performance.now()) {
  f.live = false;
  f.touchedAt = now;
}

export function hovered(f: Follow, now = performance.now()) {
  f.hoverAt = now;
}

/** True once a paused chart should go back to live. */
export function shouldResume(f: Follow, now = performance.now()) {
  return !f.live && now - f.touchedAt >= RESUME_MS && now - f.hoverAt >= READING_MS;
}

/** Seconds until a paused chart returns to live (for the chip). */
export function resumeIn(f: Follow, now = performance.now()) {
  return f.live ? 0 : Math.max(0, Math.ceil((RESUME_MS - (now - f.touchedAt)) / 1000));
}
