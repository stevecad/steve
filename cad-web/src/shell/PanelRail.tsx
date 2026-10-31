import { motion } from 'motion/react';
import { Code2, GitBranch, History, ListTree, MessageSquare, MessageSquareText, PackagePlus, PanelLeftOpen, PanelRightOpen, SlidersHorizontal } from 'lucide-react';
import { Tip } from '@/ui';
import { set, useApp, type AppState, type DockTab } from '@/state/store';
import { modKey } from '@/lib/format';
import styles from './PanelRail.module.css';

type LeftTab = 'model' | 'versions';

const LEFT: { id: LeftTab; label: string; description: string; icon: typeof ListTree }[] = [
  { id: 'model', label: 'Model browser', description: 'Bodies, sketches, features and construction.', icon: ListTree },
  { id: 'versions', label: 'Versions', description: 'Revisions, branches and merges.', icon: GitBranch },
];

const RIGHT: { id: DockTab; label: string; description: string; icon: typeof ListTree; visible?: (state: AppState) => boolean }[] = [
  { id: 'properties', label: 'Inspector', description: 'Properties of the selection or the active feature.', icon: SlidersHorizontal },
  { id: 'parts', label: 'Parts', description: 'Pick a part, then click in the schematic to place it.', icon: PackagePlus,
    visible: (state) => state.workspace === 'electronics' && state.doc.open && state.doc.kind === 'circuit' },
  { id: 'source', label: 'Source', description: 'The CadQuery Python behind this design.', icon: Code2 },
  { id: 'assistant', label: 'STEVE', description: 'Ask for a part or an edit.', icon: MessageSquare },
  { id: 'comments', label: 'Comments', description: 'Notes pinned to faces, edges and corners, for your AI agent.', icon: MessageSquareText },
  { id: 'history', label: 'History', description: 'Your conversations with STEVE.', icon: History },
];

const RAIL_WIDTH = 40;

/** The slim strip a collapsed side panel leaves behind: one click brings any of its tabs back. */
export default function PanelRail({ side, transition }: { side: 'left' | 'right'; transition: object }) {
  const leftTab = useApp((state) => state.leftTab);
  const dockTab = useApp((state) => state.dockTab);
  const branch = useApp((state) => state.doc.branch);
  const sourceError = useApp((state) => state.doc.open && state.error !== '');
  const left = side === 'left';
  const tipSide = left ? 'right' : 'left';
  const visibleRight = useApp((state) => RIGHT.filter((item) => !item.visible || item.visible(state)).map((item) => item.id).join(' '));
  const items = left ? LEFT : RIGHT.filter((item) => visibleRight.split(' ').includes(item.id));
  const last = left ? leftTab : dockTab;
  const open = (tab?: string) => (left
    ? set({ browserOpen: true, ...(tab ? { leftTab: tab as LeftTab } : {}) })
    : set({ dockOpen: true, ...(tab ? { dockTab: tab as DockTab } : {}) }));
  const Expand = left ? PanelLeftOpen : PanelRightOpen;
  return (
    <motion.nav
      className={styles.rail}
      data-side={side}
      aria-label={left ? 'Browser panels' : 'Inspector panels'}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: RAIL_WIDTH, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={transition}
    >
      <div className={styles.inner}>
        <Tip label="Show panel" shortcut={left ? `${modKey}+B` : `${modKey}+.`} side={tipSide}>
          <button type="button" className={styles.button} data-rail-open={side} aria-label="Show panel" onClick={() => open()}><Expand /></button>
        </Tip>
        <span className={styles.rule} />
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Tip key={item.id} label={item.label} description={item.description} side={tipSide}>
              <button type="button" className={styles.button} data-rail-tab={item.id} data-last={item.id === last || undefined} aria-label={item.label} onClick={() => open(item.id)}>
                <Icon />
                {item.id === 'versions' && branch !== 'main' && <span className={styles.badge} />}
                {item.id === 'source' && sourceError && <span className={styles.badge} data-tone="danger" />}
              </button>
            </Tip>
          );
        })}
      </div>
    </motion.nav>
  );
}
