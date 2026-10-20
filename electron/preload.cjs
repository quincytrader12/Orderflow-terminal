// Exposes a narrow, typed bridge to the renderer as window.novus.
// Every call returns the value or throws the main-process error message.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const ccxtListeners = new Set();
const amtListeners = { status: new Set(), event: new Set() };
for (const ch of ['status', 'event']) ipcRenderer.on(`amt:${ch}`, (_e, msg) => amtListeners[ch].forEach((fn) => fn(msg)));
const listen = (set, fn) => {
  set.add(fn);
  return () => set.delete(fn);
};
ipcRenderer.on('ccxt:event', (_e, msg) => {
  for (const fn of ccxtListeners) fn(msg);
});

contextBridge.exposeInMainWorld('novus', {
  desktop: true,
  app: { info: () => call('app:info'), openExternal: (url) => call('shell:open', url), locked: () => call('app:locked'), unlock: (code) => call('app:unlock', code), seal: () => call('app:seal'), changeKey: (current, next) => call('app:changeKey', current, next) },
  net: { fetchJson: (url, init) => call('net:fetchJson', url, init) },
  vault: {
    list: () => call('vault:list'),
    save: (rec) => call('vault:save', rec),
    remove: (id) => call('vault:remove', id),
    copy: (id, field) => call('vault:copy', id, field),
    test: (id) => call('vault:test', id),
  },
  ccxt: {
    exchanges: () => call('ccxt:exchanges'),
    markets: (id) => call('ccxt:markets', id),
    ohlcv: (id, symbol, tf, limit) => call('ccxt:ohlcv', id, symbol, tf, limit),
    tickers: (id) => call('ccxt:tickers', id),
    ticker: (id, symbol) => call('ccxt:ticker', id, symbol),
    account: (secretId, symbol) => call('ccxt:account', secretId, symbol),
    subscribe: (sid, id, symbol) => call('ccxt:subscribe', sid, id, symbol),
    unsubscribe: (sid) => call('ccxt:unsubscribe', sid),
    onEvent: (fn) => {
      ccxtListeners.add(fn);
      return () => ccxtListeners.delete(fn);
    },
  },
  trade: {
    marketInfo: (secretId, symbol) => call('trade:marketInfo', secretId, symbol),
    place: (secretId, req) => call('trade:place', secretId, req),
    cancel: (secretId, orderId, symbol) => call('trade:cancel', secretId, orderId, symbol),
    cancelAll: (secretId, symbol) => call('trade:cancelAll', secretId, symbol),
    close: (secretId, symbol, side) => call('trade:close', secretId, symbol, side),
    limits: () => call('trade:limits'),
    setLimits: (l) => call('trade:setLimits', l),
    log: (limit) => call('trade:log', limit),
  },
  report: { data: (kind, venue, symbol) => call('report:data', kind, venue, symbol) },
  amt: {
    list: () => call('amt:list'),
    defaults: () => call('amt:defaults'),
    presets: () => call('amt:presets'),
    save: (cfg) => call('amt:save', cfg),
    remove: (id) => call('amt:remove', id),
    start: (id) => call('amt:start', id),
    stop: (id, flatten) => call('amt:stop', id, flatten),
    stopAll: () => call('amt:stopAll'),
    snapshot: (id) => call('amt:snapshot', id),
    events: (id) => call('amt:events', id),
    backtest: (params, venue, symbol, from) => call('amt:backtest', params, venue, symbol, from),
    onStatus: (fn) => listen(amtListeners.status, fn),
    onEvent: (fn) => listen(amtListeners.event, fn),
  },
  db: {
    info: () => call('db:info'),
    record: (venue, symbol, rows) => call('db:record', venue, symbol, rows),
    query: (venue, symbol, from, to) => call('db:query', venue, symbol, from, to),
    stats: () => call('db:stats'),
    prune: (days) => call('db:prune', days),
    deleteInstrument: (venue, symbol) => call('db:deleteInstrument', venue, symbol),
    vacuum: () => call('db:vacuum'),
    setRetention: (days) => call('db:setRetention', days),
    exportCsv: (venue, symbol) => call('db:exportCsv', venue, symbol),
  },
  wallet: {
    connectPhantom: () => call('wallet:connectPhantom'),
    watch: (address) => call('wallet:watch', address),
    list: () => call('wallet:list'),
    remove: (address) => call('wallet:remove', address),
    balances: (address, rpcSecretId) => call('wallet:balances', address, rpcSecretId),
    tokenInfo: (mints) => call('wallet:tokenInfo', mints),
    activity: (address, rpcSecretId) => call('wallet:activity', address, rpcSecretId),
  },
  telegram: {
    me: (id) => call('telegram:me', id),
    detect: (id) => call('telegram:detect', id),
    send: (id, html) => call('telegram:send', id, html),
    sendPhoto: (id, png, caption) => call('telegram:sendPhoto', id, png, caption),
    commands: (id) => call('telegram:commands', id),
    setStatus: (snap) => call('telegram:setStatus', snap),
  },
});
