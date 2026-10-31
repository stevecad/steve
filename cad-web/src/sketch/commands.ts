import { MousePointer2, Redo2, Trash2, Undo2, X } from 'lucide-react';
import type { AppState } from '@/state/store';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import {
  Arc3Icon, ArcCenterIcon, CenterRectIcon, Circle3Icon, CircleToolIcon, CoincidentIcon, CollinearIcon, ConcentricIcon, ConstructionIcon,
  DimensionIcon, EllipseToolIcon, EqualIcon, FinishSketchIcon, FixConstraintIcon, HorizontalIcon, LineToolIcon, MidpointIcon, ParallelIcon,
  PerpendicularIcon, PointToolIcon, PolygonToolIcon, ProjectToolIcon, RectToolIcon, SlotToolIcon, SplineToolIcon, SymmetricIcon, TangentIcon, TrimToolIcon, VerticalIcon,
} from '@/icons/cad';
import { cancelSketch, finishSketch } from './actions';
import { deleteSelection, redo, toggleConstruction, undo, type ToolId } from './session';
import { setTool } from './tools';
import { runConstraint, type ConstraintKind } from './constraintTool';

const sketching = (state: AppState) => (!!state.sketching && !state.sketching.choosing) || 'Open a sketch first.';
const hidden = (state: AppState) => !state.sketching;

const tool = (id: ToolId, label: string, icon: Command['icon'], description: string, key?: string, short?: string): Command => ({
  id: `sketch.${id}`, label, short, icon, category: 'Sketch', description, run: () => setTool(id), enabled: sketching, hidden,
  active: (state) => state.sketching?.tool === id, ...(key ? { shortcut: key.toUpperCase(), keys: [key] } : {}),
});

// A constraint applies at once to a selection that fits it, else becomes the active tool and asks for its picks
// (constraintTool.ts). Always available while sketching; active while it is the tool.
const constraint = (kind: ConstraintKind, label: string, icon: Command['icon'], description: string, key?: string): Command => ({
  id: `sketch.c.${kind}`, label, icon, category: 'Constrain', description, enabled: sketching, hidden,
  run: () => { void runConstraint(kind); }, active: (state) => state.sketching?.tool === `c.${kind}`,
  ...(key ? { shortcut: key.toUpperCase(), keys: [key] } : {}),
});

export const sketchCommands: Command[] = [
  tool('line', 'Line', LineToolIcon, 'Chain of lines. What it infers as you draw (coincident, horizontal/vertical, parallel, perpendicular, tangent, lined up with a point) is shown and added; Alt draws freely.', 'l'),
  tool('rect', 'Rectangle (two corners)', RectToolIcon, 'Axis-aligned rectangle from two opposite corners.', 'r', 'Rectangle'),
  tool('center_rect', 'Center rectangle', CenterRectIcon, 'Rectangle from its center and a corner.'),
  tool('circle', 'Circle (center, radius)', CircleToolIcon, 'Circle from its center and a point on it.', 'c', 'Circle'),
  tool('circle_3pt', 'Circle through 3 points', Circle3Icon, 'Circle through three points.'),
  tool('arc_3pt', 'Arc (3 points)', Arc3Icon, 'Arc from start and end through a third point; tangent when started at a line’s or arc’s end along it.', 'a', 'Arc'),
  tool('arc_center', 'Center arc', ArcCenterIcon, 'Arc from its center, start and end.'),
  tool('polygon', 'Polygon', PolygonToolIcon, 'Regular polygon from center and a corner.'),
  tool('slot', 'Slot', SlotToolIcon, 'Straight slot from two centers and a width.'),
  tool('ellipse', 'Ellipse', EllipseToolIcon, 'Ellipse from center, major axis and minor radius.'),
  tool('spline', 'Spline', SplineToolIcon, 'Smooth curve through control points.', 's'),
  tool('point', 'Point', PointToolIcon, 'Construction point, e.g. hole centers.'),
  tool('project', 'Project', ProjectToolIcon, 'Bring model edges, face outlines, vertices or another sketch’s curves into this sketch. They stay linked to their source.', 'p'),
  tool('trim', 'Trim', TrimToolIcon, 'Click the piece of a line, arc or circle to cut away, up to where it crosses other curves; the new end stays on the curve it met.', 't'),
  tool('dimension', 'Dimension', DimensionIcon, 'Smart dimension: lengths, distances, radii, diameters and angles. Values accept parameters.', 'd'),
  // Esc gets back here from any tool (App's sketch keys); the shortcut is shown, not bound twice.
  { id: 'sketch.select', label: 'Select', icon: MousePointer2, category: 'Sketch', shortcut: 'Esc', keysElsewhere: true, description: 'Pick points, curves, the origin or the axes; drag to move or reshape.', run: () => setTool('select'), enabled: sketching, hidden, active: (state) => state.sketching?.tool === 'select' },
  { id: 'sketch.construction', label: 'Construction', icon: ConstructionIcon, category: 'Sketch', shortcut: 'Q', keys: ['q'], description: 'Toggle construction geometry: reference lines that don’t form profiles.', run: toggleConstruction, enabled: sketching, hidden },
  constraint('coincident', 'Coincident', CoincidentIcon, 'Join two points, or put a point on a curve.'),
  constraint('horizontal', 'Horizontal', HorizontalIcon, 'Make lines (or two points) horizontal.', 'h'),
  constraint('vertical', 'Vertical', VerticalIcon, 'Make lines (or two points) vertical.', 'v'),
  constraint('parallel', 'Parallel', ParallelIcon, 'Make two lines parallel.'),
  constraint('perpendicular', 'Perpendicular', PerpendicularIcon, 'Make two lines perpendicular.'),
  constraint('tangent', 'Tangent', TangentIcon, 'Make two curves tangent.'),
  constraint('equal', 'Equal', EqualIcon, 'Equal lengths, or equal radii.', 'e'),
  constraint('symmetric', 'Symmetric', SymmetricIcon, 'Mirror two points about a line or point.'),
  constraint('midpoint', 'Midpoint', MidpointIcon, 'Put a point at a line’s midpoint.'),
  constraint('concentric', 'Concentric', ConcentricIcon, 'Share a center between circles or arcs.'),
  constraint('collinear', 'Collinear', CollinearIcon, 'Put two lines on one line.'),
  constraint('fix', 'Fix', FixConstraintIcon, 'Lock points where they are.', 'f'),
  { id: 'sketch.delete', label: 'Delete', icon: Trash2, category: 'Sketch', shortcut: 'Delete', keys: ['delete', 'backspace'], run: deleteSelection, enabled: (state) => (sketching(state) === true ? (state.sketching!.selection > 0 || 'Select geometry or constraints first.') : sketching(state)), hidden },
  { id: 'sketch.undo', label: 'Undo', icon: Undo2, category: 'Sketch', shortcut: 'Mod+Z', keys: ['mod+z'], run: undo, enabled: (state) => !!state.sketching?.undo || 'Nothing to undo.', hidden },
  { id: 'sketch.redo', label: 'Redo', icon: Redo2, category: 'Sketch', shortcut: 'Mod+Shift+Z', keys: ['mod+shift+z', 'mod+y'], run: redo, enabled: (state) => !!state.sketching?.redo || 'Nothing to redo.', hidden },
  { id: 'sketch.finish', label: 'Finish sketch', short: 'Finish', icon: FinishSketchIcon, category: 'Sketch', shortcut: 'Mod+Enter', keys: ['mod+enter'], description: 'Write the sketch into the design and regenerate.', run: () => { void finishSketch(); }, enabled: sketching, hidden },
  { id: 'sketch.cancel', label: 'Cancel sketch', short: 'Cancel', icon: X, category: 'Sketch', description: 'Leave without changing the design.', run: cancelSketch, enabled: sketching, hidden },
];

export const SKETCH_RIBBON: RibbonGroup[] = [
  { title: 'Select', priority: KEEP, items: ['sketch.select'] },
  { title: 'Draw', priority: KEEP, items: ['sketch.line', { menu: 'rect', label: 'Rectangle', icon: RectToolIcon, items: ['sketch.rect', 'sketch.center_rect'] },
    { menu: 'circle', label: 'Circle', icon: CircleToolIcon, items: ['sketch.circle', 'sketch.circle_3pt'] },
    { menu: 'arc', label: 'Arc', icon: Arc3Icon, items: ['sketch.arc_3pt', 'sketch.arc_center'] },
    'sketch.polygon', 'sketch.slot', 'sketch.ellipse', 'sketch.spline', 'sketch.point', 'sketch.project'] },
  { title: 'Constrain', priority: HIGH, items: ['sketch.dimension', 'sketch.c.coincident', 'sketch.c.horizontal', 'sketch.c.vertical', 'sketch.c.parallel', 'sketch.c.perpendicular',
    'sketch.c.tangent', 'sketch.c.equal', { menu: 'more', label: 'More', icon: SymmetricIcon, items: ['sketch.c.symmetric', 'sketch.c.midpoint', 'sketch.c.concentric', 'sketch.c.collinear', 'sketch.c.fix'] }] },
  { title: 'Edit', priority: MID, items: ['sketch.trim', 'sketch.construction', 'sketch.delete', 'sketch.undo', 'sketch.redo'] },
  { title: 'Sketch', priority: KEEP + 1, items: ['sketch.finish', 'sketch.cancel'] },
];
