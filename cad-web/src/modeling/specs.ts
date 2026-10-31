/**
 * Feature dialogs, declared once per kind: fields, what they pre-fill from the selection,
 * and how values become the call's arguments (docs/MODELING.md section 4). Values are
 * Python sources, so an expression like `thickness * 2` stays an expression.
 */
import type { ComponentType } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import {
  BoundaryFillIcon, BoundarySurfaceIcon, BoxIcon, SolidifyIcon, ThickenIcon, ChamferIcon, CircularPatternIcon, ConeIcon, CylinderIcon, DraftIcon, ExtrudeIcon, FillIcon, FilletIcon, HoleIcon, LinearPatternIcon,
  LoftIcon, MirrorIcon, MoveIcon, OriginIcon, RevolveIcon, ShellIcon, SphereIcon, SweepIcon, TablePatternIcon, TextToolIcon, TorusIcon,
} from '@/icons/cad';
import type { ModelDoc } from '@/lib/modeling';
import { selectedBodies, splitTuple } from './bodies';
import { SHEET_SPECS } from '@/workspaces/sheetmetal/specs';

export type FieldType = 'sketch' | 'sketches' | 'edges' | 'edge' | 'faces' | 'face' | 'plane' | 'axis' | 'length' | 'angle' | 'count' | 'number' | 'choice' | 'boolean'
  | 'features' | 'text' | 'points' | 'point' | 'vector' | 'bodies' | 'segments' | 'chips' | 'rule' | 'form_tool' | 'bend' | 'image'
  | 'offsets' | 'component' | 'table' | 'regions' | 'decal_center';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** Written positionally right after the id (in field order), otherwise as `key=`. */
  positional?: boolean;
  required?: boolean;
  /** Python source used when the dialog opens. */
  initial?: string;
  /** Omit the argument when its source equals this (the library default). */
  omit?: string;
  options?: { value: string; label: string }[];
  hint?: string;
  when?: (values: Values) => boolean;
  /** Not written as an argument; `emit` turns it into others. */
  virtual?: boolean;
  /** A `sketches` list that also offers construction points (a loft's first or last section). */
  points?: boolean;
  /** An edge list that can also take whole sketches, such as a fill boundary. */
  sketches?: boolean;
}

export type Values = Record<string, string>;

export interface Context {
  doc: ModelDoc | null;
  /** Reference names of selected faces / edges (from the build's topology). */
  faces: string[];
  edges: string[];
  /** The feature the user last worked on (or selected in the browser/timeline). */
  lastSketch: string | null;
  lastSolid: string | null;
}

export interface FeatureSpec {
  kind: string;
  label: string;
  prefix: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  description: string;
  /** Essential workflow guidance shown in the tool, in addition to ribbon help. */
  guidance?: string;
  fields: Field[];
  preselect?: (ctx: Context) => Partial<Values>;
  /** Extra keyword arguments derived from virtual fields. */
  emit?: (values: Values) => Record<string, string | undefined>;
  /** Virtual field values recovered from an existing call's keyword sources. */
  read?: (kwargs: Record<string, string>) => Partial<Values>;
  /** A Sheet Metal tab tool (its ribbon commands are `sheet.*`, not `model.*`). */
  sheet?: boolean;
  /** A surface-only tool (it makes surface bodies): editing it shows the Surface tab (workspaces/surface/commands.ts). */
  surface?: boolean;
  /** Turns a picked face/edge reference into what the target field takes; null refuses the pick (with `pickHint`). */
  pick?: (ref: string, field: string) => string | null;
  pickHint?: string | ((field: string) => string);
}

const list = (refs: string[]) => (refs.length ? `[${refs.map((r) => JSON.stringify(r)).join(', ')}]` : '');
const quote = (text: string | null) => (text ? JSON.stringify(text) : '');

const OP: Field = {
  key: 'op', label: 'Operation', type: 'choice', initial: '', omit: '',
  options: [{ value: '', label: 'Auto' }, { value: '"new"', label: 'New body' }, { value: '"join"', label: 'Join' }, { value: '"cut"', label: 'Cut' }, { value: '"intersect"', label: 'Intersect' }],
  hint: 'Auto cuts when the extrusion goes into the solid, and joins (or starts the model) when it goes out of it.',
};

const PLANES = [{ value: '"XY"', label: 'XY' }, { value: '"XZ"', label: 'XZ' }, { value: '"YZ"', label: 'YZ' }];
const AXES = [{ value: '"X"', label: 'X axis' }, { value: '"Y"', label: 'Y axis' }, { value: '"Z"', label: 'Z axis' }];

export const SPECS: Record<string, FeatureSpec> = {
  extrude: {
    kind: 'extrude', label: 'Extrude', prefix: 'extrude', icon: ExtrudeIcon,
    description: 'Push a sketch profile into a solid, or cut it into one.',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true, hint: 'A sketch (all its closed regions, holes stay holes).' },
      { key: 'extent', label: 'Extent', type: 'choice', virtual: true, initial: 'distance', options: [{ value: 'distance', label: 'Distance' }, { value: 'both', label: 'Symmetric' }, { value: 'through', label: 'Through all' }] },
      { key: 'distance', label: 'Distance', type: 'length', initial: '10', when: (v) => v.extent !== 'through', hint: 'Negative goes the other way.' },
      OP,
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch) }),
    emit: (v) => ({ both: v.extent === 'both' ? 'True' : undefined, through_all: v.extent === 'through' ? 'True' : undefined, distance: v.extent === 'through' ? undefined : v.distance }),
    read: (k) => ({ extent: k.through_all === 'True' ? 'through' : k.both === 'True' ? 'both' : 'distance' }),
  },
  revolve: {
    kind: 'revolve', label: 'Revolve', prefix: 'revolve', icon: RevolveIcon,
    description: 'Spin a profile around an axis.',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true },
      { key: 'axis', label: 'Axis', type: 'axis', required: true, initial: '"Z"', hint: 'X, Y, Z, a sketch line (sketch_1.l3) or a straight edge.' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '360', omit: '360' },
      OP,
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch), ...(ctx.edges.length === 1 ? { axis: JSON.stringify(ctx.edges[0]) } : {}) }),
  },
  sweep: {
    kind: 'sweep', label: 'Sweep', prefix: 'sweep', icon: SweepIcon,
    description: 'Sweep a closed profile along a path.',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true },
      { key: 'path', label: 'Path', type: 'sketch', positional: true, required: true, hint: 'A sketch whose curves form the path (construction lines count).' },
      { key: 'orientation', label: 'Orientation', type: 'choice', virtual: true, initial: 'default',
        options: [{ value: 'default', label: 'Default' }, { value: 'frenet', label: 'Keep twist (Frenet)' }, { value: 'binormal', label: 'Fixed direction' }, { value: 'guide', label: 'Guide curve' }],
        hint: 'Fixed direction keeps the profile from twisting, like a U-shaped path in one plane. A guide curve steers the profile, and scales it when it starts on the profile’s outline.' },
      { key: 'binormal', label: 'Direction', type: 'vector', initial: '(0, 0, 1)', when: (v) => v.orientation === 'binormal', hint: 'Across the path: for a path in one plane, that plane’s normal.' },
      { key: 'guide', label: 'Guide curve', type: 'sketch', required: true, when: (v) => v.orientation === 'guide', hint: 'A sketch whose curves run beside the path from its start to its end.' },
      { key: 'sections', label: 'More sections', type: 'sketches', initial: '', omit: '', hint: 'Closed profiles after the first, in order along the path: the section changes between them.' },
      { key: 'transition', label: 'Corners', type: 'choice', initial: '"right"', omit: '"right"', options: [{ value: '"right"', label: 'Sharp' }, { value: '"round"', label: 'Round' }, { value: '"transformed"', label: 'Transformed' }] },
      OP,
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch) }),
    // positions= (where each section sits along the path) has no field: kept as written when the sweep is edited.
    emit: (v) => ({ frenet: v.orientation === 'frenet' ? 'True' : undefined, positions: v.sections && v.positions ? v.positions : undefined }),
    read: (k) => ({ orientation: k.frenet === 'True' ? 'frenet' : k.binormal ? 'binormal' : k.guide ? 'guide' : 'default', positions: k.positions ?? '' }),
  },
  loft: {
    kind: 'loft', label: 'Loft', prefix: 'loft', icon: LoftIcon,
    description: 'A smooth solid through two or more profiles, in order.',
    fields: [
      { key: 'sections', label: 'Sections', type: 'sketches', positional: true, required: true, points: true, hint: 'Pick sketches in order; a construction point can be the first or last, to close the loft to a tip.' },
      { key: 'ruled', label: 'Straight sides', type: 'boolean', initial: 'False', omit: 'False' },
      { key: 'smoothing', label: 'Smoothing', type: 'boolean', initial: 'False', omit: 'False', when: (v) => v.ruled !== 'True', hint: 'Fairs the surface so it bulges less between unevenly spaced sections.' },
      { key: 'continuity', label: 'Continuity', type: 'choice', initial: '', omit: '', when: (v) => v.ruled !== 'True',
        options: [{ value: '', label: 'Default' }, { value: '"C1"', label: 'C1' }, { value: '"C2"', label: 'C2' }],
        hint: 'How smoothly the loft flows through its own sections: C1 keeps tangents, C2 curvature too (the default). Not across to neighbouring faces; G2/Class-A between faces is beyond these tools.' },
      { key: 'max_degree', label: 'Max degree', type: 'count', initial: '', omit: '', when: (v) => v.ruled !== 'True', hint: '2 to 25; empty uses 8. Lower is stiffer, higher follows the sections more closely.' },
      OP,
    ],
  },
  fill: {
    kind: 'fill', label: 'Fill', prefix: 'fill', icon: FillIcon, surface: true,
    description: 'A surface patch closing a loop of edges or sketch curves, optionally tangent to the faces around it. Makes a surface body.',
    fields: [
      { key: 'boundary', label: 'Boundary', type: 'edges', sketches: true, required: true, hint: 'Pick edges in the view, or choose a sketch whose curves close one loop.' },
      { key: 'continuity', label: 'Continuity', type: 'choice', initial: '"G0"', omit: '"G0"',
        options: [{ value: '"G0"', label: 'Through the edges (G0)' }, { value: '"G1"', label: 'Tangent to the faces (G1)' }] },
      { key: 'support', label: 'Tangent to', type: 'faces', initial: '', omit: '', when: (v) => v.continuity === '"G1"',
        hint: 'The faces the patch is tangent to, where an edge lies between two. Empty when each edge has only one.' },
      { key: 'constraints', label: 'Pass through', type: 'offsets', initial: '', omit: '', hint: 'Points (X, Y, Z in mm) the patch also passes through, like a dome’s top.' },
    ],
    preselect: (ctx) => ({ boundary: list(ctx.edges) }),
  },
  boundary_surface: {
    kind: 'boundary_surface', label: 'Boundary surface', prefix: 'surface', icon: BoundarySurfaceIcon, surface: true,
    description: 'A surface blended through two or more curves in order, or through a grid of curves both ways. Makes a surface body.',
    fields: [
      { key: 'curves_u', label: 'Curves', type: 'sketches', positional: true, required: true, hint: 'Pick sketches (or edges) in order; each is one curve set.' },
      { key: 'curves_v', label: 'Cross curves', type: 'sketches', initial: '', omit: '', hint: 'Optional: curves running the other way; the first and last close a four-sided patch.' },
      { key: 'ruled', label: 'Straight between curves', type: 'boolean', initial: 'False', omit: 'False', when: (v) => !v.curves_v },
    ],
  },
  thicken: {
    kind: 'thicken', label: 'Thicken', prefix: 'thicken', icon: ThickenIcon,
    description: 'A wall of a set thickness from a surface, or from faces of a solid: a solid. A whole surface body becomes the solid.',
    fields: [
      { key: 'source', label: 'Surface', type: 'faces', positional: true, required: true, hint: 'A surface body’s faces, or faces of one solid (their wall joins it).' },
      { key: 'thickness', label: 'Thickness', type: 'length', positional: true, required: true, initial: '2' },
      { key: 'side', label: 'Side', type: 'choice', initial: '"out"', omit: '"out"',
        options: [{ value: '"out"', label: 'Along the normal' }, { value: '"in"', label: 'Against the normal' }, { value: '"both"', label: 'Both ways (half each)' }] },
      OP,
    ],
    preselect: (ctx) => (ctx.faces.length ? { source: list(ctx.faces) } : {}),
  },
  solidify: {
    kind: 'solidify', label: 'Solidify', prefix: 'solid', icon: SolidifyIcon,
    description: 'Sews surface bodies that close a volume into one solid; open edges are named when they don’t close.',
    fields: [
      { key: 'surfaces', label: 'Surfaces', type: 'bodies', positional: true, required: true, hint: 'Pick a face of each surface body; together they must close a volume.' },
      { key: 'tolerance', label: 'Gap tolerance', type: 'length', initial: '0.01', omit: '0.01', hint: 'Gaps up to this are closed when sewing.' },
      OP,
    ],
  },
  boundary_fill: {
    kind: 'boundary_fill', label: 'Boundary fill', prefix: 'boundary_fill', icon: BoundaryFillIcon,
    description: 'Fill or cut the regions that bodies and planes enclose between them, like a pocket closed off by a plane.',
    fields: [
      { key: 'tools', label: 'Bodies', type: 'bodies', positional: true, required: true, hint: 'Pick a face of each body that bounds the regions.' },
      { key: 'planes', label: 'Plane', type: 'plane', initial: '', omit: '', hint: 'Extended across the model to close the regions off. Code can list several.' },
      { key: 'cells', label: 'Regions', type: 'regions', initial: '', omit: '',
        hint: 'The regions the preview found, by volume: click them to choose. Auto uses every enclosed region outside the bodies. In code each is a point (X, Y, Z) inside it.' },
      { key: 'tools_after', label: 'Bodies afterwards', type: 'choice', initial: '"keep"', omit: '"keep"',
        options: [{ value: '"keep"', label: 'Keep' }, { value: '"remove"', label: 'Remove' }, { value: '"include"', label: 'Include in the fill' }],
        hint: 'The body the fill goes into always stays.' },
      { ...OP, hint: 'Auto joins the regions to the active body.' },
    ],
    preselect: () => ({ tools: list(selectedBodies()) }),
  },
  hole: {
    kind: 'hole', label: 'Hole', prefix: 'hole', icon: HoleIcon,
    description: 'Simple, counterbored or countersunk holes normal to a face.',
    fields: [
      { key: 'on', label: 'Face', type: 'face', required: true, hint: 'A flat face; positions are measured in its sketch coordinates.' },
      { key: 'points', label: 'Positions', type: 'points', required: true, initial: '[(0, 0)]', hint: 'X, Y on the face, or sketch points (points, circle centres, line ends) picked in the view; a picked hole follows its sketch.' },
      { key: 'kind', label: 'Type', type: 'choice', initial: '"simple"', omit: '"simple"', options: [{ value: '"simple"', label: 'Simple' }, { value: '"counterbore"', label: 'Counterbore' }, { value: '"countersink"', label: 'Countersink' }] },
      { key: 'diameter', label: 'Diameter', type: 'length', required: true, initial: '6.6' },
      { key: 'depth', label: 'Depth', type: 'length', initial: '', omit: '', hint: 'Empty goes through.' },
      { key: 'cbore_diameter', label: 'Counterbore Ø', type: 'length', initial: '11', when: (v) => v.kind === '"counterbore"' },
      { key: 'cbore_depth', label: 'Counterbore depth', type: 'length', initial: '6.4', when: (v) => v.kind === '"counterbore"' },
      { key: 'csk_diameter', label: 'Countersink Ø', type: 'length', initial: '13', when: (v) => v.kind === '"countersink"' },
      { key: 'csk_angle', label: 'Countersink angle', type: 'angle', initial: '90', when: (v) => v.kind === '"countersink"' },
      { key: 'thread', label: 'Thread', type: 'text', initial: '', omit: '', hint: 'A tapped hole’s thread, like M6x1, for drawings’ hole tables; its diameter is the tap drill.' },
    ],
    preselect: (ctx) => (ctx.faces.length ? { on: JSON.stringify(ctx.faces[0]) } : {}),
  },
  fillet: {
    kind: 'fillet', label: 'Fillet', prefix: 'fillet', icon: FilletIcon,
    description: 'Round edges.',
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges', required: true, hint: 'Pick edges (or a face for all its edges).' },
      { key: 'radius', label: 'Radius', type: 'length', required: true, initial: '2' },
      { key: 'radius2', label: 'End radius', type: 'length', initial: '', omit: '', hint: 'Variable fillet: blends from Radius to this along each edge. Empty for a constant radius.' },
      { key: 'flip', label: 'Flip direction', type: 'boolean', initial: 'False', omit: 'False', when: (v) => !!v.radius2, hint: 'Swap which end of the edge gets which radius.' },
    ],
    preselect: (ctx) => ({ edges: list(ctx.edges.length ? ctx.edges : ctx.faces) }),
  },
  chamfer: {
    kind: 'chamfer', label: 'Chamfer', prefix: 'chamfer', icon: ChamferIcon,
    description: 'Bevel edges.',
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges', required: true },
      { key: 'distance', label: 'Distance', type: 'length', required: true, initial: '1' },
      { key: 'distance2', label: 'Second distance', type: 'length', initial: '', omit: '', when: (v) => !v.angle, hint: 'Empty for an equal-distance chamfer.' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '', omit: '', when: (v) => !v.distance2, hint: 'Distance + angle chamfer (0–90°). Empty for distances only.' },
      { key: 'along', label: 'Along face', type: 'faces', initial: '', omit: '', when: (v) => (!!v.distance2 || !!v.angle) && v.flip !== 'True', hint: 'The face Distance runs along (each edge must touch one of them). Empty uses the edge’s first face.' },
      { key: 'flip', label: 'Flip side', type: 'boolean', initial: 'False', omit: 'False', when: (v) => (!!v.distance2 || !!v.angle) && !v.along, hint: 'Measure the distance along the other face.' },
    ],
    preselect: (ctx) => ({ edges: list(ctx.edges.length ? ctx.edges : ctx.faces) }),
  },
  shell: {
    kind: 'shell', label: 'Shell', prefix: 'shell', icon: ShellIcon,
    description: 'Hollow the body, opening the selected faces.',
    fields: [
      { key: 'remove', label: 'Open faces', type: 'faces', positional: true, hint: 'Faces to remove (none makes a closed hollow).' },
      { key: 'thickness', label: 'Wall', type: 'length', positional: true, required: true, initial: '2' },
    ],
    preselect: (ctx) => ({ remove: list(ctx.faces) || '[]' }),
  },
  draft: {
    kind: 'draft', label: 'Draft', prefix: 'draft', icon: DraftIcon,
    description: 'Taper faces for molding.',
    fields: [
      { key: 'faces', label: 'Faces', type: 'faces', positional: true, required: true },
      { key: 'neutral', label: 'Neutral plane', type: 'plane', positional: true, required: true, initial: '"XY"' },
      { key: 'angle', label: 'Angle', type: 'angle', positional: true, required: true, initial: '3' },
    ],
    preselect: (ctx) => ({ faces: list(ctx.faces) }),
  },
  linear_pattern: {
    kind: 'linear_pattern', label: 'Linear pattern', prefix: 'pattern', icon: LinearPatternIcon,
    description: 'Repeat features along one or two directions.',
    fields: [
      { key: 'features', label: 'Features', type: 'features', required: true },
      { key: 'direction', label: 'Direction', type: 'axis', positional: true, required: true, initial: '"X"' },
      { key: 'count', label: 'Count', type: 'count', positional: true, required: true, initial: '3' },
      { key: 'spacing', label: 'Spacing', type: 'length', positional: true, required: true, initial: '10' },
      { key: 'direction2', label: 'Second direction', type: 'axis', initial: '', omit: '' },
      { key: 'count2', label: 'Second count', type: 'count', initial: '1', omit: '1', when: (v) => !!v.direction2 },
      { key: 'spacing2', label: 'Second spacing', type: 'length', initial: '10', when: (v) => !!v.direction2 },
    ],
    preselect: (ctx) => ({ features: ctx.lastSolid ? `[${JSON.stringify(ctx.lastSolid)}]` : '' }),
  },
  circular_pattern: {
    kind: 'circular_pattern', label: 'Circular pattern', prefix: 'pattern', icon: CircularPatternIcon,
    description: 'Repeat features around an axis.',
    fields: [
      { key: 'features', label: 'Features', type: 'features', required: true },
      { key: 'axis', label: 'Axis', type: 'axis', positional: true, required: true, initial: '"Z"' },
      { key: 'count', label: 'Count', type: 'count', positional: true, required: true, initial: '6' },
      { key: 'angle', label: 'Total angle', type: 'angle', initial: '360', omit: '360' },
    ],
    preselect: (ctx) => ({ features: ctx.lastSolid ? `[${JSON.stringify(ctx.lastSolid)}]` : '', ...(ctx.edges.length === 1 ? { axis: JSON.stringify(ctx.edges[0]) } : {}) }),
  },
  // In a design's main.py the same command places a component at a table's rows instead (DESIGN_TABLE_PATTERN).
  point_pattern: {
    kind: 'point_pattern', label: 'Table pattern', prefix: 'pattern', icon: TablePatternIcon,
    description: 'Repeat features at a table of positions, spaced however they are. In a design, repeat a component at the rows of an imported table (.csv or Excel .xlsx).',
    fields: [
      { key: 'features', label: 'Features', type: 'features', required: true },
      { key: 'points', label: 'Positions', type: 'offsets', positional: true, required: true, initial: '[(0, 0), (15, 0), (40, 10)]',
        hint: 'Offsets from the features (X, Y and optionally Z, mm); (0, 0) is the original. With Polar, radius, angle (°) and Z.' },
      { key: 'polar', label: 'Polar (r, θ)', type: 'boolean', initial: 'False', omit: 'False', hint: 'Read each row as radius and angle; each copy turns by its angle about Z.' },
      { key: 'absolute', label: 'Absolute positions', type: 'boolean', initial: 'False', omit: 'False',
        hint: 'Read each row as a position instead of an offset: the first row is where the features are, and each other row gets a copy there.' },
    ],
    // labels= (names for the copies, often a table column) has no field: kept as written when the pattern is edited.
    emit: (v) => ({ labels: v.labels || undefined }),
    read: (k) => ({ labels: k.labels ?? '' }),
    preselect: (ctx) => ({ features: ctx.lastSolid ? `[${JSON.stringify(ctx.lastSolid)}]` : '' }),
  },
  mirror: {
    kind: 'mirror', label: 'Mirror', prefix: 'mirror', icon: MirrorIcon,
    description: 'Mirror features across a plane or flat face.',
    fields: [
      { key: 'plane', label: 'Mirror plane', type: 'plane', positional: true, required: true, initial: '"YZ"' },
      { key: 'features', label: 'Features', type: 'features', required: true },
    ],
    preselect: (ctx) => ({ features: ctx.lastSolid ? `[${JSON.stringify(ctx.lastSolid)}]` : '', ...(ctx.faces.length === 1 ? { plane: JSON.stringify(ctx.faces[0]) } : {}) }),
  },
  move: {
    kind: 'move', label: 'Move/Copy', prefix: 'move', icon: MoveIcon,
    description: 'Move, rotate or copy bodies: drag the handles in the view or type exact values.',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies', positional: true, required: true, hint: 'Pick a body, or a face or edge of it.' },
      { key: 'tx', label: 'X distance', type: 'length', virtual: true, initial: '0' },
      { key: 'ty', label: 'Y distance', type: 'length', virtual: true, initial: '0' },
      { key: 'tz', label: 'Z distance', type: 'length', virtual: true, initial: '0' },
      { key: 'axis', label: 'Rotate about', type: 'axis', virtual: true, initial: '', omit: '', hint: 'X, Y or Z through the origin, an edge or a sketch line. Dragging a ring rotates about the bodies’ center.' },
      { key: 'angle', label: 'Angle', type: 'angle', virtual: true, initial: '0', when: (v) => !!v.axis, hint: 'Applied before the move.' },
      { key: 'copy', label: 'Create copy', type: 'boolean', virtual: true, initial: 'False', hint: 'Keep the originals and move new bodies.' },
    ],
    preselect: () => ({ bodies: list(selectedBodies()) }),
    emit: (v) => {
      const offset = [v.tx, v.ty, v.tz].map((s) => s?.trim() || '0');
      return {
        translate: offset.every((s) => Number(s) === 0) ? undefined : `(${offset.join(', ')})`,
        rotate: v.axis && v.angle?.trim() && Number(v.angle) !== 0 ? `(${v.axis}, ${v.angle.trim()})` : undefined,
        copy: v.copy === 'True' ? 'True' : undefined,
      };
    },
    read: (k) => {
      const [tx = '0', ty = '0', tz = '0'] = splitTuple(k.translate ?? '') ?? [];
      const [axis = '', angle = '0'] = splitTuple(k.rotate ?? '') ?? [];
      return { tx, ty, tz, axis, angle, copy: k.copy === 'True' ? 'True' : 'False' };
    },
  },
  plane: {
    kind: 'plane', label: 'Offset plane', prefix: 'plane', icon: OriginIcon,
    description: 'A construction plane offset from a plane or flat face.',
    fields: [
      { key: 'on', label: 'From', type: 'plane', required: true, initial: '"XY"' },
      { key: 'offset', label: 'Offset', type: 'length', initial: '10' },
      { key: 'angle', label: 'Tilt', type: 'angle', initial: '0', omit: '0' },
    ],
    preselect: (ctx) => (ctx.faces.length === 1 ? { on: JSON.stringify(ctx.faces[0]) } : {}),
  },
  box: {
    kind: 'box', label: 'Box', prefix: 'box', icon: BoxIcon, description: 'A box centered on a point.',
    fields: [
      { key: 'length', label: 'Length (X)', type: 'length', positional: true, required: true, initial: '40' },
      { key: 'width', label: 'Width (Y)', type: 'length', positional: true, required: true, initial: '30' },
      { key: 'height', label: 'Height (Z)', type: 'length', positional: true, required: true, initial: '20' },
      { key: 'at', label: 'Center', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)' },
      OP,
    ],
  },
  cylinder: {
    kind: 'cylinder', label: 'Cylinder', prefix: 'cylinder', icon: CylinderIcon, description: 'A cylinder standing on a point.',
    fields: [
      { key: 'radius', label: 'Radius', type: 'length', positional: true, required: true, initial: '10' },
      { key: 'height', label: 'Height', type: 'length', positional: true, required: true, initial: '20' },
      { key: 'at', label: 'Base center', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)' },
      { key: 'direction', label: 'Direction', type: 'vector', initial: '(0, 0, 1)', omit: '(0, 0, 1)' },
      OP,
    ],
  },
  sphere: {
    kind: 'sphere', label: 'Sphere', prefix: 'sphere', icon: SphereIcon, description: 'A sphere.',
    fields: [
      { key: 'radius', label: 'Radius', type: 'length', positional: true, required: true, initial: '10' },
      { key: 'at', label: 'Center', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)' },
      OP,
    ],
  },
  cone: {
    kind: 'cone', label: 'Cone', prefix: 'cone', icon: ConeIcon, description: 'A cone or truncated cone.',
    fields: [
      { key: 'radius1', label: 'Base radius', type: 'length', positional: true, required: true, initial: '10' },
      { key: 'radius2', label: 'Top radius', type: 'length', positional: true, required: true, initial: '0' },
      { key: 'height', label: 'Height', type: 'length', positional: true, required: true, initial: '20' },
      { key: 'at', label: 'Base center', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)' },
      OP,
    ],
  },
  torus: {
    kind: 'torus', label: 'Torus', prefix: 'torus', icon: TorusIcon, description: 'A torus.',
    fields: [
      { key: 'major_radius', label: 'Ring radius', type: 'length', positional: true, required: true, initial: '20' },
      { key: 'minor_radius', label: 'Tube radius', type: 'length', positional: true, required: true, initial: '4' },
      { key: 'at', label: 'Center', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)' },
      OP,
    ],
  },
  text: {
    kind: 'text', label: 'Text', prefix: 'text', icon: TextToolIcon, description: 'Raised or engraved text on a plane or face.',
    fields: [
      { key: 'text', label: 'Text', type: 'text', positional: true, required: true, initial: '"STEVE"' },
      { key: 'on', label: 'On', type: 'plane', initial: '"XY"' },
      { key: 'size', label: 'Size', type: 'length', initial: '10' },
      { key: 'depth', label: 'Depth', type: 'length', initial: '1' },
      { key: 'op', label: 'Operation', type: 'choice', initial: '"join"', omit: '"join"', options: [{ value: '"join"', label: 'Raised' }, { value: '"cut"', label: 'Engraved' }] },
    ],
    preselect: (ctx) => (ctx.faces.length === 1 ? { on: JSON.stringify(ctx.faces[0]) } : {}),
  },
  decal: {
    kind: 'decal', label: 'Decal', prefix: 'decal', icon: ImageIcon,
    description: 'Show an image (a logo, a label, markings) on a face, flat or curved, or across several faces. Appearance only: geometry and exports don’t change.',
    fields: [
      { key: 'image', label: 'Image', type: 'image', required: true },
      { key: 'on', label: 'Faces', type: 'faces', required: true, hint: 'One face or several of one body, flat or curved. On one flat face the image lies on it; otherwise it is projected onto the faces turned toward it.' },
      { key: 'width', label: 'Width', type: 'length', required: true, initial: '40' },
      { key: 'height', label: 'Height', type: 'length', initial: '', omit: '', hint: 'Empty keeps the image’s proportions.' },
      { key: 'at', label: 'Center', type: 'decal_center', initial: '', omit: '', hint: 'Flat face: X/Y in face coordinates, leave Z empty. Curved, wrapped or projected: X/Y/Z in part coordinates. Auto uses the face center.' },
      { key: 'rotation', label: 'Rotation', type: 'angle', initial: '0', omit: '0' },
      { key: 'wrap', label: 'Wrap around the surface', type: 'boolean', initial: 'False', omit: 'False', hint: 'Follows the surface like a sticker, for stripes and text running round a body.' },
      { key: 'direction', label: 'Direction', type: 'vector', initial: '', omit: '', hint: 'The side the image is projected from. Empty: straight onto the face at its center.' },
      { key: 'depth', label: 'Depth', type: 'length', initial: '', omit: '', when: (v) => v.wrap !== 'True', hint: 'How far in front of and behind its center a projected image reaches. Empty: half its larger side.' },
    ],
    preselect: (ctx) => (ctx.faces.length === 1 ? { on: JSON.stringify(ctx.faces[0]) } : ctx.faces.length ? { on: list(ctx.faces) } : {}),
  },
  ...SHEET_SPECS,
};

/**
 * Table pattern in a design's main.py: `design.pattern(<component>, points=table("<file>.csv"[, columns=(…)]), …)`,
 * written before `result = …`. The table is one of the design's .csv files (or imported here); values are Python
 * sources but for `table`, the file's name.
 */
export const DESIGN_TABLE_PATTERN: Field[] = [
  { key: 'component', label: 'Component', type: 'component', required: true, hint: 'A component or linked part that main.py imports.' },
  { key: 'table', label: 'Table', type: 'table', required: true, hint: 'One of the design’s tables: each row is one instance.' },
  { key: 'columns', label: 'Columns', type: 'text', initial: '', omit: '', hint: 'The header names to read, in order, like x, y or x, y, z. Empty reads every column.' },
  { key: 'polar', label: 'Polar (r, θ)', type: 'boolean', initial: 'False', omit: 'False', hint: 'Read each row as radius and angle (°), with an optional Z; each instance turns by its angle about Z.' },
  { key: 'at', label: 'Move pattern', type: 'vector', initial: '(0, 0, 0)', omit: '(0, 0, 0)', hint: 'Moves the whole pattern in the design (mm).' },
  { key: 'name', label: 'Name', type: 'text', initial: '', omit: '', hint: 'Instances are named <name>_1, <name>_2, …; empty uses the component’s id.' },
];

export { PLANES, AXES };
