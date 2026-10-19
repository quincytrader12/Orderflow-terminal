// Shared e2e helpers for the ledger-key lock screen. Tests never use the
// owner's key: they seed a throwaway key (salted digest only) into the
// browser's storage or into a fresh desktop database before launch.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Db } from '../electron/db.mjs';
import { makeLedger } from '../src/shared/ledger.ts';

export const TEST_KEY = '58204719';
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const testLedger = (key = TEST_KEY) => makeLedger(key, sha, randomBytes(16).toString('hex'));

/** Browser builds: store the test key's digest before the app script runs. */
export async function seedWebLedger(ctx, key = TEST_KEY) {
  const rec = await testLedger(key);
  await ctx.addInitScript((r) => localStorage.setItem('novus-ledger', r), JSON.stringify(rec));
}

/** Desktop: write the test key's digest into a fresh user-data database. */
export async function seedDesktopLedger(userData, key = TEST_KEY) {
  const db = new Db(join(userData, 'novus-ordo.sqlite'));
  db.set('ledger', await testLedger(key));
  db.close();
}

export async function unlock(page, key = TEST_KEY) {
  await page.waitForSelector('.lock-key input, .topbar, .embed-root', { timeout: 30_000 });
  if (await page.locator('.lock-key input').count()) {
    await page.locator('.lock-key input').fill(key);
    await page.waitForSelector('.lock', { state: 'detached', timeout: 15_000 });
  }
}
