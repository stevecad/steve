/**
 * The drawing tree, in the Browser while the Drawing tab shows: every sheet, and on each its views (section and detail
 * views under the view they're taken from, each view's dimensions, GD&T and balloons under it), then its tables, notes
 * and title block. Choosing a row selects that thing on the sheet (and the other way round); a double click edits it;
 * F2 renames a sheet, a section or detail view, or a datum in place; its menu is the sheet's (drawing/menus.tsx).
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  CircleDot, Crosshair, FileText, Flag, History, ListOrdered, PanelBottom, RectangleHorizontal, Ruler, Scissors, StickyNote, Table2, Type, ZoomIn,
} from 'lucide-react';
import { toast, useApp } from '@/state/store';
import { MAIN, filesOf } from '@/state/design';
import { SectionIcon, WeldIcon } from '@/icons/cad';
import TreeRow from '@/shell/TreeRow';
import styles from '@/shell/Browser.module.css';
import drawing from './Drawing.module.css';
import type { DrawingSheet } from '@/lib/api';
import { labelOf, type DrawingCall } from './code';
import { nameOf, renamable, renameItem, renameProblem, sheetTree, viewsOf, type TreeNode } from './items';
import { callsIn, editItem, itemKey, moveSheet, selectItem, selectSheet, useDrawingTab, type DrawingItem } from './state';
import { ItemMenu } from './menus';

const ICONS: Record<DrawingItem['kind'], ReactNode> = {
  sheet: <FileText size={15} />, view: <RectangleHorizontal size={15} />, dimension: <Ruler size={15} />, balloon: <CircleDot size={15} />,
  datum: <Flag size={15} />, frame: <Crosshair size={15} />, weld: <WeldIcon size={15} />, 'hole-table': <Table2 size={15} />, note: <Type size={15} />, notes: <StickyNote size={15} />,
  revisions: <History size={15} />, 'parts-list': <ListOrdered size={15} />, 'cut-list': <Scissors size={15} />, 'title-block': <PanelBottom size={15} />,
};

function iconOf(item: DrawingItem, call: DrawingCall): ReactNode {
  if (item.kind !== 'view') return ICONS[item.kind];
  const kind = viewsOf(call).find((view) => view.name === item.name)?.kind;
  return kind === 'section' ? <SectionIcon size={15} /> : kind === 'detail' ? <ZoomIn size={15} /> : ICONS.view;
}

/** A name being edited in place. */
function NameField({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input className={drawing.renameInput} aria-label="Name" autoFocus value={value} ref={(element) => { if (element) setTimeout(() => { if (document.activeElement !== element) element.focus(); }, 40); }} maxLength={120} onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)} onBlur={() => onDone(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); onDone(value); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(null); }
      }} />
  );
}

export default function DrawingTree() {
  const code = useApp((state) => (state.doc.kind !== 'design' || state.doc.activeFile === MAIN ? state.doc.code : filesOf(state.doc)[MAIN] ?? ''));
  const shown = useDrawingTab((state) => state.sheet);
  const selected = useDrawingTab((state) => state.selected);
  const reports = useDrawingTab((state) => state.reports);
  const built = useDrawingTab((state) => state.built);
  const calls = useMemo(() => callsIn(code, { reports, built }), [code, reports, built]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const trees = useMemo(() => calls.map((call, i) => sheetTree(call, reports?.sheets[i])), [calls, reports]);

  // What's selected on the sheet shows in the tree: the views it's under unfold.
  useEffect(() => {
    if (!selected) return;
    const path = (nodes: TreeNode[], trail: string[]): string[] | null => {
      for (const node of nodes) {
        if (itemKey(node.item) === itemKey(selected)) return trail;
        const found = path(node.children, [...trail, `${shown}/${itemKey(node.item)}`]);
        if (found) return found;
      }
      return null;
    };
    const trail = path(trees[shown] ?? [], [`${shown}/sheet`]);
    if (trail?.some((key) => !open[key])) setOpen((state) => ({ ...state, ...Object.fromEntries(trail.map((key) => [key, true])) }));
    document.querySelector(`#drawing-tree [data-item="${shown}/${itemKey(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, shown, trees]);

  if (!calls.length) return null;

  const rename = (item: DrawingItem, sheet: number, value: string | null) => {
    setRenaming(null);
    const call = calls[sheet];
    if (value === null || !call || value.trim() === nameOf(item, call, sheet)) return;
    const problem = renameProblem(item, call, value);
    if (problem) { toast('warning', 'Not renamed', problem); return; }
    void renameItem(item, sheet, value);
  };

  const row = (node: TreeNode, sheet: number, depth: number, report?: DrawingSheet): ReactNode => {
    const call = calls[sheet];
    const key = `${sheet}/${itemKey(node.item)}`;
    const expanded = open[key] ?? false;
    const isSelected = sheet === shown && itemKey(selected) === itemKey(node.item);
    const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'F2' && renamable(node.item, call)) { event.preventDefault(); selectItem(node.item, sheet); setRenaming(key); }
    };
    return (
      <div key={key}>
        <TreeRow depth={depth} icon={iconOf(node.item, call)} label={node.label} meta={node.meta && <span className={styles.metaText}>{node.meta}</span>} item={key}
          title={node.issue} error={!!node.issue} selected={isSelected}
          expanded={node.children.length ? expanded : undefined} onToggle={node.children.length ? () => setOpen((state) => ({ ...state, [key]: !expanded })) : undefined}
          onClick={() => selectItem(node.item, sheet)} onDoubleClick={() => editItem(node.item, 'first', sheet)} onContextSelect={() => selectItem(node.item, sheet)}
          onKeyDown={keyDown} editor={renaming === key ? <NameField initial={nameOf(node.item, call, sheet)} onDone={(value) => rename(node.item, sheet, value)} /> : undefined}
          menu={<ItemMenu item={node.item} report={report} sheet={sheet} rename={() => { selectItem(node.item, sheet); setRenaming(key); }} />} />
        {expanded && node.children.map((child) => row(child, sheet, depth + 1, report))}
      </div>
    );
  };

  return (
    <div id="drawing-tree" role="tree" aria-label="Drawing">
      {calls.map((call, sheet) => {
        const key = `${sheet}/sheet`;
        const expanded = open[key] ?? sheet === shown;
        const item: DrawingItem = { kind: 'sheet' };
        const report = reports?.sheets[sheet];
        const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === 'F2' && renamable(item, call)) { event.preventDefault(); setRenaming(key); }
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            const to = sheet + (event.key === 'ArrowUp' ? -1 : 1);
            if (calls[to]) void moveSheet(sheet, to);
          }
        };
        return (
          <div key={key}>
            <TreeRow depth={0} icon={ICONS.sheet} label={labelOf(call, sheet)} meta={report && <span className={styles.metaText}>{report.scale ? `${report.sheet} · ${report.scale}` : report.sheet}</span>}
              item={key} selected={sheet === shown && selected?.kind === 'sheet'} expanded={expanded}
              onToggle={() => setOpen((state) => ({ ...state, [key]: !expanded }))}
              onClick={() => { if (sheet !== shown) selectSheet(sheet); selectItem(item, sheet); }}
              onDoubleClick={() => editItem(item, 'first', sheet)} onContextSelect={() => { if (sheet !== shown) selectSheet(sheet); selectItem(item, sheet); }}
              onKeyDown={keyDown} editor={renaming === key ? <NameField initial={labelOf(call, sheet)} onDone={(value) => rename(item, sheet, value)} /> : undefined}
              menu={<ItemMenu item={item} sheet={sheet} report={report} rename={() => setRenaming(key)} />} />
            {expanded && (trees[sheet] ?? []).map((node) => row(node, sheet, 1, report))}
          </div>
        );
      })}
    </div>
  );
}
