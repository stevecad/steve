/**
 * Client for Codex's manufacturing backend (/v1/manufacturing): the revisioned library, program documents and
 * durable jobs. The server is authoritative for every rule; this module only moves data and keeps its typed
 * errors ({detail: {code, message, field?, fields?, details?}}) intact for the UI.
 */
import { uuid } from '@/lib/uuid';
import type { RecordProvenance } from './provenance';
import { withWorkspace } from '@/teams/current';

export type Kind = 'machine_model' | 'controller' | 'machine_instance' | 'rotary_cutter' | 'tool_holder' | 'tool_assembly'
  | 'tool_setup' | 'fff_profile' | 'post_processor' | 'machining_material' | 'cutting_preset'
  | 'turning_insert' | 'turning_holder' | 'turning_assembly' | 'turning_tool_setup';

export interface Pin { id: string; revision: number; kind: Kind; sha256: string }
export interface LibraryRecord extends Pin {
  definition: Record<string, unknown> & { kind: Kind; name: string };
  archived: boolean;
  created_at: string;
  version?: number;
  /** Where field values came from, saved with this revision (docs/MANUFACTURING_PROVENANCE.md). */
  provenance?: RecordProvenance | null;
}

export interface ProgramRecord {
  id: string; branch: string; revision: number; source: string; source_sha256: string;
  compiled: Program; dependency_sha256: string; revision_sha256: string; created_at: string;
  git_commit: string | null; geometry_status: string; execution_status: string;
  /** A CAM document shown as a program (cam/camDoc.ts): the document, its revision and what of its code the forms can't edit. */
  cam?: { document_id: string; revision: number; code: { path: string; line: number; text: string }[]; problem: string | null; line: number };
}
export interface Program {
  version: 1; units?: 'mm'; name: string;
  designs: { alias: string; pin: { document_id: string; branch?: string; revision: number; overrides?: Record<string, number> } }[];
  libraries: { alias: string; pin: Pin }[];
  setups: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
export interface LinkStatus { alias: string; pinned_revision?: number; latest_revision?: number | null; update_available?: boolean; [key: string]: unknown }

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Artifact { sha256: string; bytes: number; media_type: string }
export interface OutputFile { name: string; role: string; artifact: Artifact }
export interface JobRecord {
  id: string; program_id: string; branch: string; revision: number; revision_sha256: string; operation: string;
  status: JobStatus; stage: string; progress: number; generation: number; attempt_id: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  /** A failure; newer ones name the operation (executed ID) and authoring field (`strategy.stepover_mm`) it is bound to. */
  error: { code: string; message: string; operation?: string | null; field?: string | null; [key: string]: unknown } | null;
  output: { files: OutputFile[]; engine: Record<string, unknown>; input_sha256: string } | null;
  output_status?: string | null; cached_from?: string | null;
}
export interface JobEvent { sequence: number; status: JobStatus; stage: string; generation: number; progress: number; created_at: string; message?: string }

/** A typed manufacturing error: `code` and `message` from the server, plus field paths for forms. */
/** A field the server rejected: its path, message and (for validation) the pydantic error type, e.g. `missing`. */
export interface FieldProblem { path: string; message: string; code?: string }

export class MfgError extends Error {
  /** The operation (an executed ID: a pattern instance's own) and authoring field a failure is bound to, when the server names them. */
  operation?: string;
  /** The setup a setup-level failure (its post, machine, tooling...) is bound to, instead of an operation. */
  setup?: string;
  field?: string;
  constructor(public status: number, public code: string, message: string, public fields: FieldProblem[] = [], public details?: unknown) {
    super(message);
  }
}

function fieldsOf(detail: Record<string, unknown>): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (typeof detail.field === 'string') out.push({ path: detail.field, message: String(detail.message ?? ''), code: String(detail.code ?? '') || undefined });
  const many = detail.fields;
  if (Array.isArray(many)) {
    for (const item of many as Record<string, unknown>[]) {
      const loc = Array.isArray(item.loc) ? (item.loc as unknown[]).join('.') : String(item.path ?? item.field ?? '');
      const code = item.code ?? item.type;
      out.push({ path: loc, message: String(item.msg ?? item.message ?? ''), ...(typeof code === 'string' ? { code } : {}) });
    }
  }
  return out;
}

export async function mfg<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/v1/manufacturing${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new MfgError(0, 'network', 'The manufacturing service could not be reached.');
  }
  if (response.ok) return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
  const detail = payload?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const value = detail as Record<string, unknown>;
    const error = new MfgError(response.status, String(value.code ?? 'error'), String(value.message ?? response.statusText), fieldsOf(value), value.details);
    if (typeof value.operation === 'string') error.operation = value.operation;
    if (typeof value.setup === 'string') error.setup = value.setup;
    if (typeof value.field === 'string') error.field = value.field;
    throw error;
  }
  if (Array.isArray(detail)) {
    // FastAPI request validation (422): [{loc, msg, type}]
    const fields = (detail as { loc?: unknown[]; msg?: string; type?: string }[]).map((item) => ({ path: (item.loc ?? []).slice(1).join('.'), message: item.msg ?? '', code: item.type }));
    throw new MfgError(response.status, 'request_invalid', fields.map((field) => `${field.path}: ${field.message}`).join('; ') || 'The request is not valid.', fields);
  }
  throw new MfgError(response.status, 'error', typeof detail === 'string' ? detail : response.statusText);
}

/** A fresh idempotency key for one mutation (reuse it only when retrying that same mutation). */
export const requestKey = (prefix: string) => `${prefix}:${uuid()}`;
export const pinOf = (record: Pin): Pin => ({ id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 });

export const library = {
  list: (params: { kind?: Kind; search?: string; archived?: boolean; after?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.kind) query.set('kind', params.kind);
    if (params.search) query.set('search', params.search);
    if (params.archived) query.set('archived', 'true');
    if (params.after) query.set('after', params.after);
    query.set('limit', String(params.limit ?? 200));
    return mfg<{ items: LibraryRecord[]; next_after: string | null }>(`/library?${query}`);
  },
  get: (id: string, revision?: number) => mfg<LibraryRecord>(`/library/${id}${revision ? `?revision=${revision}` : ''}`),
  history: (id: string) => mfg<{ items: LibraryRecord[] } | LibraryRecord[]>(`/library/${id}/history?limit=200`)
    .then((value) => (Array.isArray(value) ? value : value.items)),
  /** `provenance`: the record's field sources; left out, an edit keeps the sources of unchanged values (see provenance.ts). */
  create: (definition: Record<string, unknown>, key = requestKey('create'), provenance?: RecordProvenance) =>
    mfg<LibraryRecord>('/library', { body: { request_key: key, definition, ...(provenance ? { provenance } : {}) } }),
  edit: (record: Pin, definition: Record<string, unknown>, archived: boolean, key = requestKey('edit'), provenance?: RecordProvenance) =>
    mfg<LibraryRecord>(`/library/${record.id}`, { method: 'PUT', body: { request_key: key, expected_revision: record.revision, definition, archived, ...(provenance ? { provenance } : {}) } }),
  /** Moves items still pinning an older revision of another item to its latest (every save already carries its edit
   *  along; this repairs links saved before it did). Saved programs keep their exact pins. */
  followLatest: () => mfg<{ followed: { id: string; name: string; revision: number }[]; skipped: { id: string; name: string; reason: string }[] }>(
    '/library/follow-latest', { method: 'POST', body: {} }),
  machineSnapshot: (id: string, revision: number) => mfg<Record<string, unknown>>(`/machines/${id}/snapshot?revision=${revision}`),
  kinematics: (record: Pin, positions: { joint: string; value: number }[]) =>
    mfg<Record<string, unknown>>(`/machines/${record.id}/kinematics`, { body: { revision: record.revision, sha256: record.sha256, positions } }),
  toolSnapshot: (id: string, revision: number) => mfg<Record<string, unknown>>(`/tools/${id}/snapshot?revision=${revision}`),
  toolSetupSnapshot: (id: string, revision: number) => mfg<Record<string, unknown>>(`/tool-setups/${id}/snapshot?revision=${revision}`),
  /** A cutting preset revision with the exact material and cutter revisions it pins (docs/MANUFACTURING_CUTTING_PRESETS.md). */
  presetSnapshot: (id: string, revision: number) => mfg<{ record: LibraryRecord; material: LibraryRecord; cutter: LibraryRecord }>(`/cutting-presets/${id}/snapshot?revision=${revision}`),
};

export const programs = {
  list: async () => {
    const out: ProgramRecord[] = [];
    let after: string | null = null;
    do {
      const page: { items: ProgramRecord[]; next_after: string | null } = await mfg(`/programs?limit=200${after ? `&after=${after}` : ''}`);
      out.push(...page.items);
      after = page.next_after;
    } while (after && out.length < 2000);
    return out;
  },
  get: (id: string, branch = 'main', revision?: number) => mfg<ProgramRecord>(`/programs/${id}?branch=${encodeURIComponent(branch)}${revision ? `&revision=${revision}` : ''}`),
  render: (program: Program) => mfg<{ source: string }>('/programs/render', { body: program }).then((value) => value.source),
  compile: (source: string) => mfg<Record<string, unknown>>('/programs/compile', { body: { source } }),
  create: (source: string, key = requestKey('program')) => mfg<ProgramRecord>('/programs', { body: { request_key: key, source } }),
  edit: (record: ProgramRecord, source: string, key = requestKey('program-edit')) =>
    mfg<ProgramRecord>(`/programs/${record.id}?branch=${encodeURIComponent(record.branch)}`, { method: 'PUT', body: { request_key: key, expected_revision: record.revision, source } }),
  history: (id: string, branch = 'main') => mfg<{ items: ProgramRecord[] } | ProgramRecord[]>(`/programs/${id}/history?branch=${encodeURIComponent(branch)}&limit=200`)
    .then((value) => (Array.isArray(value) ? value : value.items)),
  /** Per design alias: the pinned and latest revision and whether an update is available. */
  linkStatus: (record: ProgramRecord) => mfg<Record<string, Omit<LinkStatus, 'alias'>>>(`/programs/${record.id}/link-status?branch=${encodeURIComponent(record.branch)}&revision=${record.revision}`)
    .then((value) => Object.entries(value).map(([alias, status]) => ({ alias, ...status }) as LinkStatus)),
};

export const jobs = {
  execution: () => mfg<Record<string, unknown>>('/execution'),
  /** `operation` is the ID of the program operation to run. */
  submit: (program: ProgramRecord, operation: string, key = requestKey('job')) => mfg<JobRecord>('/jobs', {
    body: { request_key: key, program_id: program.id, branch: program.branch, revision: program.revision, revision_sha256: program.revision_sha256, operation },
  }),
  list: (programId?: string) => mfg<{ items: JobRecord[]; next_after?: string | null } | JobRecord[]>(`/jobs?limit=100${programId ? `&program_id=${programId}` : ''}`)
    .then((value) => (Array.isArray(value) ? value : value.items)),
  get: (id: string) => mfg<JobRecord>(`/jobs/${id}`),
  cancel: (id: string) => mfg<JobRecord>(`/jobs/${id}/cancel`, { method: 'POST' }),
  events: (id: string, after = 0) => mfg<JobEvent[] | { items: JobEvent[] }>(`/jobs/${id}/events?after=${after}`)
    .then((value) => (Array.isArray(value) ? value : value.items)),
  artifactUrl: (id: string, name: string) => withWorkspace(`/v1/manufacturing/jobs/${id}/artifacts/${encodeURIComponent(name)}`),
  artifact: async <T>(id: string, name: string): Promise<T> => {
    const response = await fetch(`/v1/manufacturing/jobs/${id}/artifacts/${encodeURIComponent(name)}`);
    if (!response.ok) throw new MfgError(response.status, 'artifact_unavailable', `${name} could not be read.`);
    return response.json() as Promise<T>;
  },
};

export const terminal = (status: JobStatus) => status === 'succeeded' || status === 'failed' || status === 'cancelled';

/** One item of Steve's catalogue (app/manufacturing/catalogue.py index): a controller says whether Steve posts for it. */
export interface CatalogueEntry {
  kind: 'machine_model' | 'controller' | 'tool_holder' | 'rotary_cutter'; key: string; name: string; description: string;
  dialect?: string; status?: 'executable' | 'saved_only';
  travel_mm?: Record<string, number>; spindle?: { interface: string; max_rpm: number } | null; changer?: { mode: string; pockets: number };
  cutter_type?: string; diameter_mm?: number;
}
/** Steve's catalogue: the shared, read-only shop document to link (its latest revision) and its items. */
export interface Catalogue { document_id: string | null; revision: number | null; name: string; items: CatalogueEntry[] }
export const catalogue = () => mfg<Catalogue>('/catalogue');
