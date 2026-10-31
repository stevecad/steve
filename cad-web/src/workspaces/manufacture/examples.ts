/**
 * Example library records, created through the normal library API so pins and revisions are real:
 * - Codex's reference mill and tooling (examples/manufacturing/machine-library.json, tool-library.json);
 * - Codex's example LinuxCNC post (examples/manufacturing/linuxcnc_linear.post.js);
 * - STEVE's built-in milling posts (Siemens 808D in Siemens and ISO mode, Centroid CNC12, LinuxCNC), from the server exactly as it runs them.
 * Copies live beside this file because the web bundle can't read the repository's examples/ folder.
 * These are reference fixtures, not qualified physical equipment.
 */
import { library, mfg, pinOf, requestKey, type Kind, type LibraryRecord } from './api';
import type { RecordProvenance } from './provenance';
import mill from './examples/machine-library.json';
import tooling from './examples/tool-library.json';
import linuxcncPost from './examples/linuxcnc_linear.post.js?raw';

export type ExampleSet = 'mill' | 'post' | 'builtin';
export const EXAMPLE_SETS: { id: ExampleSet; label: string; description: string }[] = [
  { id: 'mill', label: 'Reference mill and tools', description: '3-axis mill with a LinuxCNC controller (stationary M6 tool changes) and a tool setup: T1 6 mm end mill, T2 8 mm end mill, T3 6 mm 118° drill, T4 6 mm 90° V-bit, T5 6 mm ball end mill, each in a BT30 holder. Ready to face, contour (with tabs), pocket (helical entry, rest machining), slot, bore, drill, engrave, chamfer and finish 3D surfaces (parallel, waterline). Plus a 6061-T6 material and an example cutting preset for T1 (estimates, not recommended cutting data).' },
  { id: 'post', label: 'LinuxCNC example post', description: 'A user-authored post for straight 3-axis motion (generated output, not verified).' },
  { id: 'builtin', label: 'Built-in posts', description: 'STEVE’s own milling posts for Siemens SINUMERIK 808D (Siemens mode and ISO mode), Centroid CNC12 and LinuxCNC, exactly as it runs them. Duplicate one to make your own: its output is still checked when it targets the same controller.' },
];

/** A definition without its null fields: the server fills those defaults (a null firmware version is stored as "unknown"). */
const withoutNulls = (definition: Record<string, unknown>) => Object.fromEntries(Object.entries(definition).filter(([, value]) => value !== null));

/** Whether every value `wanted` sets is in `actual` (the server fills defaults; arrays compare item by item). */
function covers(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length && wanted.every((item, index) => covers(actual[index], item));
  if (wanted && typeof wanted === 'object') return !!actual && typeof actual === 'object' && Object.entries(wanted).every(([key, value]) => covers((actual as Record<string, unknown>)[key], value));
  return actual === wanted || (typeof wanted === 'number' && typeof actual === 'number' && Math.abs(actual - wanted) < 1e-9);
}

/**
 * Reuses an unarchived record of the same kind and name that already has every value given (the server fills
 * defaults). An older copy of this example, matching all but the `upgrade` fields (added since: tool changes, more
 * tools), gets a new revision with them; anything else of that name is left alone and a new record is made.
 */
async function ensure(existing: LibraryRecord[], definition: Record<string, unknown>, upgrade: string[] = [], provenance?: RecordProvenance): Promise<LibraryRecord> {
  const named = existing.filter((record) => record.kind === definition.kind && record.definition.name === definition.name && !record.archived);
  const same = named.find((record) => covers(record.definition, definition));
  if (same) return same;
  const base = Object.fromEntries(Object.entries(definition).filter(([key]) => !upgrade.includes(key)));
  const older = upgrade.length ? named.find((record) => covers(record.definition, base)) : undefined;
  const saved = older
    ? await library.edit(older, { ...older.definition, ...definition }, false, requestKey(`example-${definition.kind as Kind}`))
    : await library.create(definition, requestKey(`example-${definition.kind as Kind}`), provenance);
  if (older) existing[existing.indexOf(older)] = saved; else existing.push(saved);
  return saved;
}

export async function importExamples(set: ExampleSet): Promise<LibraryRecord[]> {
  const existing = (await library.list()).items;
  const made: LibraryRecord[] = [];
  const add = async (definition: Record<string, unknown>, upgrade: string[] = [], provenance?: RecordProvenance) => {
    const record = await ensure(existing, definition, upgrade, provenance);
    made.push(record);
    return record;
  };
  if (set === 'mill') {
    const model = await add(mill.model);
    // Codex's runnable reference controller (docs/MANUFACTURING_EXAMPLES.md): LinuxCNC's linear dialect, a tool-length
    // offset table and stationary M6 tool changes at the model's tool-change pose. An older copy without tool changes
    // gets a new revision with them.
    const controller = await add(withoutNulls(mill.controller), ['tool_change']);
    const machine = await add({ kind: 'machine_instance', name: 'Reference LinuxCNC mill', model: pinOf(model), controller: pinOf(controller) }, ['controller']);
    const holder = await add(tooling.holder);
    const assembled = async (name: string, cutter: Record<string, unknown>, stickout: number) => add({
      kind: 'tool_assembly', name, dimension_source: 'measured', cutter: pinOf(await add(cutter)), holders: [{ id: 'holder', holder: pinOf(holder) }], stickout_mm: stickout,
    });
    // Gauge length = the holder's 30 mm + stickout; the tool table's length offsets are those gauge lengths.
    const endMill = await assembled('6 mm end-mill assembly', tooling.cutter, 28);
    const faceMill = await assembled('8 mm end-mill assembly', {
      ...tooling.cutter, name: '8 mm reference end mill', diameter_mm: 8, cutting_length_mm: 20, shank_diameter_mm: 8, neck_diameter_mm: 7, flute_count: 4,
    }, 30);
    const drill = await assembled('6 mm drill assembly', {
      ...tooling.cutter, name: '6 mm reference drill (118°)', cutter_type: 'drill', diameter_mm: 6, cutting_length_mm: 28, overall_length_mm: 60, shank_diameter_mm: 6,
      neck_length_mm: 2, neck_diameter_mm: 5, included_angle_rad: (118 * Math.PI) / 180, tip_diameter_mm: 0, flute_count: 2, material: 'hss', max_rpm: 6000,
    }, 38);
    // A sharp 90° V-bit (a centre-cutting chamfer mill) for trace engraving: 1 mm deep cuts a 2 mm wide groove.
    const vBit = await assembled('6 mm 90° V-bit assembly', withoutNulls({
      ...tooling.cutter, name: '6 mm 90° reference V-bit', cutter_type: 'chamfer_mill', diameter_mm: 6, cutting_length_mm: 10, overall_length_mm: 50, shank_diameter_mm: 6,
      neck_length_mm: 0, neck_diameter_mm: null, included_angle_rad: Math.PI / 2, tip_diameter_mm: 0, flute_count: 2,
    }), 25);
    // A 6 mm ball end mill (centre cutting) for parallel and waterline 3D finishing.
    const ball = await assembled('6 mm ball end-mill assembly', withoutNulls({ ...tooling.cutter, name: '6 mm reference ball end mill', cutter_type: 'ball_end_mill' }), 28);
    await add({ kind: 'tool_setup', name: 'Reference LinuxCNC mill tools', machine: pinOf(machine), assignments: [
      { id: 'T1', assembly: pinOf(endMill), spindle: 'main', tool_number: 1, offsets: { basis: 'gauge_length', length_register: 1, length_mm: 58, radius_mm: 3 } },
      { id: 'T2', assembly: pinOf(faceMill), spindle: 'main', tool_number: 2, offsets: { basis: 'gauge_length', length_register: 2, length_mm: 60, radius_mm: 4 } },
      { id: 'T3', assembly: pinOf(drill), spindle: 'main', tool_number: 3, offsets: { basis: 'gauge_length', length_register: 3, length_mm: 68 } },
      { id: 'T4', assembly: pinOf(vBit), spindle: 'main', tool_number: 4, offsets: { basis: 'gauge_length', length_register: 4, length_mm: 55 } },
      { id: 'T5', assembly: pinOf(ball), spindle: 'main', tool_number: 5, offsets: { basis: 'gauge_length', length_register: 5, length_mm: 58, radius_mm: 3 } },
    ] }, ['machine', 'assignments']);
    // Cutting data for T1 in 6061-T6, with the backend's own example limits (docs/MANUFACTURING_CUTTING_PRESETS.md).
    // They're fixture values, not recommended cutting data: marked as estimates, so the rate checks they enable report
    // "not assessed" rather than a pass.
    const aluminium = await add({ kind: 'machining_material', name: '6061-T6 aluminium (example)', condition: 'T6', design_material_id: 'aluminum-6061-t6',
      description: 'Example stock material for the reference presets.' });
    const estimate = { kind: 'estimate' as const, note: 'Example fixture value from the backend documentation, not recommended cutting data.' };
    await add({
      kind: 'cutting_preset', name: '6 mm end mill / 6061-T6 (example)', material: pinOf(aluminium), cutter: pinOf(await add(tooling.cutter)),
      operations: ['face', 'pocket', 'contour'], maximum_stickout_mm: 28, maximum_spindle_rpm: 8000, maximum_feed_per_tooth_mm: 0.04,
      description: 'Example limits for T1 in 6061-T6. Fixture values, not recommended cutting data: replace them with your tooling vendor’s data.',
    }, [], { fields: { maximum_stickout_mm: estimate, maximum_spindle_rpm: estimate, maximum_feed_per_tooth_mm: estimate }, notes: 'Example preset.' });
  } else if (set === 'builtin') {
    for (const post of await mfg<Record<string, unknown>[]>('/builtin-posts')) {
      await add(withoutNulls({ ...post, kind: 'post_processor', name: `${post.name as string} (built-in)`,
        description: `${(post.description as string) || 'STEVE’s built-in post.'} A copy of the post STEVE runs for this controller; duplicate it to make your own.` }));
    }
  } else {
    await add({
      kind: 'post_processor', name: 'LinuxCNC linear (example)', format: 'steve_javascript_v1', source: linuxcncPost,
      description: 'Explicit modal startup, offsets, optional sequence numbers, straight XYZ moves and a tool table. A reference profile, not a machine-qualified post.',
      processes: ['milling'], controller_dialects: ['linuxcnc_cartesian_linear_v1'], capabilities: ['cartesian_3axis_linear_v1'],
      properties: {
        sequence_numbers: { title: 'Sequence numbers', type: 'boolean', default: false },
        sequence_start: { title: 'First sequence number', type: 'integer', default: 10, minimum: 1 },
      },
    });
  }
  return [...new Map(made.map((record) => [record.id, record])).values()];
}
