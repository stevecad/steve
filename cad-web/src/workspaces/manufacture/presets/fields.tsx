/**
 * Form controls for the cutting-data kinds (SchemaForm `controls`):
 * - a preset's operations: chips of the milling operations Steve runs (from /capabilities), dimmed where the pinned
 *   cutter's type can't do them;
 * - a material's design material: the design material catalog by name (its ID is what's saved). The link supplies no
 *   machining limits.
 */
import { useId } from 'react';
import { useLibrary } from '@/lib/materials';
import type { ControlProps } from '../SchemaForm';
import { valueLabel } from '../schema';
import styles from './Presets.module.css';
import formStyles from '../Manufacture.module.css';

export interface OperationCapability { operation: string; process: string; cutter_types: string[] }

function OperationChips({ value, onChange, context, operations, cutterType }: ControlProps & { operations: OperationCapability[]; cutterType: string | null }) {
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const known = operations.filter((item) => item.process === 'milling').map((item) => item.operation);
  const shown = [...known, ...chosen.filter((item) => !known.includes(item))];
  if (context.readOnly) return <span className={formStyles.readValue}>{chosen.length ? chosen.map(valueLabel).join(', ') : '—'}</span>;
  return (
    <>
      <span className={styles.opChips} data-operation-chips>
        {shown.map((operation) => {
          const on = chosen.includes(operation);
          const capability = operations.find((item) => item.operation === operation);
          const fits = !cutterType || !capability || capability.cutter_types.includes(cutterType);
          return (
            <button key={operation} type="button" className={styles.opChip} data-on={on || undefined} data-off={!fits || undefined} aria-pressed={on} data-operation={operation}
              title={fits ? undefined : `Steve runs ${valueLabel(operation).toLowerCase()} with ${capability!.cutter_types.map((type) => valueLabel(type).toLowerCase()).join(' or ')}s`}
              onClick={() => onChange(on ? chosen.filter((item) => item !== operation) : [...chosen, operation])}>{valueLabel(operation)}</button>
          );
        })}
      </span>
      {cutterType && <small className={styles.muted}>Dimmed: operations Steve doesn’t run with a {valueLabel(cutterType).toLowerCase()}.</small>}
    </>
  );
}

function DesignMaterial({ value, onChange, context }: ControlProps) {
  const catalog = useLibrary();
  const list = useId();
  const id = typeof value === 'string' ? value : '';
  const material = catalog?.materials.find((item) => item.id === id);
  if (context.readOnly) return <span className={formStyles.readValue}>{id ? (material ? `${material.name} (${id})` : id) : '—'}</span>;
  return (
    <>
      <input className={formStyles.input} list={list} value={id} aria-label="Design material" placeholder="Optional: link a design material" data-design-material
        onChange={(event) => {
          // A name picked from the list becomes its ID; anything else is kept as typed (the server checks it).
          const typed = event.target.value;
          const byName = catalog?.materials.find((item) => item.name === typed);
          onChange(byName ? byName.id : typed || null);
        }} />
      <datalist id={list}>{catalog?.materials.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
      {material && <small className={styles.muted}>{material.name}{material.designations.length ? ` · ${material.designations.slice(0, 3).join(', ')}` : ''}</small>}
    </>
  );
}

/** The controls for a kind's form, or undefined. `cutterType`: a preset's pinned cutter type, when known. */
export function controlsFor(kind: string | null, operations: OperationCapability[], cutterType: string | null): Record<string, (props: ControlProps) => React.ReactNode> | undefined {
  if (kind === 'cutting_preset') return { operations: (props) => <OperationChips {...props} operations={operations} cutterType={cutterType} /> };
  if (kind === 'machining_material') return { design_material_id: (props) => <DesignMaterial {...props} /> };
  return undefined;
}
