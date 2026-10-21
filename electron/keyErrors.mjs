// Exchanges answer a key they will not accept with terse codes (Binance
// -2015 "Invalid API-key, IP, or permissions for action"). Turn those into a
// checklist the owner can act on, including the public IP the exchange sees.

/** "the exchange refused this key" across the codes CCXT passes through. */
export function isKeyRejection(e) {
  const m = String(e?.message ?? e);
  return /-2015|-2014|-2008|-1022|invalid api-?key|api-?key.{0,20}(invalid|not exist|format)|permission denied|unauthori[sz]ed|10003|10004|10005|50111|50113|40006|401 /i.test(m) || /AuthenticationError|PermissionDenied/.test(e?.constructor?.name ?? '');
}

let ipCache = null;
/** The public IP this computer reaches the exchange from (cached 5 min). */
export async function publicIp(fetchFn = fetch) {
  if (ipCache && Date.now() - ipCache.at < 5 * 60_000) return ipCache.ip;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetchFn('https://api.ipify.org?format=json', { signal: ctrl.signal });
    clearTimeout(timer);
    const ip = (await r.json())?.ip;
    if (typeof ip === 'string' && ip.length <= 45) {
      ipCache = { ip, at: Date.now() };
      return ip;
    }
  } catch {
    /* offline or blocked: the checklist works without it */
  }
  return null;
}

/**
 * The checklist for a rejected key. `ctx`: exchange id, whether the key is
 * saved as testnet, whether the call was for derivatives, the public IP.
 */
export function keyChecklist({ exchange = '', sandbox = false, futures = false, ip = null, original = '' }) {
  const binance = /^binance/i.test(exchange);
  const steps = [
    sandbox
      ? `Testnet: this key is saved with “testnet / sandbox” ticked — that only works for a key made on the exchange’s testnet. For a key from the real exchange, untick it in 🔌 Connect.`
      : `Testnet: this key is saved as a LIVE key — a key made on a testnet site only works with “testnet / sandbox” ticked in 🔌 Connect.`,
    binance
      ? `Permissions: binance.com → Profile → API Management → Edit restrictions: tick “Enable Reading”${futures ? ', “Enable Futures” (needed for futures balances, positions and orders)' : ''}${', and “Enable Spot & Margin Trading” only if you trade spot'}. Never enable withdrawals.`
      : `Permissions: on the exchange’s API page, give the key read access${futures ? ' including derivatives / futures' : ''} (and trade access only if you trade). Never enable withdrawals.`,
    `IP access: if the key is restricted to trusted IPs, ${ip ? `add your current IP ${ip}` : 'add your current public IP'} — home connections often change IP. Or set it to unrestricted.`,
    `Copy errors: paste the API key and secret again (or create a new key) — a missing character makes the whole key invalid.`,
  ];
  return `${exchange || 'The exchange'} refused this API key. Check, in order:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${original ? `\n(${original})` : ''}`;
}
