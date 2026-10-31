/**
 * Sheet metal read-outs: the Inspector section (rules, flat size, bend table, exports) and the flat
 * view floating over the canvas, which updates live with every preview build.
 */
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, Download, Info, Pencil, Ruler, ShieldQuestion, TriangleAlert, X } from 'lucide-react';
import { Button, IconButton, Section } from '@/ui';
import { set, useApp } from '@/state/store';
import { areaText, lengthNum, lengthText, num, type Units } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { editFeature } from '@/modeling/dialog';
import { DxfIcon, FlatPatternIcon, FormLibraryIcon } from '@/icons/cad';
import FlatView from './FlatView';
import { bodyLabel, chosenBody, exportBends, exportFlat, hoverBend, selectBend, toggleFlat, useSheetReport, useSheetView, type Diagnostic, type SheetBody, type SheetReport, type SheetRip } from './sheet';
import styles from './Sheet.module.css';

/** The feature that owns a bend row (a jog's rise and a contour's numbered walls belong to it). */
const featureOf = (bend: string) => bend.replace(/\.(rise|\d+)$/, '');

function BodyChoice({ report, body }: { report: SheetReport; body: SheetBody }) {
  if (report.bodies.length < 2) return null;
  return (
    <select className={styles.bodyChoice} value={body.id} aria-label="Sheet body" onChange={(event) => useSheetView.setState({ body: event.target.value })}>
      {report.bodies.map((item) => <option key={item.id} value={item.id}>{bodyLabel(item)}</option>)}
    </select>
  );
}

const size = (body: SheetBody, units: Units) => {
  const [x0, y0, x1, y1] = body.flat!.bounds_mm;
  return `${lengthNum(x1 - x0, units)} × ${lengthNum(y1 - y0, units)} ${units}`;
};

export function BendTable({ body }: { body: SheetBody }) {
  const hover = useSheetView((state) => state.hover);
  const units = useSetting('display.units');
  const direction = new Map((body.flat?.bends ?? []).map((bend) => [bend.id, bend.direction]));
  if (!body.bends.length) return <p className={styles.muted}>No bends yet: add an edge flange, hem or jog.</p>;
  return (
    <table className={styles.table} id="bend-table">
      <thead><tr><th>Bend</th><th>Angle</th><th>R</th><th title="Bend allowance: the developed length of the bend in the flat">BA</th><th aria-label="Edit" /></tr></thead>
      <tbody>
        {body.bends.map((bend) => {
          const dir = direction.get(bend.id) ?? (bend.angle_deg > 0 ? 'up' : 'down');
          return (
            <tr key={bend.id} data-bend-row={bend.id} data-hover={hover === bend.id || undefined} title="Click to select it in the view"
              onPointerEnter={() => hoverBend(bend.id)} onPointerLeave={() => hoverBend(null)}
              onClick={() => selectBend(bend.id)} onDoubleClick={() => { void editFeature(featureOf(bend.id)); }}>
              <td><i className={styles.swatch} data-direction={dir} />{bend.id}</td>
              <td>{num(Math.abs(bend.angle_deg), 1)}° {dir}</td>
              <td>{lengthNum(bend.radius_mm, units)}</td>
              <td>{lengthNum(bend.allowance_mm, units, 3)}</td>
              <td className={styles.rowEdit}>
                <button type="button" aria-label={`Edit ${featureOf(bend.id)}`} title={`Edit ${featureOf(bend.id)}`} data-edit-bend={bend.id}
                  onClick={(event) => { event.stopPropagation(); void editFeature(featureOf(bend.id)); }}><Pencil size={11} /></button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const TREATMENTS: Record<string, string> = {
  developed_lance: 'Developed exactly',
  nominal_blank_form_suppressed: 'Nominal blank',
  nominal_blank_with_declared_pre_pierce: 'Nominal blank, pre-pierce',
  nominal_blank_with_louver_slit: 'Nominal blank, front slit',
};
const FORM_KINDS: Record<string, string> = { lance: 'Lance', louver: 'Louver', emboss: 'Emboss', dimple: 'Dimple' };

/** The sheet's placed forms: tool, position and how the flat pattern carries each one. */
function FormTable({ body }: { body: SheetBody }) {
  const units = useSetting('display.units');
  const forms = body.forms ?? [];
  if (!forms.length) return null;
  return (
    <table className={styles.table} id="form-table">
      <thead><tr><th>Form</th><th>Tool</th><th>At</th><th title="How the flat pattern represents the form">Flat</th><th aria-label="Edit" /></tr></thead>
      <tbody>
        {forms.map((form) => (
          <tr key={form.id} data-form-row={form.id} title={`${form.tool.name ?? FORM_KINDS[form.tool.kind] ?? form.tool.kind} on ${form.panel}; double-click to edit`}
            onDoubleClick={() => { void editFeature(form.id); }}>
            <td>{form.id}</td>
            <td>{form.tool.name ?? FORM_KINDS[form.tool.kind] ?? form.tool.kind}{form.direction === 'down' ? ' · down' : ''}</td>
            <td>{lengthNum(form.at[0], units, 1)}, {lengthNum(form.at[1], units, 1)}</td>
            <td>{TREATMENTS[form.flat_treatment] ?? form.flat_treatment.replaceAll('_', ' ')}</td>
            <td className={styles.rowEdit}>
              <button type="button" aria-label={`Edit ${form.id}`} title={`Edit ${form.id}`} data-edit-form={form.id}
                onClick={(event) => { event.stopPropagation(); void editFeature(form.id); }}><Pencil size={11} /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ripType = (rip: SheetRip) => (rip.kind === 'bend' ? `Bend ${rip.bend ?? ''}`.trim() : rip.kind === 'cylinder' ? 'Tube seam' : `Slit in ${rip.panel ?? 'panel'}`);

/** The sheet's rips: what each opened, its gap, and the sheets a separated bend left. */
function RipTable({ body }: { body: SheetBody }) {
  const units = useSetting('display.units');
  const panels = new Set(body.panels.map((panel) => panel.id));
  // A split body's report repeats every rip; show those that touch this sheet.
  const rips = (body.rips ?? []).filter((rip) => rip.kind === 'bend' ? rip.pieces?.includes(body.body) ?? true : rip.kind === 'planar' ? !rip.panel || panels.has(rip.panel) : true);
  if (!rips.length) return null;
  return (
    <table className={styles.table} id="rip-table">
      <thead><tr><th>Rip</th><th>Opens</th><th title="Across the slit, or the chord between the inside edges at a bend or seam">Gap</th><th>Sheets</th><th aria-label="Edit" /></tr></thead>
      <tbody>
        {rips.map((rip) => (
          <tr key={rip.id} data-rip-row={rip.id} title="Double-click to edit" onDoubleClick={() => { void editFeature(rip.id); }}>
            <td>{rip.id}</td>
            <td>{ripType(rip)}</td>
            <td>{lengthText(rip.gap_mm, units, 3)}</td>
            <td>{rip.pieces?.length ? rip.pieces.map((piece, index) => <span key={piece}>{index > 0 && ' + '}{piece === body.body ? <b>{piece}</b> : piece}</span>) : '—'}</td>
            <td className={styles.rowEdit}>
              <button type="button" aria-label={`Edit ${rip.id}`} title={`Edit ${rip.id}`} data-edit-rip={rip.id}
                onClick={(event) => { event.stopPropagation(); void editFeature(rip.id); }}><Pencil size={11} /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const measured = (d: Diagnostic) => (d.measured !== null && d.measured !== undefined
  ? `${num(d.measured, 3)}${d.units ? ` ${d.units}` : ''}${d.limit !== null && d.limit !== undefined ? ` (limit ${num(d.limit, 3)}${d.units ? ` ${d.units}` : ''})` : ''}` : '');

/** A rule whose numbers someone guessed (STEVE marks its own picks `Estimate by STEVE…`). */
export const isEstimate = (source: string | null | undefined) => !!source && /\bestimat/i.test(source);

/** What the flat pattern's development rests on, when that isn't shop data. */
function provenance(body: SheetBody): Diagnostic[] {
  const rules = body.rules;
  if (!body.bends.length || rules.bend_table) return [];
  const source = rules.source ?? null;
  if (isEstimate(source)) return [{ code: 'K_ESTIMATED', severity: 'info',
    message: `The flat size uses an estimated K-factor (${num(rules.k_factor ?? undefined, 3)}). Ask your fabricator for theirs, or for a bend table, before cutting.` }];
  if (!source) return [{ code: 'K_NO_SOURCE', severity: 'info',
    message: 'The K-factor has no source. Note where it comes from (a shop chart, a test bend) in the rule’s Source.' }];
  return [];
}

/** The sheet's coded findings, worst first, or a clean bill for its geometry (shop limits aren't assessed). */
function Checks({ body, report }: { body: SheetBody; report: SheetReport }) {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const findings = [...(body.diagnostics ?? []), ...provenance(body)].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className={styles.checks} id="sheet-checks">
      {findings.map((finding, index) => {
        const Icon = ICONS[finding.severity] ?? TriangleAlert;
        return (
          <div key={index} className={styles.check} data-severity={finding.severity} data-code={finding.code}>
            <Icon size={13} />
            <span>{finding.message}<small>{[finding.code, finding.feature, finding.entity, measured(finding)].filter(Boolean).join(' · ')}</small></span>
          </div>
        );
      })}
      {!findings.some((f) => f.severity !== 'info') && body.status === 'ready' && <p className={styles.muted}>No geometry or development problems found.</p>}
      {report.manufacturing_validation?.status === 'not_assessed' && (
        <p className={styles.muted} title={report.manufacturing_validation.reason}><ShieldQuestion size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />Shop limits (tooling, minimum flange, material) are not checked yet.</p>
      )}
    </div>
  );
}

/** Inspector section for a part or design with sheet-metal bodies. */
export function SheetSection() {
  const report = useSheetReport();
  const chosen = useSheetView((state) => state.body);
  const flatOpen = useApp((state) => state.flatView);
  const features = useApp((state) => state.modeling?.features);
  const formTools = useApp((state) => state.modeling?.sheet_forms?.length ?? 0);
  const units = useSetting('display.units');
  const body = chosenBody(report, chosen);
  if (!report || !body) return null;
  const origin = features?.find((feature) => feature.id === body.body && ['sheet_base', 'sheet_roll', 'sheet_convert'].includes(feature.kind));
  const named = origin?.kwargs?.rule?.kind === 'sheet_rule';
  const rules = body.rules;
  return (
    <Section title="Sheet metal" id="sheet-metal" actions={<BodyChoice report={report} body={body} />}>
      <div className={styles.stack} data-sheet-body={body.id}>
        {body.status !== 'ready' && !body.diagnostics?.length && <p className={styles.problem} data-sheet-error><TriangleAlert size={13} />{body.error ?? 'A sheet-metal feature failed.'}</p>}
        <dl className={styles.rows}>
          {rules.name && <div><dt>Rule</dt><dd>{rules.name}{rules.gauge ? ` · ${rules.gauge}` : ''}</dd></div>}
          <div><dt>Thickness</dt><dd>{lengthText(rules.thickness, units, 3)}</dd></div>
          <div><dt>Bend radius</dt><dd>{lengthText(rules.radius, units, 3)}</dd></div>
          <div><dt>{rules.bend_table ? 'Bend table' : 'K-factor'}</dt><dd>{rules.bend_table ? `${rules.bend_table.name ?? 'Unnamed'} (${rules.bend_table.rows.length} rows)` : num(rules.k_factor ?? undefined, 3)}</dd></div>
          {(body.material?.material || rules.material) && <div><dt>Material</dt><dd>{body.material?.material ?? rules.material}</dd></div>}
          {(rules.source || rules.bend_table?.source) && (
            <div data-source><dt>Source</dt><dd>{isEstimate(rules.source) && <span className={styles.estimate} data-estimate>Estimate</span>}{rules.source ?? rules.bend_table?.source}</dd></div>
          )}
          {body.flat && <div data-emphasis><dt>Flat size</dt><dd id="flat-size">{size(body, units)}</dd></div>}
          {body.flat && <div><dt>Flat area</dt><dd>{areaText(body.flat.area_mm2, units)}</dd></div>}
          {body.flat && <div><dt>Cut length</dt><dd>{lengthText(body.flat.perimeter_mm, units, 1)}</dd></div>}
          <div><dt>State</dt><dd>{body.state === 'unfolded' ? 'Unfolded' : 'Folded'}</dd></div>
        </dl>
        {origin && <Button size="sm" icon={named ? <Ruler /> : <Pencil />} id="edit-sheet-rules"
          onClick={() => { if (named) set({ dialog: 'sheetRules' }); else void editFeature(body.body); }}>{named ? `Edit rule ${origin.kwargs!.rule.value}` : 'Edit sheet rules'}</Button>}
        <Checks body={body} report={report} />
        <BendTable body={body} />
        <RipTable body={body} />
        <FormTable body={body} />
        <div className={styles.actions}>
          <Button size="sm" icon={<FlatPatternIcon />} onClick={toggleFlat} data-active={flatOpen || undefined} id="toggle-flat">{flatOpen ? 'Hide flat' : 'Show flat'}</Button>
          <Button size="sm" icon={<DxfIcon />} onClick={() => { void exportFlat(); }} disabled={body.status !== 'ready'} id="export-dxf">DXF</Button>
          <Button size="sm" icon={<Download />} onClick={() => exportBends(body)} disabled={!body.bends.length}>Bends CSV</Button>
          {(!!body.forms?.length || !!formTools) && <Button size="sm" icon={<FormLibraryIcon />} onClick={() => set({ dialog: 'sheetForms' })} id="open-form-tools">Form tools</Button>}
        </div>
        {body.form_dxf && (
          <p className={styles.note} data-forming-note><Info size={11} />The cutting DXF leaves out form marks. The ZIP adds a forming DXF (FORM_UP, FORM_DOWN and FORM_CENTER layers, same cuts and bend lines) and a form table for the press shop.</p>
        )}
      </div>
    </Section>
  );
}

/** The flat pattern over the canvas, beside the folded model. */
export function FlatOverlay() {
  const open = useApp((state) => state.flatView);
  const chosen = useSheetView((state) => state.body);
  const workspace = useApp((state) => state.workspace);
  const report = useSheetReport();
  const units = useSetting('display.units');
  const body = chosenBody(report, chosen);
  const shown = open && workspace === 'design' && !!body;
  // Notes (a pressed form's nominal blank) aren't problems; the badge counts errors and warnings.
  const problems = (body?.diagnostics ?? []).filter((d) => d.severity !== 'info');
  return (
    <AnimatePresence>
      {shown && body && report && (
        <motion.div className={styles.overlay} id="flat-overlay" initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }} onPointerDown={(event) => event.stopPropagation()}>
          <header className={styles.head}>
            <FlatPatternIcon size={15} />
            <b>Flat pattern</b>
            {body.flat && <span className={styles.size}>{size(body, units)}</span>}
            {!!problems.length && (
              <span className={styles.badge} data-severity={problems.some((d) => d.severity === 'error') ? 'error' : 'warning'} title={problems.map((d) => d.message).join('\n')} data-sheet-findings>
                <TriangleAlert size={11} />{problems.length}
              </span>
            )}
            <BodyChoice report={report} body={body} />
            <IconButton small label="Export DXF" onClick={() => { void exportFlat(); }}><DxfIcon /></IconButton>
            <IconButton small label="Close flat view" onClick={toggleFlat}><X /></IconButton>
          </header>
          {body.flat
            ? <div className={styles.canvas}><FlatView flat={body.flat} compact /></div>
            : <p className={styles.problem}><TriangleAlert size={13} />{body.error ?? 'No flat pattern for this body.'}</p>}
          <footer className={styles.legend}>
            <span><i className={styles.swatch} data-direction="up" />Bend up</span>
            <span><i className={styles.swatch} data-direction="down" />Bend down</span>
            {!!body.flat?.forms?.length && <span><i className={styles.swatch} data-form />Form marks</span>}
            <span className={styles.spacer} />
            <span>{body.bends.length} {body.bends.length === 1 ? 'bend' : 'bends'}</span>
            {body.flat && <span>{areaText(body.flat.area_mm2, units)}</span>}
          </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
