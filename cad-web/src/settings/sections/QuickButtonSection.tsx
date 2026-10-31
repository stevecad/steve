/**
 * Settings → Quick button: the split button at the top right (shell/QuickButton.tsx). People choose its items (any
 * command, any connector action they may run), their order and the main one; or leave it automatic.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Button } from '@/ui';
import { commands } from '@/commands';
import { useRunnableActions, watchRunnableActions } from '@/lib/runnableActions';
import { quickItem } from '@/shell/QuickButton';
import { useExportFormat } from '@/state/exportFormat';
import { useApp } from '@/state/store';
import { settingsSections } from '../registry';
import { updateSetting, useSetting } from '../store';
import { Card, Note, SettingsPage } from '../ui';
import own from './Developers.module.css';

/** The server's limit for 'toolbar.quickItems' (app/account_settings.py). */
const MAX_QUICK_ITEMS = 30;

export default function QuickButtonSection() {
  const section = settingsSections().find((item) => item.id === 'quick-button')!;
  useEffect(() => { watchRunnableActions(); }, []);
  const items = useSetting('toolbar.quickItems');
  const main = useSetting('toolbar.quickMain');
  const actions = useRunnableActions((state) => state.actions);
  const remembered = useExportFormat((state) => state.format);
  const [search, setSearch] = useState('');
  const label = (id: string) => quickItem(id, useApp.getState(), remembered, actions)?.label ?? null;
  const custom = items.length > 0;
  const save = (next: string[], nextMain = main) => {
    updateSetting('toolbar.quickItems', next);
    updateSetting('toolbar.quickMain', next.includes(nextMain) ? nextMain : '');
  };
  // Customize starts small: Run an action… reaches every action, and people add the ones they want (any number of
  // actions would pass the server's limit).
  const automatic = ['export', ...(actions.length ? ['command:app.runAction'] : [])];
  const full = items.length >= MAX_QUICK_ITEMS;
  const choices = useMemo(() => {
    const all = [{ id: 'export', text: 'Export (your last format)' },
      ...actions.map((action) => ({ id: `action:${action.id}`, text: `Run: ${action.title} · ${action.connector.name}` })),
      ...commands.map((item) => ({ id: `command:${item.id}`, text: `${item.label} · ${item.category}` }))];
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((choice) => !items.includes(choice.id) && words.every((word) => choice.text.toLowerCase().includes(word))).slice(0, 12);
  }, [search, actions, items]);
  const move = (index: number, by: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
    save(next);
  };
  return (
    <SettingsPage section={section}>
      <Card title="Quick button" id="quick-button" description="The split button at the top right: its main item runs with one click, the rest are in its menu. Put what you use most there: an export, a command, or one of your connector actions.">
        {!custom ? (
          <div className={own.form}>
            <Note>Automatic: {actions.length ? 'Run an action… is the main item; every export and each of your connector actions are in the menu.' : 'it exports in your last format; every export is in the menu.'}</Note>
            <div className={own.actions}><Button variant="primary" onClick={() => save(automatic, automatic.includes('command:app.runAction') ? 'command:app.runAction' : 'export')}>Customize</Button></div>
          </div>
        ) : (
          <div className={own.form}>
            {items.map((id, index) => {
              const text = label(id);
              return (
                <div key={id} className={own.key} data-quick-item={id} data-revoked={text === null || undefined}>
                  <label className={own.scope}>
                    <input type="radio" name="quick-main" checked={(main || items[0]) === id} disabled={text === null} onChange={() => save(items, id)} />
                    <span><b>{text ?? 'No longer available'}</b>{(main || items[0]) === id ? ' · main item' : ''}</span>
                  </label>
                  <div className={own.actions}>
                    <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></Button>
                    <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></Button>
                    <Button size="sm" variant="ghost" aria-label="Remove" disabled={items.length === 1} onClick={() => save(items.filter((item) => item !== id))}><X size={13} /></Button>
                  </div>
                </div>
              );
            })}
            <span className={own.label}>Add</span>
            {full ? <Note>The quick button holds up to {MAX_QUICK_ITEMS} items; remove one to add another.</Note> : (
              <>
                <input className={own.input} placeholder="Search commands and your connector actions" aria-label="Search items to add" value={search} onChange={(event) => setSearch(event.target.value)} />
                <div className={own.form} style={{ gap: 4 }}>
                  {choices.map((choice) => (
                    <div key={choice.id} className={own.actions}>
                      <Button size="sm" onClick={() => { save([...items, choice.id]); setSearch(''); }}>Add</Button>
                      <span>{choice.text}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className={own.actions}><Button onClick={() => save([], '')}>Back to automatic</Button></div>
          </div>
        )}
      </Card>
    </SettingsPage>
  );
}
