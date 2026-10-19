/**
 * Minimal Telegram Bot API connector: send messages, discover the chat id
 * from the latest message sent to the bot, and answer a few read-only
 * commands. Commands are only answered in the configured chat.
 */

type FetchLike = typeof fetch;

export interface TelegramChat {
  id: string;
  title: string;
}

function checkToken(token: string) {
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('That does not look like a bot token (expected 123456:ABC… from @BotFather)');
}

export async function tgApi<T = any>(token: string, method: string, params: Record<string, unknown> = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  checkToken(token);
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description ?? `Telegram ${method} failed`);
  return j.result as T;
}

export async function tgMe(token: string, fetchImpl?: FetchLike) {
  const me = await tgApi<{ username: string; first_name: string }>(token, 'getMe', {}, fetchImpl);
  return { username: me.username, name: me.first_name };
}

/** The chat of the most recent message sent to the bot (send it "/start" first). */
export async function tgDetectChat(token: string, fetchImpl?: FetchLike): Promise<TelegramChat> {
  const updates = await tgApi<any[]>(token, 'getUpdates', { limit: 100, timeout: 0 }, fetchImpl);
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat ?? updates[i].channel_post?.chat ?? updates[i].my_chat_member?.chat;
    if (chat) return { id: String(chat.id), title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) };
  }
  throw new Error('No messages yet — open your bot in Telegram, press Start (or send any message), then try again.');
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function tgSend(token: string, chatId: string, html: string, fetchImpl?: FetchLike) {
  if (!chatId) throw new Error('No chat id yet — use “Detect chat” first');
  await tgApi(token, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }, fetchImpl);
}

/** Telegram caps messages at 4096 characters: split on line breaks. */
export function splitHtml(html: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of html.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function tgSendLong(token: string, chatId: string, html: string, fetchImpl?: FetchLike) {
  for (const part of splitHtml(html)) await tgSend(token, chatId, part, fetchImpl);
}

/** PNG with an HTML caption (captions are limited to 1024 characters). */
export async function tgSendPhoto(token: string, chatId: string, png: Uint8Array, captionHtml: string, fetchImpl: FetchLike = fetch) {
  checkToken(token);
  if (!chatId) throw new Error('No chat id yet — use “Detect chat” first');
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', captionHtml.length > 1024 ? captionHtml.replace(/<[^>]+>/g, '').slice(0, 1020) + '…' : captionHtml);
  if (captionHtml.length <= 1024) form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([png as BlobPart], { type: 'image/png' }), 'chart.png');
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description ?? 'Telegram sendPhoto failed');
}

export const HELP_TEXT = '<b>Novus Ordo bot</b>\n/price — primary instrument price\n/status — price, funding, open interest and feeds\n/help — this message';

/**
 * Long-polls getUpdates and answers /price, /status and /help using the
 * latest snapshot from `status()`. Messages from any other chat are ignored.
 */
export class TelegramCommands {
  private stopped = false;
  private offset = 0;

  constructor(
    private token: string,
    private chatId: string,
    private status: () => { price: string; status: string },
    private fetchImpl: FetchLike = fetch,
    private onError: (e: unknown) => void = () => undefined,
  ) {}

  /** Handle one batch of updates; returns the replies sent (for tests). */
  async handle(updates: any[]): Promise<string[]> {
    const replies: string[] = [];
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const msg = u.message;
      if (!msg?.text || String(msg.chat?.id) !== this.chatId) continue;
      const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
      const snap = this.status();
      const reply = cmd === '/price' ? snap.price : cmd === '/status' ? snap.status : cmd === '/help' || cmd === '/start' ? HELP_TEXT : null;
      if (!reply) continue;
      await tgSend(this.token, this.chatId, reply, this.fetchImpl);
      replies.push(reply);
    }
    return replies;
  }

  async run() {
    // skip the backlog so old commands are not answered on start
    try {
      const old = await tgApi<any[]>(this.token, 'getUpdates', { offset: -1, timeout: 0 }, this.fetchImpl);
      if (old.length) this.offset = old[old.length - 1].update_id + 1;
    } catch (e) {
      this.onError(e);
    }
    while (!this.stopped) {
      try {
        const updates = await tgApi<any[]>(this.token, 'getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, this.fetchImpl);
        if (!this.stopped) await this.handle(updates);
      } catch (e) {
        if (this.stopped) return;
        this.onError(e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
