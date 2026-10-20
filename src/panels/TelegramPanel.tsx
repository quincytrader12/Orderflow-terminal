import { useEffect, useState } from 'react';
import type { SecretRecord } from '../desktop/bridge';
import { buildReport, localTz, sendReport, type BuiltReport } from '../desktop/reports';
import { statusSnapshot, telegram } from '../desktop/telegram';
import type { ReportKind } from '../shared/report';
import { vault } from '../desktop/vault';
import { openConnections } from '../app/connect';
import { useSettings } from '../store/settings';
import { Check, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Show report HTML in the app: only Telegram's <b> and <i> tags survive. */
function previewHtml(html: string) {
  return html
    .replace(/<(\/?)(b|i)>/g, '\u0001$1$2\u0002')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>');
}

export type TelegramConfig = Record<string, never>;
export const TELEGRAM_DEFAULTS: TelegramConfig = {};

export function TelegramPanel(_: PanelProps<TelegramConfig>) {
  const s = useSettings();
  const [bots, setBots] = useState<SecretRecord[]>([]);
  const [me, setMe] = useState<string>('');
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const [preview, setPreview] = useState<(BuiltReport & { urls: string[] }) | null>(null);
  const [busy, setBusy] = useState('');
  const note = (ok: boolean, text: string) => setLog((l) => [{ ok, text: `${new Date().toLocaleTimeString()} · ${text}` }, ...l].slice(0, 20));

  const reload = () =>
    vault
      .list()
      .then((all) => {
        const t = all.filter((k) => k.kind === 'telegram');
        setBots(t);
        if (!s.telegramSecretId && t[0]) s.set({ telegramSecretId: t[0].id });
      })
      .catch(() => undefined);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bot = bots.find((b) => b.id === s.telegramSecretId);
  const chatId = bot?.meta.fields.chatId;

  useEffect(() => {
    setMe('');
    if (!bot) return;
    telegram
      .me(bot.id)
      .then((m) => setMe(`@${m.username}`))
      .catch((e) => note(false, String(e.message ?? e)));
  }, [bot?.id]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      note(true, typeof r === 'string' ? r : label);
      await reload();
    } catch (e) {
      note(false, String((e as Error).message ?? e));
    }
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={s.telegramSecretId}
          options={[{ value: '', label: bots.length ? 'Choose bot…' : 'No bot yet' }, ...bots.map((b) => ({ value: b.id, label: b.label }))]}
          onChange={(telegramSecretId) => s.set({ telegramSecretId })}
          width={160}
        />
        <span className="muted">{me}</span>
        <Spacer />
        <span className={`status-dot status-${bot && chatId ? 'open' : 'idle'}`} title={chatId ? `chat ${chatId}` : 'not linked'} />
      </Toolbar>
      <div className="scroll" style={{ padding: 10 }}>
        <ol className="steps">
          <li className={bot ? 'done' : ''}>
            In Telegram, message <b>@BotFather</b> → <span className="mono">/newbot</span> and copy the token. Add it in{' '}
            <button className="chip" onClick={openConnections}>
              🔌 Connect → Telegram bot
            </button>
          </li>
          <li className={chatId ? 'done' : ''}>
            Open your bot in Telegram and press <b>Start</b>, then{' '}
            <button className="chip" disabled={!bot} onClick={() => void run('chat linked', async () => `Linked to ${(await telegram.detect(bot!.id)).title}`)}>
              Detect chat
            </button>
            {chatId && <span className="muted mono"> chat {chatId}</span>}
          </li>
          <li>
            <button className="chip" disabled={!chatId} onClick={() => void run('test sent', () => telegram.send(bot!.id, '✅ <b>Novus Ordo</b> is connected.\n\n' + statusSnapshot().price))}>
              Send test message
            </button>
          </li>
        </ol>
        <div className="section-title">Reports</div>
        <Check checked={s.telegramDaily} onChange={(telegramDaily) => s.set({ telegramDaily })}>
          <b>Daily report</b> <span className="muted">— market, value area and AMT context, order flow, bots, orders, accounts, wallet, alerts + chart</span>
        </Check>
        <Check checked={s.telegramWeekly} onChange={(telegramWeekly) => s.set({ telegramWeekly })}>
          <b>Weekly overview</b> <span className="muted">— weekly value and migration, bots by setup, best/worst trade, equity curve + charts</span>
        </Check>
        <div className="report-when">
          <span>Send at</span>
          <input className="ctl mono" type="time" value={s.reportTime} onChange={(e) => e.target.value && s.set({ reportTime: e.target.value })} />
          <span>weekly on</span>
          <Select value={s.reportWeekday} options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} onChange={(reportWeekday) => s.set({ reportWeekday })} />
          <span className="muted">{localTz()} — while the app is open; a missed report is sent when it reopens the same day</span>
        </div>
        <div className="chip-row">
          {(['daily', 'weekly'] as ReportKind[]).map((k) => (
            <button
              key={k}
              className="chip"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy(`preview-${k}`);
                try {
                  preview?.urls.forEach((u) => URL.revokeObjectURL(u));
                  const r = await buildReport(k);
                  setPreview({ ...r, urls: r.images.map((i) => URL.createObjectURL(new Blob([i.png as BlobPart], { type: 'image/png' }))) });
                } catch (e) {
                  note(false, String((e as Error).message ?? e));
                } finally {
                  setBusy('');
                }
              }}
            >
              {busy === `preview-${k}` ? 'Building…' : `Preview ${k}`}
            </button>
          ))}
          {(['daily', 'weekly'] as ReportKind[]).map((k) => (
            <button key={`send-${k}`} className="chip" disabled={!chatId || Boolean(busy)} onClick={() => void run(`${k} report sent`, async () => (setBusy(`send-${k}`), await sendReport(k).finally(() => setBusy(''))))}>
              {busy === `send-${k}` ? 'Sending…' : `Send ${k} now`}
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Last sent: daily {s.lastDailyReport || '—'} · weekly {s.lastWeeklyReport || '—'}
        </div>
        {preview && (
          <div className="report-preview">
            <div className="report-text" dangerouslySetInnerHTML={{ __html: previewHtml(preview.html) }} />
            {preview.urls.map((u, i) => (
              <figure key={u}>
                <img src={u} alt={`${preview.kind} chart ${i + 1}`} />
                <figcaption dangerouslySetInnerHTML={{ __html: previewHtml(preview.images[i].caption) }} />
              </figure>
            ))}
          </div>
        )}
        <div className="section-title">Instant notifications</div>
        <label className="check">
          <input type="checkbox" checked={s.telegramAlerts} onChange={(e) => s.set({ telegramAlerts: e.target.checked })} /> Forward fired alerts, placed orders and AMT bot entries (with chart), exits, stops and errors
        </label>
        <label className="check">
          <input type="checkbox" checked={s.telegramFeedAlerts} onChange={(e) => s.set({ telegramFeedAlerts: e.target.checked })} /> Tell me when the data feed has been down for 2 minutes, and when it recovers
        </label>
        <label className="check">
          <input type="checkbox" checked={s.telegramCommands} disabled={!chatId} onChange={(e) => s.set({ telegramCommands: e.target.checked })} /> Answer <span className="mono">/price</span>,{' '}
          <span className="mono">/status</span>, <span className="mono">/help</span> (only in your chat, while the app is open)
        </label>
        {log.length > 0 && (
          <>
            <div className="section-title">Log</div>
            {log.map((l, i) => (
              <div key={i} className={l.ok ? 'up' : 'down'} style={{ fontSize: 11, padding: '2px 0' }}>
                {l.text}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
