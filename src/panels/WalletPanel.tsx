import { useEffect, useState } from 'react';
import { fmtNum, fmtUsd } from '../core/format';
import { desktop, isDesktop, type SecretRecord } from '../desktop/bridge';
import { vault } from '../desktop/vault';
import { balancesFor, BASE58, connectPhantom, infoFor } from '../desktop/wallet';
import { SOL_MINT, type TokenInfo, type WalletBalances } from '../shared/solana';
import { useSettings } from '../store/settings';
import { Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export interface WalletConfig {
  address: string;
  rpcSecretId: string;
  hideDust: boolean;
}

export const WALLET_DEFAULTS: WalletConfig = { address: '', rpcSecretId: '', hideDust: true };

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function PhantomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 128 128" aria-hidden>
      <rect width="128" height="128" rx="28" fill="#ab9ff2" />
      <path d="M33 86c10 0 17-9 20-14 0 6 4 9 9 9s8-3 10-7c0 4 3 6 6 6 9 0 18-17 18-31C96 30 83 22 66 22 41 22 22 43 22 64c0 13 4 22 11 22z" fill="#fff" />
      <ellipse cx="58" cy="52" rx="5" ry="8" fill="#ab9ff2" />
      <ellipse cx="78" cy="52" rx="5" ry="8" fill="#ab9ff2" />
    </svg>
  );
}

export function WalletPanel({ config: c, setConfig }: PanelProps<WalletConfig>) {
  const wallets = useSettings((s) => s.wallets);
  const set = useSettings((s) => s.set);
  const [rpcs, setRpcs] = useState<SecretRecord[]>([]);
  const [bal, setBal] = useState<WalletBalances | null>(null);
  const [info, setInfo] = useState<TokenInfo>({ prices: {}, meta: {} });
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  const [watch, setWatch] = useState('');

  const address = c.address || wallets[0]?.address || '';

  useEffect(() => {
    vault
      .list()
      .then((all) => setRpcs(all.filter((k) => k.kind === 'solana-rpc')))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    const load = async () => {
      try {
        const b = await balancesFor(address, c.rpcSecretId);
        if (!alive) return;
        setBal(b);
        setErr('');
        const i = await infoFor(b.tokens.map((t) => t.mint));
        if (alive) setInfo(i);
      } catch (e) {
        if (alive) setErr(String((e as Error).message ?? e));
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address, c.rpcSecretId]);

  const addWallet = (addr: string, verified: boolean) => {
    const rest = wallets.filter((w) => w.address !== addr);
    set({ wallets: [{ address: addr, chain: 'solana', verified: verified || wallets.some((w) => w.address === addr && w.verified) }, ...rest] });
    setConfig({ address: addr });
  };

  const connect = async () => {
    setErr('');
    setStatus(isDesktop ? 'Opened your browser — approve the connection in Phantom…' : 'Approve the connection in Phantom…');
    try {
      const r = await connectPhantom();
      addWallet(r.address, r.verified);
      setStatus(`Connected ${short(r.address)}`);
    } catch (e) {
      setStatus('');
      setErr(String((e as Error).message ?? e));
    }
  };

  const solPrice = info.prices[SOL_MINT];
  const rows = (bal?.tokens ?? [])
    .map((t) => ({ ...t, price: info.prices[t.mint], meta: info.meta[t.mint] }))
    .map((t) => ({ ...t, usd: t.price !== undefined ? t.price * t.amount : NaN }))
    .filter((t) => !c.hideDust || !(t.usd < 1))
    .sort((a, b) => (isFinite(b.usd) ? b.usd : -1) - (isFinite(a.usd) ? a.usd : -1));
  const total = (bal ? bal.sol * (solPrice ?? 0) : 0) + rows.reduce((a, t) => a + (isFinite(t.usd) ? t.usd : 0), 0);
  const current = wallets.find((w) => w.address === address);

  return (
    <div className="panel">
      <Toolbar>
        <button className="btn phantom" onClick={() => void connect()}>
          <PhantomIcon /> Connect Phantom
        </button>
        {wallets.length > 0 && (
          <Select value={address} options={wallets.map((w) => ({ value: w.address, label: `${short(w.address)}${w.verified ? ' ✓' : ' (watch)'}` }))} onChange={(a) => setConfig({ address: a })} width={130} />
        )}
        <Select value={c.rpcSecretId} options={[{ value: '', label: 'Public RPC' }, ...rpcs.map((r) => ({ value: r.id, label: r.label }))]} onChange={(rpcSecretId) => setConfig({ rpcSecretId })} title="Solana RPC (add a private one in 🔑 Keys)" width={110} />
        <Spacer />
        {address && (
          <button
            className="chip"
            title="Forget this wallet"
            onClick={() => {
              set({ wallets: wallets.filter((w) => w.address !== address) });
              void desktop?.wallet.remove(address);
              setConfig({ address: '' });
              setBal(null);
            }}
          >
            Disconnect
          </button>
        )}
      </Toolbar>
      {status && <div className="muted" style={{ padding: '6px 10px' }}>{status}</div>}
      {err && !address && <div className="down" style={{ padding: '6px 10px' }}>{err}</div>}
      {!address ? (
        <div className="scroll">
          <Empty>
            Connect Phantom to see your Solana balances. {isDesktop ? 'The app opens a one-time page in your default browser where Phantom is installed; you sign a message proving ownership — it cannot move funds.' : 'You will sign a message proving ownership — it cannot move funds.'}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 12 }}>
              <input className="ctl mono" placeholder="…or watch any address" value={watch} onChange={(e) => setWatch(e.target.value.trim())} style={{ width: 260 }} />
              <button
                className="chip"
                disabled={!BASE58.test(watch)}
                onClick={() => {
                  addWallet(watch, false);
                  void desktop?.wallet.watch(watch);
                  setWatch('');
                }}
              >
                Watch
              </button>
            </div>
          </Empty>
        </div>
      ) : (
        <div className="scroll">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat">
              <div className="k">Wallet {current?.verified ? '· verified' : '· watch-only'}</div>
              <div className="v mono" title={address}>
                {short(address)}
              </div>
              <div className="s">
                <button className="link" onClick={() => void navigator.clipboard.writeText(address)}>
                  copy
                </button>{' '}
                ·{' '}
                <a href={`https://solscan.io/account/${address}`} target="_blank" rel="noreferrer noopener">
                  Solscan
                </a>
              </div>
            </div>
            <div className="stat">
              <div className="k">SOL</div>
              <div className="v">{bal ? fmtNum(bal.sol, 4) : '…'}</div>
              <div className="s">{solPrice && bal ? fmtUsd(bal.sol * solPrice) : ''}</div>
            </div>
            <div className="stat">
              <div className="k">Est. value</div>
              <div className="v up">{bal ? fmtUsd(total) : '…'}</div>
              <div className="s">{rows.length} tokens</div>
            </div>
          </div>
          {err && <div className="down" style={{ padding: '4px 10px' }}>{err}</div>}
          <div className="toolbar" style={{ borderBottom: 'none' }}>
            <label className="check">
              <input type="checkbox" checked={c.hideDust} onChange={(e) => setConfig({ hideDust: e.target.checked })} /> hide tokens under $1
            </label>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Token</th>
                <th>Amount</th>
                <th>Price</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.mint}>
                  <td className="l" title={t.mint}>
                    <b>{t.meta?.symbol ?? short(t.mint)}</b> <span className="muted">{t.meta?.name ?? ''}</span>
                  </td>
                  <td>{fmtNum(t.amount, 4)}</td>
                  <td className="muted">{t.price !== undefined ? fmtUsd(t.price, 4) : '—'}</td>
                  <td>{isFinite(t.usd) ? fmtUsd(t.usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="empty" style={{ textAlign: 'left', padding: '8px 10px' }}>
            Read-only: Novus Ordo stores only your public address. Prices from Jupiter; balances from {c.rpcSecretId ? 'your RPC' : 'the public Solana RPC (rate-limited — add your own in 🔑 Keys)'}.
          </div>
        </div>
      )}
    </div>
  );
}
