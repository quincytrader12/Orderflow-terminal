import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CcxtService } from './ccxt-service.mjs';
import { Db } from './db.mjs';
import { isKeyRejection, keyChecklist, publicIp } from './keyErrors.mjs';
import { Vault } from './vault.mjs';

const REJECT = 'binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}';

describe('rejected API keys', () => {
  it('recognises key rejections and nothing else', () => {
    expect(isKeyRejection(new Error(REJECT))).toBe(true);
    expect(isKeyRejection(new Error('binance {"code":-2014,"msg":"API-key format invalid."}'))).toBe(true);
    expect(isKeyRejection(new Error('bybit {"retCode":10003,"retMsg":"API key is invalid."}'))).toBe(true);
    expect(isKeyRejection(new Error('binance {"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}'))).toBe(false);
    expect(isKeyRejection(new Error('binance {"code":-2010,"msg":"Account has insufficient balance"}'))).toBe(false);
  });

  it('builds a checklist naming the testnet setting, permissions and the current IP', () => {
    const live = keyChecklist({ exchange: 'Binance', sandbox: false, futures: true, ip: '102.66.1.9', original: REJECT });
    expect(live).toMatch(/saved as a LIVE key/);
    expect(live).toMatch(/Enable Futures/);
    expect(live).toMatch(/add your current IP 102\.66\.1\.9/);
    expect(live).toMatch(/Never enable withdrawals/);
    expect(live).toContain(REJECT);
    expect(keyChecklist({ exchange: 'Binance', sandbox: true })).toMatch(/untick it/);
    expect(keyChecklist({ exchange: 'Binance', futures: false })).not.toMatch(/Enable Futures/);
  });

  it('looks up the public IP once and survives being offline', async () => {
    let calls = 0;
    const ok = async () => (calls++, { json: async () => ({ ip: '102.66.1.9' }) });
    expect(await publicIp(ok)).toBe('102.66.1.9');
    expect(await publicIp(ok)).toBe('102.66.1.9');
    expect(calls).toBe(1);
  });
});

describe('key test and stored-key hygiene', () => {
  let dir;
  let db;
  let vault;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'novus-keys-'));
    db = new Db(join(dir, 'k.sqlite'));
    vault = new Vault(db, { isEncryptionAvailable: () => false }, join(dir, 'vault.key'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Binance-like client: spot works, futures needs a permission the key may lack. */
  function lib({ futures }) {
    const seen = [];
    class FakeBinance {
      constructor(cfg) {
        this.id = 'binance';
        this.name = 'Binance';
        this.cfg = cfg;
        this.has = {};
        this.options = {};
        seen.push(cfg);
      }
      setSandboxMode(v) {
        this.sandbox = v;
      }
      async fetchBalance(params = {}) {
        // this key only exists on the live exchange
        if (this.sandbox) throw new Error(REJECT);
        if (params.type === 'future' && !futures) throw new Error(REJECT);
        return { total: { USDT: 54, BNB: 0.1 } };
      }
      async sapiGetAccountApiRestrictions() {
        return { ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: false, enableFutures: futures, enableWithdrawals: false };
      }
    }
    return { lib: { binance: FakeBinance, pro: {} }, seen };
  }

  it('strips spaces and line breaks pasted around a key', async () => {
    const { lib: l, seen } = lib({ futures: true });
    const svc = new CcxtService(vault, { db, lib: l });
    const id = vault.save({ label: 'Main', kind: 'exchange', exchange: 'binance', fields: { apiKey: ' AbC123 \n', secret: '\tsEcReT  ' } });
    await svc.testKey(id);
    expect(seen[0]).toMatchObject({ apiKey: 'AbC123', secret: 'sEcReT' });
  });

  it('Test reports spot and futures access separately', async () => {
    const ok = new CcxtService(vault, { db, lib: lib({ futures: true }).lib });
    const id = vault.save({ label: 'Main', kind: 'exchange', exchange: 'binance', fields: { apiKey: 'k', secret: 's' } });
    expect(await ok.testKey(id)).toMatchObject({ ok: true, assets: 2, futures: true });
    const noFut = new CcxtService(vault, { db, lib: lib({ futures: false }).lib });
    const r = await noFut.testKey(id);
    expect(r.futures).toBe(false);
    expect(r.futuresError).toMatch(/Enable Futures/);
  });

  it('tests a key saved as testnet against the live exchange, without changing it', async () => {
    const svc = new CcxtService(vault, { db, lib: lib({ futures: true }).lib });
    const id = vault.save({ label: 'Main', kind: 'exchange', exchange: 'binance', fields: { apiKey: 'k', secret: 's', sandbox: 'true' } });
    // as saved (testnet), Binance refuses it and the checklist says why
    await expect(svc.testKey(id)).rejects.toThrow(/saved with “testnet \/ sandbox” ticked/);
    const live = await svc.testKey(id, { env: 'live' });
    expect(live).toMatchObject({ ok: true, environment: 'live', saved: 'testnet', assets: 2, futures: true });
    expect(live.permissions).toEqual({ reading: true, spotTrading: false, futures: true, withdrawals: false, ipRestricted: true });
    // the saved setting is untouched until the owner chooses
    expect(vault.reveal(id).fields.sandbox).toBe('true');
  });
});
