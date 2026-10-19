import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from './db.mjs';
import { base58Decode, base58Encode, connectMessage, connectPhantom, verifySolanaSignature } from './phantom.mjs';
import { mask, Vault } from './vault.mjs';
import { walletBalances } from '../src/shared/solana.ts';

let dir;
let db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novus-'));
  db = new Db(join(dir, 'test.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** safeStorage double: reversible but not plaintext. */
const fakeSafe = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
  decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString('utf8'),
};

describe('Vault', () => {
  for (const [name, safe] of [
    ['OS keychain', fakeSafe],
    ['local AES fallback', { isEncryptionAvailable: () => false }],
  ]) {
    it(`encrypts at rest and only exposes masked values (${name})`, () => {
      const v = new Vault(db, safe, join(dir, 'vault.key'));
      const id = v.save({ label: 'Main', kind: 'exchange', exchange: 'binance', fields: { apiKey: 'AKIA1234567890XYZ', secret: 'super-secret-value-123' } });
      const listed = v.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].meta.fields.apiKey).toBe(mask('AKIA1234567890XYZ'));
      expect(JSON.stringify(listed)).not.toContain('super-secret-value-123');
      expect(v.reveal(id).fields.secret).toBe('super-secret-value-123');
      db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const raw = readFileSync(join(dir, 'test.sqlite'));
      expect(raw.includes(Buffer.from('super-secret-value-123'))).toBe(false);
      expect(raw.includes(Buffer.from('AKIA1234567890XYZ'))).toBe(false);
    });
  }

  it('keeps stored values when an update leaves a field blank, and deletes on null', () => {
    const v = new Vault(db, fakeSafe, join(dir, 'vault.key'));
    const id = v.save({ label: 'RPC', kind: 'solana-rpc', fields: { url: 'https://rpc.example.com/?key=abc', extra: 'x' } });
    v.save({ id, label: 'RPC 2', kind: 'solana-rpc', fields: { url: '', extra: null } });
    expect(v.reveal(id).fields).toEqual({ url: 'https://rpc.example.com/?key=abc' });
    expect(v.list()[0].label).toBe('RPC 2');
    expect(v.list()[0].meta.fields.url).toBe('https://rpc.example.com/?key=abc');
    v.remove(id);
    expect(v.list()).toHaveLength(0);
  });

  it('masks short and long values', () => {
    expect(mask('abc')).toBe('•••');
    expect(mask('abcdefghijkl')).toBe('abcd••••ijkl');
  });
});

describe('Db', () => {
  it('records, queries, prunes and reports trades', () => {
    db.recordTrades('binancef', 'BTCUSDT', [
      { p: 100, q: 1, s: 'buy', t: 1000 },
      { p: 101, q: 2, s: 'sell', t: 2000 },
      { p: 102, q: 3, s: 'buy', t: 3000 },
    ]);
    expect(db.queryTrades('binancef', 'BTCUSDT', 1500, 3000)).toEqual([
      { time: 2000, price: 101, qty: 2, side: 'sell' },
      { time: 3000, price: 102, qty: 3, side: 'buy' },
    ]);
    expect(db.tradeStats()).toEqual([{ venue: 'binancef', symbol: 'BTCUSDT', n: 3, first: 1000, last: 3000 }]);
    expect(db.pruneTrades(2500)).toBe(2);
    expect(db.info().trades).toBe(1);
    db.set('retentionDays', 7);
    expect(db.get('retentionDays')).toBe(7);
  });

  it('stores wallets and keeps verification sticky', () => {
    db.putWallet('Addr1', 'solana', true);
    db.putWallet('Addr1', 'solana', false);
    expect(db.listWallets()[0].verified).toBe(1);
  });
});

describe('Phantom verification', () => {
  const keypair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    return { address: base58Encode(raw), privateKey };
  };

  it('round-trips base58', () => {
    const buf = Buffer.from([0, 0, 1, 2, 255, 128]);
    expect(base58Decode(base58Encode(buf))).toEqual(buf);
  });

  it('verifies ed25519 signatures and rejects tampering', () => {
    const { address, privateKey } = keypair();
    const msg = connectMessage('abc', 'http://127.0.0.1:1');
    const sig = sign(null, Buffer.from(msg), privateKey);
    expect(verifySolanaSignature(address, msg, sig)).toBe(true);
    expect(verifySolanaSignature(address, msg + 'x', sig)).toBe(false);
    expect(verifySolanaSignature(keypair().address, msg, sig)).toBe(false);
  });

  it('serves the connect page and resolves only for a valid signature', async () => {
    const { address, privateKey } = keypair();
    const result = await connectPhantom(async (url) => {
      const html = await (await fetch(url)).text();
      expect(html).toContain('Connect Phantom');
      const message = JSON.parse(/const MESSAGE = (".*?");/s.exec(html)[1]);
      // a forged signature is rejected and does not resolve
      const bad = await fetch(url + 'callback', { method: 'POST', body: JSON.stringify({ publicKey: address, signature: base58Encode(Buffer.alloc(64, 1)) }) });
      expect((await bad.json()).ok).toBe(false);
      const sig = sign(null, Buffer.from(message), privateKey);
      const ok = await fetch(url + 'callback', { method: 'POST', body: JSON.stringify({ publicKey: address, signature: base58Encode(sig) }) });
      expect(await ok.json()).toEqual({ ok: true, address });
    });
    expect(result).toEqual({ address, verified: true });
  });
});

describe('Solana balances', () => {
  it('reads SOL and merges token accounts by mint', async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      const result =
        body.method === 'getBalance'
          ? { value: 2_500_000_000 }
          : body.params[1].programId.startsWith('Tokenkeg')
            ? {
                value: [
                  { account: { data: { parsed: { info: { mint: 'MintA', tokenAmount: { uiAmount: 1.5, uiAmountString: '1.5', decimals: 6 } } } } } },
                  { account: { data: { parsed: { info: { mint: 'MintA', tokenAmount: { uiAmount: 0.5, uiAmountString: '0.5', decimals: 6 } } } } } },
                  { account: { data: { parsed: { info: { mint: 'Empty', tokenAmount: { uiAmount: 0, uiAmountString: '0', decimals: 6 } } } } } },
                ],
              }
            : { value: [] };
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const b = await walletBalances('Addr', 'https://rpc.test', fetchImpl);
    expect(b.sol).toBe(2.5);
    expect(b.tokens).toEqual([{ mint: 'MintA', amount: 2, decimals: 6 }]);
    expect(calls).toEqual(['getBalance', 'getTokenAccountsByOwner', 'getTokenAccountsByOwner']);
  });
});
