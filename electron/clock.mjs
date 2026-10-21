// Signed exchange requests carry a timestamp that must be within a few
// seconds of the exchange's own clock (Binance: -1021 "Timestamp for this
// request is outside of the recvWindow"). A Windows PC clock that has drifted
// breaks every private call, so authenticated clients sign with the
// exchange's time instead of the PC's.

/** Errors that mean "your clock is off", across the exchanges CCXT maps. */
export function isClockError(e) {
  const m = String(e?.message ?? e);
  // match the exchanges' error texts, not request URLs (which carry
  // "timestamp=" and "recvWindow=" in every signed query)
  const text = m.replace(/https?:\/\/\S+/g, '');
  return /-1021|outside of the recvWindow|timestamp.{0,40}(ahead|behind|outside|expired)|invalid.{0,10}(timestamp|nonce)|"retCode":10002|"code":"50102"/i.test(text) || e?.constructor?.name === 'InvalidNonce';
}

/**
 * Measure the exchange's clock now: CCXT then signs with server time
 * (`options.timeDifference`) on every request.
 */
export async function syncClock(ex) {
  if (typeof ex.loadTimeDifference !== 'function' || !ex.has?.fetchTime) return undefined;
  try {
    await ex.loadTimeDifference();
    return ex.options?.timeDifference;
  } catch {
    return undefined;
  }
}

/**
 * Make an authenticated CCXT client tolerant of a wrong PC clock: measure the
 * offset when markets load, allow Binance's usual 10 s window, and if a
 * request is still rejected for its timestamp, re-measure and retry it once.
 * Such a request was refused before it reached the matching engine, so the
 * retry cannot duplicate an order.
 */
export function clockSafe(ex, onSync = () => undefined) {
  ex.options = { ...ex.options, adjustForTimeDifference: true, recvWindow: Math.max(ex.options?.recvWindow ?? 0, 10_000) };
  // Coinbase signs its JWT (nbf/exp) and legacy timestamps with seconds(),
  // which CCXT does not correct: give that client the exchange's seconds
  if (String(ex.id).startsWith('coinbase')) ex.seconds = () => Math.floor((Date.now() - (Number(ex.options?.timeDifference) || 0)) / 1000);
  if (typeof ex.request !== 'function') return ex;
  const request = ex.request.bind(ex);
  ex.request = async (...args) => {
    try {
      return await request(...args);
    } catch (e) {
      if (!isClockError(e)) throw e;
      const diff = await syncClock(ex);
      if (diff === undefined) throw e;
      onSync(diff);
      return request(...args);
    }
  };
  return ex;
}
