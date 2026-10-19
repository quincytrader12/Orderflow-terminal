import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import emblem from '../assets/emblem.png';
import { desktop } from '../desktop/bridge';
import { AttemptGate, LEDGER_LENGTH, ledgerMatches, normalizeKey } from '../shared/ledger';
import { runBoot, useBoot } from './boot';

const SESSION_FLAG = 'novus-ledger-open';

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// browser builds check the key here; the desktop app checks it in its own process
const webGate = new AttemptGate();

async function unlock(code: string): Promise<void> {
  if (desktop) {
    await desktop.app.unlock(code);
  } else {
    webGate.check();
    if (!(await ledgerMatches(code, sha256Hex))) {
      webGate.fail();
      throw new Error(webGate.waitMs() ? `ACCESS DENIED — locked for ${Math.ceil(webGate.waitMs() / 1000)}s` : 'ACCESS DENIED');
    }
    webGate.success();
  }
  try {
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    /* private mode */
  }
}

/** Already unlocked in this window (e.g. after View → Reload)? */
export async function alreadyUnlocked(): Promise<boolean> {
  if (desktop) return !(await desktop.app.locked().catch(() => true));
  try {
    return sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

function sessionId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().replace(/(.{4})/, '$1-');
}

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { steps, done } = useBoot();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'denied' | 'granted' | 'busy'; text: string } | null>(null);
  const [shake, setShake] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sid = useMemo(sessionId, []);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    runBoot();
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const submit = async (value = code) => {
    const digits = normalizeKey(value);
    if (digits.length !== LEDGER_LENGTH || msg?.kind === 'busy' || leaving) return;
    setMsg({ kind: 'busy', text: 'VERIFYING…' });
    try {
      await unlock(digits);
      setMsg({ kind: 'granted', text: 'ACCESS GRANTED' });
      setLeaving(true);
      setTimeout(onUnlocked, 900);
    } catch (e) {
      setMsg({ kind: 'denied', text: String((e as Error).message ?? e).replace(/^Error:\s*/, '') });
      setShake((n) => n + 1);
      setCode('');
      input.current?.focus();
    }
  };

  const current = [...steps].reverse().find((s) => s.state === 'loading');
  const finished = steps.filter((s) => s.state !== 'loading').length;
  const total = Math.max(steps.length, finished + (done ? 0 : 1), 1);
  const pct = done ? 100 : Math.round((finished / (total + 2)) * 100);

  return (
    <div className={`lock ${leaving ? 'leaving' : ''}`} onMouseDown={() => setTimeout(() => input.current?.focus(), 0)}>
      <div className="lock-corner tl">NOVUS ORDO // SECURE BOOT</div>
      <div className="lock-corner tr">
        {clock.toISOString().slice(0, 19).replace('T', ' ')} UTC · NODE {sid}
      </div>

      <div className="lock-center">
        <div className="lock-emblem" style={{ '--emblem': `url(${emblem})` } as CSSProperties}>
          <img src={emblem} alt="Novus Ordo emblem" draggable={false} />
          <span className="shine" />
        </div>
        <div className="lock-title">WELCOME TO NOVUS ORDO</div>
        <div className="lock-sub">a construction by Quincy Gininda</div>
        <div className="lock-motto">Classified order-flow terminal · Eyes only · Every session sealed</div>
      </div>

      <form
        className={`lock-key ${msg?.kind ?? ''}`}
        key={shake}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="ledger-key">ENTER LEDGER KEY</label>
        <div className="pin" onClick={() => input.current?.focus()}>
          {Array.from({ length: LEDGER_LENGTH }, (_, i) => (
            <span key={i} className={`cell ${i < code.length ? 'filled' : ''} ${i === code.length ? 'caret' : ''}`}>
              {i < code.length ? '•' : ''}
            </span>
          ))}
          <input
            id="ledger-key"
            ref={input}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={LEDGER_LENGTH + 4}
            value={code}
            aria-label="Ledger key"
            onChange={(e) => {
              const d = normalizeKey(e.target.value).slice(0, LEDGER_LENGTH);
              setCode(d);
              if (msg?.kind === 'denied') setMsg(null);
              if (d.length === LEDGER_LENGTH) void submit(d);
            }}
          />
        </div>
        <div className="lock-msg" role="status">
          {msg?.text ?? ' '}
        </div>
      </form>

      <div className="lock-corner bl">
        BUILD 1.0.0 · {desktop ? 'DESKTOP' : 'BROWSER'} · {navigator.platform || 'node'}
      </div>
      <div className="lock-loader" aria-live="polite">
        <div className="now">
          {done ? (
            <>
              <b>ALL SYSTEMS READY</b> — awaiting ledger key
            </>
          ) : current ? (
            <>
              <span className="spin" /> LOADING <b>{current.label}</b> <span className="dim">{current.detail}</span>
            </>
          ) : (
            'INITIALISING…'
          )}
        </div>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <ul>
          {steps.slice(-7).map((s) => (
            <li key={s.id} className={s.state}>
              <span className="tag">{s.state === 'done' ? '[ OK ]' : s.state === 'warn' ? '[WARN]' : '[ .. ]'}</span> {s.label} <span className="dim">— {s.detail}</span>
              {s.ms !== undefined && <span className="ms">{s.ms} ms</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
