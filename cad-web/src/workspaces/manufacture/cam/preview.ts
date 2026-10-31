/**
 * The engine's geometry preview of a saved slot or 3D finishing operation (docs/MANUFACTURING_GEOMETRY_PREVIEWS.md):
 * the slot floors it recognises in the pinned CAD (or the authored guides), the parallel rows with their proposed
 * contact heights, the waterline loops per level. Asked for by itself when the editor opens on a saved operation, and
 * drawn over the part in the work frame. A preview runs no stock, collision or post check: it is not a verdict.
 */
import { create } from 'zustand';
import { useMfg } from '../state';
import { jobs, mfg, MfgError, terminal, type JobRecord } from '../api';
import { useCam } from './state';

export interface PreviewSlot { id: string; points_mm: [number, number][]; width_mm: number }
export interface PreviewRow { id: string; points_mm: [number, number, number][]; has_proposed_contact: boolean }
export interface PreviewLevel { height_mm: number; loops: [number, number, number][][] }
export interface GeometryPreview {
  representation: 'cad_slot_floors' | 'authored_slot_guides' | 'triangle_contact_proposal';
  coordinate_space: 'work'; verification: 'not_performed'; bounds_mm: number[];
  slots: PreviewSlot[]; rows: PreviewRow[]; levels: PreviewLevel[];
  mesh_deflection_mm?: number | null; sampling_step_mm?: number | null;
  request: { operation: string; strategy: { kind: string; bottom_mm: number; [key: string]: unknown } };
}
export interface PreviewState {
  /** `program:revision:operation` the preview is of. */
  key: string; operation: string; revision: number;
  status: 'loading' | 'ready' | 'failed' | 'unavailable';
  result: GeometryPreview | null; message: string | null;
}

export const PREVIEW_KINDS = ['slot', 'parallel', 'waterline'];
export const usePreview = create<{ preview: PreviewState | null }>(() => ({ preview: null }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Previews the open editor's operation as saved (a no-op unless it's a saved slot or finishing operation). */
async function previewOpen() {
  const editor = useCam.getState().editor;
  const op = editor?.draft.op;
  const record = editor ? useMfg.getState().programs.find((item) => item.id === editor.programId) : null;
  const saved = record && op && record.revision === editor!.revision
    ? (record.compiled.operations as { id?: string; pattern?: unknown }[]).find((item) => item.id === op.id) : null;
  if (!record || !op || !saved || saved.pattern || !PREVIEW_KINDS.includes(op.kind)) { usePreview.setState({ preview: null }); return; }
  const key = `${record.id}:${record.revision}:${op.id}`;
  if (usePreview.getState().preview?.key === key) return;
  const put = (patch: Partial<PreviewState>) => usePreview.setState((state) => (state.preview?.key === key ? { preview: { ...state.preview, ...patch } } : {}));
  usePreview.setState({ preview: { key, operation: op.id, revision: record.revision, status: 'loading', result: null, message: null } });
  try {
    // The same saved revision and operation reuse the same job (and its retained preview).
    let job = await mfg<JobRecord>('/geometry-previews', { body: {
      request_key: `preview:${record.id}:${record.revision}:${op.id}`, program_id: record.id, branch: record.branch,
      revision: record.revision, revision_sha256: record.revision_sha256, operation: op.id,
    } });
    for (let wait = 500; !terminal(job.status); wait = Math.min(2000, wait * 1.3)) {
      await sleep(wait);
      if (usePreview.getState().preview?.key !== key) return;
      job = await jobs.get(job.id);
    }
    if (job.status !== 'succeeded') { put({ status: 'failed', message: job.error?.message ?? 'The preview didn’t finish.' }); return; }
    put({ status: 'ready', result: await mfg<GeometryPreview>(`/jobs/${job.id}/geometry-preview`) });
  } catch (error) {
    // An engine without previews (older deployments) just has none; anything else is said.
    const missing = error instanceof MfgError && (error.status === 404 || error.status === 405 || /unavailable|unsupported/.test(error.code));
    put({ status: missing ? 'unavailable' : 'failed', message: (error as Error).message });
  }
}

// The editor opening (or switching) on a saved operation asks for its preview; closing it clears the drawing.
let watched = '';
useCam.subscribe((state) => {
  const editor = state.editor;
  const now = editor ? `${editor.programId}:${editor.revision}:${editor.draft.op.id}:${editor.draft.op.kind}` : '';
  if (now === watched) return;
  watched = now;
  if (!editor) usePreview.setState({ preview: null });
  else void previewOpen();
});
