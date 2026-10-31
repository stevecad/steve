import { useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Html } from '@react-three/drei';
import { useSetting } from '@/settings/store';
import { ANGLE_UNITS, hasLengthUnit } from '@/lib/lengths';
import { useScrub } from '@/ui/useScrub';
import { useSketch, type HeadsField } from './session';
import { commitTyped, escape, measuredText, setTyped, typeSize } from './tools';
import styles from './Sketch.module.css';

const inputs = new Map<string, HTMLInputElement>();

let seeding = false;

/** Focuses a size; with `key`, types that character into it (via state, so React owns the value). */
function focusField(field: string | undefined, key?: string) {
  if (!field) return;
  if (key !== undefined) {
    // Keys that arrive before the input has mounted (drei renders it a frame later) still count.
    const state = useSketch.getState();
    const prior = state.fieldFocus === field && document.activeElement !== inputs.get(field) ? state.typed[field]?.source ?? '' : '';
    flushSync(() => typeSize(field, prior + key));
  }
  useSketch.setState({ fieldFocus: field });
  const input = inputs.get(field);
  if (!input) return;
  seeding = key !== undefined;
  input.focus();
  seeding = false;
  if (key !== undefined) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();
}

/** Sizes of the shape being drawn, as inputs on the geometry: type to lock a size, Tab to the next, Enter to place. */
export default function SketchFields() {
  const fields = useSketch((s) => s.fields);
  useEffect(() => {
    // A number typed while drawing goes into the first (or focused) size, as in other CAD tools.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
      const { fields: current, fieldFocus } = useSketch.getState();
      if (!current.length) return;
      if (/^[0-9.\-]$/.test(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        focusField(fieldFocus && current.some((f) => f.key === fieldFocus) ? fieldFocus : current[0].key, event.key);
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        focusField(current[0].key);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return <>{fields.map((f) => <Field key={f.key} field={f} order={fields.map((x) => x.key)} />)}</>;
}

function Field({ field, order }: { field: HeadsField; order: string[] }) {
  const entry = useSketch((s) => s.typed[field.key]);
  const focused = useSketch((s) => s.fieldFocus === field.key);
  // drei's Html mounts its children in a separate root, later than this component's effects: register on mount.
  const ref = useCallback((input: HTMLInputElement | null) => {
    if (input) {
      inputs.set(field.key, input);
      if (useSketch.getState().fieldFocus === field.key) {
        seeding = true; input.focus(); seeding = false;
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } else if (inputs.get(field.key) && !inputs.get(field.key)!.isConnected) inputs.delete(field.key);
  }, [field.key]);
  const units = useSetting('display.units');
  const shown = entry ? entry.source : measuredText(field, units);
  // Dragging a plain number sideways locks the size as typing does (Enter or a click still places the shape); Esc puts back what was there.
  const scrub = useScrub({ text: shown, positive: !field.angle, onScrub: (text) => typeSize(field.key, text), onCommit: () => {},
    onCancel: () => (entry ? setTyped(field.key, entry.source, entry.value) : setTyped(field.key, '', null)) });
  return (
    <Html position={[field.at[0], field.at[1], 0]} center zIndexRange={[45, 0]}>
      <label className={styles.heads} data-locked={entry && entry.value !== null ? true : undefined} data-invalid={entry && entry.value === null ? true : undefined} data-focused={focused || undefined}
        title={field.angle && entry && entry.value === null && hasLengthUnit(entry.source) ? ANGLE_UNITS : undefined} onPointerDown={(event) => event.stopPropagation()}>
        <span>{field.label}</span>
        <input {...scrub.props} ref={ref} value={shown} spellCheck={false} aria-label={{ length: 'Length', angle: 'Angle', width: 'Width', height: 'Height', diameter: 'Diameter', radius: 'Radius' }[field.key] ?? field.key}
          data-field={field.key} aria-invalid={!!entry && entry.value === null}
          onFocus={(event) => { useSketch.setState({ fieldFocus: field.key }); if (!seeding) event.target.select(); }}
          onBlur={() => { if (useSketch.getState().fieldFocus === field.key) useSketch.setState({ fieldFocus: null }); }}
          // Typing the displayed value (notably 0°) still locks it. React's
          // change event can skip equal values; the native input event cannot.
          onInput={(event) => { if (!useSketch.getState().typed[field.key]) typeSize(field.key, event.currentTarget.value); }}
          onChange={(event) => typeSize(field.key, event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            // Until something is typed the input shows the live measured size: the first character replaces it. (Its
            // selection can't be relied on: drei renders this input in its own root, so the measured value it shows
            // can be rewritten a commit after focus, which puts the caret at the end.)
            if (!useSketch.getState().typed[field.key] && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) (event.target as HTMLInputElement).select();
            if (event.key === 'Tab') {
              event.preventDefault();
              const next = order[(order.indexOf(field.key) + (event.shiftKey ? order.length - 1 : 1)) % order.length];
              focusField(next);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              commitTyped();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
              escape();
            }
          }} />
        {field.angle ? <em>°</em> : units === 'in' ? <em>in</em> : null}
      </label>
    </Html>
  );
}
