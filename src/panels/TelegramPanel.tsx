import { useEffect, useState } from 'react';
import type { SecretRecord } from '../desktop/bridge';
import { telegram } from '../desktop/telegram';
import { vault } from '../desktop/vault';
import { openConnections } from '../app/connect';
import { useSettings } from '../store/settings';
import { Check, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export type TelegramConfig = Record<string, never>;
export const TELEGRAM_DEFAULTS: TelegramConfig = {};

export function TelegramPanel(_: PanelProps<TelegramConfig>) {
  const s = useSettings();
  const [bots, setBots] = useState<SecretRecord[]>([]);
  const [me, setMe] = useState<string>('');
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
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
            <button className="chip" disabled={!chatId} onClick={() => void run('test sent', () => telegram.send(bot!.id, '✅ <b>Novus Ordo</b> is connected.\n\nThe swarm will tell you here when it buys a coin, when a coin hits a new multiple, and when it sells.'))}>
              Send test message
            </button>
          </li>
        </ol>
        <div className="section-title">Swarm notifications</div>
        <Check checked={s.telegramSwarm} onChange={(telegramSwarm) => s.set({ telegramSwarm })}>
          <b>Swarm trades on Telegram</b> <span className="muted">— every buy with the coin's chart and why it bought, each new multiple (2×, 5×, 10× …), and every sell with the result</span>
        </Check>
        <Check checked={s.swarmDesktopAlerts} onChange={(swarmDesktopAlerts) => s.set({ swarmDesktopAlerts })}>
          <b>Pop-up and sound here</b> <span className="muted">— when the swarm buys or closes a trade, on this computer too</span>
        </Check>
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
