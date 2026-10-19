import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { hub } from '../market/hub';
import { VENUE_COLORS } from './theme';

export interface PanelProps<C> {
  config: C;
  setConfig: (patch: Partial<C>) => void;
  nodeId: string;
}

/** Re-render the component every `ms` while mounted. */
export function useTicker(ms = 500) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(force, ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Re-render whenever the hub topology changes (primary/aggregate/status). */
export function useHubVersion() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => hub().onChange(force), []);
  return hub().version;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  title,
  width,
}: {
  value: T;
  options: (T | { value: T; label: string })[];
  onChange: (v: T) => void;
  title?: string;
  width?: number;
}) {
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  return (
    <select
      className="ctl"
      title={title}
      style={width ? { width } : undefined}
      value={String(value)}
      onChange={(e) => {
        const o = opts.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {opts.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Chip({ active, onClick, children, title, color }: { active?: boolean; onClick?: () => void; children: ReactNode; title?: string; color?: string }) {
  return (
    <button className={`chip ${active ? 'active' : ''}`} onClick={onClick} title={title} style={color && active ? { borderColor: color, color } : undefined}>
      {children}
    </button>
  );
}

export function NumberInput({ value, onChange, step, min, width = 72, title, suffix }: { value: number; onChange: (v: number) => void; step?: number; min?: number; width?: number; title?: string; suffix?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="num" title={title}>
      <input
        className="ctl"
        style={{ width }}
        type="number"
        value={text}
        step={step}
        min={min}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = parseFloat(text);
          if (isFinite(v)) onChange(v);
          else setText(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </label>
  );
}

/** Σ chip: per-panel venue visibility mask for aggregated panels. */
export function VenueMask({ hidden, onChange }: { hidden: VenueId[]; onChange: (h: VenueId[]) => void }) {
  useHubVersion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const feeds = hub().aggregate;
  const visible = feeds.filter((f) => !hidden.includes(f.inst.venue)).length;
  return (
    <div className="venue-mask" ref={ref}>
      <button className="chip sigma" title="Venues drawn in this panel (hidden venues keep streaming)" onClick={() => setOpen(!open)}>
        Σ {visible}/{feeds.length}
      </button>
      {open && (
        <div className="popover">
          {feeds.map((f) => {
            const v = f.inst.venue;
            const on = !hidden.includes(v);
            return (
              <label key={v} className="check">
                <input type="checkbox" checked={on} onChange={() => onChange(on ? [...hidden, v] : hidden.filter((x) => x !== v))} />
                <span className="dot" style={{ background: VENUE_COLORS[v] }} />
                {ADAPTERS[v].name}
              </label>
            );
          })}
          <div className="popover-foot">Hidden venues keep streaming; they just stop being drawn here.</div>
        </div>
      )}
    </div>
  );
}

/** Button that opens a small settings popover. */
export function Popover({ label, title, children, align = 'left' }: { label: ReactNode; title?: string; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="venue-mask" ref={ref}>
      <button className={`chip ${open ? 'active' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className={`popover ${align === 'right' ? 'right' : ''}`}>{children}</div>}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function VenueTag({ venue }: { venue: VenueId }) {
  return (
    <span className="venue-tag" style={{ color: VENUE_COLORS[venue] }}>
      {ADAPTERS[venue].short}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spacer() {
  return <div style={{ flex: 1 }} />;
}
