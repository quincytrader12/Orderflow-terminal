/**
 * Ledger key that unlocks the terminal. Only a salted SHA-256 digest is
 * stored here; the desktop process checks it again before it releases API
 * keys, trading, bots, wallets or Telegram.
 */

const SALT = 'novus-ordo/ledger/v1:';
export const LEDGER_DIGEST = 'a8a5170c2d6e88c3f597fd89a2765c28f87c3d77ad8afeaa310b697cd10f5fd7';
export const LEDGER_LENGTH = 8;

/** Digits only: spaces, dashes and slashes between the digits are ignored. */
export function normalizeKey(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

export async function ledgerMatches(input: string, sha256Hex: (s: string) => Promise<string> | string): Promise<boolean> {
  const digits = normalizeKey(input);
  if (digits.length !== LEDGER_LENGTH) return false;
  const h = await sha256Hex(SALT + digits);
  // constant-time compare
  let diff = h.length ^ LEDGER_DIGEST.length;
  for (let i = 0; i < LEDGER_DIGEST.length; i++) diff |= (h.charCodeAt(i) || 0) ^ LEDGER_DIGEST.charCodeAt(i);
  return diff === 0;
}

/** Wrong attempts lock input for a while: 5 free tries, then 30 s, doubling. */
export class AttemptGate {
  private fails = 0;
  private until = 0;
  constructor(private now: () => number = Date.now) {}
  waitMs() {
    return Math.max(0, this.until - this.now());
  }
  check() {
    const w = this.waitMs();
    if (w > 0) throw new Error(`LOCKED OUT — retry in ${Math.ceil(w / 1000)}s`);
  }
  fail() {
    this.fails++;
    if (this.fails >= 5) this.until = this.now() + 30_000 * 2 ** (this.fails - 5);
  }
  success() {
    this.fails = 0;
    this.until = 0;
  }
}

/** IPC channels that only carry public market data and stay open while locked. */
export const PUBLIC_CHANNELS = new Set([
  'app:info',
  'app:unlock',
  'app:locked',
  'shell:open',
  'net:fetchJson',
  'ccxt:exchanges',
  'ccxt:markets',
  'ccxt:ohlcv',
  'ccxt:tickers',
  'ccxt:ticker',
  'ccxt:subscribe',
  'ccxt:unsubscribe',
  'db:info',
  'db:record',
  'db:query',
  'db:stats',
]);
