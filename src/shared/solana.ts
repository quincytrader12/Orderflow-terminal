// Read-only Solana wallet data over JSON-RPC: SOL balance and SPL token
// balances (Token and Token-2022 programs), plus USD prices from Jupiter.
export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

type FetchLike = typeof fetch;

async function rpc(url: string, method: string, params: unknown[], fetchImpl: FetchLike = fetch): Promise<any> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC ${res.status} ${res.statusText}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'RPC error');
  return j.result;
}

export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
}

export interface WalletBalances {
  address: string;
  sol: number;
  tokens: TokenBalance[];
}

export interface TokenInfo {
  prices: Record<string, number>;
  meta: Record<string, { symbol: string; name: string; icon?: string }>;
}

export async function walletBalances(address: string, rpcUrl = DEFAULT_RPC, fetchImpl: FetchLike = fetch): Promise<WalletBalances> {
  const lamports = await rpc(rpcUrl, 'getBalance', [address, { commitment: 'confirmed' }], fetchImpl);
  const tokens: TokenBalance[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    try {
      const r = await rpc(rpcUrl, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], fetchImpl);
      for (const acc of r.value ?? []) {
        const info = acc.account?.data?.parsed?.info;
        const amt = info?.tokenAmount;
        if (!info || !amt || Number(amt.uiAmount) === 0) continue;
        tokens.push({ mint: info.mint, amount: Number(amt.uiAmountString ?? amt.uiAmount), decimals: amt.decimals });
      }
    } catch {
      /* Token-2022 may be unsupported by some RPCs */
    }
  }
  // merge accounts of the same mint
  const byMint = new Map<string, TokenBalance>();
  for (const t of tokens) byMint.set(t.mint, { ...t, amount: (byMint.get(t.mint)?.amount ?? 0) + t.amount });
  return { address, sol: lamports.value / 1e9, tokens: [...byMint.values()] };
}

/** USD prices and token metadata from Jupiter; failures return empty maps. */
export async function tokenInfo(mints: string[], fetchImpl: FetchLike = fetch): Promise<TokenInfo> {
  const prices: TokenInfo['prices'] = {};
  const meta: TokenInfo['meta'] = {};
  const ids = [...new Set([SOL_MINT, ...mints])].slice(0, 100);
  try {
    const r = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${ids.join(',')}`);
    if (r.ok) {
      const j = await r.json();
      for (const [mint, v] of Object.entries((j ?? {}) as Record<string, { usdPrice?: number }>)) if (v && typeof v.usdPrice === 'number') prices[mint] = v.usdPrice;
    }
  } catch {
    /* offline */
  }
  try {
    const r = await fetchImpl(`https://lite-api.jup.ag/tokens/v2/search?query=${ids.join(',')}`);
    if (r.ok) for (const t of (await r.json()) as { id: string; symbol: string; name: string; icon?: string }[]) meta[t.id] = { symbol: t.symbol, name: t.name, icon: t.icon };
  } catch {
    /* offline */
  }
  return { prices, meta };
}
