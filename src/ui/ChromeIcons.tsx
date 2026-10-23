import { useId, type ReactNode } from 'react';

/**
 * Line icons drawn in polished chrome (a vertical metal gradient with a dark
 * horizon band across the middle) and lit with a soft neon-silver glow — the
 * same metal as the Novus Ordo emblem and the boot ring. Colours come from
 * the --chrome-* variables, so light themes get a darker metal.
 */
function ChromeIcon({ size = 16, children }: { size?: number; children: ReactNode }) {
  const id = `chrome-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={`url(#${id})`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <defs>
        {/* user-space units: one band of metal across the whole icon, straight lines included */}
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="22">
          <stop offset="0" style={{ stopColor: 'var(--chrome-1)' }} />
          <stop offset="0.44" style={{ stopColor: 'var(--chrome-2)' }} />
          <stop offset="0.52" style={{ stopColor: 'var(--chrome-3)' }} />
          <stop offset="0.62" style={{ stopColor: 'var(--chrome-4)' }} />
          <stop offset="1" style={{ stopColor: 'var(--chrome-5)' }} />
        </linearGradient>
      </defs>
      {children}
    </svg>
  );
}

/** Trading bot: an automaton head with an antenna. */
export function BotIcon(props: { size?: number }) {
  return (
    <ChromeIcon {...props}>
      <path d="M12 3.4v3.4" />
      <circle cx="12" cy="2.6" r="0.9" />
      <rect x="4.5" y="6.8" width="15" height="12.2" rx="3.4" />
      <path d="M2.4 11.6v3.4M21.6 11.6v3.4" />
      <path d="M8.6 11.4v1.8M15.4 11.4v1.8" strokeWidth={2.3} />
      <path d="M9.4 16.1h5.2" />
    </ChromeIcon>
  );
}

/** Connections: a power plug with its cable. */
export function ConnectIcon(props: { size?: number }) {
  return (
    <ChromeIcon {...props}>
      <path d="M9 2.5v4M15 2.5v4" />
      <path d="M6.2 6.5h11.6v3.6a5.8 5.8 0 0 1-11.6 0z" />
      <path d="M12 15.9v2.6a3 3 0 0 0 3 3h3.5" />
    </ChromeIcon>
  );
}

/** Lock: a padlock with a keyhole. */
export function LockIcon(props: { size?: number }) {
  return (
    <ChromeIcon {...props}>
      <rect x="4.6" y="10.6" width="14.8" height="10.6" rx="2.4" />
      <path d="M8 10.6V7.4a4 4 0 0 1 8 0v3.2" />
      <path d="M12 14.6v2.4" strokeWidth={2.1} />
    </ChromeIcon>
  );
}
