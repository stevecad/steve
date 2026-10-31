/**
 * The Inspector on the Drawing tab: the properties of what's selected on the sheet (or in the drawing tree), written
 * into the sheet's `Drawing(...)` call as they're changed. Nothing selected: the Inspector shows what it shows anywhere
 * else in Design. Double click, Edit and Tolerance… put the cursor in the field they're about.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Undo2 } from 'lucide-react';
import { useApp } from '@/state/store';
import { drawingShown } from '@/state/designTab';
import { MAIN, filesOf } from '@/state/design';
import { Button, Section } from '@/ui';
import { stillWritten, type DrawingCall } from './code';
import { itemLabel } from './items';
import { argumentName, callsIn, editSheet, undoReplacement, useDrawingTab, type DrawingItem } from './state';
import {
  BalloonForm, CutListForm, DatumForm, DimensionForm, FrameForm, HoleTableForm, NoteForm, NotesForm, PartsListForm, RevisionsForm, SheetFormatForm, Templates,
  TitleBlockForm, ViewForm, WeldForm, type Edit,
} from './forms';
import styles from './Drawing.module.css';

/** The drawing item selected on the shown sheet, when the Drawing tab is what Design shows. */
export function useDrawingSelection(): DrawingItem | null {
  const shown = useApp(drawingShown);
  const selected = useDrawingTab((state) => state.selected);
  return shown ? selected : null;
}

/** The arguments each kind of item's form edits: where the notes of the expressions its edits wrote over go. */
const ITEM_ARGS: Record<DrawingItem['kind'], string[]> = {
  sheet: ['standard', 'sheet', 'orientation', 'projection', 'scale', 'units', 'dual_units', 'dual_precision', 'hidden', 'shaded', 'dimensions', 'name'],
  view: ['views', 'front', 'section_views', 'detail_views'], dimension: ['feature_dimensions', 'datums', 'tolerance_frames'],
  balloon: ['balloons'], datum: ['datums', 'tolerance_frames', 'feature_dimensions'], frame: ['tolerance_frames'], weld: ['welds'],
  'hole-table': ['hole_tables'], note: ['notes'], notes: ['notes'], revisions: ['revisions'], 'parts-list': ['bom'], 'cut-list': ['cut_list'],
  'title-block': ['title', 'fields', 'title_block'],
};

/** What an edit of the selected item wrote over that was a variable or an expression: `was s`, with Undo (Ctrl+Z too). */
function Replaced({ item, call, sheet }: { item: DrawingItem; call: DrawingCall; sheet: number }) {
  const replaced = useDrawingTab((state) => state.replaced);
  const tab = useApp((state) => state.activeTab);
  const shown = replaced.filter((entry) => entry.tab === tab && entry.sheet === sheet && ITEM_ARGS[item.kind].includes(entry.key) && stillWritten(call, entry.key, entry.now));
  if (!shown.length) return null;
  return (
    <>
      {shown.map((entry) => (
        <div key={entry.key} className={styles.row} data-replaced={entry.key}>
          <span className={styles.hint} title={entry.was}>
            {argumentName(entry.key).replace(/^./, (c) => c.toUpperCase())} was <code>{entry.was.length > 60 ? `${entry.was.slice(0, 57)}…` : entry.was}</code>
          </span>
          <Button size="sm" variant="ghost" icon={<Undo2 />} title="Put the code back as it was (Ctrl+Z)" onClick={() => { void undoReplacement(entry); }}>Undo</Button>
        </div>
      ))}
    </>
  );
}

export default function DrawingInspector() {
  const selected = useDrawingTab((state) => state.selected);
  const sheet = useDrawingTab((state) => state.sheet);
  const focus = useDrawingTab((state) => state.focus);
  const reports = useDrawingTab((state) => state.reports);
  const built = useDrawingTab((state) => state.built);
  const code = useApp((state) => (state.doc.kind !== 'design' || state.doc.activeFile === MAIN ? state.doc.code : filesOf(state.doc)[MAIN] ?? ''));
  const calls = useMemo(() => callsIn(code, { reports, built }), [code, reports, built]);
  const index = Math.max(0, Math.min(sheet, calls.length - 1));
  const call = calls[index];
  const report = reports?.sheets[index];
  const host = useRef<HTMLDivElement>(null);

  // Edit, Tolerance… and a double click put the cursor in their field, once: the request is used up, so selecting
  // something else later leaves keyboard focus where it is (Delete and the other keys keep acting on the sheet).
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const root = host.current;
      const field = root?.querySelector<HTMLElement>(`[data-field="${focus.field}"]`) ?? root?.querySelector<HTMLElement>('input:not([disabled]), button[role="combobox"]');
      if (!field) return;
      field.focus();
      if (field instanceof HTMLInputElement) field.select();
      if (useDrawingTab.getState().focus?.nonce === focus.nonce) useDrawingTab.setState({ focus: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus?.nonce, selected]);

  if (!selected || !call) return null;
  const edit: Edit = (changes) => { void editSheet(changes); };
  const props = { call, edit, report };
  let form: React.ReactNode = null;
  switch (selected.kind) {
    case 'sheet': form = <><SheetFormatForm {...props} /><Templates /></>; break;
    case 'view': form = <ViewForm {...props} name={selected.name} />; break;
    case 'dimension': form = <DimensionForm {...props} number={selected.number} />; break;
    case 'balloon': form = <BalloonForm {...props} number={selected.number} />; break;
    case 'datum': form = <DatumForm {...props} number={selected.number} />; break;
    case 'frame': form = <FrameForm {...props} number={selected.number} />; break;
    case 'weld': form = <WeldForm {...props} number={selected.number} />; break;
    case 'hole-table': form = <HoleTableForm {...props} number={selected.number} />; break;
    case 'note': form = <NoteForm {...props} number={selected.number} />; break;
    case 'notes': form = <NotesForm {...props} />; break;
    case 'revisions': form = <RevisionsForm {...props} />; break;
    case 'parts-list': form = <PartsListForm {...props} />; break;
    case 'cut-list': form = <CutListForm {...props} />; break;
    case 'title-block': form = <TitleBlockForm {...props} />; break;
  }
  return (
    <div ref={host} data-panel="drawing-item" data-item={selected.kind}>
      <Section title={itemLabel(selected, call, report)} id="drawing-item">
        <div className={styles.stack}><Replaced item={selected} call={call} sheet={index} />{form}</div>
      </Section>
    </div>
  );
}
