// On-chain checks for a coin, over Solana JSON-RPC (read-only):
//  - mint authority revoked: nobody can print more of it
//  - freeze authority revoked: nobody can freeze holders' tokens (a honeypot)
//  - holder concentration: the share of supply in the largest wallets, with the
//    bonding curve and known AMM pool vaults left out (those are not holders)
import type { Safety } from './token';

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** Pool authorities whose token accounts hold liquidity, not a holder's bag. */
export const POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
]);

export async function checkSafety(rpc: Rpc, mint: string, exclude: (string | undefined)[] = [], now = Date.now()): Promise<Safety> {
  const out: Safety = { checkedAt: now, mintRevoked: null, freezeRevoked: null, top10: null, top1: null };
  try {
    const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const info = acc?.value?.data?.parsed?.info;
    if (!info) throw new Error('not a token mint');
    out.mintRevoked = info.mintAuthority == null;
    out.freezeRevoked = info.freezeAuthority == null;
    const decimals = Number(info.decimals) || 0;
    const supply = Number(info.supply) / 10 ** decimals;
    const largest = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const rows: { address: string; ui: number }[] = (largest?.value ?? []).map((r: any) => ({ address: String(r.address), ui: Number(r.uiAmount ?? Number(r.amount) / 10 ** decimals) || 0 }));
    // owners of those token accounts, to drop the curve and the pools
    const owners = rows.length ? await rpc('getMultipleAccounts', [rows.map((r) => r.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]) : { value: [] };
    const skip = new Set([...exclude.filter(Boolean), ...POOL_AUTHORITIES] as string[]);
    const holders = rows.filter((r, i) => {
      const owner = owners?.value?.[i]?.data?.parsed?.info?.owner;
      return !(owner && skip.has(owner)) && !skip.has(r.address);
    });
    if (supply > 0) {
      out.top10 = holders.slice(0, 10).reduce((a, r) => a + r.ui, 0) / supply;
      out.top1 = (holders[0]?.ui ?? 0) / supply;
    }
  } catch (e) {
    out.error = String((e as Error)?.message ?? e);
  }
  return out;
}
