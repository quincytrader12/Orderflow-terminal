// Order building and pre-trade checks. Pure functions: the CCXT service
// supplies the market, reference price and precision helpers, so every rule
// here is unit-tested without touching an exchange.

export const ORDER_TYPES = ['market', 'limit', 'stop-market', 'stop-limit'];
export const TIFS = ['GTC', 'IOC', 'FOK'];

/** Quote currencies treated as 1:1 with USD for the notional cap. */
export const USD_QUOTES = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'USDE', 'PYUSD', 'USDS', 'USDP', 'ZUSD']);

export const DEFAULT_LIMITS = { maxOrderUsd: 1000, maxOrdersPerMinute: 10, maxPriceDeviationPct: 50 };

export function sanitizeLimits(l) {
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    maxOrderUsd: n(l?.maxOrderUsd, DEFAULT_LIMITS.maxOrderUsd, 1, 10_000_000),
    maxOrdersPerMinute: Math.round(n(l?.maxOrdersPerMinute, DEFAULT_LIMITS.maxOrdersPerMinute, 1, 120)),
    maxPriceDeviationPct: n(l?.maxPriceDeviationPct, DEFAULT_LIMITS.maxPriceDeviationPct, 1, 100),
  };
}

const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Turn a ticket request into CCXT createOrder arguments.
 *
 * req: { symbol, side, type, sizeMode: 'base'|'quote'|'contracts', size, price?,
 *        triggerPrice?, reduceOnly?, postOnly?, tif? }
 *        ('contracts' = exchange units as returned by a fill; exits use it so
 *         they close exactly what was opened)
 * ctx: { refPrice, quoteUsd (USD per 1 quote unit), limits, capExempt?,
 *        amountToPrecision?(n) → n, priceToPrecision?(n) → n }
 *
 * Returns { symbol, type, side, amount, price, params, notionalUsd, baseQty }.
 * Throws with a readable message when a rule is broken.
 */
export function buildOrder(req, market, ctx) {
  if (!market) throw new Error(`${req?.symbol ?? 'symbol'} is not listed on this exchange`);
  const { side, type } = req;
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
  if (!ORDER_TYPES.includes(type)) throw new Error(`unsupported order type ${type}`);
  if (!pos(req.size)) throw new Error('enter a size greater than zero');
  if (!pos(ctx.refPrice)) throw new Error('no reference price for this market yet');
  const limits = sanitizeLimits(ctx.limits);
  const roundAmt = ctx.amountToPrecision ?? ((x) => x);
  const roundPx = ctx.priceToPrecision ?? ((x) => x);

  const isLimit = type === 'limit' || type === 'stop-limit';
  const isStop = type === 'stop-market' || type === 'stop-limit';
  let price;
  let triggerPrice;
  if (isLimit) {
    if (!pos(req.price)) throw new Error('limit orders need a price');
    price = roundPx(req.price);
  }
  if (isStop) {
    if (!pos(req.triggerPrice)) throw new Error('stop orders need a trigger price');
    triggerPrice = roundPx(req.triggerPrice);
    // a stop that would trigger immediately is almost always a mistake
    if (side === 'buy' && triggerPrice <= ctx.refPrice) throw new Error('buy stop trigger must be above the current price');
    if (side === 'sell' && triggerPrice >= ctx.refPrice) throw new Error('sell stop trigger must be below the current price');
  }
  for (const [label, p] of [
    ['price', price],
    ['trigger', triggerPrice],
  ]) {
    if (p === undefined) continue;
    const dev = (Math.abs(p - ctx.refPrice) / ctx.refPrice) * 100;
    if (dev > limits.maxPriceDeviationPct) throw new Error(`${label} ${p} is ${dev.toFixed(1)}% away from the market (limit ${limits.maxPriceDeviationPct}%)`);
  }
  if (req.postOnly && type !== 'limit') throw new Error('post-only applies to limit orders');
  if (req.reduceOnly && !market.contract) throw new Error('reduce-only applies to derivatives; this is a spot market');
  if (req.tif && !TIFS.includes(req.tif)) throw new Error(`unsupported time in force ${req.tif}`);
  if (req.postOnly && req.tif && req.tif !== 'GTC') throw new Error('post-only orders must be GTC');

  // execution price used for sizing and the notional check
  const execPx = price ?? triggerPrice ?? ctx.refPrice;
  const quoteUsd = USD_QUOTES.has(market.quote) ? 1 : ctx.quoteUsd;
  const contractSize = market.contract ? market.contractSize || 1 : 1;
  const inverse = Boolean(market.contract && market.inverse);

  // size in base units (or USD for inverse contracts) → exchange amount
  let amount;
  if (req.sizeMode === 'contracts') {
    amount = req.size;
  } else if (inverse) {
    // inverse contracts are denominated in USD per contract
    const usd = req.sizeMode === 'quote' ? req.size : req.size * execPx;
    amount = usd / contractSize;
  } else {
    const base = req.sizeMode === 'quote' ? req.size / execPx : req.size;
    amount = base / contractSize;
  }
  amount = Number(roundAmt(amount));
  if (!pos(amount)) throw new Error('size rounds to zero at this market’s precision');

  const baseQty = inverse ? (amount * contractSize) / execPx : amount * contractSize;
  const notionalQuote = inverse ? amount * contractSize : baseQty * execPx;
  const notionalUsd = inverse ? notionalQuote : pos(quoteUsd) ? notionalQuote * quoteUsd : NaN;

  const minAmt = market.limits?.amount?.min;
  if (pos(minAmt) && amount < minAmt) throw new Error(`minimum size is ${minAmt} ${market.contract ? 'contracts' : market.base}`);
  const maxAmt = market.limits?.amount?.max;
  if (pos(maxAmt) && amount > maxAmt) throw new Error(`maximum size is ${maxAmt} ${market.contract ? 'contracts' : market.base}`);
  const minCost = market.limits?.cost?.min;
  if (!inverse && pos(minCost) && notionalQuote < minCost) throw new Error(`minimum order value is ${minCost} ${market.quote}`);

  // reduce-only orders (and verified spot closes) only shrink exposure, so the cap does not apply
  if (!req.reduceOnly && !ctx.capExempt) {
    if (!Number.isFinite(notionalUsd)) throw new Error(`cannot value ${market.quote} in USD to check your order cap`);
    if (notionalUsd > limits.maxOrderUsd) throw new Error(`order value $${notionalUsd.toFixed(2)} is above your cap of $${limits.maxOrderUsd} (change it in the ticket's ⚙ limits)`);
  }

  const params = {};
  if (triggerPrice !== undefined) params.triggerPrice = triggerPrice;
  if (req.reduceOnly) params.reduceOnly = true;
  if (req.postOnly) params.postOnly = true;
  if (isLimit && req.tif && !req.postOnly) params.timeInForce = req.tif;

  return { symbol: market.symbol, type: isLimit ? 'limit' : 'market', side, amount, price, params, notionalUsd, baseQty };
}

/** Sliding one-minute window of order timestamps. */
export class RateGate {
  constructor() {
    this.times = [];
  }
  take(max, now = Date.now()) {
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length >= max) throw new Error(`order rate limit: ${max} per minute (change it in the ticket's ⚙ limits)`);
    this.times.push(now);
  }
}

/** Opposite-side, reduce-only market order that flattens a position. */
export function closeOrderFor(position) {
  const contracts = Math.abs(position?.contracts ?? 0);
  if (!pos(contracts)) throw new Error('no open position to close');
  const side = position.side === 'short' ? 'buy' : 'sell';
  return { symbol: position.symbol, type: 'market', side, amount: contracts, price: undefined, params: { reduceOnly: true } };
}
