import { useState } from 'react';
import { commands, eventKey, switchedOff } from '@/commands';
import { useApp } from '@/state/store';
import { Button } from '@/ui';
import { displayShortcut } from '@/lib/format';
import { bindingLabel, type KeyboardPreset } from '../keyboard';
import { settingsSections } from '../registry';
import { updateSetting, updateSettings, useSetting } from '../store';
import { Card, ChoiceCards, Note, Row, SettingsPage } from '../ui';
import styles from './KeyboardSection.module.css';

export default function KeyboardSection() {
  const preset = useSetting('keyboard.preset');
  const overrides = useSetting('keyboard.overrides');
  const state = useApp();
  const [search, setSearch] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; key: string; conflicts: string[] } | null>(null);
  const [error, setError] = useState('');
  const available = commands.filter(c => !c.keysElsewhere && !switchedOff(c, state));
  const assign = (id: string, key: string, conflicts: string[]) => {
    const next = { ...overrides, [id]: [key] };
    for (const other of conflicts) next[other] = commands.find(c => c.id === other)!.keys!.filter(k => k !== key);
    void updateSetting('keyboard.overrides', next); setPending(null); setRecording(null);
  };
  return <SettingsPage section={settingsSections().find(s => s.id === 'keyboard')!}>
    <Card title="Keyboard preset" description="Steve stays the default. Switching presets clears custom bindings; mouse navigation is configured separately.">
      <ChoiceCards<KeyboardPreset> label="Keyboard preset" value={preset} options={[
        { value: 'steve', label: 'Steve', description: 'Original Steve shortcuts' },
        { value: 'fusion', label: 'Fusion', description: 'E extrude · F fillet · I measure' },
        { value: 'solidworks', label: 'SOLIDWORKS', description: 'F fit · Ctrl+B rebuild · Ctrl+1–7 views' },
      ]} onChange={id => { setPending(null); setRecording(null); void updateSettings({ 'keyboard.preset': id, 'keyboard.overrides': {} }); }} />
      <Note>Presets map supported equivalents. S opens Steve’s command palette in Fusion and SOLIDWORKS presets. Other Steve shortcuts remain unless they conflict. Unsupported commands from those apps are not emulated.</Note>
    </Card>
    <Card title="Customize commands" description="Click a binding, then press your shortcut. Escape cancels recording. Clear unassigns it. Changes save on this machine."
      actions={<Button onClick={() => { setPending(null); void updateSetting('keyboard.overrides', {}); }}>Reset custom bindings</Button>}>
      <input className={styles.search} aria-label="Search keyboard shortcuts" placeholder="Search commands or categories…" value={search} onChange={e => setSearch(e.target.value)} />
      {error && <Note tone="warning">{error}</Note>}
      {pending && <div className={styles.conflict} role="alert"><p>{displayShortcut(bindingLabel([pending.key]))} is assigned to {pending.conflicts.map(id => commands.find(c => c.id === id)?.label).join(', ')}.</p>
        <Button onClick={() => assign(pending.id, pending.key, pending.conflicts)}>Replace conflicting bindings</Button>
        <Button variant="ghost" onClick={() => { setPending(null); setRecording(null); }}>Cancel</Button></div>}
      <div className={styles.list}>
        {available.filter(c => `${c.label} ${c.category}`.toLowerCase().includes(search.toLowerCase())).map(c => <Row key={c.id} label={c.label} hint={`${c.category}${c.id in overrides ? ' · Customized' : ''}`}>
          <button className={styles.binding} aria-label={`Shortcut for ${c.label}`} onClick={() => { setRecording(c.id); setPending(null); setError(''); }} onBlur={() => setRecording(null)} onKeyDown={e => {
            if (recording !== c.id) return;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') { setRecording(null); return; }
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
            const key = eventKey(e.nativeEvent);
            if (['tab', 'enter', 'space', 'mod+c', 'mod+v', 'mod+x', 'mod+a', 'alt+f4'].includes(key)) { setError('That key is reserved for text entry or window controls. Choose another combination.'); return; }
            const conflicts = available.filter(other => other.id !== c.id && other.keys?.includes(key)).map(other => other.id);
            if (conflicts.length) { setPending({ id: c.id, key, conflicts }); setRecording(null); }
            else assign(c.id, key, []);
          }}>{recording === c.id ? 'Press shortcut…' : c.keys?.map(k => displayShortcut(bindingLabel([k]))).join(' / ') || 'Unassigned'}</button>
          <Button variant="ghost" onClick={() => void updateSetting('keyboard.overrides', { ...overrides, [c.id]: [] })}>Clear</Button>
        </Row>)}
      </div>
      <Note>Escape and text-editor, chat-send and drawing-canvas gestures keep their contextual behavior.</Note>
    </Card>
  </SettingsPage>;
}
