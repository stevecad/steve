/**
 * The open Drawing tool's options, in the Dock's tool tab (docs/UI_LAYOUT.md): what to do next on the sheet, the
 * tool's settings, and OK / Cancel (Enter / Esc; Esc first steps back a pick). Sheet format and title block edit a
 * draft of the sheet's arguments, written on OK.
 */
import { useMemo } from 'react';
import { useApp } from '@/state/store';
import { drawingShown } from '@/state/designTab';
import { MAIN, filesOf } from '@/state/design';
import { Field, Segmented, Select, Switch } from '@/ui';
import ToolFooter from '@/shell/ToolFooter';
import ui from '@/ui/ui.module.css';
import { drawingCalls, FLAT, OWN_VIEWS, parseDatumLabel, standardOf, templateChanges, withChanges, withNewDrawing, withWeld, type DrawingCall, type PyValue } from './code';
import { callsIn, drawableComponents, useDrawingTab } from './state';
import {
  baseChoices, cancelTool, dimensionPreview, draftChange, finishBlocked, finishTool, placesMaster, sheetMetalBodies, toolEscape, useDrawingTool, TOOL_TITLES, type ToolState,
} from './tools';
import { KIND_TITLES } from './measure';
import { FrameFields, SheetFormatForm, Templates, TitleBlockForm, WeldFields } from './forms';
import { viewTitle } from './items';
import styles from './Drawing.module.css';

/** What the next click does, as the tool's panel says it. */
function prompt(state: ToolState): string {
  switch (state.tool) {
    case 'base': return 'Click where the view goes on the sheet.';
    case 'projected': return state.step === 'parent' ? 'Click the view to project from.' : 'Move to the side the new view goes, then click.';
    case 'section': return state.step === 'line' ? (state.line ? 'Click (or let go) where the cutting line ends.' : 'Draw the cutting line across a view: it snaps across or up, through the nearest hole or corner.')
      : 'Click the side the section looks from: that’s where it goes.';
    case 'detail': return state.step === 'centre' ? 'Click the centre of what the detail shows.' : state.step === 'radius' ? 'Move out to size the circle, then click.' : 'Click where the detail goes.';
    case 'dimension': return !state.picks.length ? 'Click an edge, a circle or a corner in a view.' : state.picks.length === 1 && state.step === 'pick'
      ? 'Click another edge or corner to measure between, or click where this one goes.' : 'Click where the dimension goes, or Enter to let the sheet place it.';
    case 'note': return state.step === 'text' ? 'Type the note, then Enter.' : state.picks.length ? 'Click where the note goes: its leader points at what you picked.'
      : 'Click where the note goes, or first an edge, face or corner in a view for a note on a leader (FLUSH, TYP).';
    case 'balloon': return state.step === 'pick' ? 'Click a part in a view.' : 'Click where the balloon goes.';
    case 'datum': case 'frame': return state.step === 'pick' ? 'Click a feature in a view, or a dimension for its feature of size.' : 'Click where it goes, or Enter.';
    case 'weld': return state.weld !== null ? `Click the edge, face or corner the new arrow on weld symbol ${state.weld} points at.`
      : !state.picks.length ? 'Click an edge, a face or a corner of the joint in a view: an arrow points at each one picked.'
        : 'Click more of the joint in this view for more arrows, or click where the reference line starts (Enter: the sheet places it).';
    case 'hole-table': return state.step === 'parent' ? 'Click the view that looks along the holes.'
      : 'Click holes to list just those (none: every hole), and a corner to measure from. The table goes above the title block.';
    case 'new-sheet': return state.options.standardViews === true ? 'Set up the sheet, then OK: it starts with the front, top, right and isometric views.'
      : 'Set up the sheet, then OK for a blank sheet. Next: Base view places its first view.';
    default: return '';
  }
}

export default function DrawingToolPanel() {
  const shown = useApp(drawingShown);
  const state = useDrawingTool();
  const sheet = useDrawingTab((tab) => tab.sheet);
  const code = useApp((app) => (app.doc.kind !== 'design' || app.doc.activeFile === MAIN ? app.doc.code : filesOf(app.doc)[MAIN] ?? ''));
  const reports = useDrawingTab((tab) => tab.reports);
  const built = useDrawingTab((tab) => tab.built);
  const calls = useMemo(() => callsIn(code, { reports, built }), [code, reports, built]);
  const index = Math.max(0, Math.min(sheet, calls.length - 1));
  // New sheet edits a sheet that isn't in the code yet: the call it will write.
  const component = typeof state.options.component === 'string' ? state.options.component : null;
  const fresh = useMemo(() => (state.tool === 'new-sheet' ? drawingCalls(withNewDrawing('', { standard: 'ISO', source: component ?? undefined, args: state.changes }))[0] : undefined),
    [state.tool, state.changes, component]);
  const call = fresh ?? calls[index];
  // Sheet format and title block show their draft: the sheet as it will be written (what's left as it was, as evaluated).
  const draftOf = (drawn: DrawingCall | undefined) => (drawn ? { ...drawn, values: call?.values } : call);
  const draft = useMemo(() => (fresh ?? (call && Object.keys(state.changes).length ? draftOf(drawingCalls(withChanges(code, call, state.changes))[index]) : call)),
    [fresh, code, call, index, state.changes]);
  const kind = useApp((app) => app.doc.kind);
  if (!shown || !state.tool || !call) return null;
  const option = (key: string, value: PyValue) => useDrawingTool.setState({ options: { ...state.options, [key]: value } });
  const blocked = finishBlocked(state);
  const standard = standardOf(call);
  let body: React.ReactNode = null;
  switch (state.tool) {
    case 'base': {
      const bodies = sheetMetalBodies();
      const flat = state.options.orientation === FLAT;
      body = (
        <>
          <div className={styles.views} role="group" aria-label="Orientation">
            {baseChoices(call).map((view) => (
              <button key={view} type="button" className={styles.view} aria-pressed={state.options.orientation === view} data-view={view} onClick={() => option('orientation', view)}>
                {viewTitle(view)}
              </button>
            ))}
          </div>
          {flat && bodies.length > 1 && (
            <Field label="Body">
              <Select ariaLabel="Flat pattern body" id="drawing-flat-body" value={typeof state.options.body === 'string' && bodies.includes(state.options.body) ? state.options.body : bodies[0]}
                onChange={(value) => option('body', value)} options={bodies.map((name) => ({ value: name, label: name }))} />
            </Field>
          )}
          {flat && <p className={styles.hint} id="drawing-flat-hint">The blank its DXF cuts, with its bend lines: it follows the part as it changes.</p>}
          {placesMaster(call) && !OWN_VIEWS.includes(String(state.options.orientation ?? '')) && (
            <p className={styles.hint} id="drawing-master-hint">The first view is the sheet’s master: projected views follow it. Turn it in its properties.</p>
          )}
        </>
      );
      break;
    }
    case 'section': case 'detail':
      body = (
        <Field label="Name">
          <input className={ui.input} aria-label="View name" value={String(state.options.name ?? '')} maxLength={2}
            onChange={(event) => option('name', parseDatumLabel(event.target.value, standard) ?? event.target.value.toUpperCase())} />
        </Field>
      );
      break;
    case 'dimension': {
      // What the picks measure, as it will read on the sheet (the build's exact value replaces it).
      const preview = dimensionPreview(state);
      body = (
        <>
          {preview && <p className={styles.measure} id="drawing-tool-measure" data-kind={preview.kind}>
            {KIND_TITLES[preview.kind]}{preview.text && <> · <strong>{preview.text}</strong></>}</p>}
          {state.picks.length === 1 && state.picks[0].kind === 'circle' && (
            <Segmented size="sm" value={state.options.kind === 'radius' ? 'radius' : 'diameter'} onChange={(value) => option('kind', value)}
              options={[{ value: 'diameter', label: 'Diameter' }, { value: 'radius', label: 'Radius' }]} />
          )}
        </>
      );
      break;
    }
    case 'note':
      body = (
        <Field label="Text">
          <input className={ui.input} aria-label="Note text" id="drawing-note-panel" value={String(state.options.text ?? '')} maxLength={200} placeholder="Break all sharp edges."
            onChange={(event) => option('text', event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void finishTool(); }} />
        </Field>
      );
      break;
    case 'datum':
      body = (
        <Field label="Letter">
          <input className={ui.input} aria-label="Datum letter" value={String(state.options.label ?? '')} maxLength={2}
            onChange={(event) => option('label', parseDatumLabel(event.target.value, standard) ?? event.target.value.toUpperCase())} />
        </Field>
      );
      break;
    case 'frame':
      body = <FrameFields call={call} row={state.options} change={(patch) => {
        const next = { ...state.options };
        for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key]; else next[key] = value;
        useDrawingTool.setState({ options: next });
      }} />;
      break;
    case 'weld':
      if (state.weld !== null) break;  // Add arrow: nothing to set.
      body = (
        <>
          {state.picks.length > 0 && <p className={styles.hint} id="drawing-weld-arrows">{state.picks.length} arrow{state.picks.length > 1 ? 's' : ''} in {viewTitle(state.picks[0].view)}</p>}
          <WeldFields call={call} row={state.options} change={(patch) => useDrawingTool.setState({ options: withWeld(state.options, patch) })} />
        </>
      );
      break;
    case 'hole-table':
      if (state.view) body = <p className={styles.hint}>{viewTitle(state.view)} · {state.picks.length ? `${state.picks.length} hole${state.picks.length > 1 ? 's' : ''}` : 'every hole'} · from {state.origin?.ref ?? 'the lower-left corner'}</p>;
      break;
    case 'revision':
      body = (
        <div className={styles.grid}>
          {([['rev', 'Revision'], ['date', 'Date'], ['description', 'What changed'], ['by', 'By']] as const).map(([key, label]) => (
            <Field key={key} label={label}>
              <input className={ui.input} aria-label={label} data-field={key} value={String(state.options[key] ?? '')} maxLength={200} autoFocus={key === 'description'}
                onChange={(event) => option(key, event.target.value)} />
            </Field>
          ))}
        </div>
      );
      break;
    case 'sheet-format':
      body = <><SheetFormatForm call={draft} edit={draftChange} /><Templates apply={(template) => draftChange(templateChanges(template, call).changes)} /></>;
      break;
    case 'new-sheet': {
      const components = drawableComponents();
      body = (
        <>
          {components.length > 0 && (
            <Field label="Draw">
              <Select ariaLabel="What to draw" id="drawing-new-source" value={component ?? 'result'} onChange={(value) => option('component', value === 'result' ? null : value)}
                options={[{ value: 'result', label: kind === 'design' ? 'The whole design' : 'The part' }, ...components.map(({ id, name }) => ({ value: id, label: name }))]} />
            </Field>
          )}
          <SheetFormatForm call={draft} edit={draftChange} />
          <div className={styles.row}>Start with the standard views
            <Switch label="Standard views" checked={state.options.standardViews === true} onCheckedChange={(on) => option('standardViews', on)} />
          </div>
          <Templates fresh={draft} apply={(template) => draftChange(templateChanges(template, draft).changes)} />
        </>
      );
      break;
    }
    case 'title-block':
      body = <TitleBlockForm call={draft} edit={draftChange} />;
      break;
    default:
  }
  const instruction = prompt(state);
  return (
    <div className={styles.panel} data-panel="drawing-tool" data-tool={state.tool} data-step={state.step}>
      <div className={styles.toolBody}>
        {instruction && <p className={styles.prompt} id="drawing-tool-prompt">{instruction}</p>}
        {state.hint && <p className={styles.issue} id="drawing-tool-hint">{state.hint}</p>}
        {body}
      </div>
      <ToolFooter onOk={() => { void finishTool(); }} okDisabled={blocked} onCancel={cancelTool} onEscape={toolEscape} okTitle={`Add the ${TOOL_TITLES[state.tool].toLowerCase()}`}
        okId="drawing-tool-ok" cancelId="drawing-tool-cancel" />
    </div>
  );
}
