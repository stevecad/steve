/**
 * Set up with STEVE: a specialist that researches an item (a machine, a controller…) and drafts its library record.
 * POST /v1/assistant/setup streams NDJSON (app/setup_assistant.py). Nothing is saved by it, and nothing goes into
 * STEVE's chat: the dialog keeps this conversation and sends its earlier turns back with each follow-up.
 */
import { isProviderId } from '@/lib/api';
import { MODEL_KEY, store, stored } from '@/panels/steve';

/** Where each field of a draft came from: pages per field path (`spindles.0.max_rpm`), and the estimated paths. */
export interface Provenance { sources: Record<string, string[]>; estimates: string[] }

export interface SetupOptions {
  model: { provider: string; id: string; label: string };
  web: { search: boolean; fetch: boolean };
  kinds: Record<string, { label: string; hint: string; examples: string[] }>;
}

export interface SetupStep {
  id: string;
  kind: 'search' | 'fetch' | 'library' | 'draft';
  state: 'running' | 'done' | 'failed';
  text?: string;
  title?: string;
  results?: { url: string; title: string }[];
}

/** `pages`: the title and read time (UTC) of each page the draft cites. */
export interface SetupDraft extends Provenance { definition: Record<string, unknown>; notes: string; pages?: Record<string, { title?: string; retrieved_at?: string }> }

/** What a bundle record pins: a record drafted in the same setup (`ref`), or a saved one (its `pin` and name). */
export interface BundleLink { ref?: string; pin?: { id: string; revision: number; kind: string; sha256: string }; name?: string }

/**
 * A setup that drafts several records: the one asked for (`main`) and the records it pins that the library didn't
 * have. Each record's definition leaves out its links; the dialog fills them when it saves, dependencies first.
 */
export interface BundleRecordDraft extends SetupDraft { ref: string; kind: string; links: Record<string, BundleLink> }
export interface SetupBundle { main: string; notes: string; records: BundleRecordDraft[] }

export type SetupEvent =
  | { type: 'start'; model: SetupOptions['model']; web: SetupOptions['web'] }
  | ({ type: 'step' } & SetupStep)
  | { type: 'text'; text: string }
  | ({ type: 'draft' } & SetupDraft)
  | ({ type: 'bundle' } & SetupBundle)
  /** STEVE needs an answer before drafting (which variant, a value nothing published gives). */
  | { type: 'question'; text: string }
  | { type: 'done'; usage: Record<string, unknown> }
  | { type: 'error'; message: string };

/** A bundle's record as the dialog holds it now, for a follow-up. */
export interface BundleItem {
  ref: string;
  kind: string;
  definition: Record<string, unknown>;
  links: Record<string, BundleLink>;
  sources: Record<string, string[]>;
  estimates: string[];
  saved?: boolean;
}

export interface SetupBody {
  kind: string;
  request: string;
  draft?: Record<string, unknown> | null;
  sources?: Record<string, string[]>;
  estimates?: string[];
  bundle?: BundleItem[] | null;
  messages?: { role: 'person' | 'steve'; text: string }[];
}

/** The model the chat uses in this browser (`provider|model`), or the server's default. */
export function modelChoice(): { provider?: string; model?: string } {
  const [provider, model] = (stored(MODEL_KEY) ?? '').split('|');
  return isProviderId(provider) ? { provider, ...(model ? { model } : {}) } : {};
}

/** The server doesn't offer the model this browser has stored (it was retired or renamed): the ones it does. */
export class ModelUnavailable extends Error {
  constructor(message: string, public provider: string, public model: string, public offered: { id: string; label: string }[]) { super(message); }
}

/** Replaces this browser's stored model (STEVE's choice too) with one the server offers. */
export function chooseModel(provider: string, model: string) {
  store(MODEL_KEY, `${provider}|${model}`);
  options = null;
}

function detailOf(value: unknown, status: number): string {
  const detail = (value as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  const message = (detail as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(detail) && detail.length) return detail.map((item) => (item as { msg?: string }).msg ?? String(item)).join('; ');
  return `STEVE couldn’t start the setup (HTTP ${status}).`;
}

let options: Promise<SetupOptions> | null = null;
let optionsKey = '';
/** What STEVE can set up, and whether the chosen model can search and read the web (cached per model). */
export function setupOptions(): Promise<SetupOptions> {
  const choice = modelChoice();
  const key = `${choice.provider ?? ''}|${choice.model ?? ''}`;
  if (!options || key !== optionsKey) {
    optionsKey = key;
    const query = new URLSearchParams(Object.entries(choice).filter((entry): entry is [string, string] => !!entry[1]));
    options = fetch(`/v1/assistant/setup${query.size ? `?${query}` : ''}`).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const detail = (body as { detail?: { code?: string; provider?: string; model?: string; offered?: { id: string; label: string }[] } } | null)?.detail;
        if (detail && typeof detail === 'object' && detail.code === 'model_unavailable') {
          throw new ModelUnavailable(detailOf(body, response.status), String(detail.provider ?? ''), String(detail.model ?? ''), detail.offered ?? []);
        }
        throw new Error(detailOf(body, response.status));
      }
      return response.json() as Promise<SetupOptions>;
    });
    options.catch(() => { options = null; });
  }
  return options;
}

/** Streams one setup turn into `onEvent`. Aborting `signal` stops it quietly; failures arrive as an error event. */
export async function streamSetup(body: SetupBody, signal: AbortSignal, onEvent: (event: SetupEvent) => void): Promise<void> {
  let finished = false;
  try {
    const response = await fetch('/v1/assistant/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ ...body, ...modelChoice() }),
    });
    if (!response.ok || !response.body) {
      onEvent({ type: 'error', message: detailOf(await response.json().catch(() => null), response.status) });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line) as SetupEvent;
        onEvent(event);
        if (event.type === 'done' || event.type === 'error') finished = true;
      }
    }
    if (!finished) onEvent({ type: 'error', message: 'STEVE stopped before finishing. Try again.' });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    onEvent({ type: 'error', message: `STEVE couldn’t be reached (${(error as Error).message}).` });
  }
}

const valueAt = (data: unknown, path: string): unknown => path.split('.').reduce<unknown>((at, key) =>
  (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), data);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A new draft's provenance, plus the earlier marks on fields the draft left unchanged (STEVE re-cites what it
 * keeps, but a field it didn't touch keeps its mark either way).
 */
export function mergeProvenance(previous: Provenance, before: Record<string, unknown> | null, next: SetupDraft): Provenance {
  const sources = { ...next.sources };
  const estimates = new Set(next.estimates);
  const mentioned = (path: string) => path in next.sources || estimates.has(path);
  const kept = (path: string) => !mentioned(path) && before !== null && valueAt(next.definition, path) !== undefined && same(valueAt(before, path), valueAt(next.definition, path));
  for (const [path, urls] of Object.entries(previous.sources)) if (kept(path)) sources[path] = urls;
  for (const path of previous.estimates) if (kept(path)) estimates.add(path);
  return { sources, estimates: [...estimates] };
}
