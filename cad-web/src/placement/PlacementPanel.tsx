/** The Place tool's options: where the instance sits and how it is turned; Apply writes `at=` in main.py. */
import { Move3d } from 'lucide-react';
import * as THREE from 'three';
import { NumberField, Segmented } from '@/ui';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import styles from '@/viewport/Viewport.module.css';
import { applyPlacement, atSource, closePlacement, setPlacement, usePlacement } from './placement';

const AXES = [['X', 'var(--axis-x)'], ['Y', 'var(--axis-y)'], ['Z', 'var(--axis-z)']] as const;

export default function PlacementPanel() {
  const draft = usePlacement();
  if (!draft.instance) return null;
  const axis = new THREE.Vector3(...draft.axis).normalize();
  const named = (['X', 'Y', 'Z'] as const).find((_, i) => Math.abs(Math.abs(axis.getComponent(i)) - 1) < 1e-6);
  const signed = named ? draft.angle * Math.sign(axis.getComponent('XYZ'.indexOf(named))) : draft.angle;
  return (
    <Panel id="place" icon={<Move3d size={16} />} title={`Place ${draft.instance}`} onClose={closePlacement}
      footer={<ToolFooter onCancel={closePlacement} onOk={() => { void applyPlacement(); }} okId="place-apply" okTitle={`Place ${draft.instance} here`} okDisabled={draft.error} />}>
      <div className={styles.panelHint}>Drag the arrows, squares or rings on the canvas, or type the position.</div>
      {AXES.map(([name, color], i) => (
        <div key={name} className={styles.panelRow}>
          <span className={styles.panelLabel}>{name}</span>
          <div style={{ width: 130 }}>
            <NumberField value={Number(draft.position[i].toFixed(3))} prefix={name} prefixColor={color} ariaLabel={`${name} position`}
              onChange={(value) => setPlacement({ position: draft.position.map((v, j) => (j === i ? value : v)) as [number, number, number] })} />
          </div>
        </div>
      ))}
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Turn about</span>
        <Segmented size="sm" value={named ?? 'custom'} onChange={(value) => { if (value !== 'custom') setPlacement({ axis: { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[value] as [number, number, number], angle: signed }); }}
          options={[{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }, ...(named ? [] : [{ value: 'custom' as const, label: 'Custom', disabled: true }])]} />
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Angle</span>
        <div style={{ width: 130 }}>
          <NumberField value={Number(signed.toFixed(2))} unit="°" step={5} ariaLabel="Turn angle"
            onChange={(value) => setPlacement(named ? { axis: { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[named] as [number, number, number], angle: value } : { angle: value })} />
        </div>
      </div>
      <div className={styles.panelHint} data-tone={draft.error ? 'warning' : undefined} id="place-hint">
        {draft.error ?? <>Writes <span className="mono">at={atSource(draft)}</span> into main.py.</>}
      </div>
    </Panel>
  );
}
