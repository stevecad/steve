/**
 * The Surface tab's analysis: which display mode is on (zebra stripes, curvature, draft, or the continuity check of a
 * picked edge) and its options. Display only: nothing here is written into the design, and it ends with the document.
 */
import { create } from 'zustand';
import { touchCommands } from '@/commandEpoch';

export type AnalysisMode = 'zebra' | 'curvature' | 'draft' | 'continuity';
export type PullAxis = 'X' | 'Y' | 'Z';

export interface AnalysisState {
  mode: AnalysisMode | null;
  /** Zebra: stripes across the view, and whether they run up and down or side to side. */
  stripes: number;
  vertical: boolean;
  /** Curvature: mean or Gaussian, and the radius that shows at full colour (null: from the model's size). */
  measure: 'mean' | 'gaussian';
  radius: number | null;
  /** Draft: the direction the part comes out of the mould, and the least draft that is enough (degrees). */
  pull: PullAxis;
  reverse: boolean;
  minimum: number;
  /** Continuity: where the picked edge is worst (world mm), marked in the view. */
  worst: [number, number, number] | null;
}

export const ANALYSIS_TITLES: Record<AnalysisMode, string> = {
  zebra: 'Zebra stripes', curvature: 'Curvature map', draft: 'Draft analysis', continuity: 'Continuity check',
};

export const useSurfaceAnalysis = create<AnalysisState>(() => ({
  mode: null, stripes: 12, vertical: true, measure: 'mean', radius: null, pull: 'Z', reverse: false, minimum: 1, worst: null,
}));

useSurfaceAnalysis.subscribe((state, previous) => { if (state.mode !== previous.mode) touchCommands(); });

/** Turns a mode on, or off when it's the one showing. */
export function toggleAnalysis(mode: AnalysisMode) {
  useSurfaceAnalysis.setState((state) => ({ mode: state.mode === mode ? null : mode, worst: null }));
}

export const closeAnalysis = () => useSurfaceAnalysis.setState({ mode: null, worst: null });

/** The pull direction as a unit vector. */
export function pullVector(state: Pick<AnalysisState, 'pull' | 'reverse'>): [number, number, number] {
  const sign = state.reverse ? -1 : 1;
  return state.pull === 'X' ? [sign, 0, 0] : state.pull === 'Y' ? [0, sign, 0] : [0, 0, sign];
}
