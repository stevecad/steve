/**
 * A design with joints as a physics simulation model (docs/MOTION.md, "Simulation model export"): MJCF for MuJoCo,
 * a plain JSON kinematic inventory for teams with their own model generators, one STL per body, a validation report
 * and a manifest. Built in the browser, like the 3MF export, from the full build's bodies-mesh.zip (each body as
 * modelled, with its material and exact mass properties) and the design's kinematics.
 *
 * - A link is the instances fastened together by rigid joints. The grounded instances make the base link, welded to
 *   the world (add a <freejoint/> to it for a floating base).
 * - A moving link's body frame sits at its joint's origin with the design's axes, so qpos 0 is the design as modelled
 *   and a STEVE joint value equals the simulator's (mm → m, degrees → radians). A cylindrical joint is a hinge and
 *   a slide (`<joint>_travel`) on the same axis.
 * - Mass, centre of mass and inertia per link come from each body's exact volume integrals and its material's
 *   density (parallel-axis theorem). A body without a material is listed, never guessed.
 * - Each body collides as the convex hull of its mesh (MuJoCo's rule for mesh geoms); parent and child never collide.
 *   An instance with `design.collision_shape`s collides as those boxes, spheres and capsules instead; its meshes are
 *   visual only.
 * - `design.collision_filter` sets each instance's collision geoms' contype/conaffinity (group, condim, friction);
 *   `design.contact_pair` and `design.contact_exclude` become <contact> pairs (geom to geom) and exclusions (link to link).
 * - Mass overrides (runtime/steve/physics.py) apply per instance: `fill` scales, `mass` sets a datasheet mass on the
 *   solids' uniform-density shape, `measured_mass` scales a set to a weighed total; `lumped_mass` adds a box or point
 *   mass to a link. `design.site`s become <site>s on their link.
 * - Couplings become joint equality constraints (polycoef); named poses and the code's pose become keyframes.
 * - The report checks forward kinematics against STEVE's own at the zero pose and with each joint moved, mass against
 *   the bodies' sum, and every pose against the joint limits. Same build, same files, byte for byte.
 * - A moving link with (almost) no rotational inertia (only point masses) gets a 1 mm ball's, so MuJoCo loads it.
 *
 * Pure: no app state, so tests run it in Node (tests/simulation_model_test.mjs); simulationExport.ts downloads it.
 */
import * as THREE from 'three';
import type { BodyMesh } from '@/lib/api';
import { gearsOf, initialCoupled, initialPose, instanceMotions, type JointState, type Kinematics, type MotionJoint, type Pose } from './kinematics';

const MM = 1e-3;
const DEG = Math.PI / 180;
/** How far each joint moves for the kinematic parity check (degrees, mm). */
const NUDGE = 5;
/** The smallest rotational inertia a moving link gets: a ball of its mass this big (m), as (2/5)·m·r². */
const FLOOR_RADIUS = 1e-3;

type Vec = [number, number, number];

/** Triangles in a binary STL (as meshExport.ts counts them). */
const triangles = (stl: DataView) => (stl.byteLength >= 84 ? Math.min(stl.getUint32(80, true), Math.floor((stl.byteLength - 84) / 50)) : 0);

/** A number as written: 12 significant digits, never "-0". Lengths snap to 0 below a picometre. */
export const num = (value: number) => { const v = Number(value.toPrecision(12)); return v === 0 ? '0' : String(v); };
const len = (value: number) => num(Math.abs(value) < 1e-12 ? 0 : value);
const vec = (values: readonly number[], format = len) => values.map(format).join(' ');
const written = (values: readonly number[]) => values.map((value) => Number(len(value))) as Vec;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safe = (text: string) => text.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'body';

/** One degree of freedom of a joint, as the simulator names it: a hinge (`turn`, radians) or a slide (`travel`, m). */
interface Dof { joint: MotionJoint; name: string; kind: 'turn' | 'travel'; key: string }

function dofsOf(joint: MotionJoint): Dof[] {
  if (joint.type === 'revolute') return [{ joint, name: joint.name, kind: 'turn', key: joint.name }];
  if (joint.type === 'slider') return [{ joint, name: joint.name, kind: 'travel', key: joint.name }];
  if (joint.type === 'cylindrical') {
    return [{ joint, name: joint.name, kind: 'turn', key: `${joint.name}.turn` }, { joint, name: `${joint.name}_travel`, kind: 'travel', key: `${joint.name}.travel` }];
  }
  return [];
}

/** SI units per design unit. */
const scaleOf = (dof: Pick<Dof, 'kind'>) => (dof.kind === 'turn' ? DEG : MM);
const unitOf = (dof: Pick<Dof, 'kind'>) => (dof.kind === 'turn' ? '°' : ' mm');
const slides = (dof: Dof) => dof.joint.type === 'cylindrical' && dof.kind === 'travel';
const dofValue = (dof: Dof, state: JointState) => (slides(dof) ? state.slide : state.value);
const dofLimits = (dof: Dof) => (slides(dof) ? dof.joint.slide_limits ?? null : dof.joint.limits);

/** Joint and coupling values (as a pose names them) applied from the code's pose, couplings added, nothing clamped. */
function livePose(kinematics: Kinematics, values: Record<string, number>): Pose {
  const own = initialPose(kinematics), coupled = initialCoupled(kinematics);
  for (const [target, value] of Object.entries(values)) {
    if (own[target]) own[target] = { ...own[target], value };
    else coupled[target] = value;
  }
  const out: Pose = {};
  for (const joint of kinematics.joints) {
    let { value, slide } = own[joint.name];
    for (const { coupling, ratio } of gearsOf(kinematics, joint, 'turn')) value += (coupled[coupling.name] ?? coupling.value) * ratio;
    if (joint.type === 'cylindrical') for (const { coupling, ratio } of gearsOf(kinematics, joint, 'travel')) slide += (coupled[coupling.name] ?? coupling.value) * ratio;
    out[joint.name] = { value, slide };
  }
  return out;
}

// ── Mass properties ───────────────────────────────────────────────────────

/** SI (kg, m, kg·m²), in the design frame; the inertia tensor is about the centre of mass. */
interface Mass { mass: number; com: Vec; inertia: number[][] }

function bodyMass(item: BodyMesh, density = item.density_g_cm3): Mass | null {
  const props = item.mass_properties;
  if (!props || !density || !(props.volume_mm3 > 0)) return null;
  // g/cm³ × mm³ → kg is 1e-6; g/cm³ × mm⁵ → kg·m² is 1e-12.
  return { mass: density * props.volume_mm3 * 1e-6, com: props.center_of_mass_mm.map((v) => v * MM) as Vec,
    inertia: props.inertia_mm5.map((row) => row.map((v) => v * density * 1e-12)) };
}

/** Several bodies as one: total mass, centre of mass, and the inertia about it (parallel-axis theorem). */
function combine(parts: Mass[]): Mass | null {
  const mass = parts.reduce((sum, part) => sum + part.mass, 0);
  if (!(mass > 0)) return null;
  const com = [0, 1, 2].map((a) => parts.reduce((sum, part) => sum + part.mass * part.com[a], 0) / mass) as Vec;
  const inertia = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const part of parts) {
    const d = part.com.map((v, a) => v - com[a]);
    const squared = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inertia[r][c] += part.inertia[r][c] + part.mass * ((r === c ? squared : 0) - d[r] * d[c]);
  }
  return { mass, com, inertia };
}

const scaled = (part: Mass, factor: number): Mass => ({ mass: part.mass * factor, com: part.com, inertia: part.inertia.map((row) => row.map((v) => v * factor)) });

/** A uniform box (`box` m along `axes`, unit vectors in the design frame; none is a point) at `com`. */
function boxMass(mass: number, com: Vec, axes: readonly (readonly number[])[], box: readonly number[] | null): Mass {
  const [a, b, c] = box ?? [0, 0, 0];
  const own = [b * b + c * c, a * a + c * c, a * a + b * b].map((v) => (mass * v) / 12);
  const inertia = [0, 1, 2].map((r) => [0, 1, 2].map((col) => axes.reduce((sum, axis, k) => sum + own[k] * axis[r] * axis[col], 0)));
  return { mass, com, inertia };
}

/** The principal moments of a symmetric inertia tensor, largest first (closed-form eigenvalues). */
function principal(I: number[][]): Vec {
  const off = I[0][1] ** 2 + I[0][2] ** 2 + I[1][2] ** 2;
  const trace = (I[0][0] + I[1][1] + I[2][2]) / 3;
  const spread = (I[0][0] - trace) ** 2 + (I[1][1] - trace) ** 2 + (I[2][2] - trace) ** 2 + 2 * off;
  if (off <= 1e-12 * spread || spread === 0) return [I[0][0], I[1][1], I[2][2]].sort((x, y) => y - x) as Vec;
  const p = Math.sqrt(spread / 6);
  const B = I.map((row, r) => row.map((v, c) => (v - (r === c ? trace : 0)) / p));
  const det = B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0]);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  const first = trace + 2 * p * Math.cos(phi), last = trace + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [first, 3 * trace - first - last, last];
}

// ── The model ─────────────────────────────────────────────────────────────

interface Placed { item: BodyMesh; stl: DataView; mesh: string; mass: Mass | null }

interface Link {
  name: string;
  joint: MotionJoint | null;
  parent: Link | null;
  /** The body frame's origin in the design frame (mm): the joint's origin, the design origin for the base. */
  origin: Vec;
  /** Position relative to the parent's body frame (m) and the joint axis, both as written. */
  pos: Vec;
  axis: Vec;
  dofs: Dof[];
  instances: string[];
  bodies: Placed[];
  children: Link[];
  mass: Mass | null;
}

export interface SimulationSource { document_id: string | null; revision: number | null; branch: string | null; build_id: string; unsaved_edits: boolean }

export interface SimulationReport {
  links: number;
  joints: number;
  bodies: number;
  /** Total exported mass and the bodies' own sum (kg): they match unless something was left out. */
  mass_kg: number;
  bodies_mass_kg: number;
  /** Exported forward kinematics against STEVE's, at the zero pose and with each joint moved 5° or 5 mm. */
  kinematic_parity: { poses: number; max_position_error_m: number; max_rotation_error: number };
  /** Bodies without a material (instance/body): left out of their link's mass. */
  missing_material: string[];
  /** Moving links whose mass MuJoCo infers from the mesh at 1000 kg/m³ (none of their bodies has a material). */
  inferred_mass: string[];
  /** Per link: mass, centre of mass (body frame), principal moments (largest first) and the overrides that apply. */
  link_masses: { link: string; mass_kg: number | null; center_of_mass: Vec | null; principal_moments: Vec | null; overrides: string[] }[];
  /** Mass overrides that couldn't apply (left as modelled). */
  mass_override_errors: string[];
  /** Moving links with (almost) no rotational inertia, given a 1 mm ball's so MuJoCo loads them. */
  inertia_floor: string[];
  /** Each site's world pose at the zero pose, as the exported model places it (m; quaternion w x y z). */
  sites: { name: string; link: string; position: Vec; quat: number[] }[];
  /** Explicit contact pairs and exclusions written, and those that couldn't be. */
  contacts: { pairs: number; excludes: number; errors: string[] };
  /** Named poses outside a joint's limits. */
  pose_limits: string[];
  unsupported: string[];
  notes: string[];
}

export interface SimulationInput { name: string; kinematics: Kinematics; bodies: { item: BodyMesh; stl: DataView }[]; source: SimulationSource }

/** One body's mesh in its link's body frame, in metres (binary STL). */
function bodyFrameStl(stl: DataView, origin: Vec, title: string): Uint8Array {
  const count = triangles(stl);
  const out = new Uint8Array(84 + 50 * count);
  out.set(new TextEncoder().encode(`STEVE ${title} (m)`).slice(0, 80));
  const view = new DataView(out.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const at = 84 + 50 * t;
    for (let k = 0; k < 3; k++) view.setFloat32(at + 4 * k, stl.getFloat32(at + 4 * k, true), true); // Normals: the frame isn't turned.
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 3; k++) {
        const where = at + 12 + 12 * v + 4 * k;
        view.setFloat32(where, (stl.getFloat32(where, true) - origin[k]) * MM, true);
      }
    }
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Each link's world frame as the exported model places it at joint positions `q` (SI, by simulator joint name). */
function exportedFrames(order: Link[], q: Map<string, number>): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>();
  for (const link of order) {
    const frame = link.parent ? out.get(link.parent.name)!.clone().multiply(new THREE.Matrix4().makeTranslation(link.pos[0], link.pos[1], link.pos[2])) : new THREE.Matrix4();
    const axis = new THREE.Vector3(...link.axis).normalize();
    for (const dof of link.dofs) {
      const value = q.get(dof.name) ?? 0;
      frame.multiply(dof.kind === 'turn' ? new THREE.Matrix4().makeRotationAxis(axis, value) : new THREE.Matrix4().makeTranslation(axis.x * value, axis.y * value, axis.z * value));
    }
    out.set(link.name, frame);
  }
  return out;
}

/** The files of the export (model.xml, inventory.json, report.json, meshes/*.stl, manifest.json) and its report. */
export async function simulationModel(input: SimulationInput): Promise<{ files: [string, Uint8Array | string][]; report: SimulationReport }> {
  const { kinematics, source } = input;
  const unsupported: string[] = [], notes: string[] = [];
  const byChild = new Map(kinematics.joints.map((joint) => [joint.child, joint]));
  const topOf = (instance: string) => instance.split('/')[0];
  const used = new Set([...kinematics.joints.flatMap((joint) => [joint.parent, joint.child]), ...kinematics.ground, ...input.bodies.map(({ item }) => topOf(item.instance))]);
  const baseName = ['base', 'base_link', 'steve_base'].find((name) => !used.has(name)) ?? 'steve_base';
  /** The link an instance belongs to: up its rigid joints to a moving joint's child, or the base. */
  const linkOf = (instance: string): string => {
    let at = instance;
    for (let depth = 0; depth < 64; depth++) {
      const joint = byChild.get(at);
      if (!joint) return baseName;
      if (joint.type !== 'rigid') return at;
      at = joint.parent;
    }
    return baseName;
  };

  const blank = (name: string, joint: MotionJoint | null): Link => ({
    name, joint, parent: null, origin: joint ? [...joint.origin] as Vec : [0, 0, 0], pos: [0, 0, 0], axis: written(joint?.axis ?? [0, 0, 1]),
    dofs: joint ? dofsOf(joint) : [], instances: [], bodies: [], children: [], mass: null,
  });
  const base = blank(baseName, null);
  const links = new Map<string, Link>([[baseName, base]]);
  for (const joint of kinematics.joints) if (joint.type !== 'rigid') links.set(joint.child, blank(joint.child, joint));
  for (const link of links.values()) {
    if (!link.joint) continue;
    link.parent = links.get(linkOf(link.joint.parent)) ?? base;
    link.parent.children.push(link);
    link.pos = written(link.origin.map((v, a) => (v - link.parent!.origin[a]) * MM));
  }
  const order: Link[] = [];
  const walk = (link: Link) => { order.push(link); link.children.forEach(walk); };
  walk(base);
  for (const instance of [...new Set([...kinematics.ground, ...kinematics.joints.flatMap((joint) => [joint.parent, joint.child])])]) {
    links.get(linkOf(instance))?.instances.push(instance);
  }

  // Bodies: one mesh each, named after the instance and body, in their link.
  const meshNames = new Set<string>();
  const missing: string[] = [];
  for (const { item, stl } of input.bodies) {
    const link = links.get(linkOf(topOf(item.instance))) ?? base;
    let mesh = safe(`${item.instance.replace(/\//g, '__')}__${item.body}`);
    for (let n = 2; meshNames.has(mesh); n++) mesh = safe(`${item.instance.replace(/\//g, '__')}__${item.body}_${n}`);
    meshNames.add(mesh);
    const mass = bodyMass(item);
    if (!mass) missing.push(`${item.instance}/${item.body}`);
    link.bodies.push({ item, stl, mesh, mass });
  }
  if (input.bodies.some(({ item }) => item.instance.includes('/'))) notes.push('Joints inside linked designs are exported fixed, as modelled.');

  // Declared collision shapes (design frame, mm, as modelled) as primitive geoms in their link's body frame.
  const declared = kinematics.collision_shapes ?? [];
  const shaped = new Set(declared.map((shape) => shape.instance));
  const primitives = new Map<string, { name: string; instance: string; attrs: string }[]>();
  const counts = new Map<string, number>();
  for (const shape of declared) {
    const link = links.get(linkOf(shape.instance)) ?? base;
    const n = (counts.get(shape.instance) ?? 0) + 1;
    counts.set(shape.instance, n);
    let name = safe(`${shape.instance}__collision_${n}`);
    while (meshNames.has(name)) name = `${name}_`;
    meshNames.add(name);
    const local = (point: readonly number[]) => written(point.map((v, a) => (v - link.origin[a]) * MM));
    const attrs = shape.type === 'box'
      ? `type="box" size="${vec(shape.size!.map((v) => (v / 2) * MM))}" pos="${vec(local(shape.at!))}" quat="${vec(shape.quat!, num)}"`
      : shape.type === 'sphere'
        ? `type="sphere" size="${num(shape.radius! * MM)}" pos="${vec(local(shape.at!))}"`
        : `type="capsule" size="${num(shape.radius! * MM)}" fromto="${vec([...local(shape.start!), ...local(shape.end!)])}"`;
    primitives.set(link.name, [...(primitives.get(link.name) ?? []), { name, instance: shape.instance, attrs }]);
  }

  // Mass per instance (its bodies combined), then the overrides in turn: fill, datasheet mass, measured mass.
  const sim = kinematics.simulation ?? {};
  const bodiesOf = new Map<string, Placed[]>();
  for (const link of order) for (const body of link.bodies) bodiesOf.set(topOf(body.item.instance), [...(bodiesOf.get(topOf(body.item.instance)) ?? []), body]);
  const instanceMass = new Map<string, Mass | null>([...bodiesOf].map(([instance, bodies]) => [instance, combine(bodies.flatMap((body) => (body.mass ? [body.mass] : [])))] as const));
  const applied = new Map<string, string[]>();
  const apply = (instance: string, text: string) => applied.set(instance, [...(applied.get(instance) ?? []), text]);
  const datasheet = new Set<string>();
  const overrideErrors: string[] = [];
  for (const kind of ['fill', 'mass', 'measured'] as const) {
    for (const entry of (sim.masses ?? []).filter((item) => item.kind === kind)) {
      if (kind === 'measured') {
        const names = entry.instances.filter((name) => bodiesOf.has(name));
        const without = names.filter((name) => !instanceMass.get(name));
        if (!names.length || without.length) {
          overrideErrors.push(`Measured mass of ${entry.instances.join(', ')}: ${without.length ? `${without.join(', ')} ${without.length === 1 ? 'has' : 'have'} no mass to scale (give a material or design.mass)` : 'no solid bodies'}; left as modelled.`);
          continue;
        }
        const factor = (entry.grams! * 1e-3) / names.reduce((sum, name) => sum + instanceMass.get(name)!.mass, 0);
        for (const name of names) { instanceMass.set(name, scaled(instanceMass.get(name)!, factor)); apply(name, `measured_mass ${num(entry.grams!)} g (×${num(Number(factor.toPrecision(4)))})`); }
        continue;
      }
      for (const name of entry.instances) {
        const bodies = bodiesOf.get(name);
        const label = kind === 'fill' ? 'Fill' : 'Mass';
        if (!bodies) { overrideErrors.push(`${label} of ${name}: it has no solid bodies to apply it to.`); continue; }
        if (kind === 'fill') {
          const own = instanceMass.get(name);
          if (!own) { overrideErrors.push(`Fill of ${name}: it has no material to scale; give it one with model.material(…), or use design.mass.`); continue; }
          instanceMass.set(name, scaled(own, entry.fraction!));
          apply(name, `fill ${num(entry.fraction!)}`);
        } else {
          // The solids at uniform density: their geometric centre of mass and inertia, scaled to the datasheet mass.
          const shape = combine(bodies.flatMap((body) => { const unit = bodyMass(body.item, 1); return unit ? [unit] : []; }));
          if (!shape) { overrideErrors.push(`Mass of ${name}: its bodies have no volume.`); continue; }
          const own = scaled(shape, (entry.grams! * 1e-3) / shape.mass);
          instanceMass.set(name, entry.center ? { ...own, com: entry.center.map((v) => v * MM) as Vec } : own);
          datasheet.add(name);
          applied.set(name, [`mass ${num(entry.grams!)} g${entry.center ? ', centre of mass given' : ''}`]);
        }
      }
    }
  }
  const lumped = new Map<string, Mass[]>();
  for (const item of sim.lumped ?? []) {
    const link = links.get(linkOf(item.instance)) ?? base;
    lumped.set(link.name, [...(lumped.get(link.name) ?? []), boxMass(item.grams * 1e-3, item.at.map((v) => v * MM) as Vec, item.axes, item.box?.map((v) => v * MM) ?? null)]);
    apply(item.instance, `lumped_mass ${item.name} ${num(item.grams)} g${item.box ? ` (box ${item.box.map(num).join(' × ')} mm)` : ' (point)'}`);
  }
  const missingMaterial = missing.filter((path) => !datasheet.has(topOf(path)));

  const inferred: string[] = [], floored: string[] = [];
  for (const link of order) {
    const own = [...new Set(link.bodies.map((body) => topOf(body.item.instance)))].flatMap((name) => { const mass = instanceMass.get(name); return mass ? [mass] : []; });
    link.mass = combine([...own, ...(lumped.get(link.name) ?? [])]);
    // MuJoCo refuses a moving body without rotational inertia (a link whose only mass is a point mass): raise its
    // smallest principal moment to a 1 mm ball's (the same on every axis, so A + B ≥ C still holds).
    const floor = link.mass ? 0.4 * link.mass.mass * FLOOR_RADIUS ** 2 : 0;
    const least = link.mass ? Math.min(...principal(link.mass.inertia)) : 0;
    if (link.parent && link.mass && least < floor) {
      link.mass.inertia = link.mass.inertia.map((row, r) => row.map((v, c) => v + (r === c ? floor - least : 0)));
      floored.push(link.name);
    }
    if (link.parent && !link.mass && link.bodies.length) inferred.push(link.name);
    if (link.parent && !link.mass && !link.bodies.length) unsupported.push(`Link ${link.name} has no solid bodies: it gets a tiny placeholder mass so the model compiles.`);
  }

  // Contact filtering: each instance's collision geoms (its declared shapes, else its body meshes) and the last filter
  // that names it; explicit pairs between geoms, exclusions between links.
  const collisionGeoms = new Map<string, string[]>();
  for (const link of order) {
    for (const body of link.bodies) if (!shaped.has(topOf(body.item.instance))) collisionGeoms.set(topOf(body.item.instance), [...(collisionGeoms.get(topOf(body.item.instance)) ?? []), body.mesh]);
    for (const shape of primitives.get(link.name) ?? []) collisionGeoms.set(shape.instance, [...(collisionGeoms.get(shape.instance) ?? []), shape.name]);
  }
  const friction3 = (f: number[]) => [f[0], f[1] ?? 0.005, f[2] ?? 0.0001];
  const contactAttrs = (instance: string) => {
    const filter = [...(sim.filters ?? [])].reverse().find((item) => item.instances.includes(instance));
    if (!filter) return '';
    return ` contype="${filter.contype}" conaffinity="${filter.conaffinity}"${filter.group !== undefined ? ` group="${filter.group}"` : ''}`
      + `${filter.condim ? ` condim="${filter.condim}"` : ''}${filter.friction ? ` friction="${vec(friction3(filter.friction), num)}"` : ''}`;
  };
  const contactErrors: string[] = [];
  const pairs: string[] = [], excludes: string[] = [];
  for (const rule of sim.pairs ?? []) {
    const [a, b] = [collisionGeoms.get(rule.a) ?? [], collisionGeoms.get(rule.b) ?? []];
    if (linkOf(rule.a) === linkOf(rule.b)) { contactErrors.push(`Contact pair ${rule.a}/${rule.b}: both are on link ${linkOf(rule.a)} (fastened together), so they never touch; left out.`); continue; }
    if (!a.length || !b.length) { contactErrors.push(`Contact pair ${rule.a}/${rule.b}: ${!a.length ? rule.a : rule.b} has no collision geoms; left out.`); continue; }
    const f = rule.friction ? friction3(rule.friction) : null;
    const attrs = `${rule.condim ? ` condim="${rule.condim}"` : ''}${f ? ` friction="${vec([f[0], f[0], f[1], f[2], f[2]], num)}"` : ''}`;
    for (const geom1 of a) for (const geom2 of b) pairs.push(`    <pair geom1="${geom1}" geom2="${geom2}"${attrs}/>`);
  }
  for (const rule of sim.excludes ?? []) {
    const [a, b] = [linkOf(rule.a), linkOf(rule.b)];
    if (a === b) { contactErrors.push(`Contact exclude ${rule.a}/${rule.b}: both are on link ${a}, which never collides with itself; left out.`); continue; }
    excludes.push(`    <exclude body1="${escape(a)}" body2="${escape(b)}"/>`);
  }

  // Sites: on their instance's link, in its body frame (the design's axes at the zero pose).
  const sites = (sim.sites ?? []).map((item) => {
    const link = links.get(linkOf(item.instance)) ?? base;
    const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(...item.axes.map((axis) => new THREE.Vector3(...axis)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]));
    return { name: item.name, link: link.name, at: item.at, pos: written(item.at.map((v, a) => (v - link.origin[a]) * MM)), quat: [turn.w, turn.x, turn.y, turn.z] };
  });

  // Couplings: each geared motion follows the coupling's first one, q_b = c0 + c1·q_a (SI). A motion geared by
  // several couplings has no single such line; those couplings are left out. Nor does a polycoef equality stop a
  // motion at its joint's limits, as STEVE holds a joint its couplings push past them (`effectivePose`).
  const dofs = order.flatMap((link) => link.dofs);
  const byKey = new Map(dofs.map((dof) => [dof.key, dof]));
  const gearedBy = new Map<string, number>();
  for (const coupling of kinematics.couplings ?? []) for (const key of Object.keys(coupling.gears)) gearedBy.set(key, (gearedBy.get(key) ?? 0) + 1);
  const equalities: { name: string; joint1: string; joint2: string; c0: number; c1: number }[] = [];
  for (const coupling of kinematics.couplings ?? []) {
    const gears = Object.entries(coupling.gears).filter(([key]) => byKey.has(key));
    const shared = gears.filter(([key]) => (gearedBy.get(key) ?? 0) > 1).map(([key]) => key);
    if (shared.length) { unsupported.push(`Coupling ${coupling.name} is left out: ${shared.join(', ')} ${shared.length === 1 ? 'is' : 'are'} also geared by another coupling `
      + '(their sum, held at the joint\'s limits, isn\'t modelled by polycoef equalities).'); continue; }
    if (gears.length < 2) continue;
    const [[keyA, ratioA], ...rest] = gears;
    const a = byKey.get(keyA)!;
    const ownA = slides(a) ? a.joint.slide ?? 0 : a.joint.value;
    for (const [keyB, ratioB] of rest) {
      const b = byKey.get(keyB)!;
      const ownB = slides(b) ? b.joint.slide ?? 0 : b.joint.value;
      const ratio = ratioB / ratioA;
      equalities.push({ name: `${coupling.name}:${b.name}`, joint1: b.name, joint2: a.name, c0: scaleOf(b) * (ownB - ratio * ownA), c1: (ratio * scaleOf(b)) / scaleOf(a) });
    }
  }

  // Keyframes: the code's pose, then every named pose.
  const keyName = (name: string) => (name in kinematics.poses ? `${name}_code` : name);
  const keyframes: [string, Pose][] = [[keyName('as_written'), livePose(kinematics, {})], ...Object.entries(kinematics.poses).map(([name, values]) => [name, livePose(kinematics, values)] as [string, Pose])];
  const qpos = (pose: Pose) => dofs.map((dof) => dofValue(dof, pose[dof.joint.name] ?? { value: dof.joint.value, slide: dof.joint.slide ?? 0 }) * scaleOf(dof));
  const poseLimits: string[] = [];
  for (const [name, pose] of keyframes) {
    for (const dof of dofs) {
      const limits = dofLimits(dof);
      const value = dofValue(dof, pose[dof.joint.name]);
      if (limits && !(value >= limits[0] - 1e-9 && value <= limits[1] + 1e-9)) {
        poseLimits.push(`Pose ${name}: ${dof.name} at ${num(value)}${unitOf(dof)} is outside its limits ${num(limits[0])}…${num(limits[1])}${unitOf(dof)}.`);
      }
    }
  }

  // Kinematic parity: the exported frames against STEVE's forward kinematics, at zero and each joint nudged.
  const zero: Pose = Object.fromEntries(kinematics.joints.map((joint) => [joint.name, { value: 0, slide: 0 }]));
  const checks: Pose[] = [zero, ...dofs.map((dof) => ({ ...zero, [dof.joint.name]: slides(dof) ? { value: 0, slide: NUDGE } : { value: NUDGE, slide: 0 } }))];
  let positionError = 0, rotationError = 0;
  for (const pose of checks) {
    const motions = instanceMotions(kinematics, pose);
    const frames = exportedFrames(order, new Map(dofs.map((dof) => [dof.name, dofValue(dof, pose[dof.joint.name]) * scaleOf(dof)])));
    for (const link of order) {
      const expected = motions.get(link.name)?.clone() ?? new THREE.Matrix4();
      expected.elements[12] *= MM; expected.elements[13] *= MM; expected.elements[14] *= MM;
      expected.multiply(new THREE.Matrix4().makeTranslation(link.origin[0] * MM, link.origin[1] * MM, link.origin[2] * MM));
      const e = expected.elements, x = frames.get(link.name)!.elements;
      positionError = Math.max(positionError, Math.hypot(e[12] - x[12], e[13] - x[13], e[14] - x[14]));
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) rotationError = Math.max(rotationError, Math.abs(e[c * 4 + r] - x[c * 4 + r]));
    }
  }

  // MJCF
  const comment = (text: string) => text.replace(/-{2,}/g, '-');
  const xml: string[] = [
    `<!-- STEVE simulation model: ${comment(input.name)}. Document ${source.document_id ?? 'unsaved'}, revision ${source.revision ?? '-'}${source.unsaved_edits ? ' with unsaved edits' : ''}. -->`,
    '<!-- Metres, radians, kilograms. Joint values equal STEVE\'s (mm → m, degrees → radians); qpos 0 is the design as modelled. -->',
    `<mujoco model="${escape(input.name)}">`,
    '  <compiler angle="radian" meshdir="meshes" autolimits="true"/>',
    '  <default>',
    '    <geom type="mesh" rgba="0.39 0.72 0.65 1"/>',
    '  </default>',
    '  <asset>',
    ...order.flatMap((link) => link.bodies.map((body) => `    <mesh name="${body.mesh}" file="${body.mesh}.stl"/>`)),
    '  </asset>',
    '  <worldbody>',
  ];
  const bodyXml = (link: Link, depth: number) => {
    const pad = '  '.repeat(depth);
    xml.push(`${pad}<body name="${escape(link.name)}"${link.parent ? ` pos="${vec(link.pos)}"` : ''}>`);
    if (link.mass) {
      const { mass, com, inertia: I } = link.mass;
      xml.push(`${pad}  <inertial pos="${vec(com.map((v, a) => v - link.origin[a] * MM))}" mass="${num(mass)}" fullinertia="${vec([I[0][0], I[1][1], I[2][2], I[0][1], I[0][2], I[1][2]], num)}"/>`);
    } else if (link.parent && !link.bodies.length) {
      xml.push(`${pad}  <inertial pos="0 0 0" mass="1e-6" diaginertia="1e-12 1e-12 1e-12"/>`);
    }
    for (const dof of link.dofs) {
      const limits = dofLimits(dof);
      xml.push(`${pad}  <joint name="${escape(dof.name)}" type="${dof.kind === 'turn' ? 'hinge' : 'slide'}" axis="${vec(link.axis)}"`
        + `${limits ? ` range="${num(limits[0] * scaleOf(dof))} ${num(limits[1] * scaleOf(dof))}"` : ''}/>`);
    }
    for (const body of link.bodies) {
      const instance = topOf(body.item.instance);
      xml.push(`${pad}  <geom name="${body.mesh}" mesh="${body.mesh}"${shaped.has(instance) ? ' contype="0" conaffinity="0"' : contactAttrs(instance)}/>`);
    }
    for (const shape of primitives.get(link.name) ?? []) xml.push(`${pad}  <geom name="${shape.name}" ${shape.attrs}${contactAttrs(shape.instance)} rgba="0.95 0.55 0.2 0.4"/>`);
    for (const site of sites.filter((item) => item.link === link.name)) xml.push(`${pad}  <site name="${escape(site.name)}" pos="${vec(site.pos)}" quat="${vec(site.quat, num)}"/>`);
    for (const child of link.children) bodyXml(child, depth + 1);
    xml.push(`${pad}</body>`);
  };
  bodyXml(base, 2);
  xml.push('  </worldbody>');
  if (pairs.length || excludes.length) xml.push('  <contact>', ...pairs, ...excludes, '  </contact>');
  if (equalities.length) {
    xml.push('  <equality>');
    for (const item of equalities) xml.push(`    <joint name="${escape(item.name)}" joint1="${escape(item.joint1)}" joint2="${escape(item.joint2)}" polycoef="${num(item.c0)} ${num(item.c1)} 0 0 0"/>`);
    xml.push('  </equality>');
  }
  if (dofs.length) {
    xml.push('  <keyframe>');
    for (const [name, pose] of keyframes) xml.push(`    <key name="${escape(name)}" qpos="${vec(qpos(pose), num)}"/>`);
    xml.push('  </keyframe>');
  }
  xml.push('</mujoco>', '');

  // Kinematic inventory: the same tree as plain data (SI, body frames), for model generators of one's own.
  const overridesOf = (link: Link) => [...new Set([...link.instances, ...link.bodies.map((body) => topOf(body.item.instance)), ...(sim.lumped ?? []).map((item) => item.instance)])]
    .filter((name) => linkOf(name) === link.name).flatMap((name) => (applied.get(name) ?? []).map((text) => `${name}: ${text}`));
  const matrix = (m: number[][]) => m.map((row) => row.map((v) => Number(num(v))));
  const inventory = {
    version: 1,
    units: { length: 'm', angle: 'rad', mass: 'kg', inertia: 'kg·m² about the centre of mass, in the body frame' },
    design: input.name,
    source: { document_id: source.document_id, revision: source.revision, branch: source.branch },
    frames: 'Each link\'s body frame sits at its joint origin with the design\'s axes; the base link is the design origin, fixed to the world.',
    links: order.map((link) => ({
      name: link.name,
      parent: link.parent?.name ?? null,
      position: link.pos,
      instances: link.instances,
      joints: link.dofs.map((dof) => ({ name: dof.name, steve_joint: dof.joint.name, type: dof.kind === 'turn' ? 'revolute' : 'prismatic', axis: link.axis,
        limits: dofLimits(dof)?.map((v) => Number(num(v * scaleOf(dof)))) ?? null, ...(dof.joint.driven_by?.length ? { driven_by: dof.joint.driven_by } : {}) })),
      ...(link.joint?.type === 'cylindrical' ? { steve_joint_type: 'cylindrical' } : {}),
      mass: link.mass ? Number(num(link.mass.mass)) : null,
      center_of_mass: link.mass ? written(link.mass.com.map((v, a) => v - link.origin[a] * MM)) : null,
      inertia: link.mass ? matrix(link.mass.inertia) : null,
      ...(overridesOf(link).length ? { mass_overrides: overridesOf(link) } : {}),
    })),
    sites: sites.map((site) => ({ name: site.name, link: site.link, position: site.pos, quat: site.quat.map((v) => Number(num(v))) })),
    lumped_masses: (sim.lumped ?? []).map((item) => ({ name: item.name, link: linkOf(item.instance), instance: item.instance, mass: Number(num(item.grams * 1e-3)),
      position: written(item.at.map((v, a) => (v - (links.get(linkOf(item.instance)) ?? base).origin[a]) * MM)), box: item.box?.map((v) => Number(num(v * MM))) ?? null })),
    contact: { filters: sim.filters ?? [], pairs: pairs.length, excludes: (sim.excludes ?? []).map((rule) => [linkOf(rule.a), linkOf(rule.b)]) },
    bodies: order.flatMap((link) => link.bodies.map(({ item, mesh, mass }) => ({
      instance: item.instance, body: item.body, name: item.name, link: link.name, mesh: `meshes/${mesh}.stl`,
      material: item.material ?? null, density_kg_m3: item.density_g_cm3 ? Number(num(item.density_g_cm3 * 1000)) : null,
      volume_m3: item.mass_properties ? Number(num(item.mass_properties.volume_mm3 * 1e-9)) : null,
      mass: mass ? Number(num(mass.mass)) : null,
      center_of_mass: item.mass_properties ? written(item.mass_properties.center_of_mass_mm.map((v, a) => (v - link.origin[a]) * MM)) : null,
      inertia: mass ? matrix(mass.inertia) : null,
      bounding_box: written(item.extent_mm.map((v, i) => (v - link.origin[i % 3]) * MM)),
    }))),
    couplings: equalities.map((item) => ({ name: item.name, joint: item.joint1, follows: item.joint2, offset: Number(num(item.c0)), ratio: Number(num(item.c1)) })),
    poses: Object.fromEntries(keyframes.map(([name, pose]) => [name, Object.fromEntries(dofs.map((dof, i) => [dof.name, Number(num(qpos(pose)[i]))]))])),
  };

  const exportedMass = order.reduce((sum, link) => sum + (link.mass?.mass ?? 0), 0);
  const bodiesMass = input.bodies.reduce((sum, { item }) => sum + (bodyMass(item)?.mass ?? 0), 0);
  if (missingMaterial.length) notes.push('Bodies without a material are left out of their link\'s mass: give them one with model.material(…) in their component, or a datasheet mass with design.mass(…).');
  if (applied.size) notes.push('Mass overrides apply to the links\' inertials (link_masses); the bodies in inventory.json keep their material masses, and bodies_mass_kg is their sum.');
  notes.push('Each body collides as the convex hull of its mesh; a link never collides with its parent.');
  if (shaped.size) notes.push(`${[...shaped].join(', ')} collide${shaped.size === 1 ? 's' : ''} as declared collision shapes instead; their meshes are visual only.`);
  if (floored.length) notes.push(`${floored.join(', ')} ${floored.length === 1 ? 'has' : 'have'} almost no rotational inertia (only point masses), so ${floored.length === 1 ? 'it gets' : 'they get'} that of a 1 mm ball of the same mass for MuJoCo to load the model: give the lumped mass a box, or the link's solids a material, for a truer one.`);
  if (sim.filters?.length) notes.push('Collision geoms without a design.collision_filter keep MuJoCo\'s default contype 1 and conaffinity 1.');
  // Each site's world pose at the zero pose, through the exported frames.
  const zeroFrames = exportedFrames(order, new Map());
  const report: SimulationReport = {
    links: order.length, joints: dofs.length, bodies: input.bodies.length, mass_kg: Number(num(exportedMass)), bodies_mass_kg: Number(num(bodiesMass)),
    kinematic_parity: { poses: checks.length, max_position_error_m: Number(positionError.toPrecision(3)), max_rotation_error: Number(rotationError.toPrecision(3)) },
    missing_material: missingMaterial, inferred_mass: inferred,
    link_masses: order.map((link) => ({ link: link.name, mass_kg: link.mass ? Number(num(link.mass.mass)) : null,
      center_of_mass: link.mass ? written(link.mass.com.map((v, a) => v - link.origin[a] * MM)) : null,
      principal_moments: link.mass ? principal(link.mass.inertia).map((v) => Number(num(v))) as Vec : null, overrides: overridesOf(link) })),
    mass_override_errors: overrideErrors,
    inertia_floor: floored,
    sites: sites.map((site) => ({ name: site.name, link: site.link, position: written(new THREE.Vector3(...site.pos).applyMatrix4(zeroFrames.get(site.link)!).toArray()),
      quat: site.quat.map((v) => Number(num(v))) })),
    contacts: { pairs: pairs.length, excludes: excludes.length, errors: contactErrors },
    pose_limits: poseLimits, unsupported, notes,
  };

  const files: [string, Uint8Array | string][] = [
    ['model.xml', xml.join('\n')],
    ['inventory.json', `${JSON.stringify(inventory, null, 1)}\n`],
    ['report.json', `${JSON.stringify(report, null, 1)}\n`],
    ...order.flatMap((link) => link.bodies.map((body) => [`meshes/${body.mesh}.stl`, bodyFrameStl(body.stl, link.origin, `${body.item.instance} ${body.item.name}`)] as [string, Uint8Array])),
  ];
  const encoder = new TextEncoder();
  const hashes = await Promise.all(files.map(async ([path, content]) => {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    return { path, bytes: data.length, sha256: await sha256(data) };
  }));
  const manifest = { version: 1, generator: 'STEVE', format: 'mjcf', design: input.name, source,
    options: { units: 'SI', base: 'fixed to the world', collision: shaped.size ? 'declared collision shapes where given, else the convex hull of each body mesh' : 'convex hull of each body mesh',
      mesh_frame: 'link body frame' }, files: hashes };
  files.push(['manifest.json', `${JSON.stringify(manifest, null, 1)}\n`]);
  return { files, report };
}
