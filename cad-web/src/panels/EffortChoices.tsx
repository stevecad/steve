/** Reasoning effort as a short list: Automatic, then the levels the model offers, each with its trade-off in a line. */
import { Check } from 'lucide-react';
import { EFFORTS, type Effort } from './effort';
import styles from './Assistant.module.css';

export default function EffortChoices({ value, offered, onChoose, label = 'Reasoning effort', disabled }: {
  value: Effort;
  offered: Effort[];
  onChoose: (effort: Effort) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className={styles.efforts} role="radiogroup" aria-label={label}>
      {(['auto', ...offered] as Effort[]).map((effort) => {
        const on = effort === value;
        return (
          <button key={effort} type="button" role="radio" aria-checked={on} className={styles.effort} data-on={on || undefined} data-effort={effort}
            disabled={disabled} onClick={() => { if (!on) onChoose(effort); }}>
            <span className={styles.effortRadio}>{on && <Check size={11} />}</span>
            <span className={styles.effortText}><b>{EFFORTS[effort].label}</b><small>{EFFORTS[effort].hint}</small></span>
          </button>
        );
      })}
    </div>
  );
}
