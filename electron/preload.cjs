// Exposes a narrow, typed bridge to the renderer as window.novus.
// Every call returns the value or throws the main-process error message.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const ccxtListeners = new Set();
ipcRenderer.on('ccxt:event', (_e, msg) => {
  for (const fn of ccxtListeners) fn(msg);
});

contextBridge.exposeInMainWorld('novus', {
  desktop: true,
  app: { info: () => call('app:info'), openExternal: (url) => call('shell:open', url) },
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
    commands: (id) => call('telegram:commands', id),
    setStatus: (snap) => call('telegram:setStatus', snap),
  },
});
