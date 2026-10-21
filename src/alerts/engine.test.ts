import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSettings, type AlertRule } from '../store/settings';
import { Feed, hub } from '../market/hub';
import { AlertEngine } from './engine';

const rule = (p: Partial<AlertRule>): AlertRule => ({ id: p.type!, type: p.type!, enabled: true, scope: 'primary', value: 0, windowSec: 60, cooldownSec: 0, sound: false, notify: false, ...p });

describe('AlertEngine', () => {
  let engine: AlertEngine;
  beforeAll(() => {
    useSettings.setState({ base: 'BTC', primaryVenue: 'sim', aggregateVenues: ['sim'], historySource: 'none', alerts: [], fired: [] });
    engine = new AlertEngine();
  });
  afterAll(() => {
    engine.dispose();
    hub().dispose();
  });

  const fired = () => useSettings.getState().fired.map((f) => f.type);

  it('fires price crosses once per crossing', () => {
    const f = hub().primary;
    useSettings.setState({ alerts: [rule({ type: 'price_above', value: 105 })], fired: [] });
    f.store.push(100, 1, 'buy', Date.now());
    (engine as any).evaluate();
    f.store.push(106, 1, 'buy', Date.now());
    (engine as any).evaluate();
    (engine as any).evaluate();
    expect(fired()).toEqual(['price_above']);
  });

  it('fires large trade and liquidation alerts from hub events', () => {
    const f = hub().primary;
    useSettings.setState({ alerts: [rule({ type: 'large_trade', value: 1000 }), rule({ type: 'liquidation', value: 1000 })], fired: [] });
    hub().emitTrade({ venue: 'sim', price: 100, qty: 5, side: 'buy', time: Date.now() }, f);
    hub().emitTrade({ venue: 'sim', price: 100, qty: 50, side: 'buy', time: Date.now() }, f);
    hub().emitLiq({ venue: 'sim', symbol: 'BTC-SIM', position: 'long', price: 100, qty: 20, time: Date.now() }, f);
    expect(fired().sort()).toEqual(['large_trade', 'liquidation']);
  });

  it('respects cooldowns', () => {
    const f = hub().primary;
    useSettings.setState({ alerts: [rule({ type: 'large_trade', value: 1, cooldownSec: 60, id: 'cd' })], fired: [] });
    for (let i = 0; i < 3; i++) hub().emitTrade({ venue: 'sim', price: 100, qty: 1, side: 'sell', time: Date.now() }, f);
    expect(fired()).toEqual(['large_trade']);
  });

  it('detects walls appearing and being pulled', () => {
    const f = hub().primary;
    useSettings.setState({ alerts: [rule({ type: 'wall_appear', value: 50_000 }), rule({ type: 'wall_pulled', value: 50_000 })], fired: [] });
    f.book.apply({ snapshot: true, bids: [[99, 1]], asks: [[101, 1]], time: 1 });
    (engine as any).evaluate();
    f.book.apply({ snapshot: false, bids: [[99.5, 1000]], asks: [], time: 2 });
    (engine as any).evaluate();
    f.book.apply({ snapshot: false, bids: [[99.5, 0]], asks: [], time: 3 });
    f.store.push(100, 1, 'buy', Date.now());
    (engine as any).evaluate();
    expect(fired().sort()).toEqual(['wall_appear', 'wall_pulled']);
  });

  it('detects a delta spike', () => {
    const f = hub().primary;
    useSettings.setState({ alerts: [rule({ type: 'delta_spike', value: 10_000, windowSec: 60 })], fired: [] });
    f.store.push(100, 500, 'buy', Date.now());
    (engine as any).lastSlow = 0;
    (engine as any).evaluate();
    expect(fired()).toEqual(['delta_spike']);
  });

  /** A second venue of the same coin inside the hub's venue set (not started: no sockets). */
  const otherVenue = () => {
    const f = new Feed({ venue: 'binancef', symbol: 'BTCUSDT', base: 'BTC' }, hub());
    hub().aggregate.push(f);
    return f;
  };
  const dropOther = (f: Feed) => (hub().aggregate = hub().aggregate.filter((x) => x !== f));

  it('alerts follow the market on the chart: other venues of the coin stay quiet unless asked for', () => {
    const other = otherVenue();
    const big = { venue: 'binancef' as const, price: 100, qty: 50_000, side: 'sell' as const, time: Date.now() };
    const liq = { venue: 'binancef' as const, symbol: 'BTCUSDT', position: 'long' as const, price: 100, qty: 50_000, time: Date.now() };
    useSettings.setState({ alerts: [rule({ type: 'large_trade', value: 1000, id: 'p1' }), rule({ type: 'liquidation', value: 1000, id: 'p2' })], fired: [] });
    hub().emitTrade(big, other);
    hub().emitLiq(liq, other);
    expect(fired()).toEqual([]);
    // widened on purpose: they fire, and say which venue and symbol
    useSettings.setState({ alerts: [rule({ type: 'large_trade', value: 1000, id: 'a1', scope: 'aggregate' })], fired: [] });
    hub().emitTrade(big, other);
    expect(useSettings.getState().fired[0].message).toMatch(/^BNF BTCUSDT SELL/);
    dropOther(other);
  });

  it('liquidation cascades count only the chart’s market by default', () => {
    const other = otherVenue();
    useSettings.setState({ alerts: [rule({ type: 'liq_cascade', value: 1_000_000, windowSec: 60, id: 'c1' })], fired: [] });
    hub().emitLiq({ venue: 'binancef', symbol: 'BTCUSDT', position: 'short', price: 100, qty: 20_000, time: Date.now() }, other);
    (engine as any).evaluate();
    expect(fired()).toEqual([]);
    hub().emitLiq({ venue: 'sim', symbol: 'BTC-SIM', position: 'short', price: 100, qty: 20_000, time: Date.now() }, hub().primary);
    (engine as any).evaluate();
    expect(fired()).toEqual(['liq_cascade']);
    dropOther(other);
  });

  it('moves saved rules to the chart’s market once', () => {
    const migrate = useSettings.persist.getOptions().migrate!;
    const out = migrate({ alerts: [rule({ type: 'large_trade', scope: 'aggregate' }), rule({ type: 'liquidation', scope: 'aggregate' })] }, 2) as { alerts: AlertRule[] };
    expect(out.alerts.map((r) => r.scope)).toEqual(['primary', 'primary']);
  });
});

