/**
 * The phone shell: the model gets the screen. A slim top bar says what's open; five buttons under the
 * model reach everything else in sheets: the panels, the view, the open tool or Play, STEVE, and Tools (the desktop
 * ribbon and every command). It mounts the same Viewport, panels, dialogs and stores as the desktop shell
 * (shell/App.tsx), which still boots the app; only the chrome is different.
 */
import { useEffect } from 'react';
import { useApp, set } from '@/state/store';
import Viewport from '@/viewport/Viewport';
import AnimationStrip from '@/motion/AnimationStrip';
import { useMotion } from '@/motion/state';
import { toggleExplode } from '@/commands';
import Toasts from '@/shell/Toasts';
import Dialogs from '@/dialogs/Dialogs';
import ErrorBoundary from '@/ui/ErrorBoundary';
import PhoneTopBar, { DocumentSheet, MoreSheet, WorkspaceSheet } from './PhoneTopBar';
import PhoneActionBar, { SelectionChip } from './PhoneActionBar';
import PanelSheet from './PanelSheet';
import ExplodeStrip from './ExplodeStrip';
import { ToolsSheet, ViewSheet } from './CommandSheets';
import { installSheetFollow } from './state';
import { installLongPress } from './longPress';
import './phone.css';
import styles from './Phone.module.css';

export default function PhoneShell() {
  const workspace = useApp((state) => state.workspace);
  // The motion timeline only once there's an animation or explode to scrub; the Play button covers motors.
  const animations = useMotion((state) => (state.kinematics?.animations?.length ?? 0) + (state.kinematics?.explodes?.length ?? 0) > 0);
  // The exploded view is a strip under the model, not a sheet: opening and closing it leaves the panels as they were.
  const exploding = useApp((state) => !!state.displayed && state.tool === 'explode');
  const explode = useApp((state) => state.explode);
  useEffect(() => {
    // Boot opens panels for wide windows (a landscape phone is wider than the desktop's 900 px drawer limit): start on the model.
    set({ browserOpen: false, dockOpen: false });
    const unfollow = installSheetFollow();
    const viewport = document.getElementById('viewport');
    const unpress = viewport ? installLongPress(viewport) : () => {};
    return () => { unfollow(); unpress(); };
  }, []);
  return (
    <div className={styles.shell} data-workspace={workspace} data-phone-shell>
      <PhoneTopBar />
      <main className={styles.main}>
        <ErrorBoundary name="Viewport"><Viewport /></ErrorBoundary>
        {animations && <ErrorBoundary name="Animation"><AnimationStrip /></ErrorBoundary>}
        {exploding && <ExplodeStrip id="phone-explode" value={explode} max={1.5} onChange={(value) => set({ explode: value })} onClose={toggleExplode} />}
        <SelectionChip />
      </main>
      <PhoneActionBar />
      <PanelSheet />
      <ToolsSheet />
      <ViewSheet />
      <DocumentSheet />
      <WorkspaceSheet />
      <MoreSheet />
      <Toasts />
      <Dialogs />
    </div>
  );
}
