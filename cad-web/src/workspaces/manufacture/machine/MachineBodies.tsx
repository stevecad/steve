/**
 * A machine model's collision bodies (docs/MANUFACTURING_MACHINE_SOLIDS.md, docs/MANUFACTURING_MACHINE_MESHES.md):
 * what the machine is made of, for the collision checks of every job that runs on it.
 *
 * Each body rides on one node of the kinematic chain (the base, an axis) and comes from a saved STEVE part or design
 * (one solid at an exact revision), an uploaded STL, or a box. The 3D view places them by kinematics; the pose sliders
 * move the axes (a display only). Bodies are edited in the record's draft and saved with it as a new revision: a CAD
 * body's revision is pinned when the machine is saved; an uploaded STL is checked by the first job that uses it.
 */
import { useMemo, useRef, useState } from 'react';
import { Box, Boxes, ChevronRight, FileUp, Home, Pencil, Trash2 } from 'lucide-react';
import { Button, NumberField, Spinner } from '@/ui';
import { toast } from '@/state/store';
import { slugify } from '../fieldHelp';
import { report } from '../state';
import { uploadStl, type BodySource, type Bounds, type CollisionBody } from './bodyGeometry';
import CadBodyPicker, { type PickedBody } from './CadBodyPicker';
import MachineView, { PALETTE, useBodyGeometry } from './MachineView';
import { depthOf, forwardKinematics, joints, restValue, type Frame, type MachineNode, type Pose, type Vec3 } from './kinematics';
import styles from './Machine.module.css';

type Definition = Record<string, unknown>;
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const REPRESENTATION: Record<CollisionBody['representation'], string> = { brep: 'CAD solid', mesh: 'STL mesh', solid_box: 'Box', enclosing_box: 'Enclosing box' };
const COVERAGE: { value: string; label: string; hint: string }[] = [
  { value: 'missing', label: 'Not described', hint: 'No machine collisions are checked.' },
  { value: 'partial', label: 'Some of the machine', hint: 'Checks cover these bodies; the rest of the machine stays unchecked.' },
  { value: 'complete', label: 'The whole machine', hint: 'These bodies are everything a tool, fixture or part could hit.' },
];

const fmt = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const uniqueId = (wanted: string, bodies: CollisionBody[]) => {
  const base = (slugify(wanted, 56) ?? 'body');
  let id = base;
  for (let n = 2; bodies.some((body) => body.id === id); n++) id = `${base}_${n}`;
  return id;
};

function Vector({ label, value, onChange, readOnly, name }: { label: string; value: Vec3; onChange: (next: Vec3) => void; readOnly: boolean; name: string }) {
  return (
    <div className={styles.row} data-vector={name}>
      <span className={styles.label}>{label}</span>
      <span className={styles.vector}>
        {value.map((item, index) => (
          <NumberField key={index} className={styles.input} unit="" optional eager value={item} disabled={readOnly} ariaLabel={`${label} ${'XYZ'[index]}`}
            onChange={(entered) => { const next = [...value] as Vec3; next[index] = entered ?? 0; onChange(next); }} />
        ))}
      </span>
    </div>
  );
}

/** A body's status: where its geometry comes from and when it's checked, in plain words. */
function Status({ body, saved }: { body: CollisionBody; saved: boolean }) {
  const { look, note } = useBodyGeometry(body);
  const source = body.geometry_source;
  let text: string;
  if (body.representation === 'mesh') text = body.artifact ? `STL stored (${(body.artifact.bytes / 1024).toFixed(1)} KB) · checked by the first job that uses it` : 'No STL uploaded yet';
  else if (body.representation === 'brep' && source) text = saved ? `Pinned: revision ${source.revision}, body “${source.body}”` : `Revision ${source.revision} is pinned when you save`;
  else if (body.representation === 'brep') text = 'A BRep file';
  else text = body.representation === 'solid_box' ? 'Exactly this box' : 'A box around the real part (conservative)';
  return (
    <small className={styles.status} data-look={look} data-body-status>
      {look === 'loading' && <Spinner size={10} />} {text}{note ? ` · ${note}` : ''}
    </small>
  );
}

export default function MachineBodies({ definition, readOnly, saved, onChange, onEdit, errors }: {
  definition: Definition;
  /** Not being edited: changes start editing first (onEdit). */
  readOnly: boolean;
  /** The definition shown is a saved revision (not a draft). */
  saved: boolean;
  onChange: (next: Definition) => void;
  onEdit: () => Definition | null;
  errors: Map<string, string>;
}) {
  const nodes = list<MachineNode>(definition.nodes);
  const bodies = list<CollisionBody>(definition.collision_geometry);
  const attachments = list<{ id: string; node: string; role: string; frame?: Partial<Frame> | null }>(definition.attachments);
  const poses = list<Pose>(definition.poses);
  const coverage = String(definition.collision_coverage ?? 'missing');
  const [values, setValues] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ replace: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const stlInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const moving = joints(nodes);
  const frames = useMemo(() => forwardKinematics(nodes, values), [nodes, values]);
  const rest = useMemo(() => forwardKinematics(nodes, {}), [nodes]);
  const order = useMemo(() => [...nodes].sort((a, b) => depthOf(nodes, a.id) - depthOf(nodes, b.id)), [nodes]);
  const nodeColors = useMemo(() => Object.fromEntries(order.map((node, index) => [node.id, PALETTE[index % PALETTE.length]])), [order]);

  /** Apply a change to the bodies (starting the edit if needed). */
  const edit = (change: (current: Definition) => Definition) => {
    const base = readOnly ? onEdit() : definition;
    if (base) onChange(change(base));
  };
  const setBodies = (change: (current: CollisionBody[]) => CollisionBody[]) => edit((current) => {
    const next = change(list<CollisionBody>(current.collision_geometry));
    // Bodies describe some of the machine once there are any; "the whole machine" stays the person's call.
    const covered = String(current.collision_coverage ?? 'missing');
    return { ...current, collision_geometry: next, collision_coverage: next.length && covered === 'missing' ? 'partial' : !next.length ? 'missing' : covered };
  });
  const update = (id: string, patch: Partial<CollisionBody>) => setBodies((current) => current.map((body) => (body.id === id ? { ...body, ...patch } : body)));
  const root = nodes.find((node) => !node.parent)?.id ?? nodes[0]?.id ?? 'base';

  const addCad = (picked: PickedBody) => {
    const replace = picking?.replace;
    setPicking(null);
    if (replace) { update(replace, { representation: 'brep', geometry_source: picked.source, artifact: null, bounds: null }); return; }
    const id = uniqueId(picked.name, bodies);
    setBodies((current) => [...current, { id, node: root, representation: 'brep', geometry_source: picked.source, frame: { origin_mm: [0, 0, 0] }, error_bound_mm: 0 }]);
    setSelected(id);
  };
  const addStl = async (file: File) => {
    setUploading(true);
    try {
      const { artifact, bounds, triangles } = await uploadStl(file);
      const replace = replacing.current;
      replacing.current = null;
      if (replace) update(replace, { representation: 'mesh', artifact, bounds, geometry_source: null });
      else {
        const id = uniqueId(file.name.replace(/\.stl$/i, ''), bodies);
        setBodies((current) => [...current, { id, node: root, representation: 'mesh', artifact, bounds, frame: { origin_mm: [0, 0, 0] }, error_bound_mm: 0.1 }]);
        setSelected(id);
      }
      toast('success', 'STL uploaded', `${file.name}: ${triangles.toLocaleString()} triangles. It’s checked by the first job that uses it.`);
    } catch (error) { report(error, 'Couldn’t use that STL'); }
    finally { setUploading(false); }
  };
  const addBox = () => {
    const id = uniqueId('box', bodies);
    setBodies((current) => [...current, { id, node: root, representation: 'solid_box', bounds: { minimum_mm: [0, 0, 0], maximum_mm: [100, 100, 100] }, frame: { origin_mm: [0, 0, 0] }, error_bound_mm: 0 }]);
    setSelected(id);
  };
  const errorsFor = (index: number) => [...errors].filter(([path]) => path === `collision_geometry.${index}` || path.startsWith(`collision_geometry.${index}.`));

  const editor = (body: CollisionBody, index: number) => {
    const frame = { origin_mm: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], ...(body.frame ?? {}) } as Frame;
    const setFrame = (patch: Partial<Frame>) => update(body.id, { frame: { ...frame, ...patch } });
    const bounds = body.bounds ?? { minimum_mm: [0, 0, 0], maximum_mm: [0, 0, 0] } as Bounds;
    const problems = errorsFor(index);
    return (
      <div className={styles.editor} data-body-editor={body.id}>
        {problems.length > 0 && <ul className={styles.problems} role="alert">{problems.map(([path, message]) => <li key={path}>{message}</li>)}</ul>}
        <div className={styles.row}>
          <span className={styles.label}>Name</span>
          <input className={styles.input} value={body.id} disabled={readOnly} aria-label="Body name" onChange={(event) => { const id = event.target.value.replace(/[^a-zA-Z0-9_-]/g, '_'); update(body.id, { id }); setSelected(id); }} />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Moves with</span>
          <select className={styles.input} value={body.node} disabled={readOnly} aria-label="Moves with" onChange={(event) => update(body.id, { node: event.target.value })}>
            {order.map((node) => <option key={node.id} value={node.id}>{node.id} · {node.kind === 'fixed' ? 'fixed' : `${node.kind} axis`}</option>)}
          </select>
        </div>
        <Vector name="origin" label="Position at rest (mm)" value={frame.origin_mm} readOnly={readOnly} onChange={(origin_mm) => setFrame({ origin_mm })} />
        {(body.representation === 'solid_box' || body.representation === 'enclosing_box') && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>The box is</span>
              <select className={styles.input} value={body.representation} disabled={readOnly} aria-label="Box kind" onChange={(event) => update(body.id, { representation: event.target.value as CollisionBody['representation'] })}>
                <option value="solid_box">Exactly the part’s shape</option>
                <option value="enclosing_box">Around the part (it’s smaller)</option>
              </select>
            </div>
            <Vector name="minimum" label="Lowest corner (mm)" value={bounds.minimum_mm} readOnly={readOnly} onChange={(minimum_mm) => update(body.id, { bounds: { ...bounds, minimum_mm } })} />
            <Vector name="maximum" label="Highest corner (mm)" value={bounds.maximum_mm} readOnly={readOnly} onChange={(maximum_mm) => update(body.id, { bounds: { ...bounds, maximum_mm } })} />
          </>
        )}
        {!readOnly && body.representation === 'brep' && body.geometry_source && <Button size="sm" icon={<Pencil />} onClick={() => setPicking({ replace: body.id })}>Choose another body…</Button>}
        {!readOnly && body.representation === 'mesh' && <Button size="sm" icon={<FileUp />} onClick={() => { replacing.current = body.id; stlInput.current?.click(); }}>Replace the STL…</Button>}
        <details className={styles.more} data-more-details>
          <summary><ChevronRight size={12} />More details <small>orientation, accuracy{body.representation === 'mesh' ? ', bounds' : ''}</small></summary>
          <Vector name="x" label="Its X axis points along" value={frame.x} readOnly={readOnly} onChange={(x) => setFrame({ x })} />
          <Vector name="y" label="Its Y axis points along" value={frame.y} readOnly={readOnly} onChange={(y) => setFrame({ y })} />
          <Vector name="z" label="Its Z axis points along" value={frame.z} readOnly={readOnly} onChange={(z) => setFrame({ z })} />
          <div className={styles.row}>
            <span className={styles.label}>Approximation error (mm)</span>
            <NumberField className={styles.input} unit="" optional eager min={0} step={0.01} value={body.error_bound_mm} disabled={readOnly} ariaLabel="Approximation error"
              onChange={(entered) => update(body.id, { error_bound_mm: entered ?? 0 })} />
          </div>
          <small className={styles.help}>
            {body.representation === 'mesh' ? 'How far the facets may sit inside the real surface (the STL’s chord tolerance). 0 only if the facets are the real shape. Not a clearance.'
              : body.representation === 'brep' ? 'A CAD solid is the exact shape: 0 unless it simplifies the real part. Not a clearance.' : 'How far the box may be from the real part. Not a clearance.'}
          </small>
          {body.representation === 'mesh' && body.bounds && <small className={styles.help}>Bounds from the file: {body.bounds.minimum_mm.map(fmt).join(', ')} → {body.bounds.maximum_mm.map(fmt).join(', ')} mm (the job checks they enclose it).</small>}
        </details>
        {!readOnly && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => { setBodies((current) => current.filter((item) => item.id !== body.id)); setSelected(null); }} data-remove-body>Remove this body</Button>}
      </div>
    );
  };

  return (
    <div className={styles.bodies} id="machine-bodies">
      <div className={styles.head}>
        <label className={styles.coverage}>
          <span>The bodies describe</span>
          <select className={styles.input} value={coverage} aria-label="Collision coverage" onChange={(event) => edit((current) => ({ ...current, collision_coverage: event.target.value }))} data-coverage>
            {COVERAGE.map((item) => <option key={item.value} value={item.value} disabled={item.value !== 'missing' && !bodies.length}>{item.label}</option>)}
          </select>
        </label>
        <small className={styles.help}>{COVERAGE.find((item) => item.value === coverage)?.hint}</small>
      </div>
      <MachineView id="machine-preview" bodies={bodies} frames={frames} rest={rest} attachments={attachments} nodeColors={nodeColors} selected={selected} onSelect={setSelected}
        loading={uploading ? 'Uploading the STL…' : null} />
      {moving.length > 0 && (
        <div className={styles.pose} data-pose>
          <div className={styles.poseHead}>
            <span className={styles.label}>Pose</span>
            <button type="button" className={styles.chip} onClick={() => setValues({})} data-pose-chip="rest"><Home size={11} />Rest</button>
            {poses.map((pose) => (
              <button key={pose.id} type="button" className={styles.chip} data-pose-chip={pose.id}
                onClick={() => setValues(Object.fromEntries(pose.positions.map((position) => [position.joint, position.value])))}>{pose.id}</button>
            ))}
            <small className={styles.help}>A display: jobs check the actual moves.</small>
          </div>
          {moving.map((node) => {
            const value = restValue(node, values[node.id]);
            const rad = node.limits!.unit === 'rad';
            return (
              <label key={node.id} className={styles.joint}>
                <span><i style={{ background: nodeColors[node.id] }} />{node.id}</span>
                <input type="range" min={node.limits!.minimum} max={node.limits!.maximum} step={(node.limits!.maximum - node.limits!.minimum) / 400 || 1} value={value}
                  aria-label={`${node.id} position`} onChange={(event) => setValues({ ...values, [node.id]: Number(event.target.value) })} />
                <b>{rad ? `${fmt((value * 180) / Math.PI)}°` : `${fmt(value)} mm`}</b>
              </label>
            );
          })}
        </div>
      )}
      <div className={styles.list} data-body-list>
        {bodies.length === 0 && (
          <div className={styles.empty} data-bodies-empty>
            <Boxes size={20} />
            <span>No collision bodies yet, so jobs on this machine don’t check it for collisions. Add the parts of the machine a tool, fixture or part could hit: the spindle housing, the column, the table.</span>
          </div>
        )}
        {order.filter((node) => bodies.some((body) => body.node === node.id)).map((node) => (
          <div key={node.id} className={styles.nodeGroup} data-node={node.id}>
            <div className={styles.nodeHead}><i style={{ background: nodeColors[node.id] }} />{node.id}<small>{node.kind === 'fixed' ? 'fixed' : `${node.kind} axis`}</small></div>
            {bodies.map((body, index) => body.node !== node.id ? null : (
              <div key={`${index}:${body.id}`} className={styles.body} data-on={selected === body.id || undefined} data-body={body.id} data-error={errorsFor(index).length > 0 || undefined}>
                <button type="button" className={styles.bodyHead} onClick={() => setSelected(selected === body.id ? null : body.id)} aria-expanded={selected === body.id}>
                  <Box size={13} />
                  <b>{body.id}</b>
                  <span className={styles.badge}>{REPRESENTATION[body.representation]}</span>
                  <Status body={body} saved={saved} />
                </button>
                {selected === body.id && editor(body, index)}
              </div>
            ))}
          </div>
        ))}
        {bodies.some((body) => !nodes.some((node) => node.id === body.node)) && (
          <p className={styles.note} data-tone="danger">Some bodies ride on a node this machine doesn’t have: {bodies.filter((body) => !nodes.some((node) => node.id === body.node)).map((body) => body.id).join(', ')}.</p>
        )}
      </div>
      <div className={styles.add}>
        <Button size="sm" icon={<Box />} onClick={() => setPicking({ replace: null })} id="add-cad-body">From a part…</Button>
        <Button size="sm" icon={<FileUp />} onClick={() => { replacing.current = null; stlInput.current?.click(); }} disabled={uploading} id="add-stl-body">Upload STL…</Button>
        <Button size="sm" onClick={addBox} id="add-box-body">Box</Button>
        <input ref={stlInput} type="file" accept=".stl,model/stl,application/sla" hidden data-stl-input onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void addStl(file); }} />
        <small className={styles.help}>{readOnly ? 'Adding a body starts editing; save to keep it.' : 'Saved with the machine as its next revision.'}</small>
      </div>
      <CadBodyPicker open={!!picking} current={picking?.replace ? bodies.find((body) => body.id === picking.replace)?.geometry_source as BodySource | undefined : null} onPick={addCad} onClose={() => setPicking(null)} />
    </div>
  );
}
