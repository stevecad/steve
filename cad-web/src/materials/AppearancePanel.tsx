import { useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { Button, Segmented, Slider, Switch } from '@/ui';
import { toast, useApp } from '@/state/store';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import { cleanLook, currentLooks, lookOf, useLibrary } from '@/lib/materials';
import { bodyOrder, faceLooks } from '@/lib/bodyOrder';
import type { Look } from '@/lib/modeling';
import { bodiesOfPick, bodyIds, bodyLabel, modelingOf } from '@/modeling/bodies';
import { refFor } from '@/modeling/dialog';
import { assignAppearance, assignFaceAppearance, closeAppearance, useAppearanceTool } from './actions';
import { PLAIN } from './render';
import view from '@/viewport/Viewport.module.css';
import styles from './Materials.module.css';

/** The 0–1 numbers of a look, with the value a switched-on field starts from. */
const NUMBERS = [['opacity', 'Opacity', 0.4], ['roughness', 'Roughness', PLAIN.roughness], ['metalness', 'Metalness', PLAIN.metalness]] as const;

/**
 * The Appearance tool's options (a Dock tab): color, finish, opacity, roughness and metalness of the part, some
 * bodies or the picked faces (by their references), written as `model.appearance(...)`. Only the look: mass,
 * simulation and machining follow `model.material`.
 */
export default function AppearancePanel() {
  const initial = useAppearanceTool((state) => state.target);
  const doc = useApp((state) => state.modeling);
  const displayed = useApp((state) => state.displayed);
  const appBusy = useApp((state) => state.busy);
  const library = useLibrary();
  const bodies = useMemo(() => {
    const report = modelingOf(displayed);
    return bodyIds(displayed).map((id) => ({ id, label: bodyLabel(id, doc, report) }));
  }, [displayed, doc]);
  const report = modelingOf(displayed);
  const looks = currentLooks(doc, report);
  // Faces: the faces picked in the viewport (of the part, or the open component's instances), by their references.
  const selection = useApp((state) => state.selection);
  const picked = useMemo(() => selection.filter((pick) => pick.kind === 'face' && bodiesOfPick(pick).length), [selection]);
  const refs = useMemo(() => [...new Set(picked.map(refFor).filter((ref): ref is string => !!ref))], [picked]);
  const [kind, setKind] = useState<'part' | 'bodies' | 'faces'>(Array.isArray(initial) && initial.length ? 'bodies' : 'part');
  const [chosen, setChosen] = useState<string[]>(Array.isArray(initial) ? initial : []);
  const first = picked[0];
  const faceLook = first?.kind === 'face' ? faceLooks(report, bodyOrder(report)).get(first.index) : undefined;
  const current = kind === 'part' ? looks.part : kind === 'faces' ? cleanLook(faceLook) : lookOf(looks, chosen[0] ?? null);
  const [draft, setDraft] = useState<Look>(() => ({ ...current }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (change: Look) => setDraft((value) => ({ ...value, ...change }));
  const toggleBody = (id: string) => setChosen((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  const where = kind === 'part' ? 'the part' : kind === 'faces' ? (refs.length === 1 ? '1 face' : `${refs.length} faces`)
    : chosen.length === 1 ? (bodies.find((b) => b.id === chosen[0])?.label ?? chosen[0]) : `${chosen.length} bodies`;
  const look = cleanLook(draft);
  const unnamed = kind === 'faces' && picked.some((pick) => !refFor(pick));

  const apply = async (value: Look | null) => {
    setSaving(true); setError(null);
    const problem = kind === 'faces' ? await assignFaceAppearance(refs, value) : await assignAppearance(kind === 'part' ? 'part' : chosen, value);
    setSaving(false);
    if (problem) { setError(problem); return; }
    toast('success', value ? `Appearance → ${where}` : `Appearance cleared from ${where}`);
    closeAppearance();
  };

  return (
    <Panel id="appearance" icon={<Palette size={16} />} title="Appearance" onClose={closeAppearance}
      footer={<ToolFooter onCancel={closeAppearance} onOk={() => void apply(look)} okId="appearance-ok" okBusy={saving}
        okTitle={look ? `Give ${where} this look` : `Clear the appearance of ${where}`}
        okDisabled={appBusy ? 'Working…' : kind === 'bodies' && !chosen.length ? 'Choose at least one body.'
          : kind === 'faces' && unnamed ? 'Some picked faces have no name to refer to; pick faces of modeling features.'
            : kind === 'faces' && !refs.length ? 'Pick faces in the viewport.' : !look && !current ? 'Set a color, finish, opacity, roughness or metalness.' : null}
        extra={current && <Button size="sm" variant="ghost" disabled={saving} onClick={() => void apply(null)} id="appearance-clear">Clear appearance</Button>} />}>
      <div className={view.panelRow}>
        <span className={view.panelLabel}>Apply to</span>
        <Segmented size="sm" value={kind} onChange={(next) => { setKind(next); if (next === 'bodies' && !chosen.length && bodies[0]) setChosen([bodies[0].id]); }} options={[
          { value: 'part', label: 'Whole part' },
          { value: 'bodies', label: 'Bodies', disabled: bodies.length < 1, title: bodies.length ? 'Choose which bodies' : 'There are no bodies yet' },
          { value: 'faces', label: 'Faces', disabled: bodies.length < 1, title: bodies.length ? 'Some faces of a body: bands, trims, inner and outer sides. The solid stays one solid.' : 'There are no bodies yet' },
        ]} />
      </div>
      {kind === 'faces' && (
        <div className={view.panelHint} id="appearance-faces">
          {refs.length ? <>Faces: <span className="mono">{refs.slice(0, 3).join(', ')}{refs.length > 3 ? ` and ${refs.length - 3} more` : ''}</span></> : 'Pick faces in the viewport (Shift adds more).'}
        </div>
      )}
      {kind === 'bodies' && (
        <div className={styles.bodyChips} role="group" aria-label="Bodies to change">
          {bodies.map((body) => (
            <button key={body.id} type="button" className={styles.bodyChip} aria-pressed={chosen.includes(body.id)} data-body={body.id} onClick={() => toggleBody(body.id)}>{body.label}</button>
          ))}
        </div>
      )}
      <div className={view.panelRow}>
        <span className={view.panelLabel}>Color</span>
        <span className={styles.colorRow}>
          {draft.color
            ? <><input type="color" aria-label="Appearance color" value={draft.color} onChange={(event) => patch({ color: event.target.value })} />
              <button type="button" className={styles.link} onClick={() => patch({ color: null })}>Clear</button></>
            : <button type="button" className={styles.link} id="appearance-color" onClick={() => patch({ color: PLAIN.color })}>Set color</button>}
        </span>
      </div>
      <span className={view.panelLabel}>Finish</span>
      <div className={styles.finishes} role="radiogroup" aria-label="Finish" style={{ marginTop: 0 }}>
        <button type="button" role="radio" aria-checked={!draft.finish} className={styles.finish} onClick={() => patch({ finish: null })}>None</button>
        {library?.finishes.map((finish) => (
          <button key={finish.id} type="button" role="radio" aria-checked={draft.finish === finish.id} className={styles.finish} onClick={() => patch({ finish: finish.id })}>{finish.name}</button>
        ))}
      </div>
      {NUMBERS.map(([key, label, start]) => {
        const value = draft[key];
        return (
          <div key={key} data-field={key}>
            <div className={view.panelRow}>
              <span className={view.panelLabel}>{label}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="tnum" style={{ fontSize: 12 }}>{typeof value === 'number' ? value.toFixed(2) : '—'}</span>
                <Switch label={`Set ${label.toLowerCase()}`} checked={typeof value === 'number'} onCheckedChange={(on) => patch({ [key]: on ? start : null } as Look)} />
              </span>
            </div>
            {typeof value === 'number' && <Slider label={label} value={value} step={0.01} onChange={(next) => patch({ [key]: Math.round(next * 100) / 100 } as Look)} />}
          </div>
        );
      })}
      {error && <div className={view.panelHint} data-tone="warning" role="alert">{error}</div>}
      <div className={view.panelHint}>
        Only the look: mass, simulation and machining follow the material, and a body without one has no mass.
        Written into the design as <span className="mono">model.appearance(…)</span>; it wins over the material’s color and finish, and a face’s over its body’s.
      </div>
    </Panel>
  );
}
