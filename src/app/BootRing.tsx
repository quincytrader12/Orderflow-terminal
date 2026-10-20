import { useEffect, useRef, useState } from 'react';
import emblem from '../assets/emblem.png';
import { desktop } from '../desktop/bridge';
import { useBoot } from './boot';
import { bootProgress } from './bootProgress';

/**
 * Overall boot progress as a chrome ring in the shape of the Chrome logo:
 * three segments (core assets, exchange connectors, market data) around a
 * centre disc holding the emblem. The ring fills clockwise with the real
 * loading progress; hover or click for the breakdown.
 */

const R = 46; // outer radius
const RI = 22; // inner edge of the segments
const RC = 17; // centre disc
const PHI = (Math.acos(RI / R) * 180) / Math.PI; // tangent offset of the segment edges

const pt = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`;
};

/** One segment: outer arc, then edges running tangent to the inner circle. */
function segment(a0: number) {
  const a1 = a0 + 120;
  return `M ${pt(R, a0)} A ${R} ${R} 0 0 1 ${pt(R, a1)} L ${pt(RI, a1 + PHI)} A ${RI} ${RI} 0 0 0 ${pt(RI, a0 + PHI)} Z`;
}

/** Pie wedge from 12 o'clock, clockwise, covering `frac` of the circle. */
function wedge(frac: number) {
  if (frac >= 0.999) return `M 0 ${-R - 4} A ${R + 4} ${R + 4} 0 1 1 -0.01 ${-R - 4} Z`;
  if (frac <= 0) return 'M 0 0';
  const end = -90 + 360 * frac;
  return `M 0 0 L ${pt(R + 4, -90)} A ${R + 4} ${R + 4} 0 ${frac > 0.5 ? 1 : 0} 1 ${pt(R + 4, end)} Z`;
}

// segment start angles: core at the top, then connectors, then market data, clockwise
const STARTS = [-150 - PHI, -30 - PHI, 90 - PHI];

export function BootRing() {
  const { steps, done } = useBoot();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [shown, setShown] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // eased estimates move with time, so re-evaluate while loading
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [done]);

  const prog = bootProgress(steps, Boolean(desktop), now, done);
  const target = prog.overall;

  // the number and the ring glide toward the real value instead of jumping
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setShown((v) => {
        const next = v + (target - v) * 0.12;
        return Math.abs(target - next) < 0.001 ? target : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  useEffect(() => {
    if (!pinned) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && (setPinned(false), setOpen(false));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setPinned(false), setOpen(false));
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [pinned]);

  const pct = Math.round(shown * 100);
  const current = [...steps].reverse().find((s) => s.state === 'loading');
  const warns = steps.filter((s) => s.state === 'warn').length;

  return (
    <div
      ref={box}
      className={`boot-ring ${done ? 'complete' : ''} ${open ? 'open' : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => !pinned && setOpen(false)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="ring-btn"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`Loading ${pct}%`}
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
      >
        <svg viewBox="-52 -52 104 104" width="64" height="64" aria-hidden>
          <defs>
            {/* polished chrome: three lights at different angles per segment */}
            {/* polished chrome in three tones, so the segments read like the Chrome logo's three colours */}
            {[
              ['#ffffff', '#b9bfc8', '#f3f5f7', '#8b929c', '#e4e7eb'],
              ['#e9ecef', '#8e959f', '#dfe3e7', '#5f666f', '#c7ccd2'],
              ['#d7dbe0', '#737a84', '#c9ced4', '#4c525a', '#b3b9c0'],
            ].map((c, i) => (
              <linearGradient key={i} id={`chrome-${i}`} gradientTransform={`rotate(${35 + i * 120} 0.5 0.5)`}>
                {c.map((col, k) => (
                  <stop key={k} offset={k / 4} stopColor={col} />
                ))}
              </linearGradient>
            ))}
            <radialGradient id="chrome-core" cx="0.35" cy="0.3" r="0.9">
              <stop offset="0" stopColor="#1d2026" />
              <stop offset="1" stopColor="#040506" />
            </radialGradient>
            <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(255,255,255,0)" />
              <stop offset="0.5" stopColor="rgba(255,255,255,0.85)" />
              <stop offset="1" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
            <mask id="ring-fill">
              <path d={wedge(shown)} fill="#fff" />
            </mask>
            <clipPath id="core-clip">
              <circle r={RC - 2} />
            </clipPath>
          </defs>
          {/* empty segments */}
          {STARTS.map((a, i) => (
            <path key={`e${i}`} d={segment(a)} className="seg-empty" />
          ))}
          {/* chrome fill, revealed clockwise by progress */}
          <g mask="url(#ring-fill)">
            {STARTS.map((a, i) => (
              <path key={`f${i}`} d={segment(a)} fill={`url(#chrome-${i})`} className={`seg-fill seg-${prog.phases[i].frac >= 1 ? 'done' : 'live'}`} />
            ))}
          </g>
          {/* a light sweeping round the ring while it loads */}
          {!done && (
            <g className="ring-sheen" mask="url(#ring-fill)">
              <rect x={-6} y={-R} width={12} height={R - RI + 2} fill="url(#sheen)" opacity="0.7" />
            </g>
          )}
          {/* inner bezel and centre disc with the emblem */}
          <circle r={RI - 1.5} fill="none" stroke="url(#chrome-0)" strokeWidth="2.2" />
          <circle r={RC} fill="url(#chrome-core)" />
          <image href={emblem} x={-(RC - 3)} y={-(RC - 3)} width={(RC - 3) * 2} height={(RC - 3) * 2} clipPath="url(#core-clip)" style={{ opacity: 0.35 + 0.65 * shown }} />
        </svg>
      </button>
      <div className="ring-text">
        <div className="ring-title">
          SECURE BOOT <b>{pct}%</b>
        </div>
        <div className="ring-sub">{done ? (warns ? `ready · ${warns} warning${warns > 1 ? 's' : ''}` : 'all systems ready') : current ? current.label : 'initialising'}</div>
      </div>
      {open && (
        <div className="ring-pop" role="dialog" aria-label="Loading details">
          {prog.phases.map((ph) => (
            <div key={ph.id} className={`ring-phase ${ph.frac >= 1 ? 'done' : ph.frac > 0 ? 'live' : ''}`}>
              <div className="ph-head">
                <span>{ph.label}</span>
                <span className="mono">
                  {Math.round(ph.frac * 100)}% · {ph.done}/{ph.steps}
                </span>
              </div>
              <div className="ph-bar">
                <div style={{ width: `${ph.frac * 100}%` }} />
              </div>
            </div>
          ))}
          <ul>
            {steps.map((s) => (
              <li key={s.id} className={s.state}>
                <span className="dot" /> {s.label}
                <span className="dim"> {s.detail}</span>
              </li>
            ))}
          </ul>
          <div className="ring-foot">{pinned ? 'Click outside or press Esc to close' : 'Click the ring to pin'}</div>
        </div>
      )}
    </div>
  );
}
