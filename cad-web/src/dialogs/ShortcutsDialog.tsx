import { Keyboard } from 'lucide-react';
import { Button, Dialog, Shortcut } from '@/ui';
import { openSettings } from '@/settings/registry';
import { set, useApp } from '@/state/store';
import { commands, switchedOff } from '@/commands';
import { displayShortcut } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { mouseStyleInfo } from '@/viewport/mouseStyle';
import styles from './Dialogs.module.css';

const MOUSE = [
  ['Orbit', 'Left drag'], ['Pan', 'Right or middle drag'], ['Zoom to cursor', 'Scroll'], ['Select', 'Click'],
  ['Add to selection', 'Shift / Ctrl click'], ['Select owner', 'Double-click'], ['Context menu', 'Right click'],
];

export default function ShortcutsDialog({ open }: { open: boolean }) {
  // Orbit, pan and zoom follow Settings → Navigation's mouse style (MOUSE has the default's).
  const style = mouseStyleInfo(useSetting('viewport.mouseStyle')).mouse;
  const mouse = MOUSE.map(([label, keys]) => [label, style.find(([action]) => action === label)?.[1] ?? keys]);
  const state = useApp();
  const withKeys = commands.filter((cmd) => cmd.shortcut && !switchedOff(cmd, state) && !cmd.hidden?.(state));
  const groups = [...new Set(withKeys.map((cmd) => cmd.category))];
  return (
    <Dialog open={open} onOpenChange={(value) => !value && set({ dialog: null })} title="Keyboard and mouse" description="Every command is also in the command palette." icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><Keyboard size={17} /></div>} width={680}>
      <Button onClick={() => openSettings('keyboard')}>Customize keyboard shortcuts</Button>
      <div className={styles.shortcuts}>
        <div className={styles.shortcutGroup}>
          <h4 className="caps">Mouse</h4>
          {mouse.map(([label, keys]) => <div key={label} className={styles.shortcutRow}><span>{label}</span><span style={{ color: 'var(--text-1)', fontSize: 11 }}>{keys}</span></div>)}
        </div>
        {groups.map((group) => (
          <div key={group} className={styles.shortcutGroup}>
            <h4 className="caps">{group}</h4>
            {withKeys.filter((cmd) => cmd.category === group).map((cmd) => (
              <div key={cmd.id} className={styles.shortcutRow}><span>{cmd.label}</span><Shortcut keys={displayShortcut(cmd.shortcut)!} /></div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
