import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMIT_DEFAULTS, MemeTrader, MIN_SWEEP, rpcWithFallback, SOL_MINT } from './memetrade.mjs';
import { base58Decode, base58Encode } from './phantom.mjs';
import { exportSecret, keypairFromSeed, newKeypair, parseSecret, parseTx, signTx, txSignature } from './solana-tx.mjs';

/** A minimal legacy or v0 transaction for `payer`: one signature slot, two keys, no instructions. */
function unsignedTx(payer, versioned = false) {
  const parts = [Buffer.from([1]), Buffer.alloc(64)];
  if (versioned) parts.push(Buffer.from([0x80]));
  parts.push(Buffer.from([1, 0, 1]), Buffer.from([2]), base58Decode(payer), Buffer.alloc(32, 7), Buffer.alloc(32, 9), Buffer.from([0]));
  if (versioned) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

const pubKeyObject = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });

describe('trading wallet keys', () => {
  it('derives the address from the seed, round-trips Phantom’s private key export, and rejects a mismatched key', () => {
    const kp = keypairFromSeed(Buffer.alloc(32, 1));
    expect(kp.address).toBe(base58Encode(kp.pub));
    expect(kp.pub.length).toBe(32);
    const exported = exportSecret(kp);
    expect(base58Decode(exported).length).toBe(64);
    expect(parseSecret(exported).address).toBe(kp.address);
    expect(parseSecret(JSON.stringify([...Buffer.concat([kp.seed, kp.pub])])).address).toBe(kp.address);
    const other = newKeypair();
    expect(() => parseSecret(base58Encode(Buffer.concat([kp.seed, other.pub])))).toThrow(/do not match/);
    expect(() => parseSecret('abc')).toThrow(/not a Solana private key/);
  });
});

describe('signing a swap transaction', () => {
  for (const versioned of [false, true]) {
    it(`signs a ${versioned ? 'v0' : 'legacy'} transaction in the fee payer's slot, with a valid ed25519 signature`, () => {
      const kp = newKeypair();
      const tx = unsignedTx(kp.address, versioned);
      const p = parseTx(tx);
      expect(p).toMatchObject({ nSig: 1, versioned, keys: [kp.address, expect.any(String)] });
      const signed = signTx(tx, kp);
      const sig = signed.subarray(1, 65);
      expect(verify(null, signed.subarray(p.msgStart), pubKeyObject(kp.pub), sig)).toBe(true);
      expect(txSignature(signed)).toBe(base58Encode(sig));
      expect(signed.subarray(65).equals(tx.subarray(65))).toBe(true);
    });
  }

  it('refuses a transaction built for another wallet', () => {
    const kp = newKeypair();
    expect(() => signTx(unsignedTx(newKeypair().address), kp)).toThrow('transaction is not for this wallet');
  });
});

describe('the executor', () => {
  const kp = newKeypair();
  const MINT = 'FrogMint1111111111111111111111111111111pump';
  const TOKEN_ACCOUNT = newKeypair().address;

  function rig(over = {}) {
    const calls = [];
    const sentTx = [];
    let spent = 0;
    let held = 5_000_000 - (over.grow ?? 0);
    let clock = 0;
    const limits = { ...LIMIT_DEFAULTS, armed: true, ...over.limits };
    const rpc = async (method, params) => {
      calls.push(method);
      if (method === 'getBalance') return { value: (over.balance ?? 1) * 1e9 };
      if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(Buffer.alloc(32, 5)), lastValidBlockHeight: 1 } };
      if (method === 'sendTransaction') {
        sentTx.push(Buffer.from(params[0], 'base64'));
        return txSignature(sentTx.at(-1));
      }
      if (method === 'getSignatureStatuses') return { value: [over.slow ? null : { confirmationStatus: 'confirmed', err: over.chainErr ?? null }] };
      if (method === 'getTokenAccountsByOwner') {
        held += over.grow ?? 0;
        // after a sell went out, the account is empty (when the test says so)
        const amount = over.emptyAfterSell && sentTx.length ? '0' : String(held);
        return { value: [{ pubkey: TOKEN_ACCOUNT, account: { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lamports: 2_039_280, data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } }] };
      }
      if (method === 'getTransaction')
        return over.noTx ? null : {
          transaction: { message: { accountKeys: [{ pubkey: kp.address }, { pubkey: 'Other' }] } },
          meta: { preBalances: [1e9, 0], postBalances: [0.9 * 1e9 - 5000, 0], preTokenBalances: [], postTokenBalances: [{ owner: kp.address, mint: MINT, uiTokenAmount: { amount: '3500000000', decimals: 6 } }] },
        };
      throw new Error(method);
    };
    const http = async (url, init) => {
      calls.push(url.split('?')[0]);
      if (url.includes('/quote')) return over.noRoute ? { ok: false, status: 400, json: async () => ({}) } : { ok: true, json: async () => ({ outAmount: '3500000000', inAmount: '100000000' }) };
      if (url.endsWith('/swap')) {
        expect(JSON.parse(init.body).userPublicKey).toBe(kp.address);
        return { ok: true, json: async () => ({ swapTransaction: unsignedTx(kp.address, true).toString('base64') }) };
      }
      if (url.includes('pumpportal')) {
        const b = JSON.parse(init.body);
        calls.push(`pumpportal:${b.action}:${b.amount}`);
        return { ok: true, arrayBuffer: async () => unsignedTx(kp.address, true) };
      }
      throw new Error(url);
    };
    const t = new MemeTrader({ wallet: () => kp, rpc, http, limits: () => limits, spent: () => spent, addSpend: (s) => (spent += s), flight: over.flight, now: () => (clock += 5_000), sleep: async () => {} });
    return { t, calls, sentTx, spentNow: () => spent };
  }

  it('buys through Jupiter: quote, swap, sign, send, confirm, and settles the real amounts', async () => {
    const { t, calls, spentNow } = rig();
    const r = await t.buy(MINT, 0.1);
    expect(r).toMatchObject({ via: 'Jupiter', tokenDelta: '3500000000', decimals: 6 });
    expect(r.solDelta).toBeCloseTo(-0.100005, 9);
    expect(calls).toEqual(['getBalance', 'getTokenAccountsByOwner', `${'https://lite-api.jup.ag/swap/v1'}/quote`, 'https://lite-api.jup.ag/swap/v1/swap', 'sendTransaction', 'getSignatureStatuses', 'getTransaction']);
    expect(spentNow()).toBe(0.1);
  });

  it('falls back to pump.fun when Jupiter has no route, and sells by share', async () => {
    const { t, calls } = rig({ noRoute: true });
    await t.buy(MINT, 0.05);
    expect(calls).toContain('pumpportal:buy:0.05');
    await t.sell(MINT, '2500000');
    expect(calls).toContain('pumpportal:sell:50%');
  });

  it('enforces the limits in the main process: armed (for buys), per-trade cap, daily cap, fee reserve; and reports chain failures', async () => {
    await expect(rig({ limits: { armed: false } }).t.buy(MINT, 0.1)).rejects.toThrow('live trading is not armed');
    // disarming stops buys, not the exits of positions already open
    await expect(rig({ limits: { armed: false } }).t.sell(MINT, 'all')).resolves.toMatchObject({ via: 'Jupiter' });
    await expect(rig().t.buy(MINT, 0.2)).rejects.toThrow('over the 0.1 SOL cap per trade');
    const r = rig({ limits: { dailySpendSol: 0.15 } });
    await r.t.buy(MINT, 0.1);
    await expect(r.t.buy(MINT, 0.1)).rejects.toThrow('daily spend cap reached (0.15 SOL)');
    await expect(rig({ balance: 0.11 }).t.buy(MINT, 0.1)).rejects.toThrow(/not enough SOL: 0\.1100 in the wallet, 0\.02 kept for fees/);
    await expect(rig({ chainErr: { InstructionError: [2, { Custom: 6001 }] } }).t.buy(MINT, 0.1)).rejects.toThrow(/transaction failed on chain/);
    expect(SOL_MINT).toMatch(/^So1/);
  });

  it('counts buys in flight against the daily cap, so two at once cannot overspend', async () => {
    const flight = { sol: 0 };
    const a = rig({ flight, limits: { dailySpendSol: 0.15 } });
    const b = rig({ flight, limits: { dailySpendSol: 0.15 } });
    const results = await Promise.allSettled([a.t.buy(MINT, 0.1), b.t.buy(MINT, 0.1)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected').reason.message).toMatch(/daily spend cap reached/);
    expect(flight.sol).toBe(0);
  });

  it('keeps a slow buy on the daily count (it may still land) and gives back one the chain rejected', async () => {
    const slow = rig({ slow: true });
    await expect(slow.t.buy(MINT, 0.1)).rejects.toThrow(/not confirmed within 60 s/);
    expect(slow.spentNow()).toBe(0.1);
    const failed = rig({ chainErr: { InstructionError: [0, 'Custom'] } });
    await expect(failed.t.buy(MINT, 0.1)).rejects.toThrow(/failed on chain/);
    expect(failed.spentNow()).toBe(0);
  });

  const HOME = newKeypair().address;

  it('sold out: closes the empty token account and takes its rent back', async () => {
    const r = rig({ emptyAfterSell: true });
    const res = await r.t.sell(MINT, 'all');
    expect(res.rentBack).toBeCloseTo(0.00203928, 8);
    expect(r.sentTx).toHaveLength(2);
    const close = parseTx(r.sentTx[1]);
    expect(close.keys).toEqual([kp.address, TOKEN_ACCOUNT, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
    expect([...r.sentTx[1].subarray(r.sentTx[1].length - 7)]).toEqual([2, 3, 1, 0, 0, 1, 9]);
    // a partial sell leaves the account open
    const part = rig({ emptyAfterSell: true });
    expect((await part.t.sell(MINT, '2500000')).rentBack).toBeUndefined();
  });
  /** lamports and destination of a signed transfer */
  const transferOf = (tx) => {
    const p = parseTx(tx);
    const data = tx.subarray(tx.length - 12);
    return { to: p.keys[1], from: p.keys[0], lamports: Number(data.readBigUInt64LE(4)), program: p.keys[2] };
  };

  it('sends SOL home as a signed System Program transfer, keeping the fee reserve', async () => {
    const r = rig({ balance: 1 });
    const res = await r.t.send(HOME, 0.5);
    expect(res.sol).toBe(0.5);
    expect(transferOf(r.sentTx[0])).toEqual({ from: kp.address, to: HOME, lamports: 500_000_000, program: '11111111111111111111111111111111' });
    await expect(rig({ balance: 0.5 }).t.send(HOME, 0.49)).rejects.toThrow(/kept for fees/);
    const all = rig({ balance: 0.3 });
    await all.t.send(HOME, 'all');
    expect(transferOf(all.sentTx[0]).lamports).toBe(299_990_000);
    await expect(rig().t.send(kp.address, 0.1)).rejects.toThrow(/swarm wallet itself/);
    await expect(rig().t.send('not-an-address', 0.1)).rejects.toThrow();
    // nothing leaves while a buy is in flight
    await expect(rig({ flight: { sol: 0.1 } }).t.send(HOME, 0.1)).rejects.toThrow(/buy is in flight/);
  });

  it('sweeps profits home: only when on, only over the amount kept, at least the minimum', async () => {
    expect(await rig({ balance: 5 }).t.sweep(HOME)).toBeNull();
    expect(await rig({ balance: 1.03, limits: { sweepAboveSol: 1 } }).t.sweep(HOME)).toBeNull();
    const r = rig({ balance: 1.5, limits: { sweepAboveSol: 1 } });
    const res = await r.t.sweep(HOME);
    expect(res.sol).toBeCloseTo(0.49999, 5);
    expect(transferOf(r.sentTx[0])).toMatchObject({ to: HOME, lamports: 499_990_000 });
    expect(MIN_SWEEP).toBe(0.05);
  });

  it('reads the tokens from the wallet when the RPC does not serve the transaction yet', async () => {
    const r = await rig({ noTx: true, grow: 3_500_000_000 }).t.buy(MINT, 0.1);
    expect(r).toMatchObject({ tokenDelta: '3500000000', decimals: 6, solDelta: null });
  });
});

describe('the RPC fallback', () => {
  it('uses the public RPC when your own refuses or cannot be reached, but not for a real error answer', async () => {
    const used = [];
    const refuse = async (m) => {
      used.push(`own:${m}`);
      throw Object.assign(new Error('RPC 429 Too Many Requests'), { transport: true });
    };
    const pub = async (m) => (used.push(`public:${m}`), 'ok');
    const notes = [];
    expect(await rpcWithFallback(refuse, pub, (e, m) => notes.push(m))('getBalance', [])).toBe('ok');
    expect(used).toEqual(['own:getBalance', 'public:getBalance']);
    expect(notes).toEqual(['getBalance']);
    // the node answered with an error (a failed simulation): that is the answer
    const simFail = async () => {
      throw new Error('Transaction simulation failed: slippage');
    };
    await expect(rpcWithFallback(simFail, pub)('sendTransaction', [])).rejects.toThrow(/simulation failed/);
    // no fallback configured
    await expect(rpcWithFallback(refuse, null)('getSlot', [])).rejects.toThrow(/429/);
  });
});
