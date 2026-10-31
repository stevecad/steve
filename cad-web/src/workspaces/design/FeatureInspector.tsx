import { useEffect, useState } from 'react';
import { CircleAlert, Code2, Lock } from 'lucide-react';
import { Badge, Button, NumberField, Section } from '@/ui';
import { set, useApp } from '@/state/store';
import { canEdit, clampToLimits, featureValue, isNumeric, type Feature } from '@/lib/features';
import { applyFeatureEdit, PARAMETERS_ID } from './featureEdit';
import { featureIcon } from './featureIcons';
import { revealSource } from './FeatureTree';
import styles from '@/panels/Panels.module.css';

/** Parameter editor for one feature. Edits are applied server-side, verified, then saved. */
export default function FeatureInspector() {
  const features = useApp((state) => state.features);
  const activeId = useApp((state) => state.activeFeature);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => { setDraft({}); setError(null); }, [activeId]);

  if (!features || features.state !== 'ready') return null;
  const tree = features.tree;
  const feature: Feature | undefined = tree.features.find((item) => item.id === activeId);
  if (!feature) return null;
  const treeEditable = tree.editable && tree.execution_verified;
  const captured = tree.status === 'captured' || tree.status === 'partial';
  const labelOf = (id: string) => tree.features.find((item) => item.id === id)?.label ?? id;
  const Icon = featureIcon(feature.operation, feature.category);
  const changes = Object.entries(draft).filter(([name, value]) => feature.parameters[name]?.value !== value);

  const apply = async () => {
    setApplying(true);
    setError(null);
    const message = await applyFeatureEdit(changes.map(([parameter, value]) => ({ feature_id: feature.id, parameter, value })), feature.label, feature.id);
    if (message) setError(message); else setDraft({});
    setApplying(false);
  };


  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Icon size={19} /></div>
        <div className={styles.heroText}>
          <div className={styles.heroTitle}>{feature.label}</div>
          <div className={styles.heroSub}><span className="mono" style={{ fontSize: 10.5 }}>{feature.operation}</span><Badge tone={treeEditable ? 'ws' : captured ? undefined : 'warning'}>{treeEditable ? 'Editable' : captured ? 'Captured' : 'Read-only'}</Badge></div>
        </div>
      </div>
      <Section title="Parameters">
        <div className={styles.stack}>
          {!Object.keys(feature.parameters).length && <p className={styles.muted} style={{ fontSize: 11.5 }}>This feature has no parameters.</p>}
          {Object.entries(feature.parameters).map(([name, parameter]) => {
            const editable = canEdit(tree, parameter);
            return (
              <div key={name} className={styles.fieldRow} style={{ gridTemplateColumns: '96px 1fr' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{!editable && <Lock size={11} />}{name}</span>
                <div>
                  {isNumeric(parameter.value) ? <NumberField
                    value={draft[name] ?? parameter.value}
                    unit={parameter.unit ?? ''}
                    disabled={!editable || applying}
                    min={parameter.limits?.min ?? parameter.limits?.exclusive_min}
                    max={parameter.limits?.max}
                    ariaLabel={name}
                    onChange={(value) => setDraft((current) => ({ ...current, [name]: clampToLimits(value, parameter.limits) }))}
                  /> : <div className={styles.paramValue}>{featureValue(parameter.value, parameter.unit, labelOf)}</div>}
                  {parameter.expression && parameter.expression !== featureValue(parameter.value) && <p className={styles.muted} style={{ fontSize: 10.5, marginTop: 4, overflowWrap: 'anywhere' }}>{parameter.expression}</p>}
                  {!editable && parameter.reason && <p className={styles.muted} style={{ fontSize: 10.5, marginTop: 4 }}>{parameter.reason}</p>}
                  {!editable && parameter.binding?.kind === 'parameter' && parameter.binding.name && tree.design_parameters?.some((item) => item.name === parameter.binding!.name && item.editable) && (
                    <button type="button" className={styles.linkButton} onClick={() => set({ activeFeature: PARAMETERS_ID, parameterFocus: parameter.binding!.name! })}>Edit design parameter {parameter.binding.name} →</button>
                  )}
                </div>
              </div>
            );
          })}
          {!treeEditable && (
            <div className={styles.note} data-tone={captured && tree.execution_verified ? undefined : 'warning'}>
              <CircleAlert size={15} />
              <span>{captured
                ? `${tree.status === 'partial' ? 'Partially captured' : 'Captured'} from running the source${tree.execution_verified ? ' and verified against it' : ''}. Captured history is read-only — edit the source to change it.`
                : tree.execution_verified ? 'This source isn’t in the supported editable subset. Edit it in Source.' : 'Generate the current source before editing parameters.'}</span>
            </div>
          )}
          {error && <div className={styles.note} data-tone="warning"><CircleAlert size={15} /><span><b>Edit rejected.</b> {error} Your proposed values are kept; the saved design is unchanged.</span></div>}
          <div className={styles.actions}>
            {treeEditable && <Button variant="primary" size="sm" disabled={!changes.length || applying} onClick={() => { void apply(); }}>{applying ? 'Applying…' : 'Apply'}</Button>}
            {treeEditable && <Button size="sm" variant="ghost" disabled={!changes.length || applying} onClick={() => setDraft({})}>Reset</Button>}
            <Button size="sm" variant="ghost" icon={<Code2 />} style={{ marginLeft: 'auto' }} onClick={() => revealSource(feature)} disabled={!feature.source}>Show in source</Button>
          </div>
        </div>
      </Section>
      {feature.depends_on.length > 0 && (
        <Section title="Depends on" defaultOpen={false}>
          <div className={styles.list}>
            {feature.depends_on.map((id) => {
              const dependency = tree.features.find((item) => item.id === id);
              return <button key={id} type="button" className={styles.listItem} onClick={() => set({ activeFeature: id })}><span className={styles.grow}>{dependency?.label ?? id}</span><span className={styles.muted}>{dependency?.operation}</span></button>;
            })}
          </div>
        </Section>
      )}
    </>
  );
}
