import { Camera, Grid3x3, Presentation } from 'lucide-react';
import { MeasureIcon, SectionIcon } from '@/icons/cad';
import { IconButton } from '@/ui';
import { set, useApp } from '@/state/store';
import { runCommand, toggleSection, toggleTool } from '@/commands';
import SpaceMousePanel from './SpaceMousePanel';
import ViewTools from './ViewTools';
import styles from './Viewport.module.css';

/** Floating navigation and display bar, like the one at the bottom of desktop CAD viewports. */
export default function NavBar() {
  const grid = useApp((state) => state.showGrid);
  const section = useApp((state) => state.section.enabled);
  const measuring = useApp((state) => state.tool === 'measure');
  const hasModel = useApp((state) => !!state.displayed);
  return (
    <div className={styles.navbar} role="toolbar" aria-label="View tools" data-disabled={!hasModel || undefined}>
      <ViewTools toggleProjection={() => runCommand('view.projection')} />
      <span className={styles.navSep} />
      <IconButton label="Section analysis" shortcut="X" active={section} onClick={toggleSection} disabled={!hasModel}><SectionIcon /></IconButton>
      <IconButton label="Measure" shortcut="M" active={measuring} onClick={() => toggleTool('measure')} disabled={!hasModel}><MeasureIcon /></IconButton>
      <span className={styles.navSep} data-optional />
      <IconButton label="Ground grid" shortcut="G" active={grid} onClick={() => set({ showGrid: !grid })} id="grid" data-optional><Grid3x3 /></IconButton>
      <IconButton label="Capture image" onClick={() => runCommand('export.image')} disabled={!hasModel} data-optional><Camera /></IconButton>
      <IconButton label="Presentation view" description="Only the 3D view, full screen, with a player for the motion. Esc leaves it." shortcut="Shift+P"
        onClick={() => runCommand('view.present')} disabled={!hasModel} id="present-enter"><Presentation /></IconButton>
      <span className={styles.navSep} data-optional />
      <SpaceMousePanel />
    </div>
  );
}
