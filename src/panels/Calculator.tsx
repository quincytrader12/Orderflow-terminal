import type { ReactNode } from 'react';
import { fmtNum, fmtPrice, fmtUsd } from '../core/format';
import { hub } from '../market/hub';
import { Chip, NumberInput, Spacer, Toolbar, useTicker, type PanelProps } from '../ui/controls';

export interface CalcConfig {
  tab: 'position' | 'liquidation' | 'mcap';
  account: number;
  riskPct: number;
  entry: number;
  stop: number;
  target: number;
  feeBps: number;
  leverage: number;
  side: 'long' | 'short';
  mmrPct: number;
  supply: number;
  mcapTarget: number;
}

export const CALC_DEFAULTS: CalcConfig = {
  tab: 'position',
  account: 10_000,
  riskPct: 1,
  entry: 0,
  stop: 0,
  target: 0,
  feeBps: 5,
  leverage: 10,
  side: 'long',
  mmrPct: 0.5,
  supply: 19_800_000,
  mcapTarget: 3e12,
};

export interface PositionResult {
  qty: number;
  notional: number;
  riskUsd: number;
  feesUsd: number;
  rr: number;
  rewardUsd: number;
  minLeverage: number;
}

/** Size a position so that hitting the stop loses riskPct of the account (fees included). */
export function positionSize(account: number, riskPct: number, entry: number, stop: number, target: number, feeBps: number): PositionResult | null {
  const dist = Math.abs(entry - stop);
  if (!(entry > 0) || !(dist > 0) || !(account > 0)) return null;
  const riskUsd = (account * riskPct) / 100;
  const feePerUnit = ((entry + stop) * feeBps) / 1e4; // round trip
  const qty = riskUsd / (dist + feePerUnit);
  const notional = qty * entry;
  const reward = target > 0 ? Math.abs(target - entry) * qty - ((entry + target) * feeBps * qty) / 1e4 : NaN;
  return { qty, notional, riskUsd, feesUsd: feePerUnit * qty, rr: reward / riskUsd, rewardUsd: reward, minLeverage: notional / account };
}

/** Isolated-margin liquidation estimate (ignores funding and fees). */
export function liquidationPrice(entry: number, leverage: number, side: 'long' | 'short', mmrPct: number) {
  const mmr = mmrPct / 100;
  return side === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="form-row" style={{ gridTemplateColumns: '130px 1fr', marginBottom: 6 }}>
      <span className="muted">{k}</span>
      <div>{children}</div>
    </div>
  );
}

export function Calculator({ config: c, setConfig }: PanelProps<CalcConfig>) {
  useTicker(2000);
  const last = hub().primary.lastPrice();
  const entry = c.entry || (isFinite(last) ? last : 0);
  const pos = positionSize(c.account, c.riskPct, entry, c.stop, c.target, c.feeBps);
  const liq = entry ? liquidationPrice(entry, c.leverage, c.side, c.mmrPct) : NaN;
  const base = hub().primary.inst.base;
  return (
    <div className="panel">
      <Toolbar>
        <Chip active={c.tab === 'position'} onClick={() => setConfig({ tab: 'position' })}>
          Position size
        </Chip>
        <Chip active={c.tab === 'liquidation'} onClick={() => setConfig({ tab: 'liquidation' })}>
          Liquidation
        </Chip>
        <Chip active={c.tab === 'mcap'} onClick={() => setConfig({ tab: 'mcap' })}>
          Market cap
        </Chip>
        <Spacer />
        <button className="chip" onClick={() => setConfig({ entry: isFinite(last) ? last : 0 })} title="Use last price as entry">
          ↧ last {fmtPrice(last)}
        </button>
      </Toolbar>
      <div className="scroll" style={{ padding: 10 }}>
        {c.tab === 'position' && (
          <>
            <Row k="Account ($)">
              <NumberInput value={c.account} onChange={(account) => setConfig({ account })} width={120} />
            </Row>
            <Row k="Risk (%)">
              <NumberInput value={c.riskPct} step={0.25} onChange={(riskPct) => setConfig({ riskPct })} width={120} />
            </Row>
            <Row k="Entry">
              <NumberInput value={entry} onChange={(e) => setConfig({ entry: e })} width={120} />
            </Row>
            <Row k="Stop">
              <NumberInput value={c.stop} onChange={(stop) => setConfig({ stop })} width={120} />
            </Row>
            <Row k="Target (optional)">
              <NumberInput value={c.target} onChange={(target) => setConfig({ target })} width={120} />
            </Row>
            <Row k="Fee per side (bps)">
              <NumberInput value={c.feeBps} step={0.5} onChange={(feeBps) => setConfig({ feeBps })} width={120} />
            </Row>
            {pos ? (
              <div className="stat-grid" style={{ marginTop: 10 }}>
                <div className="stat">
                  <div className="k">Quantity</div>
                  <div className="v">
                    {fmtNum(pos.qty, 4)} {base}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">Notional</div>
                  <div className="v">{fmtUsd(pos.notional)}</div>
                  <div className="s">min leverage {pos.minLeverage.toFixed(2)}×</div>
                </div>
                <div className="stat">
                  <div className="k">Risk at stop</div>
                  <div className="v down">{fmtUsd(pos.riskUsd)}</div>
                  <div className="s">incl. fees {fmtUsd(pos.feesUsd)}</div>
                </div>
                <div className="stat">
                  <div className="k">Reward : risk</div>
                  <div className={`v ${pos.rr >= 1 ? 'up' : 'down'}`}>{isFinite(pos.rr) ? pos.rr.toFixed(2) + 'R' : '—'}</div>
                  <div className="s">{isFinite(pos.rewardUsd) ? fmtUsd(pos.rewardUsd) + ' at target' : 'set a target'}</div>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 10 }}>
                Enter an entry and a stop different from it.
              </div>
            )}
          </>
        )}
        {c.tab === 'liquidation' && (
          <>
            <Row k="Side">
              <Chip active={c.side === 'long'} onClick={() => setConfig({ side: 'long' })}>
                Long
              </Chip>{' '}
              <Chip active={c.side === 'short'} onClick={() => setConfig({ side: 'short' })}>
                Short
              </Chip>
            </Row>
            <Row k="Entry">
              <NumberInput value={entry} onChange={(e) => setConfig({ entry: e })} width={120} />
            </Row>
            <Row k="Leverage (×)">
              <NumberInput value={c.leverage} onChange={(leverage) => setConfig({ leverage: Math.max(1, leverage) })} width={120} />
            </Row>
            <Row k="Maint. margin (%)">
              <NumberInput value={c.mmrPct} step={0.1} onChange={(mmrPct) => setConfig({ mmrPct })} width={120} />
            </Row>
            <div className="stat-grid" style={{ marginTop: 10 }}>
              <div className="stat">
                <div className="k">Est. liquidation</div>
                <div className="v down">{fmtPrice(liq)}</div>
                <div className="s">{entry ? (((liq - entry) / entry) * 100).toFixed(2) + '% from entry' : ''}</div>
              </div>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              Isolated-margin estimate. Real venues use tiered maintenance margin, fees and mark price.
            </div>
          </>
        )}
        {c.tab === 'mcap' && (
          <>
            <Row k="Circulating supply">
              <NumberInput value={c.supply} onChange={(supply) => setConfig({ supply })} width={140} />
            </Row>
            <Row k="Target market cap ($)">
              <NumberInput value={c.mcapTarget} onChange={(mcapTarget) => setConfig({ mcapTarget })} width={140} />
            </Row>
            <div className="stat-grid" style={{ marginTop: 10 }}>
              <div className="stat">
                <div className="k">Market cap now</div>
                <div className="v">{fmtUsd(last * c.supply)}</div>
                <div className="s">at {fmtPrice(last)}</div>
              </div>
              <div className="stat">
                <div className="k">Price at target cap</div>
                <div className="v">{fmtPrice(c.mcapTarget / (c.supply || 1))}</div>
                <div className="s">{isFinite(last) ? ((c.mcapTarget / (c.supply || 1) / last - 1) * 100).toFixed(1) + '% from now' : ''}</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
