/**
 * The milling program editor, a right-dock tool like Fusion's setup and operation dialogs. Setup: machine, the tools
 * loaded in it, post, work offset, where program zero sits on the machine, box stock and fixture bodies. Operation
 * (2D pocket with plunge, ramp or helical entry, rest machining, face, 2D contour with retention tabs, drill, peck drill or
 * circular bore): tool, geometry, heights, passes, the drilling cycle or the bore, feeds and the stock-check resolution. Saving writes a program revision; the server checks everything again and its errors land
 * on the field they name.
 */
import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Crosshair, Info, Plus, Trash2, X } from 'lucide-react';
import { Button, NumberField, Segmented, Select, Section } from '@/ui';
import { set as setApp, useApp } from '@/state/store';
import { BoreIcon, ContourIcon, RoughIcon, DrillOpIcon, ChamferOpIcon, EngraveIcon, FaceMillIcon, ParallelFinishIcon, PocketIcon, RestIcon, SetupIcon, SlotIcon, WaterlineIcon } from '@/icons/cad';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import CopyMessage from '@/shell/CopyMessage';
import { openLibrary, useMfg } from '../state';
import { pinOf, type LibraryRecord, type Pin } from '../api';
import PresetPicker from '../presets/PresetPicker';
import { presetOf } from '../presets/feeds';
import {
  bodyBounds, bodyHoles, bodyLabel, contourChain, TRANSFER_LABEL, type TransferPreset, cutterOf, displayedBodies, facedTop, isDrilling, isPocketing, isSurface, OP_LABEL, opLabelLower, patternable, patternSeed, patternSeedNamed, picksFor, previousOperation, tabAngleAt, takesHoles,
  travel, upwardFloors, INSPECTION_DEFAULTS, type CuttingResolution, type OperationDraft, type OpKind, type ProgramDraft, type SetupDraft, type SlotGuideDraft, type TabDraft, type Vec3,
} from './program';
import {
  chamferEdgeZ, chooseAssignment, chooseSetup, closeEditor, entryModes, geometryChanged, setTransfer, loadEngines, loadMachine, loadTooling, NATIVE_FAMILY, patternKinds, placeOnMachine, refreshStock, resolveConflict, runOperation, saveProgram, setupChoices,
  roughStart, savedPathCurves, setTarget, startPicking, stopPicking, suits, tabsSupported, updateDraft, updateEngrave, useCam, useGeometryVersion,
} from './state';
import { chamferFits, chamferOffset, chamferSlope, coneHeight, engraveWidth, pathsLength, type ConicalCutter } from './engrave';
import { horizontalSketches } from './sketchCurves';
import { activeInstances, instancesOf, newPattern, PATTERN_LABEL, patternProblem, switchPattern, type PatternDraft, type PatternKind, type PlacementDraft } from './pattern';
import { usePreview } from './preview';
import { aboveThePart, roughProblems, type RoughProblem } from './rough';
import { soleChoice } from './setupChoice';
import { shopKey, shopOf } from './camDoc';
import { useShop } from '../shop/state';
import styles from './Cam.module.css';

const BUILT_IN = '__built_in__';
const NO_ERRORS: Record<string, string> = {};
const NONE = '__none__';
const wcsLabel = (n: number) => (n <= 6 ? `G${53 + n}` : n <= 9 ? `G59.${n - 6}` : `WCS ${n}`);
const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();

function Row({ label, sub, error, children, field, stack }: { label: string; sub?: string; error?: boolean; children: React.ReactNode; field?: string; stack?: boolean }) {
  return (
    <div className={styles.row} data-error={error || undefined} data-field={field} data-stack={stack || undefined}>
      <span>{label}{sub && <small>{sub}</small>}</span>
      <div>{children}</div>
    </div>
  );
}

function FieldError({ field }: { field: string }) {
  const message = useCam((state) => state.editor?.errors[field]);
  const ref = useRef<HTMLDivElement>(null);
  // A failure's Fix or Edit lands here: bring the message into view.
  useEffect(() => { if (message) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [message]);
  if (!message) return null;
  return <div ref={ref} className={styles.error} role="alert" data-field-error={field}><AlertTriangle size={13} /><span>{message}</span><CopyMessage text={message} /></div>;
}

function Vector({ value, onChange, labels = ['X', 'Y', 'Z'], ariaLabel }: { value: Vec3; onChange: (value: Vec3) => void; labels?: string[]; ariaLabel: string }) {
  return (
    <div className={styles.triple}>
      {value.map((component, axis) => (
        <NumberField key={axis} value={component} prefix={labels[axis]} prefixColor={['var(--axis-x)', 'var(--axis-y)', 'var(--axis-z)'][axis]} ariaLabel={`${ariaLabel} ${labels[axis]}`}
          onChange={(next) => { const out = [...value] as Vec3; out[axis] = next; onChange(out); }} />
      ))}
    </div>
  );
}

const recordsOf = (records: LibraryRecord[], kind: string, keep: (record: LibraryRecord) => boolean = () => true) =>
  records.filter((record) => record.kind === kind && !record.archived && keep(record)).sort((a, b) => a.definition.name.localeCompare(b.definition.name));

/** A library choice that keeps the pinned revision unless the person picks again (then the record's head). */
function RecordChoice({ value, records, onChange, ariaLabel, none, extra = [], hint }: {
  value: Pin | null; records: LibraryRecord[]; onChange: (record: LibraryRecord | null, special?: string) => void; ariaLabel: string; none?: string; extra?: { value: string; label: string }[];
  /** What each option says beside its name (its revision when not given). */
  hint?: (record: LibraryRecord) => string;
}) {
  const all = useMfg((state) => state.records);
  const head = value ? all.find((record) => record.id === value.id) : null;
  const options: { value: string; label: string; hint?: string }[] = [
    ...(none ? [{ value: NONE, label: none }] : []),
    ...extra,
    ...records.map((record) => ({ value: record.id, label: record.definition.name, hint: hint ? hint(record) : `r${record.revision}` })),
  ];
  if (value && !records.some((record) => record.id === value.id)) options.push({ value: value.id, label: head?.definition.name ?? 'Pinned record', hint: `r${value.revision}` });
  return (
    <>
      <Select ariaLabel={ariaLabel} value={value?.id ?? (extra[0]?.value ?? NONE)} options={options}
        onChange={(id) => { if (id === NONE || extra.some((item) => item.value === id)) onChange(null, id); else onChange(all.find((record) => record.id === id) ?? null); }} />
      {value && head && head.revision > value.revision && (
        <span className={styles.hint} data-tone="warn">Pinned r{value.revision}; r{head.revision} is newer. <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => onChange(head)}>Use r{head.revision}</button></span>
      )}
    </>
  );
}

// ── Setup ────────────────────────────────────────────────────────────────

function SetupTab({ draft }: { draft: ProgramDraft }) {
  const setup = draft.setup;
  const records = useMfg((state) => state.records);
  const machine = useCam((state) => state.machine);
  const picking = useCam((state) => state.picking);
  const errors = useCam((state) => state.editor?.errors ?? NO_ERRORS);
  const patch = (change: Partial<SetupDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, setup: { ...d.setup, ...change } }), clear);
  const controller = machine?.controller.definition as { name?: string; dialect?: string; work_offsets?: number[]; tool_length_compensation?: string } | undefined;
  const model = machine?.model.definition as { name?: string; processes?: string[] } | undefined;
  const limits = travel(machine);
  // Milling machines only (printers and lathes have their own processes).
  const milling = new Set(records.filter((record) => record.kind === 'machine_model' && (record.definition.processes as string[] | undefined)?.includes('milling')).map((record) => record.id));
  // A CAM program picks from its shop: the machines and tool setups that shop has.
  const editedId = useCam((state) => state.editor?.programId ?? null);
  const camShop = useMfg((state) => { const edited = state.programs.find((item) => item.id === editedId); return edited?.cam ? shopOf(edited) ?? '' : null; });
  useShop((state) => state.holders);
  const inShop = (record: LibraryRecord) => camShop === null || shopKey(camShop, record.id) !== null;
  const machines = recordsOf(records, 'machine_instance', (record) => milling.has((record.definition.model as Pin | undefined)?.id ?? '') && inShop(record));
  // Any tool setup on any machine: the tools are checked against the machine when the program saves.
  const toolSetups = recordsOf(records, 'tool_setup', inShop);
  const posts = recordsOf(records, 'post_processor', (record) => {
    const definition = record.definition as { processes?: string[]; controller_dialects?: string[] };
    return !!definition.processes?.includes('milling') && (!controller?.dialect || !!definition.controller_dialects?.includes(controller.dialect));
  });
  const builtInPosts = useCam((state) => state.builtInPosts);
  const builtIn = controller?.dialect ? builtInPosts[controller.dialect] : undefined;
  // No built-in post and exactly one in the library fits this controller: that's the post.
  const onlyPost = !builtIn && posts.length === 1 ? posts[0] : null;
  useEffect(() => {
    if (onlyPost && !setup.post) patch({ post: { id: onlyPost.id, revision: onlyPost.revision, kind: onlyPost.kind, sha256: onlyPost.sha256 }, postProperties: {} }, ['post']);
  }, [onlyPost?.id, onlyPost?.revision, !!setup.post]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = setup.stockMax.map((value, axis) => value - setup.stockMin[axis]);
  const programId = useCam((state) => state.editor?.programId ?? null);
  const record = useMfg((state) => state.programs.find((item) => item.id === programId));
  // Each machine with its controller, and whether Steve posts for it (a built-in post reads its G-code).
  const controllerOf = (machineRecord: LibraryRecord) => records.find((item) => item.id === (machineRecord.definition.controller as Pin | undefined)?.id)?.definition as { name?: string; dialect?: string } | undefined;
  const machineHint = (machineRecord: LibraryRecord) => {
    const fitted = controllerOf(machineRecord);
    return fitted ? `${fitted.name ?? ''}${fitted.dialect && !builtInPosts[fitted.dialect] ? ' · saved only' : ''}` : '';
  };
  // Pick a machine, pick a tool setup, done: a new setup takes the only machine and the only tool setup there are.
  const isNew = !record || !(record.compiled.setups as { id?: string }[]).some((item) => item.id === setup.id);
  const picked = useRef<string | null>(null);
  useEffect(() => {
    if (!isNew || picked.current === setup.id || !machines.length) return;
    picked.current = setup.id;
    const machineId = setup.machine ? null : soleChoice(machines);
    const toolsId = setup.tooling ? null : soleChoice(toolSetups);
    const only = (id: string | null) => records.find((item) => item.id === id);
    const machine = only(machineId);
    const tools = only(toolsId);
    if (!machine && !tools) return;
    patch({ ...(machine ? { machine: pinOf(machine), post: null } : {}), ...(tools ? { tooling: pinOf(tools) } : {}) }, ['machine', 'tooling']);
    if (machine) void loadMachine();
    if (tools) void loadTooling();
  }, [isNew, setup.id, machines.length, toolSetups.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // The post is a choice only when there is one to make: otherwise it's the built-in post, or the only one that fits.
  const choosePost = !!errors.post || (!!controller && (builtIn ? posts.length > 0 : posts.length > 1 || (!!setup.post && !onlyPost)));
  const postName = setup.post ? records.find((item) => item.id === setup.post!.id)?.definition.name : builtIn;
  const transfer = setup.transfer;
  const source = transfer && record ? (record.compiled.operations as { id?: string; name?: string; setup?: string }[]).find((op) => op.id === transfer.from) : null;
  const sourceSetup = source && record ? (record.compiled.setups as { id?: string; name?: string }[]).find((item) => item.id === (source.setup ?? 'setup')) : null;
  return (
    <>
      <div className={styles.row} style={{ margin: '8px 12px 0' }}>
        <span>Name</span>
        <input className={styles.text} aria-label="Setup name" value={setup.name} onChange={(event) => patch({ name: event.target.value })} />
      </div>
      {transfer && (
        <Section title="Turned over" id="cam-setup-identity">
          {transfer && (
            <>
              <p className={styles.note} id="cam-transfer-source">
                Continues from <b>{source?.name ?? transfer.from}</b>{sourceSetup ? <> in <b>{sourceSetup.name}</b></> : null}: the part is unclamped, turned and clamped again.
                This setup starts on the stock that operation actually leaves, moved into this setup’s coordinates.
              </p>
              <Row label="The part" sub="how it’s turned" field="stock" error={!!errors.stock}>
                <Segmented size="sm" value={transfer.preset === 'custom' ? 'flip_x' : transfer.preset} onChange={(preset) => setTransfer(preset as TransferPreset)}
                  options={[{ value: 'flip_x', label: 'Flip over X' }, { value: 'flip_y', label: 'Flip over Y' }, { value: 'turn_z', label: 'Turn 90°' }, { value: 'same', label: 'As it was' }]} />
              </Row>
              {transfer.preset === 'custom' && <p className={styles.hint} data-tone="warn">This setup uses a custom transfer frame; choosing a turn here replaces it.</p>}
              <p className={styles.hint}>{TRANSFER_LABEL[transfer.preset]}, in place: the turned stock keeps the box it filled, so program zero and the stock’s spot on the table can stay. The viewport shows the part as it’s now clamped.</p>
            </>
          )}
        </Section>
      )}
      <Section title="Machine" id="cam-machine">
        <FieldError field="machine" />
        <Row label="Machine" field="machine" error={!!errors.machine}>
          <RecordChoice ariaLabel="Machine" value={setup.machine} records={machines} none="Choose a machine…" hint={machineHint}
            onChange={(record) => { patch({ machine: record ? pinOf(record) : null, post: null }, ['machine', 'tooling']); void loadMachine(); }} />
        </Row>
        {!machines.length && <p className={styles.note}>No machines in your shop yet. <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => openLibrary('catalogue')}>Add yours from Steve’s catalogue</button>.</p>}
        {machine && (
          <div className={styles.spec} id="cam-machine-spec">
            <span><b>{model?.name}</b></span>
            <span>{controller?.name}{controller?.dialect && !builtInPosts[controller.dialect] ? ' · saved only' : ''}{!choosePost && postName ? ` · posts with ${postName}` : ''}</span>
            {limits && <span>Travel X {num(limits.min[0], 1)}…{num(limits.max[0], 1)} · Y {num(limits.min[1], 1)}…{num(limits.max[1], 1)} · Z {num(limits.min[2], 1)}…{num(limits.max[2], 1)} mm</span>}
          </div>
        )}
        <FieldError field="tooling" />
        <Row label="Tools loaded" sub="Tool setup" field="tooling" error={!!errors.tooling}>
          <RecordChoice ariaLabel="Tool setup" value={setup.tooling} records={toolSetups} none="Choose a tool setup…" hint={(item) => `${(item.definition.assignments as unknown[] | undefined)?.length ?? 0} tools`}
            onChange={(record) => { patch({ tooling: record ? pinOf(record) : null }, ['tooling', 'tool']); void loadTooling(); }} />
        </Row>
        {!toolSetups.length && <p className={styles.note}>No tool setups yet. <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => openLibrary('shop')}>Open your shop</button> to add your tools.</p>}
        <FieldError field="post" />
        {choosePost && (
          <Row label="Post" field="post" error={!!errors.post}>
            <RecordChoice ariaLabel="Post processor" value={setup.post} records={posts} extra={builtIn ? [{ value: BUILT_IN, label: builtIn }] : []} none={builtIn ? undefined : 'Choose a post…'}
              onChange={(record) => patch({ post: record ? pinOf(record) : null, postProperties: {} }, ['post'])} />
          </Row>
        )}
        {controller && !builtIn && !posts.length && (
          <p className={styles.hint} data-tone="warn" id="cam-no-post">
            {controller.name ?? 'This controller'} is saved only: plan and simulate here; posting waits until Steve supports its G-code.{' '}
            <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => openLibrary('shop')}>Change the controller in your shop</button>
            {' '}or{' '}
            <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => openLibrary('post_processor')}>add a post</button>.
          </p>
        )}
      </Section>

      <Section title="Work coordinates" id="cam-placement">
        <FieldError field="placement" />
        <p className={styles.note}>{transfer
          ? <>Program zero is this setup’s origin: the design origin of the setup before, turned with the part (the stock fills the same box). Place it by translation.</>
          : <>Program zero is the <b>design origin</b> (X0 Y0 Z0, axes as modelled). Rotated machine axes aren’t run by this engine; place the part by translation.</>}</p>
        <Row label="Work offset">
          <Select ariaLabel="Work offset" value={String(setup.workOffset)} onChange={(value) => patch({ workOffset: Number(value) }, ['placement'])}
            options={(controller?.work_offsets?.length ? controller.work_offsets : [1, 2, 3, 4, 5, 6]).map((n) => ({ value: String(n), label: wcsLabel(n) }))} />
        </Row>
        <Row label="Zero on the machine" sub="machine coordinates, mm" field="placement" error={!!errors.placement} stack>
          <Vector ariaLabel="Work origin" value={setup.origin} onChange={(origin) => patch({ origin, placedByRun: false }, ['placement'])} />
        </Row>
        {setup.placedByRun && <p className={styles.note} id="cam-placed-by-run">Placed at the middle of the machine’s travel when the program runs; type a value to set your own.</p>}
        <div className={styles.quick}>{limits && <button type="button" id="cam-place" onClick={placeOnMachine}>Centre the stock in the travel</button>}</div>
      </Section>

      <Section title="Stock" id="cam-stock">
        <FieldError field="stock" />
        {transfer ? (
          <p className={styles.note}>The stock <b>{source?.name ?? transfer.from}</b> leaves, as the engine tracked it, moved with the turn: a quarter or half turn keeps every cell exactly; the engine checks the transfer and the setup’s heights against it.</p>
        ) : <>
        <Row label="Box">
          <Segmented size="sm" value={setup.stockMode} onChange={(stockMode) => { patch({ stockMode }); if (stockMode === 'auto') refreshStock(); }}
            options={[{ value: 'auto', label: 'From the part' }, { value: 'manual', label: 'Fixed size' }]} />
        </Row>
        {setup.stockMode === 'auto' ? (
          <>
            <Row label="Margins" sub="sides · top · bottom">
              <div className={styles.triple}>
                {(['side', 'top', 'bottom'] as const).map((key) => (
                  <NumberField key={key} value={setup.margins[key]} min={0} ariaLabel={`Stock ${key} margin`} onChange={(value) => { patch({ margins: { ...setup.margins, [key]: value } }); refreshStock(); }} />
                ))}
              </div>
            </Row>
          </>
        ) : (
          <>
            <Row label="Minimum" sub="work coordinates, mm" stack><Vector ariaLabel="Stock minimum" value={setup.stockMin} onChange={(stockMin) => patch({ stockMin }, ['stock'])} /></Row>
            <Row label="Maximum" sub="work coordinates, mm" stack><Vector ariaLabel="Stock maximum" value={setup.stockMax} onChange={(stockMax) => patch({ stockMax }, ['stock'])} /></Row>
          </>
        )}
        </>}
        <p className={styles.note} id="cam-stock-size">{num(size[0], 2)} × {num(size[1], 2)} × {num(size[2], 2)} mm · top at Z {num(setup.stockMax[2])}</p>
      </Section>

      <Section title="Fixtures" id="cam-fixtures">
        <FieldError field="fixtures" />
        <p className={styles.note}>Vise jaws, clamps or plates modelled as bodies in this design. The checks sweep the tool against them.</p>
        <div className={styles.refs}>
          {setup.fixtures.map((fixture) => (
            <div key={fixture.id} className={styles.ref} data-fixture={fixture.id}>
              <span>{bodyLabel(fixture)}</span>
              <button type="button" className={styles.iconBtn} aria-label={`Remove ${fixture.body}`} onClick={() => patch({ fixtures: setup.fixtures.filter((item) => item !== fixture) }, ['fixtures'])}><Trash2 size={12} /></button>
            </div>
          ))}
          <Button size="sm" variant={picking === 'fixtures' ? 'primary' : 'secondary'} icon={<Crosshair />} id="cam-pick-fixtures" onClick={() => startPicking('fixtures')}>
            {picking === 'fixtures' ? 'Done picking fixtures' : setup.fixtures.length ? 'Pick more fixture bodies' : 'Pick fixture bodies'}
          </Button>
        </div>
        <Row label="These are">
          <Segmented size="sm" value={setup.fixtureCoverage} onChange={(fixtureCoverage) => patch({ fixtureCoverage }, ['fixtures'])}
            options={[{ value: 'complete', label: 'All the fixtures' }, { value: 'missing', label: 'Not all modelled' }]} />
        </Row>
        <p className={styles.hint}>{setup.fixtureCoverage === 'complete' ? (setup.fixtures.length ? 'Nothing else holds the part.' : 'Nothing holds the part that the tool could reach.') : 'The fixture check stays open: something holding the part isn’t modelled.'}</p>
      </Section>

      <InspectionSection setup={setup} patch={patch} />

      <Section title="Material" id="cam-material" defaultOpen={!!setup.material || !!setup.machiningMaterial}>
        <FieldError field="material" />
        <Row label="Stock" sub="Library material" field="material">
          <RecordChoice ariaLabel="Machining material" value={setup.machiningMaterial} records={recordsOf(records, 'machining_material')} none="Not from the library"
            onChange={(record) => patch({ machiningMaterial: record ? pinOf(record) : null, ...(record && !setup.material.trim() ? { material: record.definition.name } : {}) }, ['material', 'feeds'])} />
        </Row>
        <input className={styles.text} aria-label="Stock material" placeholder="e.g. 6061-T6 aluminium" value={setup.material} onChange={(event) => patch({ material: event.target.value })} />
        <p className={styles.hint}>{setup.machiningMaterial ? 'Cutting presets for this material can check every feed move. The text is the label on setup sheets.' : 'A label for setup sheets. Choosing a cutting preset for an operation picks the library material for you.'}</p>
      </Section>
    </>
  );
}

/**
 * Finished-part inspection: after the setup's last operation the engine compares the stock it actually leaves with the
 * chosen design bodies. Material standing proud of the first band, or cut below the second, fails; what it can't
 * resolve stays uncertain. The bodies default to the part's own (not the fixtures').
 */
function InspectionSection({ setup, patch }: { setup: SetupDraft; patch: (change: Partial<SetupDraft>, clear?: string[]) => void }) {
  const version = useGeometryVersion();
  const bodies = useMemo(() => displayedBodies().filter((body) => !setup.fixtures.some((fixture) => fixture.instance === body.instance && fixture.body === body.body)),
    [version, setup.fixtures]); // eslint-disable-line react-hooks/exhaustive-deps
  const inspection = setup.inspection;
  const same = (a: { instance: string; body: string }, b: { instance: string; body: string }) => a.instance === b.instance && a.body === b.body;
  const listed = inspection ? [...bodies, ...inspection.bodies.filter((body) => !bodies.some((item) => same(item, body)))] : bodies;
  return (
    <Section title="Finished part" id="cam-inspection" defaultOpen={!!inspection}>
      <FieldError field="inspection" />
      <Row label="Inspect">
        <Segmented size="sm" value={inspection ? 'on' : 'off'} onChange={(value) => patch({ inspection: value === 'on' ? { bodies, ...INSPECTION_DEFAULTS } : null }, ['inspection'])}
          options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'Against the design' }]} />
      </Row>
      {inspection ? <>
        <div className={styles.refs} id="cam-inspection-bodies">
          {listed.map((body) => {
            const on = inspection.bodies.some((item) => same(item, body));
            return (
              <label key={`${body.instance}/${body.body}`} className={styles.ref} data-body={body.body} data-on={on || undefined}>
                <input type="checkbox" checked={on} onChange={() => patch({ inspection: { ...inspection, bodies: on ? inspection.bodies.filter((item) => !same(item, body)) : [...inspection.bodies, body] } }, ['inspection'])} />
                <span>{bodyLabel(body)}</span>
              </label>
            );
          })}
        </div>
        <Row label="Leftover allowed" sub="mm proud of the design"><NumberField ariaLabel="Leftover allowed" value={inspection.excess} min={0.001} step={0.01} onChange={(excess) => patch({ inspection: { ...inspection, excess } }, ['inspection'])} /></Row>
        <Row label="Undercut allowed" sub="mm into the design"><NumberField ariaLabel="Undercut allowed" value={inspection.missing} min={0.001} step={0.01} onChange={(missing) => patch({ inspection: { ...inspection, missing } }, ['inspection'])} /></Row>
        <p className={styles.hint}>After this setup’s last operation, the stock it actually leaves is compared with these bodies. Include anything meant to stay, such as tabs. The result shows on the part, amber where material is left and red where too much was cut.</p>
      </> : <p className={styles.hint}>Compare the finished stock with the design: leftover material and undercuts beyond the allowances fail the run.</p>}
    </Section>
  );
}

// ── Operation ────────────────────────────────────────────────────────────

const KIND_ICON: Record<OpKind, typeof PocketIcon> = { rough: RoughIcon, pocket: PocketIcon, rest: RestIcon, slot: SlotIcon, face: FaceMillIcon, contour: ContourIcon, drill: DrillOpIcon, peck_drill: DrillOpIcon, bore: BoreIcon, engrave: EngraveIcon, chamfer: ChamferOpIcon, parallel: ParallelFinishIcon, waterline: WaterlineIcon };
export const opIcon = (kind: OpKind, size = 16) => { const Icon = KIND_ICON[kind]; return <Icon size={size} />; };

function ToolSection({ op, draft }: { op: OperationDraft; draft: ProgramDraft }) {
  const tooling = useCam((state) => state.tooling);
  const errors = useCam((state) => state.editor?.errors ?? NO_ERRORS);
  const cutter = cutterOf(tooling, op.assignment);
  const assignments = tooling?.setup.definition.assignments ?? [];
  const fitting = assignments.filter((item) => suits(op.kind, cutterOf(tooling, item.id)));
  const others = assignments.length - fitting.length;
  const drilling = isDrilling(op.kind);
  const engraving = op.kind === 'engrave' || op.kind === 'chamfer';
  const surface = isSurface(op.kind);
  // What this operation's engine cuts with, in words.
  const shape = drilling ? 'a drill' : engraving ? 'a chamfer mill (V-bit)' : surface ? 'a ball end mill' : 'a flat end mill';
  return (
    <Section title="Tool" id="cam-tool">
      <FieldError field="tool" />
      <Row label={drilling ? 'Drill' : 'Tool'} field="tool" error={!!errors.tool}>
        <Select ariaLabel="Tool" value={op.assignment ?? NONE} onChange={(id) => { if (id !== NONE) chooseAssignment(id); }}
          options={[{ value: NONE, label: draft.setup.tooling ? (drilling ? 'Choose a drill…' : 'Choose a tool…') : 'Choose the tools loaded (Setup)' },
            ...[...fitting, ...(op.assignment && !fitting.some((item) => item.id === op.assignment) ? assignments.filter((item) => item.id === op.assignment) : [])].map((item) => {
              const info = cutterOf(tooling, item.id);
              return { value: item.id, label: `T${item.tool_number} · ${info?.name ?? item.id}`, hint: info ? `Ø${num(info.diameter, 2)}` : undefined };
            })]} />
      </Row>
      {tooling && others > 0 && <p className={styles.hint}>{others} tool{others === 1 ? '' : 's'} in this setup {others === 1 ? 'isn’t' : 'aren’t'} {shape} and {others === 1 ? 'isn’t' : 'aren’t'} listed.</p>}
      {tooling && !fitting.length && <p className={styles.hint} data-tone="warn">No {shape.replace(/^an? /, '')} in this tool setup. <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => openLibrary('tool_setup')}>Add one in the library</button>.</p>}
      {cutter && (
        <div className={styles.spec} id="cam-tool-spec">
          <span><b>Ø{num(cutter.diameter, 3)} mm</b> {cutter.type.replace(/_/g, ' ')}{surface ? ` · ball radius ${num(cutter.diameter / 2, 3)}` : ''}</span>
          {(drilling || engraving) && cutter.pointAngleDeg && <span>{engraving ? 'Included' : 'Point'} {num(cutter.pointAngleDeg, 1)}°{engraving ? (cutter.tipDiameter ? ` · tip Ø${num(cutter.tipDiameter, 3)}` : ' · sharp tip') : cutter.tipDiameter ? ` · tip Ø${num(cutter.tipDiameter, 2)}` : ''}</span>}
          <span>Flutes {num(cutter.cuttingLength, 2)} mm</span>
          <span>Stickout {num(cutter.stickout, 2)}</span>
          <span>Gauge {num(cutter.gauge, 2)}</span>
          <span>T{cutter.toolNumber}{cutter.lengthRegister ? ` · H${cutter.lengthRegister}` : ''}</span>
          <span>Length offset {cutter.lengthOffset !== null ? `${num(cutter.lengthOffset, 3)} mm` : `gauge (${num(cutter.gauge, 3)} mm)`}{cutter.lengthWear ? ` ${cutter.lengthWear > 0 ? '+' : ''}${num(cutter.lengthWear, 3)} wear` : ''}</span>
        </div>
      )}
      {cutter?.partBacked && <PartCutting cutting={cutter.cutting} />}
      {cutter && (!suits(op.kind, cutter) || !cutter.centerCutting || (cutter.partBacked && cutter.cutting?.status !== 'bounded')) && (
        <p className={styles.hint} data-tone="warn">{drilling ? 'This engine drills with a centre-cutting drill' : engraving ? `This engine ${op.kind === 'chamfer' ? 'chamfers' : 'engraves'} with a centre-cutting chamfer mill (a V-bit)` : surface ? 'This engine finishes 3D surfaces with a centre-cutting ball end mill' : 'This engine cuts with a centre-cutting flat end mill'}{cutter.partBacked && cutter.cutting?.status !== 'bounded' ? '; a cutter modelled from a part needs its cutting shape proven first (resolve it again in the library)' : ''}.</p>
      )}
    </Section>
  );
}

/** Where the engine's preview of the saved operation stands, in words (it's drawn in violet). */
function EnginePreviewNote({ op }: { op: OperationDraft }) {
  const preview = usePreview((state) => state.preview);
  if (!preview || preview.operation !== op.id || preview.status === 'unavailable') return null;
  const result = preview.result;
  let text: string;
  if (preview.status === 'loading') text = `Asking the engine for its preview of revision ${preview.revision}…`;
  else if (preview.status === 'failed' || !result) text = `The engine couldn’t preview revision ${preview.revision}: ${preview.message ?? 'no result'}`;
  else if (op.kind === 'slot') {
    const widths = [...new Set(result.slots.map((slot) => num(slot.width_mm, 3)))];
    text = result.representation === 'cad_slot_floors'
      ? (result.slots.length ? `The engine finds ${result.slots.length} slot floor${result.slots.length === 1 ? '' : 's'} in the part (${widths.join(', ')} mm wide), drawn in violet.` : 'The engine finds no rounded slot floor in this selection.')
      : `${result.slots.length} centreline${result.slots.length === 1 ? '' : 's'} as saved, drawn in violet.`;
  } else if (op.kind === 'parallel') {
    const touching = result.rows.filter((row) => row.has_proposed_contact).length;
    text = `${result.rows.length} rows, ${touching} reaching the part (drawn in violet; contact heights are proposals the run checks).`;
  } else {
    const loops = result.levels.reduce((sum, level) => sum + level.loops.length, 0);
    text = `${result.levels.length} levels, ${loops} loop${loops === 1 ? '' : 's'} around the part (drawn in violet; proposals the run checks).`;
  }
  return <p className={styles.hint} id="cam-engine-preview" data-status={preview.status} data-tone={preview.status === 'failed' ? 'warn' : undefined}>
    {preview.status === 'ready' && <b>Engine preview · revision {preview.revision}. </b>}{text}
  </p>;
}

/** A cutter modelled from a part: the cutting shape its tool-geometry job proved, and how far the real part may differ. */
function PartCutting({ cutting }: { cutting: CuttingResolution | null }) {
  if (!cutting) return <p className={styles.hint} data-tone="warn" id="cam-part-cutting" data-status="none">Modelled from a part resolved before cutting shapes were proven: it collides as its outline but can’t cut. Resolve it again in the library and pick the new result in its assembly.</p>;
  if (cutting.status !== 'bounded' || !cutting.bounds) return <p className={styles.hint} data-tone="warn" id="cam-part-cutting" data-status="unassessed">The part’s cutting shape isn’t proven: {cutting.message ?? cutting.code}.</p>;
  const { nominal, relative_error: error, maximum_deviation_mm: deviation } = cutting.bounds;
  const shape = nominal.shape === 'ball' ? 'ball' : nominal.shape === 'cone' ? 'cone' : 'flat';
  return (
    <p className={styles.hint} id="cam-part-cutting" data-status="bounded" data-deviation={deviation}>
      Cutting shape from the part: <b>{shape} Ø{num(nominal.radius_mm * 2, 3)}</b>, {num(nominal.height_mm, 2)} mm of flutes, within <b>±{num(deviation, 4)} mm</b> ({num(error * 100, 3)}%).
      Material it may only graze stays uncertain; checks use the larger shape for clearance and the smaller for what’s removed.
    </p>
  );
}

function BodyRow({ op }: { op: OperationDraft }) {
  const version = useGeometryVersion();
  const errors = useCam((state) => state.editor?.errors ?? NO_ERRORS);
  const bodies = useMemo(() => displayedBodies(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Row label="Part" field="geometry" error={!!errors.geometry}>
      <Select ariaLabel="Part body" value={op.target ? `${op.target.instance}\u0000${op.target.body}` : NONE}
        onChange={(value) => { if (value === NONE) return; const [instance, body] = value.split('\u0000'); setTarget({ instance, body }, null); }}
        options={[{ value: NONE, label: 'Choose the part…' }, ...bodies.map((body) => ({ value: `${body.instance}\u0000${body.body}`, label: bodyLabel(body) }))]} />
    </Row>
  );
}

function PocketGeometry({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const floors = useMemo(() => (op.target ? upwardFloors(op.target) : []), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const bodyTop = useMemo(() => (op.target ? bodyBounds(op.target)?.max.z ?? Infinity : Infinity), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const levels = [...new Set(floors.map((floor) => Number(floor.z.toFixed(6))))].filter((z) => z < Math.min(op.top, bodyTop) - 1e-6);
  const atBottom = floors.filter((floor) => Math.abs(floor.z - op.bottom) < 1e-6);
  return (
    <Section title="Geometry" id="cam-geometry">
      <FieldError field="geometry" />
      <BodyRow op={op} />
      <Row label="Floor">
        <div className={styles.ref} data-empty={!op.floor || undefined} data-picking={picking === 'floor' || undefined} id="cam-floor">
          <span>{picking === 'floor' ? 'Click the pocket floor in the viewport…' : op.floor ? `Face at Z ${num(op.floor.z)}${op.floor.area ? ` · ${num(op.floor.area, 1)} mm²` : ''}` : 'Auto: the one flat floor at the bottom height'}</span>
          {op.floor && <button type="button" className={styles.iconBtn} aria-label="Use auto floor" onClick={() => patch({ floor: null }, ['geometry'])}><X size={12} /></button>}
          <button type="button" className={styles.iconBtn} id="cam-pick-floor" aria-label="Pick the floor face" title="Pick the floor face" onClick={() => startPicking('floor')}><Crosshair size={13} /></button>
        </div>
      </Row>
      {!op.floor && op.target && (
        <p className={styles.hint} data-tone={atBottom.length === 1 ? undefined : 'warn'} id="cam-floor-hint">
          {atBottom.length === 1 ? `One upward floor at Z ${num(op.bottom)}: auto will use it.` : atBottom.length > 1 ? `${atBottom.length} upward faces at Z ${num(op.bottom)}: pick the one to clear.` : `No upward face at Z ${num(op.bottom)}.${levels.length ? ` Floors at ${levels.map((z) => num(z)).join(', ')}.` : ''}`}
        </p>
      )}
      <p className={styles.hint}>The pocket is cleared straight down to the floor; anything overhanging it stops the job with a clear error.</p>
    </Section>
  );
}

function FaceGeometry({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  return (
    <Section title="Geometry" id="cam-geometry">
      <FieldError field="geometry" />
      <BodyRow op={op} />
      <Row label="Finished face">
        <div className={styles.ref} data-empty={!op.floor || undefined} data-picking={picking === 'floor' || undefined} id="cam-face-top">
          <span>{picking === 'floor' ? 'Click the part’s top face in the viewport…' : op.floor ? `Face at Z ${num(op.floor.z)}` : `Auto: the part’s top at Z ${num(op.bottom)}`}</span>
          {op.floor && <button type="button" className={styles.iconBtn} aria-label="Use the part's top" onClick={() => patch({ floor: null }, ['geometry'])}><X size={12} /></button>}
          <button type="button" className={styles.iconBtn} id="cam-pick-face" aria-label="Pick the finished face" title="Pick the finished face" onClick={() => startPicking('floor')}><Crosshair size={13} /></button>
        </div>
      </Row>
      <p className={styles.hint}>Facing cuts the <b>whole stock</b> down to this height; the face sets the height, not an outline. Nothing of the part may rise above it.</p>
    </Section>
  );
}

function DrillGeometry({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const picking = useCam((state) => state.picking);
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const found = useMemo(() => (op.target ? bodyHoles(op.target) : []), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const bore = op.kind === 'bore';
  // A drill must be the hole's size; a bore's cutter must fit inside it (the engine decides, with its guards).
  const fits = (radius: number) => !!cutter && (bore ? cutter.diameter / 2 + op.radialAllowance < radius : Math.abs(cutter.diameter / 2 + op.radialAllowance - radius) <= Math.max(op.tolerance, 1e-6));
  // A picked bore may also be the cutter's size, plunged like a counterbore (over by at most the bore tolerance).
  const fitsPicked = (radius: number) => fits(radius) || (bore && !!cutter && Math.abs(cutter.diameter / 2 + op.radialAllowance - radius) <= op.boreTolerance);
  const sizes = new Map<string, { radius: number; count: number }>();
  for (const hole of found) { const key = num(hole.radius * 2, 3); sizes.set(key, { radius: hole.radius, count: (sizes.get(key)?.count ?? 0) + 1 }); }
  const matching = found.filter((hole) => fits(hole.radius)).length;
  return (
    <Section title={bore ? 'Bores' : 'Holes'} id="cam-geometry">
      <FieldError field="geometry" />
      <BodyRow op={op} />
      <Row label={bore ? 'Bores' : 'Holes'}>
        <div className={styles.ref} data-empty={!op.holes.length || undefined} data-picking={picking === 'holes' || undefined} id="cam-holes">
          <span>{picking === 'holes' ? `Click ${bore ? 'bore' : 'hole'} walls in the viewport, in ${bore ? 'boring' : 'drilling'} order…` : op.holes.length ? `${op.holes.length} picked, ${bore ? 'bored' : 'drilled'} in this order`
            : bore ? 'Auto: every vertical bore in the part the cutter fits inside' : 'Auto: every hole in the part that fits the drill'}</span>
          {op.holes.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Use every matching hole" onClick={() => patch({ holes: [] }, ['geometry'])}><X size={12} /></button>}
          <button type="button" className={styles.iconBtn} id="cam-pick-holes" aria-label={picking === 'holes' ? 'Done picking holes' : 'Pick hole walls'} title={picking === 'holes' ? 'Done picking holes' : 'Pick hole walls'} onClick={() => startPicking('holes')}><Crosshair size={13} /></button>
        </div>
      </Row>
      {op.holes.length > 0 && (
        <ol className={styles.holes} id="cam-hole-list">
          {op.holes.map((hole, index) => (
            <li key={`${hole.face}:${index}`} data-hole={hole.face}>
              <span>{index + 1}.</span>
              <span>{hole.radius ? `Ø${num(hole.radius * 2, 3)} at X${num(hole.center[0], 2)} Y${num(hole.center[1], 2)}` : hole.face}</span>
              {hole.radius > 0 && cutter && !fitsPicked(hole.radius) && <em data-tone="warn">{bore ? 'the cutter doesn’t fit' : 'not the drill’s size'}</em>}
              <button type="button" className={styles.iconBtn} aria-label={`Remove hole ${index + 1}`} onClick={() => patch({ holes: op.holes.filter((_, at) => at !== index) }, ['geometry'])}><Trash2 size={12} /></button>
            </li>
          ))}
        </ol>
      )}
      {op.target && (
        <p className={styles.hint} id="cam-hole-hint" data-tone={!op.holes.length && cutter && !matching ? 'warn' : undefined}>
          {found.length
            ? <>Vertical holes in this part: {[...sizes.entries()].map(([size, item]) => `${item.count} × Ø${size}`).join(', ')}.{cutter ? ` ${matching} ${bore ? `take${matching === 1 ? 's' : ''} the Ø${num(cutter.diameter, 3)} cutter` : `fit${matching === 1 ? 's' : ''} the Ø${num(cutter.diameter, 3)} drill`}${op.radialAllowance ? ` (+${num(op.radialAllowance)} radial)` : ''}.` : ''}</>
            : 'No vertical cylindrical holes found in this part.'}
          {' '}{bore ? 'The engine resolves the bores itself: complete vertical cylinders the cutter fits inside. Different diameters on one axis: pick the wall you mean.'
            : 'The engine resolves the holes itself; a hole must match the drill’s radius plus any radial allowance.'}
        </p>
      )}
    </Section>
  );
}

const CHAIN_PROBLEM: Record<string, string> = {
  planes: 'The picked edges aren’t all in one horizontal plane.',
  disconnected: 'The picked edges don’t join end to end: pick one connected chain.',
  branched: 'The picked edges branch: pick one chain without forks.',
};

/** The picked edge chain in words: open (from where to where) or closed (counterclockwise), as the engine runs it. */
function ChainSummary({ op }: { op: OperationDraft }) {
  const chain = contourChain(op);
  if (!chain || chain === 'empty') return null;
  if (typeof chain === 'string') return <p className={styles.hint} data-tone="warn" id="cam-chain">{CHAIN_PROBLEM[chain]}</p>;
  const first = chain.points[0], last = chain.points[chain.points.length - 1];
  return (
    <p className={styles.hint} id="cam-chain" data-closed={chain.closed || undefined}>
      {chain.closed
        ? <>A closed loop at Z {num(chain.z)}, run <b>counterclockwise</b> seen from above (the arrow in the viewport).</>
        : <>An open chain at Z {num(chain.z)}, run from <b>X{num(first[0], 2)} Y{num(first[1], 2)}</b> to <b>X{num(last[0], 2)} Y{num(last[1], 2)}</b> (the arrow in the viewport).</>}
      {' '}Left and right are the cutter’s side walking that way.
    </p>
  );
}

function ContourGeometry({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const mode = op.contourMode;
  return (
    <Section title="Geometry" id="cam-geometry">
      <FieldError field="geometry" />
      <Row label="Follow">
        <Segmented size="sm" value={mode} onChange={(contourMode) => {
          if (picking) stopPicking();
          // An edge chain has no automatic side: switching asks again (the person picks left or right of the arrow).
          patch({ contourMode, side: 'auto' }, ['geometry', 'contour']);
        }} options={[{ value: 'body', label: 'Part outline' }, { value: 'faces', label: 'Faces' }, { value: 'edges', label: 'Edges' }]} />
      </Row>
      <BodyRow op={op} />
      {mode !== 'edges' && (
        <Row label="Outline">
          <Segmented size="sm" value={op.boundary} onChange={(boundary) => patch({ boundary }, ['geometry'])}
            options={[{ value: 'outer', label: 'Outside' }, { value: 'inner', label: 'Inside (holes)' }, { value: 'all', label: 'Both' }]} />
        </Row>
      )}
      {mode === 'body' && <p className={styles.hint}>The outline of the part’s highest upward faces: {op.boundary === 'outer' ? 'its outside' : op.boundary === 'inner' ? 'its holes and openings' : 'outside and holes'}, cut from the top down to the bottom height.</p>}
      {mode === 'faces' && (
        <>
          <Row label="Faces">
            <div className={styles.ref} data-empty={!op.contourFaces.length || undefined} data-picking={picking === 'contour-faces' || undefined} id="cam-contour-faces">
              <span>{picking === 'contour-faces' ? `Click flat horizontal faces in the viewport…${op.contourFaces.length ? ` · ${op.contourFaces.length} picked` : ''}` : op.contourFaces.length ? `${op.contourFaces.length} face${op.contourFaces.length === 1 ? '' : 's'}: ${op.contourFaces.map((face) => `Z ${num(face.z)}`).join(', ')}` : 'Pick the faces whose outline to follow'}</span>
              {op.contourFaces.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the faces" onClick={() => patch({ contourFaces: [] }, ['geometry'])}><X size={12} /></button>}
              <button type="button" className={styles.iconBtn} id="cam-pick-contour-faces" aria-label={picking === 'contour-faces' ? 'Done picking faces' : 'Pick faces'} title={picking === 'contour-faces' ? 'Done picking faces' : 'Pick faces'} onClick={() => startPicking('contour-faces')}><Crosshair size={13} /></button>
            </div>
          </Row>
          <p className={styles.hint}>Each face’s {op.boundary === 'outer' ? 'outside edge' : op.boundary === 'inner' ? 'inside edges' : 'edges'} is followed, with the material on its left.</p>
        </>
      )}
      {mode === 'edges' && (
        <>
          <Row label="Edges">
            <div className={styles.ref} data-empty={!op.contourEdges.length || undefined} data-picking={picking === 'contour-edges' || undefined} id="cam-contour-edges">
              <span>{picking === 'contour-edges' ? `Click edges in the viewport, one connected chain…${op.contourEdges.length ? ` · ${op.contourEdges.length} picked` : ''}` : op.contourEdges.length ? `${op.contourEdges.length} edge${op.contourEdges.length === 1 ? '' : 's'} picked` : 'Pick connected edges in one horizontal plane'}</span>
              {op.contourEdges.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the edges" onClick={() => patch({ contourEdges: [] }, ['geometry'])}><X size={12} /></button>}
              <button type="button" className={styles.iconBtn} id="cam-pick-contour-edges" aria-label={picking === 'contour-edges' ? 'Done picking edges' : 'Pick edges'} title={picking === 'contour-edges' ? 'Done picking edges' : 'Pick edges'} onClick={() => startPicking('contour-edges')}><Crosshair size={13} /></button>
            </div>
          </Row>
          <ChainSummary op={op} />
          <p className={styles.hint}>Straight edges and circular arcs that join end to end; gaps aren’t bridged.</p>
        </>
      )}
    </Section>
  );
}

function ContourSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const edges = op.contourMode === 'edges';
  const chain = contourChain(op);
  const closed = !!chain && typeof chain !== 'string' && chain.closed;
  return (
    <Section title="Contour" id="cam-contour">
      <FieldError field="contour" />
      <Row label="Cutter side" field="contour">
        <Segmented size="sm" value={op.side} onChange={(side) => patch({ side }, ['contour'])}
          options={[...(edges ? [] : [{ value: 'auto' as const, label: 'Off the part' }]), { value: 'left' as const, label: 'Left' }, { value: 'right' as const, label: 'Right' }]} />
      </Row>
      <p className={styles.hint} id="cam-side-hint">{edges
        ? (op.side === 'auto' ? 'Choose the side of the edges the cutter runs on.' : `The cutter runs on the ${op.side} of the arrow; the other side is kept.`)
        : op.side === 'auto' ? 'The outline runs with the material on its left; the cutter stays on the right, off the part.' : `Explicit side: ${op.side} of the outline (the material is on its left).`}</p>
      <Row label="Lead in" sub="straight, off the free side"><NumberField ariaLabel="Lead in" value={op.leadIn} min={0} step={0.5} onChange={(leadIn) => patch({ leadIn }, ['contour'])} /></Row>
      <Row label="Lead out"><NumberField ariaLabel="Lead out" value={op.leadOut} min={0} step={0.5} onChange={(leadOut) => patch({ leadOut }, ['contour'])} /></Row>
      {edges && !closed && (
        <>
          <Row label="Extend start" sub="past the first end"><NumberField ariaLabel="Extend start" value={op.extensionStart} min={0} step={0.5} onChange={(extensionStart) => patch({ extensionStart }, ['contour'])} /></Row>
          <Row label="Extend end" sub="past the last end"><NumberField ariaLabel="Extend end" value={op.extensionEnd} min={0} step={0.5} onChange={(extensionEnd) => patch({ extensionEnd }, ['contour'])} /></Row>
        </>
      )}
      <Row label="Roughing width" sub="extra stock beside the wall"><NumberField ariaLabel="Roughing width" value={op.roughingWidth} min={0} step={0.5} onChange={(roughingWidth) => patch({ roughingWidth }, ['contour'])} /></Row>
      {op.roughingWidth > 0 && (
        <>
          <Row label="Stepover"><NumberField ariaLabel="Stepover" value={op.stepover} min={0} onChange={(stepover) => patch({ stepover }, ['passes', 'contour'])} /></Row>
          {cutter && <p className={styles.hint} data-tone={op.stepover > cutter.diameter / 2 ? 'warn' : undefined}>Offsets step in by up to the cutter radius ({num(cutter.diameter / 2, 3)} mm) toward the finishing pass.</p>}
        </>
      )}
      <Row label="Tolerance"><NumberField ariaLabel="Contour tolerance" value={op.contourTolerance} min={0.0001} max={1} step={0.001} onChange={(contourTolerance) => patch({ contourTolerance }, ['contour'])} /></Row>
      <p className={styles.hint}>Enters with a plunge beside the wall (after the lead-in); the path is already offset by the cutter radius, so cutter compensation stays off in the posted code.</p>
    </Section>
  );
}

/** Tip vs full-diameter depth, drawn: where `bottom` sits on the drill. */
function DepthDiagram({ value }: { value: OperationDraft['depthRef'] }) {
  return (
    <svg className={styles.drillDiagram} viewBox="0 0 120 64" role="img" aria-label={value === 'tip' ? 'The bottom height is the end of the drill point' : 'The bottom height is where the full diameter starts; the point goes below it'}>
      <rect x="44" y="4" width="32" height="38" rx="1.5" className={styles.drillBody} />
      <path d="M44 42 L60 56 L76 42 Z" className={styles.drillBody} />
      <line x1="10" x2="110" y1={value === 'tip' ? 56 : 42} y2={value === 'tip' ? 56 : 42} className={styles.drillLine} />
      <text x="112" y={value === 'tip' ? 59 : 45} className={styles.drillText} textAnchor="end">bottom</text>
    </svg>
  );
}

/** Slot geometry: the rounded slot floors the engine finds (or the one picked), or explicit centrelines with a width. */
function SlotGeometry({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const picking = useCam((state) => state.picking);
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const bounds = useMemo(() => (op.target ? bodyBounds(op.target) : null), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const setGuide = (index: number, change: Partial<SlotGuideDraft>) => patch({ slotGuides: op.slotGuides.map((guide, at) => (at === index ? { ...guide, ...change } : guide)) }, ['slot', 'geometry']);
  const addGuide = () => {
    let n = op.slotGuides.length + 1;
    while (op.slotGuides.some((guide) => guide.id === `slot_${n}`)) n++;
    // A straight centreline across the middle of the part, as wide as the cutter: the person moves it onto the slot.
    const y = bounds ? Number(((bounds.min.y + bounds.max.y) / 2).toFixed(3)) : 0;
    const x0 = bounds ? Number((bounds.min.x + (bounds.max.x - bounds.min.x) * 0.25).toFixed(3)) : 0;
    const x1 = bounds ? Number((bounds.min.x + (bounds.max.x - bounds.min.x) * 0.75).toFixed(3)) : 20;
    patch({ slotGuides: [...op.slotGuides, { id: `slot_${n}`, points: [[x0, y], [x1, y]], width: cutter ? cutter.diameter : 6 }] }, ['slot', 'geometry']);
  };
  return (
    <Section title="Slots" id="cam-geometry">
      <FieldError field="geometry" />
      <EnginePreviewNote op={op} />
      <Row label="Defined by">
        <Segmented size="sm" value={op.slotMode} onChange={(slotMode) => { if (picking) stopPicking(); patch({ slotMode, floor: slotMode === 'guides' ? null : op.floor }, ['geometry', 'slot']); }}
          options={[{ value: 'floors', label: 'Slot floors' }, { value: 'guides', label: 'Centrelines' }]} />
      </Row>
      <BodyRow op={op} />
      {op.slotMode === 'floors' ? (
        <>
          <Row label="Floor">
            <div className={styles.ref} data-empty={!op.floor || undefined} data-picking={picking === 'floor' || undefined} id="cam-slot-floor">
              <span>{picking === 'floor' ? 'Click a slot floor in the viewport…' : op.floor ? `Floor at Z ${num(op.floor.z)}` : 'Auto: every rounded slot floor at the bottom height'}</span>
              {op.floor && <button type="button" className={styles.iconBtn} aria-label="Use every slot floor" onClick={() => patch({ floor: null }, ['geometry'])}><X size={12} /></button>}
              <button type="button" className={styles.iconBtn} id="cam-pick-slot-floor" aria-label="Pick a slot floor" title="Pick a slot floor" onClick={() => startPicking('floor')}><Crosshair size={13} /></button>
            </div>
          </Row>
          <p className={styles.hint}>A slot floor is a complete straight floor with two parallel sides and rounded ends, at the bottom height. For open grooves or through slots, use centrelines.</p>
        </>
      ) : (
        <>
          <FieldError field="slot" />
          {op.slotGuides.map((guide, index) => (
            <div key={guide.id} className={styles.guide} data-guide={guide.id}>
              <div className={styles.guideHead}>
                <b>{guide.id.replace(/_/g, ' ')}</b>
                <NumberField ariaLabel={`Slot ${index + 1} width`} prefix="W" unit="mm" value={guide.width} min={0.01} step={0.5} onChange={(width) => setGuide(index, { width })} />
                <button type="button" className={styles.iconBtn} aria-label={`Remove slot ${index + 1}`} onClick={() => patch({ slotGuides: op.slotGuides.filter((_, at) => at !== index) }, ['slot'])}><Trash2 size={12} /></button>
              </div>
              {guide.points.map((point, at) => (
                <div key={at} className={styles.guidePoint}>
                  <span>{at === 0 ? 'Start' : at === guide.points.length - 1 ? 'End' : `Bend ${at}`}</span>
                  <NumberField ariaLabel={`Slot ${index + 1} point ${at + 1} X`} prefix="X" prefixColor="var(--axis-x)" value={point[0]} onChange={(x) => setGuide(index, { points: guide.points.map((item, k) => (k === at ? [x, item[1]] : item)) })} />
                  <NumberField ariaLabel={`Slot ${index + 1} point ${at + 1} Y`} prefix="Y" prefixColor="var(--axis-y)" value={point[1]} onChange={(y) => setGuide(index, { points: guide.points.map((item, k) => (k === at ? [item[0], y] : item)) })} />
                  {guide.points.length > 2 && <button type="button" className={styles.iconBtn} aria-label={`Remove point ${at + 1}`} onClick={() => setGuide(index, { points: guide.points.filter((_, k) => k !== at) })}><X size={11} /></button>}
                </div>
              ))}
              <div className={styles.quick}><button type="button" onClick={() => { const last = guide.points[guide.points.length - 1]; setGuide(index, { points: [...guide.points, [Number((last[0] + 5).toFixed(3)), last[1]]] }); }}>Add a bend</button></div>
            </div>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus />} id="cam-add-slot-guide" onClick={addGuide}>Add a centreline</Button>
          <p className={styles.hint}>Work XY. The width is the finished slot’s (not a toolpath offset); a bend includes a full round at each point. A centreline may run past the stock for an open slot; for a through slot set the bottom below the part.</p>
        </>
      )}
    </Section>
  );
}

/** The editor's V-bit as the engine sees it (null without a conical cutter). */
const conicalOf = (cutter: ReturnType<typeof cutterOf>): ConicalCutter | null => (cutter?.pointAngleDeg
  ? { diameter: cutter.diameter, tipDiameter: cutter.tipDiameter ?? 0, angle: (cutter.pointAngleDeg * Math.PI) / 180 } : null);

/** Engraving geometry: the face engraved (or the part's top) and the centrelines, from sketch curves and model edges. */
function EngraveGeometry({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const version = useGeometryVersion();
  const modeling = useApp((state) => state.modeling);
  const sketches = useMemo(() => horizontalSketches(op.engraveChord), [modeling, version, op.engraveChord]); // eslint-disable-line react-hooks/exhaustive-deps
  const bounds = useMemo(() => (op.target ? bodyBounds(op.target) : null), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const curveSketchesOf = (refs: { sketch: string }[]) => [...new Set(refs.map((ref) => sketches.find((item) => item.id === ref.sketch)?.name ?? ref.sketch))];
  const curveSketches = curveSketchesOf(op.engraveCurves);
  const closed = op.engravePaths.filter((path) => path.closed).length;
  const legacy = op.engraveSaved.length > 0;
  const convertible = useMemo(() => (legacy ? savedPathCurves(op) : null), [legacy, op.engraveSaved, sketches]); // eslint-disable-line react-hooks/exhaustive-deps
  // What each path follows, in words: "Mark · Line 3" for a sketch curve, "Edge 12" for a model edge.
  const sourceLabel = (from: string) => {
    const [sketchId, entity] = from.includes(':') ? [null, null] : from.split('.');
    if (sketchId && entity) {
      const sketch = sketches.find((item) => item.id === sketchId);
      return `${sketch?.name ?? sketchId} · ${sketch?.curves.find((curve) => curve.entity === entity)?.label ?? entity}`;
    }
    return `Edge ${from.split(':').slice(1).join(':').replace(/^edge\((.*)\)$/, '$1')}`;
  };
  const missing = [
    ...op.engraveCurves.filter((ref) => !sketches.some((sketch) => sketch.id === ref.sketch && sketch.curves.some((curve) => curve.entity === ref.entity))).map((ref) => `${ref.sketch} · ${ref.entity}`),
    ...op.engraveEdges.filter((edge) => edge.points.length < 2).map((edge) => `edge ${edge.edge}`),
  ];
  const addSketch = (id: string) => {
    const sketch = sketches.find((item) => item.id === id);
    if (!sketch) return;
    updateEngrave((current) => ({ engraveCurves: [...current.engraveCurves, ...sketch.curves
      .filter((curve) => !current.engraveCurves.some((ref) => ref.sketch === curve.sketch && ref.entity === curve.entity))
      .map((curve) => ({ sketch: curve.sketch, entity: curve.entity, label: curve.label }))] }));
  };
  return (
    <>
      <Section title="Surface" id="cam-geometry">
        <FieldError field="geometry" />
        <BodyRow op={op} />
        <Row label="Face">
          <div className={styles.ref} data-empty={!op.floor || undefined} data-picking={picking === 'floor' || undefined} id="cam-engrave-face">
            <span>{picking === 'floor' ? 'Click the flat face to engrave…' : op.floor ? `Face at Z ${num(op.floor.z)}` : `Auto: the part’s top${bounds ? ` at Z ${num(bounds.max.z)}` : ''}`}</span>
            {op.floor && <button type="button" className={styles.iconBtn} aria-label="Use the part's top" onClick={() => { if (op.target) setTarget(op.target, null); }}><X size={12} /></button>}
            <button type="button" className={styles.iconBtn} id="cam-pick-engrave-face" aria-label="Pick the face to engrave" title="Pick the face to engrave" onClick={() => startPicking('floor')}><Crosshair size={13} /></button>
          </div>
        </Row>
        <p className={styles.hint}>{op.engraveIntent === 'add_groove'
          ? 'The groove is cut into this flat, upward face at the top height; all of it must stay on the face.'
          : 'A groove already modelled in the part: the cutter must stay inside it.'}</p>
      </Section>
      <Section title={`Paths${op.engravePaths.length ? ` (${op.engravePaths.length})` : ''}`} id="cam-engrave-paths">
        <FieldError field="engrave" />
        <Row label="Sketch curves">
          <div className={styles.ref} data-empty={!op.engraveCurves.length || undefined} data-picking={picking === 'engrave-curves' || undefined} id="cam-engrave-curves">
            <span>{picking === 'engrave-curves' ? `Click sketch curves in the viewport…${op.engraveCurves.length ? ` · ${op.engraveCurves.length} picked` : ''}`
              : op.engraveCurves.length ? `${op.engraveCurves.length} curve${op.engraveCurves.length === 1 ? '' : 's'} from ${curveSketches.join(', ')}` : sketches.length ? 'Pick the curves to follow' : 'No sketch on a horizontal plane'}</span>
            {op.engraveCurves.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the sketch curves" onClick={() => updateEngrave(() => ({ engraveCurves: [] }))}><X size={12} /></button>}
            <button type="button" className={styles.iconBtn} id="cam-pick-engrave-curves" disabled={!sketches.length} aria-label={picking === 'engrave-curves' ? 'Done picking curves' : 'Pick sketch curves'} title={picking === 'engrave-curves' ? 'Done picking curves' : 'Pick sketch curves'} onClick={() => startPicking('engrave-curves')}><Crosshair size={13} /></button>
          </div>
        </Row>
        {sketches.length > 0 && (
          <Row label="Whole sketch">
            <Select ariaLabel="Add a whole sketch" value={NONE} onChange={(id) => { if (id !== NONE) addSketch(id); }}
              options={[{ value: NONE, label: 'Add every curve of a sketch…' }, ...sketches.map((sketch) => ({ value: sketch.id, label: sketch.name, hint: `${sketch.curves.length} curve${sketch.curves.length === 1 ? '' : 's'} · Z ${num(sketch.z)}` }))]} />
          </Row>
        )}
        <Row label="Model edges">
          <div className={styles.ref} data-empty={!op.engraveEdges.length || undefined} data-picking={picking === 'engrave-edges' || undefined} id="cam-engrave-edges">
            <span>{picking === 'engrave-edges' ? `Click flat edges on the face…${op.engraveEdges.length ? ` · ${op.engraveEdges.length} picked` : ''}` : op.engraveEdges.length ? `${op.engraveEdges.length} edge${op.engraveEdges.length === 1 ? '' : 's'}` : 'Optional: edges lying on the face'}</span>
            {op.engraveEdges.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the edges" onClick={() => updateEngrave(() => ({ engraveEdges: [] }))}><X size={12} /></button>}
            <button type="button" className={styles.iconBtn} id="cam-pick-engrave-edges" aria-label={picking === 'engrave-edges' ? 'Done picking edges' : 'Pick edges'} title={picking === 'engrave-edges' ? 'Done picking edges' : 'Pick edges'} onClick={() => startPicking('engrave-edges')}><Crosshair size={13} /></button>
          </div>
        </Row>
        {legacy && (
          <div className={styles.banner} data-tone="warn" id="cam-engrave-saved" data-convertible={convertible ? 'true' : undefined}>
            <Info size={14} />
            <span><b>{op.engraveSaved.length} path{op.engraveSaved.length === 1 ? '' : 's'} saved as fixed coordinates</b> (from before engraving followed the design): {op.engraveSaved.length === 1 ? 'it doesn’t' : 'they don’t'} change when the sketch does.{' '}
              {convertible
                ? <>{convertible.length === 1 ? 'It matches' : `They match ${convertible.length} curves of`} the design’s sketch{curveSketchesOf(convertible).length === 1 ? ` “${curveSketchesOf(convertible)[0]}”` : 'es'} exactly.{' '}
                  <button type="button" className={styles.quick} style={{ display: 'inline' }} id="cam-engrave-convert" onClick={() => updateEngrave(() => ({ engraveSaved: [], engraveCurves: convertible }))}>Follow the sketch instead</button></>
                : <>No sketch curves match {op.engraveSaved.length === 1 ? 'it' : 'them'} exactly, so {op.engraveSaved.length === 1 ? 'it stays' : 'they stay'} as saved. <button type="button" className={styles.quick} style={{ display: 'inline' }} onClick={() => updateEngrave(() => ({ engraveSaved: [] }))}>Clear them</button> and pick the curves to follow.</>}
            </span>
          </div>
        )}
        {missing.length > 0 && (
          <p className={styles.hint} data-tone="warn" id="cam-engrave-missing">{missing.length} source{missing.length === 1 ? ' isn’t' : 's aren’t'} in the displayed design ({missing.join(', ')}): the program still has {missing.length === 1 ? 'it' : 'them'} in the revision it pins, but saving now pins this revision. Remove {missing.length === 1 ? 'it' : 'them'} or pick again.</p>
        )}
        {op.engravePaths.length > 0 && (
          <>
            <p className={styles.hint} id="cam-engrave-summary">{op.engravePaths.length} path{op.engravePaths.length === 1 ? '' : 's'}{closed ? ` (${closed} closed)` : ''} · {num(pathsLength(op.engravePaths), 1)} mm to engrave</p>
            <ol className={styles.holes} id="cam-engrave-path-list">
              {op.engravePaths.map((path, index) => (
                <li key={path.id} data-path={path.id} data-closed={path.closed || undefined} data-from={path.from.join(' ') || undefined}>
                  <span>{index + 1}.</span>
                  <span>{path.from.length ? path.from.map(sourceLabel).join(' + ') : 'Saved coordinates'} · {path.closed ? 'loop' : 'open'} · {num(pathsLength([path]), 1)} mm</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {legacy && <Row label="Curve accuracy" sub="segments within"><NumberField ariaLabel="Curve accuracy" unit="mm" value={op.engraveChord} min={0.0005} max={1} step={0.005} onChange={(engraveChord) => updateEngrave(() => ({ engraveChord }))} /></Row>}
        <p className={styles.hint}>{legacy
          ? <>Arcs and splines become straight segments within {num(op.engraveChord, 4)} mm of the sketch. Curves that meet end to end join into one path; a loop is engraved as a closed path. The tip follows these centrelines in work XY.</>
          : <>Each curve is followed exactly as the design defines it, from the design revision the program pins: edit the sketch, save the design, and generate again, and the paths follow. A sketch below or above the face is projected onto it. Each curve is its own path.</>}</p>
      </Section>
    </>
  );
}

/** The groove in section: the V-bit's cone at the depth and the width it leaves at the surface. */
function GrooveDiagram({ cutter, depth }: { cutter: ConicalCutter; depth: number }) {
  const width = engraveWidth(cutter, depth);
  const height = coneHeight(cutter);
  const scale = 46 / Math.max(height * 1.15, depth * 1.2, 0.01);
  const surface = 18, cx = 80;
  const tip = surface + depth * scale, half = (cutter.tipDiameter / 2) * scale, top = surface - Math.max(0, height - depth) * scale - 4;
  const r = (cutter.diameter / 2) * scale;
  const cone = `${cx - half},${tip} ${cx + half},${tip} ${cx + r},${tip - height * scale} ${cx + r},${top} ${cx - r},${top} ${cx - r},${tip - height * scale}`;
  return (
    <svg className={styles.helixDiagram} viewBox="0 0 160 76" role="img" aria-label={`A ${num(depth, 3)} mm deep groove ${num(width, 3)} mm wide at the surface`}>
      <path d={`M4 ${surface}H${cx - (width / 2) * scale}L${cx - half} ${tip}H${cx + half}L${cx + (width / 2) * scale} ${surface}H156`} className={styles.helixPath} fill="none" />
      <polygon points={cone} className={styles.helixCutter} />
      <line x1={cx - (width / 2) * scale} x2={cx + (width / 2) * scale} y1={surface - 6} y2={surface - 6} className={styles.drillLine} />
      <text x={cx} y={surface - 9} className={styles.drillText} textAnchor="middle">{num(width, 3)} mm</text>
      <text x="156" y={Math.min(72, tip + 2)} className={styles.drillText} textAnchor="end">{num(depth, 3)} deep</text>
    </svg>
  );
}

/** How the engraving cuts: a new groove or a modelled one, its depth and the width that leaves, the tolerance. */
function EngraveSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const cone = conicalOf(cutter);
  const depth = Math.max(0, op.top - op.bottom);
  const width = cone ? engraveWidth(cone, depth) : null;
  const height = cone ? coneHeight(cone) : null;
  return (
    <Section title="Engrave" id="cam-engrave">
      <FieldError field="passes" />
      <Row label="Groove">
        <Segmented size="sm" value={op.engraveIntent} onChange={(engraveIntent) => updateEngrave(() => ({ engraveIntent }))}
          options={[{ value: 'add_groove' as const, label: 'Cut a new one' }, { value: 'existing_groove' as const, label: 'Modelled in the part' }]} />
      </Row>
      <Row label="Depth" sub="below the top"><NumberField ariaLabel="Engrave depth" unit="mm" value={Number(depth.toFixed(6))} min={0.001} step={0.1} onChange={(value) => patch({ bottom: Number((op.top - value).toFixed(6)) }, ['heights'])} /></Row>
      {cone && width !== null && (
        <>
          <GrooveDiagram cutter={cone} depth={depth} />
          <p className={styles.hint} id="cam-engrave-width">The Ø{num(cone.diameter, 3)} {num((cone.angle * 180) / Math.PI, 1)}° V-bit{cone.tipDiameter ? ` (Ø${num(cone.tipDiameter, 3)} flat tip)` : ''} at {num(depth, 3)} mm deep leaves a groove <b>{num(width, 3)} mm</b> wide at the surface.</p>
          {height !== null && depth > height && <p className={styles.hint} data-tone="warn">Deeper than the cone ({num(height, 3)} mm): below that the groove’s walls go straight down at the full Ø{num(cone.diameter, 3)}.</p>}
        </>
      )}
      <Row label="Stepdown" sub="per depth pass"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0.001} step={0.1} onChange={(stepdown) => patch({ stepdown }, ['passes'])} /></Row>
      <Row label="Tolerance" sub="coverage, precision"><NumberField ariaLabel="Engrave tolerance" value={op.engraveTolerance} min={0.0001} max={1} step={0.001} onChange={(engraveTolerance) => patch({ engraveTolerance }, ['engrave'])} /></Row>
      {op.cell > depth && <p className={styles.hint}>With a {num(op.cell)} mm check grid (Check resolution), a groove this shallow can show as uncertain stock; every operation in a setup shares the grid, so set it on the facing too.</p>}
      <p className={styles.hint}>Each path is entered with a straight plunge at the plunge feed and followed in its order, a pass per stepdown; moves between paths are at the clearance height. Text outlines, V-carving and engraving on curved faces aren’t part of this engine.</p>
    </Section>
  );
}

/** Chamfer selection: the part's top outline, picked faces' boundaries, or one picked edge chain (like a contour). */
function ChamferGeometry({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const mode = op.contourMode;
  const modelled = op.chamferIntent === 'existing_chamfer';
  return (
    <Section title="Edges" id="cam-geometry">
      <FieldError field="geometry" />
      <Row label="Chamfer">
        <Segmented size="sm" value={mode} onChange={(contourMode) => {
          if (picking) stopPicking();
          patch({ contourMode, side: 'auto' }, ['geometry', 'chamfer']);
        }} options={[{ value: 'body', label: 'Top outline' }, { value: 'faces', label: 'Faces' }, { value: 'edges', label: 'Edges' }]} />
      </Row>
      <BodyRow op={op} />
      {mode !== 'edges' && (
        <Row label="Outline">
          <Segmented size="sm" value={op.boundary} onChange={(boundary) => patch({ boundary }, ['geometry'])}
            options={[{ value: 'outer', label: 'Outside' }, { value: 'inner', label: 'Inside (holes)' }, { value: 'all', label: 'Both' }]} />
        </Row>
      )}
      {mode === 'body' && <p className={styles.hint}>The edges around the part’s highest upward faces: {op.boundary === 'outer' ? 'its outside' : op.boundary === 'inner' ? 'its holes and openings (hole rims too)' : 'outside, holes and openings'}.</p>}
      {mode === 'faces' && (
        <>
          <Row label="Faces">
            <div className={styles.ref} data-empty={!op.contourFaces.length || undefined} data-picking={picking === 'contour-faces' || undefined} id="cam-chamfer-faces">
              <span>{picking === 'contour-faces' ? `Click upward flat faces in the viewport…${op.contourFaces.length ? ` · ${op.contourFaces.length} picked` : ''}` : op.contourFaces.length ? `${op.contourFaces.length} face${op.contourFaces.length === 1 ? '' : 's'}: ${op.contourFaces.map((face) => `Z ${num(face.z)}`).join(', ')}` : 'Pick the faces whose edges get the chamfer'}</span>
              {op.contourFaces.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the faces" onClick={() => patch({ contourFaces: [] }, ['geometry'])}><X size={12} /></button>}
              <button type="button" className={styles.iconBtn} id="cam-pick-chamfer-faces" aria-label={picking === 'contour-faces' ? 'Done picking faces' : 'Pick faces'} title={picking === 'contour-faces' ? 'Done picking faces' : 'Pick faces'} onClick={() => startPicking('contour-faces')}><Crosshair size={13} /></button>
            </div>
          </Row>
          <p className={styles.hint}>Each face’s {op.boundary === 'outer' ? 'outside edge' : op.boundary === 'inner' ? 'inside edges (hole rims)' : 'edges'} get the chamfer; the faces must be at one height.</p>
        </>
      )}
      {mode === 'edges' && (
        <>
          <Row label="Edges">
            <div className={styles.ref} data-empty={!op.contourEdges.length || undefined} data-picking={picking === 'contour-edges' || undefined} id="cam-chamfer-edges">
              <span>{picking === 'contour-edges' ? `Click edges in the viewport, one connected chain…${op.contourEdges.length ? ` · ${op.contourEdges.length} picked` : ''}` : op.contourEdges.length ? `${op.contourEdges.length} edge${op.contourEdges.length === 1 ? '' : 's'} picked` : modelled ? 'Pick the bevel’s lower edges' : 'Pick connected edges in one horizontal plane'}</span>
              {op.contourEdges.length > 0 && <button type="button" className={styles.iconBtn} aria-label="Clear the edges" onClick={() => patch({ contourEdges: [] }, ['geometry'])}><X size={12} /></button>}
              <button type="button" className={styles.iconBtn} id="cam-pick-chamfer-edges" aria-label={picking === 'contour-edges' ? 'Done picking edges' : 'Pick edges'} title={picking === 'contour-edges' ? 'Done picking edges' : 'Pick edges'} onClick={() => startPicking('contour-edges')}><Crosshair size={13} /></button>
            </div>
          </Row>
          <ChainSummary op={op} />
          <p className={styles.hint}>{modelled
            ? 'The lower edges of the modelled bevel, where it meets the vertical wall: straight edges and circular arcs joined end to end.'
            : 'Sharp edges between an upward flat face and a vertical wall: straight edges and circular arcs joined end to end, at one height.'}</p>
        </>
      )}
      {modelled && mode !== 'edges' && <p className={styles.hint} data-tone="warn">A chamfer already modelled is cut along its lower edges: choose Edges and pick them.</p>}
    </Section>
  );
}

/** The chamfer in section: the part's corner, the bevel `width` wide, and the V-bit's flank lying along it, tip below. */
function ChamferDiagram({ cutter, width, tipOffset }: { cutter: ConicalCutter; width: number; tipOffset: number }) {
  const k = chamferSlope(cutter);
  const depth = width / k;
  const offset = chamferOffset(tipOffset, cutter);
  const height = coneHeight(cutter);
  const scale = 46 / Math.max(depth + tipOffset + 0.5, width + offset + 0.5, 0.01);
  const surface = 16, edgeX = 70;
  const bottomY = surface + depth * scale, tipY = bottomY + tipOffset * scale;
  const tipX = edgeX + offset * scale, rTip = (cutter.tipDiameter / 2) * scale, r = (cutter.diameter / 2) * scale;
  const shoulder = tipY - height * scale;
  const part = `4,${surface} ${edgeX - width * scale},${surface} ${edgeX},${bottomY} ${edgeX},74 4,74`;
  const cone = `${tipX - rTip},${tipY} ${tipX + rTip},${tipY} ${tipX + r},${shoulder} ${tipX + r},${Math.min(shoulder, 2)} ${tipX - r},${Math.min(shoulder, 2)} ${tipX - r},${shoulder}`;
  return (
    <svg className={styles.helixDiagram} viewBox="0 0 160 76" role="img" aria-label={`A ${num(width, 3)} mm chamfer, ${num(depth, 3)} mm deep`} id="cam-chamfer-diagram">
      <polygon points={part} className={styles.drillBody} />
      <path d={`M${edgeX - width * scale} ${surface}L${edgeX} ${bottomY}`} className={styles.helixPath} fill="none" />
      <polygon points={cone} className={styles.helixCutter} />
      <line x1={edgeX - width * scale} x2={edgeX} y1={surface - 6} y2={surface - 6} className={styles.drillLine} />
      <text x={edgeX - (width * scale) / 2} y={surface - 9} className={styles.drillText} textAnchor="middle">{num(width, 3)} mm</text>
      <text x="4" y={Math.min(72, bottomY + 3)} className={styles.drillText}>{num(depth, 3)} deep</text>
    </svg>
  );
}

/** How the chamfer cuts: new (a width) or modelled, the tip offset, side, direction, passes and tolerance. */
function ChamferSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const cone = conicalOf(cutter);
  const modelled = op.chamferIntent === 'existing_chamfer';
  const edges = op.contourMode === 'edges';
  const edge = chamferEdgeZ(op);
  const depth = cone && !modelled ? op.chamferWidth / chamferSlope(cone) : null;
  const fits = !cone || modelled || chamferFits(op.chamferWidth, op.chamferTipOffset, cone);
  return (
    <Section title="Chamfer" id="cam-chamfer">
      <FieldError field="chamfer" />
      <FieldError field="passes" />
      <Row label="Bevel">
        <Segmented size="sm" value={op.chamferIntent} onChange={(chamferIntent) => {
          if (chamferIntent === 'existing_chamfer' && op.contourMode !== 'edges') stopPicking();
          patch({ chamferIntent, ...(chamferIntent === 'existing_chamfer' ? { contourMode: 'edges' as const, side: 'auto' as const } : {}) }, ['chamfer', 'geometry']);
        }} options={[{ value: 'add_chamfer' as const, label: 'Cut a new one' }, { value: 'existing_chamfer' as const, label: 'Modelled in the part' }]} />
      </Row>
      {!modelled && <Row label="Width" sub="across the top face" field="chamfer"><NumberField ariaLabel="Chamfer width" unit="mm" value={op.chamferWidth} min={0.001} step={0.1} onChange={(chamferWidth) => patch({ chamferWidth }, ['chamfer', 'heights'])} /></Row>}
      <Row label="Tip offset" sub="tip below the lower edge"><NumberField ariaLabel="Chamfer tip offset" unit="mm" value={op.chamferTipOffset} min={0} step={0.1} onChange={(chamferTipOffset) => patch({ chamferTipOffset }, ['chamfer'])} /></Row>
      {cone && !modelled && (
        <>
          <ChamferDiagram cutter={cone} width={op.chamferWidth} tipOffset={op.chamferTipOffset} />
          <p className={styles.hint} id="cam-chamfer-width">The {num((cone.angle * 180) / Math.PI, 1)}° V-bit cuts a <b>{num(op.chamferWidth, 3)} mm</b> chamfer {num(depth ?? 0, 3)} mm deep{edge !== null ? ` (edge at Z ${num(edge)}, lower edge at Z ${num(op.bottom)})` : ''}; its tip runs {num(op.chamferTipOffset, 3)} mm lower, {num(chamferOffset(op.chamferTipOffset, cone), 3)} mm outside the lower edge.</p>
        </>
      )}
      {cone && !fits && <p className={styles.hint} data-tone="warn" id="cam-chamfer-fit">The bevel and tip offset need {num(chamferOffset(op.chamferTipOffset, cone) + op.chamferWidth, 3)} mm of the cone’s radius; this V-bit has {num(cone.diameter / 2, 3)} mm. Narrow the chamfer, lower the tip offset, or use a larger V-bit.</p>}
      {modelled && <p className={styles.hint}>The cutter follows the bevel already in the part: its angle must match the bevel’s, and the bottom height is the picked lower edge{edge !== null ? ` (Z ${num(edge)})` : ''}.</p>}
      {edges && (
        <>
          <Row label="Cutter side" field="chamfer">
            <Segmented size="sm" value={op.side} onChange={(side) => patch({ side }, ['chamfer'])} options={[{ value: 'left' as const, label: 'Left' }, { value: 'right' as const, label: 'Right' }]} />
          </Row>
          <p className={styles.hint} id="cam-chamfer-side">{op.side === 'auto' ? 'Choose the side of the edges the cutter runs on: the side away from the part.' : `The cutter runs on the ${op.side} of the arrow; the part is on the other side.`}</p>
        </>
      )}
      <Row label="Direction">
        <Segmented size="sm" value={op.direction} onChange={(direction) => patch({ direction })} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} />
      </Row>
      <Row label="Stepdown" sub="per depth pass"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0.001} step={0.1} onChange={(stepdown) => patch({ stepdown }, ['passes'])} /></Row>
      <Row label="Tolerance"><NumberField ariaLabel="Chamfer tolerance" value={op.chamferTolerance} min={0.0001} max={1} step={0.005} onChange={(chamferTolerance) => patch({ chamferTolerance }, ['chamfer'])} /></Row>
      {depth !== null && op.cell > depth && <p className={styles.hint}>With a {num(op.cell)} mm check grid (Check resolution), a bevel this shallow can show as uncertain stock; every operation in a setup shares the grid, so set the facing’s to match.</p>}
      <p className={styles.hint}>Each chain is entered with a straight plunge at the plunge feed, a pass per stepdown, moves between chains at the clearance height. Sloped or freeform edges and variable widths aren’t part of this engine.</p>
    </Section>
  );
}

/** Slot entry and tolerance; how the width is cut follows from the cutter. */
function SlotSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const modes = entryModes('slot');
  const widths = op.slotMode === 'guides' ? [...new Set(op.slotGuides.map((guide) => guide.width))] : [];
  const equal = !!cutter && widths.length > 0 && widths.every((width) => Math.abs(width - op.radialAllowance * 2 - cutter.diameter) < 1e-6);
  return (
    <Section title="Slot" id="cam-slot">
      <FieldError field="slot" />
      <FieldError field="linking" />
      <Row label="Entry">
        <Segmented size="sm" value={op.entry === 'ramp' ? 'ramp' : 'plunge'} onChange={(entry) => patch({ entry }, ['linking'])}
          options={[{ value: 'plunge' as const, label: 'Plunge' }, { value: 'ramp' as const, label: 'Ramp along the slot' }].filter((item) => modes.includes(item.value) || item.value === op.entry)} />
      </Row>
      {op.entry === 'ramp' && <Row label="Ramp angle" sub="descent"><NumberField ariaLabel="Ramp angle" unit="°" value={op.rampDeg} min={0.1} max={45} onChange={(rampDeg) => patch({ rampDeg }, ['linking'])} /></Row>}
      <Row label="Tolerance" sub="finishing path"><NumberField ariaLabel="Slot tolerance" value={op.slotTolerance} min={0.0001} max={1} step={0.001} onChange={(slotTolerance) => patch({ slotTolerance }, ['slot'])} /></Row>
      <p className={styles.hint}>{equal
        ? 'The cutter is the slot’s width: it follows the centreline, cutting both sides at once.'
        : 'A cutter narrower than the slot clears the centre, then rings outward to the slot’s width at each depth; one as wide as the slot follows the centreline.'} Ramps go back and forth along the slot below the angle; no helix for slots.</p>
    </Section>
  );
}

/** Helical entry, drawn: the cutter centre spiralling down on a circle of the helix radius, the cutter's footprint at
 * the bottom (to scale with the radius). */
function HelixDiagram({ radius, cutterRadius }: { radius: number | null; cutterRadius: number | null }) {
  const cutter = cutterRadius ?? 3;
  const r = radius ?? cutter * 0.8;
  const scale = 28 / Math.max(cutter, r);
  const rx = r * scale, ry = rx * 0.3;
  const cx = 64, top = 12, bottom = 56, turns = 3, steps = 48;
  const path = Array.from({ length: turns * steps + 1 }, (_, i) => {
    const t = (i / steps) * Math.PI * 2;
    return `${(cx + rx * Math.cos(t)).toFixed(2)},${(top + ((bottom - top) * i) / (turns * steps) + ry * Math.sin(t)).toFixed(2)}`;
  }).join(' ');
  return (
    <svg className={styles.helixDiagram} viewBox="0 0 160 76" role="img" aria-label={`Helical entry: the cutter centre spirals down on a ${radius === null ? 'fitted' : `${num(radius, 3)} mm`} radius`}>
      <line x1={cx} x2={cx} y1={4} y2={bottom + 12} className={styles.drillLine} opacity={0.5} />
      <polyline points={path} className={styles.helixPath} fill="none" />
      <ellipse cx={cx + rx} cy={bottom} rx={cutter * scale} ry={cutter * scale * 0.3} className={styles.helixCutter} />
      <line x1={cx} x2={cx + rx} y1={bottom} y2={bottom} className={styles.helixPath} />
      <text x={cx + rx / 2} y={bottom - 3} className={styles.drillText} textAnchor="middle">r</text>
      <text x="158" y="10" className={styles.drillText} textAnchor="end">{radius === null ? 'r fitted' : `r ${num(radius, 2)} mm`}</text>
      {cutterRadius !== null && <text x="158" y="21" className={styles.drillText} textAnchor="end" opacity={0.7}>cutter Ø{num(cutterRadius * 2, 2)}</text>}
    </svg>
  );
}

/** Ramp or helix: the descent angle, and a helix's cutter-centre radius (auto, or at most the cutter radius). */
function RampHelixFields({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  // A rough's helix is half the cutter radius unless set (manufacturing/rough.py); pockets and bores fit the largest.
  const rough = op.kind === 'rough';
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const radius = cutter ? cutter.diameter / 2 : null;
  return (
    <>
      <Row label={op.entry === 'helix' ? 'Helix angle' : 'Ramp angle'} sub="descent"><NumberField ariaLabel="Ramp angle" unit="°" value={op.rampDeg} min={0.1} max={45} onChange={(rampDeg) => patch({ rampDeg }, ['linking'])} /></Row>
      {op.entry === 'helix' && (
        <>
          <Row label="Helix radius" sub="cutter centre">
            <div className={styles.inline}>
              <Segmented size="sm" value={op.helixRadius === null ? 'auto' : 'own'} onChange={(value) => patch({ helixRadius: value === 'auto' ? null : Number(((radius ?? 2) * 0.8).toFixed(3)) }, ['linking'])}
                options={[{ value: 'auto', label: rough ? 'Default' : 'Fit it' }, { value: 'own', label: 'Set' }]} />
              {op.helixRadius !== null && <NumberField ariaLabel="Helix radius" value={op.helixRadius} min={0.001} step={0.1} onChange={(helixRadius) => patch({ helixRadius }, ['linking'])} />}
            </div>
          </Row>
          <HelixDiagram radius={rough && op.helixRadius === null && radius !== null ? radius / 2 : op.helixRadius} cutterRadius={radius} />
          {!rough && radius !== null && op.helixRadius !== null && op.helixRadius > radius && <p className={styles.hint} data-tone="warn">At most the cutter radius ({num(radius, 3)} mm): a larger circle would leave an uncut core.</p>}
          <p className={styles.hint}>{op.helixRadius === null
            ? (rough ? `Half the cutter radius${radius !== null ? ` (${num(radius / 2, 3)} mm)` : ''}; where it doesn’t fit, the run stops and names the largest radius that does.` : 'The engine fits the largest helix each region can take, up to the cutter radius.')
            : 'This exact radius, or the job stops with a clear error; it never quietly becomes a plunge.'}</p>
        </>
      )}
    </>
  );
}

/** Pocket entry: plunge, a ramp along the wall or a helix, as the engine runs them. */
function EntrySection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const modes = entryModes('pocket');
  const options = [{ value: 'plunge' as const, label: 'Plunge' }, { value: 'ramp' as const, label: 'Ramp' }, { value: 'helix' as const, label: 'Helix' }].filter((item) => modes.includes(item.value) || item.value === op.entry);
  return (
    <Section title="Entry" id="cam-linking">
      <FieldError field="linking" />
      <Row label="Entry"><Segmented size="sm" value={op.entry} onChange={(entry) => patch({ entry }, ['linking'])} options={options} /></Row>
      {op.entry !== 'plunge' && <RampHelixFields op={op} cutter={cutter} />}
      <p className={styles.hint}>{op.entry === 'plunge' ? 'Straight down at each depth (a centre-cutting cutter).' : op.entry === 'ramp' ? 'Down along the pocket wall at the ramp angle.' : 'Each region is entered on a helix, then a full circuit at each depth.'}</p>
    </Section>
  );
}

/** What the engine refuses in a rough that the form can tell (cam/rough.ts), on the section it belongs to; Save refuses them too. */
function RoughRefusals({ problems, field }: { problems: RoughProblem[]; field: string }) {
  // One already on the field (Save refused it) isn't said twice.
  const shown = useCam((state) => state.editor?.errors[field]);
  const mine = problems.filter((problem) => problem.field === field && problem.message !== shown);
  if (!mine.length) return null;
  return <>{mine.map((problem) => <p key={problem.message} className={styles.hint} data-tone="warn" data-rough-problem={field}>{problem.message}</p>)}</>;
}

/** Roughing's part: the whole body, cleared around at each depth. */
function RoughGeometry({ op, above }: { op: OperationDraft; above: number | null }) {
  return (
    <Section title="Geometry" id="cam-geometry">
      <FieldError field="geometry" />
      <BodyRow op={op} />
      {above !== null && (
        <p className={styles.hint} data-tone="warn" id="cam-rough-above">The first pass (Z {num(above)}) is above the part’s top: a rough starts at or below it, so the run refuses this. Face the stock down to the part first (Face), then start the rough at the faced height.</p>
      )}
      <p className={styles.hint}>At each depth it clears the stock around the part’s outline seen from above (from that depth up), from the stock’s edge in. Inside corners and openings narrower than the cutter keep their stock; an overhang is never cut under.</p>
    </Section>
  );
}

/** Roughing's passes: rings a stepover apart around the part at each stepdown, and what is left on the walls and floor. */
function RoughSection({ op, cutter, problems }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf>; problems: RoughProblem[] }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const modes = entryModes('rough');
  return (
    <>
      <Section title="Passes" id="cam-passes">
        <FieldError field="passes" />
        <Row label="Clearing">
          <Segmented size="sm" value={op.roughClearing} onChange={(roughClearing) => patch({ roughClearing, ...(roughClearing === 'adaptive' && cutter && op.roughClearing !== 'adaptive' ? { engagement: Number((cutter.diameter * 0.1).toFixed(3)) } : {}) }, ['passes'])}
            options={[{ value: 'offset' as const, label: 'Rings' }, { value: 'adaptive' as const, label: 'Adaptive' }]} />
        </Row>
        {op.roughClearing === 'adaptive' ? <>
          <Row label="Engagement" sub="widest cut" field="passes"><NumberField ariaLabel="Maximum radial engagement" value={op.engagement} min={0} step={0.1} onChange={(engagement) => patch({ engagement }, ['passes'])} /></Row>
          {cutter && <p className={styles.hint}>At most the cutter radius ({num(cutter.diameter / 2, 3)} mm) · {num((op.engagement / cutter.diameter) * 100, 0)}% of Ø. No move cuts wider, in corners and openings too; the check of the posted program proves it.</p>}
        </> : <>
          <Row label="Stepover" sub="between rings" field="passes"><NumberField ariaLabel="Stepover" value={op.stepover} min={0} onChange={(stepover) => patch({ stepover }, ['passes'])} /></Row>
          {cutter && <p className={styles.hint}>At most the cutter radius ({num(cutter.diameter / 2, 3)} mm) · {num((op.stepover / cutter.diameter) * 100, 0)}% of Ø</p>}
        </>}
        <Row label="Stepdown"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0} onChange={(stepdown) => patch({ stepdown }, ['passes'])} /></Row>
        <Row label="Direction">
          <Segmented size="sm" value={op.direction} onChange={(direction) => patch({ direction })} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} />
        </Row>
        <Row label="Leave on walls"><NumberField ariaLabel="Radial allowance" value={op.radialAllowance} min={0} step={0.05} onChange={(radialAllowance) => patch({ radialAllowance }, ['passes'])} /></Row>
        <Row label="Leave on floor"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} min={0} step={0.05} onChange={(axialAllowance) => patch({ axialAllowance }, ['passes', 'heights'])} /></Row>
        <Row label="Tolerance" sub="path"><NumberField ariaLabel="Clearing tolerance" value={op.clearingTolerance} min={0.00001} max={1} step={0.001} onChange={(clearingTolerance) => patch({ clearingTolerance }, ['passes'])} /></Row>
        <RoughRefusals problems={problems} field="passes" />
        <p className={styles.hint}>Depths of up to {num(op.stepdown)} mm from the top, the last at the bottom plus what’s left on the floor. {op.roughClearing === 'adaptive'
          ? `Passes follow the stock, loop where it’s too tight to turn, and cut ${op.direction === 'climb' ? 'climb' : 'conventional'} only; the walls are traced last.`
          : `Each ring is cut ${op.direction === 'climb' ? 'climb' : 'conventional'}, from the stock’s edge in.`}</p>
      </Section>
      <Section title="Entry" id="cam-linking">
        <FieldError field="linking" />
        <Row label="Entry">
          <Segmented size="sm" value={op.entry === 'helix' ? 'helix' : 'plunge'} onChange={(entry) => patch({ entry }, ['linking'])}
            options={[{ value: 'plunge' as const, label: 'From outside' }, { value: 'helix' as const, label: 'Helix' }].filter((item) => modes.includes(item.value) || item.value === op.entry)} />
        </Row>
        {op.entry === 'helix' && <RampHelixFields op={op} cutter={cutter} />}
        <RoughRefusals problems={problems} field="linking" />
        <p className={styles.hint}>{op.entry === 'helix'
          ? 'Rings are entered from outside the stock or from the ring just cut; an opening the part encloses (a hole, a cavity) is entered by a helix inside it.'
          : 'Rings are entered from outside the stock or from the ring just cut, never by plunging into material. An opening the part encloses that the cutter fits into stops the run: choose Helix for it.'}</p>
      </Section>
    </>
  );
}

/** Circular boring: entry, concentric passes outward, allowances and the finishing tolerance. */
function BoreSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const modes = entryModes('bore');
  return (
    <>
      <Section title="Boring" id="cam-boring">
        <FieldError field="boring" />
        <Row label="Entry">
          <Segmented size="sm" value={op.entry === 'helix' ? 'helix' : 'plunge'} onChange={(entry) => patch({ entry }, ['linking', 'boring'])}
            options={[{ value: 'plunge' as const, label: 'Plunge at centre' }, { value: 'helix' as const, label: 'Helix' }].filter((item) => modes.includes(item.value) || item.value === op.entry)} />
        </Row>
        <FieldError field="linking" />
        {op.entry === 'helix' && <RampHelixFields op={op} cutter={cutter} />}
        <Row label="Stepover" sub="each ring outward"><NumberField ariaLabel="Stepover" value={op.stepover} min={0} onChange={(stepover) => patch({ stepover }, ['passes', 'boring'])} /></Row>
        {cutter && <p className={styles.hint} data-tone={op.stepover > cutter.diameter / 2 ? 'warn' : undefined}>Up to the cutter radius ({num(cutter.diameter / 2, 3)} mm).</p>}
        <Row label="Stepdown"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0} onChange={(stepdown) => patch({ stepdown }, ['passes', 'boring'])} /></Row>
        <Row label="Direction"><Segmented size="sm" value={op.direction} onChange={(direction) => patch({ direction })} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} /></Row>
        <Row label="Leave on walls"><NumberField ariaLabel="Radial allowance" value={op.radialAllowance} min={0} step={0.05} onChange={(radialAllowance) => patch({ radialAllowance }, ['boring', 'geometry'])} /></Row>
        <Row label="Leave on floor"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} min={0} step={0.05} onChange={(axialAllowance) => patch({ axialAllowance }, ['boring'])} /></Row>
        <Row label="Tolerance" sub="finishing path"><NumberField ariaLabel="Bore tolerance" value={op.boreTolerance} min={0.0001} max={1} step={0.001} onChange={(boreTolerance) => patch({ boreTolerance }, ['boring'])} /></Row>
        <p className={styles.hint}>Concentric passes outward at each depth, then a full finishing circle; a picked bore the cutter fills (a counterbore) is plunged at its centre instead, over by at most the tolerance. Circles are posted as short straight moves (no G2/G3, no boring cycle). For a through bore, set the bottom below the part.</p>
      </Section>
    </>
  );
}

/** Rest machining: which operation's actual remaining stock it cleans up, and what that means. */
function RestSection({ op }: { op: OperationDraft }) {
  const programId = useCam((state) => state.editor?.programId ?? null);
  const record = useMfg((state) => state.programs.find((item) => item.id === programId));
  const setupId = useCam((state) => state.editor?.draft.setup.id);
  const before = previousOperation(record?.compiled, op.id, setupId);
  return (
    <Section title="Remaining stock" id="cam-rest">
      <FieldError field="rest" />
      <Row label="After">
        <span className={styles.ref} id="cam-rest-from" data-empty={!before || undefined}>
          <span>{before ? `${before.name} (${OP_LABEL[before.kind]})` : 'Add the pocket first'}</span>
        </span>
      </Row>
      <p className={styles.hint}>A smaller cutter follows the pocket paths again, but only where the stock that <b>{before?.name ?? 'the operation before'}</b> actually left still has material: corners its larger cutter couldn’t reach. Air the engine proves empty is skipped; anything uncertain is cut.</p>
      <p className={styles.hint}>It always runs right after that operation, on its real stock, so generate it with the whole program. It enters with a plunge.</p>
    </Section>
  );
}

/** Contour retention tabs: bridges left between the part and the stock, placed on straight stretches of the outline. */
function TabsSection({ op }: { op: OperationDraft }) {
  const picking = useCam((state) => state.picking);
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const setTab = (index: number, change: Partial<TabDraft>) => patch({ tabs: op.tabs.map((tab, at) => (at === index ? { ...tab, ...change } : tab)) }, ['tabs']);
  // Saved tabs come back without their direction: find it from the displayed edge through each centre (drawing only).
  useEffect(() => {
    if (!op.tabs.some((tab) => tab.angle === null)) return;
    const angles = op.tabs.map((tab) => (tab.angle === null ? tabAngleAt(tab.center) : tab.angle));
    if (angles.some((angle, index) => angle !== op.tabs[index].angle)) updateDraft((d) => ({ ...d, op: { ...d.op, tabs: d.op.tabs.map((tab, index) => ({ ...tab, angle: angles[index] ?? tab.angle })) } }));
  }, [op.tabs.length, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section title={`Tabs${op.tabs.length ? ` (${op.tabs.length})` : ''}`} id="cam-tabs" defaultOpen={op.tabs.length > 0}>
      <FieldError field="tabs" />
      <div className={styles.ref} data-empty={!op.tabs.length || undefined} data-picking={picking === 'tabs' || undefined} id="cam-tabs-pick">
        <span>{picking === 'tabs' ? 'Click straight outline edges: a tab goes at each edge’s middle (click again to remove)…' : op.tabs.length ? `${op.tabs.length} tab${op.tabs.length === 1 ? '' : 's'}` : 'No tabs: the part comes free at the last depth'}</span>
        <button type="button" className={styles.iconBtn} id="cam-pick-tabs" aria-label={picking === 'tabs' ? 'Done placing tabs' : 'Place tabs'} title={picking === 'tabs' ? 'Done placing tabs' : 'Place tabs'} onClick={() => startPicking('tabs')}><Crosshair size={13} /></button>
      </div>
      {op.tabs.length > 0 && (
        <ol className={styles.holes} id="cam-tab-list">
          {op.tabs.map((tab, index) => (
            <li key={tab.id} data-tab={tab.id} className={styles.tabItem}>
              <span>{index + 1}.</span>
              <div className={styles.tabFields}>
                <NumberField ariaLabel={`Tab ${index + 1} X`} prefix="X" prefixColor="var(--axis-x)" value={tab.center[0]} onChange={(x) => setTab(index, { center: [x, tab.center[1]] })} />
                <NumberField ariaLabel={`Tab ${index + 1} Y`} prefix="Y" prefixColor="var(--axis-y)" value={tab.center[1]} onChange={(y) => setTab(index, { center: [tab.center[0], y] })} />
                <NumberField ariaLabel={`Tab ${index + 1} width`} prefix="W" value={tab.width} min={0.01} step={0.5} onChange={(width) => setTab(index, { width })} />
                <NumberField ariaLabel={`Tab ${index + 1} height`} prefix="H" value={tab.height} min={0.01} step={0.1} onChange={(height) => setTab(index, { height })} />
              </div>
              <button type="button" className={styles.iconBtn} aria-label={`Remove tab ${index + 1}`} onClick={() => patch({ tabs: op.tabs.filter((_, at) => at !== index) }, ['tabs'])}><Trash2 size={12} /></button>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.hint}>Each tab is a rectangular bridge {op.tabs[0] ? `${num(op.tabs[0].width, 2)} mm` : ''} along the outline, its height above the bottom{op.axialAllowance ? ' and floor allowance' : ''}. It must sit on one straight stretch away from corners and reach stock past every pass. At each tab the cutter lifts over it at every depth; the engine checks the bridges survive the posted program.</p>
    </Section>
  );
}

/**
 * Repeat the operation (docs/MANUFACTURING_PATTERNS.md): a linear grid, a circle about a centre, or explicit placements,
 * in setup XY. The engine moves the seed selection to each instance and finds the identical feature there on the actual
 * part, then plans and checks every instance on its own, each on the stock the one before leaves. Instances can be left
 * out; their IDs come from the engine.
 */
function PatternSection({ op, draft }: { op: OperationDraft; draft: ProgramDraft }) {
  const version = useGeometryVersion();
  useCam((state) => state.capabilities);  // Re-render when what the engine runs arrives.
  const seed = useMemo(() => patternSeed(op), [op.floor, op.holes, op.contourFaces, op.contourEdges, op.engravePaths, op.slotGuides, op.contourMode, op.kind, op.top, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = patternKinds(op.kind).filter((kind): kind is PatternKind => kind in PATTERN_LABEL);
  const pattern = op.pattern;
  if (!patternable(op.kind) || (!kinds.length && !pattern)) return null;
  const set = (next: PatternDraft | null) => updateDraft((d) => ({ ...d, op: { ...d.op, pattern: next } }), ['pattern']);
  const patch = (change: Partial<PatternDraft>) => pattern && set({ ...pattern, ...change });
  const instances = pattern ? instancesOf(pattern) : [];
  const active = pattern ? activeInstances(pattern) : [];
  const problem = pattern ? patternProblem(pattern) : null;
  const stockCentre: [number, number] = [Number(((draft.setup.stockMin[0] + draft.setup.stockMax[0]) / 2).toFixed(3)), Number(((draft.setup.stockMin[1] + draft.setup.stockMax[1]) / 2).toFixed(3))];
  const toggle = (key: string) => pattern && patch({ suppress: pattern.suppress.includes(key) ? pattern.suppress.filter((item) => item !== key) : [...pattern.suppress, key] });
  const setPlacement = (index: number, change: Partial<PlacementDraft>) => pattern && patch({ placements: pattern.placements.map((item, at) => (at === index ? { ...item, ...change } : item)) });
  const overrides = pattern ? Object.keys(pattern.overrides).length : 0;
  const count = (value: number) => Math.max(1, Math.round(value));
  return (
    <Section title={pattern ? `Pattern · ${active.length} of ${instances.length}` : 'Pattern'} id="cam-pattern" defaultOpen={!!pattern}>
      <FieldError field="pattern" />
      <Row label="Repeat">
        <Segmented size="sm" value={pattern?.kind ?? 'none'}
          onChange={(value) => set(value === 'none' ? null : pattern ? switchPattern(pattern, value as PatternKind) : newPattern(value as PatternKind, stockCentre))}
          options={[{ value: 'none', label: 'Once' }, ...kinds.map((kind) => ({ value: kind, label: PATTERN_LABEL[kind] }))]} />
      </Row>
      {pattern?.kind === 'linear' && (
        <>
          <Row label="Along U" sub="instances"><NumberField ariaLabel="Pattern count U" unit="×" step={1} min={1} value={pattern.countU} onChange={(value) => patch({ countU: count(value) })} /></Row>
          <Row label="Spacing U" sub="each step, X Y">
            <div className={styles.pair}>
              <NumberField ariaLabel="Pattern spacing U X" prefix="X" prefixColor="var(--axis-x)" value={pattern.stepU[0]} onChange={(x) => patch({ stepU: [x, pattern.stepU[1]] })} />
              <NumberField ariaLabel="Pattern spacing U Y" prefix="Y" prefixColor="var(--axis-y)" value={pattern.stepU[1]} onChange={(y) => patch({ stepU: [pattern.stepU[0], y] })} />
            </div>
          </Row>
          <Row label="Along V" sub="a second direction"><NumberField ariaLabel="Pattern count V" unit="×" step={1} min={1} value={pattern.countV} onChange={(value) => patch({ countV: count(value) })} /></Row>
          {pattern.countV > 1 && (
            <Row label="Spacing V" sub="each step, X Y">
              <div className={styles.pair}>
                <NumberField ariaLabel="Pattern spacing V X" prefix="X" prefixColor="var(--axis-x)" value={pattern.stepV[0]} onChange={(x) => patch({ stepV: [x, pattern.stepV[1]] })} />
                <NumberField ariaLabel="Pattern spacing V Y" prefix="Y" prefixColor="var(--axis-y)" value={pattern.stepV[1]} onChange={(y) => patch({ stepV: [pattern.stepV[0], y] })} />
              </div>
            </Row>
          )}
          <p className={styles.hint}>Spacing is the move from one instance to the next (any direction in XY). U varies first.</p>
        </>
      )}
      {pattern?.kind === 'circular' && (
        <>
          <Row label="Count"><NumberField ariaLabel="Pattern count" unit="×" step={1} min={1} max={1000} value={pattern.count} onChange={(value) => patch({ count: count(value) })} /></Row>
          <Row label="Centre" sub="turned about">
            <div className={styles.pair}>
              <NumberField ariaLabel="Pattern centre X" prefix="X" prefixColor="var(--axis-x)" value={pattern.center[0]} onChange={(x) => patch({ center: [x, pattern.center[1]] })} />
              <NumberField ariaLabel="Pattern centre Y" prefix="Y" prefixColor="var(--axis-y)" value={pattern.center[1]} onChange={(y) => patch({ center: [pattern.center[0], y] })} />
            </div>
          </Row>
          <div className={styles.quick}>
            <button type="button" id="cam-pattern-centre-stock" onClick={() => patch({ center: stockCentre })}>Stock centre ({num(stockCentre[0], 2)}, {num(stockCentre[1], 2)})</button>
            <button type="button" onClick={() => patch({ center: [0, 0] })}>Origin</button>
          </div>
          <Row label="Angle step" sub="counterclockwise +"><NumberField ariaLabel="Pattern angle step" unit="°" step={5} value={pattern.angleStepDeg} onChange={(angleStepDeg) => patch({ angleStepDeg })} /></Row>
          <div className={styles.quick}>
            <button type="button" id="cam-pattern-full-turn" onClick={() => patch({ angleStepDeg: Number((360 / pattern.count).toFixed(9)) })}>Spread evenly ({num(360 / pattern.count, 3)}°)</button>
            <button type="button" onClick={() => patch({ angleStepDeg: -pattern.angleStepDeg })}>Reverse</button>
          </div>
        </>
      )}
      {pattern?.kind === 'placements' && (
        <>
          <ol className={styles.holes} id="cam-pattern-placements">
            {pattern.placements.map((item, index) => (
              <li key={index} className={styles.tabItem} data-placement={item.key}>
                <input className={styles.text} style={{ width: 48 }} aria-label={`Placement ${index + 1} name`} value={item.key} onChange={(event) => setPlacement(index, { key: event.target.value.trim() })} />
                <div className={styles.tabFields}>
                  <NumberField ariaLabel={`Placement ${index + 1} X`} prefix="X" prefixColor="var(--axis-x)" value={item.translation[0]} onChange={(x) => setPlacement(index, { translation: [x, item.translation[1]] })} />
                  <NumberField ariaLabel={`Placement ${index + 1} Y`} prefix="Y" prefixColor="var(--axis-y)" value={item.translation[1]} onChange={(y) => setPlacement(index, { translation: [item.translation[0], y] })} />
                  <NumberField ariaLabel={`Placement ${index + 1} angle`} unit="°" step={5} value={item.angleDeg} onChange={(angleDeg) => setPlacement(index, { angleDeg })} />
                </div>
                <button type="button" className={styles.iconBtn} aria-label={`Remove placement ${index + 1}`} disabled={pattern.placements.length === 1} onClick={() => patch({ placements: pattern.placements.filter((_, at) => at !== index) })}><Trash2 size={12} /></button>
              </li>
            ))}
          </ol>
          <Button size="sm" variant="ghost" icon={<Plus />} id="cam-pattern-add-placement" onClick={() => {
            const used = new Set(pattern.placements.map((item) => item.key));
            let n = pattern.placements.length + 1;
            while (used.has(`p${n}`)) n += 1;
            const last = pattern.placements.at(-1);
            patch({ placements: [...pattern.placements, { key: `p${n}`, translation: last ? [last.translation[0] + 20, last.translation[1]] : [0, 0], center: seed.anchor ?? [0, 0], angleDeg: 0 }] });
          }}>Add placement</Button>
          <p className={styles.hint}>Each placement turns the seed by its angle about the seed’s centre, then moves it by X Y. Include one at 0, 0 to keep the seed itself.</p>
        </>
      )}
      {pattern && (
        <>
          <div className={styles.instances} id="cam-pattern-instances">
            {instances.map((instance, index) => {
              const off = pattern.suppress.includes(instance.key);
              return (
                <button key={instance.key} type="button" data-instance={instance.key} data-off={off || undefined} data-seed={index === 0 || undefined} aria-pressed={!off}
                  title={off ? `${instance.key} is left out: click to include it` : `Click to leave ${instance.key} out`} onClick={() => toggle(instance.key)}>{instance.key}</button>
              );
            })}
          </div>
          {problem && <p className={styles.hint} data-tone="warn" id="cam-pattern-problem">{problem}</p>}
          {!patternSeedNamed(op) && <p className={styles.hint} data-tone="warn" id="cam-pattern-unnamed">A pattern finds each instance’s feature from the seed: pick the seed’s {takesHoles(op.kind) ? 'hole walls' : op.kind === 'contour' || op.kind === 'chamfer' ? 'faces or edges' : 'floor face'} (a whole-part selection can’t be matched instance by instance).</p>}
          {overrides > 0 && <p className={styles.hint}>{overrides} instance{overrides === 1 ? ' uses its' : 's use their'} own targets (set in the program’s code); they’re kept as they are.</p>}
          <p className={styles.hint}>The engine moves the seed to each instance and finds the identical feature there on the actual part; then each instance is planned and checked on its own, on the stock the one before leaves. Generating runs {active.length === 1 ? 'it' : `all ${active.length}`}. Click a name to leave that instance out.</p>
        </>
      )}
    </Section>
  );
}

/** 3D finishing selects one whole body; parallel can be kept inside a rectangle of cutter-centre positions. */
function SurfaceGeometry({ op }: { op: OperationDraft }) {
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const bounds = useMemo(() => (op.target ? bodyBounds(op.target) : null), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const partRect = (): [number, number, number, number] => (bounds
    ? [Number(bounds.min.x.toFixed(3)), Number(bounds.min.y.toFixed(3)), Number(bounds.max.x.toFixed(3)), Number(bounds.max.y.toFixed(3))] : [0, 0, 10, 10]);
  const rect = op.surfaceBounds;
  const setCorner = (index: number, value: number) => { if (!rect) return; const next = [...rect] as [number, number, number, number]; next[index] = value; patch({ surfaceBounds: next }, ['surface']); };
  return (
    <Section title="Geometry" id="cam-geometry">
      <FieldError field="geometry" />
      <BodyRow op={op} />
      <p className={styles.hint}>3D finishing works over the <b>whole body</b>: the ball follows every surface it can reach from above{op.kind === 'parallel' ? ', inside the boundary' : ''}. The engine doesn’t take single faces for it.</p>
      {op.kind === 'parallel' && (
        <>
          <Row label="Boundary" sub="where the cutter’s centre may go" field="surface">
            <Segmented size="sm" value={rect ? 'rect' : 'part'} onChange={(value) => patch({ surfaceBounds: value === 'part' ? null : partRect() }, ['surface'])}
              options={[{ value: 'part', label: 'Part outline' }, { value: 'rect', label: 'Rectangle' }]} />
          </Row>
          {rect && (
            <div id="cam-surface-bounds">
              <Row label="From"><div className={styles.pair}>
                <NumberField ariaLabel="Boundary X min" prefix="X" prefixColor="var(--axis-x)" value={rect[0]} onChange={(value) => setCorner(0, value)} />
                <NumberField ariaLabel="Boundary Y min" prefix="Y" prefixColor="var(--axis-y)" value={rect[1]} onChange={(value) => setCorner(1, value)} />
              </div></Row>
              <Row label="To"><div className={styles.pair}>
                <NumberField ariaLabel="Boundary X max" prefix="X" prefixColor="var(--axis-x)" value={rect[2]} onChange={(value) => setCorner(2, value)} />
                <NumberField ariaLabel="Boundary Y max" prefix="Y" prefixColor="var(--axis-y)" value={rect[3]} onChange={(value) => setCorner(3, value)} />
              </div></Row>
              <div className={styles.quick}>{bounds && <button type="button" onClick={() => patch({ surfaceBounds: partRect() }, ['surface'])}>Part bounds</button>}</div>
              {!(rect[0] < rect[2] && rect[1] < rect[3]) && <p className={styles.hint} data-tone="warn">The maximum X and Y must be above the minimum.</p>}
              <p className={styles.hint}>Setup XY, for the cutter’s centre (not its edge). It limits where rows run; the clearance check still covers the whole part.</p>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Parallel or waterline settings: row spacing and scan (parallel) or level spacing and loop direction (waterline), the
 * normal allowance and the path tolerance. The cusp heights shown are estimates for a ball of this size; the engine's
 * checks cover path coverage and clearance, not scallops.
 */
function SurfaceSection({ op, cutter }: { op: OperationDraft; cutter: ReturnType<typeof cutterOf> }) {
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const radius = cutter ? cutter.diameter / 2 : null;
  const cusp = (spacing: number) => (radius && spacing > 0 && spacing <= 2 * radius ? radius - Math.sqrt(radius * radius - (spacing / 2) ** 2) : null);
  const parallel = op.kind === 'parallel';
  return (
    <Section title={parallel ? 'Parallel finishing' : 'Waterline finishing'} id="cam-surface">
      <FieldError field="surface" />
      <FieldError field="passes" />
      <EnginePreviewNote op={op} />
      {parallel ? (
        <>
          <Row label="Stepover" sub="between rows" field="passes"><NumberField ariaLabel="Stepover" value={op.stepover} min={0.001} step={0.1} onChange={(stepover) => patch({ stepover }, ['passes', 'surface'])} /></Row>
          {cutter && (
            <p className={styles.hint} data-tone={op.stepover > cutter.diameter ? 'warn' : undefined} id="cam-cusp">
              {op.stepover > cutter.diameter ? `Up to the ball’s diameter (${num(cutter.diameter, 3)} mm).`
                : `≈ ${num(cusp(op.stepover) ?? 0, 4)} mm cusps on flat areas with this Ø${num(cutter.diameter, 2)} ball; steeper areas get taller ones (finish them with waterline). An estimate: the checks don’t measure cusps.`}
            </p>
          )}
          <Row label="Rows along"><Segmented size="sm" value={op.surfaceAxis} onChange={(surfaceAxis) => patch({ surfaceAxis }, ['surface'])} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]} /></Row>
          <Row label="Rows"><Segmented size="sm" value={op.surfacePassMode} onChange={(surfacePassMode) => patch({ surfacePassMode }, ['surface'])} options={[{ value: 'zigzag', label: 'Zigzag' }, { value: 'one_way', label: 'One way' }]} /></Row>
          <Row label="Stepdown" sub="most depth per pass" field="passes"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0.001} onChange={(stepdown) => patch({ stepdown }, ['passes', 'surface'])} /></Row>
          <p className={styles.hint}>Rows across the part at the stepover, the ball riding the surface; where material is still deep, passes step down to it first. Best on shallow areas.</p>
        </>
      ) : (
        <>
          <Row label="Stepdown" sub="between levels" field="passes"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0.001} step={0.1} onChange={(stepdown) => patch({ stepdown }, ['passes', 'surface'])} /></Row>
          {cutter && (
            <p className={styles.hint} id="cam-cusp">≈ {num(cusp(op.stepdown) ?? 0, 4)} mm cusps on vertical walls with this Ø{num(cutter.diameter, 2)} ball; gentler slopes get taller ones (finish them with parallel). An estimate: the checks don’t measure cusps.</p>
          )}
          <Row label="Direction">
            <Segmented size="sm" value={op.direction} onChange={(direction) => patch({ direction }, ['surface'])} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} />
          </Row>
          <p className={styles.hint}>Levels from the top down to the bottom height, each following closed loops around the part (islands and holes too). Best on steep walls; it finishes, it doesn’t rough out the stock.</p>
        </>
      )}
      <Row label="Leave on the part" sub="normal allowance"><NumberField ariaLabel="Surface allowance" value={op.surfaceAllowance} min={0} step={0.05} onChange={(surfaceAllowance) => patch({ surfaceAllowance }, ['surface'])} /></Row>
      <Row label="Path tolerance"><NumberField ariaLabel="Surface tolerance" value={op.surfaceTolerance} min={0.0001} max={1} step={0.005} onChange={(surfaceTolerance) => patch({ surfaceTolerance }, ['surface'])} /></Row>
      <p className={styles.hint}>How closely each path follows the surface, not how small the cusps between paths are. Plunge entry; rapids at the clearance height.</p>
    </Section>
  );
}

function OperationTab({ draft }: { draft: ProgramDraft }) {
  const op = draft.op;
  const tooling = useCam((state) => state.tooling);
  const errors = useCam((state) => state.editor?.errors ?? NO_ERRORS);
  const version = useGeometryVersion();
  const patch = (change: Partial<OperationDraft>, clear: string[] = []) => updateDraft((d) => ({ ...d, op: { ...d.op, ...change } }), clear);
  const cutter = cutterOf(tooling, op.assignment);
  const cutterPin = tooling?.assignments.find((item) => item.assignment === op.assignment)?.tool.components.find((component) => component.kind === 'rotary_cutter');
  // A preset pins its material revision, and the setup must cut that one: binding a preset binds its material too.
  const bindPreset = (preset: Pin | null, material: Pin | null, rates: Partial<OperationDraft> = {}) => updateDraft((d) => {
    const name = material && !d.setup.material.trim() ? useMfg.getState().records.find((record) => record.id === material.id)?.definition.name : undefined;
    return { ...d, op: { ...d.op, preset, ...rates }, setup: material ? { ...d.setup, machiningMaterial: material, ...(name ? { material: name } : {}) } : d.setup };
  }, ['feeds', 'material']);
  const stockTop = draft.setup.stockMax[2];
  const drilling = isDrilling(op.kind);
  const holes = takesHoles(op.kind);
  const programId = useCam((state) => state.editor?.programId ?? null);
  const record = useMfg((state) => state.programs.find((item) => item.id === programId));
  // After a facing earlier in the program, later operations can start at the faced height (the engine checks it).
  const faced = op.kind === 'face' ? null : facedTop(record?.compiled, op.id, draft.setup.id);
  const bounds = useMemo(() => (op.target ? bodyBounds(op.target) : null), [op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const holeBottoms = useMemo(() => (holes && op.target ? [...new Set(bodyHoles(op.target).map((hole) => Number(hole.zMin.toFixed(3))))] : []), [holes, op.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const depth = op.top - op.bottom;
  const rough = op.kind === 'rough';
  const roughFrom = rough ? roughStart(draft) : null;
  const problems = rough ? roughProblems(op, cutter, roughFrom) : [];
  const above = rough && bounds ? aboveThePart(op, roughFrom, bounds.max.z) : null;
  const pointHeight = cutter?.pointAngleDeg ? Math.max(0, (cutter.diameter - (cutter.tipDiameter ?? 0)) / 2 / Math.tan((cutter.pointAngleDeg / 2) * Math.PI / 180)) : 0;
  return (
    <>
      <ToolSection op={op} draft={draft} />
      {op.kind === 'rest' && <RestSection op={op} />}
      {rough ? <RoughGeometry op={op} above={above} /> : isPocketing(op.kind) ? <PocketGeometry op={op} /> : op.kind === 'slot' ? <SlotGeometry op={op} cutter={cutter} /> : op.kind === 'face' ? <FaceGeometry op={op} />
        : op.kind === 'contour' ? <ContourGeometry op={op} /> : op.kind === 'engrave' ? <EngraveGeometry op={op} /> : op.kind === 'chamfer' ? <ChamferGeometry op={op} />
        : isSurface(op.kind) ? <SurfaceGeometry op={op} /> : <DrillGeometry op={op} cutter={cutter} />}
      <PatternSection op={op} draft={draft} />

      <Section title="Heights" id="cam-heights">
        <FieldError field="heights" />
        <p className={styles.note}>Work Z (program zero is the design origin). {faced !== null ? `After the facing, this can start at the faced height (Z ${num(faced)}); the engine checks the actual stock it left.` : 'The first cut starts at the stock top; later ones can start where an earlier facing leaves it.'}</p>
        <Row label="Clearance" field="heights"><NumberField ariaLabel="Clearance height" value={op.clearance} onChange={(clearance) => patch({ clearance }, ['heights'])} /></Row>
        <div className={styles.quick}><button type="button" onClick={() => patch({ clearance: Number((stockTop + 5).toFixed(3)) }, ['heights'])}>Stock top + 5</button></div>
        {drilling && (
          <>
            <Row label="Retract" sub="between holes and pecks">
              <div className={styles.inline}>
                <Segmented size="sm" value={op.retract === null ? 'clearance' : 'own'} onChange={(value) => patch({ retract: value === 'clearance' ? null : Number((stockTop + 2).toFixed(3)) }, ['drilling'])}
                  options={[{ value: 'clearance', label: 'Clearance' }, { value: 'own', label: 'Own height' }]} />
                {op.retract !== null && <NumberField ariaLabel="Retract height" value={op.retract} onChange={(retract) => patch({ retract }, ['drilling'])} />}
              </div>
            </Row>
            {op.retract !== null && (op.retract <= op.top || op.retract > op.clearance) && <p className={styles.hint} data-tone="warn">The retract plane sits above the top and at or below the clearance.</p>}
          </>
        )}
        <Row label="Top"><NumberField ariaLabel="Top height" value={op.top} onChange={(top) => patch({ top }, ['heights'])} /></Row>
        <div className={styles.quick}>
          <button type="button" onClick={() => patch({ top: stockTop }, ['heights'])}>Stock top ({num(stockTop)})</button>
          {faced !== null && faced < stockTop && <button type="button" id="cam-top-faced" onClick={() => patch({ top: faced, clearance: Math.max(op.clearance, Number((faced + 5).toFixed(3))) }, ['heights'])}>Faced top ({num(faced)})</button>}
        </div>
        {op.kind === 'chamfer' ? (
          <Row label="Bottom" sub="the chamfer’s lower edge">
            <span className={styles.derived} id="cam-chamfer-bottom">Z {num(op.bottom, 4)} · from the edge, width and cutter</span>
          </Row>
        ) : (
          <Row label={op.kind === 'face' ? 'Finished height' : isSurface(op.kind) ? 'Lowest tip' : 'Bottom'} sub={isSurface(op.kind) ? 'the ball rises over the part' : undefined}>
            <NumberField ariaLabel="Bottom height" value={op.bottom} onChange={(bottom) => patch({ bottom, floor: op.floor && Math.abs(op.floor.z - bottom) > 1e-6 ? null : op.floor }, ['heights', 'geometry'])} />
          </Row>
        )}
        <div className={styles.quick}>
          {op.kind === 'face' && bounds && <button type="button" onClick={() => patch({ bottom: Number(bounds.max.z.toFixed(6)) }, ['heights'])}>Part top ({num(bounds.max.z)})</button>}
          {(op.kind === 'contour' || op.kind === 'rough' || isSurface(op.kind)) && bounds && <button type="button" onClick={() => patch({ bottom: Number(bounds.min.z.toFixed(6)) }, ['heights'])}>Part bottom ({num(bounds.min.z)})</button>}
          {op.kind === 'contour' && op.contourMode === 'edges' && op.contourEdges[0] && <button type="button" onClick={() => patch({ bottom: Number(op.contourEdges[0].z.toFixed(6)) }, ['heights'])}>Edge plane ({num(op.contourEdges[0].z)})</button>}
          {holes && holeBottoms.map((z) => <button key={z} type="button" onClick={() => patch({ bottom: z }, ['heights'])}>{op.kind === 'bore' ? 'Bore' : 'Hole'} bottom {num(z)}</button>)}
          {op.kind === 'bore' && bounds && <button type="button" onClick={() => patch({ bottom: Number((bounds.min.z - 0.5).toFixed(3)) }, ['heights'])}>Through ({num(bounds.min.z - 0.5)})</button>}
        </div>
        {op.kind === 'face' && op.top <= op.bottom && <p className={styles.hint} data-tone="warn">The finished height is at or above the top (Z {num(op.top)}): facing removes nothing. Set it below the top.</p>}
        <RoughRefusals problems={problems} field="heights" />
        {!drilling && !rough && depth > 0 && cutter && depth > cutter.cuttingLength && <p className={styles.hint} data-tone="warn">Depth {num(depth)} mm is past the {num(cutter.cuttingLength, 2)} mm flutes.</p>}
        {drilling && cutter && depth + (op.depthRef === 'full_diameter' ? pointHeight : 0) + op.breakthrough > cutter.cuttingLength && (
          <p className={styles.hint} data-tone="warn">The drill reaches {num(depth + (op.depthRef === 'full_diameter' ? pointHeight : 0) + op.breakthrough)} mm into the stock (with its point); its flutes are {num(cutter.cuttingLength, 2)} mm.</p>
        )}
      </Section>

      {op.kind === 'engrave' ? <EngraveSection op={op} cutter={cutter} /> : op.kind === 'chamfer' ? <ChamferSection op={op} cutter={cutter} /> : isSurface(op.kind) ? <SurfaceSection op={op} cutter={cutter} />
        : op.kind === 'bore' ? <BoreSection op={op} cutter={cutter} /> : rough ? <RoughSection op={op} cutter={cutter} problems={problems} /> : drilling ? (
        <Section title="Drilling" id="cam-drilling">
          <FieldError field="drilling" />
          <Row label="Cycle">
            <Segmented size="sm" value={op.kind} onChange={(kind) => patch({ kind: kind as OpKind }, ['drilling'])} options={[{ value: 'drill', label: 'Drill' }, { value: 'peck_drill', label: 'Peck' }]} />
          </Row>
          {op.kind === 'peck_drill' && (
            <>
              <Row label="Peck" sub="each step down"><NumberField ariaLabel="Peck depth" value={op.peck} min={0.01} step={0.5} onChange={(peck) => patch({ peck }, ['drilling'])} /></Row>
              <Row label="Re-entry" sub="above the last peck"><NumberField ariaLabel="Re-entry margin" value={op.reentry} min={0.001} step={0.05} onChange={(reentry) => patch({ reentry }, ['drilling'])} /></Row>
              <p className={styles.hint}>Each peck goes back up to the retract plane, then rapids down to just above the last depth.</p>
            </>
          )}
          <Row label="Depth to" sub="where the bottom height is on the drill">
            <Segmented size="sm" value={op.depthRef} onChange={(depthRef) => patch({ depthRef }, ['drilling'])} options={[{ value: 'full_diameter', label: 'Full diameter' }, { value: 'tip', label: 'Tip' }]} />
          </Row>
          <DepthDiagram value={op.depthRef} />
          <p className={styles.hint}>{op.depthRef === 'tip'
            ? 'The point’s end reaches the bottom height: for blind holes with a cone at the bottom.'
            : `The full diameter reaches the bottom height; the point${pointHeight ? ` (${num(pointHeight, 2)} mm)` : ''} goes below it: through holes, or a flat-bottomed hole that can take it.`}</p>
          <Row label="Breakthrough" sub="past the bottom"><NumberField ariaLabel="Breakthrough" value={op.breakthrough} min={0} step={0.1} onChange={(breakthrough) => patch({ breakthrough, axialAllowance: breakthrough > 0 ? 0 : op.axialAllowance }, ['drilling'])} /></Row>
          <Row label="Leave at the bottom" sub="axial allowance"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} min={0} step={0.1} onChange={(axialAllowance) => patch({ axialAllowance, breakthrough: axialAllowance > 0 ? 0 : op.breakthrough }, ['drilling'])} /></Row>
          {(op.breakthrough > 0 || op.axialAllowance > 0) && <p className={styles.hint}>Breakthrough and a bottom allowance can’t both be set: {op.breakthrough > 0 ? 'the allowance is off.' : 'breakthrough is off.'}</p>}
          <Row label="Radial allowance" sub="holes larger than the drill"><NumberField ariaLabel="Radial allowance" value={op.radialAllowance} min={0} step={0.05} onChange={(radialAllowance) => patch({ radialAllowance }, ['drilling', 'geometry'])} /></Row>
          <Row label="Tolerance" sub="hole size, position"><NumberField ariaLabel="Drilling tolerance" value={op.tolerance} min={0.00001} max={1} step={0.001} onChange={(tolerance) => patch({ tolerance }, ['drilling', 'geometry'])} /></Row>
          <p className={styles.hint}>Straight moves are posted (no G81/G83 canned cycles); the output is checked as posted.</p>
        </Section>
      ) : (
        <Section title="Passes" id="cam-passes">
          <FieldError field="passes" />
          {op.kind !== 'contour' && <Row label="Stepover" field="passes"><NumberField ariaLabel="Stepover" value={op.stepover} min={0} onChange={(stepover) => patch({ stepover }, ['passes'])} /></Row>}
          {op.kind !== 'contour' && cutter && <p className={styles.hint} data-tone={op.stepover > cutter.diameter / 2 ? 'warn' : undefined}>Up to the cutter radius ({num(cutter.diameter / 2, 3)} mm) · {num((op.stepover / cutter.diameter) * 100, 0)}% of Ø</p>}
          <Row label="Stepdown"><NumberField ariaLabel="Stepdown" value={op.stepdown} min={0} onChange={(stepdown) => patch({ stepdown }, ['passes'])} /></Row>
          <Row label="Direction">
            <Segmented size="sm" value={op.direction} onChange={(direction) => patch({ direction })} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} />
          </Row>
          {op.kind === 'contour' ? (
            <>
              <Row label="Leave on walls"><NumberField ariaLabel="Radial allowance" value={op.radialAllowance} min={0} onChange={(radialAllowance) => patch({ radialAllowance }, ['passes'])} /></Row>
              <Row label="Leave on floor"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} min={0} onChange={(axialAllowance) => patch({ axialAllowance }, ['passes'])} /></Row>
              <p className={styles.hint}>Successive depths of up to {num(op.stepdown)} mm from the top down to the bottom height.</p>
            </>
          ) : op.kind === 'face' ? (
            <>
              <Row label="Passes along"><Segmented size="sm" value={op.faceAxis} onChange={(faceAxis) => patch({ faceAxis }, ['passes'])} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]} /></Row>
              <Row label="Overtravel" sub="past each end"><NumberField ariaLabel="Overtravel" value={op.overtravel} min={0} step={0.5} onChange={(overtravel) => patch({ overtravel }, ['passes'])} /></Row>
              <Row label="Leave on top"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} min={0} onChange={(axialAllowance) => patch({ axialAllowance }, ['passes'])} /></Row>
              <p className={styles.hint}>One-way passes at each depth; the tool goes down outside the stock and rapids at clearance.</p>
            </>
          ) : (
            <>
              <Row label="Leave on walls"><NumberField ariaLabel="Radial allowance" value={op.radialAllowance} onChange={(radialAllowance) => patch({ radialAllowance }, ['passes'])} /></Row>
              <Row label="Leave on floor"><NumberField ariaLabel="Axial allowance" value={op.axialAllowance} onChange={(axialAllowance) => patch({ axialAllowance }, ['passes'])} /></Row>
            </>
          )}
        </Section>
      )}

      {op.kind === 'contour' && <ContourSection op={op} cutter={cutter} />}
      {op.kind === 'contour' && (tabsSupported() || op.tabs.length > 0) && <TabsSection op={op} />}

      {op.kind === 'pocket' && <EntrySection op={op} cutter={cutter} />}
      {op.kind === 'slot' && <SlotSection op={op} cutter={cutter} />}

      <Section title="Feeds and speeds" id="cam-feeds">
        <FieldError field="feeds" />
        <PresetPicker cutter={cutterPin ? pinOf(cutterPin) : null} material={draft.setup.machiningMaterial} operation={op.kind} stickout={cutter?.stickout ?? null}
          current={{ rpm: op.rpm, feed: op.feed, plunge: drilling ? null : op.plunge }} value={op.preset}
          onChange={(record) => bindPreset(record ? pinOf(record) : null, record ? presetOf(record).material : null)}
          onApply={(values) => bindPreset(values.preset, values.material, {
            ...(values.rpm !== null && { rpm: values.rpm }), ...(values.feed !== null && { feed: values.feed }), ...(values.plunge !== null && !drilling && { plunge: values.plunge }),
          })} />
        <RoughRefusals problems={problems} field="feeds" />
        <Row label="Spindle"><NumberField ariaLabel="Spindle speed" unit="rpm" step={100} value={op.rpm} min={0} onChange={(rpm) => patch({ rpm }, ['feeds'])} /></Row>
        {cutter?.maxRpm && op.rpm > cutter.maxRpm && <p className={styles.hint} data-tone="warn">Above the tool’s {num(cutter.maxRpm, 0)} rpm.</p>}
        <Row label={drilling ? 'Drilling feed' : 'Cutting feed'}><NumberField ariaLabel="Cutting feed" unit="mm/min" step={10} value={op.feed} min={0} onChange={(feed) => patch({ feed }, ['feeds'])} /></Row>
        {!drilling && <Row label="Plunge feed"><NumberField ariaLabel="Plunge feed" unit="mm/min" step={10} value={op.plunge} min={0} onChange={(plunge) => patch({ plunge }, ['feeds'])} /></Row>}
        <p className={styles.hint}>{op.preset ? 'Every posted feed move is checked against the preset’s limits.' : 'Starting values only: set them for your material and tool, or choose a cutting preset.'}</p>
      </Section>

      <Section title="Check resolution" id="cam-cell" defaultOpen={!!errors.cell}>
        <FieldError field="cell" />
        <Row label="Stock cell"><NumberField ariaLabel="Stock check cell" value={op.cell} min={0.05} step={0.1} onChange={(cell) => patch({ cell }, ['cell'])} /></Row>
        <p className={styles.hint}>The stock check works on a grid of cubes this size, shared by every operation in the setup. It’s a resolution, not a promise that every error is smaller. Finer is slower and has a limit.</p>
      </Section>
    </>
  );
}

/** The kinds a new program can start with, in the ribbon's order (rest machining needs an operation before it). */
export default function ProgramEditor() {
  const editor = useCam((state) => state.editor);
  const engines = useCam((state) => state.engines);
  const enginesUnavailable = useCam((state) => state.enginesUnavailable);
  const picking = useCam((state) => state.picking);
  const saved = useMfg((state) => state.programs.find((item) => item.id === editor?.programId));
  const programsVersion = useMfg((state) => state.programs);
  useEffect(() => { if (engines === null) void loadEngines(); }, [engines]);
  // The part's selection data arrives after it's drawn: pick the new setup's part then, and keep part-sized stock true.
  const geometry = useGeometryVersion();
  useEffect(() => { geometryChanged(); }, [geometry]);
  // What the draft names, highlighted in the viewport while the editor is open (and not picking).
  const draft = editor?.draft;
  useEffect(() => {
    if (!draft || picking) return;
    setApp({ selection: picksFor({ floor: draft.op.floor, bodies: draft.setup.fixtures, holes: draft.op.holes, faces: draft.op.contourFaces, edges: draft.op.contourEdges }) });
  }, [draft?.op.floor, draft?.op.holes, draft?.op.contourFaces, draft?.op.contourEdges, draft?.setup.fixtures, picking]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = useMemo(() => setupChoices(), [programsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editor) return null;
  const { mode, busy, errors, conflict } = editor;
  const op = editor.draft.op;
  // Two tools: the Setup tool (a setup on its own) and each operation's tool (the operation, in the setup it names).
  const savedOp = !!saved && saved.compiled.operations.some((item) => (item as { id?: string }).id === op.id);
  const savedSetup = !!saved && (saved.compiled.setups as { id?: string }[]).some((item) => item.id === editor.draft.setup.id);
  const title = mode === 'setup' ? (savedSetup ? editor.draft.setup.name || 'Setup' : 'New setup') : savedOp ? OP_LABEL[op.kind] : `New ${opLabelLower(op.kind)}`;
  // A saved operation moves only within its program; a new one can go into any setup.
  const shown = mode === 'op' ? choices.filter((choice) => !savedOp || choice.programId === editor.programId) : [];
  const saveAndRun = async () => {
    const record = await saveProgram();
    if (record) void runOperation(record, op.id);
  };
  const escape = () => { if (!useCam.getState().picking) return false; stopPicking(); return true; };
  return (
    <Panel id="cam" icon={mode === 'setup' ? <SetupIcon size={16} /> : opIcon(op.kind)} title={title} onClose={closeEditor}
      footer={mode === 'setup'
        // A setup has nothing to generate: OK saves it.
        ? <ToolFooter onCancel={closeEditor} okBusy={busy} onEscape={escape} onOk={() => void saveProgram()} okId="cam-setup-ok" okTitle="Save the setup" />
        // OK saves the operation and, like a CAM operation dialog, generates its toolpaths (an operation that follows
        // others runs with them, on the stock they leave); "Save only" skips that.
        : <ToolFooter onCancel={closeEditor} okBusy={busy} onEscape={escape} onOk={() => void saveAndRun()} okId="cam-save-run" okTitle="Save, then generate toolpaths, post and check"
            extra={<Button size="sm" variant="ghost" id="cam-save" disabled={busy} onClick={() => void saveProgram()}>Save only</Button>} />}>
      <div className={styles.editor} id="cam-editor" data-mode={mode} data-kind={op.kind}>
        {mode === 'op' && (
          <>
            <div className={styles.row} style={{ marginTop: 8 }} id="cam-op-setup">
              <span>Setup</span>
              <Select ariaLabel="Setup" value={`${editor.programId}:${editor.draft.setup.id}`} onChange={(value) => {
                const choice = shown.find((item) => item.value === value);
                if (choice) chooseSetup(choice.programId, choice.setupId);
              }} options={shown.map(({ value, label }) => ({ value, label }))} />
            </div>
            <div className={styles.row}>
              <span>Name</span>
              <input className={styles.text} aria-label="Operation name" value={op.name} onChange={(event) => updateDraft((d) => ({ ...d, op: { ...d.op, name: event.target.value } }))} />
            </div>
          </>
        )}
        {engines && !engines.includes(NATIVE_FAMILY) && (
          <div className={styles.banner} data-tone="warn" style={{ margin: '8px 0 0' }} id="cam-no-engine"><Info size={14} /><span>{enginesUnavailable
            ? 'Toolpaths can’t be generated right now: machining is unavailable on this server. Setups and operations save; try generating again later.'
            : 'This server can’t generate milling toolpaths. Setups and operations save.'}</span></div>
        )}
        {conflict && (
          <div className={styles.banner} data-tone="warn" role="alert" style={{ margin: '8px 0 0' }} id="cam-conflict">
            <AlertTriangle size={14} />
            <div>
              <b>Revision {conflict.revision} was saved elsewhere</b> after the one you opened.
              <div className={styles.actions}>
                <Button size="sm" onClick={() => void resolveConflict('theirs')}>Open theirs</Button>
                <Button size="sm" variant="primary" onClick={() => void resolveConflict('mine')}>Save mine on top</Button>
              </div>
            </div>
          </div>
        )}
        {errors.form && <div className={styles.error} role="alert" data-field-error="form"><AlertTriangle size={13} /><span>{errors.form}</span><CopyMessage text={errors.form} /></div>}
        <div className={styles.body} style={{ margin: '0 -12px' }}>{mode === 'setup' ? <SetupTab draft={editor.draft} /> : <OperationTab draft={editor.draft} />}</div>
      </div>
    </Panel>
  );
}
