import { useEffect, useMemo, useState } from 'react';
import { fmtNum, fmtPrice, fmtTime, fmtUsd } from '../core/format';
import { desktop, DesktopOnlyError, type MarketInfo, type OrderLogRow, type OrderRequest, type OrderType, type TimeInForce } from '../desktop/bridge';
import { forwardAlert } from '../desktop/telegram';
import { describeOrder, estimateValue, pickSymbol, TYPE_LABEL, unifiedCandidates, useTicket } from '../desktop/trading';
import { useVaultKeys } from '../desktop/vault';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { Check, Chip, Empty, Popover, Select, Spacer, Toolbar, useHubVersion, type PanelProps } from '../ui/controls';

export interface TicketConfig {
  secretId: string;
  /** unified CCXT symbol; ignored while following the chart */
  symbol: string;
  follow: boolean;
  type: OrderType;
  sizeMode: 'base' | 'quote';
  tif: TimeInForce;
  reduceOnly: boolean;
  postOnly: boolean;
  /** 0 = leave the exchange setting alone */
  leverage: number;
}

export const TICKET_DEFAULTS: TicketConfig = { secretId: '', symbol: '', follow: true, type: 'limit', sizeMode: 'quote', tif: 'GTC', reduceOnly: false, postOnly: false, leverage: 0 };

const num = (s: string) => {
  const v = parseFloat(s.replace(/,/g, ''));
  return isFinite(v) ? v : undefined;
};

export function OrderTicket({ config: c, setConfig }: PanelProps<TicketConfig>) {
  useHubVersion();
  const settings = useSettings();
  const ticket = useTicket();
  const keys = useVaultKeys('exchange') ?? [];
  const [markets, setMarkets] = useState<string[]>([]);
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [infoErr, setInfoErr] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');
  const [size, setSize] = useState('');
  const [pending, setPending] = useState<OrderRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [log, setLog] = useState<OrderLogRow[]>([]);

  // default to the first key that may trade
  useEffect(() => {
    if ((!c.secretId || !keys.some((k) => k.id === c.secretId)) && keys[0]) setConfig({ secretId: (keys.find((k) => k.meta.fields.trading === 'enabled') ?? keys[0]).id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  const key = keys.find((k) => k.id === c.secretId);
  const keyTrading = key?.meta.fields.trading;
  const exchangeId = key?.exchange ?? '';

  useEffect(() => {
    setMarkets([]);
    if (!desktop || !exchangeId) return;
    desktop.ccxt
      .markets(exchangeId)
      .then((m) => setMarkets(m.map((x) => x.symbol)))
      .catch(() => undefined);
  }, [exchangeId]);

  const chartInst = hub().primary.inst;
  const followed = useMemo(() => (markets.length ? pickSymbol(unifiedCandidates(chartInst), markets) : null), [markets, chartInst.venue, chartInst.symbol]);
  const symbol = c.follow ? followed ?? '' : c.symbol;

  // market details, balances and the current bid/ask (refreshed every 10s)
  useEffect(() => {
    setInfo(null);
    setInfoErr('');
    if (!desktop || !c.secretId || !symbol) return;
    let alive = true;
    const load = () =>
      desktop!.trade
        .marketInfo(c.secretId, symbol)
        .then((i) => alive && (setInfo(i), setInfoErr('')))
        .catch((e) => alive && setInfoErr(String(e?.message ?? e)));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.secretId, symbol, keyTrading]);

  const loadLog = () =>
    desktop?.trade
      .log(8)
      .then(setLog)
      .catch(() => undefined);
  useEffect(() => {
    void loadLog();
    const t = setInterval(loadLog, 10_000);
    return () => clearInterval(t);
  }, []);

  // price clicked in the DOM ladder: limit order at that level, side by where it sits
  useEffect(() => {
    if (!ticket.nonce || ticket.price === null) return;
    setPrice(String(ticket.price));
    if (c.type === 'market') setConfig({ type: 'limit' });
    const last = info?.last ?? hub().primary.lastPrice();
    if (ticket.side) setSide(ticket.side);
    else if (isFinite(last)) setSide(ticket.price <= last ? 'buy' : 'sell');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.nonce]);

  if (!desktop) return <Empty>{new DesktopOnlyError('Order placement').message}</Empty>;

  const isLimit = c.type === 'limit' || c.type === 'stop-limit';
  const isStop = c.type === 'stop-market' || c.type === 'stop-limit';
  const contract = Boolean(info?.contract);
  const unit = c.sizeMode === 'quote' ? info?.quote ?? 'USD' : info?.base ?? 'base';

  const req: OrderRequest = {
    symbol,
    side,
    type: c.type,
    sizeMode: c.sizeMode,
    size: num(size) ?? 0,
    price: isLimit ? num(price) : undefined,
    triggerPrice: isStop ? num(trigger) : undefined,
    reduceOnly: contract && c.reduceOnly ? true : undefined,
    postOnly: c.type === 'limit' && c.postOnly ? true : undefined,
    tif: isLimit ? c.tif : undefined,
    leverage: contract && info?.canLeverage && c.leverage > 0 ? c.leverage : undefined,
  };
  const value = info ? estimateValue(req, info) : NaN;
  const fee = info?.taker && isFinite(value) ? value * (c.type === 'limit' && c.postOnly ? info.maker ?? info.taker : info.taker) : NaN;

  const blocker = !key
    ? 'Choose an exchange key'
    : !symbol
      ? c.follow
        ? `${key.exchange} does not list the chart’s market — untick “follow chart” and pick a symbol`
        : 'Enter a symbol'
      : infoErr
        ? infoErr
        : !info
          ? 'Loading market…'
          : !info.trading
            ? 'Trading is off for this key — edit it in 🔑 Keys and tick “Allow trading”'
            : !(req.size > 0)
              ? 'Enter a size'
              : isLimit && !req.price
                ? 'Enter a limit price'
                : isStop && !req.triggerPrice
                  ? 'Enter a trigger price'
                  : !req.reduceOnly && isFinite(value) && value > info.limits.maxOrderUsd
                    ? `Above your $${fmtNum(info.limits.maxOrderUsd, 0)} order cap (⚙)`
                    : '';

  const send = async (r: OrderRequest) => {
    setPending(null);
    setBusy(true);
    setResult(null);
    try {
      const res = await desktop!.trade.place(c.secretId, r);
      const text = `${res.sandbox ? 'TESTNET · ' : ''}${res.side.toUpperCase()} ${res.amount.toLocaleString('en-US', { maximumFractionDigits: 10 })} ${res.symbol} ${res.status}${res.id ? ` · id ${res.id}` : ''}`;
      setResult({ ok: true, text });
      forwardAlert('Order placed', describeOrder(r, info!));
    } catch (e) {
      setResult({ ok: false, text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
      void loadLog();
    }
  };

  const submit = () => {
    if (blocker || busy) return;
    if (settings.confirmOrders) setPending(req);
    else void send(req);
  };

  // % of what is free: quote to buy (×leverage on derivatives), base to sell spot
  const fillPct = (pct: number) => {
    if (!info) return;
    const lev = contract ? Math.max(1, c.leverage || 1) : 1;
    const px = (side === 'buy' ? info.ask : info.bid) ?? info.last;
    const spendQuote = side === 'sell' && !contract ? (info.freeBase ?? 0) * px : (info.freeQuote ?? 0) * lev;
    const q = spendQuote * pct * 0.995;
    if (!(q > 0)) return;
    setSize(c.sizeMode === 'quote' ? q.toFixed(2) : String(Number((q / px).toPrecision(6))));
  };

  const setLimits = (patch: Partial<MarketInfo['limits']>) =>
    desktop!.trade
      .setLimits({ ...info?.limits, ...patch })
      .then((limits) => info && setInfo({ ...info, limits }))
      .catch(() => undefined);

  return (
    <div className="panel ticket">
      <Toolbar>
        <Select
          value={c.secretId}
          options={[{ value: '', label: keys.length ? 'Choose key…' : 'No exchange keys' }, ...keys.map((k) => ({ value: k.id, label: `${k.label} · ${k.exchange}${k.meta.fields.trading === 'enabled' ? '' : ' (read-only)'}` }))]}
          onChange={(secretId) => setConfig({ secretId })}
          width={130}
        />
        <Chip active={c.follow} onClick={() => setConfig({ follow: !c.follow, symbol: c.symbol || followed || '' })} title="Trade the market shown on the chart">
          follow chart
        </Chip>
        {!c.follow && (
          <>
            <input className="ctl mono" list="ticket-markets" style={{ width: 130 }} value={c.symbol} placeholder="BTC/USDT:USDT" onChange={(e) => setConfig({ symbol: e.target.value.trim().toUpperCase() })} />
            <datalist id="ticket-markets">
              {markets.slice(0, 3000).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}
        <Spacer />
        {info && <span className={`env-badge ${info.sandbox ? 'test' : 'live'}`}>{info.sandbox ? 'TESTNET' : 'LIVE'}</span>}
        <Popover label="⚙" title="Order limits" align="right">
          <div className="section-title" style={{ marginTop: 0 }}>
            Safety limits (enforced by the desktop process)
          </div>
          <label className="form-row compact">
            <span>Max order value (USD)</span>
            <input className="ctl" type="number" min={1} defaultValue={info?.limits.maxOrderUsd ?? 1000} onBlur={(e) => void setLimits({ maxOrderUsd: Number(e.target.value) })} />
          </label>
          <label className="form-row compact">
            <span>Max orders / minute</span>
            <input className="ctl" type="number" min={1} defaultValue={info?.limits.maxOrdersPerMinute ?? 10} onBlur={(e) => void setLimits({ maxOrdersPerMinute: Number(e.target.value) })} />
          </label>
          <label className="form-row compact">
            <span>Max distance from market %</span>
            <input className="ctl" type="number" min={1} defaultValue={info?.limits.maxPriceDeviationPct ?? 50} onBlur={(e) => void setLimits({ maxPriceDeviationPct: Number(e.target.value) })} />
          </label>
          <Check checked={settings.confirmOrders} onChange={(confirmOrders) => settings.set({ confirmOrders })}>
            Confirm every order before sending
          </Check>
          <div className="popover-foot">Reduce-only and close-position orders skip the value cap because they can only shrink a position.</div>
        </Popover>
      </Toolbar>

      <div className="scroll ticket-body">
        <div className="ticket-head">
          {symbol ? <b className="mono">{symbol}</b> : <span className="muted">No market selected</span>}
          {info && (
            <span className="muted mono">
              {info.exchange} · bid <span className="up">{info.bid ? fmtPrice(info.bid) : '—'}</span> · ask <span className="down">{info.ask ? fmtPrice(info.ask) : '—'}</span>
            </span>
          )}
        </div>

        <div className="side-toggle">
          <button className={`side buy ${side === 'buy' ? 'on' : ''}`} onClick={() => setSide('buy')}>
            {contract ? 'Long' : 'Buy'}
          </button>
          <button className={`side sell ${side === 'sell' ? 'on' : ''}`} onClick={() => setSide('sell')}>
            {contract ? 'Short' : 'Sell'}
          </button>
        </div>

        <div className="chip-row">
          {(Object.keys(TYPE_LABEL) as OrderType[]).map((t) => (
            <Chip key={t} active={c.type === t} onClick={() => setConfig({ type: t })}>
              {TYPE_LABEL[t]}
            </Chip>
          ))}
        </div>

        {isStop && (
          <div className="form-row compact">
            <span>Trigger</span>
            <input className="ctl mono" inputMode="decimal" value={trigger} placeholder={info ? fmtPrice(info.last) : ''} onChange={(e) => setTrigger(e.target.value)} />
          </div>
        )}
        {isLimit && (
          <div className="form-row compact">
            <span>Price</span>
            <input className="ctl mono" inputMode="decimal" value={price} placeholder="click a DOM level" onChange={(e) => setPrice(e.target.value)} />
          </div>
        )}
        {isLimit && (
          <div className="chip-row pct">
            <button className="chip" disabled={!info?.bid} onClick={() => info?.bid && setPrice(String(info.bid))}>
              Bid
            </button>
            <button className="chip" disabled={!info} onClick={() => info && setPrice(String(info.last))}>
              Last
            </button>
            <button className="chip" disabled={!info?.ask} onClick={() => info?.ask && setPrice(String(info.ask))}>
              Ask
            </button>
          </div>
        )}
        <div className="form-row compact">
          <span>Size</span>
          <div className="input-with-chips">
            <input className="ctl mono" inputMode="decimal" value={size} placeholder="0" onChange={(e) => setSize(e.target.value)} />
            <button className="chip unit" title="Switch size unit" onClick={() => setConfig({ sizeMode: c.sizeMode === 'quote' ? 'base' : 'quote' })}>
              {unit}
            </button>
          </div>
        </div>
        <div className="chip-row pct">
          {[0.1, 0.25, 0.5, 1].map((p) => (
            <button key={p} className="chip" disabled={!info} onClick={() => fillPct(p)}>
              {p * 100}%
            </button>
          ))}
          <span className="muted" style={{ fontSize: 11 }}>
            {info && (side === 'sell' && !contract ? `free ${fmtNum(info.freeBase ?? 0, 6)} ${info.base}` : `free ${fmtNum(info.freeQuote ?? 0, 2)} ${info.settle ?? info.quote}`)}
          </span>
        </div>

        <div className="ticket-opts">
          {isLimit && <Select value={c.tif} options={['GTC', 'IOC', 'FOK'] as TimeInForce[]} onChange={(tif) => setConfig({ tif })} title="Time in force" />}
          {c.type === 'limit' && (
            <Check checked={c.postOnly} onChange={(postOnly) => setConfig({ postOnly })}>
              Post only
            </Check>
          )}
          {contract && (
            <Check checked={c.reduceOnly} onChange={(reduceOnly) => setConfig({ reduceOnly })}>
              Reduce only
            </Check>
          )}
          {contract && info?.canLeverage && (
            <label className="num" title="Leverage (blank keeps the exchange setting)">
              <input className="ctl" style={{ width: 52 }} type="number" min={0} max={200} value={c.leverage || ''} placeholder="lev" onChange={(e) => setConfig({ leverage: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              <span className="suffix">×</span>
            </label>
          )}
        </div>

        <div className="ticket-sum">
          <span>Value</span>
          <b className="mono">{isFinite(value) ? `${fmtNum(value, 2)} ${info?.quote ?? ''}` : '—'}</b>
          <span>Est. fee</span>
          <span className="mono muted">{isFinite(fee) ? fmtNum(fee, 4) : '—'}</span>
          <span>Cap</span>
          <span className="mono muted">{info ? fmtUsd(info.limits.maxOrderUsd) : '—'}</span>
        </div>

        {pending && info ? (
          <div className={`confirm-card ${pending.side}`}>
            <div>
              {!info.sandbox && <span className="env-badge live">LIVE</span>} {describeOrder(pending, info)}
            </div>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className={`btn ${pending.side}`} autoFocus onClick={() => void send(pending)}>
                Confirm {contract ? (pending.side === 'buy' ? 'long' : 'short') : pending.side}
              </button>
            </div>
          </div>
        ) : (
          <button className={`btn submit ${side}`} disabled={Boolean(blocker) || busy} title={blocker} onClick={submit}>
            {busy ? 'Sending…' : `${side === 'buy' ? (contract ? 'Long' : 'Buy') : contract ? 'Short' : 'Sell'} ${info?.base ?? ''} · ${TYPE_LABEL[c.type]}`}
          </button>
        )}
        {blocker && !pending && <div className="muted ticket-hint">{blocker}</div>}
        {result && <div className={`ticket-result ${result.ok ? 'up' : 'down'}`}>{result.text}</div>}

        {log.length > 0 && (
          <>
            <div className="section-title">Order log</div>
            {log.map((r) => (
              <div key={r.id} className="log-row" title={r.message ?? ''}>
                <span className="muted mono">{fmtTime(r.t)}</span>
                <span className={`tag status-${r.status}`}>{r.status}</span>
                <span className="mono">
                  {r.action === 'place' ? `${r.side?.toUpperCase() ?? ''} ${r.amount ?? ''} ${r.symbol ?? ''}` : `${r.action} ${r.symbol ?? ''}`}
                  {r.sandbox ? ' · test' : ''}
                </span>
                {r.message && <span className="muted log-msg">{r.message}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
