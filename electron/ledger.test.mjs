import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AttemptGate, DEFAULT_LEDGER, isLedgerRecord, ledgerMatches, makeLedger, normalizeKey, PUBLIC_CHANNELS, weakKeyReason } from '../src/shared/ledger.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex');

describe('ledger key', () => {
  // the real key is not committed: NOVUS_LEDGER_KEY or e2e/.ledger-key
  const keyFile = new URL('../e2e/.ledger-key', import.meta.url);
  const KEY = process.env.NOVUS_LEDGER_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');

  it.skipIf(!KEY)('accepts the key in any digit format', async () => {
    const [y, m, d] = [KEY.slice(0, 4), KEY.slice(4, 6), KEY.slice(6)];
    for (const k of [KEY, `${y} ${m} ${d}`, `${y}-${m}-${d}`, ` ${y}/${m}/${d} `]) expect(await ledgerMatches(k, sha)).toBe(true);
    expect(await ledgerMatches(KEY.slice(0, 7), sha)).toBe(false);
    expect(await ledgerMatches(`${KEY}0`, sha)).toBe(false);
  });

  it('rejects other keys', async () => {
    for (const k of ['', '1234567', '12345678', '00000000', 'password', '87654321']) expect(await ledgerMatches(k, sha)).toBe(false);
    expect(normalizeKey('1234 56-78')).toBe('12345678');
  });

  it('ships only a digest, never the key itself', () => {
    const src = readFileSync(new URL('../src/shared/ledger.ts', import.meta.url), 'utf8');
    if (KEY) expect(src).not.toContain(KEY);
    expect(src).toMatch(/LEDGER_DIGEST = '[0-9a-f]{64}'/);
  });

  it('lets the owner set their own key; the old one stops working', async () => {
    const rec = await makeLedger('5820 4719', sha, 'ab'.repeat(16));
    expect(isLedgerRecord(rec)).toBe(true);
    expect(rec.salt).not.toBe(DEFAULT_LEDGER.salt);
    expect(JSON.stringify(rec)).not.toContain('58204719');
    expect(await ledgerMatches('58204719', sha, rec)).toBe(true);
    expect(await ledgerMatches('58204718', sha, rec)).toBe(false);
    if (KEY) expect(await ledgerMatches(KEY, sha, rec)).toBe(false);
    // same key, different salt → different digest
    expect((await makeLedger('58204719', sha, 'cd'.repeat(16))).digest).not.toBe(rec.digest);
  });

  it('refuses weak or malformed new keys', async () => {
    expect(weakKeyReason('11111111')).toMatch(/same/);
    expect(weakKeyReason('12345678')).toMatch(/sequence/);
    expect(weakKeyReason('87654321')).toMatch(/sequence/);
    expect(weakKeyReason('1234')).toMatch(/8 digits/);
    expect(weakKeyReason('58204719')).toBeNull();
    await expect(makeLedger('00000000', sha, 'ab'.repeat(16))).rejects.toThrow(/Choose another key/);
    expect(isLedgerRecord({ salt: 'x', digest: 'nope' })).toBe(false);
  });

  it('locks out after five wrong tries, doubling each time', () => {
    let now = 0;
    const g = new AttemptGate(() => now);
    for (let i = 0; i < 4; i++) g.fail();
    expect(() => g.check()).not.toThrow();
    g.fail();
    expect(() => g.check()).toThrow(/retry in 30s/);
    now += 30_001;
    g.check();
    g.fail();
    expect(g.waitMs()).toBe(60_000);
    g.success();
    expect(g.waitMs()).toBe(0);
  });

  it('keeps secrets, trading and bots sealed while locked', () => {
    for (const ch of ['vault:list', 'vault:copy', 'trade:place', 'amt:start', 'telegram:send', 'wallet:balances', 'ccxt:account', 'db:exportCsv']) expect(PUBLIC_CHANNELS.has(ch)).toBe(false);
    for (const ch of ['ccxt:subscribe', 'net:fetchJson', 'db:record', 'app:unlock', 'app:seal']) expect(PUBLIC_CHANNELS.has(ch)).toBe(true);
    // changing the key needs an unlocked terminal (and the current key)
    expect(PUBLIC_CHANNELS.has('app:changeKey')).toBe(false);
  });
});
