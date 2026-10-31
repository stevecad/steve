import { ChevronDown, Grid3x3, TriangleAlert } from 'lucide-react';
import { FitIcon, HiddenLineIcon, OrthoIcon, OriginIcon, PerspectiveIcon, ShadedEdgesIcon, ShadedIcon, ViewCubeIcon, WireframeIcon, XrayIcon } from '@/icons/cad';
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '@/ui';
import { set, useApp, type DisplayStyle, type StandardView } from '@/state/store';
import { viewer, VIEW_LABELS } from './viewer';
import styles from './Viewport.module.css';

const STYLES: { value: DisplayStyle; label: string; icon: typeof ShadedIcon; key?: string }[] = [
  { value: 'shaded-edges', label: 'Shaded with edges', icon: ShadedEdgesIcon },
  { value: 'shaded', label: 'Shaded', icon: ShadedIcon },
  { value: 'hidden-line', label: 'Hidden line', icon: HiddenLineIcon },
  { value: 'wireframe', label: 'Wireframe', icon: WireframeIcon },
  { value: 'xray', label: 'X-ray', icon: XrayIcon },
];
const VIEWS: { value: StandardView; key: string }[] = [
  { value: 'iso', key: '0' }, { value: 'front', key: '1' }, { value: 'back', key: '2' }, { value: 'left', key: '3' },
  { value: 'right', key: '4' }, { value: 'top', key: '5' }, { value: 'bottom', key: '6' },
];

const flipProjection = () => set((state) => ({ projection: state.projection === 'orthographic' ? 'perspective' : 'orthographic' }));

/** The nav bar's view tools: fit, standard views, display style and environment, projection. The app's NavBar and the
 *  share page both show these. */
export default function ViewTools({ toggleProjection = flipProjection }: { toggleProjection?: () => void }) {
  const style = useApp((state) => state.style);
  const projection = useApp((state) => state.projection);
  const grid = useApp((state) => state.showGrid);
  const origin = useApp((state) => state.showOrigin);
  const shadows = useApp((state) => state.showShadows);
  const collisions = useApp((state) => state.showCollisions);
  const current = STYLES.find((item) => item.value === style)!;
  const StyleIcon = current.icon;
  return (
    <>
      <IconButton label="Fit all" shortcut="F" onClick={() => viewer.fit()} id="fit"><FitIcon /></IconButton>
      <Menu>
        <Tip label="Standard views">
          <MenuTrigger asChild>
            <button type="button" className={styles.navMenu} aria-label="Standard views"><ViewCubeIcon size={16} /><ChevronDown size={10} /></button>
          </MenuTrigger>
        </Tip>
        <MenuContent side="top" align="center" sideOffset={10}>
          <MenuLabel>Standard views</MenuLabel>
          {VIEWS.map((view) => <MenuItem key={view.value} shortcut={view.key} onSelect={() => viewer.setView(view.value)}>{VIEW_LABELS[view.value]}</MenuItem>)}
        </MenuContent>
      </Menu>
      <span className={styles.navSep} />
      <Menu>
        <Tip label="Display style" shortcut="V">
          <MenuTrigger asChild>
            <button type="button" className={styles.navMenu} aria-label="Display style" data-testid="display-style"><StyleIcon size={16} /><ChevronDown size={10} /></button>
          </MenuTrigger>
        </Tip>
        <MenuContent side="top" align="center" sideOffset={10}>
          <MenuLabel>Visual style</MenuLabel>
          {STYLES.map((item) => { const Icon = item.icon; return <MenuItem key={item.value} icon={<Icon size={15} />} checked={item.value === style} onSelect={() => set({ style: item.value })}>{item.label}</MenuItem>; })}
          <MenuSeparator />
          <MenuLabel>Environment</MenuLabel>
          <MenuItem icon={<Grid3x3 size={15} />} checked={grid} shortcut={grid ? undefined : 'G'} onSelect={() => set({ showGrid: !grid })}>Ground grid</MenuItem>
          <MenuItem icon={<OriginIcon size={15} />} checked={origin} shortcut={origin ? undefined : 'O'} onSelect={() => set({ showOrigin: !origin })}>Origin planes</MenuItem>
          <MenuItem icon={<ShadedIcon size={15} />} checked={shadows} onSelect={() => set({ showShadows: !shadows })}>Ground shadow</MenuItem>
          <MenuItem icon={<TriangleAlert size={15} />} checked={collisions} onSelect={() => set({ showCollisions: !collisions })}>Collision highlights</MenuItem>
        </MenuContent>
      </Menu>
      <IconButton label={projection === 'orthographic' ? 'Orthographic' : 'Perspective'} description="Toggle between orthographic and perspective projection." shortcut="P" onClick={toggleProjection} active={projection === 'perspective'}>
        {projection === 'orthographic' ? <OrthoIcon /> : <PerspectiveIcon />}
      </IconButton>
    </>
  );
}
