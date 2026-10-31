import { useState } from 'react';
import { Button, Select, Spinner } from '@/ui';
import { OWN_PROPERTIES, OWN_UNITS, PROPERTY_LABELS, saveOwnMaterial, type Library, type OwnMaterial, type OwnMaterialInput, type PropertyKey } from '@/lib/materials';
import styles from './Materials.module.css';

/**
 * One of the person's own materials, new or changed (app/user_materials.py): its name, category, look and values in
 * the library's units. A copy of a library material keeps which one it came from (shown as "Modified"); the library
 * itself never changes. Shown in the Materials dialog's detail pane.
 */
export default function OwnMaterialEditor({ library, id, initial, onSaved, onCancel }: {
  library: Library; id: string | null; initial: OwnMaterialInput; onSaved: (saved: OwnMaterial) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [values, setValues] = useState<Partial<Record<PropertyKey, string>>>(() =>
    Object.fromEntries(OWN_PROPERTIES.filter((key) => initial.properties[key] !== undefined).map((key) => [key, String(initial.properties[key])])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = draft.based_on ? library.byId.get(draft.based_on) : undefined;
  const sample = base ?? library.materials.find((m) => !m.own && m.category === draft.category);
  const change = (fields: Partial<OwnMaterialInput>) => setDraft((current) => ({ ...current, ...fields }));

  const save = async () => {
    const properties: Partial<Record<PropertyKey, number>> = {};
    for (const key of OWN_PROPERTIES) {
      const text = values[key]?.trim();
      if (!text) continue;
      const value = Number(text);
      if (!Number.isFinite(value)) { setError(`${PROPERTY_LABELS[key]} must be a number.`); return; }
      properties[key] = value;
    }
    if (!draft.name.trim()) { setError('Give the material a name.'); return; }
    setBusy(true); setError(null);
    try {
      onSaved(await saveOwnMaterial(id, { ...draft, name: draft.name.trim(), properties }));
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.detailInner} id="own-material-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className={styles.name}>{id ? 'Edit your material' : base ? 'Modified copy' : 'New material'}</h3>
      {base && <div className={styles.muted}>Copied from {base.name}. The library’s {base.name} stays as it is; both can be assigned.</div>}
      <label className={styles.ownField}>
        <span className={styles.fieldLabel}>Name</span>
        <input className={styles.ownInput} value={draft.name} maxLength={100} required aria-label="Name" onChange={(event) => change({ name: event.target.value })} />
      </label>
      <div className={styles.ownField}>
        <span className={styles.fieldLabel}>Category</span>
        <Select ariaLabel="Category" value={draft.category} onChange={(category) => change({ category })}
          options={library.categories.map((c) => ({ value: c.id, label: c.name, hint: c.group }))} />
      </div>
      <div className={styles.colorRow}>
        <span className={styles.fieldLabel}>Color</span>
        <input type="color" aria-label="Color" value={draft.color ?? sample?.appearance.base_color.srgb ?? '#9aa0a6'} onChange={(event) => change({ color: event.target.value })} />
        {draft.color ? <button type="button" className={styles.link} onClick={() => change({ color: null })}>Use the {base ? 'original' : 'category’s'} color</button>
          : <span className={styles.muted}>{base ? 'As the original' : 'The category’s'}</span>}
      </div>
      <label className={styles.ownField}>
        <span className={styles.fieldLabel}>Notes</span>
        <textarea className={styles.ownInput} rows={2} value={draft.description} maxLength={1000} aria-label="Notes" placeholder="Supplier, data sheet, grade…"
          onChange={(event) => change({ description: event.target.value })} />
      </label>
      <div className={styles.fieldLabel}>Properties <span className={styles.muted}>(leave empty when unknown)</span></div>
      <div className={styles.ownProps}>
        {OWN_PROPERTIES.map((key) => (
          <label key={key} className={styles.ownProp}>
            <span>{PROPERTY_LABELS[key]}</span>
            <input className={styles.ownInput} inputMode="decimal" aria-label={PROPERTY_LABELS[key]} data-property={key} value={values[key] ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
            <span className={styles.muted}>{OWN_UNITS[key]}</span>
          </label>
        ))}
      </div>
      <div className={styles.muted}>Density gives the mass; simulations use the stiffness, strength and thermal values.</div>
      {error && <span className={styles.error} role="alert">{error}</span>}
      <div className={styles.ownActions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy} id="own-material-save">{busy ? <Spinner /> : null}{id ? 'Save' : 'Add to my materials'}</Button>
      </div>
    </form>
  );
}
