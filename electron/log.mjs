// Plain-text log in <userData>/logs/novus.log: startup timings and every error
// from the main process and the window, so problems on a user's machine can
// be diagnosed (Help → Open log folder).
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 2_000_000;
let file = null;
const t0 = Date.now();

export function initLog(dir) {
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'novus.log');
  try {
    // keep one previous log
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'novus.old.log'));
  } catch {
    /* rotation is best effort */
  }
  return file;
}

export function log(level, ...parts) {
  const msg = parts.map((p) => (p instanceof Error ? `${p.message}\n${p.stack ?? ''}` : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(2)}s ${level.toUpperCase()} ${msg}\n`;
  if (level === 'error') process.stderr.write(line);
  if (!file) return;
  try {
    appendFileSync(file, line);
  } catch {
    /* disk full or read-only: never crash because of logging */
  }
}

export const logFile = () => file;
