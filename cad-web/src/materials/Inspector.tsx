import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Section } from '@/ui';
import { useApp, type Pick } from '@/state/store';
import { mass, volumeText } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { currentLooks, finishOf, formatQuantity, lookOf, type Assignment, type Library, type Material, type Quantity } from '@/lib/materials';
import type { Look } from '@/lib/modeling';
import { bodiesOfPick, modelingOf } from '@/modeling/bodies';
import { usePhysical } from './usePhysical';
import { openAppearance, openMaterials } from './actions';
import Swatch from './Swatch';
import panel from '@/panels/Panels.module.css';
import styles from './Materials.module.css';

const summary = (material: Material) => [material.properties.youngs_modulus && `E ${formatQuantity(material.properties.youngs_modulus)}`,
  material.properties.yield_strength && `σy ${formatQuantity(material.properties.yield_strength)}`].filter(Boolean).join(' · ') || material.designations[0] || '';

function MaterialCard({ library, body, onClick, id }: { library: Library; body: { material: Material | null; assignment: Assignment | null }; onClick: () => void; id?: string }) {
  const { material, assignment } = body;
  if (!material) {
    return (
      <button type="button" className={styles.material} onClick={onClick} id={id} style={{ borderStyle: 'dashed' }}>
        <span className={styles.materialText}><span className={styles.materialName}>No material</span><span className={styles.materialMeta}>Mass needs a density</span></span>
        <span className={styles.change}>Assign…</span>
      </button>
    );
  }
  const finish = finishOf(library, material, assignment?.finish);
  return (
    <button type="button" className={styles.material} onClick={onClick} id={id}>
      <Swatch surface={{ material, finish, color: assignment?.color ?? null }} size={30} />
      <span className={styles.materialText}>
        <span className={styles.materialName} data-testid="material-name">{material.name}</span>
        <span className={styles.materialMeta}>{[finish?.name, summary(material)].filter(Boolean).join(' · ')}</span>
      </span>
      <span className={styles.change}>Change</span>
    </button>
  );
}

/** A body's appearance in a few words: "Painted · 40% opacity". */
function describeLook(look: Look, library: Library | null): string {
  const words = [look.finish && (library?.finishById.get(look.finish)?.name ?? look.finish),
    typeof look.opacity === 'number' && look.opacity < 1 && `${Math.round(look.opacity * 100)}% opacity`,
    typeof look.roughness === 'number' && `roughness ${look.roughness}`, typeof look.metalness === 'number' && `metalness ${look.metalness}`];
  return words.filter(Boolean).join(' · ') || (look.color ? look.color : 'Set');
}

const PROPERTY_ROWS: [keyof Material['properties'], string][] = [
  ['density', 'Density'], ['youngs_modulus', "Young's modulus"], ['poisson_ratio', "Poisson's ratio"], ['yield_strength', 'Yield strength'], ['ultimate_strength', 'Tensile strength'],
  ['thermal_conductivity', 'Thermal conductivity'], ['thermal_expansion', 'Thermal expansion'],
];

function KeyProperties({ material }: { material: Material }) {
  const rows = PROPERTY_ROWS.filter(([key]) => material.properties[key]);
  return (
    <dl className={panel.rows}>
      {rows.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{formatQuantity(material.properties[key] as Quantity)}</dd></div>)}
    </dl>
  );
}

/** The part's mass stat: from each body's volume and material density. */
export function PartMass() {
  const physical = usePhysical();
  if (physical.mass !== null) return <span className={panel.statValue} id="selection-mass">{mass(physical.mass)}</span>;
  if (!physical.library && (physical.assignments.part || Object.keys(physical.assignments.bodies).length)) return <span className={panel.statValue}>…</span>;
  const missing = physical.bodies.filter((body) => !body.material).length;
  return missing < physical.bodies.length && physical.bodies.length > 1
    ? <button type="button" className={panel.statAction} onClick={() => openMaterials()}>{missing} of {physical.bodies.length} bodies unassigned</button>
    : <button type="button" className={panel.statAction} onClick={() => openMaterials('part')} id="assign-material">Assign material</button>;
}

/** Materials of the displayed part: one card when they agree, a per-body list with masses when they don't. */
export function PartMaterial() {
  const physical = usePhysical();
  const placement = useApp((state) => state.doc.kind === 'design' && !state.doc.activeFile.startsWith('components/'));
  const materialProblems = useApp((state) => modelingOf(state.displayed)?.materials?.problems) ?? [];
  const lookProblems = useApp((state) => modelingOf(state.displayed)?.appearances?.problems) ?? [];
  const problems = [...materialProblems, ...lookProblems];
  const { library, bodies } = physical;
  if (placement) return <p className={panel.muted} style={{ fontSize: 11.5, margin: 0 }}>Components take their materials from their own files; linked parts from their documents.</p>;
  if (!library) return null;
  const mixed = bodies.length > 1 && !physical.uniform;
  return (
    <div className={panel.stack} data-section="materials">
      {mixed ? (
        <div className={styles.bodies} id="body-materials">
          {bodies.map((body) => (
            <button key={body.id} type="button" className={styles.body} onClick={() => openMaterials([body.id])}>
              {body.material ? <Swatch surface={{ material: body.material, finish: finishOf(library, body.material, body.assignment?.finish), color: body.assignment?.color ?? null }} size={16} /> : <span className={panel.swatch} />}
              <span className={styles.bodyName}>{body.label}<small>{body.material?.name ?? 'No material'}</small></span>
              <span className={styles.bodyMass}>{body.mass !== null ? mass(body.mass) : '—'}</span>
            </button>
          ))}
        </div>
      ) : (
        <MaterialCard library={library} body={{ material: physical.uniform ?? physical.part, assignment: physical.bodies[0]?.assignment ?? physical.assignments.part }} onClick={() => openMaterials('part')} id="part-material" />
      )}
      {physical.uniform && <KeyProperties material={physical.uniform} />}
      {problems.map((problem) => <div key={problem} className={panel.note} data-tone="warning"><TriangleAlert size={14} /><span>{problem}</span></div>)}
    </div>
  );
}

/** Material, volume and mass of the body a pick belongs to. */
export function PickMaterial({ pick }: { pick: Pick }) {
  const physical = usePhysical();
  const kind = useApp((state) => state.doc.kind);
  const doc = useApp((state) => state.pastVersion ? null : state.modeling);
  const displayed = useApp((state) => state.displayed);
  const looks = useMemo(() => currentLooks(doc, modelingOf(displayed)), [doc, displayed]);
  const units = useSetting('display.units');
  const ids = bodiesOfPick(pick);
  const body = ids.length === 1 ? physical.bodies.find((b) => b.id === ids[0]) : physical.bodies.length === 1 ? physical.bodies[0] : undefined;
  if (kind !== 'part' || !body || !physical.library) return null;
  const look = lookOf(looks, body.id || null);
  return (
    <Section title="Material" id="pick-material">
    <div className={panel.stack} id="body-material">
      <MaterialCard library={physical.library} body={body} onClick={() => openMaterials(body.id ? [body.id] : 'part')} />
      <dl className={panel.rows}>
        <div><dt>Body</dt><dd>{body.label}</dd></div>
        <div><dt>Volume</dt><dd>{volumeText(body.volume, units)}</dd></div>
        <div data-emphasis><dt>Mass</dt><dd id="body-mass">{body.mass !== null ? mass(body.mass) : '—'}</dd></div>
        {body.material?.properties.density && <div><dt>Density</dt><dd>{formatQuantity(body.material.properties.density)}</dd></div>}
        <div><dt>Appearance</dt><dd>
          <button type="button" className={panel.statAction} id="body-appearance" onClick={() => openAppearance(body.id ? [body.id] : 'part')}
            title="Color, finish and opacity apart from the material: never a mass">
            {look?.color && <span className={panel.swatch} style={{ background: look.color, display: 'inline-block', verticalAlign: 'middle', marginRight: 5 }} />}
            {look ? describeLook(look, physical.library) : 'From the material'}
          </button>
        </dd></div>
      </dl>
    </div>
    </Section>
  );
}
