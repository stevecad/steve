/**
 * The results legend as data: what the viewport legend draws and what a recording paints over each frame, so a
 * video carries the same scale as the screen. Values are in display units; `range` is in SI.
 */
import { visibleFields } from './api';
import { BANDS, type Palette } from './colormap';
import { deformationText, SAFETY_CAP, useSimulation, yieldOf } from './state';
import { convert, fieldLabel, modeText, scaleLabels, show } from './units';

export interface LegendZone { label: string; color: 'fail' | 'amber' | 'green' | 'neutral' }

export interface LegendModel {
  title: string;
  /** Unit, or what the scale means (safety factor, mode amplitude). */
  subtitle: string;
  /** The state block: study, step/time/mode, deformation. */
  details: string[];
  palette: Palette;
  banded: boolean;
  bands: number;
  /** Tick labels at the band boundaries, highest first (bands + 1); empty for zone legends. */
  labels: string[];
  /** Traffic-light safety zones, highest first. */
  zones: LegendZone[];
  /** A typed-in range is showing. */
  edited: boolean;
  /** What the colours leave out: values beyond a typed-in range, safety factors at or above a target. */
  outside: string[];
  /** The yield strength's position up the bar (0 bottom, 1 top), when it falls on a stress scale. */
  yieldAt: number | null;
  yieldLabel: string;
  /** Display unit of the range inputs; `rangeShown` is the range in it. */
  unit: string;
  rangeShown: { min: number; max: number } | null;
}

const fmt = (value: number) => (Math.abs(value) >= 1e5 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(2) : Number(value.toPrecision(4)).toString());

export function legendModel(studyName: string | undefined): LegendModel | null {
  const s = useSimulation.getState();
  if (!s.result || !s.range || s.field === 'mesh') return null;
  const manifest = s.result.manifest;
  const safety = s.field === 'safety';
  const mode = manifest.modes?.find((item) => item.field === s.field);
  const flow = !!manifest.engine.openfoam;
  const siUnit = safety ? '' : visibleFields(manifest, s.region)[s.field]?.units;
  const palette: Palette = { kind: safety ? 'safety' : 'field', colormap: s.colormap, safety: s.safetyMode, cap: SAFETY_CAP };
  const banded = s.contours === 'banded';
  const bands = s.bands || BANDS;
  const details: string[] = [];
  if (studyName) details.push(`${studyName} · study revision ${manifest.provenance.study_revision}`);
  const frame = manifest.frames?.[s.frame];
  if (frame) details.push(`${frame.label ?? `Time ${fmt(frame.time_s)} s`} · step ${s.frame + 1} of ${manifest.frames!.length}`);
  if (mode) details.push(modeText(mode));
  const deformable = !!manifest.arrays.displacement && !manifest.modal;
  if (deformable) details.push(`Deformation ${deformationText(s.deformation, s.autoDeformation)}`);
  const model: LegendModel = {
    title: mode ? `Mode ${mode.number}` : fieldLabel(s.field, manifest.analysis) ?? s.field, subtitle: '', details, palette, banded, bands,
    labels: [], zones: [], edited: false, outside: [], yieldAt: null, yieldLabel: '', unit: '', rangeShown: null,
  };
  if (safety) {
    model.subtitle = 'Yield strength ÷ von Mises stress';
    if (s.safetyMode === 'traffic') {
      model.zones = [{ label: `≥ ${fmt(s.trafficAmber)}  Adequate`, color: 'green' }, { label: `${fmt(s.trafficRed)} – ${fmt(s.trafficAmber)}  Low margin`, color: 'amber' },
        { label: `< ${fmt(s.trafficRed)}  Yields`, color: 'fail' }];
    } else if (s.safetyMode === 'target') {
      const low = Math.min(s.range.min, s.safetyTarget);
      model.labels = Array.from({ length: bands + 1 }, (_, i) => fmt(s.safetyTarget - ((s.safetyTarget - low) * i) / bands));
      model.outside = [`≥ ${fmt(s.safetyTarget)}: meets the target (grey)`];
    } else {
      model.labels = Array.from({ length: bands + 1 }, (_, i) => (SAFETY_CAP - ((SAFETY_CAP - 1) * i) / bands).toFixed(1));
      model.labels[0] = `≥ ${SAFETY_CAP}`;
      model.outside = ['Below 1: yields'];
    }
    return model;
  }
  const range = s.legendRange ?? s.range;
  const scale = scaleLabels(range.min, range.max, siUnit, flow, bands);
  model.labels = scale.labels;
  model.unit = scale.unit;
  model.subtitle = mode ? 'Relative amplitude' : scale.unit;
  model.edited = !!s.legendRange;
  model.rangeShown = { min: convert(range.min, siUnit, scale.unit), max: convert(range.max, siUnit, scale.unit) };
  if (s.legendRange && s.outOfRange === 'grey') {
    if (s.range.max > range.max) model.outside.push(`Above ${scale.labels[0]} ${scale.unit}: grey`);
    if (s.range.min < range.min) model.outside.push(`Below ${scale.labels[bands]} ${scale.unit}: grey`);
  }
  const yieldPa = yieldOf(manifest);
  if (s.showYield && s.field === 'von_mises' && yieldPa && range.max > range.min) {
    const at = (yieldPa - range.min) / (range.max - range.min);
    if (at >= 0 && at <= 1) { model.yieldAt = at; model.yieldLabel = `Yield ${show(yieldPa, 'Pa', flow).value} ${show(yieldPa, 'Pa', flow).unit}`; }
    else if (at > 1) model.outside.push(`Yield ${show(yieldPa, 'Pa', flow).value} ${show(yieldPa, 'Pa', flow).unit} is above the scale`);
  }
  return model;
}
