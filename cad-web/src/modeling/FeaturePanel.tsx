import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Crosshair, Loader2, Plus, Table2, TriangleAlert, X } from 'lucide-react';
import { IconButton, Segmented, Switch } from '@/ui';
import { useApp } from '@/state/store';
import { importTable } from '@/state/actions';
import { filesOf, isTable, placeables, tablePath } from '@/state/design';
import { evaluate, lengthSource, type ModelDoc } from '@/lib/modeling';
import { ANGLE_UNITS, hasLengthUnit, lengthCode } from '@/lib/lengths';
import { cancelFeature, commitFeature, emit, fieldsOf, parseList, setValue, useFeatureDialog } from './dialog';
import { AXES, PLANES, SPECS, type Field } from './specs';
import BodiesField from './BodiesField';
import ImageField from './ImageField';
import { modelingOf, splitTuple } from './bodies';
import { positionItems } from '@/sketch/picking';
import { useSheetReport } from '@/workspaces/sheetmetal/sheet';
import ToolFooter from '@/shell/ToolFooter';
import styles from './Feature.module.css';

const unquote = (source: string) => { try { return JSON.parse(source); } catch { return source.replace(/^['"]|['"]$/g, ''); } };

/**
 * An input for a length: shows what is typed while it has focus and writes it in millimetres (`1in` as `25.4`,
 * `width + 1in` as `width + (1 * 25.4)`), so a unit never reaches the code.
 */
function LengthInput({ value, doc, onChange, ...props }: { value: string; doc: ModelDoc | null; onChange: (code: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  // Half-typed (`1" +`), it is still written with its units converted: an inch or foot mark would read as a string.
  const write = (text: string) => { const code = lengthSource(text, 'mm', doc); onChange(/["']/.test(code) ? lengthCode(text) : code); };
  return (
    <input {...props} value={draft ?? value} onFocus={() => setDraft(value)} onBlur={() => setDraft(null)}
      onChange={(event) => { setDraft(event.target.value); write(event.target.value); }} />
  );
}

function Expression({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  // A length's value is already in millimetres (LengthInput writes it so); what doesn't read stays as typed.
  const length = field.type === 'length';
  const evaluated = value.trim() ? evaluate(value, doc) : null;
  const plain = /^-?\d+(\.\d+)?$/.test(value.trim());
  const unit = field.type === 'angle' ? '°' : field.type === 'count' || field.type === 'number' ? '' : 'mm';
  const invalid = !!value.trim() && evaluated === null;
  const input = { spellCheck: false, 'aria-label': field.label, placeholder: field.omit === '' ? '—' : '', onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter') void commitFeature(); } };
  return (
    <span className={styles.expression} data-invalid={invalid || undefined}
      title={field.type === 'angle' && invalid && hasLengthUnit(value) ? ANGLE_UNITS : length ? 'Millimetres, or a length like 1in or 3cm' : undefined}>
      {length
        ? <LengthInput {...input} value={value} doc={doc} onChange={(code) => setValue(field.key, code)} />
        : <input {...input} value={value} onChange={(event) => setValue(field.key, event.target.value)} />}
      {!plain && evaluated !== null && <small>= {Number(evaluated.toFixed(4))}</small>}
      <em>{unit}</em>
    </span>
  );
}

function Refs({ field, value, target, prompt }: { field: Field; value: string; target: boolean; prompt?: string }) {
  const single = field.type === 'face' || field.type === 'edge';
  const refs = single ? (value ? [unquote(value)] : []) : parseList(value);
  const clear = (ref: string) => {
    if (single) { setValue(field.key, ''); return; }
    const next = refs.filter((r) => r !== ref);
    setValue(field.key, next.length ? `[${next.map((r) => JSON.stringify(r)).join(', ')}]` : '');
  };
  return (
    <button type="button" className={styles.refs} data-target={target || undefined} onClick={() => useFeatureDialog.setState({ target: field.key })}>
      {refs.length === 0 && <span className={styles.placeholder}><Crosshair size={12} />{target ? `Pick ${prompt ?? (field.type === 'face' ? 'a face' : field.type === 'edge' ? 'an edge' : field.type)} in the view` : 'Click, then pick in the view'}</span>}
      {refs.map((ref) => (
        <span key={ref} className={styles.chip} title={ref}>
          <span>{shortRef(ref)}</span>
          <X size={11} onClick={(event) => { event.stopPropagation(); clear(ref); }} />
        </span>
      ))}
      {refs.length > 0 && <span className={styles.count}>{refs.length}</span>}
    </button>
  );
}

/** A readable label for a reference name: `edge(extrude_1.end|extrude_1.side(r1.left))` → `end ∩ side r1.left`. */
function shortRef(ref: string): string {
  const edge = /^edge\((.+)\)(\[\d+\])?$/.exec(ref);
  const tidy = (name: string) => name.replace(/^[a-z0-9_]+\./, '').replace(/\((.*)\)/, ' $1');
  if (edge) {
    const [a, b] = splitTop(edge[1]);
    return `${tidy(a)} ∩ ${tidy(b ?? '')}${edge[2] ?? ''}`;
  }
  return ref.length > 34 ? `${ref.slice(0, 31)}…` : ref;
}

function splitTop(text: string): string[] {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === '|' && depth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text];
}

function SketchChoice({ field, value, doc, multi }: { field: Field; value: string; doc: ModelDoc | null; multi?: boolean }) {
  // Only a list that says so (a loft's sections) also offers construction points, as its first or last section.
  const sketches = (doc?.features ?? []).filter((f) => (f.kind === 'sketch' || (multi && field.points && f.kind === 'point')) && f.id);
  const chosen = multi ? parseList(value) : value ? [unquote(value)] : [];
  const toggle = (id: string) => {
    if (!multi) { setValue(field.key, JSON.stringify(id)); return; }
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    setValue(field.key, next.length ? `[${next.map((c) => JSON.stringify(c)).join(', ')}]` : '');
  };
  if (!sketches.length) return <span className={styles.empty}>Draw a sketch first.</span>;
  return (
    <span className={styles.options}>
      {sketches.map((sketch) => (
        <button key={sketch.id} type="button" className={styles.option} data-on={chosen.includes(sketch.id!) || undefined} onClick={() => toggle(sketch.id!)}>
          {multi && chosen.includes(sketch.id!) && <b>{chosen.indexOf(sketch.id!) + 1}</b>}{sketch.name}
        </button>
      ))}
    </span>
  );
}

function FeatureChoice({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const solids = (doc?.features ?? []).filter((f) => f.id && !['sketch', 'plane', 'axis', 'point', 'code'].includes(f.kind));
  const chosen = parseList(value);
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    setValue(field.key, next.length ? `[${next.map((c) => JSON.stringify(c)).join(', ')}]` : '');
  };
  if (!solids.length) return <span className={styles.empty}>No features to repeat yet.</span>;
  return (
    <span className={styles.options}>
      {solids.map((f) => <button key={f.id} type="button" className={styles.option} data-on={chosen.includes(f.id!) || undefined} onClick={() => toggle(f.id!)}>{f.name}</button>)}
    </span>
  );
}

function Datum({ field, value, doc, kind }: { field: Field; value: string; doc: ModelDoc | null; kind: 'plane' | 'axis' }) {
  const base = kind === 'plane' ? PLANES : AXES;
  const planes = kind === 'plane' ? (doc?.features ?? []).filter((f) => f.kind === 'plane' && f.id).map((f) => ({ value: JSON.stringify(f.id), label: f.name })) : [];
  const options = [...base, ...planes];
  const known = options.some((o) => o.value === value);
  // An axis takes a straight edge of the model or a line of a sketch shown in the view ("sketch_1.l3").
  const pick = kind === 'plane' ? 'a face' : 'an edge or sketch line';
  const pickLabel = kind === 'plane' ? 'Pick a face' : 'Pick an edge or sketch line';
  return (
    <span className={styles.datum}>
      <span className={styles.options}>
        {options.map((o) => <button key={o.value} type="button" className={styles.option} data-on={o.value === value || undefined} onClick={() => setValue(field.key, o.value)}>{o.label}</button>)}
        {field.omit === '' && <button type="button" className={styles.option} data-on={!value || undefined} onClick={() => setValue(field.key, '')}>None</button>}
      </span>
      {(!known && value) || useFeatureDialog.getState().target === field.key
        ? <Refs field={{ ...field, type: 'face' }} value={known ? '' : value} target={useFeatureDialog.getState().target === field.key} prompt={pick} />
        : <button type="button" className={styles.link} onClick={() => useFeatureDialog.setState({ target: field.key })}><Crosshair size={11} />{pickLabel}</button>}
    </span>
  );
}

/**
 * Hole positions: typed (x, y) rows and sketch points picked in the view ("sketch_1.p1", shown as chips), in one list;
 * a whole sketch (`"sketch_1"`, all its points) shows as one chip. Code it can't take apart is shown, never rewritten.
 */
function Points({ field, value, doc, target }: { field: Field; value: string; doc: ModelDoc | null; target: boolean }) {
  // Each item: a typed row [x, y], or a sketch reference.
  type Item = { xy: string[] } | { ref: string } | { code: string };
  const items = useMemo(() => positionItems(value).map((item): Item => {
    if (/^["']/.test(item)) return { ref: String(unquote(item)) };
    const xy = /^\(/.test(item) ? splitTuple(item) : null;
    return xy && xy.length === 2 ? { xy } : { code: item };
  }), [value]);
  const editable = !items.some((item) => 'code' in item);
  const write = (next: Item[]) => setValue(field.key, next.length
    ? `[${next.map((item) => ('xy' in item ? `(${item.xy[0] || 0}, ${item.xy[1] || 0})` : 'ref' in item ? JSON.stringify(item.ref) : item.code)).join(', ')}]` : '');
  const edit = (index: number, column: number, text: string) => write(items.map((item, i) => (i === index && 'xy' in item ? { xy: item.xy.map((v, j) => (j === column ? text : v)) } : item)));
  const sketchName = (id: string) => doc?.features.find((f) => f.id === id)?.name ?? id;
  const label = (ref: string) => {
    const [sketch, ...rest] = ref.split('.');
    return rest.length ? `${sketchName(sketch)} · ${rest.join('.')}` : `All points of ${sketchName(sketch)}`;
  };
  if (!editable) return <code className={styles.empty} title="Written in code; edit it in the source">{value}</code>;
  return (
    <span className={styles.points}>
      {items.map((item, index) => ('ref' in item ? (
        <span key={index} className={styles.chip} title={item.ref} data-position-ref={item.ref}>
          <span>{label(item.ref)}</span>
          <X size={11} onClick={() => write(items.filter((_, i) => i !== index))} />
        </span>
      ) : 'xy' in item ? (
        <span key={index} className={styles.pointRow}>
          <LengthInput value={item.xy[0]} doc={doc} aria-label="X" onChange={(code) => edit(index, 0, code)} />
          <LengthInput value={item.xy[1]} doc={doc} aria-label="Y" onChange={(code) => edit(index, 1, code)} />
          <X size={12} onClick={() => write(items.filter((_, i) => i !== index))} />
        </span>
      ) : null))}
      <button type="button" className={styles.link} onClick={() => write([...items, { xy: ['0', '0'] }])}><Plus size={11} />Add position</button>
      <button type="button" className={styles.link} data-target={target || undefined} title="Click points, circle centres or line ends of a sketch shown in the view; click again to remove one"
        onClick={() => useFeatureDialog.setState({ target: target ? null : field.key })}>
        <Crosshair size={11} />{target ? 'Picking sketch points in the view…' : 'Pick sketch points'}
      </button>
      {items.some((item) => 'xy' in item && (evaluate(item.xy[0], doc) === null || evaluate(item.xy[1], doc) === null)) && <small className={styles.invalid}>Positions must be numbers (mm), lengths like 1in, or parameter expressions.</small>}
    </span>
  );
}

/** One region a boundary fill's build found (its `detail.cells`): a point inside it, its volume, the tool body it lies in. */
interface Region { point: [number, number, number]; volume_mm3: number; inside?: string }

/**
 * A boundary fill's regions, as the preview found them: each toggles the point inside it in `cells`. Auto (no points)
 * uses every region outside the tool bodies. Points the list doesn't know (typed in code) are shown as typed rows.
 */
function Regions({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const own = useFeatureDialog((s) => s.id);
  const found = useApp((s) => (modelingOf(s.displayed)?.features.find((f) => f.id === own)?.detail as { cells?: Region[] } | undefined)?.cells);
  const regions = found ?? [];
  const key = (point: number[]) => point.map((v) => v.toFixed(3)).join(',');
  const typed = positionItems(value).map((item) => (splitTuple(item) ?? []).map(Number));
  if (!regions.length || typed.some((point) => point.length !== 3 || !regions.some((r) => key(r.point) === key(point)))) {
    return <Offsets field={field} value={value} doc={doc} />;
  }
  const auto = !value.trim();
  const chosen = auto ? regions.filter((r) => !r.inside).map((r) => r.point) : typed;
  const write = (points: number[][]) => setValue(field.key, points.length ? `[${points.map((p) => `(${p.join(', ')})`).join(', ')}]` : '');
  const toggle = (point: number[]) => write(chosen.some((p) => key(p) === key(point)) ? chosen.filter((p) => key(p) !== key(point)) : [...chosen, point]);
  return (
    <span className={styles.datum}>
      <span className={styles.options}>
        <button type="button" className={styles.option} data-on={auto || undefined} onClick={() => write([])}>Auto</button>
        {regions.map((region, i) => (
          <button key={key(region.point)} type="button" className={styles.option} data-on={(!auto && chosen.some((p) => key(p) === key(region.point))) || undefined}
            title={`A point inside it: (${region.point.join(', ')})`} onClick={() => toggle(region.point)}>
            {`${i + 1} · ${Number(region.volume_mm3.toPrecision(4))} mm³${region.inside ? ` · in ${region.inside}` : ''}`}
          </button>
        ))}
      </span>
    </span>
  );
}

/** Table pattern's positions: a row per copy, X, Y and an optional Z (r, θ, Z when polar); an empty Z is left out. */
function Offsets({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const polar = useFeatureDialog((s) => s.values.polar === 'True');
  const rows = useMemo(() => (splitTuple(value) ?? []).map((item) => {
    const [a = '', b = '', c = ''] = splitTuple(item.trim()) ?? [];
    return [a, b, c];
  }), [value]);
  const write = (next: string[][]) => setValue(field.key, next.length ? `[${next.map(([a, b, c]) => `(${a || 0}, ${b || 0}${c.trim() ? `, ${c}` : ''})`).join(', ')}]` : '');
  const edit = (index: number, column: number, text: string) => write(rows.map((row, i) => (i === index ? row.map((cell, j) => (j === column ? text : cell)) : row)));
  const heads = polar ? ['r', 'θ', 'Z'] : ['X', 'Y', 'Z'];
  return (
    <span className={styles.points} data-offsets>
      {rows.map((row, index) => (
        <span key={index} className={styles.pointRow}>
          {row.map((cell, column) => (polar && column === 1
            ? <input key={column} value={cell} aria-label={`Position ${index + 1} ${heads[column]}`} title={heads[column]} onChange={(event) => edit(index, column, event.target.value)} />
            : <LengthInput key={column} value={cell} doc={doc} aria-label={`Position ${index + 1} ${heads[column]}`} placeholder={column === 2 ? '0' : undefined}
              title={heads[column]} onChange={(code) => edit(index, column, code)} />))}
          <button type="button" className={styles.removePoint} aria-label={`Remove position ${index + 1}`} onClick={() => write(rows.filter((_, i) => i !== index))}><X size={12} /></button>
        </span>
      ))}
      <button type="button" className={styles.link} onClick={() => write([...rows, ['0', '0', '']])}><Plus size={11} />Add position</button>
      {rows.length > 0 && <small className={styles.hint}>{heads.join(' · ')} for each {field.key === 'points' ? 'copy' : 'point'}{polar ? ' (θ in °)' : ''}; Z is optional.</small>}
      {rows.some((row) => row.some((cell) => !!cell.trim() && evaluate(cell, doc) === null)) && <small className={styles.invalid}>Positions must be numbers (mm), lengths like 1in, or parameter expressions.</small>}
    </span>
  );
}

/** Table pattern in a design: the component or linked part main.py imports, to place at each row. */
function ComponentChoice({ field, value }: { field: Field; value: string }) {
  const main = useApp((s) => s.doc.code);
  const choices = useMemo(() => placeables(main), [main]);
  if (!choices.length) return <span className={styles.empty}>No components yet: add one in the browser (Components).</span>;
  return (
    <span className={styles.options}>
      {choices.map((c) => <button key={c.source} type="button" className={styles.option} data-on={c.source === value || undefined} onClick={() => setValue(field.key, c.source)}>{c.label}</button>)}
    </span>
  );
}

/**
 * Table pattern in a design: one of its tables (.csv beside main.py), or a new one imported here as in the Source
 * panel's file switcher (a .csv, or one sheet of an Excel .xlsx converted to .csv in the browser).
 */
function TableChoice({ field, value }: { field: Field; value: string }) {
  const doc = useApp((s) => s.doc);
  const tables = useMemo(() => Object.keys(filesOf(doc)).filter(isTable).sort(), [doc]);
  const [problem, setProblem] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<{ file: File; sheets: string[] } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const importPicked = async (file: File | undefined, sheet?: string) => {
    if (!file) return;
    setWorkbook(null);
    const outcome = await importTable(file, sheet, true);
    if (outcome === true) { setProblem(null); setValue(field.key, tablePath(file.name) ?? ''); }
    else if (typeof outcome === 'string') setProblem(outcome);
    else { setProblem(null); setWorkbook({ file, sheets: outcome.sheets }); }
  };
  return (
    <span className={styles.datum}>
      {tables.length ? (
        <span className={styles.options}>
          {tables.map((path) => <button key={path} type="button" className={styles.option} data-on={path === value || undefined} data-table={path} onClick={() => setValue(field.key, path)}>{path}</button>)}
        </span>
      ) : <span className={styles.empty}>No tables in this design yet.</span>}
      {workbook ? (
        <span className={styles.options} role="group" aria-label="Sheet to import">
          {workbook.sheets.map((sheet) => <button key={sheet} type="button" className={styles.option} data-sheet={sheet} onClick={() => void importPicked(workbook.file, sheet)}>{sheet}</button>)}
          <button type="button" className={styles.link} onClick={() => setWorkbook(null)}>Cancel</button>
        </span>
      ) : (
        <button type="button" className={styles.link} id="table-pattern-import" title="Add a table of positions (.csv, or a sheet of an Excel .xlsx saved as .csv) to this design"
          onClick={() => { setProblem(null); picker.current?.click(); }}><Table2 size={11} />Import table…</button>
      )}
      <input ref={picker} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Import table (.csv or .xlsx)"
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importPicked(file); }} />
      {problem && <small className={styles.invalid} role="alert">{problem}</small>}
    </span>
  );
}

function Vector({ field, value }: { field: Field; value: string }) {
  const split = (source: string) => /^\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)$/.exec(source)?.slice(1) ?? ['0', '0', '0'];
  // No value (an optional vector left out, e.g. a decal's `direction`): empty boxes, and the hint says what that means.
  const empty = !value.trim() && field.omit === '';
  const parts = empty ? ['', '', ''] : split(value);
  const write = (index: number, text: string) =>
    setValue(field.key, `(${split(useFeatureDialog.getState().values[field.key] ?? '').map((p, i) => (i === index ? text || '0' : p)).join(', ')})`);
  return (
    <span className={styles.vector}>
      {(['X', 'Y', 'Z'] as const).map((axis, index) => (
        <label key={axis}><i data-axis={axis}>{axis}</i><input value={parts[index]} placeholder={empty ? 'auto' : undefined} onChange={(event) => write(index, event.target.value)} /></label>
      ))}
    </span>
  );
}

/** A 2D point `(x, y)` in a panel's or sketch's own coordinates. */
function Point({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  // No value (an optional point left out, e.g. a decal's `at`): empty boxes, and the hint says what that means.
  const empty = !value.trim();
  const parts = empty ? ['', ''] : (splitTuple(value) ?? ['0', '0']).slice(0, 2);
  // From the latest value, not this render's: quick edits to X then Y must both land.
  const write = (index: number, text: string) => {
    const current = (splitTuple(useFeatureDialog.getState().values[field.key] ?? '') ?? ['0', '0']).slice(0, 2);
    setValue(field.key, `(${current.map((p, i) => (i === index ? text || '0' : p)).join(', ')})`);
  };
  return (
    <span className={styles.vector}>
      {(['X', 'Y'] as const).map((axis, index) => (
        <label key={axis}><i data-axis={axis}>{axis}</i><LengthInput value={parts[index] ?? '0'} doc={doc} placeholder={empty ? 'auto' : undefined} aria-label={`${field.label} ${axis}`} onChange={(code) => write(index, code)} /></label>
      ))}
    </span>
  );
}

/** Decals use a face-local pair or a part-space triple. Keep all authored coordinates when editing. */
function DecalCenter({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const parts = splitTuple(value) ?? [];
  const write = (index: number, text: string) => {
    const next = [...(splitTuple(useFeatureDialog.getState().values[field.key] ?? '') ?? ['', '', ''])];
    next[index] = text;
    const count = next[2]?.trim() ? 3 : 2;
    setValue(field.key, next.some((p) => p.trim()) ? `(${Array.from({ length: count }, (_, i) => next[i]?.trim() || '0').join(', ')})` : '');
  };
  return (
    <span className={styles.datum}>
      <span className={styles.vector}>
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <label key={axis}><i data-axis={axis}>{axis}</i><LengthInput value={parts[index] ?? ''} doc={doc}
            placeholder={index === 2 ? 'optional' : 'auto'} aria-label={`${field.label} ${axis}`} onChange={(code) => write(index, code)} /></label>
        ))}
      </span>
      <small className={styles.hint}>{field.hint}</small>
      {!!value && <button type="button" className={styles.link} onClick={() => setValue(field.key, '')}>Use face center</button>}
    </span>
  );
}

/** A contour's chained segments: `[{"length": 20, "angle": 90}, …]`; other keys in a row are kept. */
function parseSegments(value: string): Record<string, string>[] {
  return (splitTuple(value) ?? []).map((item) => {
    const inner = item.trim().replace(/^\{|\}$/g, '');
    const entries = (splitTuple(`(${inner})`) ?? []).map((pair) => /^["'](\w+)["']\s*:\s*([\s\S]+)$/.exec(pair.trim())).filter(Boolean) as RegExpExecArray[];
    return Object.fromEntries(entries.map((m) => [m[1], m[2].trim()]));
  });
}

function Segments({ field, value }: { field: Field; value: string }) {
  const rows = useMemo(() => parseSegments(value), [value]);
  const write = (next: Record<string, string>[]) =>
    setValue(field.key, next.length ? `[${next.map((row) => `{${Object.entries(row).map(([k, v]) => `"${k}": ${v || 0}`).join(', ')}}`).join(', ')}]` : '');
  const edit = (index: number, key: string, text: string) => write(rows.map((row, i) => (i === index ? { ...row, [key]: text } : row)));
  return (
    <span className={styles.points} data-segments>
      {rows.map((row, index) => (
        <span key={index} className={styles.pointRow} data-segment={index}>
          <b className={styles.segmentIndex}>{index + 1}</b>
          <input value={row.length ?? ''} aria-label={`Segment ${index + 1} length`} title="Straight length (mm)" onChange={(event) => edit(index, 'length', event.target.value)} />
          <input value={row.angle ?? ''} aria-label={`Segment ${index + 1} angle`} title="Bend angle into this segment (°)" onChange={(event) => edit(index, 'angle', event.target.value)} />
          <X size={12} onClick={() => write(rows.filter((_, i) => i !== index))} />
        </span>
      ))}
      <button type="button" className={styles.link} onClick={() => write([...rows, { length: '15', angle: rows.length % 2 ? '90' : '-90' }])}><Plus size={11} />Add segment</button>
      {rows.length > 0 && <small className={styles.hint}>Length (mm) · bend angle (°) for each wall, in order.</small>}
    </span>
  );
}

/** Choices that wrap (more, longer labels than a segmented control holds). */
function Chips({ field, value }: { field: Field; value: string }) {
  return (
    <span className={styles.options}>
      {(field.options ?? []).map((o) => <button key={o.value} type="button" className={styles.option} data-on={o.value === value || undefined} onClick={() => setValue(field.key, o.value)}>{o.label}</button>)}
    </span>
  );
}

/** A named sheet-metal rule declared in this file (`shop = SheetMetalRule(...)`); the value is its variable. */
function RuleChoice({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const rules = (doc?.sheet_rules ?? []).filter((rule) => rule.kind === 'sheet_rule');
  return (
    <span className={styles.datum}>
      {rules.length ? (
        <span className={styles.options}>
          {rules.map((rule) => {
            const name = rule.kwargs?.name?.value;
            return <button key={rule.variable} type="button" className={styles.option} data-on={rule.variable === value || undefined} title={typeof name === 'string' ? name : undefined}
              onClick={() => setValue(field.key, rule.variable)}>{rule.variable}</button>;
          })}
        </span>
      ) : <span className={styles.empty}>No rules in this file yet.</span>}
      <button type="button" className={styles.link} onClick={() => useApp.setState({ dialog: 'sheetRules' })}><Plus size={11} />Manage rules…</button>
    </span>
  );
}

/** A form tool declared in this file (`louver = SheetMetalForm("louver", ...)`); the value is its variable. */
function FormToolChoice({ field, value, doc }: { field: Field; value: string; doc: ModelDoc | null }) {
  const tools = doc?.sheet_forms ?? [];
  return (
    <span className={styles.datum}>
      {tools.length ? (
        <span className={styles.options}>
          {tools.map((tool) => {
            const name = tool.kwargs?.name?.value;
            const kind = tool.args?.[0]?.value;
            return <button key={tool.variable} type="button" className={styles.option} data-on={tool.variable === value || undefined} data-form-tool={tool.variable}
              title={[typeof name === 'string' ? name : null, typeof kind === 'string' ? kind : null].filter(Boolean).join(' · ') || undefined}
              onClick={() => setValue(field.key, tool.variable)}>{tool.variable}</button>;
          })}
        </span>
      ) : <span className={styles.empty}>No form tools in this file yet.</span>}
      <button type="button" className={styles.link} onClick={() => useApp.setState({ dialog: 'sheetForms' })}><Plus size={11} />Manage form tools…</button>
    </span>
  );
}

/** A bend of the sheet, by its id: chosen from the sheet's bends or picked on a bend face in the view. */
function BendChoice({ field, value, target }: { field: Field; value: string; target: boolean }) {
  const report = useSheetReport();
  const own = useFeatureDialog((s) => s.id);
  const chosen = value ? unquote(value) : '';
  // The preview may already have split the chosen bend; bends this feature made aren't choices.
  const bends = [...new Set([...(report?.bodies ?? []).flatMap((body) => body.bends.map((bend) => bend.id)).filter((id) => !id.startsWith(`${own}.`)), ...(chosen ? [chosen] : [])])];
  return (
    <span className={styles.datum}>
      {bends.length ? (
        <span className={styles.options}>
          {bends.map((bend) => <button key={bend} type="button" className={styles.option} data-on={bend === chosen || undefined} data-bend-choice={bend}
            onClick={() => setValue(field.key, JSON.stringify(bend))}>{bend}</button>)}
        </span>
      ) : <span className={styles.empty}>This sheet has no bends yet.</span>}
      <button type="button" className={styles.link} data-target={target || undefined} onClick={() => useFeatureDialog.setState({ target: field.key })}>
        <Crosshair size={11} />{target ? 'Pick a bend face in the view' : 'Pick in the view'}
      </button>
    </span>
  );
}

function FieldRow({ field, doc }: { field: Field; doc: ModelDoc | null }) {
  const value = useFeatureDialog((s) => s.values[field.key] ?? '');
  const auto = useFeatureDialog((s) => s.auto[field.key] ?? '');
  const target = useFeatureDialog((s) => s.target === field.key);
  // A choice left on Auto says what it stands for right now ("Auto · Cut").
  const autoLabel = (o: { value: string; label: string }) => (o.value === '' && value === '' && auto ? `${o.label} · ${field.options?.find((x) => x.value === auto)?.label ?? auto}` : o.label);
  let control: React.ReactNode;
  switch (field.type) {
    case 'length': case 'angle': case 'count': case 'number': control = <Expression field={field} value={value} doc={doc} />; break;
    case 'choice': control = <Segmented size="sm" value={value} onChange={(next) => setValue(field.key, next)} options={(field.options ?? []).map((o) => ({ value: o.value, label: autoLabel(o) }))} />; break;
    case 'boolean': control = <Switch checked={value === 'True'} onCheckedChange={(on) => setValue(field.key, on ? 'True' : 'False')} label={field.label} />; break;
    case 'sketch': control = <SketchChoice field={field} value={value} doc={doc} />; break;
    case 'sketches': control = <SketchChoice field={field} value={value} doc={doc} multi />; break;
    case 'features': control = <FeatureChoice field={field} value={value} doc={doc} />; break;
    case 'bodies': control = <BodiesField field={field} value={value} />; break;
    case 'image': control = <ImageField field={field} value={value} />; break;
    case 'edges': case 'edge': case 'faces': case 'face': control = field.sketches ? (
      <span className={styles.datum}>
        <Refs field={field} value={value} target={target} prompt="edges or a sketch" />
        <SketchChoice field={field} value={value} doc={doc} multi />
      </span>
    ) : <Refs field={field} value={value} target={target} />; break;
    case 'plane': control = <Datum field={field} value={value} doc={doc} kind="plane" />; break;
    case 'axis': control = <Datum field={field} value={value} doc={doc} kind="axis" />; break;
    case 'points': control = <Points field={field} value={value} doc={doc} target={target} />; break;
    case 'offsets': control = <Offsets field={field} value={value} doc={doc} />; break;
    case 'regions': control = <Regions field={field} value={value} doc={doc} />; break;
    case 'component': control = <ComponentChoice field={field} value={value} />; break;
    case 'table': control = <TableChoice field={field} value={value} />; break;
    case 'vector': control = <Vector field={field} value={value} />; break;
    case 'point': control = <Point field={field} value={value} doc={doc} />; break;
    case 'decal_center': control = <DecalCenter field={field} value={value} doc={doc} />; break;
    case 'segments': control = <Segments field={field} value={value} />; break;
    case 'chips': control = <Chips field={field} value={value} />; break;
    case 'rule': control = <RuleChoice field={field} value={value} doc={doc} />; break;
    case 'form_tool': control = <FormToolChoice field={field} value={value} doc={doc} />; break;
    case 'bend': control = <BendChoice field={field} value={value} target={target} />; break;
    case 'text': control = <input className={styles.text} value={unquote(value) ?? ''} onChange={(event) => setValue(field.key, event.target.value ? JSON.stringify(event.target.value) : '')} aria-label={field.label} />; break;
    default: control = null;
  }
  return (
    <div className={styles.field} data-field={field.key} data-target={target || undefined}>
      <span className={styles.label} title={field.hint}>{field.label}{field.required && <sup>•</sup>}</span>
      <span className={styles.control}>{control}</span>
    </div>
  );
}

/** The dialog for the feature being created or edited, with live preview. */
export default function FeaturePanel() {
  const open = useFeatureDialog((s) => s.open);
  const kind = useFeatureDialog((s) => s.kind);
  const id = useFeatureDialog((s) => s.id);
  const editing = useFeatureDialog((s) => s.editing);
  const status = useFeatureDialog((s) => s.status);
  const message = useFeatureDialog((s) => s.message);
  const values = useFeatureDialog((s) => s.values);
  const design = useFeatureDialog((s) => !!s.design);
  const doc = useApp((s) => s.modeling);
  const spec = SPECS[kind];
  const Icon = spec?.icon;
  // The call as it will be written: follows the values and what Auto stands for (an extrude's cut).
  const code = useFeatureDialog((s) => (s.open && SPECS[s.kind] ? emit(s) : ''));
  return (
    <AnimatePresence>
      {open && spec && (
        <motion.div id="feature-panel" className={styles.panel} data-kind={kind} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }} onPointerDown={(event) => event.stopPropagation()}>
          <div className={styles.head}>
            {Icon && <span className={styles.icon}><Icon size={17} /></span>}
            <div className={styles.title}><b>{editing ? `Edit ${spec.label.toLowerCase()}` : spec.label}</b><span>{id}</span></div>
            <IconButton small label="Cancel" onClick={cancelFeature}><X /></IconButton>
          </div>
          <div className={styles.body}>
            {spec.guidance && <p className={styles.guidance}>{spec.guidance}</p>}
            {fieldsOf({ kind, design }).filter((f) => !f.when || f.when(values)).map((field) => <FieldRow key={field.key} field={field} doc={doc} />)}
          </div>
          <div className={styles.status} data-state={status}>
            {status === 'previewing' && <><Loader2 size={13} className={styles.spin} />Previewing…</>}
            {status === 'ok' && <><Check size={13} />Preview ready</>}
            {status === 'error' && <><TriangleAlert size={13} />{message}</>}
            {status === 'idle' && message && <>{message}</>}
          </div>
          <code className={styles.code} title="What will be written into the design">{code}</code>
          {/* Enter/Esc come through the shared footer (App's key handler). */}
          <ToolFooter onCancel={cancelFeature} onOk={() => { void commitFeature(); }} okId="feature-ok" cancelId="feature-cancel"
            okBusy={status === 'previewing'} okDisabled={status === 'ok' ? false : message || 'Wait for a valid preview before applying this feature.'}
            okTitle={editing ? `Update ${id}` : design ? `Add the pattern to ${id}` : `Add ${spec.label.toLowerCase()} ${id}`} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
