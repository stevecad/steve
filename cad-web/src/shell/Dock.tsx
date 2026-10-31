import { lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Code2, History, MessageSquare, MessageSquareText, PackagePlus, PanelRightClose, Plug, SlidersHorizontal } from 'lucide-react';
import { set, useApp, type AppState, type DockTab } from '@/state/store';
import Properties from '@/panels/Properties';
import Assistant from '@/panels/Assistant';
import FeaturePanel from '@/modeling/FeaturePanel';
import CommandPanels from '@/viewport/CommandPanels';
import SketchPanel from '@/sketch/SketchPanel';
import DrawingToolPanel from '@/drawing/ToolPanel';
import { useActiveTools } from './toolDock';
import { panelOfTab, panelTab, usePanels } from '@/connectors/panels';
import PanelFrame from '@/connectors/PanelFrame';
import { IconButton, Spinner } from '@/ui';
import { modKey } from '@/lib/format';
import styles from './Dock.module.css';

const SourcePanel = lazy(() => import('@/panels/SourcePanel'));
const SteveHistory = lazy(() => import('@/panels/SteveHistory'));
const Comments = lazy(() => import('@/panels/Comments'));
const PartsPanel = lazy(() => import('@/workspaces/electronics/palette/PartsPanel'));

/** A circuit open in Electronics: the Parts tab is there (parts are placed on its schematic). */
export const partsTabShown = (state: AppState) => state.workspace === 'electronics' && state.doc.open && state.doc.kind === 'circuit';

/** The dock's tabs; `visible` keeps a workspace's own tab to that workspace. */
const TABS: { id: DockTab; label: string; icon: typeof Code2; iconOnly?: boolean; visible?: (state: AppState) => boolean }[] = [
  { id: 'properties', label: 'Inspector', icon: SlidersHorizontal },
  { id: 'parts', label: 'Parts', icon: PackagePlus, visible: partsTabShown },
  { id: 'source', label: 'Source', icon: Code2 },
  { id: 'assistant', label: 'STEVE', icon: MessageSquare },
  { id: 'comments', label: 'Comments', icon: MessageSquareText, iconOnly: true, visible: () => false },
  { id: 'history', label: 'History', icon: History },
];

const Loading = () => <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Spinner /></div>;

export default function Dock() {
  const selected = useApp((state) => state.dockTab);
  const stale = useApp((state) => state.doc.open && state.error !== '');
  const shown = useApp((state) => TABS.filter((item) => !item.visible || item.visible(state)).map((item) => item.id).join(' '));
  const panels = usePanels((state) => state.panels).filter((panel) => panel.placement.includes('right'));
  const tabs: { id: DockTab; label: string; icon: typeof Code2; iconOnly?: boolean }[] = [...TABS.filter((item) => shown.split(' ').includes(item.id)),
    ...panels.map((panel) => ({ id: panelTab(panel.id), label: panel.title, icon: Plug }))];
  const tools = useActiveTools();
  // A tab that isn't here now (the tool ended, Parts outside Electronics, a panel removed) falls back to the Inspector.
  const tab = (selected === 'tool' && !tools.length) || (selected !== 'tool' && !tabs.some((item) => item.id === selected)) ? 'properties' : selected;
  const panel = panels.find((item) => item.id === panelOfTab(tab));
  const ToolIcon = tools[0]?.icon;
  return (
    <div className={styles.dock}>
      <div className={styles.tabs} role="tablist" aria-label="Inspector panels">
        <AnimatePresence initial={false}>
          {tools.length > 0 && ToolIcon && (
            <motion.button key="tool" type="button" role="tab" aria-selected={tab === 'tool'} data-tab="tool" className={`${styles.tab} ${styles.toolTab}`} data-active={tab === 'tool'}
              initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 'auto' }} exit={{ opacity: 0, width: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              onClick={() => set({ dockTab: 'tool' })} title={tools.map((t) => t.title).join(' · ')}>
              {tab === 'tool' && <motion.span layoutId="dock-tab" className={styles.tabThumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <ToolIcon size={14} strokeWidth={1.7} />
              <span>{tools[0].title}{tools.length > 1 ? ` +${tools.length - 1}` : ''}</span>
            </motion.button>
          )}
        </AnimatePresence>
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = item.id === tab;
          return (
            <button key={item.id} type="button" role="tab" aria-selected={active} data-tab={item.id} className={styles.tab} data-active={active} data-icon-only={item.iconOnly || undefined}
              aria-label={item.label} title={item.label} onClick={() => set({ dockTab: item.id })}>
              {active && <motion.span layoutId="dock-tab" className={styles.tabThumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <Icon size={14} strokeWidth={1.7} />
              {!item.iconOnly && <span>{item.label}</span>}
              {item.id === 'source' && stale && <span className={styles.errorDot} />}
            </button>
          );
        })}
        <IconButton small label="Hide panel" shortcut={`${modKey}+.`} className={styles.close} onClick={() => set({ dockOpen: false })}><PanelRightClose /></IconButton>
      </div>
      <div className={styles.body}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            className={styles.pane}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
          >
            {tab === 'properties' && <Properties />}
            {tab === 'parts' && <Suspense fallback={<Loading />}><PartsPanel /></Suspense>}
            {tab === 'source' && <Suspense fallback={<Loading />}><SourcePanel /></Suspense>}
            {tab === 'assistant' && <Assistant />}
            {tab === 'comments' && <Suspense fallback={<Loading />}><Comments /></Suspense>}
            {tab === 'history' && <Suspense fallback={<Loading />}><SteveHistory /></Suspense>}
            {tab === 'tool' && <div className={styles.tools}><SketchPanel /><FeaturePanel /><CommandPanels /><DrawingToolPanel /></div>}
            {panel && <PanelFrame panel={panel} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
