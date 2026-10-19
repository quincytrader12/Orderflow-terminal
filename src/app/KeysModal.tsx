import { useEffect, useState } from 'react';
import { desktop, isDesktop, type CcxtExchangeInfo, type SecretKind, type SecretRecord } from '../desktop/bridge';
import { vault } from '../desktop/vault';
import { Modal } from './Modals';

const KIND_LABEL: Record<SecretKind, string> = { exchange: 'Exchange (CCXT)', 'solana-rpc': 'Solana RPC', telegram: 'Telegram bot', api: 'Other API key' };

const FIELD_LABEL: Record<string, string> = {
  apiKey: 'API key',
  secret: 'Secret',
  password: 'Passphrase',
  uid: 'UID',
  login: 'Login',
  twofa: '2FA secret',
  privateKey: 'Private key',
  walletAddress: 'Wallet address',
  token: 'Token',
  url: 'RPC URL',
  chatId: 'Chat id',
  key: 'Key',
};

interface Draft {
  id?: string;
  kind: SecretKind;
  label: string;
  exchange: string;
  fields: { name: string; value: string; stored?: string }[];
  sandbox: boolean;
}

const blank = (kind: SecretKind): Draft => ({
  kind,
  label: '',
  exchange: '',
  sandbox: false,
  fields:
    kind === 'exchange'
      ? [{ name: 'apiKey', value: '' }, { name: 'secret', value: '' }]
      : kind === 'solana-rpc'
        ? [{ name: 'url', value: '' }]
        : kind === 'telegram'
          ? [{ name: 'token', value: '' }]
          : [{ name: 'key', value: '' }],
});

export function KeysModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<SecretRecord[]>([]);
  const [exchanges, setExchanges] = useState<CcxtExchangeInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ id?: string; text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    vault
      .list()
      .then(setItems)
      .catch((e) => setMsg({ text: String(e.message ?? e), ok: false }));
  useEffect(() => {
    void reload();
    desktop?.ccxt.exchanges().then(setExchanges).catch(() => undefined);
  }, []);

  const exInfo = exchanges.find((e) => e.id === draft?.exchange);

  const pickExchange = (id: string) => {
    if (!draft) return;
    const info = exchanges.find((e) => e.id === id);
    const want = info?.credentials.length ? info.credentials : ['apiKey', 'secret'];
    const keep = draft.fields.filter((f) => f.value || f.stored);
    const names = new Set(keep.map((f) => f.name));
    setDraft({ ...draft, exchange: id, label: draft.label || info?.name || id, fields: [...keep, ...want.filter((n) => !names.has(n)).map((name) => ({ name, value: '' }))] });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const fields: Record<string, string | null> = {};
      for (const f of draft.fields) if (f.name.trim()) fields[f.name.trim()] = f.value;
      if (draft.kind === 'exchange') fields.sandbox = draft.sandbox ? 'true' : null;
      const id = await vault.save({ id: draft.id, kind: draft.kind, label: draft.label.trim() || KIND_LABEL[draft.kind], exchange: draft.kind === 'exchange' ? draft.exchange : null, fields });
      setDraft(null);
      setMsg({ id, text: 'Saved and encrypted.', ok: true });
      await reload();
    } catch (e) {
      setMsg({ text: String((e as Error).message ?? e), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const edit = (r: SecretRecord) =>
    setDraft({
      id: r.id,
      kind: r.kind,
      label: r.label,
      exchange: r.exchange ?? '',
      sandbox: r.meta.fields.sandbox === 'true' || r.meta.fields.sandbox === '••••',
      fields: Object.entries(r.meta.fields)
        .filter(([k]) => k !== 'sandbox')
        .map(([name, stored]) => ({ name, value: '', stored })),
    });

  const test = async (r: SecretRecord) => {
    if (!desktop) return;
    setMsg({ id: r.id, text: 'Testing…', ok: true });
    try {
      const t = await desktop.vault.test(r.id);
      setMsg({ id: r.id, text: `Connected to ${t.exchange} — ${t.assets} assets with a balance.`, ok: true });
    } catch (e) {
      setMsg({ id: r.id, text: String((e as Error).message ?? e), ok: false });
    }
  };

  const copy = async (r: SecretRecord, field: string) => {
    try {
      await vault.copy(r.id, field);
      setMsg({ id: r.id, text: `${FIELD_LABEL[field] ?? field} copied${isDesktop ? ' (clipboard clears in 30s)' : ''}.`, ok: true });
    } catch (e) {
      setMsg({ id: r.id, text: String((e as Error).message ?? e), ok: false });
    }
  };

  const backend = items[0]?.backend ?? (isDesktop ? 'os' : 'browser');

  return (
    <Modal title="🔑 API key vault" onClose={onClose} width={860}>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Keys are encrypted before they are stored{' '}
        {backend === 'os'
          ? 'with your operating system’s keychain (Windows DPAPI / macOS Keychain / libsecret) in the local database'
          : backend === 'local'
            ? 'with AES-256-GCM using a key file in the app data folder (no OS keychain was available)'
            : 'in this browser with a non-exportable AES-256 key'}
        . The interface only ever shows masked values; copying a value puts it on the clipboard without displaying it. Exchange keys are used by CCXT in the {isDesktop ? 'desktop process' : 'desktop app'} for balances, positions and orders. Use read-only keys where the exchange offers them.
      </p>

      {!draft && (
        <div className="chip-row">
          {(Object.keys(KIND_LABEL) as SecretKind[]).map((k) => (
            <button key={k} className="btn ghost" onClick={() => setDraft(blank(k))}>
              + {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="vault-form">
          <div className="section-title">{draft.id ? 'Edit' : 'New'} — {KIND_LABEL[draft.kind]}</div>
          {draft.kind === 'exchange' && (
            <div className="form-row">
              <span>Exchange</span>
              <div>
                <input
                  className="ctl"
                  list="ccxt-exchanges"
                  value={draft.exchange}
                  placeholder={exchanges.length ? `Search ${exchanges.length} CCXT exchanges…` : 'exchange id, e.g. binance'}
                  onChange={(e) => setDraft({ ...draft, exchange: e.target.value.trim().toLowerCase() })}
                  onBlur={(e) => pickExchange(e.target.value.trim().toLowerCase())}
                />
                <datalist id="ccxt-exchanges">
                  {exchanges.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </datalist>
                {exInfo && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{exInfo.name} needs: {exInfo.credentials.map((c) => FIELD_LABEL[c] ?? c).join(', ') || 'apiKey, secret'}</div>}
              </div>
            </div>
          )}
          <div className="form-row">
            <span>Label</span>
            <input className="ctl" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Main account (read-only)" />
          </div>
          {draft.fields.map((f, i) => (
            <div className="form-row" key={i}>
              {draft.kind === 'api' ? (
                <input className="ctl" value={f.name} placeholder="field name" onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              ) : (
                <span>{FIELD_LABEL[f.name] ?? f.name}</span>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="ctl mono"
                  type={f.name === 'url' || f.name === 'chatId' ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={f.value}
                  placeholder={f.stored ? `stored: ${f.stored} — leave blank to keep` : ''}
                  onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                />
                <button className="chip" title="Remove field" onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="form-row">
            <span />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="chip" onClick={() => setDraft({ ...draft, fields: [...draft.fields, { name: draft.kind === 'exchange' ? 'password' : '', value: '' }] })}>
                + field
              </button>
              {draft.kind === 'exchange' && (
                <label className="check">
                  <input type="checkbox" checked={draft.sandbox} onChange={(e) => setDraft({ ...draft, sandbox: e.target.checked })} /> testnet / sandbox
                </label>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn" disabled={busy || (draft.kind === 'exchange' && !draft.exchange)} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save encrypted'}
            </button>
          </div>
        </div>
      )}

      {msg && !msg.id && <div className={msg.ok ? 'up' : 'down'} style={{ margin: '8px 0' }}>{msg.text}</div>}

      <div className="section-title">Stored keys ({items.length})</div>
      {items.length === 0 ? (
        <div className="muted">No keys yet.</div>
      ) : (
        items.map((r) => (
          <div key={r.id} className="vault-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>{r.label}</b>
              <span className="tag">{KIND_LABEL[r.kind]}</span>
              {r.exchange && <span className="tag">{r.exchange}</span>}
              <span style={{ flex: 1 }} />
              {r.kind === 'exchange' && isDesktop && (
                <button className="chip" onClick={() => void test(r)}>
                  Test
                </button>
              )}
              <button className="chip" onClick={() => edit(r)}>
                Edit
              </button>
              <button
                className="chip"
                onClick={async () => {
                  if (!confirm(`Delete “${r.label}”? This cannot be undone.`)) return;
                  await vault.remove(r.id);
                  await reload();
                }}
              >
                Delete
              </button>
            </div>
            <div className="vault-fields">
              {Object.entries(r.meta.fields)
                .filter(([k]) => k !== 'sandbox')
                .map(([k, v]) => (
                  <span key={k} className="vault-field">
                    <span className="muted">{FIELD_LABEL[k] ?? k}</span> <span className="mono">{v}</span>
                    <button className="link" title="Copy to clipboard" onClick={() => void copy(r, k)}>
                      copy
                    </button>
                  </span>
                ))}
            </div>
            {msg?.id === r.id && <div className={msg.ok ? 'up' : 'down'}>{msg.text}</div>}
          </div>
        ))
      )}
    </Modal>
  );
}
