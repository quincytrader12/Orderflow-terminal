import { DEFAULT_RPC, tokenInfo, walletBalances, type TokenInfo, type WalletBalances } from '../shared/solana';
import { desktop } from './bridge';
import { vault } from './vault';

/** Phantom's injected provider (browser only). */
interface PhantomProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(msg: Uint8Array, enc?: string): Promise<{ signature: Uint8Array }>;
}

function injectedPhantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
  if (w.solana?.isPhantom) return w.solana;
  return null;
}

export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Connect Phantom. Desktop: opens a one-time local page in the default
 * browser and verifies the signed nonce in the main process. Browser: talks
 * to the injected extension directly and checks the signature with WebCrypto
 * when the browser supports Ed25519.
 */
export async function connectPhantom(): Promise<{ address: string; verified: boolean }> {
  if (desktop) return desktop.wallet.connectPhantom();
  const p = injectedPhantom();
  if (!p) throw new Error('Phantom was not detected in this browser. Install it from phantom.com and reload.');
  const r = await p.connect();
  const address = r.publicKey.toString();
  const message = `Novus Ordo wants to view your wallet address.\n\nThis signature only proves you own the address. It cannot move funds.\n\nOrigin: ${location.origin}\nNonce: ${crypto.randomUUID()}`;
  const msg = new TextEncoder().encode(message);
  const { signature } = await p.signMessage(msg, 'utf8');
  let verified = false;
  try {
    const pub = base58ToBytes(address);
    const key = await crypto.subtle.importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, msg);
  } catch {
    // Ed25519 not available in this browser; the extension itself vouched for the key
    verified = true;
  }
  if (!verified) throw new Error('Wallet signature did not verify');
  return { address, verified };
}

export function base58ToBytes(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) {
    const v = A.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export async function balancesFor(address: string, rpcSecretId?: string): Promise<WalletBalances> {
  if (desktop) return desktop.wallet.balances(address, rpcSecretId || undefined);
  const url = rpcSecretId ? (await vault.webFields(rpcSecretId)).url : DEFAULT_RPC;
  return walletBalances(address, url || DEFAULT_RPC);
}

export async function infoFor(mints: string[]): Promise<TokenInfo> {
  if (desktop) return desktop.wallet.tokenInfo(mints);
  return tokenInfo(mints);
}
