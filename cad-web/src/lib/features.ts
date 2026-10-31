import { ApiError, api, serverCapabilities, type CadDocument, type Build } from './api';

/** Versioned contract: BACKEND_SPEC.md "Feature API". */
/** Server-side bounds for a parameter; the UI clamps and rounds before sending. */
export interface Limits { exclusive_min?: number; min?: number; exclusive_max?: number; max?: number; integer?: boolean }

export interface SourceRange { line: number; column_utf8: number; end_line: number; end_column_utf8: number }

export interface FeatureParameter {
  value: unknown;
  unit?: string;
  editable: boolean;
  reason?: string | null;
  expression?: string;
  binding?: { kind: string; name?: string; source?: SourceRange } | null;
  expression_source?: SourceRange | null;
  limits?: Limits | null;
}

export interface Feature {
  id: string;
  operation: 'plane' | 'rectangle' | 'extrusion' | 'face' | 'workplane' | 'points' | 'holes' | string;
  label: string;
  category: 'reference' | 'sketch' | 'solid' | 'transform' | 'opaque' | string;
  depends_on: string[];
  source?: (SourceRange & { call_site?: number; occurrence?: number }) | null;
  parameters: Record<string, FeatureParameter>;
  reference?: unknown;
  executed?: boolean;
}

export interface FeatureDiagnostic { code?: string; message: string; severity?: string; source?: SourceRange | null }

export interface FeatureTree {
  document_id: string;
  revision: number;
  schema_version: string;
  status: 'supported' | 'unsupported' | 'invalid' | 'captured' | 'partial';
  execution_verified: boolean;
  editable: boolean;
  features: Feature[];
  diagnostics: FeatureDiagnostic[];
  root_feature_id?: string;
  coverage?: { categories?: Record<string, number>; operations?: Record<string, number> };
  design_parameters?: DesignParameter[];
}

/** A module-level numeric variable in the source; editing it updates every feature that uses it. */
export interface DesignParameter {
  name: string;
  value: number;
  unit?: string | null;
  source?: SourceRange | null;
  used_by: string[];
  references?: number;
  editable: boolean;
  reason?: string | null;
  limits?: Limits | null;
}

export type FeatureChange = { feature_id: string; parameter: string; value: number } | { design_parameter: string; value: number };

export const isNumeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A parameter is editable only when the whole tree and the parameter both allow it (spec rule). */
export const canEdit = (tree: FeatureTree, parameter: FeatureParameter) =>
  tree.editable && tree.execution_verified && parameter.editable && isNumeric(parameter.value);

/** Human-readable parameter value. Captured (0.2) arguments may be any JSON; references resolve to labels. */
export function featureValue(value: unknown, unit?: string | null, labelOf: (id: string) => string = (id) => id): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isNumeric(value)) return `${Number(value.toFixed(4))}${unit ? ` ${unit}` : ''}`;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `(${value.map((item) => featureValue(item, null, labelOf)).join(', ')})`;
  if (typeof value === 'object') {
    const ref = value as { type?: string; feature_refs?: string[] };
    if (Array.isArray(ref.feature_refs)) return ref.feature_refs.map(labelOf).join(', ') || (ref.type ?? 'reference');
  }
  return JSON.stringify(value) ?? '—';
}

/** Up to two numeric arguments for compact rows; units only where the server states them. */
export function summarize(feature: Feature): string {
  const numbers = Object.values(feature.parameters).filter((parameter) => isNumeric(parameter.value)).slice(0, 2);
  if (!numbers.length) return '';
  const unit = numbers.every((parameter) => parameter.unit === 'mm') ? ' mm' : '';
  return numbers.map((parameter) => Number((parameter.value as number).toFixed(3))).join(' × ') + unit;
}

export type FeatureFetch = { state: 'ready'; tree: FeatureTree } | { state: 'unavailable' } | { state: 'error'; message: string };

export async function fetchFeatures(documentId: string): Promise<FeatureFetch> {
  if (!(await serverCapabilities()).features) return { state: 'unavailable' };
  try {
    const tree = await api<FeatureTree>(`/v1/documents/${documentId}/features`);
    return { state: 'ready', tree };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return { state: 'unavailable' };
    return { state: 'error', message: (error as Error).message };
  }
}

export interface FeatureEditResult { document: CadDocument; features: FeatureTree; model: Build }

export function editFeatures(documentId: string, revision: number, changes: FeatureChange[]) {
  return api<FeatureEditResult>(`/v1/documents/${documentId}/features/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, changes }),
  });
}

/** Converts 1-based line / 0-based UTF-8 byte column positions to JS string offsets. */
export function utf8RangeToOffsets(source: string, range: SourceRange): { from: number; to: number } {
  const lines = source.split('\n');
  const offsetOf = (line: number, byteColumn: number) => {
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    const text = lines[line - 1] ?? '';
    const encoder = new TextEncoder();
    let bytes = 0, index = 0;
    while (index < text.length && bytes < byteColumn) {
      const codePoint = text.codePointAt(index)!;
      const char = String.fromCodePoint(codePoint);
      bytes += encoder.encode(char).length;
      index += char.length;
    }
    return offset + index;
  };
  return { from: offsetOf(range.line, range.column_utf8), to: offsetOf(range.end_line, range.end_column_utf8) };
}

export interface SketchGroup { id: string; features: Feature[]; plane?: Feature; consumer?: Feature }

const PLANE_OPERATIONS = new Set(['plane', 'Workplane', 'workplane', 'transformed', 'copyWorkplane', 'workplaneFromTagged']);

/** Groups consecutive 2D operations into the sketch a solid operation consumes. */
export function groupSketches(tree: FeatureTree): SketchGroup[] {
  const byId = new Map(tree.features.map((feature) => [feature.id, feature]));
  const owner = new Map<string, SketchGroup>();
  const sketches: SketchGroup[] = [];
  for (const feature of tree.features) {
    if (feature.category !== 'sketch') continue;
    const parent = feature.depends_on.map((id) => owner.get(id)).find((group) => group && !group.consumer);
    if (parent) { parent.features.push(feature); owner.set(feature.id, parent); continue; }
    const plane = feature.depends_on.map((id) => byId.get(id)).find((dependency) => dependency && PLANE_OPERATIONS.has(dependency.operation));
    const group: SketchGroup = { id: feature.id, features: [feature], plane };
    sketches.push(group);
    owner.set(feature.id, group);
  }
  for (const feature of tree.features) {
    if (feature.category === 'sketch') continue;
    for (const id of feature.depends_on) { const group = owner.get(id); if (group && !group.consumer) group.consumer = feature; }
  }
  return sketches;
}

/** Workplanes the source created, in history order. */
export const constructionFeatures = (tree: FeatureTree) => tree.features.filter((feature) => PLANE_OPERATIONS.has(feature.operation));

/** Nudges a value into the server's limits: exclusive bounds step just inside, integers round. */
export function clampToLimits(value: number, limits?: Limits | null): number {
  if (!limits) return value;
  let next = limits.integer ? Math.round(value) : value;
  const epsilon = limits.integer ? 1 : 1e-6;
  if (limits.min !== undefined) next = Math.max(next, limits.min);
  if (limits.exclusive_min !== undefined && next <= limits.exclusive_min) next = limits.exclusive_min + epsilon;
  if (limits.max !== undefined) next = Math.min(next, limits.max);
  if (limits.exclusive_max !== undefined && next >= limits.exclusive_max) next = limits.exclusive_max - epsilon;
  return next;
}
