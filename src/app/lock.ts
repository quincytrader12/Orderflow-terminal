import { create } from 'zustand';
import { desktop } from '../desktop/bridge';

/**
 * Locking the terminal: back to the ENTER LEDGER KEY page without a reload.
 * The terminal's panels unmount (nothing of the accounts stays on screen)
 * while market data, alerts and bots keep running underneath, so unlocking is
 * instant. The desktop process seals itself too: keys, trading and bot
 * control stay refused until the ledger key is entered again.
 */

export const SESSION_FLAG = 'novus-ledger-open';

export type GateState = 'locked' | 'opening' | 'open';

interface LockStore {
  state: GateState;
  /** when and why the terminal was locked (null on the first boot) */
  lockedAt: number | null;
  reason: string | null;
  set(state: GateState): void;
}

export const useLock = create<LockStore>((set) => ({
  state: 'locked',
  lockedAt: null,
  reason: null,
  set: (state) => set({ state }),
}));

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_FLAG);
  } catch {
    /* private mode */
  }
}

/** Lock now (the top-bar Lock button). Only ever on the owner's request. */
export async function lockTerminal(reason = 'locked by you') {
  const s = useLock.getState();
  if (s.state === 'locked') return;
  // the screen locks at once; the desktop process seals in the same moment
  useLock.setState({ state: 'locked', lockedAt: Date.now(), reason });
  clearSession();
  await desktop?.app.seal().catch(() => undefined);
}

/** Another window locked the terminal: follow it. */
export function followDesktopSeal() {
  return desktop?.app.onSealed?.((reason) => {
    if (useLock.getState().state === 'locked') return;
    useLock.setState({ state: 'locked', lockedAt: Date.now(), reason });
    clearSession();
  });
}
