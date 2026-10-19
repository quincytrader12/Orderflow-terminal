import type { ConnState } from '../core/types';

export interface ManagedSocketOptions {
  url: string | (() => string | Promise<string>);
  /** called on every (re)open; send subscriptions here */
  onOpen?: (ws: ManagedSocket) => void | Promise<void>;
  onMessage: (data: unknown, raw: string) => void;
  onState?: (state: ConnState, error?: string) => void;
  /** keepalive payload and period */
  ping?: { intervalMs: number; payload: () => string };
  /** treat this raw text as a pong and skip JSON parsing */
  isPong?: (raw: string) => boolean;
  /** reconnect if no message arrives for this long */
  staleMs?: number;
  binaryType?: BinaryType;
  /** non-JSON messages are passed as raw strings when true */
  rawText?: boolean;
}

/** WebSocket with exponential-backoff reconnect, keepalive and stale detection. */
export class ManagedSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMsg = 0;
  state: ConnState = 'idle';

  constructor(private opts: ManagedSocketOptions) {}

  async connect() {
    this.closedByUser = false;
    this.setState('connecting');
    let url: string;
    try {
      url = typeof this.opts.url === 'string' ? this.opts.url : await this.opts.url();
    } catch (e) {
      this.setState('error', String(e));
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setState('error', String(e));
      this.scheduleReconnect();
      return;
    }
    if (this.opts.binaryType) ws.binaryType = this.opts.binaryType;
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.lastMsg = Date.now();
      this.setState('open');
      if (this.opts.ping) {
        const { intervalMs, payload } = this.opts.ping;
        this.pingTimer = setInterval(() => this.send(payload()), intervalMs);
      }
      if (this.opts.staleMs) {
        const staleMs = this.opts.staleMs;
        this.staleTimer = setInterval(() => {
          if (Date.now() - this.lastMsg > staleMs) {
            this.setState('error', 'stale feed, reconnecting');
            ws.close();
          }
        }, Math.min(5000, staleMs));
      }
      void this.opts.onOpen?.(this);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      if (this.opts.isPong?.(raw)) return;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        if (this.opts.rawText) data = raw;
        else return;
      }
      try {
        this.opts.onMessage(data, raw);
      } catch (e) {
        console.error('[ws] handler error', e);
      }
    };
    ws.onerror = () => {
      this.setState('error', 'socket error');
    };
    ws.onclose = (ev) => {
      this.clearTimers();
      this.ws = null;
      if (this.closedByUser) {
        this.setState('closed');
        return;
      }
      this.setState('error', `closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closedByUser) return;
    const delay = Math.min(30_000, 500 * 2 ** this.attempts++) + Math.random() * 250;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /** Force a reconnect (e.g. after an order book sequence gap). */
  reconnect() {
    if (this.ws) this.ws.close();
    else void this.connect();
  }

  send(data: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    }
    return false;
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.pingTimer = this.staleTimer = null;
  }

  private setState(s: ConnState, err?: string) {
    this.state = s;
    this.opts.onState?.(s, err);
  }
}

export async function fetchJson<T = any>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));
