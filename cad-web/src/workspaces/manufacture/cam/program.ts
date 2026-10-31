/**
 * Milling program authoring: a form draft ↔ the typed Program the backend saves as a revision
 * (docs/MANUFACTURING_PROGRAMS.md). Only what the native milling engine executes is exposed (`GET /capabilities`;
 * docs/MANUFACTURING_NATIVE_JOBS.md, MANUFACTURING_FACING.md, MANUFACTURING_DRILLING.md, MANUFACTURING_CONTOURS.md,
 * MANUFACTURING_BORING.md, MANUFACTURING_TABS.md, MANUFACTURING_REST.md, MANUFACTURING_SLOTS.md): one box stock, a
 * translated work frame, pinned fixture bodies, parametric centre-cutting flat end mills for pockets (plunge, ramp or
 * helical entry), rest machining, slots, circular bores, facing and contours (with retention tabs), drills for drilling.
 *
 * Frames: the work frame is the design's own frame (program X0 Y0 Z0 is the design origin); `work_to_machine`
 * places it on the machine by translation. Stock bounds and every height are in the work frame. Client checks here
 * are hints; the server's errors are the answer.
 */
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import type { FaceInfo } from '@/viewport/model';
import type { Pick } from '@/state/store';
import type { ModelingResult } from '@/lib/modeling';
import { pinOf, type Pin, type Program, type ProgramRecord } from '../api';
import { instanceOfNode } from '@/workspaces/simulate/state';
import type { ResolvedMachineSnapshot, ResolvedToolSetupSnapshot } from './api';
import { orderChain, type Chain, type ChainProblem } from './contour';
import { patternDraftOf, patternJson, patternProblem, type PatternDraft } from './pattern';
import { roughStrategy } from './rough';
import { fixtureDraftOf, fixtureJsonOf, mergedSetupJson, type FixtureDraft } from './setupJson';

export type Vec3 = [number, number, number];

/** A body in the open design, as programs name it: the instance path ("part" in a part) and the body name. */
export interface BodyRef { instance: string; body: string }
export interface FloorRef extends BodyRef { face: string; z: number; area: number }
export type { FixtureDraft };

/**
 * A rigid frame, as the contract's `Frame`: a point p maps to origin + p.x * x + p.y * y + p.z * z (axes are columns).
 */
export interface Frame { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }
export const IDENTITY_FRAME: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** How the part is turned when it's re-clamped for the next setup (manual setups, docs/MANUFACTURING_SETUPS.md). */
export type TransferPreset = 'flip_x' | 'flip_y' | 'turn_z' | 'same' | 'custom';
/**
 * A setup that continues from an earlier one: the actual stock left by operation `from`, moved by `frame` from the
 * earlier setup's work coordinates into this one's.
 */
export interface TransferDraft { from: string; preset: TransferPreset; frame: Frame }

export interface SetupDraft {
  /** The setup's ID in the program ('setup' for the first). */
  id: string;
  /** null: the first setup's own box stock. Else the stock comes from an earlier setup through this transfer. */
  transfer: TransferDraft | null;
  name: string;
  machine: Pin | null;
  tooling: Pin | null;
  /** null: the engine's bundled LinuxCNC post (LinuxCNC controllers only). */
  post: Pin | null;
  postProperties: Record<string, unknown>;
  workOffset: number;
  /** Where the work origin (the design origin) sits on the machine, in machine millimetres. */
  origin: Vec3;
  /**
   * The saved setup leaves its place on the machine out (a program STEVE or code wrote): the run places it at the
   * middle of the machine's travel, `origin` only shows that, and saving keeps it out. Editing the place makes it the person's.
   */
  placedByRun: boolean;
  stockMode: 'auto' | 'manual';
  margins: { side: number; top: number; bottom: number };
  stockMin: Vec3;
  stockMax: Vec3;
  fixtures: FixtureDraft[];
  fixtureCoverage: 'complete' | 'missing';
  material: string;
  /** The machining-material revision cut here (a cutting preset's material); null: none bound, the label above only. */
  machiningMaterial: Pin | null;
  /** Compare the setup's finished stock with these design bodies (docs/MANUFACTURING_STOCK_INSPECTION.md); null: off. */
  inspection: InspectionDraft | null;
}
/** The expected bodies and the two bands: material may stand `excess` mm proud and be cut `missing` mm under. */
export interface InspectionDraft { bodies: BodyRef[]; excess: number; missing: number }
/** Starting bands for a finished part: a light finishing allowance proud, a few hundredths under. */
export const INSPECTION_DEFAULTS = { excess: 0.1, missing: 0.02 } as const;

export type OpKind = 'rough' | 'pocket' | 'rest' | 'slot' | 'face' | 'contour' | 'drill' | 'peck_drill' | 'bore' | 'engrave' | 'chamfer' | 'parallel' | 'waterline';
export const OP_LABEL: Record<OpKind, string> = { rough: 'Rough', pocket: '2D pocket', rest: 'Rest machining', slot: 'Slot', face: 'Face', contour: '2D contour', drill: 'Drill', peck_drill: 'Peck drill', bore: 'Bore', engrave: 'Engrave', chamfer: 'Chamfer', parallel: 'Parallel', waterline: 'Waterline' };
export const isDrilling = (kind: OpKind) => kind === 'drill' || kind === 'peck_drill';
/** 3D finishing with a ball end mill over the whole retained body (docs/MANUFACTURING_SURFACES.md). */
export const isSurface = (kind: OpKind) => kind === 'parallel' || kind === 'waterline';
/** Operations that select an outline like a contour: the part's top outline, picked faces' boundaries, or an edge chain. */
export const followsOutline = (kind: OpKind) => kind === 'contour' || kind === 'chamfer';
/** Operations that select hole walls (vertical cylinders): drilling and circular boring. */
export const takesHoles = (kind: OpKind) => isDrilling(kind) || kind === 'bore';
/** Operations that cut down to a pocket floor: the pocket, and rest machining after it. */
export const isPocketing = (kind: OpKind) => kind === 'pocket' || kind === 'rest';
/** Operations that pick an upward floor face: pockets, rest machining and slots (their rounded floors). */
export const takesFloor = (kind: OpKind) => isPocketing(kind) || kind === 'slot';
/** An operation's label inside a sentence ("New 2D contour", "a peck drill"). */
/** Operations a pattern can repeat: ordinary features (whole-stock facing and rest machining run as ordered operations). */
export const patternable = (kind: OpKind) => kind !== 'face' && kind !== 'rough' && kind !== 'rest' && !isSurface(kind);
export const opLabelLower = (kind: OpKind) => OP_LABEL[kind].replace(/^(2D )?(.)/, (_, prefix: string | undefined, first: string) => `${prefix ?? ''}${first.toLowerCase()}`);

/** A picked cylindrical hole wall: drilling selects named faces, holes in the order picked. */
export interface HoleRef extends BodyRef { face: string; radius: number; center: [number, number]; zMin: number; zMax: number }

/**
 * What a contour follows: the part's outline (the boundaries of its highest upward faces), picked horizontal faces'
 * boundaries, or a picked chain of connected edges (lines and circular arcs in one horizontal plane).
 */
export type ContourMode = 'body' | 'faces' | 'edges';
export interface ContourFaceRef extends BodyRef { face: string; z: number }
/** A picked contour edge: its name and its polyline in the work frame (XY), in the plane `z`. */
export interface ContourEdgeRef extends BodyRef { edge: string; z: number; points: [number, number][] }

/** A picked sketch curve for engraving: the sketch feature, the curve's entity ID, and how it reads ("Line 3"). */
export interface EngraveCurveRef { sketch: string; entity: string; label: string }
/** An engraving's pinned sources: picked sketch curves and model edges. */
export interface EngraveSources { engraveCurves: EngraveCurveRef[]; engraveEdges: ContourEdgeRef[] }
/** An engraving centreline in work XY (`closed`: a loop, its first point not repeated) and the picks it came from. */
export interface EngravePathDraft { id: string; points: [number, number][]; closed: boolean; from: string[] }
/**
 * A contour retention tab (docs/MANUFACTURING_TABS.md): a rectangular bridge at a point on the followed boundary (work
 * XY), `width` along it and `height` above the bottom (plus the floor allowance). `angle` is the boundary's direction
 * there (radians), only to draw it; the engine finds the boundary segment itself.
 */
export interface TabDraft { id: string; center: [number, number]; width: number; height: number; angle: number | null }
/**
 * A slot centreline guide (docs/MANUFACTURING_SLOTS.md): a polyline in work XY and the finished slot width (not a
 * toolpath offset). Bends include the full disk at each point; it may run past the blank for an open or through slot.
 */
export interface SlotGuideDraft { id: string; points: [number, number][]; width: number }

/** One operation of the program, as the editor edits it (fields a kind doesn't use are kept but not saved). */
export interface OperationDraft {
  id: string;
  name: string;
  kind: OpKind;
  /** Tool setup assignment ID; its assembly is what the strategy pins. */
  assignment: string | null;
  assembly: Pin | null;
  target: BodyRef | null;
  /** Pocket and rest: the floor face (null: the engine finds the one upward floor at the bottom height). Face: the finished face. */
  floor: FloorRef | null;
  /** Drilling and boring: picked hole walls in order (empty: every matching hole in the body). */
  holes: HoleRef[];
  clearance: number;
  top: number;
  bottom: number;
  stepover: number;
  stepdown: number;
  direction: 'climb' | 'conventional';
  /** Pocket: plunge, ramp along the wall or helix. Bore: plunge at the centre or helix. Others plunge. */
  entry: 'plunge' | 'ramp' | 'helix';
  /** Ramp and helix: the descent angle. */
  rampDeg: number;
  /** Helix: the cutter-centre circle's radius (null: the engine fits one; it can't exceed the cutter radius). */
  helixRadius: number | null;
  /** Rough: rings a stepover apart ('offset'), or engagement-controlled clearing ('adaptive'). */
  roughClearing: 'offset' | 'adaptive';
  /** Adaptive rough: the widest radial engagement any cutting move may have (max_radial_engagement_mm). */
  engagement: number;
  /** Bore: the finishing path's approximation and coverage tolerance. */
  boreTolerance: number;
  /** Face, pocket and rest: the path's approximation tolerance and the deviation the target check permits. */
  clearingTolerance: number;
  /** Rest machining: the operation whose actual remaining stock it cleans up (the one right before it). */
  restFrom: string | null;
  /** Contour retention tabs. */
  tabs: TabDraft[];
  /** Slot: what defines the slots (their rounded floors in the part, or explicit centreline guides), and the tolerance. */
  slotMode: 'floors' | 'guides';
  slotGuides: SlotGuideDraft[];
  slotTolerance: number;
  /**
   * Engraving: the picked sketch curves and model edges, the paths built from them plus any saved ones (a saved program
   * keeps the paths, not what they came from), the intent, the engine's tolerance and how closely curves are followed.
   */
  engraveCurves: EngraveCurveRef[];
  engraveEdges: ContourEdgeRef[];
  engraveSaved: EngravePathDraft[];
  engravePaths: EngravePathDraft[];
  engraveIntent: 'add_groove' | 'existing_groove';
  engraveTolerance: number;
  engraveChord: number;
  /**
   * Chamfering (docs/MANUFACTURING_CHAMFER.md) selects edges like a contour (`contourMode`, faces or edges, `boundary`,
   * `side`): a new chamfer `chamferWidth` wide across the top face, or the cut along a bevel already modelled (width 0,
   * its lower edges picked). The tip runs `chamferTipOffset` below the lower edge; `bottom` is that lower edge.
   */
  chamferIntent: 'add_chamfer' | 'existing_chamfer';
  chamferWidth: number;
  chamferTipOffset: number;
  chamferTolerance: number;
  /**
   * 3D finishing (parallel and waterline): rows along X or Y, alternating or one-way, inside an optional rectangular
   * cutter-centre boundary (null: the body's XY bounds); the path tolerance (not a scallop bound) and the normal
   * allowance left on the solid. Waterline uses `stepdown` for its levels and `direction`; parallel uses `stepover`.
   */
  surfaceAxis: 'x' | 'y';
  surfacePassMode: 'zigzag' | 'one_way';
  surfaceBounds: [number, number, number, number] | null;
  surfaceTolerance: number;
  surfaceAllowance: number;
  radialAllowance: number;
  axialAllowance: number;
  rpm: number;
  feed: number;
  plunge: number;
  /** The cutting-preset revision whose limits the posted feeds and speeds are checked against; null: none. */
  preset: Pin | null;
  cell: number;
  /** Facing: the direction of each pass (not the tool axis), and travel past each end of the stock. */
  faceAxis: 'x' | 'y';
  overtravel: number;
  /** Drilling. `retract` null: the clearance plane. */
  peck: number;
  retract: number | null;
  reentry: number;
  depthRef: 'tip' | 'full_diameter';
  breakthrough: number;
  tolerance: number;
  /** Contour (`contour_*` strategy fields). Faces and edges are picked in order; `side` auto is off the material. */
  contourMode: ContourMode;
  contourFaces: ContourFaceRef[];
  contourEdges: ContourEdgeRef[];
  boundary: 'outer' | 'inner' | 'all';
  side: 'auto' | 'left' | 'right';
  roughingWidth: number;
  leadIn: number;
  leadOut: number;
  extensionStart: number;
  extensionEnd: number;
  contourTolerance: number;
  /**
   * Repeat this operation at linear, circular or explicit placements (docs/MANUFACTURING_PATTERNS.md); null: once.
   * Not for facing or rest machining. The engine expands it into instances, each planned on its own pinned target.
   */
  pattern: PatternDraft | null;
}
/** @deprecated The pocket draft is an operation draft of kind `pocket`. */
export type PocketDraft = OperationDraft;

export interface ProgramDraft { name: string; setup: SetupDraft; op: OperationDraft }

export const SETUP_ID = 'setup';
export const MACHINE = 'mill';
export const TOOLING = 'tooling';
export const POST = 'post';
export const MATERIAL = 'material';
export const PRESET = 'preset';
export const toolAlias = (assignment: string) => `tool_${assignment.replace(/[^A-Za-z0-9_]/g, '_')}`.toLowerCase();

// ── Geometry from the displayed model ─────────────────────────────────────────

/** The instance a model node belongs to: "part" in a part, else the instance path ("link/sub"), as studies name it. */
export const instanceOf = instanceOfNode;

const instancesOf = (instance: string) => (instance === 'part' ? [] : instance.split('/'));

/** `surface`: the face is a surface body's (model.fill, boundary_surface): nothing to machine, hold or stock from. */
interface FaceEntry { pick: Pick & { kind: 'face' }; ref: string | null; bodies: string[]; instance: string; type: string; area: number; normal: THREE.Vector3 | null; origin: THREE.Vector3 | null; mesh: THREE.Mesh; surface: boolean }

/** Said when a pick is on a surface body (the runtime's SURFACE_NOTE, and why it matters here). */
export const SURFACE_PICK = "This is a surface body: surface bodies aren't solids; thicken or solidify them first. Only solids are machined, held or used as stock.";

/** The mesh's surface bodies, as its topology lists them (parts and design components alike); once per topology. */
const SURFACES = new WeakMap<object, Set<string>>();
const NO_SURFACES = new Set<string>();
function surfacesOf(meshIndex: number): Set<string> {
  const topology = viewer.model?.topologyFor(meshIndex);
  if (!topology?.surface_bodies?.length) return NO_SURFACES;
  let found = SURFACES.get(topology);
  if (!found) SURFACES.set(topology, (found = new Set(topology.surface_bodies)));
  return found;
}

/** A face's entry. Its `mesh` is looked up when read: a merged huge part (viewport/model.ts) makes single faces on demand. */
function entryOfFace(info: FaceInfo): FaceEntry | null {
  const model = viewer.model;
  if (!model) return null;
  const face = model.topologyFor(info.meshIndex)?.faces[info.faceIndex];
  if (!face) return null;
  const frame = model.frameFor(info.node, info.meshIndex);
  const matrix = frame?.matrixWorld ?? new THREE.Matrix4();
  const normal = face.normal ? new THREE.Vector3(...face.normal).transformDirection(matrix) : null;
  const origin = face.origin ? new THREE.Vector3(...face.origin).applyMatrix4(matrix) : null;
  let instance = 'part';
  try { instance = instanceOf(info.node); } catch { /* no model */ }
  const bodies = face.bodies ?? [];
  const surfaces = surfacesOf(info.meshIndex);
  return {
    pick: { kind: 'face', node: info.node, mesh: info.meshIndex, index: info.faceIndex }, ref: face.ref ?? null, bodies, instance,
    type: face.type, area: face.area, normal, origin, get mesh() { return model.faceMesh(info.node, info.meshIndex, info.faceIndex)!; },
    surface: bodies.length > 0 && bodies.every((body) => surfaces.has(body)),
  };
}

function faceEntries(): FaceEntry[] {
  return (viewer.model?.allFaces() ?? []).map(entryOfFace).filter((entry): entry is FaceEntry => !!entry);
}

/** The face a pick names (one lookup: hover asks this every frame while picking). */
function entryOf(pick: Pick): FaceEntry | null {
  if (pick.kind !== 'face') return null;
  const mesh = viewer.model?.faceMesh(pick.node, pick.mesh, pick.index);
  return mesh ? entryOfFace(mesh.userData.face as FaceInfo) : null;
}

const sameBody = (a: BodyRef, b: BodyRef) => a.instance === b.instance && a.body === b.body;
export const bodyLabel = (ref: BodyRef) => (ref.instance === 'part' ? ref.body : `${ref.instance} · ${ref.body}`);

/** Every named body in the displayed design but surface bodies (a part's or a design component's): they have no solid to machine. */
export function displayedBodies(): BodyRef[] {
  const seen = new Map<string, BodyRef>();
  const reported = (viewer.model?.build.metadata as { modeling?: ModelingResult } | null | undefined)?.modeling?.bodies ?? {};
  // A part's own report too, for a build whose topology predates the mesh's surface_bodies.
  const surface = (face: FaceEntry) => face.surface || (face.instance === 'part' && reported[face.bodies[0]]?.kind === 'surface');
  for (const face of faceEntries()) if (face.bodies.length === 1 && !surface(face)) seen.set(`${face.instance}\0${face.bodies[0]}`, { instance: face.instance, body: face.bodies[0] });
  return [...seen.values()].sort((a, b) => bodyLabel(a).localeCompare(bodyLabel(b)));
}

/** A body's bounds in the design (work) frame, from its displayed faces. */
export function bodyBounds(ref: BodyRef): THREE.Box3 | null {
  const box = new THREE.Box3();
  for (const face of faceEntries()) {
    if (face.bodies.length !== 1 || !sameBody({ instance: face.instance, body: face.bodies[0] }, ref)) continue;
    face.mesh.geometry.computeBoundingBox();
    if (face.mesh.geometry.boundingBox) box.union(face.mesh.geometry.boundingBox.clone().applyMatrix4(face.mesh.matrixWorld));
  }
  return box.isEmpty() ? null : box;
}

/** Upward planar faces of a body, by height: candidate pocket floors (the engine decides). */
export function upwardFloors(ref: BodyRef): FloorRef[] {
  const out: FloorRef[] = [];
  for (const face of faceEntries()) {
    if (face.type !== 'plane' || !face.ref || face.bodies.length !== 1 || !face.normal || !face.origin) continue;
    if (!sameBody({ instance: face.instance, body: face.bodies[0] }, ref) || face.normal.z < 1 - 1e-6) continue;
    out.push({ ...ref, face: face.ref, z: face.origin.z, area: face.area });
  }
  return out.sort((a, b) => a.z - b.z);
}

/** A clicked face → the body it belongs to and, for an upward plane, the floor it names. */
export function faceToRefs(pick: Pick): { body: BodyRef; floor: FloorRef | null; reason?: string } | null {
  const face = entryOf(pick);
  if (!face) return null;
  if (face.bodies.length !== 1 || face.surface) return null;
  const body = { instance: face.instance, body: face.bodies[0] };
  if (!face.ref) return { body, floor: null, reason: 'This face has no persistent name. Rebuild a STEVE modeling design to pick it.' };
  if (face.type !== 'plane' || !face.normal || face.normal.z < 1 - 1e-6 || !face.origin) return { body, floor: null, reason: 'A pocket floor is an upward-facing flat face.' };
  return { body, floor: { ...body, face: face.ref, z: face.origin.z, area: face.area } };
}

/** A vertical cylindrical face as a drilling hole wall (centre, radius, Z extent), or why it can't be one. */
function holeOfEntry(face: FaceEntry): HoleRef | string {
  if (face.bodies.length !== 1) return 'Pick a face of one body.';
  if (face.surface) return SURFACE_PICK;
  if (face.type !== 'cylinder') return 'A hole wall is a cylindrical face.';
  if (!face.ref) return 'This face has no persistent name. Rebuild a STEVE modeling design to pick it.';
  const model = viewer.model;
  const info = face.mesh.userData.face as FaceInfo;
  const topo = model?.topologyFor(info.meshIndex)?.faces[info.faceIndex];
  const frame = model?.frameFor(info.node, info.meshIndex);
  const matrix = frame?.matrixWorld ?? new THREE.Matrix4();
  const axis = topo?.axis ? new THREE.Vector3(...topo.axis).transformDirection(matrix) : null;
  if (!axis || Math.abs(Math.abs(axis.z) - 1) > 1e-6 || !face.origin || !topo?.radius) return 'Drilling runs along the spindle: pick a vertical hole wall.';
  face.mesh.geometry.computeBoundingBox();
  const box = face.mesh.geometry.boundingBox!.clone().applyMatrix4(face.mesh.matrixWorld);
  return { instance: face.instance, body: face.bodies[0], face: face.ref, radius: topo.radius, center: [face.origin.x, face.origin.y], zMin: box.min.z, zMax: box.max.z };
}

/** A clicked face → a drilling hole wall, or why it isn't one. */
export function holeOf(pick: Pick): HoleRef | string {
  const face = entryOf(pick);
  return face ? holeOfEntry(face) : 'Pick a hole wall.';
}

// ── Contours ─────────────────────────────────────────────────────────────

const horizontal = (normal: THREE.Vector3 | null) => !!normal && Math.abs(Math.abs(normal.z) - 1) <= 1e-6;
const UNNAMED = 'This has no persistent name. Rebuild a STEVE modeling design to pick it.';

/** A clicked face → a contour face (a horizontal flat face: its boundaries are followed), or why it can't be one. */
export function contourFaceOf(pick: Pick): ContourFaceRef | string {
  const face = entryOf(pick);
  if (!face) return 'Pick a flat horizontal face, or an edge.';
  if (face.bodies.length !== 1) return 'Pick a face of one body.';
  if (face.surface) return SURFACE_PICK;
  if (face.type !== 'plane' || !horizontal(face.normal) || !face.origin) return 'A contour face is a flat horizontal face: its outline is followed.';
  if (!face.ref) return UNNAMED;
  return { instance: face.instance, body: face.bodies[0], face: face.ref, z: face.origin.z };
}

/** Every edge of the displayed model, as picks with their topology (enumerated per drawn mesh). */
function edgePicks(): { pick: Pick & { kind: 'edge' }; ref: string | null; type: string; faces: number[] }[] {
  const model = viewer.model;
  if (!model) return [];
  const out: { pick: Pick & { kind: 'edge' }; ref: string | null; type: string; faces: number[] }[] = [];
  const seen = new Set<string>();
  for (const set of model.edgeSets) {
    const key = `${set.node}:${set.meshIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    model.topologyFor(set.meshIndex)?.edges.forEach((edge, index) => {
      out.push({ pick: { kind: 'edge', node: set.node, mesh: set.meshIndex, index }, ref: (edge as { ref?: string | null }).ref ?? null, type: edge.type, faces: edge.faces ?? [] });
    });
  }
  return out;
}

/** A clicked edge → a contour edge (a line or circular arc lying in one horizontal plane), or why it can't be one. */
export function contourEdgeOf(pick: Pick, anyCurve = false): ContourEdgeRef | string {
  const model = viewer.model;
  if (pick.kind !== 'edge' || !model) return 'Pick an edge of the part.';
  const topology = model.topologyFor(pick.mesh);
  const edge = topology?.edges[pick.index];
  if (!edge) return 'Pick an edge of the part.';
  if (!anyCurve && edge.type !== 'line' && edge.type !== 'circle') return 'Contours follow straight edges and circular arcs.';
  const points = model.worldEdgePoints(pick);
  if (points.length < 2) return 'Pick an edge of the part.';
  const z = points[0].z;
  if (points.some((point) => Math.abs(point.z - z) > 1e-4)) return `${anyCurve ? 'An engraving' : 'A contour'} edge lies flat: pick one in a horizontal plane.`;
  const bodies = [...new Set((edge.faces ?? []).flatMap((index) => topology!.faces[index]?.bodies ?? []))];
  if (bodies.length !== 1) return 'Pick an edge of one body.';
  if (surfacesOf(pick.mesh).has(bodies[0])) return SURFACE_PICK;
  const ref = (edge as { ref?: string | null }).ref;
  if (!ref) return UNNAMED;
  let instance = 'part';
  try { instance = instanceOf(pick.node); } catch { /* no model */ }
  return { instance, body: bodies[0], edge: ref, z, points: points.map((point) => [point.x, point.y] as [number, number]) };
}

/**
 * A clicked edge → where a contour tab goes: the middle of a straight horizontal edge (work XY), the edge's direction
 * and length, or why it can't take one. The engine needs a tab on one straight stretch of the boundary, away from
 * corners: an edge's middle is that. Vertical walls' top or bottom edges both project onto the outline.
 */
export function tabEdgeOf(pick: Pick): { center: [number, number]; angle: number; length: number } | string {
  const model = viewer.model;
  if (pick.kind !== 'edge' || !model) return 'Click a straight edge of the outline.';
  const edge = model.topologyFor(pick.mesh)?.edges[pick.index];
  if (!edge) return 'Click a straight edge of the outline.';
  if (edge.type !== 'line') return 'Tabs sit on straight edges (not arcs or corners).';
  const points = model.worldEdgePoints(pick);
  if (points.length < 2) return 'Click a straight edge of the outline.';
  const a = points[0], b = points[points.length - 1];
  if (Math.abs(a.z - b.z) > 1e-4) return 'A tab sits on a horizontal edge of the outline.';
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-6) return 'Click a straight edge of the outline.';
  return { center: [(a.x + b.x) / 2, (a.y + b.y) / 2], angle: Math.atan2(b.y - a.y, b.x - a.x), length };
}

/** A tab's direction from the displayed straight edge through its centre (to draw saved tabs), or null. */
export function tabAngleAt(center: [number, number]): number | null {
  let best: { angle: number; distance: number } | null = null;
  for (const item of edgePicks()) {
    if (item.type !== 'line') continue;
    const edge = tabEdgeOf(item.pick);
    if (typeof edge === 'string') continue;
    const distance = Math.hypot(edge.center[0] - center[0], edge.center[1] - center[1]);
    // On the edge's line, within its length.
    const ux = Math.cos(edge.angle), uy = Math.sin(edge.angle);
    const along = (center[0] - edge.center[0]) * ux + (center[1] - edge.center[1]) * uy;
    const across = Math.abs(-(center[0] - edge.center[0]) * uy + (center[1] - edge.center[1]) * ux);
    if (across > 1e-3 || Math.abs(along) > edge.length / 2 + 1e-6) continue;
    if (!best || distance < best.distance) best = { angle: edge.angle, distance };
  }
  return best ? best.angle : null;
}

/** A named contour edge in the displayed model (to restore a saved edge selection's geometry). */
export function contourEdgeByName(ref: BodyRef, name: string): ContourEdgeRef | null {
  for (const item of edgePicks()) {
    if (item.ref !== name) continue;
    const edge = contourEdgeOf(item.pick);
    if (typeof edge !== 'string' && sameBody(edge, ref)) return edge;
  }
  return null;
}

/** A named flat edge (any curve) in the displayed model: a saved engraving source's edge, with its polyline to draw. */
export function engraveEdgeByName(ref: BodyRef, name: string): ContourEdgeRef | null {
  for (const item of edgePicks()) {
    if (item.ref !== name) continue;
    const edge = contourEdgeOf(item.pick, true);
    if (typeof edge !== 'string' && sameBody(edge, ref)) return edge;
  }
  return null;
}

/** A named horizontal face in the displayed model (to restore a saved face selection's height). */
export function contourFaceByName(ref: BodyRef, name: string): ContourFaceRef | null {
  for (const face of faceEntries()) {
    if (face.ref !== name || face.bodies.length !== 1 || !sameBody({ instance: face.instance, body: face.bodies[0] }, ref)) continue;
    const out = contourFaceOf(face.pick);
    if (typeof out !== 'string') return out;
  }
  return null;
}

/** The picked edges as one chain, oriented as the engine orients it (or why they aren't one chain). */
export function contourChain(op: OperationDraft): Chain | ChainProblem | null {
  if (op.contourMode !== 'edges' || !op.contourEdges.length) return null;
  if (op.contourEdges.some((edge) => edge.points.length < 2)) return null;
  return orderChain(op.contourEdges.map((edge) => ({ name: edge.edge, points: edge.points, z: edge.z })));
}

/**
 * The vertical cylindrical walls of a body grouped by axis (coaxial segments are one hole), with their radius: a hint
 * of what drilling would find. Which walls are holes, and whether they fit the drill, is the engine's call.
 */
export function bodyHoles(ref: BodyRef): { center: [number, number]; radius: number; zMin: number; zMax: number; faces: string[] }[] {
  const out: { center: [number, number]; radius: number; zMin: number; zMax: number; faces: string[] }[] = [];
  for (const face of faceEntries()) {
    if (face.bodies.length !== 1 || !sameBody({ instance: face.instance, body: face.bodies[0] }, ref) || face.type !== 'cylinder') continue;
    const hole = holeOfEntry(face);
    if (typeof hole === 'string') continue;
    const same = out.find((item) => Math.hypot(item.center[0] - hole.center[0], item.center[1] - hole.center[1]) < 1e-4 && Math.abs(item.radius - hole.radius) < 1e-6);
    if (same) { same.zMin = Math.min(same.zMin, hole.zMin); same.zMax = Math.max(same.zMax, hole.zMax); same.faces.push(hole.face); }
    else out.push({ center: hole.center, radius: hole.radius, zMin: hole.zMin, zMax: hole.zMax, faces: [hole.face] });
  }
  return out.sort((a, b) => a.center[0] - b.center[0] || a.center[1] - b.center[1]);
}

/** A named hole wall in the displayed model (to restore a saved drilling selection's geometry). */
export function holeByName(ref: BodyRef, name: string): HoleRef | null {
  for (const face of faceEntries()) {
    if (face.ref !== name || face.bodies.length !== 1 || !sameBody({ instance: face.instance, body: face.bodies[0] }, ref)) continue;
    const hole = holeOfEntry(face);
    if (typeof hole !== 'string') return hole;
  }
  return null;
}

/**
 * A named face's outline in the design frame, from its displayed triangles (edges only one triangle uses), as segment
 * endpoint pairs. Drawing only (a pattern's instances show where the seed feature lands).
 */
export function faceOutline(ref: BodyRef, name: string): [number, number, number][] {
  const face = faceEntries().find((item) => item.ref === name && item.bodies.length === 1 && sameBody({ instance: item.instance, body: item.bodies[0] }, ref));
  if (!face) return [];
  const geometry = face.mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return [];
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const v = new THREE.Vector3();
  const point = (i: number): [number, number, number] => {
    v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(face.mesh.matrixWorld);
    return [v.x, v.y, v.z];
  };
  const key = (p: [number, number, number]) => p.map((value) => value.toFixed(4)).join(',');
  const edges = new Map<string, { a: [number, number, number]; b: [number, number, number]; n: number }>();
  for (let t = 0; t + 2 < count; t += 3) {
    const tri = [point(t), point(t + 1), point(t + 2)];
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const [ka, kb] = [key(a), key(b)];
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const edge = edges.get(id);
      if (edge) edge.n += 1;
      else edges.set(id, { a, b, n: 1 });
    }
  }
  return [...edges.values()].filter((edge) => edge.n === 1).flatMap((edge) => [edge.a, edge.b]);
}

/**
 * What a pattern repeats, as drawn: the seed operation's selection in the design frame (face outlines as segment pairs,
 * edge chains and paths as polylines, holes as circles) and a point to label each instance at. Drawing only.
 */
export function patternSeed(op: OperationDraft): { segments: [number, number, number][]; lines: [number, number, number][][]; circles: { center: [number, number]; radius: number; z: number }[]; anchor: [number, number] | null } {
  const segments: [number, number, number][] = [];
  const lines: [number, number, number][][] = [];
  const circles: { center: [number, number]; radius: number; z: number }[] = [];
  if (op.floor && op.kind !== 'face') segments.push(...faceOutline(op.floor, op.floor.face));
  for (const hole of op.holes) circles.push({ center: hole.center, radius: hole.radius, z: hole.zMax });
  if (followsOutline(op.kind) && op.contourMode === 'faces') for (const face of op.contourFaces) segments.push(...faceOutline(face, face.face));
  if (followsOutline(op.kind) && op.contourMode === 'edges') for (const edge of op.contourEdges) lines.push(edge.points.map(([x, y]) => [x, y, edge.z]));
  if (op.kind === 'engrave') for (const path of op.engravePaths) lines.push((path.closed ? [...path.points, path.points[0]] : path.points).map(([x, y]) => [x, y, op.top]));
  if (op.kind === 'slot' && op.slotMode === 'guides') for (const guide of op.slotGuides) lines.push(guide.points.map(([x, y]) => [x, y, op.top]));
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of [...segments, ...lines.flat()]) { xs.push(x); ys.push(y); }
  for (const circle of circles) { xs.push(circle.center[0] - circle.radius, circle.center[0] + circle.radius); ys.push(circle.center[1] - circle.radius, circle.center[1] + circle.radius); }
  const anchor: [number, number] | null = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : null;
  return { segments, lines, circles, anchor };
}

/**
 * Whether a pattern can find each instance's feature: geometric patterns match named seed faces or edges (a whole-body
 * selection can't be matched per instance); engraving paths and slot centrelines move with the pattern on the same body.
 */
export function patternSeedNamed(op: OperationDraft): boolean {
  if (op.kind === 'engrave' || (op.kind === 'slot' && op.slotMode === 'guides')) return true;
  if (takesHoles(op.kind)) return op.holes.length > 0;
  if (followsOutline(op.kind)) return op.contourMode !== 'body';
  return !!op.floor;
}

/** The highest upward planar face of a body: facing's finished height when the person doesn't pick one. */
export function topFace(ref: BodyRef): FloorRef | null {
  const floors = upwardFloors(ref);
  return floors.length ? floors[floors.length - 1] : null;
}

/** The displayed faces (and edges) a reference names, to highlight it. */
export function picksFor(refs: { body?: BodyRef | null; floor?: FloorRef | null; bodies?: BodyRef[]; holes?: HoleRef[]; faces?: ContourFaceRef[]; edges?: ContourEdgeRef[] }): Pick[] {
  const faces = faceEntries().filter((face) => face.bodies.length === 1 && (
    (refs.floor && face.ref === refs.floor.face && sameBody({ instance: face.instance, body: face.bodies[0] }, refs.floor))
    || refs.holes?.some((hole) => face.ref === hole.face && sameBody({ instance: face.instance, body: face.bodies[0] }, hole))
    || refs.faces?.some((item) => face.ref === item.face && sameBody({ instance: face.instance, body: face.bodies[0] }, item))
    || (!refs.floor && refs.body && sameBody({ instance: face.instance, body: face.bodies[0] }, refs.body))
    || refs.bodies?.some((body) => sameBody({ instance: face.instance, body: face.bodies[0] }, body)))).map((face) => face.pick);
  if (!refs.edges?.length) return faces;
  const names = new Set(refs.edges.map((edge) => edge.edge));
  return [...faces, ...edgePicks().filter((item) => item.ref && names.has(item.ref)).map((item) => item.pick)];
}

// ── Machine and tooling ───────────────────────────────────────────────────────

interface Node { id: string; parent: string | null; kind: string; axis?: number[] | null; limits?: { minimum: number; maximum: number; max_velocity_per_minute?: number } | null }

/** Linear axis travel by direction (X, Y, Z), from the machine model's kinematic tree, with installed overrides. */
export function travel(machine: ResolvedMachineSnapshot | null): { min: Vec3; max: Vec3 } | null {
  const model = machine?.model.definition as { nodes?: Node[] } | undefined;
  if (!model?.nodes) return null;
  const overrides = new Map(((machine!.instance.definition.joint_overrides ?? []) as { joint: string; limits: { minimum: number; maximum: number } }[]).map((item) => [item.joint, item.limits]));
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const node = model.nodes.find((item) => item.kind === 'linear' && item.axis && Math.abs(item.axis[axis] - 1) < 1e-9);
    const limits = node ? overrides.get(node.id) ?? node.limits : null;
    if (!limits) return null;
    min[axis] = limits.minimum; max[axis] = limits.maximum;
  }
  return { min, max };
}

/** Home gauge position (the model's home pose), when it names every linear axis. */
export function homeGauge(machine: ResolvedMachineSnapshot | null): Vec3 | null {
  const model = machine?.model.definition as { nodes?: Node[]; poses?: { id: string; positions: { joint: string; value: number }[] }[]; home_pose?: string } | undefined;
  const pose = model?.poses?.find((item) => item.id === model.home_pose);
  if (!model?.nodes || !pose) return null;
  const out: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const node = model.nodes.find((item) => item.kind === 'linear' && item.axis && Math.abs(item.axis[axis] - 1) < 1e-9);
    const value = node && pose.positions.find((item) => item.joint === node.id)?.value;
    if (value === undefined || value === null) return null;
    out[axis] = value;
  }
  return out;
}

/**
 * A part-backed cutter's cutting shape (docs/MANUFACTURING_CUTTING_BOUNDS.md): `bounded` with the nominal shape and how
 * far the actual part may stray from it (inner and outer solids scale it by 1 ∓ `relative_error`), or `unassessed`
 * with why. Only a bounded cutter machines; an unassessed one still collides as its outer profile.
 */
export interface CuttingResolution {
  cutter_type: string; status: 'bounded' | 'unassessed'; code?: string | null; message?: string | null;
  bounds?: { nominal: { shape: 'flat' | 'ball' | 'cone'; radius_mm: number; height_mm: number; tip_radius_mm: number; tip_height_mm: number }; relative_error: number; maximum_deviation_mm: number } | null;
}

/** The cutter of a tool setup assignment (diameter, cutting length, flat/center cutting), for hints and defaults. */
export function cutterOf(tooling: ResolvedToolSetupSnapshot | null, assignment: string | null) {
  const entry = tooling?.assignments.find((item) => item.assignment === assignment);
  const cutter = entry?.tool.components.find((component) => component.kind === 'rotary_cutter')?.definition as
    { name?: string; cutter_type?: string; diameter_mm?: number; cutting_length_mm?: number; center_cutting?: boolean; geometry_source?: unknown; max_rpm?: number | null;
      included_angle_rad?: number | null; tip_diameter_mm?: number | null } | undefined;
  const definition = tooling?.setup.definition.assignments.find((item) => item.id === assignment);
  if (!entry || !cutter || !definition) return null;
  // A cutter modelled from a part: its cutting shape as the tool-geometry job proved it (nominal, within ± deviation).
  const placements = (entry.tool.geometry.placements as { part?: { cutting?: CuttingResolution } }[] | undefined) ?? [];
  const cutting = placements.find((item) => item.part?.cutting)?.part?.cutting ?? null;
  const nominal = cutting?.status === 'bounded' ? cutting.bounds?.nominal ?? null : null;
  const source = cutter.geometry_source as { cutting_length_mm?: number | null } | undefined;
  const coneAngle = nominal?.shape === 'cone' && nominal.tip_height_mm > 0 ? 2 * Math.atan((nominal.radius_mm - nominal.tip_radius_mm) / nominal.tip_height_mm) * 180 / Math.PI : null;
  return {
    name: String(entry.tool.assembly.definition.name ?? cutter.name ?? 'Tool'),
    type: cutter.cutter_type ?? 'unknown', diameter: cutter.diameter_mm ?? (nominal ? nominal.radius_mm * 2 : entry.tool.geometry.cutter_diameter_mm),
    cuttingLength: cutter.cutting_length_mm ?? source?.cutting_length_mm ?? nominal?.height_mm ?? 0,
    centerCutting: !!cutter.center_cutting, partBacked: !!cutter.geometry_source, cutting, maxRpm: entry.tool.geometry.max_rpm ?? cutter.max_rpm ?? null,
    pointAngleDeg: cutter.included_angle_rad ? cutter.included_angle_rad * 180 / Math.PI : coneAngle, tipDiameter: cutter.tip_diameter_mm ?? (nominal?.shape === 'cone' ? nominal.tip_radius_mm * 2 : null),
    gauge: entry.tool.geometry.gauge_length_mm, stickout: entry.tool.geometry.stickout_mm,
    toolNumber: definition.tool_number, lengthRegister: definition.offsets.length_register ?? null,
    lengthOffset: definition.offsets.length_mm ?? null, lengthWear: definition.offsets.length_wear_mm ?? 0, basis: definition.offsets.basis ?? 'gauge_length',
    assembly: definition.assembly,
  };
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const round = (value: number, step = 0.001) => Math.round(value / step) * step;

/** Stock from the target's bounds plus margins (the side margin on X and Y). */
export function autoStock(bounds: THREE.Box3, margins: SetupDraft['margins']): { min: Vec3; max: Vec3 } {
  return {
    min: [round(bounds.min.x - margins.side), round(bounds.min.y - margins.side), round(bounds.min.z - margins.bottom)],
    max: [round(bounds.max.x + margins.side), round(bounds.max.y + margins.side), round(bounds.max.z + margins.top)],
  };
}

/**
 * A starting place on the machine: stock centred in X/Y travel, its top at mid Z travel. Derived from the pinned
 * machine's limits; the person adjusts it to their fixture.
 */
export function suggestedOrigin(machine: ResolvedMachineSnapshot | null, stockMin: Vec3, stockMax: Vec3): Vec3 | null {
  const limits = travel(machine);
  if (!limits) return null;
  const mid = (axis: number) => (limits.min[axis] + limits.max[axis]) / 2;
  return [round(mid(0) - (stockMin[0] + stockMax[0]) / 2, 0.1), round(mid(1) - (stockMin[1] + stockMax[1]) / 2, 0.1), round(mid(2) - stockMax[2], 0.1)];
}

/** Where the run places a setup that leaves its place on the machine out: the middle of the machine's X, Y and Z travel. */
export function middleOfTravel(machine: ResolvedMachineSnapshot | null): Vec3 | null {
  const limits = travel(machine);
  return limits ? [0, 1, 2].map((axis) => round((limits.min[axis] + limits.max[axis]) / 2)) as Vec3 : null;
}

export function newSetup(): SetupDraft {
  return {
    id: SETUP_ID, transfer: null, name: 'Setup 1', machine: null, tooling: null, post: null, postProperties: {}, workOffset: 1, origin: [0, 0, 0], placedByRun: false,
    stockMode: 'auto', margins: { side: 2, top: 1, bottom: 0 }, stockMin: [0, 0, 0], stockMax: [10, 10, 10],
    fixtures: [], fixtureCoverage: 'complete', material: '', machiningMaterial: null, inspection: null,
  };
}

/** Starting values per kind (the person sets them for their material and tool; the server checks them). */
export function newOperation(kind: OpKind = 'pocket', index = 1): OperationDraft {
  const base: OperationDraft = {
    id: `${kind === 'peck_drill' ? 'drill' : kind}_${index}`, name: `${OP_LABEL[kind].replace('2D ', '').replace(/^./, (c) => c.toUpperCase())}${index === 1 ? '' : ` ${index}`}`,
    kind, assignment: null, assembly: null, target: null, floor: null, holes: [],
    clearance: 15, top: 10, bottom: 0, stepover: 2, stepdown: 2, direction: 'climb', entry: 'plunge', rampDeg: 3, helixRadius: null, roughClearing: 'offset', engagement: 1,
    // New operations: 0.01 mm tolerances. A saved strategy without one keeps the format's 0.001 mm (read below).
    boreTolerance: 0.01, clearingTolerance: 0.01, restFrom: null, tabs: [], slotMode: 'floors', slotGuides: [], slotTolerance: 0.01,
    engraveCurves: [], engraveEdges: [], engraveSaved: [], engravePaths: [], engraveIntent: 'add_groove', engraveTolerance: 0.01, engraveChord: 0.01,
    chamferIntent: 'add_chamfer', chamferWidth: 1, chamferTipOffset: 0.5, chamferTolerance: 0.02,
    surfaceAxis: 'x', surfacePassMode: 'zigzag', surfaceBounds: null, surfaceTolerance: 0.02, surfaceAllowance: 0,
    radialAllowance: 0, axialAllowance: 0, rpm: 8000, feed: 600, plunge: 150, preset: null, cell: 1,
    faceAxis: 'x', overtravel: 1, peck: 3, retract: null, reentry: 0.254, depthRef: 'full_diameter', breakthrough: 0, tolerance: 0.01,
    contourMode: 'body', contourFaces: [], contourEdges: [], boundary: 'outer', side: 'auto', roughingWidth: 0,
    leadIn: 0, leadOut: 0, extensionStart: 0, extensionEnd: 0, contourTolerance: 0.01, pattern: null,
  };
  if (kind === 'face') return { ...base, stepdown: 1, stepover: 3, feed: 800, plunge: 200 };
  // Roughing: rings around the part from the stock's edge in, leaving stock on the walls and floor for finishing.
  if (kind === 'rough') return { ...base, stepdown: 2, stepover: 2, radialAllowance: 0.3, axialAllowance: 0.3, rampDeg: 3 };
  // A finishing profile: one radial pass at the wall, short normal leads off the free side.
  if (kind === 'contour') return { ...base, stepdown: 2, stepover: 1, leadIn: 1, leadOut: 1 };
  if (isDrilling(kind)) return { ...base, rpm: 3000, feed: 100 };
  // Bores clear outward in concentric passes; a helix down at the centre is the usual way in.
  if (kind === 'bore') return { ...base, entry: 'helix', stepover: 1, stepdown: 2, plunge: 100 };
  // Rest machining: a smaller cutter cleans what the operation before it left (corners); it enters with a plunge.
  if (kind === 'rest') return { ...base, stepover: 1, stepdown: 2, plunge: 100 };
  // Slots: a ramp along the slot is the usual way in (no helix for slots).
  if (kind === 'slot') return { ...base, entry: 'ramp', stepover: 1, stepdown: 2, plunge: 100 };
  // Engraving: a V-bit follows the centrelines at a shallow constant depth, plunging in at each path.
  if (kind === 'engrave') return { ...base, bottom: base.top - 0.5, stepdown: 0.5, plunge: 100, feed: 400, rpm: 10000 };
  // Chamfers: the V-bit's flank cuts the bevel along the top outline, a pass per stepdown, plunging in at each chain.
  if (kind === 'chamfer') return { ...base, bottom: base.top - 1, stepdown: 1, plunge: 100, feed: 500, rpm: 8000 };
  // 3D finishing: a ball end mill after roughing. Parallel rows a fine stepover apart (depth passes of up to the
  // stepdown on the way down); waterline levels a fine stepdown apart.
  if (kind === 'parallel') return { ...base, stepover: 0.5, stepdown: 2, plunge: 150, feed: 800, rpm: 10000 };
  if (kind === 'waterline') return { ...base, stepdown: 0.5, plunge: 150, feed: 800, rpm: 10000 };
  return base;
}
/** @deprecated Use newOperation('pocket', index). */
export const newPocket = (index = 1) => newOperation('pocket', index);

// ── Setups and frames ───────────────────────────────────────────────────────

const round6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
export const frameVector = (f: Frame, v: number[]): Vec3 => [0, 1, 2].map((i) => round6(f.x[i] * v[0] + f.y[i] * v[1] + f.z[i] * v[2])) as Vec3;
export const framePoint = (f: Frame, p: number[]): Vec3 => frameVector(f, p).map((value, i) => round6(value + f.origin[i])) as Vec3;
/** `a` after `b`: p → a(b(p)). */
export const composeFrames = (a: Frame, b: Frame): Frame => ({ origin: framePoint(a, b.origin), x: frameVector(a, b.x), y: frameVector(a, b.y), z: frameVector(a, b.z) });
const sameVec = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);
export const sameFrame = (a: Frame, b: Frame) => sameVec(a.origin, b.origin) && sameVec(a.x, b.x) && sameVec(a.y, b.y) && sameVec(a.z, b.z);
export const isIdentityFrame = (f: Frame) => sameFrame(f, IDENTITY_FRAME);
/** A box through a frame: the box enclosing its eight transformed corners (exact for quarter turns). */
export function frameBox(f: Frame, min: number[], max: number[]): { min: Vec3; max: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = framePoint(f, [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  }
  return { min: lo, max: hi };
}
/** The frame as a matrix (for placing the displayed part in a setup's work frame). */
export const frameMatrix4 = (f: Frame) => new THREE.Matrix4().set(
  f.x[0], f.y[0], f.z[0], f.origin[0], f.x[1], f.y[1], f.z[1], f.origin[1], f.x[2], f.y[2], f.z[2], f.origin[2], 0, 0, 0, 1);
const frameOf = (value: unknown): Frame => {
  const f = (value ?? {}) as Rec;
  return { origin: vec(f.origin_mm, [0, 0, 0]), x: vec(f.x, [1, 0, 0]), y: vec(f.y, [0, 1, 0]), z: vec(f.z, [0, 0, 1]) };
};
export const frameJson = (f: Frame) => ({ origin_mm: f.origin, x: f.x, y: f.y, z: f.z });

/**
 * The re-clamp transfers, each keeping the turned stock in the box it occupied (so program zero and the stock's place
 * on the table can stay): a half turn about X or Y (the part upside down), a quarter turn about Z, or as it was.
 */
export function transferFrame(preset: TransferPreset, min: number[], max: number[]): Frame {
  const sum = (axis: number) => round6(min[axis] + max[axis]);
  if (preset === 'flip_x') return { origin: [0, sum(1), sum(2)], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };
  if (preset === 'flip_y') return { origin: [sum(0), 0, sum(2)], x: [-1, 0, 0], y: [0, 1, 0], z: [0, 0, -1] };
  if (preset === 'turn_z') return { origin: [sum(1), 0, 0], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] };
  return IDENTITY_FRAME;
}
export function presetOf(frame: Frame, min: number[], max: number[]): TransferPreset {
  return (['flip_x', 'flip_y', 'turn_z', 'same'] as const).find((preset) => sameFrame(transferFrame(preset, min, max), frame)) ?? 'custom';
}
export const TRANSFER_LABEL: Record<TransferPreset, string> = { flip_x: 'Flipped over X', flip_y: 'Flipped over Y', turn_z: 'Turned 90° about Z', same: 'Re-clamped as it was', custom: 'Moved by a custom frame' };

type ProgramShape = { setups: unknown[]; operations: unknown[] };
const setupsOf = (program: ProgramShape) => program.setups as Rec[];
/** The setup an operation belongs to (the first setup for an unknown one). */
export const setupOfOperation = (program: ProgramShape, opId: string | null | undefined): string => {
  const op = (program.operations as Rec[]).find((item) => item.id === opId);
  return String(op?.setup ?? (setupsOf(program)[0]?.id ?? SETUP_ID));
};
/** A setup's operations, in program order. */
export const opsOfSetup = (program: ProgramShape, setupId: string) => (program.operations as Rec[]).filter((op) => String(op.setup ?? SETUP_ID) === setupId);
const transferOfSetup = (setup: Rec | undefined) => {
  const stock = setup?.stock as Rec | undefined;
  return stock?.kind === 'previous_operation' ? { from: String(stock.operation), frame: frameOf(stock.transfer) } : null;
};
/**
 * Where the design sits in a setup's work coordinates: the first setup's model placement (identity unless authored),
 * or, for a setup that continues from another, its transfer after the source setup's placement.
 */
export function placementOf(program: ProgramShape, setupId: string, depth = 0): Frame {
  const setup = setupsOf(program).find((item) => item.id === setupId);
  const transfer = transferOfSetup(setup);
  if (!transfer || depth > 16) return setup?.model_to_work ? frameOf(setup.model_to_work) : IDENTITY_FRAME;
  return composeFrames(transfer.frame, placementOf(program, setupOfOperation(program, transfer.from), depth + 1));
}
/** A setup's stock box in its work coordinates: its own box, or (an enclosure of) the source setup's moved by the transfer. */
export function stockBoxOf(program: ProgramShape, setupId: string, depth = 0): { min: Vec3; max: Vec3 } | null {
  const setup = setupsOf(program).find((item) => item.id === setupId);
  const transfer = transferOfSetup(setup);
  if (!transfer || depth > 16) {
    const bounds = ((setup?.stock as Rec | undefined)?.bounds ?? null) as Rec | null;
    return bounds ? { min: vec(bounds.minimum_mm, [0, 0, 0]), max: vec(bounds.maximum_mm, [0, 0, 0]) } : null;
  }
  const source = stockBoxOf(program, setupOfOperation(program, transfer.from), depth + 1);
  return source ? frameBox(transfer.frame, source.min, source.max) : null;
}
/** The design's placement for a draft's setup (its unsaved transfer included). */
export function draftPlacement(draft: ProgramDraft, program: ProgramShape | undefined): Frame {
  const transfer = draft.setup.transfer;
  if (!transfer) return IDENTITY_FRAME;
  return composeFrames(transfer.frame, program ? placementOf(program, setupOfOperation(program, transfer.from)) : IDENTITY_FRAME);
}
/** A setup ID not yet used: setup_2, setup_3… */
export function newSetupId(program: ProgramShape): string {
  const taken = new Set(setupsOf(program).map((setup) => String(setup.id)));
  let n = taken.size + 1;
  while (taken.has(`setup_${n}`)) n++;
  return `setup_${n}`;
}

// ── Draft ↔ program ─────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const vec = (value: unknown, fallback: Vec3): Vec3 => (Array.isArray(value) && value.length === 3 ? value.map(Number) as Vec3 : fallback);
const vec2 = (value: unknown): [number, number] => (Array.isArray(value) && value.length === 2 ? [Number(value[0]), Number(value[1])] : [0, 0]);
const KINDS: OpKind[] = ['rough', 'pocket', 'rest', 'slot', 'face', 'contour', 'drill', 'peck_drill', 'bore', 'engrave', 'chamfer', 'parallel', 'waterline'];
/** Whether the workspace's tools edit this operation's kind. Others (a kind written as code that no tool has) are
 * edited in code: opening one in a tool would show it, and save it, as a pocket. */
export const editableKind = (op: Rec): boolean => (KINDS as string[]).includes(String((op.strategy as Rec | undefined)?.kind ?? 'pocket'));
export const kindOf = (op: Rec): OpKind => {
  const kind = String((op.strategy as Rec | undefined)?.kind ?? 'pocket');
  return (KINDS as string[]).includes(kind) ? kind as OpKind : 'pocket';
};

/** A saved program's engraving paths (what they were picked from isn't saved). */
const savedPaths = (value: unknown): EngravePathDraft[] => ((value as Rec[] | undefined) ?? []).map((path) => ({
  id: String(path.id), points: ((path.points_mm as unknown[] | undefined) ?? []).map(vec2), closed: path.closed === true, from: [],
}));

/**
 * A saved engraving's pinned sources (docs/MANUFACTURING_LINKED_ENGRAVING.md) back as picks: sketch curves by sketch and
 * entity, model edges by name (with their polyline when the displayed model still has them).
 */
function engraveSourcesDraft(value: unknown): EngraveSources {
  const sources = (value as Rec[] | undefined) ?? [];
  const refs = sources.map((source) => (source.reference ?? {}) as Rec);
  return {
    engraveCurves: refs.filter((ref) => ref.kind === 'sketch_curve').map((ref) => ({ sketch: String(ref.sketch), entity: String(ref.entity), label: String(ref.entity) })),
    engraveEdges: refs.filter((ref) => ref.kind === 'edge').map((ref) => {
      const instance = ((ref.instances as string[] | undefined) ?? []).join('/') || 'part';
      const body = { instance, body: String(ref.body) };
      const edge = String((ref.names as string[] | undefined)?.[0] ?? '').replace(`${instance}:`, '');
      return engraveEdgeByName(body, edge) ?? { ...body, edge, z: 0, points: [] };
    }),
  };
}

/**
 * The pinned sources an engraving sends: one per picked sketch curve or model edge, in pick order, each its own path
 * (the planner retracts between them). Their IDs name the paths in the results. A curve in a plane other than the top
 * (an XY sketch marking a raised face) is projected straight up or down onto it.
 */
export function engraveSourcesOf(op: EngraveSources): Rec[] {
  const taken = new Set<string>();
  const unique = (base: string) => {
    const id = (base.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[^a-zA-Z]+/, '') || 'curve').slice(0, 56);
    let out = id, n = 2;
    while (taken.has(out)) out = `${id}_${n++}`;
    taken.add(out);
    return out;
  };
  return [
    ...op.engraveCurves.map((ref) => ({ id: unique(`${ref.sketch}_${ref.entity}`), reference: { kind: 'sketch_curve', link: 'part', sketch: ref.sketch, entity: ref.entity }, projection: 'parallel_to_top' })),
    ...op.engraveEdges.map((edge, index) => ({
      id: unique(`edge_${index + 1}`), projection: 'parallel_to_top',
      reference: { kind: 'edge', link: 'part', instances: instancesOf(edge.instance), body: edge.body, names: [`${edge.instance}:${edge.edge}`] },
    })),
  ];
}

/** The draft for a saved program: its first milling setup and the operation `operationId` (else its first operation). */
export function draftOf(record: ProgramRecord, operationId?: string, setupOnly?: string): ProgramDraft {
  const program = record.compiled;
  const pins = new Map(program.libraries.map((item) => [item.alias, item.pin]));
  const ops = program.operations as Rec[];
  // `setupOnly`: that setup (a setup is its own record, it may have no operations yet); else the operation's setup.
  const op = ops.find((item) => item.id === operationId) ?? (setupOnly ? opsOfSetup(program, setupOnly)[0] : ops[0]) ?? {};
  const setupId = setupOnly ?? setupOfOperation(program, String(op.id ?? ''));
  const setup = ((program.setups as Rec[]).find((item) => item.id === setupId) ?? program.setups[0] ?? {}) as Rec;
  const transfer = transferOfSetup(setup);
  const box = transfer ? stockBoxOf(program, setupId) : null;
  const source = transfer ? stockBoxOf(program, setupOfOperation(program, transfer.from)) : null;
  const strategy = (op.strategy ?? {}) as Rec;
  const stock = ((setup.stock as Rec | undefined)?.bounds ?? {}) as Rec;
  const frame = (setup.work_to_machine ?? {}) as Rec;
  const target = ((op.targets as Rec[] | undefined) ?? [])[0];
  const instanceName = (ref: Rec) => ((ref.instances as string[] | undefined) ?? []).join('/') || 'part';
  const toolPin = pins.get(String(strategy.tool ?? '')) ?? null;
  const post = setup.post as Rec | null | undefined;
  const kind = kindOf(op);
  const base = newOperation(kind);
  const body = target ? { instance: instanceName(target), body: String(target.body) } : null;
  const names = target && (target.kind === 'face' || target.kind === 'edge') ? (target.names as string[]).map((name) => name.replace(`${instanceName(target)}:`, '')) : [];
  const contour = followsOutline(kind);
  const contourMode: ContourMode = !contour || !target || target.kind === 'body' ? 'body' : target.kind === 'edge' ? 'edges' : 'faces';
  const number = (value: unknown, fallback: number) => (value === undefined || value === null ? fallback : Number(value));
  return {
    name: program.name,
    setup: {
      ...newSetup(),
      id: String(setup.id ?? SETUP_ID),
      transfer: transfer ? { ...transfer, preset: source ? presetOf(transfer.frame, source.min, source.max) : 'custom' } : null,
      name: String(setup.name ?? 'Setup 1'),
      machine: pins.get(String(setup.machine ?? '')) ?? null,
      tooling: setup.tooling ? pins.get(String(setup.tooling)) ?? null : null,
      post: post ? pins.get(String(post.library)) ?? null : null,
      postProperties: (post?.properties as Rec | undefined) ?? {},
      workOffset: Number(setup.work_offset ?? 1),
      origin: vec(frame.origin_mm, [0, 0, 0]),
      // A setup in the program without one: the run places it (not at the machine's zero, inside the spindle).
      placedByRun: !!setup.id && setup.work_to_machine === undefined,
      stockMode: 'manual',
      stockMin: box?.min ?? vec(stock.minimum_mm, [0, 0, 0]),
      stockMax: box?.max ?? vec(stock.maximum_mm, [10, 10, 10]),
      // As saved, whatever their shape (a name the code defines, another design's body placed by a frame).
      fixtures: ((setup.fixtures as unknown[] | undefined) ?? []).map(fixtureDraftOf),
      fixtureCoverage: setup.fixture_coverage === 'missing' ? 'missing' : 'complete',
      material: String(setup.material ?? ''),
      machiningMaterial: setup.machining_material ? pins.get(String(setup.machining_material)) ?? null : null,
      inspection: (() => {
        const inspection = setup.stock_inspection as Rec | undefined;
        if (!inspection) return null;
        return {
          bodies: ((inspection.expected as Rec[] | undefined) ?? []).map((ref) => ({ instance: instanceName(ref), body: String(ref.body) })),
          excess: Number(inspection.excess_tolerance_mm ?? INSPECTION_DEFAULTS.excess), missing: Number(inspection.missing_tolerance_mm ?? INSPECTION_DEFAULTS.missing),
        };
      })(),
    },
    op: {
      ...base,
      id: String(op.id ?? base.id), name: String(op.name ?? base.name), kind,
      assignment: null, assembly: toolPin,
      target: body,
      floor: body && names.length && !takesHoles(kind) && !contour && !isSurface(kind) && kind !== 'rough' ? { ...body, face: names[0], z: Number((kind === 'engrave' ? strategy.top_mm : strategy.bottom_mm) ?? 0), area: 0 } : null,
      // Saved hole names come back with their geometry when the displayed model has them.
      holes: body && takesHoles(kind) ? names.map((name) => holeByName(body, name) ?? { ...body, face: name, radius: 0, center: [0, 0], zMin: 0, zMax: 0 }) : [],
      clearance: number(strategy.clearance_mm, base.clearance), top: number(strategy.top_mm, base.top), bottom: number(strategy.bottom_mm, base.bottom),
      stepover: number(strategy.stepover_mm, base.stepover), stepdown: number(strategy.stepdown_mm, base.stepdown),
      direction: strategy.direction === 'conventional' ? 'conventional' : 'climb',
      entry: strategy.entry === 'ramp' || strategy.entry === 'helix' ? strategy.entry : 'plunge',
      rampDeg: strategy.ramp_angle_rad ? Number(strategy.ramp_angle_rad) * 180 / Math.PI : base.rampDeg,
      helixRadius: strategy.helix_radius_mm === undefined || strategy.helix_radius_mm === null ? null : Number(strategy.helix_radius_mm),
      roughClearing: strategy.clearing === 'adaptive' ? 'adaptive' : 'offset',
      engagement: number(strategy.max_radial_engagement_mm, base.engagement),
      boreTolerance: number(strategy.bore_tolerance_mm, 0.001), clearingTolerance: number(strategy.clearing_tolerance_mm, 0.001),
      restFrom: strategy.rest_from ? String(strategy.rest_from) : null,
      tabs: ((strategy.contour_tabs as Rec[] | undefined) ?? []).map((tab) => ({
        id: String(tab.id), center: vec2(tab.center_mm), width: Number(tab.width_mm), height: Number(tab.height_mm), angle: null,
      })),
      slotMode: ((strategy.slot_guides as unknown[] | undefined) ?? []).length ? 'guides' : 'floors',
      slotGuides: ((strategy.slot_guides as Rec[] | undefined) ?? []).map((guide) => ({
        id: String(guide.id), points: ((guide.points_mm as unknown[] | undefined) ?? []).map(vec2), width: Number(guide.width_mm),
      })),
      slotTolerance: number(strategy.slot_tolerance_mm, 0.001),
      engraveSaved: savedPaths(strategy.engrave_paths), engravePaths: savedPaths(strategy.engrave_paths),
      ...engraveSourcesDraft(strategy.engrave_sources),
      engraveIntent: strategy.engrave_intent === 'existing_groove' ? 'existing_groove' : 'add_groove',
      engraveTolerance: number(strategy.engrave_tolerance_mm, 0.001),
      chamferIntent: strategy.chamfer_intent === 'existing_chamfer' ? 'existing_chamfer' : 'add_chamfer',
      chamferWidth: number(strategy.chamfer_width_mm, base.chamferWidth),
      chamferTipOffset: number(strategy.chamfer_tip_offset_mm, kind === 'chamfer' ? 0 : base.chamferTipOffset),
      chamferTolerance: number(strategy.chamfer_tolerance_mm, kind === 'chamfer' ? 0.001 : base.chamferTolerance),
      surfaceAxis: strategy.surface_axis === 'y' ? 'y' : 'x', surfacePassMode: strategy.surface_pass_mode === 'one_way' ? 'one_way' : 'zigzag',
      surfaceBounds: Array.isArray(strategy.surface_bounds_mm) && strategy.surface_bounds_mm.length === 4 ? strategy.surface_bounds_mm.map(Number) as [number, number, number, number] : null,
      surfaceTolerance: number(strategy.surface_tolerance_mm, 0.02), surfaceAllowance: number(strategy.surface_allowance_mm, 0),
      radialAllowance: number(strategy.radial_allowance_mm, 0), axialAllowance: number(strategy.axial_allowance_mm, 0),
      rpm: number(strategy.spindle_rpm, base.rpm), feed: number(strategy.feed_mm_min, base.feed), plunge: number(strategy.plunge_mm_min, base.plunge),
      preset: strategy.cutting_preset ? pins.get(String(strategy.cutting_preset)) ?? null : null,
      cell: number(strategy.verification_cell_mm, 1),
      faceAxis: strategy.face_axis === 'y' ? 'y' : 'x', overtravel: number(strategy.face_overtravel_mm, 0),
      peck: number(strategy.peck_mm, base.peck), retract: strategy.drill_retract_mm === undefined || strategy.drill_retract_mm === null ? null : Number(strategy.drill_retract_mm),
      reentry: number(strategy.drill_reentry_mm, 0.254), depthRef: strategy.drill_depth_reference === 'full_diameter' ? 'full_diameter' : kind === 'drill' || kind === 'peck_drill' ? 'tip' : base.depthRef,
      breakthrough: number(strategy.drill_breakthrough_mm, 0), tolerance: number(strategy.drill_tolerance_mm, 0.001),
      // Saved contour faces and edges come back with their geometry when the displayed model has them.
      contourMode,
      contourFaces: body && contourMode === 'faces' ? names.map((name) => contourFaceByName(body, name) ?? { ...body, face: name, z: Number(strategy.bottom_mm ?? 0) }) : [],
      contourEdges: body && contourMode === 'edges' ? names.map((name) => contourEdgeByName(body, name) ?? { ...body, edge: name, z: Number(strategy.bottom_mm ?? 0), points: [] }) : [],
      boundary: ((value) => (value === 'inner' || value === 'all' ? value : 'outer'))(strategy.contour_boundary ?? strategy.chamfer_boundary),
      side: ((value) => (value === 'left' || value === 'right' ? value : 'auto'))(strategy.contour_side ?? strategy.chamfer_side),
      roughingWidth: number(strategy.contour_roughing_width_mm, 0),
      leadIn: number(strategy.contour_lead_in_mm, 0), leadOut: number(strategy.contour_lead_out_mm, 0),
      extensionStart: number(strategy.contour_extension_start_mm, 0), extensionEnd: number(strategy.contour_extension_end_mm, 0),
      contourTolerance: number(strategy.contour_tolerance_mm, 0.001),
      pattern: patternable(kind) ? patternDraftOf(op.pattern) : null,
    },
  };
}

/**
 * The height operations after a facing can start at (work Z): the lowest finished height a facing before `opId` in
 * the program cuts to (its bottom plus any floor allowance), or null without one. The engine checks it against the
 * stock the facing actually leaves (docs/MANUFACTURING_STOCK_TOP.md) and rejects a top with material above it.
 */
export function facedTop(program: Program | undefined, opId: string, setupId?: string): number | null {
  const setup = setupId ?? (program ? setupOfOperation(program, opId) : SETUP_ID);
  const ops = program ? opsOfSetup(program, setup) : [];
  const index = ops.findIndex((item) => item.id === opId);
  const before = index < 0 ? ops : ops.slice(0, index);
  const heights = before.filter((item) => kindOf(item) === 'face').map((item) => {
    const strategy = (item.strategy ?? {}) as Rec;
    return Number(strategy.bottom_mm ?? 0) + Number(strategy.axial_allowance_mm ?? 0);
  });
  return heights.length ? Math.min(...heights) : null;
}

/** The operation right before `opId` (or the last one, for a new operation): rest machining's stock source. */
export function previousOperation(program: Program | undefined, opId: string, setupId?: string): { id: string; name: string; kind: OpKind } | null {
  const ops = program ? opsOfSetup(program, setupId ?? setupOfOperation(program, opId)) : [];
  const index = ops.findIndex((item) => item.id === opId);
  const before = index < 0 ? ops.at(-1) : index > 0 ? ops[index - 1] : undefined;
  return before ? { id: String(before.id), name: String(before.name ?? before.id), kind: kindOf(before) } : null;
}

export interface DesignPin { document_id: string; branch: string; revision: number }

/** The engine's strategy for an operation draft: only the fields its kind uses (defaults left out, as the server canonicalises). */
export function strategyOf(op: OperationDraft, alias: string): Rec {
  const common: Rec = {
    process: 'milling', kind: op.kind, tool: alias, spindle_rpm: op.rpm, feed_mm_min: op.feed,
    top_mm: op.top, bottom_mm: op.bottom, clearance_mm: op.clearance, verification_cell_mm: op.cell,
  };
  if (op.kind === 'engrave') {
    // Trace engraving follows explicit centrelines at constant depth: plunge entry, no stepover or stock allowances.
    const out: Rec = {
      ...common, plunge_mm_min: op.plunge, stepdown_mm: op.stepdown, entry: 'plunge',
      // Paths follow the design's curves (pinned with its revision); a program saved with fixed coordinates keeps them
      // until they're converted (one operation can't mix the two).
      ...(op.engraveSaved.length
        ? { engrave_paths: op.engravePaths.map((path) => ({ id: path.id, points_mm: path.points, ...(path.closed ? { closed: true } : {}) })) }
        : { engrave_sources: engraveSourcesOf(op) }),
    };
    if (op.engraveIntent !== 'add_groove') out.engrave_intent = op.engraveIntent;
    if (op.engraveTolerance !== 0.001) out.engrave_tolerance_mm = op.engraveTolerance;
    return out;
  }
  if (isSurface(op.kind)) {
    // Ball-end finishing over the whole body: plunge entry, a normal allowance on the solid (radial and axial stay zero),
    // depth passes or levels of up to the stepdown. Parallel takes the row spacing and scan settings and keeps the
    // default (climb) direction; waterline takes its loop direction. Defaults are left out, as the server canonicalises.
    const out: Rec = { ...common, plunge_mm_min: op.plunge, stepdown_mm: op.stepdown, entry: 'plunge' };
    if (op.kind === 'parallel') {
      out.stepover_mm = op.stepover;
      if (op.surfaceAxis !== 'x') out.surface_axis = op.surfaceAxis;
      if (op.surfacePassMode !== 'zigzag') out.surface_pass_mode = op.surfacePassMode;
      if (op.surfaceBounds) out.surface_bounds_mm = op.surfaceBounds;
    } else {
      out.direction = op.direction;
    }
    if (op.surfaceTolerance !== 0.02) out.surface_tolerance_mm = op.surfaceTolerance;
    if (op.surfaceAllowance) out.surface_allowance_mm = op.surfaceAllowance;
    return out;
  }
  if (op.kind === 'chamfer') {
    // A conical cutter's flank cuts the bevel: plunge entry, no stepover or stock allowances; width and tip offset set
    // the cut. Defaults are left out, as the server canonicalises; the width is always explicit (zero for a modelled bevel).
    const out: Rec = {
      ...common, plunge_mm_min: op.plunge, stepdown_mm: op.stepdown, entry: 'plunge', direction: op.direction,
      chamfer_width_mm: op.chamferIntent === 'existing_chamfer' ? 0 : op.chamferWidth,
    };
    if (op.chamferIntent !== 'add_chamfer') out.chamfer_intent = op.chamferIntent;
    if (op.chamferTipOffset) out.chamfer_tip_offset_mm = op.chamferTipOffset;
    if (op.boundary !== 'outer' && op.contourMode !== 'edges') out.chamfer_boundary = op.boundary;
    if (op.side !== 'auto' && op.contourMode === 'edges') out.chamfer_side = op.side;
    if (op.chamferTolerance !== 0.001) out.chamfer_tolerance_mm = op.chamferTolerance;
    return out;
  }
  if (isDrilling(op.kind)) {
    // Drilling needs no plunge feed, stepover or stepdown; the axial feed is `feed_mm_min`.
    const out: Rec = { ...common, drill_depth_reference: op.depthRef };
    if (op.kind === 'peck_drill') out.peck_mm = op.peck;
    if (op.retract !== null) out.drill_retract_mm = op.retract;
    if (op.reentry !== 0.254) out.drill_reentry_mm = op.reentry;
    if (op.breakthrough) out.drill_breakthrough_mm = op.breakthrough;
    if (op.axialAllowance) out.axial_allowance_mm = op.axialAllowance;
    if (op.radialAllowance) out.radial_allowance_mm = op.radialAllowance;
    if (op.tolerance !== 0.001) out.drill_tolerance_mm = op.tolerance;
    return out;
  }
  const milling: Rec = {
    ...common, plunge_mm_min: op.plunge, stepdown_mm: op.stepdown, stepover_mm: op.stepover,
    direction: op.direction, radial_allowance_mm: op.radialAllowance, axial_allowance_mm: op.axialAllowance,
  };
  if (op.kind === 'rough') return roughStrategy(op, common);
  if (op.kind === 'face') {
    // Facing cuts the whole stock: radial allowance is zero and entry is the outside-stock plunge.
    milling.radial_allowance_mm = 0;
    milling.entry = 'plunge';
    if (op.faceAxis !== 'x') milling.face_axis = op.faceAxis;
    if (op.overtravel) milling.face_overtravel_mm = op.overtravel;
    if (op.clearingTolerance !== 0.001) milling.clearing_tolerance_mm = op.clearingTolerance;
    return milling;
  }
  if (op.kind === 'rest') {
    // Rest machining shortens a smaller cutter's pocket paths to the actual stock the operation before it left; it
    // enters with a centre-cutting plunge (ramp and helix are rejected, not converted).
    milling.entry = 'plunge';
    milling.rest_from = op.restFrom;
    if (op.clearingTolerance !== 0.001) milling.clearing_tolerance_mm = op.clearingTolerance;
    return milling;
  }
  if (op.kind === 'slot') {
    // Constant-width slots: their rounded floors in the part, or explicit centreline guides. Plunge or ramp entry.
    milling.entry = op.entry === 'ramp' ? 'ramp' : 'plunge';
    if (milling.entry === 'ramp') milling.ramp_angle_rad = op.rampDeg * Math.PI / 180;
    if (op.slotMode === 'guides' && op.slotGuides.length) {
      milling.slot_guides = op.slotGuides.map((guide) => ({ id: guide.id, points_mm: guide.points, width_mm: guide.width }));
    }
    if (op.slotTolerance !== 0.001) milling.slot_tolerance_mm = op.slotTolerance;
    return milling;
  }
  if (op.kind === 'bore') {
    // Concentric passes outward at each depth, entering at the centre by plunge or helix.
    milling.entry = op.entry === 'helix' ? 'helix' : 'plunge';
    if (milling.entry === 'helix') {
      milling.ramp_angle_rad = op.rampDeg * Math.PI / 180;
      if (op.helixRadius !== null) milling.helix_radius_mm = op.helixRadius;
    }
    if (op.boreTolerance !== 0.001) milling.bore_tolerance_mm = op.boreTolerance;
    return milling;
  }
  if (op.kind === 'contour') {
    // Contours enter with a controlled plunge (the only entry the engine runs for them); the centreline is already
    // offset, so the post keeps controller cutter compensation off. Defaults are left out, as the server canonicalises.
    milling.entry = 'plunge';
    if (op.tabs.length) milling.contour_tabs = op.tabs.map((tab) => ({ id: tab.id, center_mm: tab.center, width_mm: tab.width, height_mm: tab.height }));
    if (op.boundary !== 'outer' && op.contourMode !== 'edges') milling.contour_boundary = op.boundary;
    if (op.side !== 'auto') milling.contour_side = op.side;
    if (op.roughingWidth) milling.contour_roughing_width_mm = op.roughingWidth;
    if (op.leadIn) milling.contour_lead_in_mm = op.leadIn;
    if (op.leadOut) milling.contour_lead_out_mm = op.leadOut;
    if (op.contourMode === 'edges' && op.extensionStart) milling.contour_extension_start_mm = op.extensionStart;
    if (op.contourMode === 'edges' && op.extensionEnd) milling.contour_extension_end_mm = op.extensionEnd;
    if (op.contourTolerance !== 0.001) milling.contour_tolerance_mm = op.contourTolerance;
    return milling;
  }
  milling.entry = op.entry;
  if (op.entry !== 'plunge') milling.ramp_angle_rad = op.rampDeg * Math.PI / 180;
  if (op.entry === 'helix' && op.helixRadius !== null) milling.helix_radius_mm = op.helixRadius;
  if (op.clearingTolerance !== 0.001) milling.clearing_tolerance_mm = op.clearingTolerance;
  return milling;
}

/** The target an operation names: the body, a named face (pocket floor, facing face) or named hole walls in order. */
export function targetOf(op: OperationDraft): Rec {
  const target = op.target!;
  if (followsOutline(op.kind)) {
    // Faces and edges are qualified by instance, as the frozen geometry archive records them ("part:edge(…)").
    if (op.contourMode === 'faces' && op.contourFaces.length) {
      const first = op.contourFaces[0];
      return { link: 'part', instances: instancesOf(first.instance), body: first.body, kind: 'face', names: op.contourFaces.map((face) => `${face.instance}:${face.face}`) };
    }
    if (op.contourMode === 'edges' && op.contourEdges.length) {
      const first = op.contourEdges[0];
      return { link: 'part', instances: instancesOf(first.instance), body: first.body, kind: 'edge', names: op.contourEdges.map((edge) => `${edge.instance}:${edge.edge}`) };
    }
    return { link: 'part', instances: instancesOf(target.instance), body: target.body, kind: 'body' };
  }
  if (takesHoles(op.kind) && op.holes.length) {
    const first = op.holes[0];
    return { link: 'part', instances: instancesOf(first.instance), body: first.body, kind: 'face', names: op.holes.map((hole) => `${hole.instance}:${hole.face}`) };
  }
  // 3D finishing and roughing select one whole retained body (face masks aren't executable inputs for them).
  if (isSurface(op.kind) || op.kind === 'rough') return { link: 'part', instances: instancesOf(target.instance), body: target.body, kind: 'body' };
  // A groove already modelled in the part is checked against the whole retained body.
  if (op.kind === 'engrave' && op.engraveIntent === 'existing_groove') return { link: 'part', instances: instancesOf(target.instance), body: target.body, kind: 'body' };
  // Slot guides name their centrelines; the target is then the retained body.
  if (op.kind === 'slot' && op.slotMode === 'guides') return { link: 'part', instances: instancesOf(target.instance), body: target.body, kind: 'body' };
  if (!takesHoles(op.kind) && op.floor) {
    // Face names are qualified by instance, as the frozen geometry archive records them ("part:pocket.bottom").
    return { link: 'part', instances: instancesOf(op.floor.instance), body: op.floor.body, kind: 'face', names: [`${op.floor.instance}:${op.floor.face}`] };
  }
  return { link: 'part', instances: instancesOf(target.instance), body: target.body, kind: 'body' };
}

/** The typed program for a draft. Missing choices throw with the field to fix. */
/**
 * The program with the edited part saved into it. A setup and an operation are separate tools: `mode` 'setup' saves the
 * setup alone (a setup needs no operations), 'op' saves the operation into `draft.setup` (moving it there when it was in
 * another setup) and leaves that setup as it is.
 */
export function programOf(draft: ProgramDraft, design: DesignPin, previous?: Program, mode: 'setup' | 'op' = 'op'): Program {
  const { setup, op } = draft;
  const need = (value: unknown, field: string, message: string) => { if (!value) throw new DraftError(field, message); };
  need(setup.machine, 'machine', 'Choose a machine.');
  need(setup.tooling, 'tooling', 'Choose the tools loaded in this machine (a tool setup).');
  if (mode === 'setup') return setupProgramOf(draft, design, previous);
  need(op.assembly, 'tool', isDrilling(op.kind) ? 'Choose a drill.' : `Choose a tool for the ${opLabelLower(op.kind)}.`);
  need(op.target, 'geometry', isPocketing(op.kind) ? 'Choose the body to pocket, or click its floor face.' : op.kind === 'slot' ? 'Choose the body with the slots, or click a slot floor.'
    : takesHoles(op.kind) ? 'Choose the body with the holes, or click the hole walls.'
    : op.kind === 'contour' ? 'Choose the part whose outline to follow, or pick faces or edges.'
    : op.kind === 'engrave' ? 'Choose the part to engrave, or click the face to engrave on.'
    : op.kind === 'chamfer' ? 'Choose the part to chamfer, or pick its top faces or edges.'
    : isSurface(op.kind) ? 'Choose the part to finish (the whole body is finished).' : op.kind === 'rough' ? 'Choose the part to rough around.' : 'Choose the part to face.');
  if (op.kind === 'parallel' && op.surfaceBounds) {
    const [x0, y0, x1, y1] = op.surfaceBounds;
    if (!(x0 < x1 && y0 < y1)) throw new DraftError('surface', 'The boundary needs its maximum X and Y above its minimum.');
  }
  if (op.kind === 'chamfer') {
    if (op.contourMode === 'faces') need(op.contourFaces.length, 'geometry', 'Pick the top faces whose edges to chamfer.');
    if (op.contourMode === 'edges') {
      need(op.contourEdges.length, 'geometry', 'Pick the edges to chamfer, in one connected chain.');
      if (op.side === 'auto') throw new DraftError('chamfer', 'Choose the side of the edges the cutter runs on (left or right of the arrow).');
    } else if (op.chamferIntent === 'existing_chamfer') {
      throw new DraftError('geometry', 'A chamfer already modelled is cut along its lower edges: pick them (Edges).');
    }
    if (op.chamferIntent === 'add_chamfer' && !(op.chamferWidth > op.chamferTolerance)) throw new DraftError('chamfer', 'The chamfer needs a width larger than its tolerance.');
  }
  if (op.kind === 'engrave') need(op.engravePaths.length, 'engrave', 'Pick sketch curves or edges for the engraving to follow.');
  if (op.kind === 'slot' && op.slotMode === 'guides') need(op.slotGuides.length, 'slot', 'Add a slot centreline, or let the engine find the slot floors.');
  if (op.kind === 'contour') {
    if (op.contourMode === 'faces') need(op.contourFaces.length, 'geometry', 'Pick the horizontal faces whose outline to follow.');
    if (op.contourMode === 'edges') {
      need(op.contourEdges.length, 'geometry', 'Pick the edges to follow, in one connected chain.');
      // The engine needs the side for an edge chain (contour_side_required): say so before saving.
      if (op.side === 'auto') throw new DraftError('contour', 'Choose the side of the edges the cutter runs on (left or right of the arrow).');
    }
  }
  // Library aliases: the first setup keeps the plain names; another setup reuses an alias pinning the same record, else
  // gets its own (suffixed with its ID).
  const previousLibraries = previous?.libraries ?? [];
  const otherSetups = ((previous?.setups ?? []) as Rec[]).filter((item) => item.id !== setup.id);
  const usedByOthers = new Set(otherSetups.flatMap((item) => [String(item.machine), String(item.tooling ?? ''), String((item.post as Rec | undefined)?.library ?? ''), String(item.machining_material ?? '')]));
  const libraries: Program['libraries'] = previousLibraries.filter((lib) => usedByOthers.has(lib.alias));
  const aliasFor = (base: string, record: Pin) => {
    const pin = pinOf(record);
    const same = libraries.find((lib) => lib.pin.id === pin.id && lib.pin.revision === pin.revision && (lib.alias === base || lib.alias.startsWith(`${base}_`)));
    if (same) return same.alias;
    let alias = base;
    for (let n = 1; libraries.some((lib) => lib.alias === alias); n++) alias = n === 1 ? `${base}_${setup.id}` : `${base}_${setup.id}_${n}`;
    libraries.push({ alias, pin });
    return alias;
  };
  const machineAlias = aliasFor(MACHINE, setup.machine!);
  const toolingAlias = aliasFor(TOOLING, setup.tooling!);
  const postAlias = setup.post ? aliasFor(POST, setup.post) : null;
  const materialAlias = setup.machiningMaterial ? aliasFor(MATERIAL, setup.machiningMaterial) : null;
  // Operations this form doesn't edit keep their tool and preset aliases.
  const previousOps = (previous?.operations ?? []) as Rec[];
  const kept = new Set(previousOps.filter((item) => item.id !== op.id).flatMap((item) => operationAliases(item)));
  for (const item of previousLibraries) if (kept.has(item.alias) && !libraries.some((lib) => lib.alias === item.alias)) libraries.push(item);
  // After the kept aliases, so a new preset alias never takes one another operation names.
  const presetAlias = op.preset ? aliasFor(PRESET, op.preset) : null;
  const alias = toolAlias(op.assignment ?? 'tool');
  const existing = libraries.find((lib) => lib.alias === alias);
  if (!existing) libraries.push({ alias, pin: pinOf(op.assembly!) });
  else if (existing.pin.id !== op.assembly!.id || existing.pin.revision !== op.assembly!.revision) {
    throw new DraftError('tool', 'Another operation pins a different revision of this tool. Update that operation first.');
  }
  const designs: Program['designs'] = [{ alias: 'part', pin: { document_id: design.document_id, branch: design.branch || 'main', revision: design.revision, overrides: {} } }];
  const pattern = op.pattern && patternable(op.kind) ? op.pattern : null;
  if (pattern) {
    const problem = patternProblem(pattern);
    if (problem) throw new DraftError('pattern', problem);
  }
  const operation: Rec = {
    id: op.id, name: op.name.trim() || OP_LABEL[op.kind], setup: setup.id, targets: [targetOf(op)],
    strategy: { ...strategyOf(op, alias), ...(presetAlias ? { cutting_preset: presetAlias } : {}) },
    ...(pattern ? { pattern: patternJson(pattern) } : {}),
  };
  // Operations stay grouped by setup. A new one goes after the last of its setup and works on the stock that one
  // leaves (the run carries it along); a setup's first one works on the stock its transfer brings.
  const before = previousOps.find((item) => item.id === op.id);
  const moved = !!before && String(before.setup ?? SETUP_ID) !== setup.id;
  let ordered = previousOps.filter((item) => !(moved && item.id === op.id))
    .map((item) => (item.id === op.id ? { ...operation, ...(item.depends_on ? { depends_on: item.depends_on } : {}) } : item));
  if (!ordered.some((item) => item.id === op.id)) {
    const mine = ordered.filter((item) => String(item.setup ?? SETUP_ID) === setup.id);
    const last = mine.at(-1);
    const source = setup.transfer?.from ?? null;
    const placed = last ? { ...operation, depends_on: [String(last.id)] } : source ? { ...operation, depends_on: [source] } : operation;
    const at = last ? ordered.indexOf(last) + 1 : ordered.length;
    ordered.splice(at, 0, placed);
  }
  // Moved to another setup: each setup's operations follow one another again (as reordering does).
  if (moved) ordered = chained(ordered, (previous?.setups ?? []) as Rec[]);
  if (op.kind === 'rest') {
    // Rest machining works on the actual stock of the operation right before it in its setup: that one is its source.
    const mine = ordered.filter((item) => String(item.setup ?? SETUP_ID) === setup.id);
    const index = mine.findIndex((item) => item.id === op.id);
    const before = index > 0 ? String(mine[index - 1].id) : null;
    if (!before) throw new DraftError('rest', 'Rest machining cleans up after another operation: add the pocket (or other cut) first, then rest machining after it.');
    const at = ordered.findIndex((item) => item.id === op.id);
    const strategy = (ordered[at].strategy as Rec);
    ordered[at] = { ...ordered[at], strategy: { ...strategy, rest_from: before } };
  }
  if (setup.transfer && !ordered.some((item) => item.id === setup.transfer!.from)) throw new DraftError('stock', 'The operation this setup takes its stock from is gone: choose the setup to continue from again.');
  const setupJson = setupJsonOf(setup, { machine: machineAlias, tooling: toolingAlias, post: postAlias, material: materialAlias }, previous);
  // Setups in program order; a new one (continuing from an earlier setup) goes last.
  const setups = ((previous?.setups ?? []) as Rec[]).map((item) => (item.id === setup.id ? setupJson : item));
  if (!setups.some((item) => item.id === setup.id)) setups.push(setupJson);
  return {
    version: 1, units: 'mm', name: draft.name.trim() || 'Milling program', designs, libraries,
    setups,
    operations: ordered,
  };
}

/** A setup's JSON from its draft and the library aliases its pins took. */
function setupJsonOf(setup: SetupDraft, alias: { machine: string; tooling: string; post: string | null; material: string | null }, previous?: Program): Rec {
  // What the editors don't edit stays as it was saved (setupJson.ts).
  return mergedSetupJson({
    id: setup.id, name: setup.name.trim() || 'Setup 1', process: 'milling', machine: alias.machine, tooling: alias.tooling,
    ...(alias.post ? { post: { library: alias.post, properties: setup.postProperties } } : {}),
    work_offset: setup.workOffset, material: setup.material, ...(alias.material ? { machining_material: alias.material } : {}),
    stock: setup.transfer
      ? { kind: 'previous_operation', operation: setup.transfer.from, transfer: frameJson(setup.transfer.frame) }
      : { kind: 'box', bounds: { minimum_mm: setup.stockMin, maximum_mm: setup.stockMax } },
    ...(setup.placedByRun ? {} : { work_to_machine: { origin_mm: setup.origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } }),
    fixtures: setup.fixtures.map((fixture) => fixtureJsonOf(fixture, instancesOf)),
    fixture_coverage: setup.fixtureCoverage,
    ...(setup.inspection ? { stock_inspection: inspectionJson(setup.inspection, previousSetupOf(previous, setup.id)) } : {}),
    // A new setup posts at its controller's resolution; a saved one keeps how it was posted.
    ...outputResolutionOf(previousSetupOf(previous, setup.id)),
  }, previousSetupOf(previous, setup.id));
}

/** `output_resolution` of a setup's JSON: what a saved setup had (absent = six decimals), `controller` for a new one. */
function outputResolutionOf(saved: Rec | undefined): Rec {
  if (!saved) return { output_resolution: 'controller' };
  return saved.output_resolution === undefined ? {} : { output_resolution: saved.output_resolution };
}

/** Each operation depends on the one before it in its setup (a setup's first on the operation its stock comes from). */
function chained(ops: Rec[], setups: Rec[]): Rec[] {
  return ops.map((op, index) => {
    const { depends_on: _, ...rest } = op;
    const setupId = String(op.setup ?? SETUP_ID);
    const before = ops.slice(0, index).filter((item) => String(item.setup ?? SETUP_ID) === setupId).at(-1);
    const transfer = transferOfSetup(setups.find((item) => item.id === setupId));
    return before ? { ...rest, depends_on: [String(before.id)] } : transfer ? { ...rest, depends_on: [transfer.from] } : rest;
  });
}

/** The program with `draft.setup` saved (added or changed) and every operation as it was. */
function setupProgramOf(draft: ProgramDraft, design: DesignPin, previous?: Program): Program {
  const { setup } = draft;
  const previousLibraries = previous?.libraries ?? [];
  const previousOps = (previous?.operations ?? []) as Rec[];
  const otherSetups = ((previous?.setups ?? []) as Rec[]).filter((item) => item.id !== setup.id);
  const used = new Set([...otherSetups.flatMap((item) => [String(item.machine), String(item.tooling ?? ''), String((item.post as Rec | undefined)?.library ?? ''), String(item.machining_material ?? '')]),
    ...previousOps.flatMap(operationAliases)]);
  const libraries: Program['libraries'] = previousLibraries.filter((lib) => used.has(lib.alias));
  const aliasFor = (base: string, record: Pin) => {
    const pin = pinOf(record);
    const same = libraries.find((lib) => lib.pin.id === pin.id && lib.pin.revision === pin.revision && (lib.alias === base || lib.alias.startsWith(`${base}_`)));
    if (same) return same.alias;
    let alias = base;
    for (let n = 1; libraries.some((lib) => lib.alias === alias); n++) alias = n === 1 ? `${base}_${setup.id}` : `${base}_${setup.id}_${n}`;
    libraries.push({ alias, pin });
    return alias;
  };
  const machineAlias = aliasFor(MACHINE, setup.machine!);
  const toolingAlias = aliasFor(TOOLING, setup.tooling!);
  const postAlias = setup.post ? aliasFor(POST, setup.post) : null;
  const materialAlias = setup.machiningMaterial ? aliasFor(MATERIAL, setup.machiningMaterial) : null;
  if (setup.transfer && !previousOps.some((item) => item.id === setup.transfer!.from)) throw new DraftError('stock', 'The operation this setup takes its stock from is gone: choose the setup to continue from again.');
  const setupJson = setupJsonOf(setup, { machine: machineAlias, tooling: toolingAlias, post: postAlias, material: materialAlias }, previous);
  const setups = ((previous?.setups ?? []) as Rec[]).map((item) => (item.id === setup.id ? setupJson : item));
  if (!setups.some((item) => item.id === setup.id)) setups.push(setupJson);
  const designs: Program['designs'] = previous?.designs?.length ? previous.designs
    : [{ alias: 'part', pin: { document_id: design.document_id, branch: design.branch || 'main', revision: design.revision, overrides: {} } }];
  return { version: 1, units: 'mm', name: draft.name.trim() || 'Machining', designs, libraries, setups, operations: previousOps };
}

/** The library aliases an operation's strategy names (its tool, and its cutting preset when bound). */
const operationAliases = (op: Rec) => {
  const strategy = (op.strategy ?? {}) as Rec;
  return [String(strategy.tool ?? ''), ...(strategy.cutting_preset ? [String(strategy.cutting_preset)] : [])];
};

const previousSetupOf = (previous: Program | null | undefined, id: string) => ((previous?.setups ?? []) as Rec[]).find((item) => item.id === id);

/** A setup's `stock_inspection`: the expected bodies through the design link, the bands, and any tuning saved before. */
function inspectionJson(inspection: InspectionDraft, previous: Rec | undefined): Rec {
  if (!inspection.bodies.length) throw new DraftError('inspection', 'Pick the design body the finished part should match (or turn the inspection off).');
  if (!(inspection.excess > 0) || !(inspection.missing > 0)) throw new DraftError('inspection', 'Both allowances must be more than zero.');
  const kept = (previous?.stock_inspection ?? {}) as Rec;
  return {
    expected: inspection.bodies.map((body) => ({ link: 'part', instances: instancesOf(body.instance), body: body.body, kind: 'body' })),
    excess_tolerance_mm: inspection.excess, missing_tolerance_mm: inspection.missing,
    ...(kept.minimum_box_mm !== undefined ? { minimum_box_mm: kept.minimum_box_mm } : {}),
    ...(kept.maximum_evaluations !== undefined ? { maximum_evaluations: kept.maximum_evaluations } : {}),
  };
}

/**
 * The program with its operations in a new order (or one removed), each depending on the one before it in this
 * setup, as the run carries stock from one to the next. Tool aliases no operation uses any more are dropped.
 */
export function reorderedProgram(program: Program, order: string[]): Program {
  const ops = program.operations as Rec[];
  const setupIds = (program.setups as Rec[]).map((setup) => String(setup.id));
  const setupOf = (op: Rec) => String(op.setup ?? SETUP_ID);
  // Operations stay in their setups, the setups in program order.
  const kept = order.map((id) => ops.find((op) => op.id === id)!).filter(Boolean)
    .map((op, index) => ({ op, index })).sort((a, b) => setupIds.indexOf(setupOf(a.op)) - setupIds.indexOf(setupOf(b.op)) || a.index - b.index).map((item) => item.op);
  // A setup continues from the last remaining operation of the setup it takes its stock from.
  const setups = (program.setups as Rec[]).map((setup) => {
    const transfer = transferOfSetup(setup);
    if (!transfer) return setup;
    const source = setupOfOperation(program, transfer.from);
    const last = kept.filter((op) => setupOf(op) === source).at(-1);
    if (!last) {
      const name = String((program.setups as Rec[]).find((item) => item.id === source)?.name ?? source);
      throw new DraftError('stock', `${String(setup.name)} continues from the stock ${name} leaves, and ${name} would have no operations: remove ${String(setup.name)}’s operations first.`);
    }
    return { ...setup, stock: { ...(setup.stock as Rec), operation: String(last.id) } };
  });   // A setup stays without operations: it's its own record.
  const next = kept.map((op, index) => {
    const { depends_on: _, ...rest } = op;
    const before = kept.slice(0, index).filter((item) => setupOf(item) === setupOf(op)).at(-1);
    const transfer = transferOfSetup(setups.find((setup) => setup.id === setupOf(op)));
    return before ? { ...rest, depends_on: [String(before.id)] } : transfer ? { ...rest, depends_on: [transfer.from] } : rest;
  });
  const used = new Set(next.flatMap(operationAliases));
  const shared = new Set([MACHINE, TOOLING, POST, ...setups.flatMap((setup) => [String(setup.machine), String(setup.tooling ?? ''), String((setup.post as Rec | undefined)?.library ?? ''), String(setup.machining_material ?? '')])]);
  return { ...program, setups, libraries: program.libraries.filter((lib) => shared.has(lib.alias) || used.has(lib.alias)), operations: next };
}

/** The program without a setup that has no operations (a program keeps at least one setup). */
export function withoutSetup(program: Program, setupId: string): Program {
  const setups = (program.setups as Rec[]).filter((setup) => setup.id !== setupId);
  if (!setups.length) throw new DraftError('form', 'This is the part’s only setup: edit it instead.');
  if (opsOfSetup(program, setupId).length) throw new DraftError('form', 'Remove this setup’s operations first.');
  const used = new Set([...(program.operations as Rec[]).flatMap(operationAliases),
    ...setups.flatMap((setup) => [String(setup.machine), String(setup.tooling ?? ''), String((setup.post as Rec | undefined)?.library ?? ''), String(setup.machining_material ?? '')])]);
  return { ...program, setups, libraries: program.libraries.filter((lib) => used.has(lib.alias)) };
}

export class DraftError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

/**
 * Which form field a server error path names ("body.setups.0.stock.box.bounds", "operations.0.strategy.stepover_mm",
 * or a job failure's `field`). Unknown paths land on the form as a whole.
 */
export function fieldOfPath(path: string): string {
  const p = path.replace(/^body\./, '');
  const rules: [RegExp, string][] = [
    [/stock_inspection/, 'inspection'], [/machining_material/, 'material'], [/cutting_preset/, 'feeds'], [/stock/, 'stock'], [/work_to_machine|work_offset/, 'placement'], [/fixture/, 'fixtures'], [/setups\.\d+\.post|post/, 'post'],
    [/setups\.\d+\.machine|machine/, 'machine'], [/tooling|assignment/, 'tooling'], [/strategy\.tool|\.tool$/, 'tool'],
    [/face_axis|face_overtravel/, 'passes'], [/drill_depth_reference|drill_breakthrough|peck_mm|drill_reentry|drill_retract/, 'drilling'],
    [/\.pattern\b|pattern_/, 'pattern'], [/engrave_(paths|intent|tolerance)/, 'engrave'], [/chamfer_(width|tip_offset|intent|tolerance|side)/, 'chamfer'], [/chamfer_boundary/, 'geometry'], [/contour_tabs/, 'tabs'], [/rest_from/, 'rest'], [/helix_radius/, 'linking'], [/bore_tolerance/, 'boring'], [/slot_(guides|tolerance)/, 'slot'],
    [/contour_(side|boundary|lead|extension|roughing|tolerance)/, 'contour'],
    [/surface_(axis|pass_mode|bounds|tolerance|allowance)/, 'surface'],
    [/drill_tolerance|holes?\b/, 'geometry'],
    [/targets|geometry|floor|face/, 'geometry'], [/clearance|top_mm|bottom_mm/, 'heights'],
    [/stepover|stepdown|allowance|direction/, 'passes'], [/entry|ramp/, 'linking'], [/rpm|feed|plunge/, 'feeds'], [/verification_cell|resolution/, 'cell'],
  ];
  return rules.find(([pattern]) => pattern.test(p))?.[1] ?? 'form';
}

/** The form field a failure names: its bound authoring field (`strategy.stepover_mm`) when the server gives one, else its code's. */
export function failureField(code: string, field?: string | null): string | undefined {
  const bound = field ? fieldOfPath(field) : undefined;
  return bound && bound !== 'form' ? bound : CODE_FIELDS[code] ?? bound;
}

/** Job failure codes the engine reports before or during a run → the field that fixes them. */
export const CODE_FIELDS: Record<string, string> = {
  milling_strategy_unsupported: 'form', milling_target_unsupported: 'geometry', milling_stock_unsupported: 'stock', milling_frame_unsupported: 'placement',
  milling_fixture_unsupported: 'fixtures', milling_machine_process: 'machine', milling_controller_unsupported: 'machine', milling_assignment_missing: 'tooling',
  milling_assignment_machine: 'tooling', milling_assignment_ambiguous: 'tool', milling_cutter_unsupported: 'tool', pocket_entry_unsupported: 'linking',
  milling_cut_dimensions: 'passes', milling_kinematics_unsupported: 'machine', milling_initial_pose_missing: 'machine', milling_initial_pose_limits: 'machine',
  milling_initial_pose_clearance: 'placement', milling_spindle_missing: 'machine', milling_spindle_limits: 'feeds', milling_feed_limit: 'feeds',
  milling_radius_offset_unsupported: 'tool', milling_length_offset_missing: 'tool', milling_post_required: 'post', milling_post_incompatible: 'post',
  milling_stock_top: 'heights', milling_stock_resolution: 'cell', operation_execution_unavailable: 'form',
  // Cutting-preset preflight and rate checks (docs/MANUFACTURING_CUTTING_PRESETS.md).
  cutting_material_mismatch: 'material', cutting_operation_mismatch: 'feeds', cutting_output_mismatch: 'feeds', cutting_preset: 'feeds', cutting_preset_coverage: 'feeds',
  cutting_stickout_limit: 'feeds', cutting_tool_binding: 'feeds', cutting_tool_mismatch: 'feeds',
  pocket_face_reference: 'geometry', pocket_face_count: 'geometry', pocket_selection_unsupported: 'geometry', pocket_floor_ambiguous: 'geometry',
  pocket_floor_invalid: 'geometry', pocket_top_invalid: 'heights', pocket_obstructed: 'geometry', pocket_wire_open: 'geometry', pocket_brep_invalid: 'geometry',
  pocket_geometry_parameters: 'heights', geometry_body_missing: 'geometry',
  facing_face_reference: 'geometry', facing_face_count: 'geometry', facing_selection_unsupported: 'geometry', facing_plane_invalid: 'geometry',
  facing_plane: 'heights', facing_target_obstructed: 'geometry', facing_stock_enclosure: 'stock', facing_brep_invalid: 'geometry',
  facing_parameters_invalid: 'passes', facing_parameters_unsupported: 'passes', facing_geometry_parameters: 'heights', facing_motion_limit: 'passes',
  drilling_face_reference: 'geometry', drilling_face_invalid: 'geometry', drilling_selection_unsupported: 'geometry', drilling_hole_ambiguous: 'geometry',
  drilling_holes_missing: 'geometry', drilling_hole_limit: 'geometry', drilling_tool_size: 'tool', drilling_target_obstructed: 'drilling',
  drilling_stock_enclosure: 'stock', drilling_brep_invalid: 'geometry', drilling_parameters_invalid: 'drilling', drilling_geometry_parameters: 'heights',
  drilling_entry_unsupported: 'drilling', drilling_motion_limit: 'drilling',
  contour_selection_unsupported: 'geometry', contour_reference_missing: 'geometry', contour_reference_duplicate: 'geometry', contour_reference_ambiguous: 'geometry',
  contour_face_missing: 'geometry', contour_face_invalid: 'geometry', contour_boundary_missing: 'geometry', contour_boundary_limit: 'geometry',
  contour_chain_disconnected: 'geometry', contour_chain_branched: 'geometry', contour_chain_ambiguous: 'geometry', contour_chain_self_intersection: 'geometry',
  contour_curve_unsupported: 'geometry', contour_nonplanar: 'geometry', contour_brep_invalid: 'geometry', contour_path_degenerate: 'geometry',
  contour_side_required: 'contour', contour_offset_unreachable: 'contour', contour_offset_clearance: 'contour', contour_target_obstructed: 'contour',
  contour_parameters_invalid: 'contour', contour_radial_limit: 'contour', contour_path_limit: 'contour', contour_corridor_limit: 'contour',
  contour_coordinate_limit: 'placement', contour_motion_limit: 'passes', contour_depth_limit: 'heights', contour_top_invalid: 'heights',
  contour_geometry_parameters: 'heights', contour_stock_enclosure: 'stock', contour_entry_unsupported: 'contour',
  operation_stock_unavailable: 'form',
  rough_selection: 'geometry', rough_pattern_unsupported: 'pattern', rough_entry_unsupported: 'linking', rough_region_enclosed: 'linking',
  rough_helix_no_room: 'linking', rough_helix_link: 'linking', rough_above_part: 'heights', rough_final_depth_empty: 'heights',
  rough_allowance_clearance: 'passes', rough_parameters_invalid: 'passes', rough_ring_limit: 'passes', rough_path_limit: 'passes',
  pocket_helix_no_clearance: 'linking', pocket_helix_topology: 'linking', pocket_helix_unreachable: 'linking',
  boring_face_reference: 'geometry', boring_face_invalid: 'geometry', boring_selection_unsupported: 'geometry', boring_hole_ambiguous: 'geometry',
  boring_holes_missing: 'geometry', boring_hole_limit: 'geometry', boring_tool_size: 'tool', boring_target_obstructed: 'geometry',
  boring_stock_enclosure: 'stock', boring_brep_invalid: 'geometry', boring_parameters_invalid: 'boring', boring_depth_limit: 'heights',
  boring_radial_limit: 'boring', boring_motion_limit: 'boring', boring_source_mismatch: 'geometry', boring_plunge_entry: 'boring',
  contour_tab_location: 'tabs', contour_tab_stock: 'tabs', contour_tab_path_limit: 'tabs',
  rest_stock_source: 'rest', rest_source_mismatch: 'rest', rest_stock_required: 'rest', rest_stock_height: 'heights',
  rest_entry_unsupported: 'rest', rest_computation_limit: 'passes', rest_motion_limit: 'passes',
  slot_tool_fit: 'tool', slot_target_obstructed: 'geometry', slot_paths_missing: 'geometry', slot_guide_selection: 'geometry', slot_face_invalid: 'geometry',
  slot_face_reference: 'geometry', slot_selection_unsupported: 'geometry', slot_brep_invalid: 'geometry', slot_source_mismatch: 'geometry',
  slot_parameters_invalid: 'slot', slot_path_limit: 'slot', slot_path_precision: 'slot', slot_ramp_limit: 'linking', slot_depth_limit: 'heights',
  slot_radial_limit: 'passes', slot_motion_limit: 'passes', slot_stock_enclosure: 'stock',
  engrave_surface_boundary: 'engrave', engrave_outside_stock: 'engrave', engrave_parameters_invalid: 'engrave', engrave_source_mismatch: 'geometry',
  engrave_selection: 'geometry', engrave_face_reference: 'geometry', engrave_face_invalid: 'geometry', engrave_brep_invalid: 'geometry',
  engrave_surface_missing: 'heights', engrave_top_invalid: 'heights', engrave_breakthrough: 'heights', engrave_target_obstructed: 'heights',
  engrave_stock_enclosure: 'stock', conical_depth_limit: 'passes', conical_motion_limit: 'engrave',
  chamfer_depth_mismatch: 'chamfer', chamfer_feature_invalid: 'chamfer', chamfer_offset_clearance: 'chamfer', chamfer_target_obstructed: 'chamfer',
  chamfer_parameters_invalid: 'chamfer', chamfer_tool_fit: 'tool', chamfer_selection: 'geometry', chamfer_lower_edge: 'geometry',
  chamfer_edge_invalid: 'geometry', chamfer_face_invalid: 'geometry', chamfer_reference_ambiguous: 'geometry', chamfer_source_mismatch: 'geometry',
  pattern_target_missing: 'pattern', pattern_direction_ambiguous: 'pattern', pattern_seed_missing: 'geometry', pattern_source_mismatch: 'form',
  surface_selection: 'geometry', surface_target_invalid: 'geometry', surface_contact_unresolved: 'surface', surface_clearance: 'heights',
  surface_paths_missing: 'heights', surface_parameters_invalid: 'surface', surface_cad_tolerance: 'surface', surface_path_unresolved: 'surface',
  surface_waterline_unresolved: 'surface', surface_clearance_unresolved: 'surface', surface_refinement_limit: 'surface', surface_path_limit: 'surface',
  surface_depth_limit: 'surface', surface_motion_limit: 'surface', surface_source_mismatch: 'form', native_surface_identity: 'form',
};

/** Plain words for the drilling and facing diagnostics the engine returns (its own message follows). */
export const CODE_HINTS: Record<string, string> = {
  milling_cut_dimensions: 'A stepover, stepdown or allowance is more than this cutter takes: the stepover can’t be wider than the cutter (a ball’s diameter), nor a pass deeper than its flutes.',
  drilling_tool_size: 'The holes aren’t the drill’s size: pick a drill whose diameter matches them (plus any radial allowance), or pick other holes.',
  drilling_holes_missing: 'No hole in that body matches the drill: holes are complete vertical cylindrical walls of the drill’s size.',
  drilling_hole_ambiguous: 'More than one way to read those hole walls: pick them face by face.',
  drilling_target_obstructed: 'The drill (with its point) would cut into the finished part: check the bottom height and the depth reference.',
  drilling_face_reference: 'A picked hole wall isn’t in the pinned design revision: pick it again on the current design.',
  drilling_face_invalid: 'A picked face isn’t a complete vertical hole wall.',
  drilling_stock_enclosure: 'The stock doesn’t enclose the part.',
  facing_plane: 'The bottom height must be the part’s top face (nothing of the part above it).',
  facing_target_obstructed: 'Part of the part rises above the facing plane.',
  facing_face_reference: 'The picked face isn’t in the pinned design revision: pick it again.',
  facing_stock_enclosure: 'The stock doesn’t enclose the part.',
  contour_side_required: 'An edge chain needs its side: choose left or right of the arrow.',
  contour_target_obstructed: 'On that side the cutter (or a lead) would cut into the finished part: choose the other side, or shorten the leads.',
  contour_offset_clearance: 'The cutter can’t run on that side without cutting the finished part: choose the other side or a smaller cutter.',
  contour_offset_unreachable: 'The cutter is too big to follow that outline on this side (a corner or gap is tighter than its radius).',
  contour_chain_disconnected: 'The picked edges don’t join end to end: pick one connected chain.',
  contour_chain_branched: 'The picked edges branch: pick one chain without forks.',
  contour_chain_self_intersection: 'The outline crosses itself: pick a simple chain.',
  contour_curve_unsupported: 'Contours follow straight edges and circular arcs; splines aren’t supported yet.',
  contour_nonplanar: 'The picked edges aren’t in one horizontal plane.',
  contour_reference_missing: 'A picked face or edge isn’t in the pinned design revision: pick it again on the current design.',
  contour_reference_ambiguous: 'More than one way to read that selection: pick the faces or edges one by one.',
  contour_boundary_missing: 'No outline of that kind (outer or inner) on the selection.',
  contour_stock_enclosure: 'The stock doesn’t enclose the part.',
  contour_top_invalid: 'The top must be at or above the stock top.',
  contour_depth_limit: 'The depth is past what the cutter’s flutes reach.',
  pocket_helix_no_clearance: 'The helix doesn’t fit there: make its radius smaller (at most the cutter radius), or leave it on auto.',
  pocket_helix_unreachable: 'A pocket region has no room for a helical entry: use a ramp or plunge, or a smaller cutter.',
  pocket_helix_topology: 'The helical entry can’t link this pocket’s regions safely: use a ramp or plunge.',
  boring_tool_size: 'The cutter doesn’t fit the bore: pick a flat end mill that fits inside the hole (after any radial allowance), or one the bore’s own size to plunge it like a counterbore (it may be over by at most the bore tolerance).',
  boring_plunge_entry: 'This cutter fills the bore, so it can only plunge at the centre: set Entry to Plunge at centre.',
  boring_holes_missing: 'No complete vertical bore in that body fits the cutter: pick the bore walls, or a smaller cutter.',
  boring_hole_ambiguous: 'Different diameters share one axis there: pick the bore wall you mean.',
  boring_target_obstructed: 'The bore (or its approach) would cut retained material: check the bottom height, or what’s above the hole.',
  boring_face_reference: 'A picked bore wall isn’t in the pinned design revision: pick it again on the current design.',
  boring_face_invalid: 'A picked face isn’t a complete vertical bore wall.',
  boring_stock_enclosure: 'The stock doesn’t enclose the part.',
  contour_tab_location: 'A tab must sit on one straight part of the outline, away from corners: move it along the edge.',
  contour_tab_stock: 'A tab needs stock under it and must reach past every cutting pass: check its height, and that the stock surrounds it.',
  rest_stock_source: 'Rest machining works on the stock the operation right before it leaves: put it right after the pocket it cleans up.',
  rest_entry_unsupported: 'Rest machining enters with a plunge only.',
  rest_stock_required: 'The operation before this one hasn’t produced stock to work from: run the program, not this operation alone.',
  slot_tool_fit: 'The cutter is wider than the slot (after any radial allowance): pick a cutter no wider than the slot.',
  slot_target_obstructed: 'That slot’s width, depth or approach would cut retained material: check the width, the bottom height and what’s above it.',
  slot_paths_missing: 'No rounded slot floor at that height: pick the floor, set the bottom to it, or add a centreline for an open or through slot.',
  slot_face_invalid: 'The picked face isn’t a complete straight slot floor with rounded ends: add a centreline instead.',
  slot_guide_selection: 'Centreline guides need the whole body as the target.',
  slot_face_reference: 'The picked slot floor isn’t in the pinned design revision: pick it again on the current design.',
  slot_ramp_limit: 'The ramp can’t fit along this slot at that angle: steepen it a little, or plunge.',
  slot_stock_enclosure: 'The stock doesn’t enclose the part.',
  engrave_surface_boundary: 'The groove runs off the face it’s engraved on (over an edge, a hole or another face): keep the paths inside the face, at least half the groove’s width from its edges.',
  engrave_outside_stock: 'A path runs outside the stock: keep the paths over the part.',
  engrave_selection: 'Engrave on the part or on picked upward flat faces; a groove already modelled needs the whole part.',
  engrave_face_invalid: 'The picked face isn’t flat and facing up at the top height: pick the face you engrave on.',
  engrave_face_reference: 'The picked face isn’t in the pinned design revision: pick it again on the current design.',
  engrave_surface_missing: 'There’s no upward flat face at the top height: set the top to the face you engrave on.',
  engrave_top_invalid: 'Part of the part rises above the top height: the cutter couldn’t get to the face. Set the top to the face, or engrave a higher face.',
  engrave_breakthrough: 'That depth would cut through the part: make the groove shallower.',
  engrave_target_obstructed: 'The modelled groove is narrower or shallower than this cut: check the depth and the cutter’s angle and tip.',
  engrave_stock_enclosure: 'The stock doesn’t enclose the part.',
  conical_depth_limit: 'Too many depth passes for this groove: raise the stepdown.',
  chamfer_depth_mismatch: 'The picked edge’s height, the width and the cutter’s angle don’t agree: the bottom height follows from them here, so pick the edge again or check the cutter’s angle.',
  chamfer_feature_invalid: 'That width can’t form a chamfer on these edges (too wide for the face or the wall): make it narrower.',
  chamfer_offset_clearance: 'The rounded cutter path would come too close to the edge: raise the tip offset a little.',
  chamfer_target_obstructed: 'The cutter would cut more than the chamfer (another feature is in the way, or the tip is too low): lower the width or the tip offset, or pick fewer edges.',
  chamfer_parameters_invalid: 'The width and tip offset don’t fit this cutter’s cone or reach: use a narrower chamfer, a smaller tip offset or a larger V-bit.',
  chamfer_tool_fit: 'The cutter’s angle or the usable length of its cone doesn’t match the modelled bevel: use a V-bit with the bevel’s angle.',
  chamfer_selection: 'A chamfer already modelled is cut along its lower edges: pick them (Edges), not the part or a face.',
  chamfer_lower_edge: 'Pick the lower edges of the modelled bevel, where it meets the vertical wall, at the bottom height.',
  chamfer_edge_invalid: 'A new chamfer goes on a sharp edge between an upward flat face and a vertical wall: pick such edges or faces.',
  chamfer_face_invalid: 'Pick flat faces that face up.',
  chamfer_reference_ambiguous: 'A picked face or edge isn’t (or isn’t uniquely) in the pinned design revision: pick it again on the current design.',
  chamfer_source_mismatch: 'The chamfer’s geometry changed since it was planned: generate it again.',
  pattern_target_missing: 'An instance has no matching feature on the part where the pattern puts it (the seed moved there doesn’t land on an identical face or edge): check the spacing or angle, or suppress that instance.',
  pattern_direction_ambiguous: 'An instance’s edges don’t settle which side the cutter runs on: suppress it, or use a closed outline.',
  pattern_seed_missing: 'The seed selection isn’t in the pinned design revision: pick its faces or edges again.',
  pattern_source_mismatch: 'The pattern changed since it was planned: generate it again.',
  surface_selection: '3D finishing works on a whole solid body: choose the part (faces can’t be picked for it).',
  surface_target_invalid: 'The part isn’t a valid solid for 3D finishing: check the design builds one closed body.',
  surface_contact_unresolved: 'The ball couldn’t find a clean contact with the surface everywhere: loosen the path tolerance a little, or limit the boundary to the curved area.',
  surface_clearance: 'The clearance height must be above the whole part plus the allowance: raise the clearance.',
  surface_paths_missing: 'Nothing to finish between the top and bottom heights here: lower the bottom, or check the boundary covers the part.',
  surface_parameters_invalid: 'These settings don’t fit the stock or the cutter: a stepover wider than the ball, a top below the stock left to cut, or a pass deeper than the flutes.',
  surface_cad_tolerance: 'The part’s own CAD tolerance is coarser than this path tolerance: loosen the path tolerance.',
  surface_path_unresolved: 'A parallel row can’t follow a steep wall within tolerance: limit the boundary to the shallow areas and finish the walls with waterline, or loosen the tolerance.',
  surface_waterline_unresolved: 'Waterline couldn’t follow the walls within tolerance at every level: loosen the path tolerance, or change the stepdown.',
  surface_clearance_unresolved: 'The engine couldn’t prove the cutter clears the part everywhere: loosen the path tolerance, or use a smaller boundary.',
  surface_refinement_limit: 'Proving clearance took too much computation: loosen the path tolerance, or finish a smaller area.',
  surface_path_limit: 'The paths have too many points: use a larger stepover or stepdown, a looser tolerance or a smaller boundary.',
  surface_depth_limit: 'Too many depth passes or levels: use a larger stepdown, or a top closer to the bottom.',
  surface_motion_limit: 'The finishing program would be too long: use a larger stepdown or stepover, or a smaller boundary.',
  surface_source_mismatch: 'The part or settings changed since the paths were planned: generate it again.',
};
