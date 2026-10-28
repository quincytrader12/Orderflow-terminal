// Solana keys and transaction signing for the swarm's trading wallet, with
// Node's own ed25519 (no extra libraries). Main process only: the secret
// never reaches the window.
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { base58Decode, base58Encode } from './phantom.mjs';

// PKCS#8 wrapper for a raw 32-byte ed25519 seed
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Key pair from a 32-byte seed: the signing key, the public key and its base58 address. */
export function keypairFromSeed(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('a Solana seed is 32 bytes');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, s]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  return { key, pub, address: base58Encode(pub), seed: s };
}

export function newKeypair() {
  return keypairFromSeed(randomBytes(32));
}

/**
 * A private key as wallets export it: base58 of 64 bytes (seed + public key,
 * Phantom's "Export private key"), or the JSON byte array of the Solana CLI.
 * The public half, when present, must match the seed.
 */
export function parseSecret(text) {
  const t = String(text ?? '').trim();
  let bytes;
  if (t.startsWith('[')) bytes = Buffer.from(JSON.parse(t));
  else bytes = Buffer.from(base58Decode(t));
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('not a Solana private key (expected 64 bytes)');
  const kp = keypairFromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64 && !kp.pub.equals(bytes.subarray(32))) throw new Error('private key and public key do not match');
  return kp;
}

/** The 64-byte secret (seed + public key) in base58, as Phantom imports it. */
export function exportSecret(kp) {
  return base58Encode(Buffer.concat([kp.seed, kp.pub]));
}

/** Solana's compact-u16 length prefix: [value, bytes used]. */
export function readCompactU16(buf, at) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const b = buf[at + i];
    v |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [v, i + 1];
  }
  throw new Error('bad compact-u16');
}

/**
 * Parse a serialized transaction (legacy or v0): where the signatures sit,
 * where the message starts, and the account keys the message lists first
 * (the fee payer is key 0).
 */
export function parseTx(bytes) {
  const buf = Buffer.from(bytes);
  const [nSig, n1] = readCompactU16(buf, 0);
  const sigStart = n1;
  const msgStart = sigStart + 64 * nSig;
  let p = msgStart;
  const versioned = (buf[p] & 0x80) !== 0;
  if (versioned) p += 1;
  const header = { required: buf[p], readonlySigned: buf[p + 1], readonlyUnsigned: buf[p + 2] };
  p += 3;
  const [nKeys, n2] = readCompactU16(buf, p);
  p += n2;
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(base58Encode(buf.subarray(p + 32 * i, p + 32 * (i + 1))));
  return { buf, nSig, sigStart, msgStart, versioned, header, keys };
}

/**
 * Sign a transaction built for `kp` (Jupiter's or PumpPortal's swap): checks
 * that our wallet is a required signer — the fee payer — signs the message
 * and writes the signature into its slot. Returns the signed bytes.
 */
export function signTx(bytes, kp) {
  const tx = parseTx(bytes);
  const at = tx.keys.indexOf(kp.address);
  if (at < 0 || at >= tx.header.required) throw new Error('transaction is not for this wallet');
  if (at !== 0) throw new Error('this wallet is not the fee payer of the transaction');
  const sig = sign(null, tx.buf.subarray(tx.msgStart), kp.key);
  const out = Buffer.from(tx.buf);
  sig.copy(out, tx.sigStart + 64 * at);
  return out;
}

/** The transaction's id: its first signature, base58. */
export function txSignature(signed) {
  const tx = parseTx(signed);
  return base58Encode(tx.buf.subarray(tx.sigStart, tx.sigStart + 64));
}
