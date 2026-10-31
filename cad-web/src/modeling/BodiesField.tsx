import { Crosshair } from 'lucide-react';
import { useApp } from '@/state/store';
import { setValue, useFeatureDialog } from './dialog';
import { bodyIds, bodyLabel, bodyList, modelingOf, moveDetail } from './bodies';
import type { Field } from './specs';
import styles from './Feature.module.css';

/** A `bodies` field: the part's bodies to toggle, or click it and pick a body in the view. */
export default function BodiesField({ field, value }: { field: Field; value: string }) {
  const target = useFeatureDialog((s) => s.target === field.key);
  const id = useFeatureDialog((s) => s.id);
  const displayed = useApp((s) => s.displayed);
  const doc = useApp((s) => s.modeling);
  const chosen = bodyList(value);
  // Copies the open move is previewing aren't bodies it can move.
  const copies = new Set(moveDetail(displayed, id)?.copies ?? []);
  // A preview's newly created body cannot be an input to the feature creating it.
  const bodies = [...new Set([...bodyIds(displayed).filter((b) => b !== id && !copies.has(b)), ...chosen])];
  const label = (body: string) => bodyLabel(body, doc, modelingOf(displayed));
  const toggle = (body: string) => {
    const next = chosen.includes(body) ? chosen.filter((b) => b !== body) : [...chosen, body];
    setValue(field.key, next.length ? `[${next.map((b) => JSON.stringify(b)).join(', ')}]` : '');
  };
  return (
    <span className={styles.options}>
      {bodies.map((body) => (
        <button key={body} type="button" className={styles.option} data-on={chosen.includes(body) || undefined} title={body} onClick={() => toggle(body)}>{label(body)}</button>
      ))}
      <button type="button" className={styles.link} data-on={target || undefined} onClick={() => useFeatureDialog.setState({ target: target ? null : field.key })}>
        <Crosshair size={11} />{target ? 'Picking bodies in the view' : 'Pick in the view'}
      </button>
    </span>
  );
}
