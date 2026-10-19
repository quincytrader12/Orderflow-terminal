// Encrypted API-key vault. Secret values are encrypted before they touch the
// database and are never sent back to the UI — the UI only sees labels and
// masked previews. Decryption happens in the main process when a key is used.
//
// Encryption: Electron safeStorage (Windows DPAPI, macOS Keychain, Linux
// libsecret). When the OS store is unavailable, AES-256-GCM with a random
// 256-bit key file kept beside the database (marked as "local key" in the UI).
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}${'•'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/** Fields that are not secret and may be shown in full (e.g. an RPC host, or flags). */
const PUBLIC_FIELDS = new Set(['url', 'address', 'walletAddress', 'note', 'chatId', 'sandbox', 'trading']);

export class Vault {
  /**
   * @param db Db instance
   * @param safeStorage Electron safeStorage (or a test double)
   * @param fallbackKeyFile path for the AES key used when safeStorage is unavailable
   */
  constructor(db, safeStorage, fallbackKeyFile) {
    this.db = db;
    this.safe = safeStorage;
    this.keyFile = fallbackKeyFile;
  }

  get backend() {
    try {
      if (this.safe?.isEncryptionAvailable()) {
        const b = this.safe.getSelectedStorageBackend?.();
        // basic_text on Linux means no real keyring: use our own AES key instead
        if (b !== 'basic_text') return 'os';
      }
    } catch {
      /* fall through */
    }
    return 'local';
  }

  localKey() {
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { mode: 0o600 });
    return readFileSync(this.keyFile);
  }

  encrypt(obj) {
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    if (this.backend === 'os') return Buffer.concat([Buffer.from('O1'), this.safe.encryptString(plain.toString('utf8'))]);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.localKey(), iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from('L1'), iv, c.getAuthTag(), body]);
  }

  decrypt(buf) {
    const b = Buffer.from(buf);
    const tag = b.subarray(0, 2).toString();
    if (tag === 'O1') return JSON.parse(this.safe.decryptString(b.subarray(2)));
    if (tag === 'L1') {
      const iv = b.subarray(2, 14);
      const at = b.subarray(14, 30);
      const d = createDecipheriv('aes-256-gcm', this.localKey(), iv);
      d.setAuthTag(at);
      return JSON.parse(Buffer.concat([d.update(b.subarray(30)), d.final()]).toString('utf8'));
    }
    throw new Error('unknown vault record format');
  }

  /** Metadata and masked previews only. */
  list() {
    return this.db.listSecrets().map((r) => ({ ...r, meta: JSON.parse(r.meta), backend: this.backend }));
  }

  /**
   * Create or update. `fields` holds any key/value pairs (apiKey, secret,
   * password, uid, url, token …). On update, empty field values keep the
   * stored value so the UI never needs the plaintext.
   */
  save({ id, label, kind, exchange, fields }) {
    const existing = id ? this.db.getSecret(id) : null;
    const prev = existing ? this.decrypt(existing.enc) : {};
    const merged = { ...prev };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === null) delete merged[k];
      else if (String(v).length) merged[k] = String(v);
    }
    const meta = {
      fields: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, PUBLIC_FIELDS.has(k) ? v : mask(v)])),
    };
    const rid = id ?? randomUUID();
    this.db.putSecret({ id: rid, label: label || kind, kind, exchange, meta: JSON.stringify(meta), enc: this.encrypt(merged) });
    return rid;
  }

  remove(id) {
    this.db.deleteSecret(id);
  }

  /** Main-process only: plaintext fields for a stored secret. */
  reveal(id) {
    const r = this.db.getSecret(id);
    if (!r) throw new Error('secret not found');
    return { kind: r.kind, exchange: r.exchange, label: r.label, fields: this.decrypt(r.enc) };
  }
}
