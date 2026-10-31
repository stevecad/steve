/**
 * The Surface tab's analysis options, in the Dock's tool tab (shell/toolDock.ts): the mode, its settings and its
 * legend, and for the continuity check the picked edge's gap, angle and curvature change. Display only.
 */
import { useEffect, useMemo } from 'react';
import { Rows3, Spline } from 'lucide-react';
import { DraftIcon, TangentIcon } from '@/icons/cad';
import { NumberField, Segmented, Switch } from '@/ui';
import { useApp } from '@/state/store';
import { num } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import { Panel } from '@/viewport/CommandPanels';
import { TOLERANCE, type Continuity } from '@/viewport/surfaceAnalysis';
import ToolFooter from '@/shell/ToolFooter';
import viewport from '@/viewport/Viewport.module.css';
import { ANALYSIS_TITLES, closeAnalysis, useSurfaceAnalysis, type AnalysisMode, type PullAxis } from './state';
import { autoRadius, CURVATURE_COLORS, DRAFT_COLORS } from './AnalysisLayer';
import { checkEdge } from './continuity';
import styles from './Surface.module.css';

const ICONS = { zebra: Rows3, curvature: Spline, draft: DraftIcon, continuity: TangentIcon } as const;
const MODES: { value: AnalysisMode; label: string }[] = [
  { value: 'zebra', label: 'Zebra' }, { value: 'curvature', label: 'Curvature' }, { value: 'draft', label: 'Draft' }, { value: 'continuity', label: 'Continuity' },
];
/** Shown on values estimated from the displayed mesh. */
const ESTIMATED = 'Estimated from the displayed mesh: close on a fine mesh, not exact.';

const update = (patch: Partial<ReturnType<typeof useSurfaceAnalysis.getState>>) => useSurfaceAnalysis.setState(patch);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className={viewport.panelRow}><span className={viewport.panelLabel}>{label}</span><div style={{ width: 150 }}>{children}</div></div>;
}

function Zebra() {
  const { stripes, vertical } = useSurfaceAnalysis();
  return (
    <>
      <Row label="Stripes"><NumberField value={stripes} unit="" step={1} min={2} max={60} ariaLabel="Stripes" onChange={(value) => update({ stripes: Math.round(Math.min(Math.max(value, 2), 60)) })} /></Row>
      <Row label="Direction">
        <Segmented size="sm" value={vertical ? 'vertical' : 'horizontal'} onChange={(value) => update({ vertical: value === 'vertical' })}
          options={[{ value: 'vertical', label: 'Vertical' }, { value: 'horizontal', label: 'Horizontal' }]} />
      </Row>
      <div className={viewport.panelHint}>
        Stripes that run straight across an edge mean the faces are tangent or better; a kink at the edge is a crease, a jump is a
        gap. Turn the view to move the stripes over the area you’re checking.
      </div>
    </>
  );
}

function Curvature() {
  const { measure, radius } = useSurfaceAnalysis();
  const version = useApp((state) => state.modelVersion);
  const auto = useMemo(() => autoRadius(viewer.model), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = radius ?? auto;
  return (
    <>
      <Row label="Show">
        <Segmented size="sm" value={measure} onChange={(value) => update({ measure: value })}
          options={[{ value: 'mean', label: 'Mean' }, { value: 'gaussian', label: 'Gaussian' }]} />
      </Row>
      <Row label="Full colour at radius"><NumberField value={shown} step={1} min={0.01} ariaLabel="Full colour at radius" onChange={(value) => update({ radius: Math.max(value, 0.01) })} /></Row>
      <div>
        <div className={styles.ramp} style={{ background: `linear-gradient(to right, ${CURVATURE_COLORS.concave}, ${CURVATURE_COLORS.flat}, ${CURVATURE_COLORS.convex})` }} />
        <div className={styles.rampLabels}><span>Concave, R ≤ {num(shown)} mm</span><span>Flat</span><span>Convex</span></div>
      </div>
      <div className={viewport.panelHint} title={ESTIMATED}>
        ≈ {ESTIMATED} {measure === 'gaussian'
          ? 'Gaussian curvature is positive on a dome, zero on a cylinder or cone (it can be flattened), and negative on a saddle.'
          : 'Smooth faces should change colour gradually; a sudden change of colour at an edge is a change of curvature there.'}
      </div>
    </>
  );
}

function Draft() {
  const { pull, reverse, minimum } = useSurfaceAnalysis();
  return (
    <>
      <Row label="Pull direction">
        <Segmented size="sm" value={pull} onChange={(value: PullAxis) => update({ pull: value })} options={(['X', 'Y', 'Z'] as PullAxis[]).map((axis) => ({ value: axis, label: `${reverse ? '−' : '+'}${axis}` }))} />
      </Row>
      <Row label="Reverse"><Switch label="Reverse pull direction" checked={reverse} onCheckedChange={(value) => update({ reverse: value })} /></Row>
      <Row label="Minimum draft"><NumberField value={minimum} unit="°" step={0.5} min={0} max={45} ariaLabel="Minimum draft" onChange={(value) => update({ minimum: Math.min(Math.max(value, 0), 45) })} /></Row>
      <div className={styles.swatches}>
        <span className={styles.swatch}><i style={{ background: DRAFT_COLORS.positive }} />Draft of {num(minimum)}° or more</span>
        <span className={styles.swatch}><i style={{ background: DRAFT_COLORS.shallow }} />Less than {num(minimum)}° (walls that need draft)</span>
        <span className={styles.swatch}><i style={{ background: DRAFT_COLORS.negative }} />Facing away: the other half of the mould, or an undercut</span>
      </div>
    </>
  );
}

const GRADES = { G2: 'Curvature continuous (G2)', G1: 'Tangent (G1)', G0: 'Touching, with a crease (G0)', none: 'Apart: the faces don’t touch' } as const;

/** A face's name for a pair heading: its reference without the feature prefix, or its position. */
function faceName(pick: { mesh: number }, face: number): string {
  const ref = viewer.model?.topologyFor(pick.mesh)?.faces[face]?.ref;
  return ref ? ref.replace(/\((.*)\)/, ' $1') : `face ${face + 1}`;
}

function PairResult({ result, samples }: { result: Continuity; samples: number }) {
  const approx = result.exact ? '' : '≈ ';
  const curvature = result.curvature === null ? '—'
    : `${result.exactCurvature ? '' : '≈ '}${num(result.curvature, 5)} /mm${result.relative !== null && result.relative > 0 ? ` (${num(result.relative * 100, 1)} %)` : ''}`;
  return (
    <>
      <div className={styles.grade} data-grade={result.grade}>{GRADES[result.grade]}</div>
      <dl className={viewport.measureRows}>
        <div data-emphasis={result.grade === 'none' || undefined} title={result.exact ? undefined : ESTIMATED}><dt>Largest gap (G0)</dt><dd className="tnum">{approx}{num(result.gap, 4)} mm</dd></div>
        <div data-emphasis={result.grade === 'G0' || undefined} title={result.exact ? undefined : ESTIMATED}><dt>Largest angle (G1)</dt><dd className="tnum">{approx}{num(result.angle, 3)}°</dd></div>
        <div title={result.exactCurvature ? undefined : ESTIMATED}><dt>Curvature change (G2)</dt><dd className="tnum">{curvature}</dd></div>
      </dl>
      <small className={styles.source}>{result.exact ? `Exact B-rep, ${samples} points` : `≈ From the displayed mesh, ${samples} points`}</small>
    </>
  );
}

function Continuity() {
  const selection = useApp((state) => state.selection);
  const version = useApp((state) => state.modelVersion);
  const edge = selection.length === 1 && selection[0].kind === 'edge' ? selection[0] : null;
  const check = useMemo(() => (edge && viewer.model ? checkEdge(viewer.model, edge) : null), [edge, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const worst = check && 'pairs' in check ? check.pairs.reduce((a, b) => (b.result.angle > a.result.angle ? b : a)).result.worst : null;
  useEffect(() => { update({ worst }); }, [worst]);
  if (!check) return <div className={viewport.panelHint}>Click an edge between two faces, or a surface’s open edge, to see how they meet.</div>;
  if ('problem' in check) return <div className={viewport.panelHint} data-tone="warning">{check.problem}</div>;
  return (
    <>
      {check.pairs.map((pair) => (
        <div key={pair.faces.join('-')} className={styles.pair}>
          {check.pairs.length > 1 && edge && <div className={styles.pairTitle}>{faceName(edge, pair.faces[0])} ↔ {faceName(edge, pair.faces[1])}</div>}
          <PairResult result={pair.result} samples={pair.samples} />
        </div>
      ))}
      <div className={viewport.panelHint}>
        Orange marks the worst point. G0 within {TOLERANCE.gap} mm, G1 within {TOLERANCE.angle}°, G2 when curvature across the edge matches within {TOLERANCE.relative * 100} %.
      </div>
    </>
  );
}

export default function AnalysisPanel() {
  const mode = useSurfaceAnalysis((state) => state.mode);
  if (!mode) return null;
  const Icon = ICONS[mode];
  return (
    <Panel id="surface-analysis" icon={<Icon size={16} />} title={ANALYSIS_TITLES[mode]} onClose={closeAnalysis}
      footer={<ToolFooter onCancel={closeAnalysis} cancelLabel="Close" cancelId="surface-analysis-close" />}>
      <Segmented size="sm" value={mode} onChange={(value) => update({ mode: value, worst: null })} options={MODES} />
      {mode === 'zebra' && <Zebra />}
      {mode === 'curvature' && <Curvature />}
      {mode === 'draft' && <Draft />}
      {mode === 'continuity' && <Continuity />}
    </Panel>
  );
}
