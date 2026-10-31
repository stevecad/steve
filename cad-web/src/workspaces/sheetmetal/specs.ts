/**
 * The Sheet Metal tab's feature dialogs: one per runtime call in docs/SHEET_METAL.md, declared like
 * the Solid tools (modeling/specs.ts), so they preview live, write one call and edit back from the
 * timeline. The call that starts a sheet (base, roll, convert) carries its rules: typed values or a
 * named rule (`SheetMetalRule`, maybe from a gauge or bend table); later features follow them.
 */
import type { Context, FeatureSpec, Field, Values } from '@/modeling/specs';
import {
  BaseFlangeIcon, ContourFlangeIcon, ConvertSheetIcon, CornerIcon, EdgeFlangeIcon, FormToolIcon, HemIcon, JogIcon, RefoldIcon, ReliefIcon, RipIcon, RollIcon, SheetCutIcon,
  SketchedBendIcon, TabIcon, UnfoldIcon,
} from '@/icons/cad';
import { splitTuple } from '@/modeling/bodies';
import { bendOf, panelOf, rimOf } from './refs';

const quote = (text: string | null | undefined) => (text ? JSON.stringify(text) : '');
const rim = (ref: string) => rimOf(ref);
const panel = (ref: string) => panelOf(ref);
const RIM_HINT = 'Pick the edge of the sheet to bend from: its top or bottom edge, or the side face between them.';
const PANEL_HINT = 'Pick any face of the panel.';
/** The selected face's panel, else the sheet's base (the usual place for tabs, bends and reliefs). */
const selectedPanel = (ctx: Context) => quote(ctx.faces.map(panelOf).find(Boolean) ?? ctx.doc?.features.find((f) => f.kind === 'sheet_base' && f.id)?.id);
const byValues = (v: Values) => v.from !== 'rule';
/** The sheet's rules on the call that starts it: typed values, or a named rule (`rule=shop`) shared by several sheets. */
const rules = (radius = '1.5', radiusHint = 'Inside bend radius. About 1× thickness suits most steel and aluminium.'): Field[] => [
  { key: 'from', label: 'Rules', type: 'choice', virtual: true, initial: 'values', options: [{ value: 'values', label: 'Values' }, { value: 'rule', label: 'Named rule' }],
    hint: 'Type thickness, radius and K here, or use a named rule (with a gauge or bend table) declared in this file.' },
  { key: 'rule', label: 'Rule', type: 'rule', required: true, initial: '', when: (v) => v.from === 'rule' },
  { key: 'thickness', label: 'Thickness', type: 'length', required: true, initial: '1.5', when: byValues },
  { key: 'radius', label: 'Bend radius', type: 'length', required: true, initial: radius, hint: radiusHint, when: byValues },
  { key: 'k_factor', label: 'K-factor', type: 'number', required: true, initial: '0.44', when: byValues,
    hint: 'Where the neutral layer sits in a bend (0–1, usually 0.3–0.5); it sets the flat length. 0.44 is a common air-bending estimate: use your shop’s value.' },
  { key: 'source', label: 'Source', type: 'text', initial: '', omit: '', when: byValues,
    hint: 'Where these numbers come from (a shop chart, a test bend). It travels with the DXF; leave it empty if you don’t know.' },
];
const readRules = (k: Record<string, string>) => ({ from: k.rule ? 'rule' : 'values' });

/** The rim the selection names, for selection-first use (pick an edge, then click the tool). */
const selectedRim = (edges: string[], faces: string[]) => quote([...edges, ...faces].map(rimOf).find(Boolean));
const byLength = (v: Values) => v.extent !== 'up_to';
const more = (v: Values) => v.more === 'True';

/** Rip: what it opens. A planar slit, a bend separated into two bodies, or a circular tube's seam. */
const RIP_TARGET = (target: string) => (v: Values) => v.target === target;
const RIP_HINTS: Record<string, string> = {
  panel: PANEL_HINT, bend: 'Pick a bend’s curved face, or choose the bend in the list.', face: 'Pick the tube’s outside (or inside) cylindrical face.',
};
/** The tube's rules: as for a new sheet, but a rip records no source note. */
const tubeRules = rules('20', 'Inside radius of the tube; it must match the solid exactly.')
  .filter((field) => field.key !== 'source')
  .map((field) => ({ ...field, when: (v: Values) => v.target === 'tube' && (!field.when || field.when(v)) }));
/** An unused body name for the far side of a separated bend. */
const freeBody = (ctx: Context) => {
  const used = new Set((ctx.doc?.features ?? []).map((f) => f.id));
  let n = 1;
  while (used.has(`piece_${n}`)) n++;
  return `piece_${n}`;
};
/** The form tool to place first: the one declared last (usually the one just made). */
const lastTool = (ctx: Context) => ctx.doc?.sheet_forms?.filter((form) => form.editable !== false).at(-1)?.variable ?? '';

export const SHEET_SPECS: Record<string, FeatureSpec> = {
  sheet_base: {
    kind: 'sheet_base', label: 'Base flange', prefix: 'base', icon: BaseFlangeIcon, sheet: true,
    description: 'Make a flat sheet from a closed sketch. The sketch is the top face; material goes below it. This also sets the sheet’s rules every flange follows.',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true, hint: 'One closed outline; holes stay holes.' },
      ...rules(),
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch) }),
    read: readRules,
  },
  sheet_flange: {
    kind: 'sheet_flange', label: 'Edge flange', prefix: 'flange', icon: EdgeFlangeIcon, sheet: true, pick: rim, pickHint: RIM_HINT,
    description: 'Bend a wall up from a straight outer edge of the sheet.',
    fields: [
      { key: 'edge', label: 'Edge', type: 'edge', positional: true, required: true, hint: RIM_HINT },
      { key: 'extent', label: 'Ends', type: 'choice', virtual: true, initial: 'length', options: [{ value: 'length', label: 'At a length' }, { value: 'up_to', label: 'Up to a plane' }] },
      { key: 'length', label: 'Length', type: 'length', required: true, initial: '20', when: byLength },
      { key: 'length_reference', label: 'Measured to', type: 'choice', initial: '"tangent"', omit: '"tangent"', when: byLength,
        options: [{ value: '"tangent"', label: 'Tangent' }, { value: '"inner_sharp"', label: 'Inner sharp' }, { value: '"outer_sharp"', label: 'Outer sharp' }],
        hint: 'Tangent: the straight part after the bend. Outer sharp: to where the outside faces would meet, the way drawings dimension a flange.' },
      { key: 'up_to', label: 'Up to', type: 'plane', required: true, initial: '', omit: '', when: (v) => v.extent === 'up_to', hint: 'A plane, or a flat face the flange should reach.' },
      { key: 'end_offset', label: 'Offset', type: 'length', initial: '0', omit: '0', when: (v) => v.extent === 'up_to', hint: 'Stop short of (negative) or past (positive) the plane.' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '90', omit: '90', hint: 'Bend angle from flat; negative bends the other way.' },
      { key: 'position', label: 'Position', type: 'chips', initial: '"bend_outside"', omit: '"bend_outside"',
        options: [{ value: '"bend_outside"', label: 'Bend outside' }, { value: '"material_inside"', label: 'Material inside' }, { value: '"material_outside"', label: 'Material outside' }, { value: '"centered"', label: 'Centered' }],
        hint: 'Where the flange sits on the edge. Material inside keeps the part’s outside size; bend outside adds the bend beyond the edge.' },
      { key: 'more', label: 'More options', type: 'boolean', virtual: true, initial: 'False' },
      { key: 'radius', label: 'Bend radius', type: 'length', initial: '', omit: '', when: more, hint: 'Empty uses the sheet’s radius.' },
      { key: 'k_factor', label: 'K-factor', type: 'number', initial: '', omit: '', when: more, hint: 'Empty uses the sheet’s rule.' },
      { key: 'offset', label: 'Edge offset', type: 'length', initial: '0', omit: '0', when: more, hint: 'Moves the bend line outward (positive) or inward.' },
      { key: 'gap_start', label: 'Inset start', type: 'length', initial: '0', omit: '0', when: more, hint: 'Shortens the flange from the edge’s start.' },
      { key: 'gap_end', label: 'Inset end', type: 'length', initial: '0', omit: '0', when: more, hint: 'Shortens the flange from the edge’s end.' },
      { key: 'relief', label: 'Bend relief', type: 'choice', initial: '"none"', omit: '"none"', when: more,
        options: [{ value: '"none"', label: 'None' }, { value: '"rectangular"', label: 'Rectangular' }, { value: '"round"', label: 'Round' }],
        hint: 'Cuts beside an inset flange’s bend so the metal doesn’t tear.' },
      { key: 'relief_width', label: 'Relief width', type: 'length', initial: '', omit: '', when: (v) => more(v) && v.relief !== '"none"', hint: 'Empty uses the thickness.' },
      { key: 'relief_depth', label: 'Relief depth', type: 'length', initial: '', omit: '', when: (v) => more(v) && v.relief !== '"none"', hint: 'Empty uses the thickness; round relief needs at least half its width.' },
      { key: 'miter_gap', label: 'Miter gap', type: 'length', initial: '', omit: '', when: more,
        hint: 'For return lips meeting at a corner: trims both to a 45° seam with this gap. Add before flanging the lips.' },
    ],
    preselect: (ctx) => ({ edge: selectedRim(ctx.edges, ctx.faces) }),
    read: (k) => ({
      extent: k.up_to ? 'up_to' : 'length',
      length_reference: ({ '"inner"': '"inner_sharp"', '"outer"': '"outer_sharp"' } as Record<string, string>)[k.length_reference ?? ''] ?? k.length_reference ?? '"tangent"',
      more: ['radius', 'k_factor', 'offset', 'gap_start', 'gap_end', 'relief', 'miter_gap'].some((key) => key in k) ? 'True' : 'False',
    }),
  },
  sheet_corner: {
    kind: 'sheet_corner', label: 'Corner', prefix: 'corner', icon: CornerIcon, sheet: true, pick: panel, pickHint: 'Pick a face of each wall.',
    description: 'Close the corner between two 90° walls: the first stops a gap short, the second covers its end. Add corners before flanging those walls further.',
    fields: [
      { key: 'panels', label: 'Walls', type: 'faces', positional: true, required: true, hint: 'Pick the wall that stops short first, then the wall that covers the corner.' },
      { key: 'gap', label: 'Gap', type: 'length', required: true, initial: '0.5', hint: 'Clearance between the two walls at the seam.' },
      { key: 'relief_depth', label: 'Relief depth', type: 'length', initial: '', omit: '', hint: 'Bottom relief where the bends meet; empty uses the thickness.' },
    ],
    preselect: (ctx) => {
      const walls = [...new Set(ctx.faces.map(panelOf).filter(Boolean) as string[])].slice(0, 2);
      return { panels: walls.length ? `[${walls.map((w) => JSON.stringify(w)).join(', ')}]` : '' };
    },
  },
  sheet_contour: {
    kind: 'sheet_contour', label: 'Contour flange', prefix: 'contour', icon: ContourFlangeIcon, sheet: true, pick: rim, pickHint: RIM_HINT,
    description: 'Chain several walls off one edge in one step: an L, U, Z or hat section. Each segment is a straight length after a bend.',
    fields: [
      { key: 'edge', label: 'Edge', type: 'edge', positional: true, required: true, hint: RIM_HINT },
      { key: 'segments', label: 'Segments', type: 'segments', required: true, initial: '[{"length": 20, "angle": 90}, {"length": 15, "angle": -90}]', hint: 'Up to 32 walls, in order; negative angles bend the other way.' },
    ],
    preselect: (ctx) => ({ edge: selectedRim(ctx.edges, ctx.faces) }),
  },
  sheet_hem: {
    kind: 'sheet_hem', label: 'Hem', prefix: 'hem', icon: HemIcon, sheet: true, pick: rim, pickHint: RIM_HINT,
    description: 'Fold an edge back on itself (an open hem with a clear gap) to stiffen it and remove the sharp edge.',
    fields: [
      { key: 'edge', label: 'Edge', type: 'edge', positional: true, required: true, hint: RIM_HINT },
      { key: 'length', label: 'Length', type: 'length', required: true, initial: '6', hint: 'Straight length of the folded-back leg.' },
      { key: 'gap', label: 'Gap', type: 'length', required: true, initial: '1', hint: 'Clear distance between the two sheets.' },
      { key: 'direction', label: 'Fold', type: 'choice', initial: '"up"', omit: '"up"', options: [{ value: '"up"', label: 'Up' }, { value: '"down"', label: 'Down' }] },
    ],
    preselect: (ctx) => ({ edge: selectedRim(ctx.edges, ctx.faces) }),
  },
  sheet_jog: {
    kind: 'sheet_jog', label: 'Jog', prefix: 'jog', icon: JogIcon, sheet: true, pick: rim, pickHint: RIM_HINT,
    description: 'Extend an edge with two opposed bends: a step up or down to a parallel panel.',
    fields: [
      { key: 'edge', label: 'Edge', type: 'edge', positional: true, required: true, hint: RIM_HINT },
      { key: 'offset', label: 'Offset', type: 'length', required: true, initial: '10', hint: 'Height of the step; negative steps down.' },
      { key: 'length', label: 'Length', type: 'length', required: true, initial: '15', hint: 'Straight length of the panel after the step.' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '45', omit: '45', hint: 'Angle of the rise (1–90°).' },
      { key: 'radius', label: 'Bend radius', type: 'length', initial: '', omit: '', hint: 'Empty uses the sheet’s radius.' },
    ],
    preselect: (ctx) => ({ edge: selectedRim(ctx.edges, ctx.faces) }),
  },
  sheet_tab: {
    kind: 'sheet_tab', label: 'Tab', prefix: 'tab', icon: TabIcon, sheet: true, pick: panel, pickHint: PANEL_HINT,
    description: 'Cut a U around a rectangle in a panel and bend it out: a formed tab, in the flat pattern exactly.',
    fields: [
      { key: 'panel', label: 'Panel', type: 'face', required: true, hint: PANEL_HINT },
      { key: 'from', label: 'Hinge corner', type: 'point', virtual: true, initial: '(40, 30)', hint: 'In the panel’s own XY (for the base: its sketch’s coordinates). The bend runs along this corner’s Y.' },
      { key: 'to', label: 'Tip corner', type: 'point', virtual: true, initial: '(60, 60)', hint: 'The opposite corner; the tab reaches toward +Y.' },
      { key: 'gap', label: 'Clearance', type: 'length', required: true, initial: '1', hint: 'Gap cut around the tab’s sides and tip.' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '45', omit: '45' },
      { key: 'radius', label: 'Bend radius', type: 'length', initial: '', omit: '', hint: 'Empty uses the sheet’s radius.' },
    ],
    preselect: (ctx) => ({ panel: selectedPanel(ctx) }),
    emit: (v) => {
      const [x0 = '0', y0 = '0'] = splitTuple(v.from ?? '') ?? [];
      const [x1 = '0', y1 = '0'] = splitTuple(v.to ?? '') ?? [];
      return { bounds: `(${x0}, ${y0}, ${x1}, ${y1})` };
    },
    read: (k) => {
      const [x0 = '0', y0 = '0', x1 = '0', y1 = '0'] = splitTuple(k.bounds ?? '') ?? [];
      return { from: `(${x0}, ${y0})`, to: `(${x1}, ${y1})` };
    },
  },
  sheet_bend: {
    kind: 'sheet_bend', label: 'Sketched bend', prefix: 'bend', icon: SketchedBendIcon, sheet: true, pick: panel, pickHint: PANEL_HINT,
    description: 'Bend a flat panel along a line. The material left of the line (start → end) moves; the blank keeps its outline. Bend before adding flanges to that panel.',
    fields: [
      { key: 'panel', label: 'Panel', type: 'face', required: true, hint: PANEL_HINT },
      { key: 'start', label: 'Line start', type: 'point', required: true, initial: '(0, 0)', hint: 'In the panel’s own XY (for the base: its sketch’s coordinates).' },
      { key: 'end', label: 'Line end', type: 'point', required: true, initial: '(0, 10)' },
      { key: 'angle', label: 'Angle', type: 'angle', initial: '90', omit: '90', hint: 'Negative bends the other way.' },
      { key: 'radius', label: 'Bend radius', type: 'length', initial: '', omit: '', hint: 'Empty uses the sheet’s radius.' },
    ],
    preselect: (ctx) => ({ panel: selectedPanel(ctx) }),
  },
  sheet_relief: {
    kind: 'sheet_relief', label: 'Relief', prefix: 'relief', icon: ReliefIcon, sheet: true, pick: panel, pickHint: PANEL_HINT,
    description: 'Notch a panel with sketched shapes, open to its edge: corner and bend reliefs (round, rectangular or any outline).',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true, hint: 'A sketch on the panel; the shapes may run past its edge.' },
      { key: 'panel', label: 'Panel', type: 'face', required: true, hint: PANEL_HINT },
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch), panel: selectedPanel(ctx) }),
  },
  sheet_cut: {
    kind: 'sheet_cut', label: 'Sheet cut', prefix: 'cut', icon: SheetCutIcon, sheet: true, pick: panel, pickHint: 'Optional: pick a face to restrict the cut to one panel.',
    description: 'Cut a closed sketch through a panel. To cut across bends, unfold first and use a slot aligned with the bend line.',
    guidance: 'For a cut across bends, unfold first, leave Panel empty, and draw a rectangular slot aligned with the bend line.',
    fields: [
      { key: 'profile', label: 'Profile', type: 'sketch', positional: true, required: true, hint: 'A closed sketch on the sheet plane. Across a bend, the cut must have straight edges parallel or perpendicular to the bend line.' },
      { key: 'panel', label: 'Panel', type: 'face', initial: '', omit: '', hint: 'Leave empty for an unfolded cut across bends. Selecting a panel limits the cut to that panel.' },
    ],
    preselect: (ctx) => ({ profile: quote(ctx.lastSketch) }),
  },
  sheet_roll: {
    kind: 'sheet_roll', label: 'Rolled sheet', prefix: 'roll', icon: RollIcon, sheet: true,
    description: 'A new rolled sheet: an open cylinder (shroud, guard, sleeve) with an angular seam. Its axis runs along the plane’s X; it starts at the plane’s origin and curls toward the plane’s normal (away from it for a negative wrap).',
    fields: [
      { key: 'width', label: 'Width', type: 'length', required: true, initial: '40', hint: 'Along the cylinder’s axis.' },
      { key: 'angle', label: 'Wrap', type: 'angle', required: true, initial: '340', hint: 'Up to 359.9°; the rest is the open seam.' },
      ...rules('25', 'Inside radius of the roll.'),
      { key: 'on', label: 'Plane', type: 'plane', initial: '"XY"', omit: '"XY"' },
    ],
    read: readRules,
  },
  sheet_convert: {
    kind: 'sheet_convert', label: 'Convert to sheet metal', prefix: 'sheet', icon: ConvertSheetIcon, sheet: true,
    description: 'Make a flat, uniform-thickness solid (a plate, or an imported STEP) into a sheet you can flange. Pick its top face.',
    fields: [
      { key: 'face', label: 'Top face', type: 'face', required: true, hint: 'The plate’s large flat face; the material must be exactly this face extruded by the thickness.' },
      ...rules(),
    ],
    read: readRules,
    preselect: (ctx) => (ctx.faces.length === 1 ? { face: quote(ctx.faces[0]) } : {}),
  },
  sheet_rip: {
    kind: 'sheet_rip', label: 'Rip', prefix: 'rip', icon: RipIcon, sheet: true,
    pick: (ref, field) => (field === 'panel' ? panelOf(ref) : field === 'bend' ? bendOf(ref) : ref), pickHint: (field) => RIP_HINTS[field] ?? PANEL_HINT,
    description: 'Open the sheet with a dimensioned gap: slit a panel to its edge, separate a bend into two sheets, or open a round tube’s seam so it unfolds.',
    fields: [
      { key: 'target', label: 'Rip', type: 'choice', virtual: true, initial: 'slit',
        options: [{ value: 'slit', label: 'Slit a panel' }, { value: 'bend', label: 'Split a bend' }, { value: 'tube', label: 'Open a tube' }] },
      { key: 'gap', label: 'Gap', type: 'length', required: true, initial: '0.5',
        hint: 'A slit’s gap is measured across its line. At a bend or tube seam it is the chord between the inside edges, not an arc length.' },
      { key: 'panel', label: 'Panel', type: 'face', required: true, when: RIP_TARGET('slit'), hint: PANEL_HINT },
      { key: 'start', label: 'Line start', type: 'point', required: true, initial: '(0, 0)', when: RIP_TARGET('slit'),
        hint: 'In the panel’s own XY (for the base: its sketch’s coordinates). The line must reach the panel’s outer edge; it may start at a hole.' },
      { key: 'end', label: 'Line end', type: 'point', required: true, initial: '(0, 10)', when: RIP_TARGET('slit') },
      { key: 'side', label: 'Gap on', type: 'choice', initial: '"center"', omit: '"center"', when: RIP_TARGET('slit'),
        options: [{ value: '"center"', label: 'Center' }, { value: '"left"', label: 'Left' }, { value: '"right"', label: 'Right' }],
        hint: 'Which side of the line (start → end) loses material; Center splits it evenly.' },
      { key: 'bend', label: 'Bend', type: 'bend', required: true, when: RIP_TARGET('bend'), hint: RIP_HINTS.bend },
      { key: 'split_body', label: 'New body', type: 'text', required: true, initial: '', when: RIP_TARGET('bend'),
        hint: 'The far side becomes a separate sheet with this name, with its own flat pattern, DXF and bend table.' },
      { key: 'face', label: 'Tube face', type: 'face', required: true, when: RIP_TARGET('tube'),
        hint: 'A complete, uniform round tube: no holes, end caps, cones or uneven walls.' },
      ...tubeRules,
      { key: 'seam_angle', label: 'Seam at', type: 'angle', initial: '0', omit: '0', when: RIP_TARGET('tube'), hint: 'Around the tube’s axis, from its X direction; the gap is centered there.' },
    ],
    preselect: (ctx) => ({ panel: selectedPanel(ctx), split_body: quote(freeBody(ctx)), ...(ctx.faces.length === 1 && !panelOf(ctx.faces[0]) ? { face: quote(ctx.faces[0]), target: 'tube' } : {}) }),
    read: (k) => ({ target: k.bend ? 'bend' : k.face ? 'tube' : 'slit', ...readRules(k) }),
  },
  sheet_form: {
    kind: 'sheet_form', label: 'Form', prefix: 'form', icon: FormToolIcon, sheet: true, pick: panel, pickHint: PANEL_HINT,
    description: 'Press a form tool (lance, louver, emboss or dimple) into a flat panel. Place the same tool as often as you need; edit the tool once to change them all.',
    fields: [
      { key: 'tool', label: 'Tool', type: 'form_tool', positional: true, required: true, hint: 'A form tool declared in this file. Manage tools to add or change one.' },
      { key: 'panel', label: 'Panel', type: 'face', required: true, hint: PANEL_HINT },
      { key: 'at', label: 'Center', type: 'point', required: true, initial: '(0, 0)', hint: 'In the panel’s own XY (for the base: its sketch’s coordinates).' },
      { key: 'angle', label: 'Rotation', type: 'angle', initial: '0', omit: '0', hint: 'Turns the tool in the panel’s plane.' },
      { key: 'direction', label: 'Direction', type: 'choice', initial: '"up"', omit: '"up"', options: [{ value: '"up"', label: 'Up' }, { value: '"down"', label: 'Down' }],
        hint: 'Down presses the form through to the other side of the sheet.' },
      { key: 'clearance', label: 'Clearance', type: 'length', initial: '', omit: '',
        hint: 'Least distance from the tool’s whole footprint to holes, edges, bends and other forms. Empty uses the thickness.' },
    ],
    preselect: (ctx) => ({ tool: lastTool(ctx), panel: selectedPanel(ctx) }),
  },
  sheet_unfold: {
    kind: 'sheet_unfold', label: 'Unfold', prefix: 'unfold', icon: UnfoldIcon, sheet: true, pick: panel, pickHint: 'Pick a face of the panel that stays put.',
    description: 'Lay the sheet flat in the model so you can sketch and cut across it, then refold.',
    fields: [
      { key: 'fixed', label: 'Fixed panel', type: 'face', initial: '', omit: '', hint: 'The panel that stays where it is; empty keeps the base.' },
    ],
    preselect: (ctx) => ({ fixed: quote(ctx.faces.map(panelOf).find(Boolean)) }),
  },
  sheet_refold: {
    kind: 'sheet_refold', label: 'Refold', prefix: 'refold', icon: RefoldIcon, sheet: true,
    description: 'Fold the sheet back up after an unfold, keeping cuts made in the flat.',
    fields: [],
  },
};

/** The runtime calls that make or change a sheet-metal body. */
export const SHEET_KINDS = new Set(Object.keys(SHEET_SPECS));
