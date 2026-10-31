/**
 * A run's checks as a person reads them: one verdict (can I use this program?), the few things to do (each
 * estimated library record once, each failed or uncertain check), and every check in plain words for the details.
 * Checks an estimate left "not assessed" collapse into that estimate; the checks only a prove-out on the machine can
 * pass are the verdict's standing sentence, not rows. Every verdict is the backend's; this only reads and words them.
 * No imports beyond types, so it runs outside a browser (tests/cam_check_summary_test.mjs).
 */
import type { InputEstimate } from './api';

export type Status = 'passed' | 'failed' | 'uncertain' | 'unassessed';

export const STATUS_RANK: Record<string, number> = { failed: 0, uncertain: 1, unassessed: 2, passed: 3 };
export const worst = (statuses: string[]) => statuses.reduce((a, b) => ((STATUS_RANK[b] ?? 4) < (STATUS_RANK[a] ?? 4) ? b : a), 'passed');

// ── Families ─────────────────────────────────────────────────────────────────

export type FamilyKey = 'machine' | 'part' | 'stock' | 'fixtures' | 'tool' | 'rates' | 'coverage' | 'program' | 'inputs' | 'completeness' | 'other';
export const FAMILIES: { key: FamilyKey; title: string; about: string; test: (id: string) => boolean }[] = [
  { key: 'machine', title: 'Machine', about: 'The machine’s own moving bodies against each other, the tools, the fixtures and the stock.', test: (id) => /^(sheet_)?machine_/.test(id) },
  { key: 'part', title: 'Finished part', about: 'The part against the design: material left or cut away beyond tolerance, gouges, and clearance to the finished surfaces.',
    test: (id) => /^stock_(excess|missing)_material$|^target_|_volume_clearance$|_floor_clearance$|_wall_clearance$|^program_pocket_clearance$|^remaining_stock_accuracy$|^contour_tab_/.test(id) },
  { key: 'stock', title: 'Stock contact', about: 'Rapids, holders and shanks against the stock, timed by when the cutter actually removes it.',
    test: (id) => /^rapid_in_stock$|^noncutting_stock$|stock_clearance$|^initial$|^stock_cell$/.test(id) },
  { key: 'fixtures', title: 'Fixtures', about: 'Every tool region against the pinned fixture solids.', test: (id) => id.startsWith('fixture') || id === 'clamping' },
  { key: 'rates', title: 'Feeds, speeds & removal', about: 'Posted spindle speed, feeds and surface speed, and the material removal rate, against the pinned limits.',
    test: (id) => /^cutting_(?!direction|geometry)|^tool_rpm$|^programmed_rates$|^geometric_|^rpm_data$/.test(id) },
  { key: 'tool', title: 'Tool & holder', about: 'The assembled tool, its cutting geometry and how it was measured.', test: (id) => /^tool_|^cutting_geometry_accuracy$|^insert_retention$|^seating_profile$|^interfaces$/.test(id) },
  { key: 'coverage', title: 'Toolpath coverage', about: 'Whether the posted moves actually cut what each operation selected.', test: (id) => id.endsWith('_coverage') },
  { key: 'program', title: 'Machine program', about: 'The posted file as the controller reads it: motion, offsets, travel and rates.',
    test: (id) => /^controller_|^posted_motion$|^offset_execution$|^non_cutting$|^cutting_direction$|^physical_qualification$/.test(id) },
  { key: 'inputs', title: 'Inputs', about: 'Library values the run used and where they came from.', test: (id) => /provenance$/.test(id) },
  { key: 'completeness', title: 'Program completeness', about: 'Whether every check the program needs ran, on complete inputs, for what each operation set out to do.',
    test: (id) => /^(milling|turning|sheet)_/.test(id) },
  { key: 'other', title: 'Other checks', about: '', test: () => true },
];
export const familyOf = (id: string): FamilyKey => FAMILIES.find((family) => family.test(id))!.key;

/** Plain words for every check the engine reports (manufacturing/verification_coverage.py's required checks and the
 * ones it names inside messages); anything new reads from its ID until it has words here. */
export const CHECK_WORDS: Record<string, string> = {
  // Milling.
  milling_verification_context: 'Run context recorded', milling_declared_inputs: 'Every input declared', milling_operation_intent: 'Each operation does what it was set to',
  milling_numerical_completion: 'Every numerical check ran', milling_stock_accuracy: 'Stock model exact enough', milling_machine_scope: 'Machine within what Steve can check',
  milling_tool_assignment: 'Every operation has its tool', milling_physical_cutting: 'Forces, chatter and wear (prove out on the machine)',
  machine_initial_state: 'Machine starts as declared (prove out on the machine)', physical_qualification: 'Proved out on the machine',
  controller_semantics: 'Controller reads the program as intended', controller_gauge_travel: 'Tool stays within the machine’s travel',
  controller_rates: 'Feeds and rapids within the machine’s limits', controller_retract: 'Retracts clear before each move', controller_limits: 'Machine travel limits',
  machine_self_collision: 'Machine bodies clear each other', machine_geometry_coverage: 'Machine bodies modelled',
  machine_tool_collision: 'Machine clears the tools', machine_fixture_collision: 'Machine clears the fixtures', machine_stock_collision: 'Machine clears the stock',
  stock_excess_material: 'No material left beyond the allowed excess', stock_missing_material: 'Nothing cut past the allowed undercut',
  target_gouge: 'Cutter stays off the finished part', target_noncutting_clearance: 'Holder and shank clear the finished part',
  cutting_preset_coverage: 'Cutting data for every tool', cutting_spindle_rpm: 'Spindle speed', cutting_feed_per_tooth_mm: 'Feed per tooth',
  cutting_feed_per_revolution_mm: 'Feed per revolution', cutting_nominal_surface_speed_m_min: 'Surface speed', geometric_removal_rate: 'Material removal rate',
  geometric_axial_engagement: 'Depth of cut', geometric_radial_engagement: 'Width of cut',
  fixture_collision: 'Tools clear the fixtures', fixture_coverage: 'Every fixture modelled',
  rapid_in_stock: 'No rapids through stock', noncutting_stock: 'Holder and shank clear the stock', initial_stock_clearance: 'Tool starts clear of the stock',
  tool_change_stock_clearance: 'Tool changes clear the stock', program_pocket_clearance: 'Pocket walls and floors kept',
  remaining_stock_accuracy: 'Remaining stock exact enough', tool_rpm: 'Spindle speed within the tool’s limit', tool_assembly: 'Tool assembly',
  tool_reference_travel: 'Tool length within the machine’s travel', programmed_rates: 'Programmed feeds and speeds', rpm_data: 'Spindle speed data',
  mass_data: 'Tool mass data', machine_mass: 'Tool mass within the machine’s limit',
  input_provenance: 'Library inputs', dimension_provenance: 'Measured dimensions',
  // Named inside the engine's messages.
  stock_inspection: 'Finished-part inspection', cutting_binding: 'Cutting data', engagement: 'Cutter engagement',
  // Turning.
  turning_verification_context: 'Run context recorded', turning_declared_inputs: 'Every input declared', turning_controller_output: 'Controller reads the program as intended',
  turning_operation_intent: 'Each operation does what it was set to', turning_tooling_scope: 'Tools within what Steve can check', turning_numerical_completion: 'Every numerical check ran',
  turning_material_accuracy: 'Finished part within tolerance', turning_source_evidence: 'Source evidence recorded',
  turning_physical_conditions: 'Clamping, chips and forces (prove out on the machine)',
  turning_cutting_preset_coverage: 'Cutting data for every tool', turning_cutting_spindle_rpm: 'Spindle speed', turning_cutting_feed_per_revolution_mm: 'Feed per revolution',
  turning_cutting_programmed_surface_speed_m_min: 'Surface speed',
  // Sheet cutting.
  sheet_verification_context: 'Run context recorded', sheet_controller_semantics: 'Controller reads the program as intended', sheet_declared_inputs: 'Every input declared',
  sheet_numerical_completion: 'Every numerical check ran', sheet_output_identity: 'Output matches the program', sheet_output_cycles: 'Cutting cycles in the output',
  sheet_output_path: 'Cut paths in the output', sheet_output_process: 'Process settings in the output', sheet_output_traverse: 'Traverses in the output',
  sheet_source_identity: 'Sheet matches the design', sheet_placement: 'Parts placed on the sheet', sheet_contour_inventory: 'Every contour found',
  sheet_cut_order: 'Contours cut in a safe order', sheet_traverse: 'Traverses clear the parts', sheet_kerf_clearance: 'Kerf clears the neighbouring parts',
  sheet_pierce_clearance: 'Pierces clear the parts', sheet_contour_coverage: 'Every contour cut through', sheet_retention: 'Parts held until cut free',
  sheet_remnant: 'Remnant of the sheet', sheet_machine_geometry: 'Machine bodies modelled', sheet_machine_self_collision: 'Machine bodies clear each other',
  sheet_fixture_coverage: 'Every fixture modelled', sheet_machine_fixture_collision: 'Machine clears the fixtures', sheet_machine_stock_collision: 'Machine clears the sheet',
  sheet_process_volume: 'Cutting head within its working space', sheet_process_fixture_collision: 'Cutting head clears the fixtures',
  sheet_physical_process: 'Cut quality (prove out on the machine)', sheet_io_qualification: 'Machine interlocks (prove out on the machine)',
  sheet_detached_material: 'Released parts and slugs (prove out on the machine)',
};
export const checkWords = (id: string) => CHECK_WORDS[id] ?? id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** What the backend puts before a check an estimated library input left "not assessed" (manufacturing/provenance_checks.py). */
export const ESTIMATE_LEAD = 'Computed using estimated library inputs; confirm the values before treating this check as passed. ';

/** A check's message without the estimate lead-in (said once, as the estimate's own item) and with the engine's check
 * IDs inside it in plain words ("Missing: stock_inspection" → "Missing: finished-part inspection"). */
export const plainMessage = (message: string) => message.replace(ESTIMATE_LEAD, '')
  .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (id) => (CHECK_WORDS[id] ? CHECK_WORDS[id].charAt(0).toLowerCase() + CHECK_WORDS[id].slice(1) : id)).trim();

/** The checks no software run can pass: a prove-out on the machine (verification_coverage.py's physical checks). */
export const PHYSICAL_CHECKS = new Set(['machine_initial_state', 'physical_qualification', 'milling_physical_cutting', 'turning_physical_conditions',
  'sheet_physical_process', 'sheet_io_qualification', 'sheet_detached_material']);
/** Checks that only gather the others (not assessed whenever any of them is): the details have them, the summary doesn't. */
const GATHERING = /^(milling|turning|sheet)_(verification_context|declared_inputs|numerical_completion)$/;

// ── Summary ──────────────────────────────────────────────────────────────────

export interface SummaryCheck { id: string; status: string; message: string; operation?: string | null; setup?: string | null }
type Estimate = Pick<InputEstimate, 'field' | 'origin' | 'affected_checks' | 'all_checks'> & { library: { id: string; kind: string; revision: number } };
/** One estimated library record: its estimated fields, or `whole` when the record's dimensions are declared estimated. */
export interface EstimatedRecord { library: { id: string; kind: string; revision: number }; fields: string[]; whole: boolean }

export interface CheckSummary {
  s: Status;
  /** Can I use this program? One line. */
  verdict: string;
  /** What to do about it, when there's one thing to say. */
  next: string | null;
  /** Each estimated library record once (several fields of one record are one item). */
  estimates: EstimatedRecord[];
  /** Checks left "not assessed" only by an estimate (they collapse into the estimates). */
  estimated: number;
  /** Failed, then uncertain checks: each is its own item. */
  attention: SummaryCheck[];
  /** Checks not assessed for another reason (one item for all of them). */
  unassessed: SummaryCheck[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `checks`: a run's checks (or the backend's list of those that didn't pass); `estimates`: its estimated library
 * inputs; `download`: the backend's download status (failed checks block it, `software_verified` when every check passed).
 */
export function summarize(checks: SummaryCheck[], estimates: Estimate[] | null | undefined, download: string | undefined): CheckSummary {
  const inputs = estimates ?? [];
  const byEstimate = (check: SummaryCheck) => check.status === 'unassessed'
    && (check.id === 'input_provenance' || check.message.startsWith(ESTIMATE_LEAD) || inputs.some((item) => item.all_checks || item.affected_checks.includes(check.id)));
  const records = new Map<string, EstimatedRecord>();
  for (const item of inputs) {
    const record = records.get(item.library.id) ?? { library: item.library, fields: [], whole: false };
    if (item.origin === 'dimension_source') record.whole = true;
    else if (!record.fields.includes(item.field)) record.fields.push(item.field);
    records.set(item.library.id, record);
  }
  const attention = checks.filter((check) => check.status === 'failed' || check.status === 'uncertain')
    .sort((a, b) => (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4));
  const estimated = checks.filter(byEstimate).length;
  const unassessed = checks.filter((check) => check.status === 'unassessed' && !byEstimate(check) && !PHYSICAL_CHECKS.has(check.id) && !GATHERING.test(check.id));
  const failed = attention.filter((check) => check.status === 'failed').length;
  const uncertain = attention.length - failed;
  const base = { estimates: [...records.values()], estimated, attention, unassessed };
  if (failed || download === 'blocked_failed_checks') {
    return { ...base, s: 'failed', verdict: `Failed: ${failed ? `${plural(failed, 'check', 'checks')} failed` : 'a check failed'}`, next: 'Fix what failed and run it again: until then it doesn’t download.' };
  }
  if (download === 'software_verified') return { ...base, s: 'passed', verdict: 'Posted and checked: safe to prove out on the machine', next: null };
  if (records.size) return { ...base, s: 'unassessed', verdict: `Not verified: ${plural(records.size, 'input is', 'inputs are')} estimated`, next: 'Confirm the values, then run it again.' };
  if (estimated) return { ...base, s: 'unassessed', verdict: 'Not verified: some inputs are estimated', next: 'Confirm them in the Library, then run it again.' };
  if (uncertain) return { ...base, s: 'uncertain', verdict: `Not verified: ${plural(uncertain, 'check is', 'checks are')} uncertain`, next: null };
  if (unassessed.length) return { ...base, s: 'unassessed', verdict: `Not verified: ${plural(unassessed.length, 'check', 'checks')} couldn’t be assessed`, next: null };
  return { ...base, s: 'unassessed', verdict: 'Not verified: not every check could be assessed', next: null };
}
