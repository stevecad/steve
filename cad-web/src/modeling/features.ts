import type { ComponentType } from 'react';
import { FileCode, Import } from 'lucide-react';
import { get, set, useApp } from '@/state/store';
import { modelingReport, type ModelFeature } from '@/lib/modeling';
import { AxisIcon, CombineIcon, OriginIcon, SketchIcon, SplitIcon } from '@/icons/cad';
import { editSketch } from '@/sketch/actions';
import { editFeature } from './dialog';
import { SPECS } from './specs';
import { modelBuiltFrom } from '@/state/design';

export interface FeatureRow {
  key: string;
  id: string | null;
  kind: string;
  name: string;
  status: 'ok' | 'error' | 'suppressed' | 'pending' | 'code';
  error?: string;
  /** Advice on a feature that built (a smooth loft bulging past its sections). */
  warning?: string;
  editable: boolean;
  feature: ModelFeature;
}

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;
const EXTRA: Record<string, Icon> = { sketch: SketchIcon, axis: AxisIcon, point: OriginIcon, combine: CombineIcon, split: SplitIcon, code: FileCode as Icon, add: FileCode as Icon, import_step: Import as Icon };

export const modelingIcon = (kind: string): Icon => EXTRA[kind] ?? SPECS[kind]?.icon ?? (FileCode as Icon);

/** The modeling features of the open code, with each one's result from the displayed build. */
export function useFeatureRows(): FeatureRow[] | null {
  const doc = useApp((state) => state.modeling);
  const report = useApp((state) => modelingReport(state.displayed?.metadata, state.doc.activeFile));
  const matches = useApp((state) => modelBuiltFrom(state.displayed, state.doc));
  if (!doc?.canonical) return null;
  const results = new Map((report?.features ?? []).map((f) => [f.id, f]));
  return doc.features.map((feature, index) => {
    const result = feature.id ? results.get(feature.id) : undefined;
    const status: FeatureRow['status'] = feature.kind === 'code' ? 'code' : feature.suppressed ? 'suppressed' : !matches || !result ? 'pending' : result.status;
    return { key: feature.id ?? `code-${index}`, id: feature.id, kind: feature.kind, name: feature.name, status, error: result?.error, warning: status === 'ok' ? result?.warning : undefined, editable: feature.editable, feature };
  });
}

/** Double-click on a feature: the sketch editor, the feature dialog, or its code. */
export function openRow(row: FeatureRow) {
  if (row.kind === 'sketch' && row.id) { void editSketch(row.id); return; }
  if (row.id && SPECS[row.kind] && row.editable) { void editFeature(row.id); return; }
  const code = get().doc.code;
  const [from, to] = row.feature.span;
  set({ sourceReveal: { from: Math.min(from, code.length), to: Math.min(to, code.length), nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}
