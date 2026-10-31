/**
 * Connector actions and their runs (app/connector_runs.py, app/connect_api.py): what a person's own software on their
 * network offers STEVE (print, load a program, run a local simulation, look up stock…), and each time it was asked.
 */
import { api, json } from '@/lib/api';
import { acknowledged } from '@/terms/terms';
import { withWorkspace } from '@/teams/current';

/** One input of an action: a JSON Schema property, or a STEVE document (x-steve). */
export interface InputSpec {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object';
  'x-steve'?: 'file' | 'program' | 'document';
  title?: string;
  description?: string;
  enum?: string[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  format?: string;
  kinds?: string[];
}
export interface InputSchema { type: 'object'; properties: Record<string, InputSpec>; required: string[] }

export type Caller = 'person' | 'assistant' | 'agent' | 'service_account' | 'app' | 'panel';

export interface ActionGrant {
  /** Whose runs wait for the owner's confirmation; override_person: run without one though the connector asks. */
  granted: boolean; callers: Caller[]; ask: Caller[]; override_person: boolean; machine: { id: string; name: string | null } | null;
  /** Its panel may send the document open in the app without asking, on the person's own click in the panel. */
  panel_documents: boolean;
  verifications: string[]; granted_at: string | null;
}
export interface ConnectorAction {
  id: string; name: string; title: string; description: string; inputs: InputSchema; result: string;
  needs_person: boolean; removed: boolean; takes_program: boolean; grant: ActionGrant;
}
export interface Connector {
  id: string; name: string; version: string; fingerprint: string; status: 'pending' | 'active' | 'revoked'; online: boolean;
  enrolled_at: string; enrolled_ip: string; last_seen_at: string | null; last_seen_ip: string | null; revoked_at: string | null;
  events: { name: string; description: string }[]; actions: ConnectorAction[]; panels: ConnectorPanel[];
}
/** A connector's panel (app/connector_panels.py): its own page in a pane, sandboxed on the panels origin. */
export interface ConnectorPanel {
  id: string; connector_id: string; name: string; title: string; placement: ('left' | 'right')[]; version: number;
  bytes: number; sha256: string; published_by: string; published_at: string; url: string;
}
/** A change automatic mode made (Settings → Connectors), which the person may undo. */
export interface SetupChange {
  id: number; op: string; target: string; by: Caller | 'connector';   // 'connector': a connector's own panel (PUT /connect/v1/panels)
  at: string; undone_at: string | null;
  /** The connector it was about (to show its changes together), and what: an action's or panel's title. */
  connector: { id: string; name: string; status: 'pending' | 'active' | 'revoked' } | null; what: string; version: number | null;
  /** Undoing it would still change something. */
  undoable: boolean;
}
/** One of a panel's own connector's actions, as its bridge lists them. */
export interface PanelAction {
  id: string; name: string; title: string; description: string; inputs: InputSchema; allowed: boolean; needs_confirmation: boolean;
  sends_open_document_on_click: boolean;
}
/** An action someone may run now (GET /v1/actions). */
export interface RunnableAction {
  id: string; name: string; title: string; description: string; inputs: InputSchema; result: string; takes_program: boolean;
  machine: { id: string; name: string | null } | null; needs_confirmation: boolean;
  connector: { id: string; name: string; online: boolean };
}
export type RunState = 'awaiting_confirmation' | 'queued' | 'received' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'expired';
export interface Run {
  id: string; action: { id: string; name: string; title: string }; connector_id: string; state: RunState;
  needs_confirmation: boolean; confirmed_by: string | null; cancel_requested: boolean; progress: number | null; message: string | null;
  inputs: Record<string, unknown>; note: string | null; result: unknown; error: string | null;
  requested_by: { kind: Caller; id: string; for?: string };
  files: { name: string; media_type: string; bytes: number; sha256: string }[];
  created_at: string; updated_at: string; waits_until: string | null;
  /** What a queued run waits for before it goes out, e.g. "Making the STEP file for model…" (a file input made on request). */
  waiting?: string | null;
  /** Confirming may also stop asking for this action and kind of caller. */
  can_stop_asking: boolean;
}
export interface ConnectorsOverview {
  connectors: Connector[]; waiting: Run[]; runs: Run[]; machines: { id: string; name: string }[];
  automatic: boolean; setup_log: SetupChange[];
}

export const FINAL_STATES: RunState[] = ['succeeded', 'failed', 'rejected', 'cancelled', 'expired'];
export const isFinal = (state: RunState) => FINAL_STATES.includes(state);

export const STATE_LABEL: Record<RunState, string> = {
  awaiting_confirmation: 'Waiting for you', queued: 'Waiting for the connector', received: 'Received', running: 'Running',
  succeeded: 'Done', failed: 'Failed', rejected: 'Refused by the connector', cancelled: 'Cancelled', expired: 'Expired',
};
export const CALLER_LABEL: Record<Caller, string> = {
  person: 'People in STEVE', assistant: 'The STEVE assistant', agent: 'AI agents (MCP)', service_account: 'Your API keys', app: 'Connected apps',
  panel: 'Its panel',
};
export const ASKED_BY: Record<Caller, string> = {
  person: 'you', assistant: 'the STEVE assistant', agent: 'an AI agent', service_account: 'an API key', app: 'a connected app',
  panel: 'its panel',
};

/** What a STEVE input takes, in words. */
export function describeInput(spec: InputSpec): string {
  if (spec['x-steve'] === 'program') return 'A CAM program';
  if (spec['x-steve'] === 'document') return `A ${(spec.kinds ?? ['document']).join(' or ')}`;
  if (spec['x-steve'] === 'file') return `A ${(spec.kinds ?? ['part', 'design']).join(' or ')} as ${FORMAT_LABEL[spec.format ?? ''] ?? spec.format}`;
  if (spec.enum) return `One of ${spec.enum.join(', ')}`;
  return { string: 'Text', number: 'A number', integer: 'A whole number', boolean: 'Yes or no', object: 'Data (JSON)' }[spec.type ?? 'string'];
}
export const FORMAT_LABEL: Record<string, string> = {
  step: 'STEP', 'step-parts': 'STEP per component', stl: 'STL meshes', dxf: 'DXF flat patterns', drawings: 'drawing sheets',
  '3mf': '3MF', 'drawings-pdf': 'drawing sheets (PDF)', 'pcb-fabrication': 'board fabrication files',
};

export const Actions = {
  overview: () => api<ConnectorsOverview>('/v1/connectors'),
  runnable: () => api<{ actions: RunnableAction[] }>('/v1/actions').then((body) => body.actions),
  // A program's first run on a machine asks the person to acknowledge the risk first (app/terms.py).
  run: (actionId: string, inputs: Record<string, unknown>, note?: string, confirm = false) =>
    acknowledged(() => api<Run>(`/v1/actions/${actionId}/runs`, json('POST', { inputs, note: note || undefined, confirm }))),
  get: (runId: string) => api<Run>(`/v1/action-runs/${runId}`),
  confirm: (runId: string, always = false) => acknowledged(() => api<Run>(`/v1/action-runs/${runId}/confirm`, json('POST', { always }))),
  cancel: (runId: string) => api<Run>(`/v1/action-runs/${runId}/cancel`, { method: 'POST' }),
  fileUrl: (runId: string, name: string) => withWorkspace(`/v1/action-runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}`),
  grant: (actionId: string, grant: { callers: Caller[]; ask: Caller[]; override_person: boolean; machine_id: string | null; verifications: string[];
                                      panel_documents: boolean }) =>
    api<ConnectorAction>(`/v1/connectors/actions/${actionId}`, json('PUT', grant)),
  ungrant: (actionId: string) => api<ConnectorAction>(`/v1/connectors/actions/${actionId}`, { method: 'DELETE' }),
  panels: () => api<{ panels: ConnectorPanel[]; automatic: boolean; request: { at: string; by: string; wanted: string } | null }>('/v1/connectors/panels'),
  panelActions: (panelId: string) => api<{ actions: PanelAction[] }>(`/v1/connectors/panels/${panelId}/actions`),
  /** `openDocument`: the app vouches the person just clicked in the panel and this is the document open in the app. */
  runFromPanel: (actionId: string, panelId: string, inputs: Record<string, unknown>, note?: string, openDocument?: string) =>
    acknowledged(() => api<Run>(`/v1/actions/${actionId}/runs`, json('POST', { inputs, note: note || undefined, panel: panelId, open_document: openDocument }))),
  removePanel: (panelId: string) => api<unknown>(`/v1/connectors/panels/${panelId}`, { method: 'DELETE' }),
  undo: (entryId: number) => api<unknown>(`/v1/connectors/setup-log/${entryId}/undo`, { method: 'POST' }),
  undoAll: () => api<{ undone: number }>('/v1/connectors/setup-log/undo-all', { method: 'POST' }),
  latestEvents: (connectorId: string) => api<{ events: { name: string; data: unknown; at: string }[] }>(`/v1/connectors/${connectorId}/events`),
};
