/**
 * The phone's ribbon: five thumb-reach buttons under the model. Browser, View, one that follows the context (the open
 * tool's options; Play/Pause when the design moves; else the Inspector), STEVE, and Tools: the whole desktop ribbon
 * of the moment and every other command (CommandSheets.tsx). In landscape it stands on the right as a rail.
 */
import { Eye, LayoutGrid, ListTree, MessageSquare, MoreHorizontal, Pause, Play, SlidersHorizontal, X } from 'lucide-react';
import { availability, command, runCommand } from '@/commands';
import { set, useApp, type Pick } from '@/state/store';
import { useMotion } from '@/motion/state';
import { viewer } from '@/viewport/viewer';
import { describe } from '@/viewport/measure';
import { useActiveTools } from '@/shell/toolDock';
import { useCircuit } from '@/workspaces/electronics/state';
import { openSheet, usePhoneUi } from './state';
import styles from './Phone.module.css';

function BarButton({ label, icon, onClick, active, id, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; active?: boolean; id: string; disabled?: boolean }) {
  return (
    <button type="button" className={styles.barButton} id={id} data-active={active || undefined} aria-pressed={active} aria-disabled={disabled || undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Play when the design has a motor, an animation or an explode; the open tool otherwise wins the slot, else the Inspector. */
function Primary() {
  const tools = useActiveTools();
  const dockOpen = useApp((state) => state.dockOpen);
  const dockTab = useApp((state) => state.dockTab);
  const workspace = useApp((state) => state.workspace);
  const moves = useMotion((state) => !!(state.kinematics?.drives.length || state.kinematics?.animations?.length || state.kinematics?.explodes?.length));
  const playing = useMotion((state) => !!state.playing || !!state.clipStart);
  const canPlay = useApp((state) => moves && state.workspace === 'design' && availability(command('motion.play'), state) === true);
  if (tools.length) {
    const Icon = tools[0].icon;
    const open = dockOpen && dockTab === 'tool';
    return <BarButton id="phone-primary" label={tools[0].title} icon={<Icon size={22} strokeWidth={1.6} />} active={open} onClick={() => set(open ? { dockOpen: false } : { dockOpen: true, dockTab: 'tool' })} />;
  }
  if (canPlay) {
    return <BarButton id="phone-primary" label={playing ? 'Pause' : 'Play'} active={playing} icon={playing ? <Pause size={22} /> : <Play size={22} />} onClick={() => runCommand('motion.play')} />;
  }
  const open = dockOpen && dockTab === 'properties';
  return <BarButton id="phone-primary" label={workspace === 'simulate' ? 'Study' : 'Inspector'} active={open} icon={<SlidersHorizontal size={22} strokeWidth={1.6} />}
    onClick={() => set(open ? { dockOpen: false } : { dockOpen: true, dockTab: 'properties' })} />;
}

export default function PhoneActionBar() {
  const sheet = usePhoneUi((s) => s.sheet);
  const browser = useApp((state) => state.browserOpen && state.leftTab === 'model');
  const assistant = useApp((state) => state.dockOpen && state.dockTab === 'assistant');
  return (
    <nav className={styles.bar} aria-label="Phone toolbar" id="phone-bar">
      <BarButton id="phone-browser-button" label="Browser" active={browser} icon={<ListTree size={22} strokeWidth={1.6} />}
        onClick={() => set(browser ? { browserOpen: false } : { browserOpen: true, leftTab: 'model' })} />
      <BarButton id="phone-view-button" label="View" active={sheet === 'view'} icon={<Eye size={22} strokeWidth={1.6} />} onClick={() => openSheet(sheet === 'view' ? null : 'view')} />
      <Primary />
      <BarButton id="phone-steve-button" label="STEVE" active={assistant} icon={<MessageSquare size={22} strokeWidth={1.6} />} onClick={() => runCommand('create.assistant')} />
      <BarButton id="phone-tools-button" label="Tools" active={sheet === 'tools'} icon={<LayoutGrid size={22} strokeWidth={1.6} />} onClick={() => openSheet(sheet === 'tools' ? null : 'tools')} />
    </nav>
  );
}

function pickLabel(pick: Pick, tree: Record<string, { name: string }>) {
  if (pick.kind === 'component') return tree[pick.node]?.name ?? 'Component';
  try { return viewer.model ? describe(viewer.model, pick).title : pick.kind; } catch { return pick.kind; }
}

/**
 * What a tap selected, just above the bar while something is selected: its name, the Inspector for it, its context
 * menu (the long-press menu), and clear. Nothing shows while nothing is selected.
 */
export function SelectionChip() {
  const selection = useApp((state) => state.selection);
  const tree = useApp((state) => state.tree);
  const panelUp = useApp((state) => state.browserOpen || state.dockOpen || !!state.contextMenu);
  const sheetUp = !!usePhoneUi((s) => s.sheet) || panelUp;
  const circuitParts = useCircuit((state) => state.selection);
  if (sheetUp) return null;
  const label = selection.length ? (selection.length === 1 ? pickLabel(selection[0], tree) : `${selection.length} selected`)
    : circuitParts.length ? (circuitParts.length === 1 ? circuitParts[0] : `${circuitParts.length} parts selected`) : null;
  if (!label) return null;
  const menu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    set({ contextMenu: { x: Math.max(8, box.right - 240), y: Math.max(8, box.top - 260), pick: selection[0] ?? null } });
  };
  return (
    <div className={styles.chip} id="phone-selection" role="status">
      <span className={styles.chipLabel}>{label}</span>
      <button type="button" className={styles.chipButton} aria-label="Inspect selection" onClick={() => set({ dockOpen: true, dockTab: 'properties' })}><SlidersHorizontal size={18} /></button>
      {selection.length > 0 && <button type="button" className={styles.chipButton} aria-label="Selection actions" onClick={menu}><MoreHorizontal size={18} /></button>}
      <button type="button" className={styles.chipButton} aria-label="Clear selection" onClick={() => { set({ selection: [] }); useCircuit.setState({ selection: [] }); }}><X size={18} /></button>
    </div>
  );
}
