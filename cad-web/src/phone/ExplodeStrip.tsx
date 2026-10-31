/**
 * The exploded view on a phone: one row just above the bar instead of a sheet, so the model keeps the screen and
 * stays touchable while the slider is dragged. The app's phone shell (PhoneShell.tsx) and the share page's both use
 * it; it only draws, the owner holds the value.
 */
import { Expand, Shrink, X } from 'lucide-react';
import { Slider } from '@/ui';
import styles from './Phone.module.css';

export default function ExplodeStrip({ value, max = 1, onChange, onClose, id }: { value: number; max?: number; onChange: (value: number) => void; onClose: () => void; id: string }) {
  return (
    <div className={styles.explodeStrip} id={id} role="group" aria-label="Exploded view">
      <Expand size={18} strokeWidth={1.6} className={styles.explodeIcon} aria-hidden />
      <div className={styles.explodeSlider}><Slider label="Explode distance" value={value} min={0} max={max} step={0.001} onChange={onChange} /></div>
      <span className={`${styles.explodeValue} tnum`}>{Math.round(value * 100)}%</span>
      <button type="button" className={styles.chipButton} aria-label="Collapse" aria-disabled={value === 0 || undefined} onClick={() => onChange(0)}><Shrink size={18} /></button>
      <button type="button" className={styles.chipButton} aria-label="Close exploded view" id={`${id}-close`} onClick={onClose}><X size={18} /></button>
    </div>
  );
}
