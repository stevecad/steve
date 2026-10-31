/**
 * The properties of one element in a circuit file, as a form generated from tscircuit's prop schema. Every change is
 * a code edit (`../code`), handed to `onChange` with the new code; values the code computes are shown as read-only
 * code chips, never overwritten.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Code2, ExternalLink, Info, Search, X } from 'lucide-react';
import { Button, IconButton, Section, Select, Spinner, Switch, Tip } from '@/ui';
import { babelParseExpression } from '../code/parser';
import { parse } from '../code/source';
import { findElement, removeProp, renameElement, setPosition, setProp, setProps } from '../code/edits';
import { formatJs, staticValue, supplierPartsArrayForm } from '../code/values';
import { EditError, type Attr, type EditResult, type Element, type Span, type Target } from '../code/types';
import { partFor } from '../parts/catalog';
import { footprintFamily } from '../parts/footprints';
import { schemaFor, type Field, type FieldGroup } from '../parts/schema';
import { jlcQueryFor } from '../parts/jlcpcb';
import JlcSearch from '../palette/JlcSearch';
import { PartIcon } from '../palette/symbols';
import { useCircuitEngine } from './useEngine';
import { BoardReadiness, type Readiness } from './Readiness';
import styles from './Inspector.module.css';

/** Where tscircuit placed the part (the build's `metadata.components` entry), for parts placed automatically. */
export interface ResolvedPlacement {
  pcb?: { x: number; y: number; rotation?: number; layer?: string };
  sch?: { x: number; y: number };
}

export interface ElementInspectorProps {
  /** The circuit file's current code. */
  code: string;
  /** The element: its name, or `{ start }` (its offset) for unnamed elements such as traces and holes. */
  target: Target;
  /**
   * A change was made: the new code, the edit (with notes and the changed span), and the target to keep inspecting
   * (the new name after a rename).
   */
  onChange: (code: string, edit: EditResult, next: { target: Target }) => void;
  /** Shows a span in the Source panel ("Reveal in source", and computed values). */
  onReveal?: (span: Span) => void;
  /** Where the last build placed it, to show for parts without a written position. */
  resolved?: ResolvedPlacement | null;
  readOnly?: boolean;
  /** Shown under facts that already name the part (Properties): a slim name row instead of the full header. */
  compact?: boolean;
  /** The last build's Circuit JSON: where fixes put new parts, and which nets are power. */
  circuit?: readonly unknown[] | null;
  /** The last build's fabrication-readiness verdict: this element's issues and their fixes. */
  readiness?: Readiness | null;
}

/** Fields shown without "Show more": the ones people set most. Written and required fields always show. */
const ESSENTIAL = new Set([
  'displayName', 'text', 'net', 'connectsTo', 'from', 'to',
  'resistance', 'maxResistance', 'capacitance', 'inductance', 'frequency', 'loadCapacitance', 'color', 'type', 'variant', 'channelType', 'mosfetMode',
  'pinCount', 'gender', 'standard', 'voltage', 'current', 'currentRating', 'pinLabels', 'tolerance', 'maxVoltageRating',
  'footprint', 'manufacturerPartNumber', 'supplierPartNumbers',
  'pcbX', 'pcbY', 'pcbRotation', 'layer', 'schX', 'schY', 'schRotation',
  'width', 'height', 'diameter', 'holeDiameter', 'outerDiameter', 'shape', 'padDiameter', 'fontSize',
]);
const POSITION = new Set(['pcbX', 'pcbY', 'schX', 'schY']);
const ROTATION = new Set(['pcbRotation', 'schRotation']);
const UNSET = '__unset__';

const lastAttr = (element: Element, key: string): Attr | undefined => [...element.attrs].reverse().find((attr) => attr.name === key);

/** The element with the code it was read from: every edit runs on exactly that code. */
type Bound = Element & { code: string };

/** How a written value reads in a text field. */
function textOf(attr: Attr | undefined): string {
  if (!attr) return '';
  if (!attr.static) return attr.raw;
  if (attr.kind === 'flag') return 'true';
  if (typeof attr.value === 'string') return attr.value;
  if (typeof attr.value === 'number') return String(attr.value);
  return formatJs(attr.value);
}

/** A text box that commits on Enter or blur and reverts on Escape. */
function TextInput({ value, onCommit, placeholder, mono, label, list, invalid, disabled }: {
  value: string; onCommit: (text: string) => void; placeholder?: string; mono?: boolean; label: string; list?: string; invalid?: boolean; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => { setDraft(null); if (text !== value) onCommit(text); };
  return (
    <input
      className={styles.input} data-mono={mono || undefined} data-invalid={invalid || undefined} aria-label={label} list={list} placeholder={placeholder} disabled={disabled}
      spellCheck={false} value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { commit((event.target as HTMLInputElement).value); (event.target as HTMLInputElement).blur(); }
        if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); event.stopPropagation(); }
      }}
    />
  );
}

/** A value the code computes: shown as code, edited in the source. */
function ComputedChip({ attr, onReveal }: { attr: Attr; onReveal?: (span: Span) => void }) {
  const raw = attr.raw.replace(/^\{([\s\S]*)\}$/, '$1');
  return (
    <span className={styles.computed}>
      <code title={raw}>{raw}</code>
      {onReveal && <button type="button" className={styles.link} onClick={() => onReveal(attr.span)}>Edit in source</button>}
    </span>
  );
}

type Apply = (run: () => EditResult, field?: string, next?: Target) => void;

/** What a typed value means for a field: a value, `undefined` to remove it, or an Error to show. */
function interpret(field: Field, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return field.required ? new Error(`${field.label} is required.`) : undefined;
  switch (field.kind) {
    case 'unit': return /^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : trimmed;
    case 'number':
    case 'integer': {
      const number = Number(trimmed);
      if (!Number.isFinite(number)) return new Error(`${field.label} needs a number.`);
      if (field.kind === 'integer' && !Number.isInteger(number)) return new Error(`${field.label} needs a whole number.`);
      return number;
    }
    case 'code': {
      try {
        const literal = staticValue(babelParseExpression(trimmed));
        if (literal.static) return literal.value;
      } catch { /* not a value */ }
      return new Error('Write a value: a number, "text", { key: "value" } or ["a", "b"].');
    }
    default: return text;
  }
}

function FieldControl({ field, element, attr, apply, onReveal, readOnly, listId }: {
  field: Field; element: Bound; attr: Attr | undefined; apply: Apply; onReveal?: (span: Span) => void; readOnly?: boolean; listId: string;
}) {
  const here: Target = { start: element.span.start };
  if (attr && !attr.static) return <ComputedChip attr={attr} onReveal={onReveal} />;
  const commit = (value: unknown) => {
    if (value instanceof Error) { const message = value.message; apply(() => { throw new EditError('invalid', message); }, field.key); return; }
    if (value === undefined) { apply(() => removeProp(element.code, here, field.key), field.key); return; }
    if (POSITION.has(field.key) && typeof value === 'number') { apply(() => setPosition(element.code, here, { [field.key]: value }), field.key); return; }
    if (ROTATION.has(field.key) && typeof value === 'number' && typeof attr?.value === 'string') value = `${value}deg`;
    apply(() => setProp(element.code, here, field.key, value), field.key);
  };
  switch (field.kind) {
    case 'boolean':
      return <Switch label={field.label} checked={attr?.value === true} disabled={readOnly} onCheckedChange={(checked) => commit(checked ? true : undefined)} />;
    case 'enum': {
      const current = attr && attr.static && (typeof attr.value === 'string' || typeof attr.value === 'number' || typeof attr.value === 'boolean') ? String(attr.value) : UNSET;
      const options = [{ value: UNSET, label: field.required ? 'Choose…' : '—' }, ...(field.options ?? []).map((option) => ({ value: String(option), label: String(option) }))];
      if (current !== UNSET && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
      return (
        <Select ariaLabel={field.label} value={current} options={options} disabled={readOnly}
          onChange={(next) => commit(next === UNSET ? undefined : field.options?.find((option) => String(option) === next) ?? next)} />
      );
    }
    default: {
      const footprint = field.key === 'footprint';
      // "30mm" already says its unit: the hint would read "30mm mm".
      const unit = field.unit && !textOf(attr).trim().endsWith(field.unit) ? field.unit : undefined;
      return (
        <div className={styles.valueStack}>
          <div className={styles.inputWrap} data-unit={unit}>
            <TextInput label={field.label} value={textOf(attr)} mono={field.kind === 'code' || field.kind === 'unit' || footprint}
              placeholder={field.required ? 'Required' : POSITION.has(field.key) ? 'auto' : field.kind === 'code' ? 'value' : '—'}
              list={footprint && field.suggestions?.length ? listId : undefined} disabled={readOnly}
              onCommit={(text) => commit(interpret(field, text))} />
            {unit && <span className={styles.unit}>{unit}</span>}
          </div>
          {footprint && field.suggestions?.length ? (
            <>
              <datalist id={listId}>{field.suggestions.map((name) => <option key={name} value={name} />)}</datalist>
              {!readOnly && (
                <div className={styles.chips} role="list" aria-label="Common footprints">
                  {field.suggestions.slice(0, 6).map((name) => (
                    <button key={name} type="button" role="listitem" className={styles.chip} data-on={attr && footprintFamily(String(attr.value)) === name || undefined} onClick={() => commit(name)}>{name}</button>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      );
    }
  }
}

function Row({ field, element, apply, onReveal, readOnly, error }: { field: Field; element: Bound; apply: Apply; onReveal?: (span: Span) => void; readOnly?: boolean; error?: string }) {
  const listId = useId();
  const attr = lastAttr(element, field.key);
  const removable = !readOnly && !!attr && attr.static && !field.required && field.key !== 'name';
  return (
    <div className={styles.row} data-field={field.key} data-written={attr ? true : undefined} data-error={error ? true : undefined} data-stack={field.key === 'footprint' && !readOnly || undefined}>
      <span className={styles.label}>
        {field.description ? <Tip label={field.label} description={field.description}><span>{field.label}</span></Tip> : field.label}
        {field.required && <i className={styles.required} aria-label="required">•</i>}
      </span>
      <div className={styles.value}>
        <FieldControl field={field} element={element} attr={attr} apply={apply} onReveal={onReveal} readOnly={readOnly} listId={listId} />
        {removable && (
          <IconButton small label={`Remove ${field.label}`} description="Remove it from the code (back to tscircuit’s default)" className={styles.remove}
            onClick={() => apply(() => removeProp(element.code, { start: element.span.start }, field.key), field.key)}><X /></IconButton>
        )}
      </div>
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
    </div>
  );
}

function GroupSection({ group, fields, element, apply, onReveal, readOnly, error, hint }: {
  group: FieldGroup; fields: Field[]; element: Bound; apply: Apply; onReveal?: (span: Span) => void; readOnly?: boolean; error: { field?: string; text: string } | null; hint?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = fields.filter((field) => all || field.required || ESSENTIAL.has(field.key) || lastAttr(element, field.key));
  const hidden = fields.length - shown.length;
  if (!shown.length && !hidden) return null;
  return (
    <Section title={group} id={`circuit-${group.toLowerCase().replace(/\s+/g, '-')}`} defaultOpen={group !== 'Advanced' || element.attrs.some((attr) => fields.some((field) => field.key === attr.name))}>
      <div className={styles.rows}>
        {shown.map((field) => <Row key={field.key} field={field} element={element} apply={apply} onReveal={onReveal} readOnly={readOnly} error={error?.field === field.key ? error.text : undefined} />)}
        {hint}
        {(hidden > 0 || all) && (
          <button type="button" className={styles.more} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${hidden} more`}</button>
        )}
      </div>
    </Section>
  );
}

/** Fields for written props the schema doesn't list (and for user components, which have no schema). */
function extraFields(element: Element, known: Set<string>): Field[] {
  return element.attrs.filter((attr) => !known.has(attr.name) && attr.name !== 'key' && attr.name !== 'children').map((attr): Field => ({
    key: attr.name, label: attr.name, group: 'Advanced', required: false, schema: {},
    kind: !attr.static ? 'code' : attr.kind === 'flag' || attr.kind === 'boolean' ? 'boolean' : attr.kind === 'number' ? 'number' : attr.kind === 'string' ? 'text' : 'code',
  }));
}

/** Elements a board house doesn't source a part for: features, simulation sources, structure. */
const UNSOURCED = new Set(['testpoint', 'fiducial', 'hole', 'platedhole', 'solderjumper', 'via', 'group', 'subcircuit', 'net', 'netlabel',
  'powersource', 'voltagesource', 'currentsource', 'ammeter', 'voltageprobe', 'interconnect', 'mountedboard', 'board']);

/**
 * Which real part this is (docs/ELECTRONICS_RESEARCH.md SRC-01, ASM-09): pinned to a JLCPCB part, not placed by the
 * assembler, or neither, with a search to pick one. A part number written as plain text is offered a one-click fix.
 */
function Sourcing({ element, apply, readOnly }: { element: Bound; apply: Apply; readOnly?: boolean }) {
  const [searching, setSearching] = useState(false);
  const attr = lastAttr(element, 'supplierPartNumbers');
  const props = Object.fromEntries(element.attrs.filter((item) => item.static).map((item) => [item.name, item.value]));
  const here: Target = { start: element.span.start };
  if (attr && attr.static && supplierPartsArrayForm(attr.value).repaired) {
    return (
      <p className={styles.banner} data-tone="danger" id="circuit-sourcing" data-state="text">
        <AlertTriangle size={13} />
        <span>Its supplier part number is written as text, and tscircuit drops a part written that way.{' '}
          {!readOnly && <button type="button" className={styles.link} onClick={() => apply(() => setProp(element.code, here, 'supplierPartNumbers', attr.value), 'supplierPartNumbers')}>Fix it</button>}
        </span>
      </p>
    );
  }
  const jlc = attr?.static && attr.value && typeof attr.value === 'object' ? ((attr.value as Record<string, unknown>).jlcpcb as unknown[] | undefined) : undefined;
  const lcsc = Array.isArray(jlc) && typeof jlc[0] === 'string' ? jlc[0] : null;
  const search = searching && !readOnly ? (
    <div className={styles.sourceSearch}>
      <JlcSearch code={element.code} autoFocus initialQuery={jlcQueryFor(element.tag, props)}
        onPick={(part, found) => {
          const values = found.tag === element.tag ? found.props : {};
          apply(() => setProps(element.code, here, { ...values, footprint: part.footprint, supplierPartNumbers: { jlcpcb: [part.lcsc] }, manufacturerPartNumber: part.mpn }), 'supplierPartNumbers');
          setSearching(false);
        }} />
      <button type="button" className={styles.more} onClick={() => setSearching(false)}>Cancel</button>
    </div>
  ) : null;
  if (lcsc) {
    return (
      <div className={styles.sourcing} id="circuit-sourcing" data-state="pinned">
        <CheckCircle2 size={14} className={styles.ok} />
        <span className={styles.sourceText}><b>JLCPCB {lcsc}</b>{typeof props.manufacturerPartNumber === 'string' && <small>{props.manufacturerPartNumber}</small>}</span>
        <a className={styles.link} href={`https://jlcpcb.com/partdetail/${lcsc}`} target="_blank" rel="noreferrer" title="Open on JLCPCB"><ExternalLink size={12} /></a>
        {!readOnly && !searching && <Button size="sm" variant="ghost" onClick={() => setSearching(true)}>Change</Button>}
        {search}
      </div>
    );
  }
  if (props.doNotPlace === true) {
    return <p className={styles.banner} id="circuit-sourcing" data-state="dnp"><Info size={13} /> Not placed by the assembler (doNotPlace): hand-solder it or leave it off.</p>;
  }
  return (
    <div className={styles.sourcing} id="circuit-sourcing" data-state="missing" data-tone="warn">
      <AlertTriangle size={14} className={styles.warn} />
      <span className={styles.sourceText}><b>No supplier part: pick one</b><small>The board house needs a real, in-stock part to assemble this.</small></span>
      {!readOnly && !searching && <Button size="sm" icon={<Search />} onClick={() => setSearching(true)} id="circuit-find-part">Find on JLCPCB</Button>}
      {search}
    </div>
  );
}

const fmt = (value: number) => (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '').replace(/^-0$/, '0');

function InspectorBody({ code, target, onChange, onReveal, resolved, readOnly, compact, circuit = null, readiness = null }: ElementInspectorProps) {
  const index = useMemo(() => parse(code), [code]);
  const found = useMemo(() => findElement(index, target), [index, target]);
  const [message, setMessage] = useState<{ tone: 'error' | 'note'; text: string; field?: string } | null>(null);
  useEffect(() => {
    if (!message || message.tone === 'error') return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!found) {
    if (index.errors.length) {
      const error = index.errors[0];
      return <div className={styles.empty} role="status"><AlertTriangle size={14} /> The code has a problem on line {error.line}: {error.message} Fix it in the source to edit properties.</div>;
    }
    return <div className={styles.empty} role="status">{typeof target === 'string' ? target : 'That element'} isn’t written by name in this file: it may come from another file or a loop. Find it in the source.</div>;
  }
  // The edits re-read the code by offset, so they always see this render's code.
  const element: Bound = { ...found, code };
  const part = partFor(element.tag);
  const schema = element.intrinsic ? schemaFor(element.tag) : null;
  const known = new Set(schema?.fields.map((field) => field.key) ?? []);
  const groups = schema ? schema.groups.map((entry) => ({ ...entry })) : [];
  const extras = extraFields(element, known);
  if (extras.length) {
    const advanced = groups.find((entry) => entry.group === 'Advanced');
    if (advanced) advanced.fields = [...advanced.fields, ...extras]; else groups.push({ group: 'Advanced', fields: extras });
  }
  const nameTarget = (name: string | null): Target => (name ? name : { start: element.span.start });
  const apply: Apply = (run, field, next) => {
    try {
      const edit = run();
      setMessage(edit.notes.length ? { tone: 'note', text: edit.notes.join(' ') } : null);
      if (edit.changed) onChange(edit.code, edit, { target: next ?? nameTarget(element.name) });
    } catch (error) {
      if (error instanceof EditError) setMessage({ tone: 'error', text: error.message, field });
      else throw error;
    }
  };
  const nameAttr = lastAttr(element, 'name');
  const placedPcb = !lastAttr(element, 'pcbX') && !lastAttr(element, 'pcbY') && !lastAttr(element, 'pcbLeftEdgeX') && resolved?.pcb;
  const placedSch = !lastAttr(element, 'schX') && !lastAttr(element, 'schY') && resolved?.sch;
  const hints: Partial<Record<FieldGroup, ReactNode>> = {
    'PCB placement': placedPcb ? <p className={styles.hint}><Info size={12} /> Placed automatically at {fmt(placedPcb.x)}, {fmt(placedPcb.y)} mm on the board. Drag it on the board, or type a position.</p> : undefined,
    Schematic: placedSch ? <p className={styles.hint}><Info size={12} /> Placed automatically at {fmt(placedSch.x)}, {fmt(placedSch.y)} in the schematic.</p> : undefined,
  };

  return (
    <div className={styles.inspector} data-tag={element.tag} id="circuit-properties">
      <header className={styles.header} data-compact={compact || undefined}>
        {!compact && <span className={styles.glyph}><PartIcon tag={element.tag} size={22} /></span>}
        <div className={styles.titles}>
          {!compact && <span className={styles.kind}>{part?.label ?? element.tag}<code>&lt;{element.tag}&gt;</code></span>}
          {nameAttr && !nameAttr.static ? <ComputedChip attr={nameAttr} onReveal={onReveal} /> : nameAttr || part?.prefix ? (
            <TextInput label="Name" mono value={element.name ?? ''} disabled={readOnly} placeholder="Name"
              onCommit={(text) => {
                const name = text.trim();
                if (!name) { setMessage({ tone: 'error', text: 'A part needs a name.', field: 'name' }); return; }
                apply(() => (element.name ? renameElement(code, { start: element.span.start }, name) : setProp(code, { start: element.span.start }, 'name', name)), 'name', name);
              }} />
          ) : <span className={styles.unnamed}>Line {element.line}</span>}
        </div>
        {onReveal && <IconButton label="Reveal in source" description={`Line ${element.line}`} onClick={() => onReveal(element.span)}><Code2 /></IconButton>}
      </header>

      {element.scope !== 'main' && (
        <p className={styles.banner} data-tone="warn"><AlertTriangle size={13} />
          {element.scope === 'callback' ? 'Written inside a function (a loop or map): it may be drawn many times, and every copy changes.' : `Part of ${element.owner ?? 'a component'}: every place it’s used changes.`}
        </p>
      )}
      {element.spread && <p className={styles.banner}><Info size={13} /> Some props come from a {'{...spread}'} and aren’t shown.</p>}
      {!element.intrinsic && <p className={styles.banner}><Info size={13} /> {element.tag} is a component written in code; its props are whatever it takes.</p>}
      {element.intrinsic && !UNSOURCED.has(element.tag) && (schema?.fields.some((field) => field.key === 'supplierPartNumbers') ?? false) && <Sourcing element={element} apply={apply} readOnly={readOnly} />}
      {/* Readiness issues and their fix buttons are listed once, by the workspace (CircuitInspector, through fixFor). */}
      {element.tag === 'board' && <BoardReadiness element={element} code={code} readiness={readiness} circuit={circuit} index={index} onFix={(fix) => apply(fix.run)} readOnly={readOnly} />}
      {message && (
        <p className={styles.banner} data-tone={message.tone === 'error' ? 'danger' : undefined} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.tone === 'error' ? <AlertTriangle size={13} /> : <Info size={13} />}{message.text}
        </p>
      )}

      {groups.filter((entry) => !(entry.group === 'General' && entry.fields.every((field) => field.key === 'name'))).map((entry) => (
        <GroupSection key={entry.group} group={entry.group} fields={entry.fields.filter((field) => field.key !== 'name')} element={element} apply={apply}
          onReveal={onReveal} readOnly={readOnly} error={message?.tone === 'error' ? message : null} hint={hints[entry.group]} />
      ))}
    </div>
  );
}

/** The properties inspector for one element of a circuit file. Loads the parser and prop schemas on first use. */
export default function ElementInspector(props: ElementInspectorProps) {
  const { ready, error } = useCircuitEngine();
  if (error) return <div className={styles.empty} role="alert"><AlertTriangle size={14} /> Couldn’t load the property forms: {error}</div>;
  if (!ready) return <div className={styles.empty} role="status"><Spinner /> Loading properties…</div>;
  return <InspectorBody {...props} />;
}
