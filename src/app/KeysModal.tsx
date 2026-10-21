import { useEffect, useState, type ReactNode } from 'react';
import { desktop, isDesktop, type CcxtExchangeInfo, type KeyTest, type SecretKind, type SecretRecord } from '../desktop/bridge';
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
  trading: boolean;
}

const FLAGS = new Set(['sandbox', 'trading']);

const blank = (kind: SecretKind): Draft => ({
  kind,
  label: '',
  exchange: '',
  sandbox: false,
  trading: false,
  fields:
    kind === 'exchange'
      ? [{ name: 'apiKey', value: '' }, { name: 'secret', value: '' }]
      : kind === 'solana-rpc'
        ? [{ name: 'url', value: '' }]
        : kind === 'telegram'
          ? [{ name: 'token', value: '' }]
          : [{ name: 'key', value: '' }],
});

/** One-click connections, with where to create the key and what to tick. */
interface Quick {
  id: string;
  name: string;
  kind: SecretKind;
  exchange?: string;
  badge: string;
  url: string;
  steps: string[];
}

const NO_WITHDRAW = 'Never enable withdrawals or transfers.';

export const QUICK: Quick[] = [
  {
    id: 'binance',
    name: 'Binance',
    kind: 'exchange',
    exchange: 'binance',
    badge: 'B',
    url: 'https://www.binance.com/en/my/settings/api-management',
    steps: ['Binance → Profile → API Management → Create API → System generated.', 'Keep “Enable Reading”. Tick “Enable Spot & Margin Trading” only if you will trade from Novus Ordo.', 'Restrict access to your IP address if you can. ' + NO_WITHDRAW, 'Paste the API key and the Secret key below.'],
  },
  {
    id: 'binanceusdm',
    name: 'Binance Futures',
    kind: 'exchange',
    exchange: 'binanceusdm',
    badge: 'BF',
    url: 'https://www.binance.com/en/my/settings/api-management',
    steps: ['Same page as Binance: API Management → Create API.', 'Keep “Enable Reading”; tick “Enable Futures” only if you will trade USDⓈ-M futures.', NO_WITHDRAW, 'Paste the API key and the Secret key below.'],
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    kind: 'exchange',
    exchange: 'coinbase',
    badge: 'C',
    url: 'https://portal.cdp.coinbase.com/access/api',
    steps: ['Coinbase Developer Platform → API keys → Create API key (Secret API keys, ECDSA).', 'Permissions: View; add Trade only if you will trade. ' + NO_WITHDRAW, 'API key = the key name (organizations/…/apiKeys/…).', 'Secret = the whole private key, from -----BEGIN EC PRIVATE KEY----- to the END line.'],
  },
  {
    id: 'bybit',
    name: 'Bybit',
    kind: 'exchange',
    exchange: 'bybit',
    badge: 'BY',
    url: 'https://www.bybit.com/app/user/api-management',
    steps: ['Bybit → Account → API → Create New Key → System-generated API keys.', 'Read-Only, or Read-Write with Unified Trading / Contracts only if you will trade. ' + NO_WITHDRAW, 'Paste the API key and the Secret below.'],
  },
  {
    id: 'okx',
    name: 'OKX',
    kind: 'exchange',
    exchange: 'okx',
    badge: 'O',
    url: 'https://www.okx.com/account/my-api',
    steps: ['OKX → Profile → API keys → Create API key.', 'Choose a passphrase — you will paste it here too.', 'Permissions: Read; add Trade only if you will trade. ' + NO_WITHDRAW, 'Paste the API key, Secret and Passphrase below.'],
  },
  {
    id: 'kraken',
    name: 'Kraken',
    kind: 'exchange',
    exchange: 'kraken',
    badge: 'K',
    url: 'https://pro.kraken.com/app/settings/api',
    steps: ['Kraken → Settings → API → Create API key.', 'Tick Query Funds and Query Open/Closed Orders; add Create & Modify Orders only if you will trade. ' + NO_WITHDRAW, 'Paste the API key and the Private key (as Secret) below.'],
  },
  {
    id: 'bitget',
    name: 'Bitget',
    kind: 'exchange',
    exchange: 'bitget',
    badge: 'BG',
    url: 'https://www.bitget.com/account/newapi',
    steps: ['Bitget → Profile → API Management → Create API → System-generated.', 'Set a passphrase — you will paste it here too.', 'Read-only, or Read-write with Trade only if you will trade. ' + NO_WITHDRAW],
  },
  {
    id: 'kucoin',
    name: 'KuCoin',
    kind: 'exchange',
    exchange: 'kucoin',
    badge: 'KC',
    url: 'https://www.kucoin.com/account/api',
    steps: ['KuCoin → Account → API Management → Create API.', 'Set an API passphrase — you will paste it here too.', 'General (read); add Spot Trading only if you will trade. ' + NO_WITHDRAW],
  },
  {
    id: 'telegram',
    name: 'Telegram bot',
    kind: 'telegram',
    badge: 'TG',
    url: 'https://t.me/BotFather',
    steps: ['In Telegram, open @BotFather and send /newbot. Pick a name and a username ending in “bot”.', 'Copy the token it sends (looks like 123456:ABC-…) and paste it below.', 'Save, then open the Telegram panel: press Start in your bot’s chat and click “Detect chat”. Daily/weekly reports and alerts are switched on there.'],
  },
  {
    id: 'solana',
    name: 'Solana RPC',
    kind: 'solana-rpc',
    badge: 'SOL',
    url: 'https://solana.com/rpc',
    steps: ['Any Solana RPC URL (Helius, QuickNode, Triton…). The public endpoint is heavily rate-limited.', 'Used by the Wallet panel for balances and recent activity.'],
  },
];

const OTHER_EXCHANGE: Quick = { id: 'other', name: 'Other exchange', kind: 'exchange', badge: '+', url: 'https://docs.ccxt.com/#/Exchange-Markets', steps: ['Search any of the 100+ exchanges CCXT supports. Create a read-only API key on the exchange (add trade permission only if you will trade). ' + NO_WITHDRAW] };
const OTHER_API: Quick = { id: 'api', name: 'Other API key', kind: 'api', badge: '…', url: '', steps: ['Any other key you want kept encrypted, with your own field names.'] };

/** Fill the credential fields an exchange needs, keeping anything already typed. */
function withExchange(draft: Draft, id: string, exchanges: CcxtExchangeInfo[], name?: string): Draft {
  const info = exchanges.find((e) => e.id === id);
  const want = info?.credentials.length ? info.credentials : ['apiKey', 'secret'];
  const keep = draft.fields.filter((f) => f.value || f.stored);
  const names = new Set(keep.map((f) => f.name));
  return { ...draft, exchange: id, label: draft.label || name || info?.name || id, fields: [...keep, ...want.filter((n) => !names.has(n)).map((name) => ({ name, value: '' }))] };
}

/** Secrets that span several lines (PEM private keys) need a text area: an input drops the line breaks. */
const multiline = (draft: Draft, field: string) => field === 'privateKey' || (field === 'secret' && draft.exchange.startsWith('coinbase'));

function KeyTestCard({ state, onSaveAs }: { state: { env: 'live' | 'testnet'; busy: boolean; result?: KeyTest; error?: string }; onSaveAs: (env: 'live' | 'testnet') => void }) {
  const where = state.env === 'live' ? 'LIVE' : 'TESTNET';
  if (state.busy) return <div className="key-test muted">Testing against {where}… (read-only, no orders)</div>;
  if (state.error)
    return (
      <div className="key-test bad">
        <b>✗ {where} test failed</b>
        <div className="vault-msg">{state.error}</div>
      </div>
    );
  const t = state.result!;
  const p = t.permissions;
  const row = (ok: boolean | null, text: ReactNode) => (
    <li className={ok === null ? 'muted' : ok ? 'up' : 'down'}>
      {ok === null ? '·' : ok ? '✓' : '✗'} {text}
    </li>
  );
  return (
    <div className={`key-test ${t.futures === false || p?.withdrawals ? 'warn' : 'good'}`}>
      <ul>
        {row(true, <>Connected to {t.exchange} <b>{where}</b> — {t.assets} asset{t.assets === 1 ? '' : 's'} with a balance{t.assets === 0 && t.environment === 'live' ? ' (fine before your first deposit: the key itself works)' : ''}</>)}
        {t.futures !== null && row(t.futures, t.futures ? 'Futures access works' : `Futures: ${t.futuresError}`)}
        {p && (
          <>
            {row(p.reading, 'Reading enabled')}
            {row(p.spotTrading ? true : null, p.spotTrading ? 'Spot & margin trading enabled' : 'Spot trading not enabled (only needed to trade spot)')}
            {row(p.futures, p.futures ? 'Futures enabled' : 'Futures not enabled — needed for futures bots and positions')}
            {row(!p.withdrawals, p.withdrawals ? <b>WITHDRAWALS ARE ENABLED on this key — turn them off in Binance API Management now</b> : 'Withdrawals disabled')}
            {row(p.ipRestricted ? true : null, p.ipRestricted ? 'Restricted to trusted IPs' : 'Not IP-restricted')}
          </>
        )}
        {t.ip && <li className="muted">· {t.exchange} sees this computer as <b className="mono">{t.ip}</b>{p?.ipRestricted ? ' — it is on the key’s trusted list (the test passed). Add each place you trade from (home, work).' : ' — add it to the key’s trusted IPs if you restrict by IP.'}</li>}
      </ul>
      {t.environment !== t.saved && (
        <div className="confirm-actions">
          <span>This key is saved as {t.saved.toUpperCase()} but works on {where}.</span>
          <button className="btn" onClick={() => onSaveAs(t.environment)}>
            Save this key as {where}
          </button>
        </div>
      )}
    </div>
  );
}

export function KeysModal({ onClose, onOpenPanel }: { onClose: () => void; onOpenPanel?: (component: string) => void }) {
  const [items, setItems] = useState<SecretRecord[]>([]);
  const [exchanges, setExchanges] = useState<CcxtExchangeInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ id?: string; text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);

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
    setDraft(withExchange(draft, id, exchanges));
  };

  /** The stored key a tile stands for, if any. */
  const keyFor = (q: Quick) => items.find((r) => r.kind === q.kind && (q.kind !== 'exchange' || r.exchange === q.exchange));

  const openQuick = (q: Quick) => {
    setMsg(null);
    setJustSaved(null);
    const existing = q.id === 'other' || q.id === 'api' ? undefined : keyFor(q);
    if (existing) return edit(existing);
    const d = blank(q.kind);
    setDraft(q.exchange ? withExchange(d, q.exchange, exchanges, q.name) : { ...d, label: q.id === 'other' || q.id === 'api' ? '' : q.name });
  };

  // the guide for what is being edited: by exchange id, or by kind for the rest
  const guide = draft && (draft.kind === 'exchange' ? (QUICK.find((q) => q.exchange && q.exchange === draft.exchange) ?? OTHER_EXCHANGE) : draft.kind === 'api' ? OTHER_API : QUICK.find((q) => q.kind === draft.kind));
  const saved = justSaved ? items.find((r) => r.id === justSaved) : undefined;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const fields: Record<string, string | null> = {};
      for (const f of draft.fields) if (f.name.trim()) fields[f.name.trim()] = f.value;
      if (draft.kind === 'exchange') {
        fields.sandbox = draft.sandbox ? 'true' : null;
        fields.trading = draft.trading ? 'enabled' : null;
      }
      const id = await vault.save({ id: draft.id, kind: draft.kind, label: draft.label.trim() || KIND_LABEL[draft.kind], exchange: draft.kind === 'exchange' ? draft.exchange : null, fields });
      setDraft(null);
      setMsg({ id, text: 'Saved and encrypted.', ok: true });
      setJustSaved(id);
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
      trading: r.meta.fields.trading === 'enabled',
      fields: Object.entries(r.meta.fields)
        .filter(([k]) => !FLAGS.has(k))
        .map(([name, stored]) => ({ name, value: '', stored })),
    });

  const [tests, setTests] = useState<Record<string, { env: 'live' | 'testnet'; busy: boolean; result?: KeyTest; error?: string }>>({});
  const test = async (r: SecretRecord, env: 'live' | 'testnet') => {
    if (!desktop) return;
    setMsg(null);
    setTests((t) => ({ ...t, [r.id]: { env, busy: true } }));
    try {
      const result = await desktop.vault.test(r.id, { env });
      setTests((t) => ({ ...t, [r.id]: { env, busy: false, result } }));
    } catch (e) {
      const m = String((e as Error).message ?? e);
      const net = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|NetworkError|RequestTimeout|timed out/i.test(m);
      const clock = /-1021|outside of the recvWindow/i.test(m);
      const error = net
        ? `Could not reach ${r.exchange ?? 'the exchange'} over the network — the key was not checked. Check the internet connection, and that no firewall, proxy or VPN blocks api.binance.com, then test again. (${m})`
        : clock
          ? `Your computer's clock is out of sync with ${r.exchange ?? 'the exchange'}. In Windows: Settings → Time & language → Date & time → turn on “Set time automatically” and click “Sync now”, then test again. (${m})`
          : m;
      setTests((t) => ({ ...t, [r.id]: { env, busy: false, error } }));
    }
  };

  /** Save the key as live or testnet (keeps every other field). */
  const setEnv = async (r: SecretRecord, env: 'live' | 'testnet') => {
    await vault.save({ id: r.id, kind: r.kind, label: r.label, exchange: r.exchange, fields: { sandbox: env === 'testnet' ? 'true' : null } });
    setTests((t) => ({ ...t, [r.id]: { ...t[r.id], result: t[r.id]?.result && { ...t[r.id].result!, saved: env } } }));
    await reload();
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
    <Modal title="🔌 Connections — exchanges, Telegram & APIs" onClose={onClose} width={900}>
      {!draft && (
        <>
          <div className="section-title" style={{ marginTop: 0 }}>
            Exchanges
          </div>
          <div className="quick-grid">
            {[...QUICK.filter((q) => q.kind === 'exchange'), OTHER_EXCHANGE].map((q) => {
              const k = q.id === 'other' ? undefined : keyFor(q);
              return (
                <button key={q.id} className={`quick-tile${k ? ' connected' : ''}`} onClick={() => openQuick(q)} title={k ? `Edit ${k.label}` : `Connect ${q.name}`}>
                  <span className="badge">{q.badge}</span>
                  <span className="name">{q.name}</span>
                  <span className="state">{k ? (k.meta.fields.trading === 'enabled' ? '● trading on' : '● read-only') : q.id === 'other' ? '100+ via CCXT' : 'Connect'}</span>
                </button>
              );
            })}
          </div>
          <div className="section-title">Notifications & data</div>
          <div className="quick-grid">
            {[...QUICK.filter((q) => q.kind !== 'exchange'), OTHER_API].map((q) => {
              const k = q.id === 'api' ? undefined : keyFor(q);
              const linked = q.kind === 'telegram' && k?.meta.fields.chatId;
              return (
                <button key={q.id} className={`quick-tile${k ? ' connected' : ''}`} onClick={() => openQuick(q)} title={k ? `Edit ${k.label}` : `Connect ${q.name}`}>
                  <span className="badge">{q.badge}</span>
                  <span className="name">{q.name}</span>
                  <span className="state">{k ? (q.kind === 'telegram' ? (linked ? '● chat linked' : '● token saved — link chat') : '● connected') : q.id === 'api' ? 'Custom fields' : 'Connect'}</span>
                </button>
              );
            })}
          </div>
          {saved && onOpenPanel && (
            <div className="quick-next">
              <span className="up">✓ {saved.label} saved and encrypted.</span>
              {saved.kind === 'telegram' && (
                <button className="btn" onClick={() => (onOpenPanel('telegram'), onClose())}>
                  Open the Telegram panel → link your chat & reports
                </button>
              )}
              {saved.kind === 'exchange' && (
                <>
                  <button className="btn ghost" onClick={() => (onOpenPanel('accounts'), onClose())}>
                    Open Accounts (balances & positions)
                  </button>
                  <button className="btn ghost" onClick={() => (onOpenPanel('ticket'), onClose())}>
                    Open Order Ticket
                  </button>
                </>
              )}
              {saved.kind === 'solana-rpc' && (
                <button className="btn ghost" onClick={() => (onOpenPanel('wallet'), onClose())}>
                  Open the Wallet panel
                </button>
              )}
            </div>
          )}
        </>
      )}

      {draft && (
        <div className="vault-form">
          <div className="section-title">
            {draft.id ? 'Edit' : 'Connect'} — {draft.kind === 'exchange' ? exInfo?.name ?? guide?.name ?? 'Exchange' : guide?.name ?? KIND_LABEL[draft.kind]}
          </div>
          {guide && (
            <div className="key-guide">
              <ol>
                {guide.steps.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
              {guide.url && (
                <a href={guide.url} target="_blank" rel="noreferrer">
                  Open {guide.id === 'telegram' ? '@BotFather' : guide.id === 'other' ? 'the CCXT exchange list' : `${guide.name} API settings`} ↗
                </a>
              )}
            </div>
          )}
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
                {multiline(draft, f.name) ? (
                  <textarea
                    className="ctl mono secret-area"
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    value={f.value}
                    placeholder={f.stored ? `stored: ${f.stored} — leave blank to keep` : '-----BEGIN EC PRIVATE KEY-----\n…\n-----END EC PRIVATE KEY-----'}
                    onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                ) : (
                  <input
                    className="ctl mono"
                    type={f.name === 'url' || f.name === 'chatId' ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={f.value}
                    placeholder={f.stored ? `stored: ${f.stored} — leave blank to keep` : ''}
                    onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                )}
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
          {draft.kind === 'exchange' && (
            <div className="form-row">
              <span />
              <div className={`trade-switch${draft.trading ? ' on' : ''}`}>
                <label className="check">
                  <input type="checkbox" checked={draft.trading} onChange={(e) => setDraft({ ...draft, trading: e.target.checked })} /> <b>Allow trading with this key</b>
                </label>
                <div className="muted">
                  Lets the Order Ticket place and close orders on {draft.exchange || 'this exchange'}
                  {draft.sandbox ? ' (testnet)' : ' with real funds'}. Every order is checked against your value cap and rate limit in the desktop process and logged. The key itself also needs trade permission on the exchange — never enable withdrawals.
                </div>
              </div>
            </div>
          )}
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
      <p className="muted vault-note">
        Keys are encrypted before they are stored{' '}
        {backend === 'os'
          ? 'with your operating system’s keychain (Windows DPAPI / macOS Keychain / libsecret) in the local database'
          : backend === 'local'
            ? 'with AES-256-GCM using a key file in the app data folder (no OS keychain was available)'
            : 'in this browser with a non-exportable AES-256 key'}
        . Only masked values are ever shown. Exchange keys stay read-only in Novus Ordo until you tick “Allow trading” on a key.
      </p>
      {items.length === 0 ? (
        <div className="muted">No keys yet.</div>
      ) : (
        items.map((r) => (
          <div key={r.id} className="vault-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>{r.label}</b>
              <span className="tag">{KIND_LABEL[r.kind]}</span>
              {r.exchange && <span className="tag">{r.exchange}</span>}
              {r.kind === 'exchange' && (
                <span className={`env-badge ${r.meta.fields.sandbox === 'true' ? 'test' : 'live'}`} title={r.meta.fields.sandbox === 'true' ? 'Saved as a testnet key — Edit and untick “testnet / sandbox” for a key from the real exchange' : 'Saved as a live key (the real exchange)'}>
                  {r.meta.fields.sandbox === 'true' ? 'TESTNET' : 'LIVE'}
                </span>
              )}
              {r.kind === 'exchange' && <span className={`tag ${r.meta.fields.trading === 'enabled' ? 'tag-live' : ''}`}>{r.meta.fields.trading === 'enabled' ? 'trading on' : 'read-only'}</span>}
              <span style={{ flex: 1 }} />
              {r.kind === 'exchange' && isDesktop && (
                <>
                  <button className="chip" disabled={tests[r.id]?.busy} onClick={() => void test(r, 'live')} title="Read-only check against the real exchange — no orders">
                    Test live
                  </button>
                  <button className="chip" disabled={tests[r.id]?.busy} onClick={() => void test(r, 'testnet')} title="Read-only check against the exchange’s testnet">
                    Test testnet
                  </button>
                </>
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
                .filter(([k]) => !FLAGS.has(k))
                .map(([k, v]) => (
                  <span key={k} className="vault-field">
                    <span className="muted">{FIELD_LABEL[k] ?? k}</span> <span className="mono">{v}</span>
                    <button className="link" title="Copy to clipboard" onClick={() => void copy(r, k)}>
                      copy
                    </button>
                  </span>
                ))}
            </div>
            {msg?.id === r.id && <div className={`vault-msg ${msg.ok ? 'up' : 'down'}`}>{msg.text}</div>}
            {tests[r.id] && <KeyTestCard state={tests[r.id]} onSaveAs={(env) => void setEnv(r, env)} />}
          </div>
        ))
      )}
    </Modal>
  );
}
