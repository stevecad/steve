import { type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Box, Boxes, Component, ExternalLink, Eye, EyeOff, Layers } from 'lucide-react';
import { CircuitIcon, OriginIcon, ShadedEdgesIcon, XrayIcon } from '@/icons/cad';

import { get, isNodeSeeThrough, isNodeVisible, samePick, set, useApp, type Pick, type TreeNode } from '@/state/store';
import { toggleExpanded, toggleHidden, toggleSeeThrough } from '@/state/actions';
import { useGroupOpen } from '@/state/treeOpen';
import { viewer } from '@/viewport/viewer';
import TreeRow from './TreeRow';
import StudyTree from '@/workspaces/simulate/StudyTree';
import SetupTree from '@/workspaces/manufacture/SetupTree';
import ModelStructure from '@/workspaces/design/ModelStructure';
import { ItemMenu, RenameField, itemKeyDown, startRename, useEditing, type ItemTarget } from '@/workspaces/design/ItemMenu';
import CircuitTree from '@/workspaces/electronics/CircuitTree';
import DrawingTree from '@/drawing/DrawingTree';
import { drawingShown } from '@/state/designTab';
import styles from './Browser.module.css';

/** A group's label folds it, unless the group gives it its own `onClick` (then only the chevron folds). */
export function BrowserGroup({ title, icon, children, actions, defaultOpen = true, count, depth = 0, menu, item, onClick, selected, tooltip }: { title: string; icon: ReactNode; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean; count?: number; depth?: number; menu?: ReactNode; item?: string; onClick?: () => void; selected?: boolean; tooltip?: string }) {
  // Remembered per document under its item handle, so it stays as left when the browser is drawn again.
  const [open, setOpen] = useGroupOpen(item, defaultOpen);
  return (
    <div className={styles.group}>
      <TreeRow depth={depth} icon={icon} label={<span className={styles.groupLabel}>{title}</span>} meta={count !== undefined ? count : undefined} expanded={open} onToggle={() => setOpen(!open)} onClick={onClick ?? (() => setOpen(!open))} selected={selected} title={tooltip} actions={actions} menu={menu} item={item} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function selectNode(id: string, additive: boolean) {
  const pick: Pick = { kind: 'component', node: id };
  const { selection, tree } = get();
  if (tree[id]?.type === 'document') { set({ selection: [] }); return; }
  if (additive) {
    const exists = selection.some((item) => samePick(item, pick));
    set({ selection: exists ? selection.filter((item) => !samePick(item, pick)) : [...selection, pick] });
  } else set({ selection: [pick] });
}

export function NodeRow({ id, depth, hideChildren }: { id: string; depth: number; hideChildren?: boolean }) {
  const node = useApp((state) => state.tree[id]) as TreeNode | undefined;
  const visible = useApp((state) => isNodeVisible(state.tree, id));
  const selected = useApp((state) => state.selection.some((pick) => pick.kind === 'component' && pick.node === id));
  const partial = useApp((state) => state.selection.some((pick) => pick.kind !== 'component' && pick.node === id));
  const kind = useApp((state) => state.doc.kind);
  const docName = useApp((state) => state.doc.name);
  const editing = useEditing(node?.type === 'document' ? 'document' : null);
  // A circuit board placed in a design (a circuit link): drawn with the chip glyph, like the link itself.
  const circuitBoard = useApp((state) => !!node?.documentId && Object.entries(state.doc.links).some(([alias, link]) =>
    link.document_id === node.documentId && state.doc.saved?.link_status?.[alias]?.kind === 'circuit'));
  if (!node) return null;
  const isDocument = node.type === 'document';
  // Part documents: the document and its bodies get the browser's menus; a design's placed components keep the viewport's.
  const target: ItemTarget | null = isDocument ? { kind: 'document' } : kind === 'part' ? { kind: 'node', id } : null;
  const Icon = circuitBoard ? CircuitIcon as unknown as typeof Box : node.type === 'assembly' || (isDocument && kind === 'design') ? Boxes : node.type === 'body' ? Box : isDocument ? Box : Component;
  const hasChildren = node.children.length > 0 && !hideChildren;
  return (
    <>
      <TreeRow
        depth={depth}
        testId={node.name}
        icon={<span className={styles.nodeIcon} style={{ color: node.color && node.type !== 'body' && !isDocument ? node.color : undefined }}><Icon size={15} strokeWidth={1.6} /></span>}
        label={isDocument ? docName : node.name}
        meta={node.documentId ? <ExternalLink size={11} /> : undefined}
        item={isDocument ? 'document' : `node:${id}`}
        menu={target ? <ItemMenu target={target} /> : undefined}
        editor={editing ? <RenameField editKey={editing} /> : undefined}
        onKeyDown={target ? (event) => itemKeyDown(event, target) : undefined}
        title={node.documentId ? `${node.name} · ${circuitBoard ? 'a linked circuit board' : 'references a saved part'}` : node.name}
        expanded={node.expanded}
        onToggle={hasChildren ? () => toggleExpanded(id) : undefined}
        selected={selected}
        partial={partial}
        dimmed={!visible}
        onClick={(event) => selectNode(id, event.shiftKey || event.ctrlKey || event.metaKey)}
        onDoubleClick={() => { if (isDocument) { startRename({ kind: 'document' }); return; } const box = viewer.model?.bounds(true, id); if (box) viewer.zoomTo(box); }}
        onHover={(hovering) => { if (!isDocument) set({ hover: hovering ? { kind: 'component', node: id } : null }); }}
        onContextMenu={(event) => { if (!isDocument) { if (!selected) selectNode(id, false); set({ contextMenu: { x: event.clientX, y: event.clientY, pick: { kind: 'component', node: id } } }); } }}
        onContextSelect={isDocument ? undefined : () => selectNode(id, false)}
        actions={!isDocument && (<>
          {kind === 'design' && visible && <SeeThroughButton nodes={[id]} name={node.name} handle={{ 'data-node-transparency': id }} />}
          <button type="button" className={styles.eye} data-hidden={!visible || undefined} aria-label={`${visible ? 'Hide' : 'Show'} ${node.name}`} aria-pressed={visible} onClick={() => toggleHidden(id)}>
            {visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </>)}
      />
      <AnimatePresence initial={false}>
        {hasChildren && node.expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            {node.children.map((child) => <NodeRow key={child} id={child} depth={depth + 1} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Next to a component's eye while it shows: draws its placed nodes see-through (in their own colours) or solid again. */
export function SeeThroughButton({ nodes, name, handle }: { nodes: string[]; name: string; handle?: Record<`data-${string}`, string> }) {
  const on = useApp((state) => nodes.length > 0 && nodes.every((id) => isNodeSeeThrough(state.tree, id)));
  return (
    <button type="button" className={styles.eye} data-see-through={on || undefined} {...handle} aria-pressed={on}
      aria-label={`Make ${name} ${on ? 'opaque' : 'see-through'}`} title={on ? `${name} is see-through: click to make it opaque` : `Make ${name} see-through`}
      onClick={(event) => { event.stopPropagation(); toggleSeeThrough(nodes); }}>
      {on ? <XrayIcon size={13} /> : <ShadedEdgesIcon size={13} />}
    </button>
  );
}

function OriginGroup({ depth = 0 }: { depth?: number }) {
  const show = useApp((state) => state.showOrigin);
  const toggle = () => set({ showOrigin: !show });
  const eye = (
    <button type="button" className={styles.eye} data-hidden={!show || undefined} aria-label={show ? 'Hide origin' : 'Show origin'} onClick={toggle}>
      {show ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
  return (
    <BrowserGroup title="Origin" icon={<OriginIcon size={15} />} defaultOpen={false} actions={eye} depth={depth} menu={<ItemMenu target={{ kind: 'origin' }} />} item="origin">
      {([['XY', '#5aa9ff'], ['XZ', '#7ed47c'], ['YZ', '#ff6b6b']] as const).map(([plane, color]) => (
        <TreeRow key={plane} depth={depth + 1} icon={<span className={styles.planeSwatch} style={{ borderColor: color, background: `${color}22` }} />} label={`${plane} plane`} dimmed={!show} onClick={toggle}
          item={`origin:${plane}`} menu={<ItemMenu target={{ kind: 'origin-plane', plane }} />} onKeyDown={(event) => itemKeyDown(event, { kind: 'origin-plane', plane })} />
      ))}
    </BrowserGroup>
  );
}



/** The design before it has geometry. */
function EmptyDocumentRow() {
  const name = useApp((state) => state.doc.name);
  const editing = useEditing('document');
  return (
    <TreeRow depth={0} icon={<Layers size={15} />} label={name} meta={<span className={styles.metaText}>no geometry</span>} item="document"
      menu={<ItemMenu target={{ kind: 'document' }} />} editor={editing ? <RenameField editKey={editing} /> : undefined}
      onDoubleClick={() => startRename({ kind: 'document' })} onKeyDown={(event) => itemKeyDown(event, { kind: 'document' })} />
  );
}

export default function Browser() {
  const rootId = useApp((state) => state.rootId);
  const open = useApp((state) => state.doc.open);
  const workspace = useApp((state) => state.workspace);
  const kind = useApp((state) => state.doc.kind);
  const drawing = useApp(drawingShown);
  return (
    <div className={styles.browser}>
      <div className={styles.scroll} id="model-tree">
        {!open && <p className={styles.empty}>{workspace === 'electronics' ? 'No circuit open' : 'No design open'}</p>}
        {open && kind === 'circuit' && <CircuitTree />}
        {/* The Drawing tab: the drawing's sheets, views and annotations. */}
        {open && drawing && <DrawingTree />}
        {open && !drawing && kind === 'design' && (
          <>
            {/* Designs: the document, origin, then components (one file each); the one being edited unfolds. */}
            {rootId ? <NodeRow id={rootId} depth={0} hideChildren /> : <EmptyDocumentRow />}
            <OriginGroup depth={1} />
            <ModelStructure />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={workspace} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6 }} transition={{ duration: 0.18 }}>
                {workspace === 'simulate' && <StudyTree />}
                {workspace === 'manufacture' && <SetupTree />}
              </motion.div>
            </AnimatePresence>
          </>
        )}
        {open && !drawing && kind === 'part' && (
          <>
            {/* Parts read like a CAD browser: the document owns origin, bodies, sketches, construction and history. */}
            {rootId ? <NodeRow id={rootId} depth={0} hideChildren /> : <EmptyDocumentRow />}
            <OriginGroup depth={1} />
            <ModelStructure />
            {/* Feature history lives in the timeline under the viewport. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={workspace} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6 }} transition={{ duration: 0.18 }}>
                {workspace === 'simulate' && <StudyTree />}
                {workspace === 'manufacture' && <SetupTree />}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}

export const collapseAll = () => set((state) => ({ tree: Object.fromEntries(Object.entries(state.tree).map(([id, node]) => [id, { ...node, expanded: node.type === 'document' }])) }));
