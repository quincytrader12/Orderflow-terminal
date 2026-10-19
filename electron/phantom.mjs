// Phantom wallet connection for the desktop app.
//
// Phantom is a browser extension, so it cannot inject into the Electron window.
// We serve a one-time page on 127.0.0.1, open it in the user's default browser
// (where Phantom is installed), ask Phantom to connect and sign a nonce, and
// verify the ed25519 signature here before trusting the address. The app only
// ever receives the public key: no private key or transaction signing.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function base58Encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Verify a Solana (ed25519) signature over a UTF-8 message. */
export function verifySolanaSignature(address, message, signatureBytes) {
  const pub = base58Decode(address);
  if (pub.length !== 32) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
  return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureBytes));
}

export function connectMessage(nonce, origin) {
  return `Novus Ordo wants to view your wallet address.\n\nThis signature only proves you own the address. It cannot move funds.\n\nOrigin: ${origin}\nNonce: ${nonce}`;
}

const page = (message) => `<!doctype html><html><head><meta charset="utf-8"><title>Connect Phantom — Novus Ordo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;color:#f0f2f6;
    background:radial-gradient(900px 600px at 15% -10%,rgba(255,255,255,.18),transparent 60%),linear-gradient(160deg,#70757e,#3a3e45)}
  .card{width:min(440px,92vw);padding:28px;border-radius:22px;background:rgba(40,44,51,.55);border:1px solid rgba(255,255,255,.18);
    box-shadow:0 20px 44px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.28);backdrop-filter:blur(18px)}
  h1{margin:0 0 4px;font-size:18px;letter-spacing:.18em} p{color:#b0b6c0;line-height:1.5;font-size:14px}
  button{width:100%;height:44px;border:0;border-radius:14px;font-size:15px;font-weight:600;color:#fff;cursor:pointer;
    background:linear-gradient(180deg,#ab9ff2,#7c6be0);box-shadow:0 8px 22px -8px rgba(171,159,242,.8),inset 0 1px 0 rgba(255,255,255,.35)}
  button:disabled{opacity:.5} #s{margin-top:14px;font-size:13px;min-height:18px} .ok{color:#34d1a5} .err{color:#ff6b6b}
</style></head><body><div class="card">
<h1>NOVUS ORDO</h1><p>Connect your Phantom wallet. You will be asked to sign a message that proves ownership of the address — it cannot move funds.</p>
<button id="b">Connect Phantom</button><div id="s"></div></div>
<script>
const MESSAGE = ${JSON.stringify(message)};
const s = document.getElementById('s'), b = document.getElementById('b');
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function enc58(bytes){let n=0n;for(const x of bytes)n=n*256n+BigInt(x);let o='';while(n>0n){o=B58[Number(n%58n)]+o;n/=58n}for(const x of bytes){if(x!==0)break;o='1'+o}return o}
function provider(){return window.phantom?.solana?.isPhantom ? window.phantom.solana : (window.solana?.isPhantom ? window.solana : null)}
b.onclick = async () => {
  const p = provider();
  if (!p) { s.className='err'; s.innerHTML='Phantom not detected in this browser. <a style="color:#ab9ff2" href="https://phantom.com/download" target="_blank">Install Phantom</a>, then reload this page.'; return; }
  b.disabled = true; s.className=''; s.textContent='Waiting for Phantom…';
  try {
    const r = await p.connect();
    const signed = await p.signMessage(new TextEncoder().encode(MESSAGE), 'utf8');
    const res = await fetch('callback', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ publicKey: r.publicKey.toString(), signature: enc58(signed.signature) }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'verification failed');
    s.className='ok'; s.textContent='Connected ' + j.address.slice(0,4) + '…' + j.address.slice(-4) + '. You can close this tab and return to Novus Ordo.';
  } catch (e) { s.className='err'; s.textContent = e.message || String(e); b.disabled = false; }
};
</script></body></html>`;

/**
 * Serve the connect page once and resolve with the verified address.
 * `open(url)` opens the system browser.
 */
export function connectPhantom(open, timeoutMs = 5 * 60_000) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(16).toString('hex');
    let message = '';
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== `/${nonce}/` && url.pathname !== `/${nonce}/callback`) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page(message));
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { publicKey, signature } = JSON.parse(body);
          const ok = verifySolanaSignature(publicKey, message, base58Decode(signature));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { ok: true, address: publicKey } : { ok: false, error: 'signature did not verify' }));
          if (ok) {
            finish();
            resolve({ address: publicKey, verified: true });
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
        }
      });
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Timed out waiting for Phantom'));
    }, timeoutMs);
    function finish() {
      clearTimeout(timer);
      setTimeout(() => server.close(), 1000);
    }
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      message = connectMessage(nonce, origin);
      open(`${origin}/${nonce}/`);
    });
  });
}
