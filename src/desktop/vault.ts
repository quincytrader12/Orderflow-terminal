import { desktop, type SecretInput, type SecretRecord } from './bridge';

/**
 * API-key vault facade. The desktop app stores keys in SQLite encrypted with
 * the OS keychain (see electron/vault.mjs). In a plain browser, keys are kept
 * in IndexedDB encrypted with a non-extractable AES-GCM key that page scripts
 * cannot export; plaintext never leaves this module except to the caller
 * that asked for it.
 */

const DB = 'novus-vault';
const STORE = 'secrets';
const KEY_STORE = 'keys';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.result.createObjectStore(KEY_STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function aesKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await tx<CryptoKey | undefined>(db, KEY_STORE, 'readonly', (s) => s.get('main') as IDBRequest<CryptoKey | undefined>);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await tx(db, KEY_STORE, 'readwrite', (s) => s.put(key, 'main'));
  return key;
}

interface StoredWeb {
  id: string;
  label: string;
  kind: SecretRecord['kind'];
  exchange: string | null;
  meta: SecretRecord['meta'];
  iv: Uint8Array;
  data: ArrayBuffer;
  created: number;
  updated: number;
}

export function maskValue(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  return `${v.slice(0, 4)}${'•'.repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

const PUBLIC_FIELDS = new Set(['url', 'address', 'walletAddress', 'note']);

async function webDecrypt(db: IDBDatabase, rec: StoredWeb): Promise<Record<string, string>> {
  const key = await aesKey(db);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource }, key, rec.data);
  return JSON.parse(new TextDecoder().decode(plain));
}

export const vault = {
  async list(): Promise<SecretRecord[]> {
    if (desktop) return desktop.vault.list();
    const db = await idb();
    const all = await tx<StoredWeb[]>(db, STORE, 'readonly', (s) => s.getAll() as IDBRequest<StoredWeb[]>);
    return all.sort((a, b) => b.updated - a.updated).map(({ iv: _iv, data: _d, ...r }) => ({ ...r, backend: 'browser' as const }));
  },

  async save(input: SecretInput): Promise<string> {
    if (desktop) return desktop.vault.save(input);
    const db = await idb();
    const id = input.id ?? crypto.randomUUID();
    const prevRec = input.id ? await tx<StoredWeb | undefined>(db, STORE, 'readonly', (s) => s.get(id) as IDBRequest<StoredWeb | undefined>) : undefined;
    const fields: Record<string, string> = prevRec ? await webDecrypt(db, prevRec) : {};
    for (const [k, v] of Object.entries(input.fields)) {
      if (v === null) delete fields[k];
      else if (v.length) fields[k] = v;
    }
    const key = await aesKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(fields)));
    const now = Date.now();
    const rec: StoredWeb = {
      id,
      label: input.label || input.kind,
      kind: input.kind,
      exchange: input.exchange ?? null,
      meta: { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, PUBLIC_FIELDS.has(k) ? v : maskValue(v)])) },
      iv,
      data,
      created: prevRec?.created ?? now,
      updated: now,
    };
    await tx(db, STORE, 'readwrite', (s) => s.put(rec));
    return id;
  },

  async remove(id: string): Promise<void> {
    if (desktop) return desktop.vault.remove(id);
    const db = await idb();
    await tx(db, STORE, 'readwrite', (s) => s.delete(id));
  },

  /** Copy one field to the clipboard without returning it to the UI. */
  async copy(id: string, field: string): Promise<void> {
    if (desktop) {
      await desktop.vault.copy(id, field);
      return;
    }
    const db = await idb();
    const rec = await tx<StoredWeb | undefined>(db, STORE, 'readonly', (s) => s.get(id) as IDBRequest<StoredWeb | undefined>);
    if (!rec) throw new Error('secret not found');
    const v = (await webDecrypt(db, rec))[field];
    if (v === undefined) throw new Error(`no field ${field}`);
    await navigator.clipboard.writeText(v);
  },

  /** Browser only: plaintext fields for a stored record (used for RPC URLs). */
  async webFields(id: string): Promise<Record<string, string>> {
    const db = await idb();
    const rec = await tx<StoredWeb | undefined>(db, STORE, 'readonly', (s) => s.get(id) as IDBRequest<StoredWeb | undefined>);
    if (!rec) throw new Error('secret not found');
    return webDecrypt(db, rec);
  },
};
