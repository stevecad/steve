/**
 * The building blocks of a Settings panel: a page (its header says what the section is for), cards of related
 * settings, and rows (label and help on the left, the control on the right). A row bound to a setting shows when it
 * differs from the default and offers to put it back.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, RotateCcw } from 'lucide-react';
import { Button, Tip } from '@/ui';
import controls from './Controls.module.css';
import { resetSettings, useSettings, type SettingKey } from './store';
import { INTEGRATIONS, useSettingsDialog, type SettingsSectionDef } from './registry';
import styles from './Settings.module.css';
import { openDocs } from '@/lib/docs';

/** One preset treatment for keyboard, mouse and compute preferences. */
export function ChoiceCards<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: { value: T; label: string; description: string }[];
  onChange: (value: T) => void; disabled?: boolean;
}) {
  return <div className={controls.choices} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" className={controls.choice} disabled={disabled}
      aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
      <strong>{option.label}</strong><span>{option.description}</span>
    </button>)}
  </div>;
}

/** Explicit-save fields share dirty, saving, success and failure feedback. */
export function SettingsEditor({ value, onSave, label, rows = 8 }: {
  value: string; onSave: (value: string) => Promise<void>; label: string; rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const changed = draft !== value;
  const props = { className: controls.input, 'aria-label': label, value: draft, disabled: saving,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); setSaved(false); setError(''); } };
  return <div className={controls.form}>
    {rows === 1 ? <input {...props} /> : <textarea {...props} rows={rows} />}
    {error && <p className={controls.error} role="alert">{error}</p>}
    <div className={controls.actions}>
      <Button variant="primary" disabled={saving || !changed} onClick={() => {
        setSaving(true); setError('');
        void onSave(draft).then(() => setSaved(true)).catch(e => setError(e instanceof Error ? e.message : 'Could not save changes.')).finally(() => setSaving(false));
      }}>{saving ? 'Saving…' : 'Save changes'}</Button>
      <Button disabled={saving || !changed} onClick={() => { setDraft(value); setError(''); setSaved(false); }}>Discard changes</Button>
      <span className={controls.status} role="status">{saving ? 'Saving on this machine…' : changed ? 'Unsaved changes' : saved ? 'Changes saved' : 'No unsaved changes'}</span>
    </div>
  </div>;
}

export function SettingsPage({ section, actions, children, id }: { section: SettingsSectionDef; actions?: ReactNode; children: ReactNode; id?: string }) {
  const Icon = section.icon;
  return (
    <div className={styles.page} data-settings-page={section.id} id={id}>
      <header className={styles.pageHead}>
        {section.integration && section.group === 'Integrations' && (
          <Tip label="All integrations">
            <button type="button" className={styles.backLink} aria-label="Back to all integrations" data-settings-back
                    onClick={() => useSettingsDialog.setState({ section: INTEGRATIONS })}><ArrowLeft size={15} /></button>
          </Tip>
        )}
        <span className={styles.pageIcon}><Icon size={18} /></span>
        <div className={styles.pageTitle}>
          <h2>{section.label}</h2>
          <p>{section.description}</p>
        </div>
        {actions}
        {section.docs && (
          <a className={styles.docsLink} href={section.docs} onClick={(event) => { event.preventDefault(); openDocs(section.docs!); }} data-section-docs>
            <BookOpen size={14} />
            <span>Docs</span>
          </a>
        )}
      </header>
      <div className={styles.pageBody}>{children}</div>
    </div>
  );
}

export function Card({ title, description, actions, children, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className={styles.card} id={id}>
      <header className={styles.cardHead}>
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </header>
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One setting: label and help, then its control. `setting` marks it changed from the default, with a reset. */
export function Row({ label, hint, setting, children, stack, htmlFor }: { label: ReactNode; hint?: ReactNode; setting?: SettingKey; children: ReactNode; stack?: boolean; htmlFor?: string }) {
  const changed = useSettings((state) => (setting ? !same(state.values[setting], state.defaults[setting]) : false));
  const saving = useSettings((state) => (setting ? state.saving.includes(setting) : false));
  return (
    <div className={styles.row} data-stack={stack || undefined} data-setting={setting} data-changed={changed || undefined} data-saving={saving || undefined}>
      <div className={styles.rowText}>
        <label className={styles.rowLabel} htmlFor={htmlFor}>
          {label}
          {changed && setting && (
            <Tip label="Changed from the default" description="Put it back to the default.">
              <button type="button" className={styles.reset} aria-label={`Reset ${typeof label === 'string' ? label : 'this setting'}`} onClick={() => void resetSettings([setting])}><RotateCcw size={11} /></button>
            </Tip>
          )}
        </label>
        {hint && <p className={styles.rowHint}>{hint}</p>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

/** A note inside a card (what a setting depends on, or where else it shows). */
export const Note = ({ children, tone }: { children: ReactNode; tone?: 'warning' | 'info' }) => <p className={styles.note} data-tone={tone}>{children}</p>;

/** What's over (revoked, expired) at the bottom of a list, folded away: the list itself shows what's in use. */
export function Past({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <details className={styles.past} data-past>
      <summary><ChevronRight size={12} className={styles.pastChevron} /> {label} ({count})</summary>
      {children}
    </details>
  );
}
