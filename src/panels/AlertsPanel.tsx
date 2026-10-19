import { useState } from 'react';
import { ALERT_TYPES, newRule } from '../alerts/engine';
import { fmtTime } from '../core/format';
import { useSettings, type AlertRule, type AlertType } from '../store/settings';
import { Chip, Empty, NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export interface AlertsConfig {
  tab: 'rules' | 'log';
}

export const ALERTS_DEFAULTS: AlertsConfig = { tab: 'rules' };

function RuleRow({ r }: { r: AlertRule }) {
  const upsert = useSettings((s) => s.upsertAlert);
  const remove = useSettings((s) => s.removeAlert);
  const meta = ALERT_TYPES.find((a) => a.type === r.type)!;
  const set = (p: Partial<AlertRule>) => upsert({ ...r, ...p });
  return (
    <div className="list-row" style={{ flexDirection: 'column', gap: 5, opacity: r.enabled ? 1 : 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} title="Enabled" />
        <b>{meta.label}</b>
        <span className="muted" title={meta.help}>
          ⓘ
        </span>
        <Spacer />
        <button className="chip" onClick={() => remove(r.id)} title="Delete">
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingLeft: 20 }}>
        <span className="muted">{meta.valueLabel}</span>
        <NumberInput value={r.value} onChange={(value) => set({ value })} width={96} />
        {meta.defaultWindow > 0 && (
          <>
            <span className="muted">window</span>
            <NumberInput value={r.windowSec} onChange={(windowSec) => set({ windowSec: Math.max(5, windowSec) })} width={56} suffix="s" />
          </>
        )}
        <Select
          value={r.scope}
          options={[
            { value: 'primary', label: 'Primary' },
            { value: 'aggregate', label: 'All venues' },
          ]}
          onChange={(scope) => set({ scope })}
        />
        <span className="muted">cooldown</span>
        <NumberInput value={r.cooldownSec} onChange={(cooldownSec) => set({ cooldownSec: Math.max(0, cooldownSec) })} width={52} suffix="s" />
        <Chip active={r.sound} onClick={() => set({ sound: !r.sound })} title="Sound">
          ♪
        </Chip>
        <Chip
          active={r.notify}
          onClick={() => {
            if (!r.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
            set({ notify: !r.notify });
          }}
          title="Browser notification"
        >
          🔔
        </Chip>
        <input className="ctl" placeholder="note" value={r.note ?? ''} onChange={(e) => set({ note: e.target.value })} style={{ width: 90 }} />
      </div>
    </div>
  );
}

export function AlertsPanel({ config: c, setConfig }: PanelProps<AlertsConfig>) {
  const alerts = useSettings((s) => s.alerts);
  const fired = useSettings((s) => s.fired);
  const upsert = useSettings((s) => s.upsertAlert);
  const clearFired = useSettings((s) => s.clearFired);
  const [type, setType] = useState<AlertType>('price_above');
  return (
    <div className="panel">
      <Toolbar>
        <Chip active={c.tab === 'rules'} onClick={() => setConfig({ tab: 'rules' })}>
          Rules ({alerts.length})
        </Chip>
        <Chip active={c.tab === 'log'} onClick={() => setConfig({ tab: 'log' })}>
          Fired ({fired.length})
        </Chip>
        <Spacer />
        {c.tab === 'rules' ? (
          <>
            <Select value={type} options={ALERT_TYPES.map((a) => ({ value: a.type, label: a.label }))} onChange={setType} width={150} />
            <button className="chip" onClick={() => upsert(newRule(type))}>
              + Add
            </button>
          </>
        ) : (
          <button className="chip" onClick={clearFired}>
            Clear
          </button>
        )}
      </Toolbar>
      <div className="scroll">
        {c.tab === 'rules' ? (
          alerts.length ? (
            alerts.map((r) => <RuleRow key={r.id} r={r} />)
          ) : (
            <Empty>No alert rules. Alerts are evaluated in this browser tab against the live feed — they fire while the tab is open.</Empty>
          )
        ) : fired.length ? (
          fired.map((f) => (
            <div className="list-row" key={f.id}>
              <span className="muted mono" style={{ width: 60, flexShrink: 0 }}>
                {fmtTime(f.time)}
              </span>
              <div>
                <b>{ALERT_TYPES.find((a) => a.type === f.type)?.label}</b>
                <div className="mono muted">{f.message}</div>
              </div>
            </div>
          ))
        ) : (
          <Empty>Nothing fired yet.</Empty>
        )}
      </div>
    </div>
  );
}
