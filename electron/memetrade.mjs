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
import { buildCloseAccounts, buildTransfer, pubkeyBytes, signTx, txSignature } from './solana-tx.mjs';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUP = 'https://lite-api.jup.ag/swap/v1';
export const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const LAMPORTS = 1e9;

export const LIMIT_DEFAULTS = { armed: false, maxBuySol: 0.1, dailySpendSol: 0.5, reserveSol: 0.02, slippageBps: 1500, priorityLamports: 300_000, sweepAboveSol: 0 };
/** a plain transfer's fee, 5000 lamports, with room to spare */
const TRANSFER_FEE = 0.00001;
/** profits are only sent home once there is at least this much over the amount kept */
export const MIN_SWEEP = 0.05;

export class MemeTrader {
  /**
   * @param o.wallet () => keypair (from solana-tx.mjs), or throws when there is none
   * @param o.rpc (method, params) => result
   * @param o.http (url, init) => Response-like ({ ok, status, json(), arrayBuffer() })
   * @param o.limits () => current limits; o.spent / o.addSpend: today's SOL spent
   * @param o.flight { sol }: buys in flight, shared by every trader on the wallet
   * @param o.sleep ms => Promise (tests pass a fast one)
   */
  constructor({ wallet, rpc, http, limits, spent, addSpend, flight = { sol: 0 }, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
    // flight: SOL of buys in flight, shared by every trader on the wallet. It counts against
    // the caps until the buys settle, so buys at the same moment cannot overspend.
    Object.assign(this, { wallet, rpc, http, limits, spent, addSpend, flight, now, sleep, log });
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

  /**
   * Buy `sol` SOL of `mint`. The spend counts against the daily cap from the
   * moment the transaction is sent; it is given back only when the chain
   * rejects it (a transaction that is merely slow to confirm may still land).
   */
  async buy(mint, sol) {
    const L = this.limits();
    if (!L.armed) throw new Error('live trading is not armed');
    if (!(sol > 0) || sol > L.maxBuySol + 1e-9) throw new Error(`buy of ${sol} SOL is over the ${L.maxBuySol} SOL cap per trade`);
    if (this.spent() + this.flight.sol + sol > L.dailySpendSol + 1e-9) throw new Error(`daily spend cap reached (${L.dailySpendSol} SOL)`);
    this.flight.sol += sol;
    let sent = false;
    try {
      const bal = await this.solBalance();
      // other buys in flight have not left the wallet yet: keep their SOL aside too
      if (bal - (this.flight.sol - sol) - sol < L.reserveSol) throw new Error(`not enough SOL: ${bal.toFixed(4)} in the wallet, ${L.reserveSol} kept for fees`);
      const before = await this.tokenBalance(mint).catch(() => null);
      const lamports = Math.floor(sol * LAMPORTS);
      const tx = await this.build({ side: 'buy', mint, amount: String(lamports), sol });
      const res = await this.execute(tx, mint, () => {
        sent = true;
        this.addSpend(sol);
      });
      // the RPC did not report the amounts: read them from the wallet instead
      if (res.tokenDelta === null && before) {
        const after = await this.tokenBalance(mint).catch(() => null);
        if (after) Object.assign(res, { tokenDelta: (after.raw - before.raw).toString(), decimals: after.decimals });
      }
      return res;
    } catch (e) {
      if (sent && /failed on chain/.test(String(e?.message))) this.addSpend(-sol);
      throw e;
    } finally {
      this.flight.sol -= sol;
    }
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
    const res = await this.execute(tx, mint);
    // the RPC did not report the amounts: read the tokens from the wallet instead
    if (res.tokenDelta === null) {
      const after = await this.tokenBalance(mint).catch(() => null);
      if (after) Object.assign(res, { tokenDelta: (after.raw - held.raw).toString(), decimals: after.decimals });
    }
    // sold out: close the empty token account and take its rent (~0.002 SOL) back
    if (amount === held.raw) {
      res.rentBack = await this.closeEmpty(mint).catch((e) => {
        this.log(`could not close the empty ${mint.slice(0, 6)}… account: ${e?.message ?? e}`);
        return 0;
      });
    }
    return res;
  }

  /** Close the wallet's empty token accounts for `mint`; returns the SOL of rent reclaimed. */
  async closeEmpty(mint) {
    const kp = this.wallet();
    const r = await this.rpc('getTokenAccountsByOwner', [kp.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const empty = (r?.value ?? []).filter((a) => a?.pubkey && a?.account?.owner && a.account.data?.parsed?.info?.tokenAmount?.amount === '0');
    if (!empty.length) return 0;
    const { value } = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = buildCloseAccounts(kp.address, empty.map((a) => ({ pubkey: a.pubkey, program: a.account.owner })), value.blockhash);
    await this.execute({ bytes: tx, via: 'close' }, null);
    return empty.reduce((s, a) => s + Number(a.account.lamports ?? 0), 0) / LAMPORTS;
  }

  /**
   * Send SOL from the swarm wallet to `to` (the owner's home wallet; main checks
   * which address that may be). `sol` is an amount or 'all'. The fee reserve
   * stays behind unless everything is sent; nothing is sent while a buy is in flight.
   */
  async send(to, sol) {
    const kp = this.wallet();
    pubkeyBytes(to);
    if (to === kp.address) throw new Error('cannot send to the swarm wallet itself');
    if (this.flight.sol > 0) throw new Error('a buy is in flight — try again in a moment');
    const L = this.limits();
    const bal = await this.solBalance();
    const amount = sol === 'all' ? bal - TRANSFER_FEE : Number(sol);
    if (!(amount > 0)) throw new Error('nothing to send');
    const keep = sol === 'all' ? 0 : L.reserveSol;
    if (bal - amount - TRANSFER_FEE < keep - 1e-9) throw new Error(`not enough SOL: ${bal.toFixed(4)} in the wallet, ${keep} kept for fees`);
    const { value } = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = buildTransfer(kp.address, to, Math.floor(amount * LAMPORTS), value.blockhash);
    const res = await this.execute({ bytes: tx, via: 'transfer' }, null);
    return { ...res, sol: amount };
  }

  /** Profits home: everything over `sweepAboveSol` (when on, and at least MIN_SWEEP), else null. */
  async sweep(to) {
    const L = this.limits();
    if (!(L.sweepAboveSol > 0)) return null;
    if (this.flight.sol > 0) return null;
    const bal = await this.solBalance();
    const amount = bal - Math.max(L.sweepAboveSol, L.reserveSol) - TRANSFER_FEE;
    if (amount < MIN_SWEEP) return null;
    return this.send(to, Math.floor(amount * 1e6) / 1e6);
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
  async execute({ bytes, via }, mint, onSent = () => {}) {
    const kp = this.wallet();
    const signed = signTx(bytes, kp);
    const signature = txSignature(signed);
    await this.rpc('sendTransaction', [signed.toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
    onSent();
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
    // public RPCs can take a while to serve a fresh transaction
    for (let i = 0; i < 12 && !tx; i++) {
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
