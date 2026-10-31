import { AnimatePresence, motion } from 'motion/react';
import { ChevronsDownUp, GitBranch, ListTree, PanelLeftClose, Plug } from 'lucide-react';
import { IconButton } from '@/ui';
import { set, useApp } from '@/state/store';
import Browser, { collapseAll } from './Browser';
import VersionsPanel from '@/panels/versions/VersionsPanel';
import { modKey } from '@/lib/format';
import { panelOfTab, panelTab, usePanels } from '@/connectors/panels';
import PanelFrame from '@/connectors/PanelFrame';
import styles from './Dock.module.css';

const TABS: { id: 'model' | 'versions' | `panel:${string}`; label: string; icon: typeof ListTree }[] = [
  { id: 'model', label: 'Model', icon: ListTree },
  { id: 'versions', label: 'Versions', icon: GitBranch },
];

/** Left panel: the model browser and the version history, as tabs like the right dock. */
export default function LeftPanel() {
  const selected = useApp((state) => state.leftTab);
  const panels = usePanels((state) => state.panels).filter((panel) => panel.placement.includes('left'));
  const tabs = [...TABS, ...panels.map((panel) => ({ id: panelTab(panel.id), label: panel.title, icon: Plug }))];
  // A panel removed since: back to the model.
  const tab = tabs.some((item) => item.id === selected) ? selected : 'model';
  const panel = panels.find((item) => item.id === panelOfTab(tab));
  const branch = useApp((state) => state.doc.branch);
  return (
    <div className={styles.dock}>
      <div className={styles.tabs} role="tablist" aria-label="Browser panels">
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = item.id === tab;
          return (
            <button key={item.id} type="button" role="tab" aria-selected={active} data-tab={item.id} className={styles.tab} data-active={active} onClick={() => set({ leftTab: item.id })}>
              {active && <motion.span layoutId="left-tab" className={styles.tabThumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <Icon size={14} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === 'versions' && branch !== 'main' && <span className={styles.branchBadge}>{branch}</span>}
            </button>
          );
        })}
        <span className={styles.close}>
          {tab === 'model' && <IconButton small label="Collapse all" onClick={collapseAll}><ChevronsDownUp /></IconButton>}
          <IconButton small label="Hide panel" shortcut={`${modKey}+B`} onClick={() => set({ browserOpen: false })}><PanelLeftClose /></IconButton>
        </span>
      </div>
      <div className={styles.body}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} className={styles.pane} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
            {tab === 'model' ? <Browser /> : tab === 'versions' ? <VersionsPanel /> : panel ? <PanelFrame panel={panel} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
