/**
 * A form generated from a JSON schema (the manufacturing library's OpenAPI definitions): objects, Vec3 tuples,
 * lists, maps, enums, nullable fields, discriminated unions and library pins. Read-only mode renders the same
 * structure as text. Field errors from the server are shown at their path.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import type { Kind, LibraryRecord, Pin } from './api';
import FieldMarks, { MarkCount, type FieldNote } from '@/setup/FieldMarks';
import type { FieldSource } from './provenance';
import { defaultFor, isPinSchema, labelOf, limitsOf, valueLabel, pinKindsFor, resolve, typeOf, unitOf, unwrapNullable, type OpenApi, type Schema, shownField, shownOptions } from './schema';
import { slugFor } from './fieldHelp';
import { NumberField } from '@/ui';
import { draftNumber } from './TextNumber';
import styles from './Manufacture.module.css';

export interface FormContext {
  api: OpenApi;
  readOnly: boolean;
  errors: Map<string, string>;
  records: LibraryRecord[];
  /** The kind of record the form edits: what its pin fields can name depends on it (a turning assembly's holder). */
  kind?: Kind | null;
  /** Fields rendered elsewhere (e.g. a post's source in its code editor). */
  skip?: Set<string>;
  onOpenPin?: (pin: Pin) => void;
  /** Where values came from, by field path: saved with the record, or drafted by Set up with STEVE. */
  annotations?: Map<string, FieldNote>;
  /** While editing: sets (or with null removes) a field's source by hand. */
  onSetSource?: (path: string, claim: FieldSource | null) => void;
  /** Controller dialects the backend knows: whether Steve can post and verify programs for each (from /capabilities),
   *  and the others named by posts and controllers in the library. */
  dialects?: { id: string; executable: boolean }[];
  /** Top-level fields people rarely know or need (sensible defaults filled in): under a collapsed "More details". */
  details?: Set<string>;
  /** Fields the contract requires but that are filled in when left blank: not marked required. */
  filled?: Set<string>;
  /** Fields with their own control, by path (a preset's operations as chips of what its cutter can do). */
  controls?: Record<string, (props: ControlProps) => ReactNode>;
}

type Change = (value: unknown) => void;
export interface ControlProps { value: unknown; onChange: Change; context: FormContext; schema: Schema; path: string }

const HIDDEN = new Set(['version', 'kind']);
const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

function fieldError(context: FormContext, path: string): string | undefined {
  return context.errors.get(path) ?? context.errors.get(`definition.${path}`);
}

/** The contract's own description of a field (Codex adds them to the schema), shown as help under it. */
const Help = ({ schema }: { schema: Schema }) => (schema.description ? <small className={styles.fieldHelp}>{schema.description}</small> : null);

/** A controller's dialect: a choice of the dialects the backend knows, a short ID for any other, and what it means. */
function DialectInput({ value, onChange, context, schema }: { value: unknown; onChange: Change; context: FormContext; schema: Schema }) {
  const list = useId();
  const dialects = context.dialects ?? [];
  const runs = dialects.filter((item) => item.executable).map((item) => item.id);
  const current = typeof value === 'string' ? value : '';
  const known = dialects.find((item) => item.id === current);
  const slug = slugFor(schema.pattern, current);
  return (
    <>
      {context.readOnly ? <span className={styles.readValue}><code>{current || '—'}</code></span> : (
        <>
          <input className={styles.input} aria-label="Dialect" list={list} value={current} placeholder="Choose or type an ID" onChange={(event) => onChange(event.target.value)} data-path="dialect" />
          <datalist id={list}>{dialects.map((item) => <option key={item.id} value={item.id}>{item.executable ? 'Steve can post and verify programs' : 'Saved only'}</option>)}</datalist>
        </>
      )}
      {!context.readOnly && slug && <SlugHint slug={slug} onChange={onChange} />}
      <small className={styles.fieldHelp} id="dialect-help">
        The G-code flavour this controller reads. {runs.length ? <>Steve can post and verify: {runs.map((id, index) => <span key={id}>{index ? ', ' : ''}<code>{id}</code></span>)}. </> : null}
        Others can be saved but can’t run programs yet.
        {current && !slug && (known?.executable ? ' This one can run programs.' : ' This one is saved only for now.')}
      </small>
    </>
  );
}

function Label({ name, schema, required, note, onSet }: { name: string; schema: Schema; required?: boolean; note?: FieldNote; onSet?: (claim: FieldSource | null) => void }) {
  const unit = unitOf(name);
  return (
    <span className={styles.fieldLabel} title={schema.description || undefined}>
      {labelOf(name)}{unit && <em>{unit}</em>}{required && <i aria-hidden>*</i>}
      <FieldMarks note={note} label={labelOf(name)} onSet={onSet} />
    </span>
  );
}

const noteAt = (context: FormContext, path: string) => context.annotations?.get(path);
/** Marks inside a collapsed group. */
function marksUnder(context: FormContext, path: string) {
  let sourced = 0, estimated = 0;
  for (const [key, note] of context.annotations ?? []) {
    if (!key.startsWith(`${path}.`)) continue;
    if (note.estimate) estimated += 1;
    else if (note.kind || note.sources?.length) sourced += 1;
  }
  return { sourced, estimated };
}
/** A scalar field's source can be set by hand while editing. */
const sourceSetter = (context: FormContext, path: string) =>
  (!context.readOnly && context.onSetSource ? (claim: FieldSource | null) => context.onSetSource!(path, claim) : undefined);

function NumberInput({ value, schema, onChange, readOnly, label }: { value: unknown; schema: Schema; onChange: Change; readOnly: boolean; label: string }) {
  const { min, max, integer } = limitsOf(schema);
  if (readOnly) return <span className={styles.readValue}>{isEmpty(value) ? '—' : String(value)}</span>;
  // Clearing it saves null, as before; the server's checks (and their messages at the field) stay the authority.
  return (
    <NumberField className={styles.input} unit="" optional eager ariaLabel={label} min={min} max={max} integer={integer}
      value={typeof value === 'number' ? value : typeof value === 'string' ? draftNumber(value) : undefined}
      onChange={(next) => onChange(next === undefined ? null : next)} />
  );
}

function PinPicker({ name, value, context, onChange }: { name: string; value: Pin | null; context: FormContext; onChange: Change }) {
  const kinds = pinKindsFor(name, context.kind);
  const kind = kinds.length === 1 ? kinds[0] : null;
  const options = context.records.filter((record) => !kinds.length || kinds.includes(record.kind));
  const current = value ? context.records.find((record) => record.id === value.id) : undefined;
  const text = value ? `${current?.definition.name ?? value.id.slice(0, 8)} · rev ${value.revision}` : '—';
  if (context.readOnly) {
    return value ? <button type="button" className={styles.pinLink} onClick={() => context.onOpenPin?.(value)} data-pin={value.id}>{text}</button> : <span className={styles.readValue}>—</span>;
  }
  return (
    <span className={styles.pinRow}>
      <select className={styles.input} aria-label={labelOf(name)} value={value?.id ?? ''} onChange={(event) => {
        const record = options.find((item) => item.id === event.target.value);
        onChange(record ? { id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 } : null);
      }}>
        <option value="">Choose {kind ? labelOf(kind).toLowerCase() : 'a record'}…</option>
        {options.map((record) => <option key={record.id} value={record.id}>{record.definition.name} · rev {record.revision}{record.archived ? ' (archived)' : ''}</option>)}
      </select>
      {value && current && current.revision !== value.revision && (
        <button type="button" className={styles.linkButton} title={`Pinned to revision ${value.revision}; revision ${current.revision} is the latest. Pins never move on their own.`}
          onClick={() => onChange({ id: current.id, revision: current.revision, kind: current.kind, sha256: current.sha256 })}>Use rev {current.revision}</button>
      )}
    </span>
  );
}

function Scalar({ name, schema, value, onChange, context, path }: { name: string; schema: Schema; value: unknown; onChange: Change; context: FormContext; path: string }) {
  const type = typeOf(schema);
  const label = labelOf(name);
  if (type === 'const') return <span className={styles.readValue}>{String(schema.const)}</span>;
  if (type === 'enum') {
    if (context.readOnly) return <span className={styles.readValue}>{isEmpty(value) ? '—' : valueLabel(String(value))}</span>;
    return (
      <select className={styles.input} aria-label={label} value={value === undefined || value === null ? '' : String(value)} onChange={(event) => {
        const picked = schema.enum!.find((option) => String(option) === event.target.value);
        onChange(picked ?? event.target.value);
      }}>
        {isEmpty(value) && <option value="">Choose…</option>}
        {shownOptions(schema.enum!, value).map((option) => <option key={String(option)} value={String(option)}>{valueLabel(String(option))}</option>)}
      </select>
    );
  }
  if (type === 'boolean') {
    return <input type="checkbox" className={styles.checkbox} aria-label={label} checked={value === true} disabled={context.readOnly} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (type === 'number' || type === 'integer') return <NumberInput value={value} schema={schema} onChange={onChange} readOnly={context.readOnly} label={label} />;
  const long = (schema.maxLength ?? 0) > 400 || name === 'description';
  if (context.readOnly) return <span className={styles.readValue} data-long={long || undefined}>{isEmpty(value) ? '—' : String(value)}</span>;
  if (long) return <textarea className={styles.textarea} aria-label={label} value={String(value ?? '')} rows={2} maxLength={schema.maxLength} onChange={(event) => onChange(event.target.value)} />;
  return <input className={styles.input} aria-label={label} value={String(value ?? '')} maxLength={schema.maxLength} onChange={(event) => onChange(event.target.value)} data-path={path} />;
}

/** A field that takes a short ID: the ID for what was typed, offered instead of a rejection at save. */
function SlugHint({ slug, onChange }: { slug: string; onChange: Change }) {
  return <span className={styles.slugHint} data-slug-hint>Use a short ID: letters, digits, _ or -, no spaces. <button type="button" className={styles.linkButton} onClick={() => onChange(slug)}>Use {slug}</button></span>;
}

function Field({ name, schema: raw, value, onChange, context, path, required }: {
  name: string; schema: Schema; value: unknown; onChange: Change; context: FormContext; path: string; required?: boolean;
}) {
  const { api } = context;
  const { schema, nullable } = unwrapNullable(api, raw);
  const error = fieldError(context, path);
  const type = typeOf(schema);
  if (context.filled?.has(path)) required = false;  // Filled in when blank: optional to the person.
  // Nullable or optional complex values can be added and removed.
  if ((nullable || !required) && value === undefined || (nullable && value === null && (type === 'object' || type === 'array' || isPinSchema(schema)))) {
    if (context.readOnly) return <div className={styles.field}><Label name={name} schema={schema} /><span className={styles.readValue}>—</span></div>;
    if (type === 'object' || type === 'array' || isPinSchema(schema) || schema.oneOf) {
      return (
        <div className={styles.field}>
          <Label name={name} schema={schema} />
          <button type="button" className={styles.linkButton} onClick={() => onChange(defaultFor(api, schema))}><Plus size={12} />Add</button>
        </div>
      );
    }
  }
  const control = context.controls?.[path];
  if (control) {
    return (
      <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
        <Label name={name} schema={schema} required={required} note={noteAt(context, path)} onSet={sourceSetter(context, path)} />
        <span className={styles.fieldValue} data-stack>{control({ value, onChange, context, schema, path })}</span>
        {error && <small className={styles.fieldError} data-field-error>{error}</small>}
        <Help schema={{ ...schema, description: schema.description ?? raw.description }} />
      </div>
    );
  }
  if (isPinSchema(schema)) {
    return (
      <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
        <Label name={name} schema={schema} required={required} note={noteAt(context, path)} />
        <PinPicker name={name} value={(value as Pin) ?? null} context={context} onChange={onChange} />
        {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      </div>
    );
  }
  if (schema.oneOf && schema.discriminator) return <Union name={name} schema={schema} value={value} onChange={onChange} context={context} path={path} />;
  if (type === 'object' && (schema.properties || schema.patternProperties || typeof schema.additionalProperties === 'object')) {
    return <Group name={name} schema={schema} value={(value as Record<string, unknown>) ?? {}} onChange={onChange} context={context} path={path} />;
  }
  if (type === 'array') return <List name={name} schema={schema} value={(value as unknown[]) ?? []} onChange={onChange} context={context} path={path} required={required} />;
  const dialect = path === 'dialect' && type === 'string' && !!context.dialects;
  return (
    <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
      <Label name={name} schema={schema} required={required} note={noteAt(context, path)} onSet={sourceSetter(context, path)} />
      <span className={styles.fieldValue} data-stack={dialect || undefined}>
        {dialect ? <DialectInput value={value} onChange={onChange} context={context} schema={schema} />
          : <Scalar name={name} schema={schema} value={value} context={context} path={path}
            onChange={nullable && type === 'string' ? (next) => onChange(next === '' ? null : next) : onChange} />}
        {nullable && !context.readOnly && value !== null && value !== undefined && <button type="button" className={styles.clear} aria-label={`Clear ${labelOf(name)}`} onClick={() => onChange(null)}><X size={11} /></button>}
      </span>
      {!dialect && !context.readOnly && type === 'string' && slugFor(schema.pattern, value) && <SlugHint slug={slugFor(schema.pattern, value)!} onChange={onChange} />}
      {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      {!dialect && <Help schema={schema} />}
    </div>
  );
}

function Properties({ schema, value, onChange, context, path }: { schema: Schema; value: Record<string, unknown>; onChange: Change; context: FormContext; path: string }) {
  // Constant `version`/`kind` markers are bookkeeping, not settings.
  const entries = Object.entries(schema.properties ?? {}).filter(([key, property]) =>
    !(HIDDEN.has(key) && resolve(context.api, property).const !== undefined) && !(path === '' && context.skip?.has(key)) && shownField(key, value?.[key]));
  const map = schema.patternProperties ? Object.values(schema.patternProperties)[0] : typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null;
  const field = ([key, property]: [string, Schema]) => (
    <Field key={key} name={key} schema={property} value={value[key]} context={context} path={path ? `${path}.${key}` : key}
      required={schema.required?.includes(key)} onChange={(next) => {
        const copy = { ...value };
        if (next === undefined) delete copy[key]; else copy[key] = next;
        onChange(copy);
      }} />
  );
  // The form leads with what a person knows; the rest (with sensible defaults) waits under "More details".
  const extra = path === '' && context.details ? entries.filter(([key]) => context.details!.has(key)) : [];
  return (
    <>
      {entries.filter((entry) => !extra.includes(entry)).map(field)}
      {extra.length > 0 && <MoreDetails keys={extra.map(([key]) => key)} context={context}>{extra.map(field)}</MoreDetails>}
      {map && <MapEntries schema={map} value={value} onChange={onChange} context={context} path={path} known={new Set(entries.map(([key]) => key))} />}
    </>
  );
}

function MoreDetails({ keys, context, children }: { keys: string[]; context: FormContext; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // A problem or a source inside opens it: nothing that needs attention stays hidden.
  const inside = (key: string) => [...context.errors.keys()].some((path) => path === key || path.startsWith(`${key}.`));
  const shown = open || keys.some(inside);
  let sourced = 0, estimated = 0;
  for (const key of keys) {
    const marks = marksUnder(context, key);
    const own = context.annotations?.get(key);
    sourced += marks.sourced + (own && !own.estimate ? 1 : 0);
    estimated += marks.estimated + (own?.estimate ? 1 : 0);
  }
  return (
    <div className={styles.group} data-open={shown || undefined} data-path="more-details" id="more-details">
      <button type="button" className={styles.groupHead} onClick={() => setOpen(!shown)} aria-expanded={shown}>
        <ChevronRight size={13} className={styles.chevron} /><span className={styles.fieldLabel}>More details</span>
        {!shown && <MarkCount sourced={sourced} estimated={estimated} />}
        {!shown && <span className={styles.groupSummary}>{keys.length} fields with defaults · change them only if you know them</span>}
      </button>
      {shown && <div className={styles.groupBody}>{children}</div>}
    </div>
  );
}

function MapEntries({ schema, value, onChange, context, path, known }: { schema: Schema; value: Record<string, unknown>; onChange: Change; context: FormContext; path: string; known: Set<string> }) {
  const [key, setKey] = useState('');
  const keys = Object.keys(value).filter((name) => !known.has(name));
  return (
    <div className={styles.mapBlock}>
      {keys.map((name) => (
        <div key={name} className={styles.card}>
          <div className={styles.cardHead}><code>{name}</code>{!context.readOnly && <button type="button" className={styles.clear} aria-label={`Remove ${name}`} onClick={() => { const copy = { ...value }; delete copy[name]; onChange(copy); }}><X size={11} /></button>}</div>
          <Field name={name} schema={schema} value={value[name]} context={context} path={`${path}.${name}`} required onChange={(next) => onChange({ ...value, [name]: next })} />
        </div>
      ))}
      {!context.readOnly && (
        <span className={styles.addRow}>
          <input className={styles.input} placeholder="new_key" aria-label="New entry name" value={key} onChange={(event) => setKey(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} />
          <button type="button" className={styles.linkButton} disabled={!key || key in value} onClick={() => { onChange({ ...value, [key]: defaultFor(context.api, schema) }); setKey(''); }}><Plus size={12} />Add entry</button>
        </span>
      )}
    </div>
  );
}

function Group({ name, schema, value, onChange, context, path }: { name: string; schema: Schema; value: Record<string, unknown>; onChange: Change; context: FormContext; path: string }) {
  const [open, setOpen] = useState(path.split('.').length < 2);
  const error = fieldError(context, path);
  return (
    <div className={styles.group} data-open={open || undefined} data-error={error ? true : undefined} data-path={path}>
      <button type="button" className={styles.groupHead} onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} className={styles.chevron} /><Label name={name} schema={schema} note={noteAt(context, path)} />
        {!open && <MarkCount {...marksUnder(context, path)} />}
        {!open && <span className={styles.groupSummary}>{summarize(value)}</span>}
      </button>
      {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      {open && <div className={styles.groupBody}><Properties schema={schema} value={value} onChange={onChange} context={context} path={path} /></div>}
    </div>
  );
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') {
    const named = (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).id;
    if (typeof named === 'string') return named;
    return `${Object.keys(value).length} fields`;
  }
  return value === undefined || value === null ? '—' : String(value);
}

function Union({ name, schema, value, onChange, context, path }: { name: string; schema: Schema; value: unknown; onChange: Change; context: FormContext; path: string }) {
  const key = schema.discriminator!.propertyName;
  const mapping = schema.discriminator!.mapping ?? {};
  const current = (value as Record<string, unknown> | undefined)?.[key];
  const variant = typeof current === 'string' && mapping[current] ? resolve(context.api, { $ref: mapping[current] }) : null;
  return (
    <div className={styles.group} data-open data-path={path}>
      <div className={styles.groupHead}>
        <Label name={name} schema={schema} note={noteAt(context, path)} />
        {context.readOnly ? <span className={styles.readValue}>{valueLabel(String(current ?? '—'))}</span> : (
          <select className={styles.input} aria-label={`${labelOf(name)} type`} value={String(current ?? '')} onChange={(event) => {
            const ref = mapping[event.target.value];
            if (ref) onChange(defaultFor(context.api, { $ref: ref }));
          }}>
            {current === undefined && <option value="">Choose…</option>}
            {shownOptions(Object.keys(mapping), current).map((option) => <option key={option} value={option}>{labelOf(option)}</option>)}
          </select>
        )}
      </div>
      {variant && <div className={styles.groupBody}><Properties schema={{ ...variant, properties: Object.fromEntries(Object.entries(variant.properties ?? {}).filter(([prop]) => prop !== key)) }} value={(value as Record<string, unknown>) ?? {}} onChange={onChange} context={context} path={path} /></div>}
    </div>
  );
}

function List({ name, schema, value, onChange, context, path, required }: { name: string; schema: Schema; value: unknown[]; onChange: Change; context: FormContext; path: string; required?: boolean }) {
  const { api } = context;
  const error = fieldError(context, path);
  if (schema.prefixItems) {
    return (
      <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
        <Label name={name} schema={schema} required={required} note={noteAt(context, path)} onSet={sourceSetter(context, path)} />
        <span className={styles.vector}>
          {schema.prefixItems.map((item, index) => (
            <NumberInput key={index} value={value[index]} schema={resolve(api, item)} readOnly={context.readOnly} label={`${labelOf(name)} ${'XYZW'[index] ?? index}`}
              onChange={(next) => { const copy = [...value]; copy[index] = next; onChange(copy); }} />
          ))}
        </span>
        {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      </div>
    );
  }
  const item = unwrapNullable(api, schema.items ?? {}).schema;
  const itemType = typeOf(item);
  if (itemType === 'enum') {
    return (
      <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
        <Label name={name} schema={schema} required={required} note={noteAt(context, path)} onSet={sourceSetter(context, path)} />
        <span className={styles.chips}>
          {item.enum!.filter((option) => shownOptions([option]).length || value.includes(option)).map((option) => {
            const on = value.includes(option);
            return <button key={String(option)} type="button" className={styles.chip} data-on={on || undefined} disabled={context.readOnly} aria-pressed={on}
              onClick={() => onChange(on ? value.filter((entry) => entry !== option) : [...value, option])}>{valueLabel(String(option))}</button>;
          })}
        </span>
        {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      </div>
    );
  }
  if (itemType && ['string', 'number', 'integer'].includes(itemType) && !item.properties) {
    return (
      <div className={styles.field} data-error={error ? true : undefined} data-field={path}>
        <Label name={name} schema={schema} required={required} note={noteAt(context, path)} onSet={sourceSetter(context, path)} />
        {context.readOnly ? <span className={styles.readValue}>{value.length ? value.join(', ') : '—'}</span> : (
          <input className={styles.input} aria-label={labelOf(name)} defaultValue={value.join(', ')} placeholder="comma-separated"
            onBlur={(event) => {
              const parts = event.target.value.split(',').map((part) => part.trim()).filter(Boolean);
              onChange(itemType === 'string' ? parts : parts.map(Number));
            }} />
        )}
        {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      </div>
    );
  }
  return (
    <div className={styles.group} data-open data-path={path} data-error={error ? true : undefined}>
      <div className={styles.groupHead}><Label name={name} schema={schema} required={required} note={noteAt(context, path)} /><span className={styles.groupSummary}>{summarize(value)}</span></div>
      {error && <small className={styles.fieldError} data-field-error>{error}</small>}
      <div className={styles.groupBody}>
        {value.map((entry, index) => (
          <div key={index} className={styles.card}>
            <div className={styles.cardHead}>
              <span>{summarize(entry) !== `${Object.keys((entry as object) ?? {}).length} fields` ? summarize(entry) : `${labelOf(name)} ${index + 1}`}</span>
              {!context.readOnly && value.length > (schema.minItems ?? 0) && <button type="button" className={styles.clear} aria-label={`Remove ${labelOf(name)} ${index + 1}`} onClick={() => onChange(value.filter((_, at) => at !== index))}><X size={11} /></button>}
            </div>
            {item.properties && !item.oneOf && !isPinSchema(item)
              ? <Properties schema={item} value={(entry as Record<string, unknown>) ?? {}} context={context} path={`${path}.${index}`}
                  onChange={(next) => { const copy = [...value]; copy[index] = next; onChange(copy); }} />
              : <Field name={name} schema={schema.items ?? {}} value={entry} context={context} path={`${path}.${index}`} required
                  onChange={(next) => { const copy = [...value]; copy[index] = next; onChange(copy); }} />}
          </div>
        ))}
        {!context.readOnly && (schema.maxItems === undefined || value.length < schema.maxItems) && (
          <button type="button" className={styles.linkButton} onClick={() => onChange([...value, defaultFor(api, schema.items ?? {})])}><Plus size={12} />Add {labelOf(name).toLowerCase().replace(/s$/, '')}</button>
        )}
      </div>
    </div>
  );
}

export default function SchemaForm({ schema, value, onChange, context }: { schema: Schema; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; context: FormContext }) {
  return <div className={styles.form}><Properties schema={schema} value={value} onChange={(next) => onChange(next as Record<string, unknown>)} context={context} path="" /></div>;
}
