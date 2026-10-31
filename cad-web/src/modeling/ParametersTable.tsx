import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Trash2, Variable } from 'lucide-react';
import { Button, IconButton, Tip } from '@/ui';
import { get, set, toast, useApp } from '@/state/store';
import { setCode, updateModel } from '@/state/actions';
import { ANGLE_UNITS, hasLengthUnit } from '@/lib/lengths';
import { addParameter, evaluate, evaluateLength, lengthParameter, lengthSource, parameterLine, parseModel, removeParameter, replaceSpan, setParameter, validParameterName, type ModelDoc, type ModelParameter } from '@/lib/modeling';
import styles from './Parameters.module.css';

const UNITS = ['mm', 'deg', 'count', 'in', ''];
/** `parameterFocus` that opens the table with a new row ready to type (e.g. from the browser). */
export const ADD_PARAMETER = '__add';

let regenerate: ReturnType<typeof setTimeout> | undefined;
/** Parameter edits regenerate on their own, a moment after the last change. */
function scheduleUpdate() {
  clearTimeout(regenerate);
  regenerate = setTimeout(() => {
    const { busy, modeling, doc } = get();
    // Nothing to regenerate until the design makes geometry (parameters and sketches alone don't).
    const geometry = modeling?.canonical
      ? modeling.features.some((f) => !['sketch', 'plane', 'axis', 'point'].includes(f.kind))
      : /^\s*result\s*=/m.test(doc.code);
    if (!busy && geometry) void updateModel();
  }, 700);
}

/** Who uses each parameter: other parameters and features (by name). */
export function usage(doc: ModelDoc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, by: string) => out.set(name, [...new Set([...(out.get(name) ?? []), by])]);
  for (const p of doc.parameters) for (const used of p.uses) add(used, p.name);
  for (const f of doc.features) {
    const label = f.name;
    for (const arg of [...(f.args ?? []), ...Object.values(f.kwargs ?? {})]) for (const name of arg.parameters ?? []) add(name, label);
    for (const s of f.statements ?? []) for (const arg of [...(s.args ?? []), ...Object.values(s.kwargs ?? {})]) for (const name of arg.parameters ?? []) add(name, label);
  }
  return out;
}

/** Inserts after the leading imports when the code has neither parameters nor a model yet. */
function addTo(code: string, doc: ModelDoc, line: string): string {
  if (doc.parameters.length || doc.model) return addParameter(code, doc, line);
  const lines = code.split('\n');
  let at = 0;
  while (at < lines.length && (/^\s*(import|from)\s/.test(lines[at]) || !lines[at].trim())) at++;
  const offset = lines.slice(0, at).reduce((sum, l) => sum + l.length + 1, 0);
  return `${code.slice(0, offset)}# Parameters\n${line}\n\n${code.slice(offset)}`;
}

async function apply(edit: (code: string, doc: ModelDoc) => string) {
  const code = get().doc.code;
  const doc = await parseModel(code);
  setCode(edit(code, doc));
  scheduleUpdate();
}

function Row({ parameter, doc, users }: { parameter: ModelParameter; doc: ModelDoc; users: string[] }) {
  const [text, setText] = useState(parameter.expression);
  const [editing, setEditing] = useState(false);
  const earlier = { ...doc, parameters: doc.parameters.filter((p) => p.line < parameter.line) };
  // A length (mm, or no unit given) takes units too, written in millimetres: `1in` as `25.4`.
  const length = lengthParameter(parameter.unit);
  const value = length ? evaluateLength(text, 'mm', earlier) : evaluate(text, earlier);
  const invalid = value === null;
  const commit = () => {
    setEditing(false);
    if (text.trim() === parameter.expression || invalid) { setText(parameter.expression); return; }
    const expression = length ? lengthSource(text, 'mm', earlier) : text;
    void apply((code, current) => {
      const fresh = current.parameters.find((p) => p.name === parameter.name);
      return fresh ? setParameter(code, fresh, expression) : code;
    });
  };
  const shown = editing ? text : parameter.expression;
  const derived = !/^-?[\d.]+$/.test(parameter.expression.trim());
  return (
    <motion.tr layout="position" data-parameter={parameter.name}>
      <td className={styles.name} title={parameter.description}>{parameter.name}{parameter.description && <small>{parameter.description}</small>}</td>
      <td>
        <input className={styles.expression} data-invalid={editing && invalid ? true : undefined} value={shown} spellCheck={false} aria-label={`${parameter.name} value`}
          onFocus={() => { setEditing(true); setText(parameter.expression); }} onChange={(event) => setText(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') { setText(parameter.expression); setEditing(false); (event.target as HTMLInputElement).blur(); } }} />
      </td>
      <td className={styles.value}>{derived || editing ? (value === null ? '—' : Number(value.toFixed(4))) : ''}<em>{parameter.unit ?? ''}</em></td>
      <td className={styles.users}>
        {users.length ? <Tip label="Used by" description={users.join(', ')}><span>{users.length}</span></Tip> : <span className={styles.unused}>—</span>}
      </td>
      <td>
        <IconButton small label={users.length ? 'In use: remove its uses first' : `Delete ${parameter.name}`} disabled={users.length > 0}
          onClick={() => void apply((code, current) => { const fresh = current.parameters.find((p) => p.name === parameter.name); return fresh ? removeParameter(code, fresh) : code; })}>
          <Trash2 />
        </IconButton>
      </td>
    </motion.tr>
  );
}

/** Document-wide parameters: named values and expressions the whole design is built from. */
export default function ParametersTable() {
  const doc = useApp((state) => state.modeling);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', expression: '', unit: 'mm', description: '' });
  const users = useMemo(() => (doc ? usage(doc) : new Map<string, string[]>()), [doc]);
  const focus = useApp((state) => state.parameterFocus);
  useEffect(() => { if (focus === ADD_PARAMETER) { setAdding(true); set({ parameterFocus: null }); } }, [focus]);
  if (!doc) return <p className={styles.hint}>Parameters appear once the design’s code loads.</p>;
  const nameCheck = draft.name ? validParameterName(draft.name, doc) : true;
  const draftLength = lengthParameter(draft.unit);
  const draftValue = draft.expression ? draftLength ? evaluateLength(draft.expression, 'mm', doc) : evaluate(draft.expression, doc) : null;
  const add = () => {
    if (nameCheck !== true) { toast('warning', 'Choose another name', nameCheck); return; }
    if (draftValue === null) {
      toast('warning', 'That value isn’t a number', draft.unit === 'deg' && hasLengthUnit(draft.expression) ? ANGLE_UNITS
        : `Type a number${draftLength ? ', a length like 1in,' : ''} or an expression of existing parameters.`);
      return;
    }
    const line = parameterLine(draft.name, draftLength ? lengthSource(draft.expression, 'mm', doc) : draft.expression, draft.unit || null, draft.description);
    void apply((code, current) => addTo(code, current, line));
    setDraft({ name: '', expression: '', unit: draft.unit, description: '' });
    setAdding(false);
  };
  return (
    <div className={styles.wrap} id="parameters-table">
      <div className={styles.head}>
        <Variable size={16} />
        <div><b>Parameters</b><span>{doc.parameters.length} named value{doc.parameters.length === 1 ? '' : 's'} · used anywhere in the design</span></div>
        <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)} id="parameter-add">Add</Button>
      </div>
      {doc.parameters.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>Name</th><th>Expression</th><th>Value</th><th>Uses</th><th /></tr></thead>
          <tbody>{doc.parameters.map((p) => <Row key={p.name} parameter={p} doc={doc} users={users.get(p.name) ?? []} />)}</tbody>
        </table>
      )}
      {!doc.parameters.length && !adding && <p className={styles.hint}>Name the numbers that drive the design (thickness, hole spacing, blade count) and use them in sketch dimensions and features. Expressions like <code>width / 2 + 3</code> work everywhere, and lengths take units like <code>1in</code> or <code>3cm</code> (kept in mm).</p>}
      {adding && (
        <div className={styles.add} onKeyDown={(event) => { if (event.key === 'Enter') add(); if (event.key === 'Escape') setAdding(false); }}>
          <input autoFocus placeholder="name" value={draft.name} data-invalid={nameCheck !== true || undefined} aria-label="New parameter name" onChange={(event) => setDraft({ ...draft, name: event.target.value.trim() })} />
          <input placeholder="value or expression" value={draft.expression} data-invalid={(!!draft.expression && draftValue === null) || undefined} aria-label="New parameter value" onChange={(event) => setDraft({ ...draft, expression: event.target.value })} />
          <select value={draft.unit} aria-label="Unit" onChange={(event) => setDraft({ ...draft, unit: event.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{u || 'none'}</option>)}</select>
          <input placeholder="description (optional)" className={styles.wide} value={draft.description} aria-label="Description" onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          <div className={styles.addActions}>
            {nameCheck !== true && <small>{nameCheck}</small>}
            <Button size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={add} disabled={!draft.name || !draft.expression} id="parameter-save">Add parameter</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export { replaceSpan };
