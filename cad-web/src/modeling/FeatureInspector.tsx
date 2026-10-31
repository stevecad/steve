import { Code2, EyeOff, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/ui';
import { get, set, toast, useApp } from '@/state/store';
import { setCode, updateModel } from '@/state/actions';
import { parseModel, replaceSpan } from '@/lib/modeling';
import { modelingIcon, openRow, useFeatureRows } from './features';
import { SPECS } from './specs';
import styles from './Inspector.module.css';

/** Other features whose arguments mention this feature (its sketch, faces or edges). */
export function dependents(featureId: string, doc: NonNullable<ReturnType<typeof get>['modeling']>): string[] {
  // References live in string literals: "sketch_1", "extrude_1.end", "edge(extrude_1.end|extrude_1.side(r1.left))",
  // "fillet_1.face(edge(extrude_1...))", "mirror_1[0].extrude_1.end". Match the id as a whole token inside them.
  const token = new RegExp(`(?:^|[(|,\\s]|\\]\\.)${featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[.[()|,]|$)`);
  const mentions = (source: string) => [...source.matchAll(/(["'])(.*?)\1/g)].some((m) => token.test(m[2]));
  return doc.features.filter((f) => f.id !== featureId && [...(f.args ?? []), ...Object.values(f.kwargs ?? {})].some((a) => mentions(a.source))).map((f) => f.name);
}

export async function toggleSuppressed(featureId: string) {
  const code = get().doc.code;
  const doc = await parseModel(code);
  const feature = doc.features.find((f) => f.id === featureId);
  if (!feature || feature.kind === 'code') return;
  const flag = feature.kwargs?.suppressed;
  const text = code.slice(feature.span[0], feature.span[1]);
  const next = flag
    ? replaceSpan(code, feature.span, text.replace(/,\s*suppressed\s*=\s*True/, ''))
    : feature.kind === 'sketch'
      ? replaceSpan(code, feature.span, text.replace(/\)\s*as\s+(\w+):/, ', suppressed=True) as $1:'))
      : replaceSpan(code, feature.span, text.replace(/\)\s*\n?$/, ', suppressed=True)\n'));
  setCode(next);
  void updateModel();
}

export async function deleteFeature(featureId: string) {
  const code = get().doc.code;
  const doc = await parseModel(code);
  const feature = doc.features.find((f) => f.id === featureId);
  if (!feature) return;
  const users = dependents(featureId, doc);
  if (users.length) { toast('warning', `${feature.name} is in use`, `${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} it. Delete or change ${users.length === 1 ? 'it' : 'them'} first.`); return; }
  // Display names of the bodies it made go with it (its own, split pieces, copies).
  const names = (doc.body_names ?? []).filter((b) => b.body && (b.body === featureId || b.body.startsWith(`${featureId}_`) || b.body.endsWith(`_${featureId}`)));
  setCode([feature.span, ...names.map((b) => b.span)].sort((a, b) => b[0] - a[0]).reduce((text, span) => replaceSpan(text, span, ''), code));
  set({ activeFeature: null });
  void updateModel();
}

/** The selected feature of a modeling document: status, the code it writes, and actions. */
export default function ModelingFeatureInspector() {
  const active = useApp((state) => state.activeFeature);
  const doc = useApp((state) => state.modeling);
  const rows = useFeatureRows() ?? [];
  const row = rows.find((item) => item.id === active);
  if (!row || !doc) return null;
  const Icon = modelingIcon(row.kind);
  const users = row.id ? dependents(row.id, doc) : [];
  const source = get().doc.code.slice(row.feature.span[0], row.feature.span[1]).trimEnd();
  return (
    <div className={styles.wrap} id="modeling-feature" data-feature={row.id ?? undefined}>
      <div className={styles.head}>
        <span className={styles.icon}><Icon size={17} /></span>
        <div><b>{row.name}</b><span>{SPECS[row.kind]?.sheet ? SPECS[row.kind].label.toLowerCase() : row.kind.replace('_', ' ')} · {row.id}</span></div>
      </div>
      {row.status === 'error' && <p className={styles.error}><TriangleAlert size={14} />{row.error}</p>}
      {row.warning && <p className={styles.note}><TriangleAlert size={14} />{row.warning}</p>}
      {row.status === 'suppressed' && <p className={styles.note}><EyeOff size={14} />Suppressed: skipped when the model regenerates.</p>}
      {users.length > 0 && <p className={styles.note}>Used by {users.join(', ')}.</p>}
      <pre className={styles.code}>{source}</pre>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" icon={<Pencil />} onClick={() => openRow(row)} disabled={!row.editable && row.kind !== 'code'}>{row.kind === 'sketch' ? 'Edit sketch' : 'Edit'}</Button>
        <Button size="sm" icon={<Code2 />} onClick={() => set({ sourceReveal: { from: row.feature.span[0], to: row.feature.span[1], nonce: Date.now() }, dockOpen: true, dockTab: 'source' })}>Code</Button>
        {row.id && <Button size="sm" icon={<EyeOff />} onClick={() => { void toggleSuppressed(row.id!); }}>{row.status === 'suppressed' ? 'Unsuppress' : 'Suppress'}</Button>}
        {row.id && <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => { void deleteFeature(row.id!); }}>Delete</Button>}
      </div>
    </div>
  );
}
