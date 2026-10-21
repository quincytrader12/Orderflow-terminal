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

/** Salt and SHA-256 digest of a ledger key; the key itself is never stored. */
export interface LedgerRecord {
  salt: string;
  digest: string;
}

/** Built-in key, used until the owner sets their own in Settings. */
export const DEFAULT_LEDGER: LedgerRecord = { salt: SALT, digest: LEDGER_DIGEST };

export function isLedgerRecord(x: unknown): x is LedgerRecord {
  const r = x as LedgerRecord;
  return Boolean(r && typeof r.salt === 'string' && r.salt.length >= 8 && /^[0-9a-f]{64}$/.test(r.digest ?? ''));
}

type Sha = (s: string) => Promise<string> | string;

export async function ledgerMatches(input: string, sha256Hex: Sha, rec: LedgerRecord = DEFAULT_LEDGER): Promise<boolean> {
  const digits = normalizeKey(input);
  if (digits.length !== LEDGER_LENGTH) return false;
  const h = await sha256Hex(rec.salt + digits);
  // constant-time compare
  let diff = h.length ^ rec.digest.length;
  for (let i = 0; i < rec.digest.length; i++) diff |= (h.charCodeAt(i) || 0) ^ rec.digest.charCodeAt(i);
  return diff === 0;
}

/** Reasons a new key is refused, or null when it is acceptable. */
export function weakKeyReason(input: string): string | null {
  const d = normalizeKey(input);
  if (d.length !== LEDGER_LENGTH) return `the key must be ${LEDGER_LENGTH} digits`;
  if (/^(\d)\1+$/.test(d)) return 'all digits are the same';
  if ('0123456789012345'.includes(d) || '9876543210987654'.includes(d)) return 'digits run in sequence';
  return null;
}

/** New record for a key, with a fresh random salt (hex). */
export async function makeLedger(input: string, sha256Hex: Sha, randomHex: string): Promise<LedgerRecord> {
  const why = weakKeyReason(input);
  if (why) throw new Error(`Choose another key: ${why}`);
  const salt = `novus-ordo/ledger/${randomHex}:`;
  return { salt, digest: await sha256Hex(salt + normalizeKey(input)) };
}

/** Wrong attempts lock input for a while: 5 free tries, then 30 s, doubling. */
export class AttemptGate {
  private fails = 0;
  private until = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
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
  'app:seal',
  'app:fullscreen',
  'app:isFullscreen',
  'app:log',
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
