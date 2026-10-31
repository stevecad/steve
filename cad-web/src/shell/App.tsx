import { lazy, Suspense, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { TooltipProvider } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { boot } from '@/state/actions';
import { startLocalDesktop } from '@/localDesktop';
import { installTabs, restoreTabs, resumeActiveTab } from '@/state/tabs';
import { rememberPanels, restorePanelPreference } from '@/state/panels';
import { installModelingSync } from '@/modeling/sync';
import { installToolDock, useActiveTools } from './toolDock';
import { installLinkWatch } from '@/state/linkWatch';
import { installDocumentWatch } from '@/state/documentWatch';
import { installCommentWatch } from '@/comments/comments';
import { installSelectionPrep } from '@/viewport/selectionPrep';
import { installUpdateWatch } from '@/state/updateWatch';
import { installReportWatch } from '@/feedback/feedback';
import { installDesignTabFollow } from '@/state/designTab';
import { installCircuitSync } from '@/workspaces/electronics/state';
import { installRouting } from '@/workspaces/electronics/routing';
import { escapeWiring } from '@/workspaces/electronics/schematicEdits';
import { useSketch } from '@/sketch/session';
import * as sketchTools from '@/sketch/tools';
import { handleShortcut, installFullscreenSync, toggleExplode } from '@/commands';
import { installTheme } from '@/state/theme';
import { loadToolLibrary } from '@/state/workspaceData';
import { initSpaceMouse } from '@/viewport/spacemouse';
import { DEFAULT_TOOLS } from '@/workspaces/manufacture/tools';
import TopBar from './TopBar';
import Ribbon from './Ribbon';
import LeftPanel from './LeftPanel';
import Dock from './Dock';
import StatusBar from './StatusBar';
import Resizer from './Resizer';
import PanelRail from './PanelRail';
import Toasts from './Toasts';
import UpdateNotice from './UpdateNotice';
import Viewport from '@/viewport/Viewport';
import Timeline from '@/workspaces/design/Timeline';
import AnimationStrip from '@/motion/AnimationStrip';
import SceneAnimationStrip from '@/motion/SceneAnimationStrip';
import DrawingTab from '@/drawing/DrawingTab';
import { useFeatureSync } from '@/workspaces/design/FeatureTree';
import { useBranchSync } from './BranchSwitcher';
import Dialogs from '@/dialogs/Dialogs';
import ErrorBoundary from '@/ui/ErrorBoundary';
import styles from './App.module.css';
import { fromPopup, handleToolKeys } from './ToolFooter';
import { isPhone } from '@/phone/detect';
import OAuthConsent from './OAuthConsent';  // An OAuth app's consent dialog (app/oauth_api.py), when one is pending.
import InvitationDialog from '@/teams/InvitationDialog';  // A team invitation link opened (teams/invite.ts).
import CopyDialog from '@/teams/CopyDialog';  // Copy or move the open document to another workspace (File → Copy to…).
import { watchPanels } from '@/connectors/panels';
import { installPresentationSync, presenting } from '@/present/state';
import { handlePresentationKey } from '@/present/keys';

/** Loaded only on phones, so tablets and desktops don't download it. */
const PhoneShell = lazy(() => import('@/phone/PhoneShell'));

let booted = false;


export default function App() {
  const workspace = useApp((state) => state.workspace);
  const browserOpen = useApp((state) => state.browserOpen);
  const dockOpen = useApp((state) => state.dockOpen);
  const browserWidth = useApp((state) => state.browserWidth);
  const dockWidth = useApp((state) => state.dockWidth);
  const resizing = useApp((state) => state.resizing);
  const tools = useActiveTools();
  useFeatureSync();
  useBranchSync();
  const panelTransition = resizing ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 42 };

  useEffect(() => {
    installTheme();
    loadToolLibrary(DEFAULT_TOOLS);
    initSpaceMouse();
    if (!booted) { booted = true; restorePanelPreference(); rememberPanels(); restoreTabs(); installTabs(); installModelingSync(); installToolDock(); installLinkWatch(); installDocumentWatch(); watchPanels(); installUpdateWatch(); installReportWatch(); installCommentWatch(); installSelectionPrep(); installDesignTabFollow(); installCircuitSync(); installRouting(); void boot(resumeActiveTab).then(startLocalDesktop); }
    const onKey = (event: KeyboardEvent) => {
      if (fromPopup(event)) return;  // A dropdown's own keys (its Esc closes just it).
      if (presenting() && handlePresentationKey(event)) return;
      const typing = (event.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable], .cm-editor');
      if (useSketch.getState().active && !typing && !get().dialog) {
        if (event.key === 'Escape') { event.preventDefault(); sketchTools.escape(); return; }
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); sketchTools.enter(); return; }
      }
      if (useSketch.getState().choosing && event.key === 'Escape') { useSketch.setState({ choosing: false }); return; }
      // The open tool's footer: Enter is OK, Esc is Cancel (ToolFooter).
      if (!get().dialog && !get().contextMenu && !get().pickList && handleToolKeys(event)) return;
      // The schematic's Wire tool: Esc drops a half-drawn wire, then the tool.
      if (event.key === 'Escape' && !typing && !get().dialog && escapeWiring()) { event.preventDefault(); return; }
      if (event.key === 'Escape' && !get().dialog) {
        const state = get();
        if (state.contextMenu) set({ contextMenu: null });
        else if (state.pickList) set({ pickList: null, hover: null });
        else if (state.tool === 'explode') toggleExplode();
        else if (state.tool !== 'select') set({ tool: 'select', measurePicks: [] });
        else if (state.section.enabled) set({ section: { ...state.section, enabled: false } });
        else set({ selection: [] });
        return;
      }
      handleShortcut(event);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = get();
      if (state.doc.open && state.doc.savedSnapshot !== null && state.busy) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    const uninstallFullscreen = installFullscreenSync();
    const uninstallPresentation = installPresentationSync();
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onBeforeUnload); uninstallFullscreen(); uninstallPresentation(); };
  }, []);

  // Phones get their own shell over the same app (phone/detect.ts); tablets and desktops keep this one.
  if (isPhone()) return <TooltipProvider><Suspense fallback={null}><PhoneShell /><OAuthConsent /><InvitationDialog /></Suspense></TooltipProvider>;

  return (
    <TooltipProvider>
      <div className={styles.app} data-workspace={workspace}>
        <TopBar />
        <div><UpdateNotice /></div>
        <OAuthConsent />
        <InvitationDialog />
        <CopyDialog />
        <ErrorBoundary name="Ribbon"><Ribbon /></ErrorBoundary>
        <main className={styles.main}>
          {/* Phone width only (CSS): a tap beside an open drawer closes it. Not while a tool's options are open, whose picks are on the canvas. */}
          {(browserOpen || (dockOpen && !tools.length)) && <div className={styles.scrim} aria-hidden onClick={() => set({ browserOpen: false, ...(tools.length ? {} : { dockOpen: false }) })} />}
          <AnimatePresence initial={false}>
            {browserOpen ? (
              <motion.aside
                key="browser"
                className={styles.sidePanel}
                style={{ width: browserWidth }}
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: browserWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={panelTransition}
              >
                <div className={styles.sideInner} style={{ width: browserWidth }}><ErrorBoundary name="Browser"><LeftPanel /></ErrorBoundary></div>
                <Resizer side="left" />
              </motion.aside>
            ) : <PanelRail key="browser-rail" side="left" transition={panelTransition} />}
          </AnimatePresence>
          <section className={styles.center}><ErrorBoundary name="Viewport"><Viewport /></ErrorBoundary><ErrorBoundary name="Timeline"><Timeline /></ErrorBoundary><ErrorBoundary name="Animation"><AnimationStrip /></ErrorBoundary><ErrorBoundary name="Scene animation"><SceneAnimationStrip /></ErrorBoundary><ErrorBoundary name="Drawing"><DrawingTab /></ErrorBoundary></section>
          <AnimatePresence initial={false}>
            {dockOpen ? (
              <motion.aside
                key="dock"
                className={`${styles.sidePanel} ${styles.dockPanel}`}
                style={{ width: dockWidth }}
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: dockWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={panelTransition}
              >
                <Resizer side="right" />
                <div className={styles.sideInner} style={{ width: dockWidth }}><ErrorBoundary name="Inspector"><Dock /></ErrorBoundary></div>
              </motion.aside>
            ) : <PanelRail key="dock-rail" side="right" transition={panelTransition} />}
          </AnimatePresence>
        </main>
        <StatusBar />
        <Toasts />
        <Dialogs />
      </div>
    </TooltipProvider>
  );
}
