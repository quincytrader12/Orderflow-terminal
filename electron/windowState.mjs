// Window size and position across launches. Pure helpers (tested) plus a
// small JSON file in the user data folder.
import { readFileSync, writeFileSync } from 'node:fs';

export const MIN_W = 640;
export const MIN_H = 400;

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where the window opens. A saved position is reused only if a good part of
 * it is still on a connected display (monitors change), and it is shrunk to
 * fit that display's work area; otherwise it opens centred on the primary
 * display. Opens full screen (taskbar hidden) and maximised underneath,
 * unless the user last left it otherwise.
 * `displays` are work areas, the primary first.
 */
export function initialWindow(saved, displays) {
  const valid = saved?.bounds && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved.bounds[k]));
  const home = valid ? displays.slice().sort((a, b) => overlap(saved.bounds, b) - overlap(saved.bounds, a))[0] : undefined;
  if (valid && home && overlap(saved.bounds, home) >= 100 * 100) {
    const width = Math.max(MIN_W, Math.min(saved.bounds.width, home.width));
    const height = Math.max(MIN_H, Math.min(saved.bounds.height, home.height));
    const x = Math.min(Math.max(saved.bounds.x, home.x), home.x + home.width - width);
    const y = Math.min(Math.max(saved.bounds.y, home.y), home.y + home.height - height);
    // full screen is the default; only a choice made since it became the
    // default (state version 2) turns it off
    return { bounds: { x, y, width, height }, maximized: saved.maximized !== false, fullScreen: saved.v === 2 ? Boolean(saved.fullScreen) : true };
  }
  const wa = displays[0];
  const width = Math.max(Math.min(MIN_W, wa.width), Math.round(wa.width * 0.9));
  const height = Math.max(Math.min(MIN_H, wa.height), Math.round(wa.height * 0.9));
  return { bounds: { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height }, maximized: true, fullScreen: true };
}

export function loadWindowState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function saveWindowState(file, w) {
  try {
    writeFileSync(file, JSON.stringify({ v: 2, bounds: w.getNormalBounds(), maximized: w.isMaximized(), fullScreen: w.isFullScreen() }));
  } catch {
    /* not worth failing a close over */
  }
}
