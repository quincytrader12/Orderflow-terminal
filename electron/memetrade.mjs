// The swarm's executor: real swaps from its own trading wallet, with no
// approval click. Main process only.
//
//   route   Jupiter (any pool, pump.fun curves included) → PumpPortal's local
//           transaction API as the fallback for coins Jupiter cannot route
//   sign    here, with the wallet key from the vault (it never leaves this process)
//   send    through the Solana RPC (a private RPC from the vault lands faster),
//           with preflight simulation on, then confirmed by polling
//   settle  the real amounts from the confirmed transaction: SOL spent or
//           received (fees included) and tokens bought or sold
//
// Hard limits live here, not in the window: a cap per buy, a cap on SOL spent
// per day, and SOL kept back for fees. Nothing is bought unless the wallet
// has been armed for live trading.
import { signTx, txSignature } from './solana-tx.mjs';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUP = 'https://lite-api.jup.ag/swap/v1';
export const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const LAMPORTS = 1e9;

export const LIMIT_DEFAULTS = { armed: false, maxBuySol: 0.1, dailySpendSol: 0.5, reserveSol: 0.02, slippageBps: 1500, priorityLamports: 300_000 };

export class MemeTrader {
  /**
   * @param o.wallet () => keypair (from solana-tx.mjs), or throws when there is none
   * @param o.rpc (method, params) => result
   * @param o.http (url, init) => Response-like ({ ok, status, json(), arrayBuffer() })
   * @param o.limits () => current limits; o.spent / o.addSpend: today's SOL spent
   * @param o.sleep ms => Promise (tests pass a fast one)
   */
  constructor({ wallet, rpc, http, limits, spent, addSpend, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
    Object.assign(this, { wallet, rpc, http, limits, spent, addSpend, now, sleep, log });
  }

  async solBalance() {
    const kp = this.wallet();
    const r = await this.rpc('getBalance', [kp.address, { commitment: 'confirmed' }]);
    return Number(r?.value ?? 0) / LAMPORTS;
  }

  /** Raw token amount the wallet holds of `mint` (both token programs), and its decimals. */
  async tokenBalance(mint) {
    const kp = this.wallet();
    const r = await this.rpc('getTokenAccountsByOwner', [kp.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let raw = 0n;
    let decimals = 6;
    for (const a of r?.value ?? []) {
      const amt = a?.account?.data?.parsed?.info?.tokenAmount;
      if (!amt) continue;
      raw += BigInt(amt.amount);
      decimals = Number(amt.decimals);
    }
    return { raw, decimals };
  }

  /** Buy `sol` SOL of `mint`. */
  async buy(mint, sol) {
    const L = this.limits();
    if (!L.armed) throw new Error('live trading is not armed');
    if (!(sol > 0) || sol > L.maxBuySol + 1e-9) throw new Error(`buy of ${sol} SOL is over the ${L.maxBuySol} SOL cap per trade`);
    if (this.spent() + sol > L.dailySpendSol + 1e-9) throw new Error(`daily spend cap reached (${L.dailySpendSol} SOL)`);
    const bal = await this.solBalance();
    if (bal - sol < L.reserveSol) throw new Error(`not enough SOL: ${bal.toFixed(4)} in the wallet, ${L.reserveSol} kept for fees`);
    const lamports = Math.floor(sol * LAMPORTS);
    const tx = await this.build({ side: 'buy', mint, amount: String(lamports), sol });
    const res = await this.execute(tx, mint);
    this.addSpend(sol);
    return res;
  }

  /**
   * Sell `raw` units of `mint` (a BigInt or string), or everything held with
   * 'all'. Allowed while disarmed: disarming stops new buys, and the open
   * positions can still be taken off.
   */
  async sell(mint, raw) {
    const held = await this.tokenBalance(mint);
    let amount = raw === 'all' ? held.raw : BigInt(raw);
    if (amount > held.raw) amount = held.raw;
    if (amount <= 0n) throw new Error('no tokens to sell');
    const tx = await this.build({ side: 'sell', mint, amount: amount.toString(), share: held.raw > 0n ? Number(amount) / Number(held.raw) : 1 });
    return this.execute(tx, mint);
  }

  /** The swap transaction, unsigned: Jupiter first, PumpPortal for what it cannot route. */
  async build({ side, mint, amount, sol, share }) {
    const L = this.limits();
    const kp = this.wallet();
    const [inMint, outMint] = side === 'buy' ? [SOL_MINT, mint] : [mint, SOL_MINT];
    try {
      const q = await this.http(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${L.slippageBps}&restrictIntermediateTokens=true`);
      if (!q.ok) throw new Error(`Jupiter quote ${q.status}`);
      const quote = await q.json();
      if (!quote?.outAmount) throw new Error(quote?.error ?? 'no route');
      const s = await this.http(`${JUP}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: kp.address,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true,
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: L.priorityLamports, priorityLevel: 'veryHigh' } },
        }),
      });
      if (!s.ok) throw new Error(`Jupiter swap ${s.status}`);
      const j = await s.json();
      if (!j?.swapTransaction) throw new Error(j?.error ?? 'no transaction');
      return { bytes: Buffer.from(j.swapTransaction, 'base64'), via: 'Jupiter' };
    } catch (e) {
      this.log(`Jupiter could not route ${mint.slice(0, 6)}… (${e?.message ?? e}) — trying pump.fun directly`);
    }
    const body = {
      publicKey: kp.address,
      action: side,
      mint,
      // PumpPortal takes SOL for buys and a share ("100%") or token count for sells
      amount: side === 'buy' ? sol : `${Math.min(100, Math.max(1, Math.round((share ?? 1) * 100)))}%`,
      denominatedInSol: side === 'buy' ? 'true' : 'false',
      slippage: Math.round(L.slippageBps / 100),
      priorityFee: L.priorityLamports / LAMPORTS,
      pool: 'auto',
    };
    const r = await this.http(PUMPPORTAL_TRADE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`no route for this coin (PumpPortal ${r.status})`);
    return { bytes: Buffer.from(await r.arrayBuffer()), via: 'pump.fun' };
  }

  /** Sign, send (with preflight simulation), confirm, and read back what really happened. */
  async execute({ bytes, via }, mint) {
    const kp = this.wallet();
    const signed = signTx(bytes, kp);
    const signature = txSignature(signed);
    await this.rpc('sendTransaction', [signed.toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
    const t0 = this.now();
    for (;;) {
      await this.sleep(1000);
      const st = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]).catch(() => null);
      const s = st?.value?.[0];
      if (s?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(s.err)} (${signature})`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) break;
      if (this.now() - t0 > 60_000) throw new Error(`not confirmed within 60 s (${signature}) — check the wallet before retrying`);
    }
    return { signature, via, ...(await this.settle(signature, mint)) };
  }

  /** SOL and token changes for our wallet in a confirmed transaction. */
  async settle(signature, mint) {
    const kp = this.wallet();
    let tx = null;
    for (let i = 0; i < 5 && !tx; i++) {
      tx = await this.rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (!tx) await this.sleep(1000);
    }
    if (!tx?.meta) return { solDelta: null, tokenDelta: null, decimals: null };
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const me = keys.indexOf(kp.address);
    const solDelta = me >= 0 ? (tx.meta.postBalances[me] - tx.meta.preBalances[me]) / LAMPORTS : null;
    const bal = (list) => {
      let raw = 0n;
      let decimals = null;
      for (const b of list ?? []) if (b.owner === kp.address && b.mint === mint) (raw += BigInt(b.uiTokenAmount.amount)), (decimals = b.uiTokenAmount.decimals);
      return { raw, decimals };
    };
    const pre = bal(tx.meta.preTokenBalances);
    const post = bal(tx.meta.postTokenBalances);
    return { solDelta, tokenDelta: (post.raw - pre.raw).toString(), decimals: post.decimals ?? pre.decimals };
  }
}
