/**
 * A saved setup's JSON as the setup and operation editors read and write it, without losing what they don't edit.
 *
 * Issue 1009: a CAM program written as code can name its fixtures by a Python name (`"fixtures": [JAW_FIXED]`), or take
 * them from another linked design (`body(vise, "jaw")`) placed by a frame. Reading such a setup into the editor threw
 * (no `geometry` to read), so its operations' editor never opened and their stock box never showed. Saving an operation
 * also rewrote every fixture as a body of the part with no frame, and dropped setup keys the editor doesn't know.
 */
type Rec = Record<string, unknown>;

/** A fixture as the editor lists it: `instance` and `body` say which body, `saved` is its JSON as it was read. */
export interface FixtureDraft { id: string; instance: string; body: string; saved?: Rec }

const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);

/** The editor's fixture for a saved fixture (any shape a program can hold). */
export function fixtureDraftOf(fixture: unknown, index: number): FixtureDraft {
  const saved = isRec(fixture) ? fixture : { $code: String(fixture) };
  const geometry = isRec(saved.geometry) ? saved.geometry : null;
  if (!geometry) {
    // Written in the code (a name the program defines): listed by that name, kept exactly as written.
    const name = typeof saved.$code === 'string' ? saved.$code : `fixture ${index + 1}`;
    return { id: typeof saved.id === 'string' ? saved.id : name, instance: 'in code', body: name, saved };
  }
  const link = typeof geometry.link === 'string' ? geometry.link : 'part';
  const path = Array.isArray(geometry.instances) ? geometry.instances.map(String) : [];
  // Another linked design's body (a vise, say) is named by its link, so it never matches a body of the part.
  const instance = link === 'part' ? path.join('/') || 'part' : [link, ...path].join('/');
  return { id: String(saved.id ?? `fixture_${index + 1}`), instance, body: String(geometry.body ?? ''), saved };
}

/** A fixture's JSON: as it was saved when it's one read from the program, else a body of the part picked here. */
export function fixtureJsonOf(fixture: FixtureDraft, instancesOf: (instance: string) => string[]): unknown {
  if (fixture.saved) return fixture.saved;
  return { id: fixture.id, geometry: { link: 'part', instances: instancesOf(fixture.instance), body: fixture.body, kind: 'body' } };
}

/** The setup keys the editors write: every other key of a saved setup (a model placement, say) stays as it was. */
const EDITED = ['id', 'name', 'process', 'machine', 'tooling', 'post', 'work_offset', 'material', 'machining_material', 'stock',
  'work_to_machine', 'fixtures', 'fixture_coverage', 'stock_inspection', 'output_resolution'];

/** `edited` (what the editor wrote) over what of `saved` it doesn't write; a placement keeps the axes it was saved with. */
export function mergedSetupJson(edited: Rec, saved: Rec | undefined): Rec {
  if (!saved) return edited;
  const kept = Object.fromEntries(Object.entries(saved).filter(([key]) => !EDITED.includes(key)));
  const placed = isRec(edited.work_to_machine) && isRec(saved.work_to_machine)
    ? { work_to_machine: { ...saved.work_to_machine, origin_mm: edited.work_to_machine.origin_mm } } : {};
  return { ...kept, ...edited, ...placed };
}
