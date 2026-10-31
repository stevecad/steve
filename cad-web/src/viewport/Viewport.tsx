import { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './Scene';
import { CANVAS_PROPS } from './SceneCore';
import ViewCube from './ViewCube';
import Triad from './Triad';
import NavBar from './NavBar';
import MotionHud from '@/motion/MotionHud';
import { SceneAnimationOverlay } from '@/motion/SceneAnimationStrip';
import ResultsOverlay from '@/workspaces/simulate/ResultsOverlay';
import PlayerOverlay from '@/workspaces/manufacture/cam/PlayerOverlay';
import ContextMenu from './ContextMenu';
import PickList from './PickList';
import HoverTip from './HoverTip';
import WorkspaceHud from '@/workspaces/WorkspaceHud';
import ElectronicsViews from '@/workspaces/electronics/ElectronicsViews';
import { useCircuit } from '@/workspaces/electronics/state';
import { FlatOverlay } from '@/workspaces/sheetmetal/SheetPanels';
import { EmptyState, PastVersionBanner, Progress, ReadOnlyBanner, SelectionPrepPill, StalePill, ViewLabel } from './Hud';
import { useApp, viewportTheme } from '@/state/store';
import { usePresent } from '@/present/state';
import PresentationBar from '@/present/PresentationBar';
import styles from './Viewport.module.css';

export default function Viewport() {
  const tool = useApp((state) => state.tool);
  // Electronics shows its own flat views (schematic, board) over the 3D canvas; the 3D view is the canvas itself.
  const electronics = useApp((state) => state.workspace === 'electronics');
  const circuit = useApp((state) => state.doc.open && state.doc.kind === 'circuit');
  const flat = useCircuit((state) => state.view !== '3d');
  const hide3d = electronics && (!circuit || flat);
  const presenting = usePresent((state) => state.active);
  const asleep = usePresent((state) => !state.awake);
  const cube = usePresent((state) => state.cube);
  const triad = usePresent((state) => state.triad);
  // The backdrop's colours (styles/tokens.css --vp-top/--vp-bottom) follow Settings → Display › Background; on the root,
  // so screenshots and videos (panels/attachments.tsx, present/video/render.ts) read the same ones.
  const backdrop = useApp(viewportTheme);
  useEffect(() => {
    document.documentElement.dataset.viewport = backdrop;
    return () => { delete document.documentElement.dataset.viewport; };
  }, [backdrop]);
  return (
    <div className={styles.viewport} id="viewport" data-tool={tool} data-electronics={electronics || undefined}
      data-presenting={presenting || undefined} data-asleep={(presenting && asleep) || undefined}>
      <div className={styles.backdrop} />
      <Canvas className={styles.canvas} {...CANVAS_PROPS}>
        <Scene />
      </Canvas>
      <div className={styles.vignette} />
      {/* Presentation view: the canvas alone, with the player and, when asked for, the view cube and triad. */}
      {presenting ? <>{cube && <ViewCube />}{triad && <Triad />}<PresentationBar /></> : <Overlays hide3d={hide3d} electronics={electronics} circuit={circuit} />}
    </div>
  );
}

function Overlays({ hide3d, electronics, circuit }: { hide3d: boolean; electronics: boolean; circuit: boolean }) {
  return (
    <>
      {!hide3d && <ViewLabel />}
      <StalePill />
      <SelectionPrepPill />
      <PastVersionBanner />
      <ReadOnlyBanner />
      <Progress />
      {!hide3d && <><ViewCube /><Triad /><NavBar /></>}
      <WorkspaceHud />
      <ResultsOverlay />
      <PlayerOverlay />
      <MotionHud />
      <SceneAnimationOverlay />
      <FlatOverlay />
      {!electronics && !circuit && <EmptyState />}
      <ElectronicsViews />
      <HoverTip />
      <ContextMenu />
      <PickList />
    </>
  );
}
