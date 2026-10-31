/**
 * The Drawing tab's forms: the properties of what's selected on a sheet (the Inspector, drawing/Inspector.tsx) and the
 * options of the tool that's open (drawing/ToolPanel.tsx). Each edits a sheet's `Drawing(...)` arguments through
 * `edit` (Python text; undefined removes one): the Inspector writes and rebuilds at once, a tool keeps a draft until OK.
 */
import { useState } from 'react';
import { FilePlus2, Pin, Plus, RotateCcw, Save, Stamp, X } from 'lucide-react';
import { Button, Field, IconButton, Section, Segmented, Select, Switch } from '@/ui';
import ui from '@/ui/ui.module.css';
import { useApp } from '@/state/store';
import { useSetting } from '@/settings/store';
import type { DrawingSheet } from '@/lib/api';
import {
  arg, atOf, BALLOON_SIDES, balloonRows, balloonsText, CHARACTERISTICS, datumOf, DIAMETER_ZONE, FIELDS, FIT_SHOWS, fixedNote, FLAT, frontOf, frontText, holeTableRows, layoutFields, SIDE_UP, SIDES, sidesNextTo, ISO_ONLY, needsDatum, NO_MATERIAL,
  isLeaderNote, isListedNote, noteRows, notesText, type NoteRow, parseFit, parseTolerance, parseZone, py, pyList, SCALES, scaleLabel, SHEET_SIZES, standardOf, takesDatums, TEMPLATE_LIMIT, TEXT_LIMIT,
  titleLayout, toleranceText, dualOf, unitsOf, viewItems, viewName, viewsText, withCharacteristic, withKeys, withViewAt, withViewSettings, positionOf, positionValue, withViewPatches, withViewsFixed,
  type DrawingCall, type DrawingTemplate, type PyValue,
  hasLeaders, parseWeldValue, WELD_TYPES, weldRefs, weldRows, weldSides, weldsText, weldSpacingProblem, withWeld,
} from './code';
import { listOf, orthographic, refsOf, viewTitle, viewsOf, weldTypeName } from './items';
import { applyTemplate, currentCall, removeTemplate, saveTemplate } from './state';
import { startNewSheet } from './tools';
import styles from './Drawing.module.css';
import { askConfirm } from '@/ui/confirm';

export type Edit = (changes: Record<string, string | undefined>) => void;

/* ───────── Small controls ───────── */

/** A text box that writes when it's left or Enter is pressed (not on every key: each write rebuilds). */
export function Text({ value, onCommit, placeholder, disabled, label, id, field }: {
  value: string; onCommit: (value: string) => void; placeholder?: string; disabled?: boolean; label: string; id?: string; field?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <input className={ui.input} aria-label={label} id={id} data-field={field} value={draft ?? value} placeholder={placeholder} disabled={disabled} maxLength={TEXT_LIMIT}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); }
      }} />
  );
}

/** What the tab leaves as written: made by a loop in the code (or a value it can't write out). */
export const InCode = () => <p className={styles.hint}>{fixedNote(currentCall()?.call)}</p>;
export const Issue = ({ children }: { children?: string }) => (children ? <p className={styles.issue}>{children}</p> : null);

const text = (value: PyValue | undefined) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
const asDict = (value: PyValue | undefined): Record<string, PyValue> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asList = (value: PyValue | undefined): PyValue[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []);
const SCALE_OPTIONS = SCALES.map(([a, b]) => ({ value: `${a}:${b}`, label: `${a}:${b}` }));
const scaleChoices = (first: { value: string; label: string }, own?: string) =>
  [first, ...SCALE_OPTIONS, ...(own && !SCALE_OPTIONS.some((option) => option.value === own) ? [{ value: own, label: own }] : [])];

/** ISO A sizes and ANSI letter sizes that match, for switching standards. */
const SIZE_PAIRS: Record<string, string> = { A4: 'A', A3: 'B', A2: 'C', A1: 'D', A0: 'E', A: 'A4', B: 'A3', C: 'A2', D: 'A1', E: 'A0' };

/* ───────── The sheet ───────── */

/** Standard, size, orientation, projection, scale, units, what every view shows by default, and fixing the views where
 *  they are (so moving an annotation never moves them). */
export function SheetFormatForm({ call, edit, report }: { call: DrawingCall; edit: Edit; report?: DrawingSheet }) {
  const standard = standardOf(call);
  const standardArg = arg(call, 'standard');
  const sheet = arg(call, 'sheet');
  const sheetValue = typeof sheet.value === 'string' ? sheet.value.toUpperCase() : standard === 'ISO' ? 'A3' : 'B';
  const orientation = arg(call, 'orientation');
  const projection = arg(call, 'projection');
  const units = arg(call, 'units');
  const dualUnits = arg(call, 'dual_units');
  const dualPrecision = arg(call, 'dual_precision');
  const dual = dualOf(call);
  const other = unitsOf(call) === 'mm' ? 'in' : 'mm';
  const scale = arg(call, 'scale');
  const scaleValue = scaleLabel(scale.value) ?? 'auto';
  const setUnits = (value: string) => {
    const next = value === 'standard' ? (standard === 'ANSI' ? 'in' : 'mm') : value;
    // The second unit is the one the sheet doesn't use: it goes when the sheet's units become it.
    edit({ units: value === 'standard' ? undefined : py(value), ...(dual === next ? { dual_units: undefined, dual_precision: undefined } : {}) });
  };
  const hidden = arg(call, 'hidden');
  const shaded = arg(call, 'shaded');
  const dimensions = arg(call, 'dimensions');
  const fix = report ? withViewsFixed(call, report) : null;
  const setStandard = (next: 'ISO' | 'ANSI') => {
    if (next === standard) return;
    const changes: Record<string, string | undefined> = { standard: py(next) };
    if (typeof sheet.value === 'string' && SIZE_PAIRS[sheet.value.toUpperCase()]) changes.sheet = py(SIZE_PAIRS[sheet.value.toUpperCase()]);
    if (units.raw === undefined && dual === (next === 'ANSI' ? 'in' : 'mm')) Object.assign(changes, { dual_units: undefined, dual_precision: undefined });
    edit(changes);
  };
  return (
    <div className={styles.stack}>
      <Segmented size="sm" value={standard} onChange={setStandard} options={[
        { value: 'ISO', label: 'ISO', disabled: !standardArg.editable }, { value: 'ANSI', label: 'ANSI / ASME', disabled: !standardArg.editable }]} />
      <div className={styles.grid}>
        <Field label="Size">
          <Select ariaLabel="Sheet size" value={sheetValue} disabled={!sheet.editable} onChange={(value) => edit({ sheet: py(value) })}
            options={[...SHEET_SIZES[standard], ...(SHEET_SIZES[standard].includes(sheetValue as never) ? [] : [sheetValue])].map((size) => ({ value: size, label: size }))} />
        </Field>
        <Field label="Orientation">
          <Select ariaLabel="Orientation" value={text(orientation.value) || 'landscape'} disabled={!orientation.editable}
            onChange={(value) => edit({ orientation: value === 'landscape' ? undefined : py(value) })}
            options={[{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }]} />
        </Field>
        <Field label="Projection">
          <Select ariaLabel="Projection" value={text(projection.value) || 'standard'} disabled={!projection.editable}
            onChange={(value) => edit({ projection: value === 'standard' ? undefined : py(value) })}
            options={[{ value: 'standard', label: standard === 'ISO' ? 'First angle (ISO)' : 'Third angle (ASME)' },
              { value: 'first', label: 'First angle' }, { value: 'third', label: 'Third angle' }]} />
        </Field>
        <Field label="Scale">
          <Select ariaLabel="Scale" value={scaleValue} disabled={!scale.editable}
            onChange={(value) => edit({ scale: value === 'auto' ? undefined : `(${value.replace(':', ', ')})` })} options={scaleChoices({ value: 'auto', label: 'Largest that fits' }, scaleValue === 'auto' ? undefined : scaleValue)} />
        </Field>
        <Field label="Units">
          <Select ariaLabel="Units" value={text(units.value) || 'standard'} disabled={!units.editable || !dualUnits.editable} onChange={setUnits}
            options={[{ value: 'standard', label: standard === 'ISO' ? 'Millimetres (ISO)' : 'Inches (ASME)' }, { value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }]} />
        </Field>
        <Field label="Second unit">
          <Select ariaLabel="Second unit" value={dual ?? 'none'} disabled={!dualUnits.editable || !dualPrecision.editable}
            onChange={(value) => edit(value === 'none' ? { dual_units: undefined, dual_precision: undefined } : { dual_units: py(value) })}
            options={[{ value: 'none', label: 'None' }, { value: other, label: other === 'in' ? 'Inches, in brackets' : 'Millimetres, in brackets' }]} />
        </Field>
        {dual && (
          <Field label="Second unit decimals">
            <Select ariaLabel="Second unit decimal places" value={typeof dualPrecision.value === 'number' ? String(dualPrecision.value) : 'auto'}
              disabled={!dualPrecision.editable} onChange={(value) => edit({ dual_precision: value === 'auto' ? undefined : value })}
              options={[{ value: 'auto', label: 'Auto' }, ...['0', '1', '2', '3', '4'].map((places) => ({ value: places, label: places }))]} />
          </Field>
        )}
      </div>
      <div className={styles.row}>Hidden lines dashed
        <Switch label="Hidden lines" checked={hidden.value !== false} disabled={!hidden.editable} onCheckedChange={(on) => edit({ hidden: on ? undefined : 'False' })} />
      </div>
      <div className={styles.row}>Shaded views
        <Switch label="Shaded views" checked={shaded.value === true} disabled={!shaded.editable} onCheckedChange={(on) => edit({ shaded: on ? 'True' : undefined })} />
      </div>
      <div className={styles.row}>Overall dimensions
        <Switch label="Overall dimensions" checked={dimensions.value !== false} disabled={!dimensions.editable} onCheckedChange={(on) => edit({ dimensions: on ? undefined : 'False' })} />
      </div>
      {fix && (
        <div className={styles.stack} data-fix-views>
          <p className={styles.hint}>Views are laid out with room for their annotations, so moving one can move them. Fix them where they are to keep them put.</p>
          <Button size="sm" variant="ghost" icon={<Pin />} onClick={() => edit(fix)}>Fix view positions</Button>
        </div>
      )}
      {[sheet, orientation, projection, scale, units, dualUnits, dualPrecision, standardArg, hidden, shaded, dimensions].some((item) => !item.editable) && <InCode />}
    </div>
  );
}

/** The title and the title block's fields (any others too: customer, project…); on a sheet with its own title block
 *  layout (`title_block=`), the fields its cells show. */
export function TitleBlockForm({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const title = arg(call, 'title');
  const fields = arg(call, 'fields');
  const values = asDict(fields.value);
  const layout = arg(call, 'title_block');
  const own = layout.raw !== undefined && layout.value !== null ? titleLayout(layout.value) : null;
  const [label, setLabel] = useState('');
  const setField = (key: string, value: string) => {
    const next: Record<string, PyValue> = { ...values };
    if (value) next[key] = value; else delete next[key];
    edit({ fields: Object.keys(next).length ? py(next) : undefined });
  };
  const known = new Set(FIELDS.map(([key]) => key));
  const extra = Object.keys(values).filter((key) => !known.has(key) && key !== 'revision');
  const addField = () => {
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    setLabel('');
    if (key && !(key in values)) setField(key, '-');
  };
  const titleBox = (
    <Field label="Title">
      <Text label="Title" id="drawing-title-text" field="first" value={text(title.value)} placeholder="The part or design’s name" disabled={!title.editable}
        onCommit={(value) => edit({ title: value ? py(value) : undefined })} />
    </Field>
  );
  if (layout.raw !== undefined && layout.value !== null) {
    return (
      <div className={styles.stack} data-layout="own">
        <p className={styles.hint}>This sheet has its own title block layout. Change its cells in the code, or ask STEVE.</p>
        {titleBox}
        {own ? (
          <div className={styles.grid}>
            {layoutFields(own).map(([key, name]) => (
              <Field key={key} label={name}>
                <Text label={name} field={key} value={text(values[key])} placeholder={key === 'revision' ? 'Last revision row' : undefined} disabled={!fields.editable}
                  onCommit={(value) => setField(key, value)} />
              </Field>
            ))}
          </div>
        ) : <InCode />}
        {own && !fields.editable && <InCode />}
      </div>
    );
  }
  return (
    <div className={styles.stack}>
      {titleBox}
      <div className={styles.grid}>
        {FIELDS.map(([key, name]) => (
          <Field key={key} label={name}><Text label={name} value={text(values[key])} disabled={!fields.editable} onCommit={(value) => setField(key, value)} /></Field>
        ))}
        <Field label="Revision">
          <Text label="Revision" value={text(values.revision)} placeholder="Last revision row" disabled={!fields.editable} onCommit={(value) => setField('revision', value)} />
        </Field>
        {extra.map((key) => (
          <Field key={key} label={key.replace(/_/g, ' ')}><Text label={key} value={text(values[key])} disabled={!fields.editable} onCommit={(value) => setField(key, value)} /></Field>
        ))}
      </div>
      {fields.editable ? (
        <div className={styles.row}>
          <input className={ui.input} aria-label="New field" placeholder="Another field (customer, project…)" value={label} maxLength={40}
            onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addField(); }} />
          <IconButton small label="Add field" disabled={!label.trim()} onClick={addField}><Plus size={14} /></IconButton>
        </div>
      ) : <InCode />}
    </div>
  );
}

/**
 * Sheet templates (account setting `drawing.templates`): a sheet's standard, size, orientation, projection, units,
 * title block fields and layout, and notes saved by name, for every drawing of the account. Applied ones are copied into the code.
 * `fresh`: a new sheet's setup (New sheet), which a template is used for and saved from.
 */
export function Templates({ apply, fresh }: { apply?: (template: DrawingTemplate) => void; fresh?: DrawingCall }) {
  const templates = useSetting('drawing.templates');
  const busy = useApp((state) => state.busy);
  const [name, setName] = useState('');
  const replaces = templates.some((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase());
  const full = !replaces && templates.length >= TEMPLATE_LIMIT;
  const save = () => {
    if (!name.trim() || full) return;
    void saveTemplate(name, fresh);
    setName('');
  };
  const summary = (template: DrawingTemplate) => [template.standard === 'ANSI' ? 'ANSI' : 'ISO', template.sheet, template.orientation === 'portrait' ? 'portrait' : null,
    template.title_block && 'own title block',
    template.fields && `${Object.keys(template.fields).length} field${Object.keys(template.fields).length === 1 ? '' : 's'}`,
    template.notes && `${template.notes.length} note${template.notes.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return (
    <Section title="Templates" id="drawing-templates" defaultOpen={templates.length > 0}>
      <div className={styles.stack}>
        {fresh && !templates.length && <p className={styles.hint}>Save a sheet’s setup as a template from its Sheet format, to start new sheets from it.</p>}
        {templates.map((template) => (
          <div key={template.name} className={styles.template} data-template={template.name}>
            <span className={styles.templateName} title={template.name}><span>{template.name}</span><small>{summary(template)}</small></span>
            {!fresh && <IconButton small label="New sheet from template" description={`Add a sheet set up as “${template.name}”`} disabled={busy}
              onClick={() => startNewSheet(template)}><FilePlus2 size={13} /></IconButton>}
            <IconButton small label={fresh ? 'Use for the new sheet' : 'Apply to this sheet'}
              description={fresh ? 'Its standard, size, orientation, projection, units, title block, fields and notes'
                : 'Its standard, size, orientation, projection, units, title block, fields and notes; views, scale and dimensions stay'}
              disabled={busy} onClick={() => (apply ? apply(template) : void applyTemplate(template))}><Stamp size={13} /></IconButton>
            <IconButton small label="Delete template" description="Sheets already made from it don’t change"
              onClick={() => void askConfirm({ title: `Delete the template “${template.name}”?`, detail: 'Sheets made from it stay as they are.', action: 'Delete template' })
                .then((yes) => { if (yes) removeTemplate(template.name); })}><X size={13} /></IconButton>
          </div>
        ))}
        <div className={styles.row}>
          <input className={ui.input} aria-label="Template name" id="drawing-template-name" placeholder={`Save ${fresh ? 'this setup' : 'this sheet'} as… (e.g. Company A3)`} value={name} maxLength={60}
            onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} />
          <IconButton small label={replaces ? 'Replace template' : 'Save as template'} disabled={!name.trim() || full} onClick={save}><Save size={14} /></IconButton>
        </div>
        {full && <p className={styles.hint}>You can keep up to {TEMPLATE_LIMIT} templates: delete one to save another.</p>}
      </div>
    </Section>
  );
}

/* ───────── Views ───────── */

const SIDE_OPTIONS = (sides: readonly string[]) => sides.map((side) => ({ value: side, label: viewTitle(side) }));

/** The master (front) view's orientation: the model side it shows and the side up on the paper. The views projected
 *  from it follow; annotations stay on their geometry (reported when it no longer shows). */
function MasterFields({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const front = frontOf(call);
  if (!front || !arg(call, 'front').editable) return <><p className={styles.hint}>The sheet’s master view.</p><InCode /></>;
  const [facing, up] = front;
  const setFacing = (next: string) => edit({ front: frontText(next, sidesNextTo(next).includes(up) ? up : SIDE_UP[next]) });
  return (
    <>
      <p className={styles.hint}>The sheet’s master view: the other views are projected from it and turn with it.</p>
      <div className={styles.grid} data-master>
        <Field label="Shows the model’s">
          <Select ariaLabel="Master view facing" value={facing} onChange={setFacing} options={SIDE_OPTIONS(SIDES)} />
        </Field>
        <Field label="Up on the paper">
          <Select ariaLabel="Master view up" value={up} onChange={(next) => edit({ front: frontText(facing, next) })} options={SIDE_OPTIONS(sidesNextTo(facing))} />
        </Field>
      </div>
    </>
  );
}

export function ViewForm({ call, edit, name, report }: { call: DrawingCall; edit: Edit; name: string; report?: DrawingSheet }) {
  const view = viewsOf(call).find((entry) => entry.name === name);
  if (!view) return null;
  const issue = report?.dangling_views?.find((item) => item.view === name)?.problem ?? report?.view_problems?.find((item) => item.view === name)?.problem;
  if (view.kind === 'base') {
    const items = viewItems(call);
    const item = items.find((entry) => viewName(entry) === name);
    const own = asDict(item);
    const set = (patch: Record<string, PyValue | undefined>) => edit({ views: viewsText(items.map((entry) => (viewName(entry) === name ? withViewSettings(entry, patch) : entry))) });
    if (!arg(call, 'views').editable) return <InCode />;
    if (name === FLAT) {  // The blank its DXF cuts: which sheet-metal body, its scale and place; no hidden lines or shading.
      const bodies = report?.sheet_metal_bodies ?? [];
      const body = typeof own.body === 'string' ? own.body : undefined;
      const choices = body && !bodies.includes(body) ? [body, ...bodies] : bodies;
      return (
        <div className={styles.stack} data-view-settings={name}>
          <p className={styles.hint}>The flat pattern its sheet-metal DXF cuts, with its bend lines and notes. It follows the part as it changes; use Dimension to locate its bend lines from its edges.</p>
          {(choices.length > 1 || body) && (
            <Field label="Body">
              <Select ariaLabel="Flat pattern body" value={body ?? bodies[0] ?? ''} options={choices.map((value) => ({ value, label: value }))}
                onChange={(value) => set({ body: value })} />
            </Field>
          )}
          <Field label="Scale">
            <Select ariaLabel={`${name} view scale`} value={scaleLabel(own.scale) ?? 'sheet'} onChange={(value) => set({ scale: value === 'sheet' ? undefined : value.split(':').map(Number) })}
              options={scaleChoices({ value: 'sheet', label: 'Sheet scale' }, scaleLabel(own.scale))} />
          </Field>
          <Position call={call} edit={edit} name={name} row={own} />
          <Issue>{issue && `Not drawn: ${issue}`}</Issue>
        </div>
      );
    }
    return (
      <div className={styles.stack} data-view-settings={name}>
        {name === 'front' && <MasterFields call={call} edit={edit} />}
        <Field label="Scale">
          <Select ariaLabel={`${name} view scale`} value={scaleLabel(own.scale) ?? 'sheet'} onChange={(value) => set({ scale: value === 'sheet' ? undefined : value.split(':').map(Number) })}
            options={scaleChoices({ value: 'sheet', label: 'Sheet scale' }, scaleLabel(own.scale))} />
        </Field>
        <Field label="Hidden lines">
          {name === 'iso' ? (
            <Select ariaLabel={`${name} view hidden lines`} value={own.hidden === true ? 'on' : 'off'}
              onChange={(value) => set({ hidden: value === 'on' ? true : undefined })}
              options={[{ value: 'off', label: 'None' }, { value: 'on', label: 'Dashed' }]} />
          ) : (
            <Select ariaLabel={`${name} view hidden lines`} value={own.hidden === true ? 'on' : own.hidden === false ? 'off' : 'sheet'}
              onChange={(value) => set({ hidden: value === 'sheet' ? undefined : value === 'on' })}
              options={[{ value: 'sheet', label: 'As the sheet' }, { value: 'on', label: 'Dashed' }, { value: 'off', label: 'None' }]} />
          )}
        </Field>
        <Field label="Shading">
          <Select ariaLabel={`${name} view shading`} value={own.shaded === true ? 'on' : own.shaded === false ? 'off' : 'sheet'}
            onChange={(value) => set({ shaded: value === 'sheet' ? undefined : value === 'on' })}
            options={[{ value: 'sheet', label: 'As the sheet' }, { value: 'on', label: 'Shaded' }, { value: 'off', label: 'Lines only' }]} />
        </Field>
        <Position call={call} edit={edit} name={name} row={own} />
      </div>
    );
  }
  const key = `${view.kind}_views` as const;
  const rows = listOf(arg(call, key).value);
  const index = rows.findIndex((row) => row.name === name);
  const row = rows[index];
  if (!arg(call, key).editable || !row) return <InCode />;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ [key]: pyList(rows.map((entry, i) => (i === index ? withKeys(entry, patch) : entry))) });
  const vertical = row.direction === 'vertical';
  const at = row.through ?? row.centre ?? row.center;
  return (
    <div className={styles.stack} data-view-settings={name}>
      <p className={styles.hint}>{view.kind === 'section' ? 'Cuts' : 'Centred'} {typeof at === 'string' ? `on ${at}` : Array.isArray(at) ? `at (${at.join(', ')})` : ''} in {viewTitle(view.parent ?? '')}.</p>
      <div className={styles.grid}>
        {view.kind === 'section' ? (
          <>
            <Field label="Cutting line">
              <Select ariaLabel="Cutting line" value={vertical ? 'vertical' : 'horizontal'} onChange={(value) => change({ direction: value === 'horizontal' ? undefined : value, at: undefined })}
                options={[{ value: 'horizontal', label: 'Across' }, { value: 'vertical', label: 'Up' }]} />
            </Field>
            <Field label="Looking">
              <Select ariaLabel="Looking" value={row.flip === true ? 'flip' : 'normal'} onChange={(value) => change({ flip: value === 'flip' ? true : undefined, at: undefined })}
                options={[{ value: 'normal', label: vertical ? 'Left' : 'Down' }, { value: 'flip', label: vertical ? 'Right' : 'Up' }]} />
            </Field>
          </>
        ) : (
          <Field label="Radius (model mm)">
            <Text label="Radius (model mm)" field="first" value={text(row.radius)} placeholder="10"
              onCommit={(value) => { const radius = Number(value); if (radius > 0 && radius <= 100000) change({ radius }); }} />
          </Field>
        )}
        <Field label="Scale">
          <Select ariaLabel={`View ${name} scale`} value={scaleLabel(row.scale) ?? 'parent'} onChange={(value) => change({ scale: value === 'parent' ? undefined : value.split(':').map(Number) })}
            options={scaleChoices({ value: 'parent', label: view.kind === 'detail' ? 'Twice its parent’s' : 'Its parent’s' }, scaleLabel(row.scale))} />
        </Field>
      </div>
      <Position call={call} edit={edit} name={name} row={row} />
      <Issue>{issue && `Not drawn: ${issue}`}</Issue>
    </div>
  );
}

/** A view's offset from where the projection method puts it (paper mm), or, fixed, its centre on the sheet; dragging the
 *  view on the sheet sets either. */
function Position({ call, edit, name, row }: { call: DrawingCall; edit: Edit; name: string; row: Record<string, PyValue> }) {
  const fixed = positionOf(row.position);
  if (fixed) {
    const place = (next: [number, number]) => { const changes = withViewPatches(call, new Map([[name, { position: positionValue(next) }]])); if (changes) edit(changes); };
    const typed = (value: string) => (value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
    return (
      <>
        <div className={styles.grid}>
          <Field label="Centre from left (mm)"><Text label="Centre from left" value={String(fixed[0])}
            onCommit={(value) => { const x = typed(value); if (x !== null) place([x, fixed[1]]); }} /></Field>
          <Field label="Centre from bottom (mm)"><Text label="Centre from bottom" value={String(fixed[1])}
            onCommit={(value) => { const y = typed(value); if (y !== null) place([fixed[0], y]); }} /></Field>
        </div>
        <p className={styles.hint}>Fixed on the sheet: annotations and the other views don’t move it.</p>
      </>
    );
  }
  const [x, y] = atOf(row.at);
  const set = (next: [number, number]) => { const changes = withViewAt(call, name, next); if (changes) edit(changes); };
  return (
    <div className={styles.grid}>
      <Field label="Moved right (mm)"><Text label="Moved right" value={x ? String(x) : ''} placeholder="0" onCommit={(typed) => set([Number(typed) || 0, y])} /></Field>
      <Field label="Moved up (mm)"><Text label="Moved up" value={y ? String(y) : ''} placeholder="0" onCommit={(typed) => set([x, Number(typed) || 0])} /></Field>
    </div>
  );
}

/* ───────── Annotations ───────── */

const DISPLAY_LABELS: Record<string, string> = { value: 'Value', basic: 'Basic (boxed)', reference: 'Reference ( )', limits: 'Limits' };
const SIDE_LABELS: Record<string, string> = { above: 'Above the view', below: 'Below the view', left: 'Left of the view', right: 'Right of the view',
  out: 'Outside', in: 'Inside', 'up-right': 'Leader up right', 'up-left': 'Leader up left', 'down-right': 'Leader down right', 'down-left': 'Leader down left' };

export function DimensionForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const dims = arg(call, 'feature_dimensions');
  const rows = listOf(dims.value);
  const row = rows[number - 1];
  const [bad, setBad] = useState<string | null>(null);
  if (!dims.editable || !row) return <InCode />;
  const index = number - 1;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ feature_dimensions: pyList(rows.map((entry, i) => (i === index ? withKeys(entry, patch) : entry))) });
  const display = text(row.display) || 'value';
  const setTolerance = (typed: string) => {
    const fit = parseFit(typed);
    if (fit) { setBad(null); change({ fit, tolerance: undefined, display: ['basic', 'reference'].includes(display) ? undefined : row.display }); return; }
    const tolerance = parseTolerance(typed);
    if (tolerance === undefined) { setBad('tolerance'); return; }
    setBad(null);
    // Basic and reference dimensions carry no tolerance; limits need one.
    change({ tolerance: tolerance ?? undefined, fit: undefined, fit_shows: undefined,
      display: (tolerance === null && display === 'limits') || (tolerance !== null && ['basic', 'reference'].includes(display)) ? undefined : row.display });
  };
  const placed = report?.placed?.find((item) => item.dimension === number);
  const sides = placed?.sides ?? [];
  const side = text(row.side) || placed?.side || sides[0] || '';
  const textAt = typeof row.text_at === 'number' ? 'custom' : text(row.text_at) || 'centre';
  const fit = report?.fits?.find((item) => item.dimension === number);
  const units = unitsOf(call);
  const dual = dualOf(call);
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  const issue = report?.dangling?.find((item) => item.dimension === number && !item.annotation)?.problem
    ?? report?.dimension_problems?.find((item) => item.dimension === number && !item.annotation)?.problem
    ?? report?.annotation_notes?.find((item) => item.dimension === number && !item.annotation)?.problem;
  const overridden = report?.overridden?.find((item) => item.dimension === number);
  // A distance on round wire or tube ends at its axis (centre), or at the tangent of its inside or outside.
  const refs = asList(row.refs);
  const ends = refs.length === 2 ? refs.map((_, i) => {
    const end = text(Array.isArray(row.ends) ? row.ends[i] : row.ends);
    return end === 'center' || !end ? 'centre' : end;
  }) : [];
  const setEnd = (index: number, value: string) => {
    const next = ends.map((end, i) => (i === index ? value : end));
    change({ ends: next.every((end) => end === 'centre') ? undefined : next });
  };
  return (
    <div className={styles.stack} data-dimension-form={number}>
      <p className={styles.hint}>{text(row.kind) || 'Measured'} in {viewTitle(text(row.view) || 'front')}: {asList(row.refs).map(String).join(' ↔ ')}</p>
      <div className={styles.grid}>
        <Field label="Tolerance or fit">
          <Text label="Tolerance" field="tolerance" value={toleranceText(row.tolerance, row.fit)} placeholder="±0.1, +0.1 -0.05 or H7" onCommit={setTolerance} />
        </Field>
        <Field label="Shown as">
          <Select ariaLabel="Shown as" value={display}
            onChange={(value) => change({ display: value === 'value' ? undefined : value, ...(['basic', 'reference'].includes(value) ? { tolerance: undefined, fit: undefined, fit_shows: undefined } : {}) })}
            options={Object.entries(DISPLAY_LABELS).filter(([key]) => key !== 'limits' || row.tolerance !== undefined || display === 'limits').map(([key, label]) => ({ value: key, label }))} />
        </Field>
        <Field label="Decimals">
          <Select ariaLabel="Decimal places" value={typeof row.precision === 'number' ? String(row.precision) : 'auto'}
            onChange={(value) => change({ precision: value === 'auto' ? undefined : Number(value) })}
            options={[{ value: 'auto', label: 'Auto' }, ...['0', '1', '2', '3', '4'].map((places) => ({ value: places, label: `${places}` }))]} />
        </Field>
        {(dual || row.dual !== undefined || row.dual_precision !== undefined) && (
          <Field label={dual ? `Second unit (${dual})` : 'Second unit'}>
            <Select ariaLabel="Second unit decimal places"
              value={row.dual === false ? 'off' : typeof row.dual_precision === 'number' ? String(row.dual_precision) : 'sheet'}
              onChange={(value) => change(value === 'off' ? { dual: false, dual_precision: undefined }
                : { dual: undefined, dual_precision: value === 'sheet' ? undefined : Number(value) })}
              options={[{ value: 'sheet', label: 'As the sheet' }, ...['0', '1', '2', '3', '4'].map((places) => ({ value: places, label: `${places} places` })),
                { value: 'off', label: 'Not shown' }]} />
          </Field>
        )}
        {ends.map((end, i) => (placed?.round_ends?.[i] || end !== 'centre') && (
          <Field key={`end-${i}`} label={i === 0 ? 'First end' : 'Second end'}>
            <Select ariaLabel={i === 0 ? 'First end' : 'Second end'} value={end} onChange={(value) => setEnd(i, value)}
              options={[{ value: 'centre', label: 'Centre (axis)' }, { value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }]} />
          </Field>
        ))}
        <Field label="Text">
          <Text label="Text in place of the value" field="text" value={text(row.text)} placeholder="Measured value" onCommit={(value) => change({ text: value || undefined })} />
        </Field>
        {(sides.length > 1 || row.side !== undefined) && (
          <Field label="Side">
            <Select ariaLabel="Side" value={side} onChange={(value) => change({ side: value === sides[0] && placed?.type !== 'round' ? undefined : value })}
              options={(sides.length ? sides : [side]).map((name) => ({ value: name, label: SIDE_LABELS[name] ?? name }))} />
          </Field>
        )}
        {placed?.type !== 'round' && (
          <Field label="Text position">
            <Select ariaLabel="Text position" value={textAt}
              onChange={(value) => change({ text_at: value === 'centre' ? undefined : value === 'custom' ? row.text_at : value })}
              options={[{ value: 'centre', label: 'Centred' }, { value: 'start', label: 'At start' }, { value: 'end', label: 'At end' },
                ...(textAt === 'custom' ? [{ value: 'custom', label: `${text(row.text_at)} mm along` }] : [])]} />
          </Field>
        )}
        <Field label="Offset (paper mm)">
          <Text label="Offset (paper mm)" value={text(row.offset)} placeholder={placed ? String(placed.offset) : 'Auto'}
            onCommit={(typed) => { const value = typed ? Number(typed) : undefined; if (value === undefined || (value > 0 && value <= 200)) change({ offset: value }); else setBad('offset'); }} />
        </Field>
      </div>
      {typeof row.fit === 'string' && (
        <Field label="Fit shown as">
          <Select ariaLabel="Fit shown as" value={display === 'limits' ? 'limits' : text(row.fit_shows) || (units === 'in' ? 'limits' : 'class')}
            onChange={(value) => change({ fit_shows: value, display: display === 'limits' ? undefined : row.display })}
            options={FIT_SHOWS.map((value) => ({ value, label: { class: `${row.fit}`, deviations: `${row.fit} and its deviations`, limits: `Limits, then (${row.fit})` }[value] }))} />
        </Field>
      )}
      {fit && <p className={styles.hint}>ISO 286 at {fit.nominal_mm} mm: {signed(fit.upper_mm)} / {signed(fit.lower_mm)} mm.</p>}
      {['offset', 'side', 'text_at'].some((key) => row[key] !== undefined) && (
        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => change({ offset: undefined, side: undefined, text_at: undefined })}>Reset placement</Button>
      )}
      {bad === 'tolerance' && <Issue>Write a tolerance like ±0.1, +0.1 -0.05 for upper and lower, or an ISO 286 fit like H7 (a hole) or g6 (a shaft).</Issue>}
      {bad === 'offset' && <Issue>Write the offset in paper millimetres, more than 0 and up to 200.</Issue>}
      <Issue>{issue && `Not drawn: ${issue}`}</Issue>
      {overridden && <p className={styles.hint}>Shows “{overridden.text}” in place of the measured {overridden.measured}.</p>}
    </div>
  );
}

const BALLOON_SIDE_LABELS: Record<string, string> = { out: 'Out from the view', above: 'Above the view', below: 'Below the view',
  left: 'Left of the view', right: 'Right of the view', 'up-right': 'Up right', 'up-left': 'Up left', 'down-right': 'Down right', 'down-left': 'Down left' };

export function BalloonForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const rows = balloonRows(call);
  const placed = report?.balloons_placed?.find((item) => item.balloon === number);
  if (rows === null) return <InCode />;
  if (rows === 'all' || !placed?.index) {
    return (
      <div className={styles.stack}>
        <p className={styles.hint}>Item {placed?.item} · {placed?.instance}. Every part has a balloon (balloons=True): drag one to give it its own place.</p>
        <div className={styles.row}>A balloon on every part
          <Switch label="Balloon every part" checked={rows === 'all'} onCheckedChange={(on) => edit({ balloons: balloonsText(on ? 'all' : []) })} />
        </div>
      </div>
    );
  }
  const index = placed.index - 1;
  const row = rows[index];
  const change = (patch: Record<string, PyValue | undefined>) => edit({ balloons: balloonsText(rows.map((entry, i) => (i === index ? withKeys(entry, patch) : entry))) });
  const views = viewsOf(call).map((view) => view.name);
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>Item {placed.item} of the parts list · {text(row.instance)}</p>
      <div className={styles.grid}>
        <Field label="View">
          <Select ariaLabel="Balloon view" value={text(row.view) || 'auto'} onChange={(value) => change({ view: value === 'auto' ? undefined : value })}
            options={[{ value: 'auto', label: 'First that shows it' }, ...views.map((name) => ({ value: name, label: viewTitle(name) }))]} />
        </Field>
        <Field label="Side">
          <Select ariaLabel="Balloon side" value={text(row.side) || 'out'} onChange={(value) => change({ side: value === 'out' ? undefined : value })}
            options={['out', ...BALLOON_SIDES].map((side) => ({ value: side, label: BALLOON_SIDE_LABELS[side] }))} />
        </Field>
        <Field label="Offset (paper mm)">
          <Text label="Balloon offset (paper mm)" field="first" value={text(row.offset)} placeholder="10"
            onCommit={(typed) => { const value = typed ? Number(typed) : undefined; if (value === undefined || (value > 0 && value <= 200)) change({ offset: value }); }} />
        </Field>
      </div>
    </div>
  );
}

const MATERIAL_LABELS: Record<string, string> = { none: 'RFS', MMC: 'Ⓜ MMC', LMC: 'Ⓛ LMC' };

/** A datum: its letter (the frames that refer to it follow) and its distance from the feature. */
export function DatumForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const datums = listOf(arg(call, 'datums').value);
  const row = datums[number - 1];
  if (!arg(call, 'datums').editable || !row) return <InCode />;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ datums: pyList(datums.map((entry, i) => (i === number - 1 ? withKeys(entry, patch) : entry))) });
  const issue = report?.dangling?.find((item) => item.annotation === 'datum' && item.index === number)?.problem
    ?? report?.dimension_problems?.find((item) => item.annotation === 'datum' && item.index === number)?.problem;
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>On {row.dimension !== undefined ? `dimension ${text(row.dimension)}` : `${text(row.ref)} in ${viewTitle(text(row.view) || 'front')}`}. Rename it in the drawing tree (F2).</p>
      <Field label="Offset (paper mm)">
        <Text label="Datum offset (paper mm)" field="first" value={text(row.offset)} placeholder="Auto"
          onCommit={(typed) => { const value = typed ? Number(typed) : undefined; if (value === undefined || (value > 0 && value <= 200)) change({ offset: value }); }} />
      </Field>
      <Issue>{issue && `Not drawn: ${issue}`}</Issue>
    </div>
  );
}

/** A feature control frame's settings: the frame tool's options, and a frame's properties. */
export function FrameFields({ call, row, change, number }: { call: DrawingCall; row: Record<string, PyValue>; change: (patch: Record<string, PyValue | undefined>) => void; number?: number }) {
  const [bad, setBad] = useState(false);
  const standard = standardOf(call);
  const units = unitsOf(call);
  const labels = listOf(arg(call, 'datums').value).map((datum) => text(datum.label)).filter(Boolean);
  const characteristic = text(row.characteristic);
  const refs = refsOf(row);
  const options = CHARACTERISTICS.filter(([name]) => name === characteristic || ((standard === 'ISO' || !ISO_ONLY.includes(name)) && (labels.length || !needsDatum(name))));
  const setDatum = (slot: number, letter: string) => {
    const next: PyValue[] = [];
    for (let i = 0; i < 3; i++) {
      const item = i === slot ? (letter === 'none' ? null : letter) : refs[i] ?? null;
      if (item !== null && !next.some((datum) => datumOf(datum).letter === datumOf(item).letter)) next.push(item);
    }
    change({ datums: next.length ? next : undefined });
  };
  return (
    <div className={styles.stack} data-frame-form={number}>
      <div className={styles.grid}>
        <Field label="Characteristic">
          <Select ariaLabel="Characteristic" value={characteristic} onChange={(value) => {
            const next = withCharacteristic(row, value, labels);
            change(Object.fromEntries([...new Set([...Object.keys(row), ...Object.keys(next)])].map((key) => [key, next[key]])));
          }} options={options.map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label={`Tolerance (${units})`}>
          <Text label="Tolerance" field="first" value={text(row.tolerance)} placeholder={units === 'in' ? '.005' : '0.1'}
            onCommit={(typed) => { const value = parseZone(typed); if (value === undefined) { setBad(true); return; } setBad(false); change({ tolerance: value }); }} />
        </Field>
        {DIAMETER_ZONE.includes(characteristic) && (
          <Field label="Zone">
            <Select ariaLabel="Tolerance zone" value={row.zone === 'diameter' ? 'diameter' : 'width'} onChange={(value) => change({ zone: value === 'diameter' ? 'diameter' : undefined })}
              options={[{ value: 'width', label: 'Width' }, { value: 'diameter', label: '⌀ cylinder' }]} />
          </Field>
        )}
        {!NO_MATERIAL.includes(characteristic) && (
          <Field label="Material condition">
            <Select ariaLabel="Material condition" value={text(row.modifier) || 'none'} onChange={(value) => change({ modifier: value === 'none' ? undefined : value })}
              options={Object.entries(MATERIAL_LABELS).map(([value, label]) => ({ value, label }))} />
          </Field>
        )}
      </div>
      {takesDatums(characteristic) && (
        <div className={styles.grid}>
          {[0, 1, 2].map((slot) => {
            const letter = datumOf(refs[slot] ?? null).letter;
            const choices = [...labels, ...(letter && !labels.includes(letter) ? [letter] : [])];
            return (
              <Field key={slot} label={['Primary', 'Secondary', 'Tertiary'][slot]}>
                <Select ariaLabel={`Datum ${slot + 1}`} value={letter || 'none'} onChange={(value) => setDatum(slot, value)}
                  options={[...(slot === 0 && needsDatum(characteristic) && letter ? [] : [{ value: 'none', label: '—' }]), ...choices.map((value) => ({ value, label: value }))]} />
              </Field>
            );
          })}
        </div>
      )}
      {bad && <Issue>{`Write the zone’s size in ${units === 'in' ? 'inches' : 'millimetres'}, more than 0.`}</Issue>}
    </div>
  );
}

export function FrameForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const frames = listOf(arg(call, 'tolerance_frames').value);
  const row = frames[number - 1];
  if (!arg(call, 'tolerance_frames').editable || !row) return <InCode />;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ tolerance_frames: pyList(frames.map((entry, i) => (i === number - 1 ? withKeys(entry, patch) : entry))) });
  const match = (item: { annotation?: string; index?: number | null }) => item.annotation === 'frame' && item.index === number;
  const issue = report?.dangling?.find(match)?.problem ?? report?.dimension_problems?.find(match)?.problem ?? report?.annotation_notes?.find(match)?.problem;
  return (
    <>
      <FrameFields call={call} row={row} change={change} number={number} />
      <Issue>{issue}</Issue>
    </>
  );
}

const WELD_SIDE_LABELS: Record<string, string> = { arrow: 'Arrow side', other: 'Other side', both: 'Both sides', centre: 'On the line' };

/** A weld symbol's values: the Weld tool's options, and a weld's properties. Sizes are the person's, in the sheet's
 *  units; an empty one is left out (nothing is assumed). */
export function WeldFields({ call, row, change, number }: { call: DrawingCall; row: Record<string, PyValue>; change: (patch: Record<string, PyValue | undefined>) => void; number?: number }) {
  const [bad, setBad] = useState<string | null>(null);
  const units = unitsOf(call);
  const type = text(row.type) || 'fillet';
  const sides = weldSides(type);
  const side = row.side === 'center' ? 'centre' : text(row.side) || sides[0];
  const write = (patch: Record<string, PyValue | undefined>) => {
    const problem = weldSpacingProblem(withWeld(row, patch));
    setBad(problem);
    if (!problem) change(patch);
  };
  const value = (key: 'size' | 'length' | 'pitch') => (typed: string) => {
    const parsed = parseWeldValue(typed);
    if (parsed === undefined) { setBad(`Write the ${key} in ${units === 'in' ? 'inches' : 'millimetres'}, more than 0, or leave it empty.`); return; }
    write({ [key]: parsed ?? undefined });
  };
  return (
    <div className={styles.stack} data-weld-form={number}>
      <div className={styles.grid}>
        <Field label="Type">
          <Select ariaLabel="Weld type" value={type} onChange={(next) => write({ type: next, side: weldSides(next).includes(side) ? side : undefined })}
            options={[...WELD_TYPES, ...((WELD_TYPES as readonly string[]).includes(type) ? [] : [type])].map((name) => ({ value: name, label: weldTypeName(name) }))} />
        </Field>
        <Field label="Side">
          <Select ariaLabel="Weld side" value={side} onChange={(next) => write({ side: next })}
            options={[...sides, ...(sides.includes(side) ? [] : [side])].map((name) => ({ value: name, label: WELD_SIDE_LABELS[name] ?? name }))} />
        </Field>
        <Field label={`Size (${units})`}>
          <Text label="Weld size" field="first" value={text(row.size)} placeholder="—" onCommit={value('size')} />
        </Field>
        <Field label={`Length (${units})`}>
          <Text label="Weld length" value={text(row.length)} placeholder="Continuous" onCommit={value('length')} />
        </Field>
        <Field label={`Pitch (${units})`}>
          <Text label="Weld pitch" value={text(row.pitch)} placeholder="—" onCommit={value('pitch')} />
        </Field>
        <Field label="Tail">
          <Text label="Weld tail" field="tail" value={text(row.tail)} placeholder="Process or note" onCommit={(typed) => write({ tail: typed.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || undefined })} />
        </Field>
      </div>
      <div className={styles.row}>All around
        <Switch label="Weld all around" checked={row.all_around === true} onCheckedChange={(on) => write({ all_around: on ? true : undefined })} />
      </div>
      <div className={styles.row}>Field weld
        <Switch label="Field weld" checked={row.field === true} onCheckedChange={(on) => write({ field: on ? true : undefined })} />
      </div>
      {bad && <Issue>{bad}</Issue>}
    </div>
  );
}

export function WeldForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const rows = weldRows(call);
  const row = rows?.[number - 1];
  if (!rows || !row) return <InCode />;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ welds: weldsText(rows.map((entry, i) => (i === number - 1 ? withWeld(entry, patch) : entry))) });
  const match = (item: { annotation?: string; index?: number | null }) => item.annotation === 'weld' && item.index === number;
  const issues = [...(report?.dangling ?? []), ...(report?.dimension_problems ?? [])].filter(match);
  const refs = weldRefs(row);
  const joint = Array.isArray(row.joint) ? row.joint.map(String) : null;
  const points = joint ? `the joint between ${joint.join(' and ')}` : typeof row.bead === 'string' ? `bead ${row.bead}` : `${refs.length} arrow${refs.length === 1 ? '' : 's'}: ${refs.join(', ')}`;
  return (
    <>
      <p className={styles.hint}>In {viewTitle(text(row.view) || orthographic(call)[0]?.name || 'front')}, to {points}. Drag it on the sheet to move it{hasLeaders(row) ? '; add or remove arrows from its menu' : ''}.</p>
      <WeldFields call={call} row={row} change={change} number={number} />
      {['at', 'place', 'offset'].some((key) => row[key] !== undefined) && (
        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => change({ at: undefined, place: undefined, offset: undefined })}>Reset placement</Button>
      )}
      {issues.map((item, i) => <Issue key={i}>{`Not drawn${item.refs.length ? ` (${item.refs.join(', ')})` : ''}: ${item.problem}`}</Issue>)}
    </>
  );
}

/* ───────── Tables and notes ───────── */

export function HoleTableForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const rows = holeTableRows(call);
  const row = rows[number - 1];
  if (!arg(call, 'hole_tables').editable || !row) return <InCode />;
  const change = (patch: Record<string, PyValue | undefined>) => edit({ hole_tables: pyList(rows.map((entry, i) => (i === number - 1 ? withKeys(entry, patch) : entry))) });
  const views = orthographic(call).map((view) => view.name);
  const holes = asList(row.holes).map(String);
  const drawn = report?.hole_tables?.find((table) => table.index === number);
  const issues = [...(report?.dangling ?? []), ...(report?.hole_problems ?? [])].filter((item) => item.annotation === 'hole' && item.index === number);
  return (
    <div className={styles.stack}>
      <Field label="View">
        <Select ariaLabel="Hole table view" value={text(row.view) || views[0] || 'top'} onChange={(value) => change({ view: value, holes: undefined, origin: undefined })}
          options={(views.length ? views : ['top']).map((name) => ({ value: name, label: viewTitle(name) }))} />
      </Field>
      <p className={styles.hint}>{holes.length ? `Lists ${holes.join(', ')}` : 'Lists every hole that shows round in the view'}{drawn ? ` (${drawn.holes} tagged)` : ''}, measured
        from {typeof row.origin === 'string' ? row.origin : 'the view’s lower-left corner'}. Pick other holes with Hole table.</p>
      <div className={styles.row}>
        {holes.length > 0 && <Button size="sm" variant="ghost" onClick={() => change({ holes: undefined })}>Every hole</Button>}
        {row.origin !== undefined && <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => change({ origin: undefined })}>From the lower left</Button>}
      </div>
      {issues.map((item, i) => <Issue key={i}>{`${item.refs.length ? `${item.refs.join(', ')}: ` : ''}${item.problem}`}</Issue>)}
    </div>
  );
}

export function RevisionsForm({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const revisions = arg(call, 'revisions');
  const rows = asList(revisions.value).map((row) => asDict(row));
  if (!revisions.editable) return <InCode />;
  const write = (next: Record<string, PyValue>[]) => edit({ revisions: next.length ? pyList(next) : undefined });
  const change = (index: number, key: string, value: string) => write(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  return (
    <div className={styles.stack}>
      {rows.map((row, index) => (
        <div key={index} className={styles.revision} data-revision={index}>
          <Text label="Revision" field={index === 0 ? 'first' : undefined} value={text(row.rev)} onCommit={(value) => change(index, 'rev', value)} />
          <Text label="What changed" value={text(row.description)} onCommit={(value) => change(index, 'description', value)} />
          <IconButton small label="Remove revision" onClick={() => write(rows.filter((_, i) => i !== index))}><X size={13} /></IconButton>
          <div className={styles.revisionMeta}>
            <Text label="Date" value={text(row.date)} placeholder="Date" onCommit={(value) => change(index, 'date', value)} />
            <Text label="By" value={text(row.by)} placeholder="By" onCommit={(value) => change(index, 'by', value)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The numbered notes (placed ones are their own items). */
export function NotesForm({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const notes = arg(call, 'notes');
  const rows = noteRows(call);
  const [draft, setDraft] = useState('');
  if (!notes.editable) return <InCode />;
  const listed = rows.map((row, index) => ({ row, index })).filter(({ row }) => isListedNote(row));
  const write = (next: typeof rows) => edit({ notes: notesText(next) });
  const add = () => { if (draft.trim()) write([...rows, draft.trim()]); setDraft(''); };
  return (
    <div className={styles.stack}>
      {listed.map(({ row, index }, n) => (
        <div key={index} className={styles.note}>
          <span>{n + 1}.</span>
          <Text label={`Note ${n + 1}`} field={n === 0 ? 'first' : undefined} value={typeof row === 'string' ? row : row.text}
            onCommit={(value) => write(value ? rows.map((item, i) => (i === index ? value : item)) : rows.filter((_, i) => i !== index))} />
          <IconButton small label="Remove note" onClick={() => write(rows.filter((_, i) => i !== index))}><X size={13} /></IconButton>
        </div>
      ))}
      <div className={styles.row}>
        <input className={ui.input} aria-label="New note" id="drawing-note-new" placeholder="Add a numbered note" value={draft} maxLength={TEXT_LIMIT}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} />
        <IconButton small label="Add note" disabled={!draft.trim()} onClick={add}><Plus size={14} /></IconButton>
      </div>
    </div>
  );
}

const NOTE_SIDES = ['up-right', 'up-left', 'down-right', 'down-left'] as const;

/** A note placed on the sheet: its text and where it is; a leader note's text, what it points at and its side. */
export function NoteForm({ call, edit, number, report }: { call: DrawingCall; edit: Edit; number: number; report?: DrawingSheet }) {
  const rows = noteRows(call);
  const row = rows[number - 1];
  if (!arg(call, 'notes').editable || !row || typeof row === 'string') return <InCode />;
  const change = (next: NoteRow) => edit({ notes: notesText(rows.map((entry, i) => (i === number - 1 ? next : entry))) });
  if (isLeaderNote(row)) {
    const issues = [...(report?.dangling ?? []), ...(report?.dimension_problems ?? [])].filter((item) => item.annotation === 'note' && item.index === number);
    const placed = (patch: Partial<NoteRow>) => { const next: NoteRow = { ...row, ...patch }; for (const key of ['side', 'offset', 'at'] as const) if (next[key] === undefined) delete next[key]; change(next); };
    return (
      <div className={styles.stack} data-note-form={number}>
        <p className={styles.hint}>In {viewTitle(row.view)}, pointing at {row.ref}. Drag it on the sheet to move it.</p>
        <Field label="Text"><Text label="Note text" field="first" value={row.text} onCommit={(value) => { if (value) change({ ...row, text: value }); }} /></Field>
        <Field label="Side">
          <Select ariaLabel="Note side" value={row.at ? 'at' : row.side ?? 'out'}
            onChange={(side) => placed({ side: side === 'out' || side === 'at' ? undefined : side, at: side === 'at' ? row.at : undefined, offset: side === 'at' ? undefined : row.offset })}
            options={[...(row.at ? ['at'] : []), 'out', ...NOTE_SIDES].map((side) => ({ value: side, label: side === 'at' ? 'Where it was dragged' : BALLOON_SIDE_LABELS[side] }))} />
        </Field>
        {['at', 'side', 'offset'].some((key) => row[key as keyof NoteRow] !== undefined) && (
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => placed({ at: undefined, side: undefined, offset: undefined })}>Reset placement</Button>
        )}
        {issues.map((item, i) => <Issue key={i}>{`Not drawn (${item.refs.join(', ')}): ${item.problem}`}</Issue>)}
      </div>
    );
  }
  const [x, y] = row.at ?? [0, 0];
  return (
    <div className={styles.stack}>
      <Field label="Text"><Text label="Note text" field="first" value={row.text} onCommit={(value) => { if (value) change({ ...row, text: value }); }} /></Field>
      <div className={styles.grid}>
        <Field label="From the left (mm)"><Text label="From the left" value={String(x)} onCommit={(value) => { if (Number.isFinite(Number(value))) change({ ...row, at: [Number(value), y] }); }} /></Field>
        <Field label="From the bottom (mm)"><Text label="From the bottom" value={String(y)} onCommit={(value) => { if (Number.isFinite(Number(value))) change({ ...row, at: [x, Number(value)] }); }} /></Field>
      </div>
    </div>
  );
}

export function PartsListForm({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const bom = arg(call, 'bom');
  if (!bom.editable) return <InCode />;
  if (Array.isArray(bom.value)) return <p className={styles.hint}>Its rows are written one by one in the code.</p>;
  return (
    <div className={styles.row}>Parts list on this sheet
      <Switch label="Parts list" checked={bom.value !== false && bom.value !== null} onCheckedChange={(on) => edit({ bom: on ? undefined : 'False' })} />
    </div>
  );
}

export function CutListForm({ call, edit }: { call: DrawingCall; edit: Edit }) {
  const cut = arg(call, 'cut_list');
  if (!cut.editable) return <InCode />;
  return (
    <div className={styles.row}>Cut list (each body’s stock size)
      <Switch label="Cut list" checked={cut.value === true} onCheckedChange={(on) => edit({ cut_list: on ? 'True' : undefined })} />
    </div>
  );
}
