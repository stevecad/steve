/**
 * The top bar's quick button (the split button at the right): a main item and a menu. People choose its items and
 * the main one in Settings → Quick button (settings 'toolbar.quickItems' and 'toolbar.quickMain'): any command, and any
 * connector action they may run. Left automatic, it is the export button (the last export format, every export in its
 * menu) and, for someone with connector actions, Run an action… is its main item with each action in the menu.
 *
 * Items: "export" (the remembered export format), "command:<id>" (a command, commands.ts), "action:<id>" (run that
 * connector action: the Run an action dialog opens on it). An item that no longer exists (a command removed, an action
 * no longer allowed) is left out.
 */
import { useEffect, type ReactNode } from 'react';
import { ChevronDown, Settings2, Workflow } from 'lucide-react';
import { Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '@/ui';
import { availability, command, commands, runCommand } from '@/commands';
import { useSettings } from '@/settings/store';
import { openSettings } from '@/settings/registry';
import { useRunnableActions, watchRunnableActions } from '@/lib/runnableActions';
import { EXPORT_FORMATS, useExportFormat } from '@/state/exportFormat';
import { set, toast, useApp, type AppState } from '@/state/store';
import type { RunnableAction } from '@/lib/actions';
import ExportMenuItems, { exportsCircuit } from './ExportMenu';
import styles from './TopBar.module.css';

export interface QuickItem { id: string; label: string; icon: ReactNode; run: () => void; available: true | string; hint?: string }

const exists = (id: string) => commands.some((item) => item.id === id);

/** Runs one connector action: the Run an action dialog, opened on it. */
export function runAction(actionId: string) {
  set({ dialog: 'runAction', runActionId: actionId });
}

/** The item an id names in this state (null: it no longer exists). */
export function quickItem(id: string, state: AppState, remembered: keyof typeof EXPORT_FORMATS, actions: RunnableAction[]): QuickItem | null {
  {
    if (id === 'export') {
      const circuit = exportsCircuit(state);
      const { command: commandId, label } = circuit ? { command: 'circuit.export.fabrication', label: 'Gerbers' } : EXPORT_FORMATS[remembered];
      const Icon = command(commandId).icon;
      return { id, label: `Export ${label}`, icon: <Icon size={15} />, run: () => runCommand(commandId), available: availability(command(commandId), state) };
    }
    if (id.startsWith('command:')) {
      const commandId = id.slice('command:'.length);
      if (!exists(commandId)) return null;
      const found = command(commandId);
      const Icon = found.icon;
      return { id, label: found.label, icon: <Icon size={15} />, run: () => runCommand(commandId), available: availability(found, state), hint: found.shortcut };
    }
    if (id.startsWith('action:')) {
      const action = actions.find((item) => item.id === id.slice('action:'.length));
      if (!action) return null;
      return { id, label: `Run: ${action.title}`, icon: <Workflow size={15} />, run: () => runAction(action.id), available: true,
               hint: action.connector.online ? undefined : 'offline' };
    }
    return null;
  }
}

/** The items for these ids, kept current: the component re-renders only when one's availability changes. */
export function useQuickItems(ids: string[]): (id: string) => QuickItem | null {
  const remembered = useExportFormat((value) => value.format);
  const actions = useRunnableActions((value) => value.actions);
  useApp((state) => ids.map((id) => String(quickItem(id, state, remembered, actions)?.available ?? '')).join('|'));
  return (id: string) => quickItem(id, useApp.getState(), remembered, actions);
}

/** The quick button, or `fallback` (the plain export button) when it's automatic and there are no actions to run. */
export default function QuickButton({ fallback }: { fallback: ReactNode }) {
  useEffect(() => { watchRunnableActions(); }, []);
  const items = useSettings((state) => state.values['toolbar.quickItems']);
  const mainId = useSettings((state) => state.values['toolbar.quickMain']);
  const actions = useRunnableActions((state) => state.actions);
  const custom = items.length > 0;
  const itemOf = useQuickItems(custom ? items : ['command:app.runAction']);
  if (!custom && !actions.length) return <>{fallback}</>;
  const chosen = custom ? items.map(itemOf).filter((item): item is QuickItem => item !== null) : [];
  const main = custom
    ? (chosen.find((item) => item.id === mainId) ?? chosen[0] ?? null)
    : itemOf('command:app.runAction');
  if (!main) return <>{fallback}</>;
  const go = (item: QuickItem) => (item.available === true ? item.run() : toast('info', `Can’t ${item.label.toLowerCase()} now`, String(item.available)));
  return (
    <div className={styles.split} role="group" aria-label="Quick button" data-quick-button>
      <Tip label={main.label} reason={main.available === true ? undefined : main.available}>
        <Button id="quick-main" variant="secondary" icon={main.icon} aria-label={main.label} aria-disabled={main.available !== true}
                data-disabled={main.available !== true || undefined} className={styles.export} onClick={() => go(main)}>
          <span>{main.label.replace(/^Run: /, '').replace(/…$/, '')}</span>
        </Button>
      </Tip>
      <Menu>
        <MenuTrigger asChild>
          <Button id="export-menu" variant="secondary" aria-label="More" title="More" className={styles.splitToggle}><ChevronDown /></Button>
        </MenuTrigger>
        <MenuContent align="end">
          {custom ? chosen.map((item) => (
            <MenuItem key={item.id} icon={item.icon} disabled={item.available !== true} hint={item.hint} onSelect={item.run}>{item.label}</MenuItem>
          )) : (
            <>
              <ExportMenuItems />
              <MenuSeparator />
              <MenuLabel>Your connectors</MenuLabel>
              <MenuItem icon={<Workflow size={15} />} onSelect={() => runCommand('app.runAction')}>Run an action…</MenuItem>
              {actions.map((action) => (
                <MenuItem key={action.id} icon={<Workflow size={15} />} hint={action.connector.online ? undefined : 'offline'} onSelect={() => runAction(action.id)}>
                  Run: {action.title}
                </MenuItem>
              ))}
            </>
          )}
          <MenuSeparator />
          <MenuItem icon={<Settings2 size={15} />} onSelect={() => openSettings('quick-button')}>Customize this button…</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
