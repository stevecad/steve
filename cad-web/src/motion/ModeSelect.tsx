/**
 * The design's modes (design.mode): which limit set the sliders, drives and live pose use. Shown only when the design
 * declares some; "Default" is the code's own limits. Switching clamps the pose at once, without a rebuild. Used by
 * Properties → Motion and by shares that let visitors move the mechanism (viewing only: it changes no code).
 */
import { Segmented, Select } from '@/ui';
import { setMode, useMotion } from './state';
import type { LimitMode } from './kinematics';
import styles from './Motion.module.css';

const DEFAULT_MODE = '@default';   // Mode names never hold "@".
const NONE: LimitMode[] = [];

export default function ModeSelect() {
  const modes = useMotion((s) => s.built?.modes ?? NONE);
  const mode = useMotion((s) => s.mode);
  if (!modes.length) return null;
  const options = [{ value: DEFAULT_MODE, label: 'Default' }, ...modes.map((item) => ({ value: item.name, label: item.name }))];
  const choose = (value: string) => setMode(value === DEFAULT_MODE ? null : value);
  return (
    <div className={styles.modes} id="motion-modes" data-mode={mode ?? 'default'} title="The limits the joints and couplings move within">
      <span className={styles.modesLabel}>Mode</span>
      {options.length <= 4
        ? <Segmented size="sm" value={mode ?? DEFAULT_MODE} onChange={choose} options={options} />
        : <Select value={mode ?? DEFAULT_MODE} onChange={choose} options={options} ariaLabel="Mode" />}
    </div>
  );
}
