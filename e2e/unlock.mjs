// Shared e2e helper: get past the ledger-key lock screen. The key is never
// committed: set NOVUS_LEDGER_KEY (CI uses a repository secret) or put it in
// e2e/.ledger-key (git-ignored).
import { existsSync, readFileSync } from 'node:fs';

const keyFile = new URL('./.ledger-key', import.meta.url);
export const LEDGER_KEY = process.env.NOVUS_LEDGER_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');

export async function unlock(page, key = LEDGER_KEY) {
  if (!key) throw new Error('Set NOVUS_LEDGER_KEY (or e2e/.ledger-key) to run the e2e tests');
  await page.waitForSelector('.lock-key input, .topbar, .embed-root', { timeout: 30_000 });
  if (await page.locator('.lock-key input').count()) {
    await page.locator('.lock-key input').fill(key);
    await page.waitForSelector('.lock', { state: 'detached', timeout: 15_000 });
  }
}
