/**
 * The numbers that drive the open file, as a small form above the code: change one and the model follows
 * (the panel's live rebuild). A component file shows the shared parameters it imports, edited in params.py.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import { get, useApp } from '@/state/store';
import { setCode, openFile } from '@/state/actions';
import { lengthParameter, lengthSource, setParameter, type ModelParameter } from '@/lib/modeling';
import { PARAMS } from '@/state/design';
import styles from '../SourcePanel.module.css';

const KEY = 'steve-source-params-open';
const NONE: never[] = [];
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

function ParamInput({ parameter, onEdit }: { parameter: ModelParameter; onEdit: (code: string) => void }) {
  const [draft, setDraft] = useState(parameter.expression);
  useEffect(() => { setDraft(parameter.expression); }, [parameter.expression]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === parameter.expression) { setDraft(parameter.expression); return; }
    // The span belongs to the code the parse was made from: write only if it still holds this parameter's value.
    const current = get().modeling?.parameters.find((p) => p.name === parameter.name);
    const code = get().doc.code;
    if (!current || code.slice(current.value_span[0], current.value_span[1]).trim() !== current.expression.trim()) return;
    // A length (mm, or no unit given) typed with a unit is written in millimetres: `1in` as `25.4`.
    onEdit(setParameter(code, current, lengthParameter(current.unit) ? lengthSource(next, 'mm', get().modeling) : next));
  };
  return (
    <label className={styles.param} title={parameter.description || parameter.name} data-param={parameter.name}>
      <span className={styles.paramName}>{parameter.name}</span>
      <input value={draft} spellCheck={false} aria-label={`Parameter ${parameter.name}`}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } if (event.key === 'Escape') setDraft(parameter.expression); }} />
      {parameter.unit && <span className={styles.paramUnit}>{parameter.unit}</span>}
    </label>
  );
}

export default function ParamsBar({ onEdit = setCode }: { onEdit?: (code: string) => void }) {
  const parameters = useApp((state) => state.modeling?.parameters ?? NONE);
  const imported = useApp((state) => state.modeling?.imported ?? NONE);
  const design = useApp((state) => state.doc.kind === 'design');
  const activeFile = useApp((state) => state.doc.activeFile);
  const [open, setOpen] = useState(() => (remembered() ?? (parameters.length <= 6 ? '1' : '0')) === '1');
  if (!parameters.length && !imported.length) return null;
  const toggle = () => { setOpen(!open); try { localStorage.setItem(KEY, open ? '0' : '1'); } catch { /* Optional. */ } };
  const count = parameters.length + imported.length;
  return (
    <div className={styles.params} data-open={open || undefined} id="source-params">
      <button type="button" className={styles.paramsHead} onClick={toggle} aria-expanded={open}>
        <ChevronRight size={12} className={styles.paramsChevron} />
        <SlidersHorizontal size={12} />
        <span>Parameters</span>
        <span className={styles.paramsCount}>{count}</span>
        {!open && <span className={styles.paramsPeek}>{parameters.slice(0, 4).map((p) => `${p.name} ${p.expression}`).join(' · ')}</span>}
      </button>
      {open && (
        <div className={styles.paramGrid}>
          {parameters.map((parameter) => <ParamInput key={parameter.name} parameter={parameter} onEdit={onEdit} />)}
          {imported.map((item) => (
            <span key={`shared:${item.name}`} className={styles.param} data-shared title="Shared parameter: edit it in params.py">
              <span className={styles.paramName}>{item.name}</span>
              <span className={styles.paramShared}>{Number(item.value.toFixed(6))}</span>
            </span>
          ))}
          {design && activeFile !== PARAMS && imported.length > 0 && (
            <button type="button" className={styles.paramsLink} onClick={() => openFile(PARAMS)}>Edit shared parameters in params.py</button>
          )}
        </div>
      )}
    </div>
  );
}
