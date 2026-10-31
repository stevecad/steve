/**
 * The Design workspace's Drawing tab: the drawing sheets of the open part or design, drawn by the build (exact
 * hidden-line views, ISO or ANSI sheet, title block and tables), in the centre (docs/UI_LAYOUT.md). It works like a
 * CAD drawing workspace: the ribbon's tools make views, dimensions, GD&T, notes and tables on the sheet
 * (drawing/tools.ts), with their options in the Dock; what's on the sheet is selected there or in the Browser's drawing
 * tree, its properties in the Inspector. Every change rewrites the sheet's `Drawing(...)` call in the code (drawing/state.ts),
 * so STEVE, the code editor and the tools all edit the same thing. Sheets are drawn by the build (exact projection):
 * a change to them alone asks for one drawing build while this tab shows (useSheets), and the 3D model isn't rebuilt.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FilePlus2, MessageSquare } from 'lucide-react';
import { Button, ContextContent, ContextRoot, ContextTrigger, Spinner } from '@/ui';
import { isPreviewStale, rolledDoc, useApp, type AppState } from '@/state/store';
import { declaresDrawing, drawingBuildFor, type SheetSource } from '@/state/actions';
import { drawingShown } from '@/state/designTab';
import type { Build, BuildMetadata, DrawingDimensionIssue } from '@/lib/api';
import { MAIN, builtFrom, filesOf, modelBuiltFrom, stored } from '@/state/design';
import { sheetMarkup } from './sheets';
import { balloonRows } from './code';
import { ItemMenu } from './menus';
import { askAboutSheet, callsIn, dimensionRows, moveSheet, replacements, selectItem, selectSheet, undoReplacement, useDrawingTab } from './state';
import { cancelTool, placePending, startNewSheet, useDrawingTool } from './tools';
import Paper from './Paper';
import styles from './Drawing.module.css';

/* ───────── The sheet ───────── */

/** What each kind of undrawn annotation is called in the status bar. */
const KIND_OF: Record<NonNullable<DrawingDimensionIssue['annotation']>, string> = {
  datum: 'datum', frame: 'tolerance frame', balloon: 'balloon', hole: 'hole table', weld: 'weld symbol', note: 'leader note',
};

/** A short pause before drawing edited sheets, so typing in a sheet's call doesn't ask for a drawing per keystroke. */
const PAUSE_MS = 250;

interface Wanted { source: SheetSource; drawn: boolean }

/**
 * The open document's sheets, when the model shown is of it (a drawing edit since changes only the sheets), and whether
 * the build shown already has them (a full build of exactly that source); else null.
 */
function documentSheets(doc: AppState['doc'], displayed: Build): Wanted | null {
  if (!modelBuiltFrom(displayed, doc)) return null;
  return { source: { kind: displayed.kind, name: displayed.name, ...stored(doc) }, drawn: displayed.mode === 'full' && builtFrom(displayed, doc) };
}

/** The sheets of the model shown, as its own source has them (the model isn't of the open document's code). */
function shownSheets(displayed: Build): Wanted | null {
  if (displayed.code === undefined) return null;
  return { source: { kind: displayed.kind, name: displayed.name, code: displayed.code, files: displayed.files ?? {}, links: displayed.links ?? {} },
    drawn: displayed.mode === 'full' };
}

/** `from`: the code (main.py's) the sheets were drawn from, which their reports' evaluated arguments belong to. */
interface Sheets { status: 'idle' | 'loading' | 'ready' | 'failed'; markup: string[]; build: Build | null; error?: string; owner?: string | null; from?: string }

const NO_SHEETS: Sheets = { status: 'idle', markup: [], build: null };

/**
 * The sheets of the open document, drawn by the build: one drawing build per change to the sheets (drawingBuildFor; the
 * model shown isn't rebuilt for them), or the full build shown when it has them. A newer edit replaces the drawing in
 * flight; a model edit's sheets are drawn once its preview shows.
 */
function useSheets(active: boolean, declared: boolean): Sheets {
  const displayed = useApp((state) => state.displayed);
  const open = useApp((state) => state.doc);
  const rollback = useApp((state) => state.rollback);
  // Rolled back on the timeline, the model shown is of the code up to there (store.ts rolledDoc).
  const doc = useMemo(() => rolledDoc({ doc: open, rollback } as AppState), [open, rollback]);
  const busy = useApp((state) => state.busy);
  const owner = useApp((state) => state.activeTab);
  // Half-typed code: the editor shows where the syntax breaks; drawing it would only fail.
  const broken = useApp((state) => !!state.modeling?.diagnostics.some((d) => d.severity === 'error' && /syntax/i.test(d.message)));
  const [sheets, setSheets] = useState<Sheets>(NO_SHEETS);
  const current = useMemo(() => (displayed ? documentSheets(doc, displayed) : null), [doc, displayed]);
  // After a model edit the last sheets stay up (faded, as the model is) until its build shows, and its sheets are drawn
  // then; with none drawn yet and no build coming (live builds off), the model shown has its own drawn.
  const first = sheets.owner !== owner || !sheets.build;
  const wanted = broken ? null : current ?? (first && !busy && displayed ? shownSheets(displayed) : null);
  const key = wanted ? JSON.stringify(wanted.source) : '';
  useEffect(() => {
    if (!active || !displayed || !declared) return;
    if (!wanted) {
      // Nothing to draw now (a model edit's build, half-typed code): what was drawn last stays, faded with the model.
      setSheets((previous) => (previous.status === 'loading' && previous.build ? { ...previous, status: 'ready' } : previous));
      return;
    }
    // The document's last sheets stay up (faded) while the new ones are drawn.
    setSheets((previous) => (previous.owner === owner ? { ...previous, status: 'loading', error: undefined } : { ...NO_SHEETS, status: 'loading', owner }));
    let cancelled = false;
    const draw = async () => {
      try {
        const build = wanted.drawn ? displayed : await drawingBuildFor(wanted.source, `${owner ?? ''}|${doc.saved?.id ?? ''}|${doc.branch}`);
        const markup = await sheetMarkup(build);
        if (!cancelled) setSheets({ status: 'ready', markup, build, owner, from: wanted.source.code });
      } catch (error) {
        if (!cancelled) setSheets((previous) => ({ ...previous, status: 'failed', error: (error as Error).message, owner }));
      }
    };
    const timer = setTimeout(() => void draw(), wanted.drawn ? 0 : PAUSE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, key, wanted?.drawn, !!displayed, declared, owner]);
  return declared && displayed && sheets.owner === owner ? sheets : NO_SHEETS;
}

/* ───────── The sheet tabs ───────── */

/** Where a dragged tab would land: before or after tab `index`. */
interface Drop { index: number; side: 'before' | 'after' }

/** The place a sheet dragged from `from` takes when dropped at `drop`. */
const dropPlace = (from: number, drop: Drop) => (drop.side === 'before' ? (drop.index > from ? drop.index - 1 : drop.index) : (drop.index < from ? drop.index + 1 : drop.index));

/** One tab per sheet: a click shows it, a drag moves it to another place (its statement in the code), and its menu is the
 *  sheet's (Move left / Move right). */
function SheetTabs({ count, page, reports, movable, onSelect }: { count: number; page: number; reports?: BuildMetadata['drawings']; movable: boolean; onSelect: (sheet: number) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const end = () => { setDragging(null); setDrop(null); };
  return (
    <div className={styles.pages} role="tablist" aria-label="Sheets">
      {Array.from({ length: count }, (_, i) => (
        <ContextRoot key={i}>
          <ContextTrigger asChild>
            <button type="button" role="tab" className={styles.page} aria-selected={i === page} data-active={i === page || undefined} data-sheet={i}
              data-drop={drop && drop.index === i && dragging !== null && dropPlace(dragging, drop) !== dragging ? drop.side : undefined} data-dragging={dragging === i || undefined}
              title={`${reports?.sheets[i]?.title ?? `Sheet ${i + 1}`}: drag to reorder`} draggable={movable}
              onClick={() => onSelect(i)} onContextMenu={() => { if (i !== page) onSelect(i); }}
              onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-steve-sheet', String(i)); setDragging(i); }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const box = event.currentTarget.getBoundingClientRect();
                const side = event.clientX < box.left + box.width / 2 ? 'before' : 'after';
                if (!drop || drop.index !== i || drop.side !== side) setDrop({ index: i, side });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null && drop) { const to = dropPlace(dragging, drop); if (to !== dragging) void moveSheet(dragging, to); }
                end();
              }}
              onDragEnd={end}>{i + 1}. {reports?.sheets[i]?.title ?? `Sheet ${i + 1}`}</button>
          </ContextTrigger>
          <ContextContent><ItemMenu item={{ kind: 'sheet' }} sheet={i} report={reports?.sheets[i]} tabs /></ContextContent>
        </ContextRoot>
      ))}
    </div>
  );
}

/* ───────── The tab ───────── */

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}><div className={styles.emptyCard}>{children}</div></div>;
}

export default function DrawingTab() {
  const active = useApp(drawingShown);
  const kind = useApp((state) => (state.doc.kind === 'design' ? 'design' : 'part'));
  const declared = useApp((state) => declaresDrawing(state.doc));
  const busy = useApp((state) => state.busy);
  const stale = useApp((state) => isPreviewStale(state));
  const hasModel = useApp((state) => !!state.displayed);
  const selected = useDrawingTab((state) => state.sheet);
  const code = useApp((state) => (state.doc.kind !== 'design' || state.doc.activeFile === MAIN ? state.doc.code : filesOf(state.doc)[MAIN] ?? ''));
  const sheets = useSheets(active, declared);
  const reports = sheets.build?.metadata?.drawings;
  const built = sheets.from;
  // The tree, the Inspector and the tools read what the build reported for each sheet, and what it was drawn from.
  useEffect(() => { useDrawingTab.setState({ reports, built }); }, [reports, built]);
  // Sheets are numbered as the code declares them; when they all come from this file, sheet n is call n.
  const page = Math.max(0, Math.min(selected, sheets.markup.length - 1));
  // A view a tool just wrote goes where it was clicked, once the sheet is drawn with it.
  useEffect(() => { if (sheets.status === 'ready') void placePending(reports?.sheets[page], page); }, [reports, page, sheets.status]);
  // Tools and the selection belong to the sheet that's shown; a new sheet's setup (which opens the tab) belongs to none.
  useEffect(() => { if (!active || useDrawingTool.getState().tool !== 'new-sheet') cancelTool(); }, [active, page]);
  useEffect(() => { if (!active) selectItem(null); }, [active]);
  // Esc lets go of what's selected (an open tool takes Esc first).
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || useDrawingTool.getState().tool || (event.target as HTMLElement | null)?.closest?.('input, textarea, [role="menu"]')) return;
      selectItem(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active]);
  // Ctrl+Z (⌘Z) puts back the last expression an edit wrote a value over, outside text boxes and the code editor.
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z' || event.defaultPrevented) return;
      if (target?.isContentEditable || target?.closest?.('input, textarea, select, .cm-editor') || useDrawingTool.getState().tool || useApp.getState().busy || isPreviewStale()) return;
      if (!replacements().length) return;
      event.preventDefault();
      void undoReplacement();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active]);
  // Dimensions and balloons are dragged into place unless they're made by a loop in the code.
  const call = useMemo(() => callsIn(code, { reports, built })[page], [code, page, reports, built]);
  const [editable, balloonsEditable] = [!!call && dimensionRows(call) !== null, !!call && balloonRows(call) !== null];
  if (!active) return null;

  const markup = sheets.markup[page];
  const report = reports?.sheets[page];
  const select = selectSheet;

  // A drawing edit's redraw doesn't lock the sheet: what's shown is still right, and the next edit goes on the latest
  // code (its sheet replaces the one in flight). A model change, other work or a failed drawing does.
  const locked = busy ? 'Wait for the current operation to finish.' : stale ? 'Wait for the sheet to redraw.'
    : sheets.status === 'failed' ? 'The sheet couldn’t be drawn: fix what the status bar says first.' : null;

  const undrawn = (report?.dangling?.length ?? 0) + (report?.dimension_problems?.length ?? 0);
  let status: ReactNode = null, tone: 'warning' | 'danger' | undefined;
  if (!hasModel) status = 'Generate the model to draw its sheets.';
  else if (sheets.status === 'loading') status = <><Spinner size={12} />Drawing the views (exact hidden lines)…</>;
  else if (sheets.status === 'failed') { status = `Couldn’t draw the sheets: ${sheets.error}`; tone = 'danger'; }
  else if (reports?.error) { status = reports.error; tone = 'danger'; }
  else if (report?.overflow) { status = report.overflow; tone = 'warning'; }
  else if (undrawn) {
    const items = [...(report?.dangling ?? []), ...(report?.dimension_problems ?? [])];
    const kinds = [...new Set(items.map((item) => (item.annotation ? KIND_OF[item.annotation] : 'dimension')))];
    status = `${undrawn} ${kinds.length === 1 ? kinds[0] : 'annotation'}${undrawn === 1 ? '' : 's'} not drawn: marked in the drawing tree.`;
    tone = 'warning';
  } else if (report?.annotation_notes?.length) {
    const note = report.annotation_notes[0];
    status = `${note.annotation ? `Tolerance frame ${note.index}` : `Dimension ${note.dimension}`}: ${note.problem}`;
    tone = 'warning';
  } else if (report?.balloon_problems?.some((item) => item.item === undefined) || report?.hole_problems?.length) {
    // Parts list items with no placed instance to balloon (washers, cables) are listed in the panel, not warned about here.
    const issue = [...(report.balloon_problems ?? []).filter((item) => item.item === undefined), ...(report.hole_problems ?? [])][0];
    const what = issue.annotation === 'hole' ? `Hole table ${issue.index}` : issue.index ? `Balloon ${issue.index}` : 'Balloons';
    status = `${what}: ${issue.problem}`;
    tone = 'warning';
  }
  else if (report && !report.views.length) status = `${report.standard} · ${report.sheet} · a blank sheet: place its first view with Base view.`;
  else if (report) status = `${report.standard} · ${report.sheet} · ${report.projection} angle · scale ${report.scale}`;

  return (
    <div className={styles.tab} id="drawing-tab" data-sheets={sheets.markup.length}>
      <div className={styles.stage}>
        <div className={styles.bar} data-tone={tone}>
          <span className={styles.barStatus} id="drawing-status">{status}</span>
          {sheets.markup.length > 1 && <SheetTabs count={sheets.markup.length} page={page} reports={reports} movable={!busy} onSelect={select} />}
        </div>
        {markup ? <Paper markup={markup} stale={stale} redrawing={sheets.status === 'loading'} fitKey={`${page}`} report={report} call={call}
          dimensionsEditable={editable} balloonsEditable={balloonsEditable} locked={locked} />
          : !declared ? (
            <Empty>
              <span className={styles.emptyTitle}>No drawing yet</span>
              <span>Start a sheet of this {kind}: choose its standard, size and template, then place the views you want (or start with the standard ones). Add dimensions, GD&amp;T and tables with the tools above. STEVE can set it up or change it for you too.</span>
              <div className={styles.emptyActions}>
                <Button variant="primary" icon={<FilePlus2 />} disabled={busy} onClick={() => startNewSheet()} id="drawing-new-sheet">New sheet</Button>
                <Button variant="ghost" icon={<MessageSquare />} onClick={askAboutSheet}>Ask STEVE</Button>
              </div>
            </Empty>
          ) : sheets.status === 'loading' || (hasModel && sheets.status === 'idle') ? <Empty><Spinner size={18} /></Empty>
            : <Empty>{hasModel ? 'The sheets will show here once the model builds.' : 'Generate the model to draw its sheets.'}</Empty>}
      </div>
    </div>
  );
}
