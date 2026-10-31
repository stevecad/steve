import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as THREE from 'three';
import { Code2, ExternalLink, Eye, EyeOff, Focus, Image as ImageIcon, Layers, ListTree, MessageSquareText, Palette, Pencil, ScanSearch } from 'lucide-react';
import { commentOnSelection } from '@/comments/comments';
import { ChamferIcon, CircularPatternIcon, FilletIcon, FitIcon, HoleIcon, MaterialIcon, MeasureIcon, MoveIcon, OriginIcon, SectionIcon, ShadedEdgesIcon, ShellIcon, SketchIcon, XrayIcon } from '@/icons/cad';
import { newSketch } from '@/sketch/actions';
import { openFeature } from '@/modeling/dialog';
import { get, isNodeSeeThrough, set, useApp, type EntityPick } from '@/state/store';
import { allOpaque, hideNodes, isolate, openFile, openPart, selectionNodes, showAll, toggleSeeThrough, zoomToSelection } from '@/state/actions';
import { bodiesOfPick, bodyIds } from '@/modeling/bodies';
import { componentOfNode } from '@/state/designRefs';
import { componentPath } from '@/state/design';
import { openAppearance, openMaterials } from '@/materials/actions';
import { isolateBody, toggleBody } from '@/workspaces/design/ItemMenu';
import { hasSource, showInSource } from '@/state/sourceOf';
import { revealInTree, treeTarget } from '@/shell/revealInTree';
import { viewer } from './viewer';
import { addMeasurePick } from './measure';
import ui from '@/ui/ui.module.css';
import styles from './Viewport.module.css';

interface Item { label: string; icon: React.ReactNode; run: () => void; shortcut?: string; disabled?: boolean }

function sectionThroughFace(pick: EntityPick) {
  const model = viewer.model;
  const face = model?.topologyFor(pick.mesh)?.faces[pick.index];
  const frame = model?.frameFor(pick.node, pick.mesh);
  if (!model || !face?.normal || !face.origin || !frame) return;
  const normal = new THREE.Vector3(...face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(frame.matrixWorld)).normalize();
  const axisIndex = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)].reduce((best, value, index, all) => (value > all[best] ? index : best), 0);
  if (Math.abs(normal.getComponent(axisIndex)) < 0.999) return;
  const point = new THREE.Vector3(...face.origin).applyMatrix4(frame.matrixWorld);
  const box = model.bounds(false);
  const min = box.min.getComponent(axisIndex), max = box.max.getComponent(axisIndex);
  const offset = THREE.MathUtils.clamp((point.getComponent(axisIndex) - min) / Math.max(max - min, 1e-9), 0, 1);
  set({ section: { enabled: true, axis: (['x', 'y', 'z'] as const)[axisIndex], offset: Math.min(Math.max(offset, 0.001), 0.999), flip: normal.getComponent(axisIndex) < 0 } });
}

export default function ContextMenu() {
  const menu = useApp((state) => state.contextMenu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) set({ contextMenu: null }); };
    const timer = setTimeout(() => window.addEventListener('pointerdown', close), 0);
    return () => { clearTimeout(timer); window.removeEventListener('pointerdown', close); };
  }, [menu]);

  const items: (Item | 'sep')[] = [];
  if (menu) {
    const state = get();
    const nodes = selectionNodes(state.selection);
    const pick = menu.pick;
    const documentId = pick ? state.tree[pick.node]?.documentId : undefined;
    items.push({ label: 'Zoom to selection', icon: <ScanSearch size={15} />, shortcut: 'Z', run: zoomToSelection, disabled: !state.selection.length });
    items.push({ label: 'Fit all', icon: <FitIcon size={15} />, shortcut: 'F', run: () => viewer.fit() });
    if (pick && (pick.kind === 'face' || pick.kind === 'edge') && state.doc.open && hasSource(pick)) {
      items.push({ label: 'Show in source', icon: <Code2 size={15} />, run: () => showInSource(pick) });
    }
    if (pick && treeTarget(pick)) items.push({ label: 'Show in tree', icon: <ListTree size={15} />, run: () => revealInTree(pick) });
    // Deep selection: what lies behind it too (on the desktop, pressing and holding on the model opens the same list).
    if (pick && menu.onModel) items.push({ label: 'Select other…', icon: <Layers size={15} />, run: () => { viewer.openPickList(menu.x, menu.y); } });
    items.push('sep');
    if (nodes.length && state.displayed?.kind === 'design') {
      items.push({ label: 'Isolate', icon: <Focus size={15} />, shortcut: 'I', run: () => isolate(nodes) });
      items.push({ label: 'Hide', icon: <EyeOff size={15} />, shortcut: 'H', run: () => { hideNodes(nodes); set({ selection: [] }); } });
      // See-through works on whole placed components, the same as the browser's button next to their eye.
      const placed = [...new Set(nodes.map((id) => viewer.model?.instanceNode(id) ?? id))];
      const seeThrough = placed.every((id) => isNodeSeeThrough(state.tree, id));
      items.push({ label: seeThrough ? 'Make opaque' : 'Make see-through', icon: seeThrough ? <ShadedEdgesIcon size={15} /> : <XrayIcon size={15} />, run: () => toggleSeeThrough(placed) });
      // The same as the tree's component menu: open the component's file to model in it.
      const component = pick ? componentOfNode(pick.node) : null;
      if (component && !documentId && state.doc.activeFile !== componentPath(component)) items.push({ label: 'Edit component', icon: <Pencil size={15} />, run: () => openFile(componentPath(component)) });
    }
    // A part's body under the cursor: what the tree's body menu offers for it.
    const body = pick && pick.kind !== 'component' && state.doc.kind === 'part' && state.modeling?.canonical ? bodiesOfPick(pick)[0] : undefined;
    if (body) {
      items.push({ label: 'Hide body', icon: <EyeOff size={15} />, run: () => toggleBody(body) });
      if (bodyIds(state.displayed).length > 1) items.push({ label: 'Isolate body', icon: <Focus size={15} />, run: () => isolateBody(body) });
      items.push({ label: 'Material…', icon: <MaterialIcon size={15} />, disabled: state.busy, run: () => openMaterials([body]) });
      items.push({ label: 'Appearance…', icon: <Palette size={15} />, disabled: state.busy, run: () => openAppearance([body]) });
    }
    items.push({ label: 'Show all', icon: <Eye size={15} />, shortcut: 'Shift+H', run: showAll, disabled: !Object.values(state.tree).some((node) => node.hidden) && !state.hiddenBodies.length });
    if (Object.values(state.tree).some((node) => node.seeThrough)) items.push({ label: 'Make all opaque', icon: <ShadedEdgesIcon size={15} />, run: allOpaque });
    const part = state.doc.open && state.doc.kind === 'part';
    const planar = pick?.kind === 'face' && viewer.model?.topologyFor(pick.mesh)?.faces[pick.index]?.type === 'plane';
    if (part && pick?.kind === 'face') {
      // Modeling on what's under the cursor; the command opens pre-filled with it.
      items.push('sep');
      if (planar) items.push({ label: 'Sketch on this face', icon: <SketchIcon size={15} />, shortcut: 'Shift+S', run: () => newSketch() });
      if (planar) items.push({ label: 'Hole on this face…', icon: <HoleIcon size={15} />, run: () => { void openFeature('hole'); } });
      items.push({ label: 'Fillet its edges…', icon: <FilletIcon size={15} />, run: () => { void openFeature('fillet'); } });
      if (planar) items.push({ label: 'Offset plane from here…', icon: <OriginIcon size={15} />, run: () => { void openFeature('plane'); } });
      items.push({ label: 'Decal on this face…', icon: <ImageIcon size={15} />, run: () => { void openFeature('decal'); } });
      items.push({ label: 'Shell, opening this face…', icon: <ShellIcon size={15} />, run: () => { void openFeature('shell'); } });
      items.push({ label: 'Move/Copy body…', icon: <MoveIcon size={15} />, shortcut: 'Shift+M', run: () => { void openFeature('move'); } });
    }
    if (part && pick?.kind === 'component') {
      items.push('sep');
      items.push({ label: 'Move/Copy…', icon: <MoveIcon size={15} />, shortcut: 'Shift+M', run: () => { void openFeature('move'); } });
    }
    if (part && pick?.kind === 'edge') {
      items.push('sep');
      items.push({ label: 'Fillet…', icon: <FilletIcon size={15} />, shortcut: 'Shift+F', run: () => { void openFeature('fillet'); } });
      items.push({ label: 'Chamfer…', icon: <ChamferIcon size={15} />, run: () => { void openFeature('chamfer'); } });
      items.push({ label: 'Pattern around this edge…', icon: <CircularPatternIcon size={15} />, run: () => { void openFeature('circular_pattern'); } });
    }
    if (pick && pick.kind !== 'component') {
      items.push('sep');
      items.push({ label: 'Measure from here', icon: <MeasureIcon size={15} />, run: () => { set({ tool: 'measure', measurePicks: [] }); addMeasurePick(pick); } });
      if (pick.kind === 'face' && viewer.model?.topologyFor(pick.mesh)?.faces[pick.index]?.type === 'plane') {
        items.push({ label: 'Section at this face', icon: <SectionIcon size={15} />, run: () => sectionThroughFace(pick) });
      }
    }
    if (state.doc.open && state.doc.saved && state.selection.length) {
      items.push('sep');
      items.push({ label: 'Comment on selection…', icon: <MessageSquareText size={15} />, run: commentOnSelection });
    }
    if (documentId) {
      items.push('sep');
      items.push({ label: 'Open part document', icon: <ExternalLink size={15} />, run: () => openPart(documentId) });
    }
  }

  const x = menu ? Math.min(menu.x, window.innerWidth - 240) : 0;
  const y = menu ? Math.min(menu.y, window.innerHeight - 40 - items.length * 31) : 0;

  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          className={`${ui.menu} ${styles.contextMenu}`}
          role="menu"
          style={{ left: x, top: y }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        >
          {items.map((item, index) => item === 'sep' ? <div key={index} className={ui.menuSeparator} /> : (
            <button key={item.label} type="button" role="menuitem" className={ui.menuItem} data-disabled={item.disabled || undefined} disabled={item.disabled} onClick={() => { set({ contextMenu: null }); item.run(); }} style={{ width: '100%' }}>
              {item.icon}<span>{item.label}</span>
              {item.shortcut && <span className={ui.menuShortcut}>{item.shortcut.split('+').map((key) => <kbd key={key}>{key}</kbd>)}</span>}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
