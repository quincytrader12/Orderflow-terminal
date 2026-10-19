import { useState } from 'react';
import { fmtDateTime, fmtPrice } from '../core/format';
import { hub } from '../market/hub';
import { uid, useSettings, type JournalEntry } from '../store/settings';
import { Empty, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export type JournalConfig = Record<string, never>;
export const JOURNAL_DEFAULTS: JournalConfig = {};

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toMarkdown(entries: JournalEntry[]) {
  return entries
    .map((e) => `## ${fmtDateTime(e.time)} — ${e.base} @ ${fmtPrice(e.price)}\n\n${e.text}\n${e.tags.length ? `\nTags: ${e.tags.map((t) => `#${t}`).join(' ')}\n` : ''}`)
    .join('\n');
}

export function Journal(_: PanelProps<JournalConfig>) {
  const entries = useSettings((s) => s.journal);
  const add = useSettings((s) => s.addJournal);
  const update = useSettings((s) => s.updateJournal);
  const remove = useSettings((s) => s.removeJournal);
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const submit = () => {
    if (!text.trim()) return;
    const f = hub().primary;
    const tagList = tags
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    if (editing) {
      update(editing, { text: text.trim(), tags: tagList });
      setEditing(null);
    } else add({ id: uid(), time: Date.now(), base: f.inst.base, price: f.lastPrice(), text: text.trim(), tags: tagList });
    setText('');
    setTags('');
  };

  const shown = entries.filter((e) => !filter || e.text.toLowerCase().includes(filter.toLowerCase()) || e.tags.some((t) => t.includes(filter.toLowerCase())) || e.base === filter.toUpperCase());

  return (
    <div className="panel">
      <Toolbar>
        <input className="ctl" placeholder="Search notes / tags…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 140 }} />
        <Spacer />
        <button className="chip" onClick={() => download(`journal-${new Date().toISOString().slice(0, 10)}.md`, toMarkdown(entries), 'text/markdown')}>
          Export .md
        </button>
        <button className="chip" onClick={() => download(`journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(entries, null, 2), 'application/json')}>
          Export .json
        </button>
      </Toolbar>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <textarea
          className="ctl"
          rows={3}
          placeholder={`Note for ${hub().primary.inst.base} — current price is attached automatically (Ctrl+Enter to save)`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input className="ctl" placeholder="tags: setup, absorption…" value={tags} onChange={(e) => setTags(e.target.value)} style={{ flex: 1 }} />
          {editing && (
            <button
              className="btn ghost"
              onClick={() => {
                setEditing(null);
                setText('');
                setTags('');
              }}
            >
              Cancel
            </button>
          )}
          <button className="btn" onClick={submit} disabled={!text.trim()}>
            {editing ? 'Update' : 'Add note'}
          </button>
        </div>
      </div>
      <div className="scroll">
        {shown.length === 0 ? (
          <Empty>Journal entries are stored in this browser only.</Empty>
        ) : (
          shown.map((e) => (
            <div className="list-row" key={e.id} style={{ flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
                <span className="mono muted">{fmtDateTime(e.time)}</span>
                <span className="tag">
                  {e.base} @ {fmtPrice(e.price)}
                </span>
                <Spacer />
                <button
                  className="chip"
                  onClick={() => {
                    setEditing(e.id);
                    setText(e.text);
                    setTags(e.tags.join(', '));
                  }}
                >
                  Edit
                </button>
                <button className="chip" onClick={() => remove(e.id)}>
                  ×
                </button>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{e.text}</div>
              {e.tags.length > 0 && (
                <div>
                  {e.tags.map((t) => (
                    <span className="tag" key={t}>
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
