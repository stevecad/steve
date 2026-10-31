import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Variable } from 'lucide-react';
import { Button, NumberField, Section } from '@/ui';
import { set, useApp } from '@/state/store';
import { applyFeatureEdit } from './featureEdit';
import { clampToLimits } from '@/lib/features';
import { revealSource } from './FeatureTree';
import styles from '@/panels/Panels.module.css';

/** Change parameters: the source's top-level numeric variables, edited together and verified by the server. */
export default function ParametersInspector() {
  const features = useApp((state) => state.features);
  const focus = useApp((state) => state.parameterFocus);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => { if (focus) rows.current[focus]?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focus]);

  const tree = features?.state === 'ready' ? features.tree : null;
  const parameters = tree?.design_parameters ?? [];
  const treeEditable = !!tree && tree.editable && tree.execution_verified;
  const changes = Object.entries(draft).filter(([name, value]) => parameters.find((item) => item.name === name)?.value !== value);
  const labelOf = (id: string) => tree?.features.find((feature) => feature.id === id)?.label ?? id;

  const apply = async () => {
    setApplying(true);
    setError(null);
    const message = await applyFeatureEdit(changes.map(([name, value]) => ({ design_parameter: name, value })), changes.length === 1 ? changes[0][0] : `${changes.length} parameters`, null);
    if (message) setError(message); else setDraft({});
    setApplying(false);
    if (!message) set({ activeFeature: '__parameters' });
  };

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Variable size={19} /></div>
        <div className={styles.heroText}>
          <div className={styles.heroTitle}>Design parameters</div>
          <div className={styles.heroSub}><span>{parameters.length} variables in the source</span></div>
        </div>
      </div>
      <Section title="Parameters">
        <div className={styles.stack}>
          {!parameters.length && <p className={styles.muted} style={{ fontSize: 11.5 }}>Named numbers at the top of the source (for example <span className="mono">hole_diameter = 6</span>) appear here once the server reports them.</p>}
          {parameters.map((parameter) => {
            const editable = treeEditable && parameter.editable;
            const consumers = parameter.used_by.map(labelOf);
            return (
              <div key={parameter.name} ref={(element) => { rows.current[parameter.name] = element; }} className={styles.paramRow} data-focus={focus === parameter.name || undefined}>
                <div className={styles.paramHead}>
                  <button type="button" className={`mono ${styles.paramName}`} title="Show in source" onClick={() => parameter.source && revealSource({ id: parameter.name, operation: 'parameter', label: parameter.name, category: 'reference', depends_on: [], parameters: {}, source: parameter.source })}>{parameter.name}</button>
                  <div style={{ width: 128 }}>
                    <NumberField value={draft[parameter.name] ?? parameter.value} unit={parameter.unit ?? ''} disabled={!editable || applying}
                      min={parameter.limits?.min ?? parameter.limits?.exclusive_min} max={parameter.limits?.max} ariaLabel={parameter.name}
                      onChange={(value) => setDraft((current) => ({ ...current, [parameter.name]: clampToLimits(value, parameter.limits) }))} />
                  </div>
                </div>
                <div className={styles.paramUses}>
                  {consumers.length ? consumers.slice(0, 6).map((label, index) => <span key={index} className={styles.useChip}>{label}</span>) : <span className={styles.muted}>Not used by a captured feature</span>}
                  {consumers.length > 6 && <span className={styles.muted}>+{consumers.length - 6}</span>}
                </div>
                {!editable && parameter.reason && <p className={styles.muted} style={{ fontSize: 10.5 }}>{parameter.reason}</p>}
              </div>
            );
          })}
          {error && <div className={styles.note} data-tone="warning"><CircleAlert size={15} /><span><b>Edit rejected.</b> {error} Your values are kept; the saved design is unchanged.</span></div>}
          {parameters.length > 0 && (
            <div className={styles.actions}>
              <Button variant="primary" size="sm" disabled={!changes.length || applying || !treeEditable} onClick={() => { void apply(); }}>{applying ? 'Applying…' : changes.length > 1 ? `Apply ${changes.length} changes` : 'Apply'}</Button>
              <Button size="sm" variant="ghost" disabled={!changes.length || applying} onClick={() => setDraft({})}>Reset</Button>
            </div>
          )}
          {!treeEditable && tree && <p className={styles.muted} style={{ fontSize: 10.5 }}>{tree.execution_verified ? 'This server doesn’t support editing these parameters yet.' : 'Generate the current source before editing parameters.'}</p>}
        </div>
      </Section>
    </>
  );
}
