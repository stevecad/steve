/**
 * STEVE's terms (app/terms.py): the "Before you start" page a person agrees to before the app opens, and the one-time
 * acknowledgements before a risky step (the first program to a machine, automatic mode, an AI buying without asking).
 */
import { api, ApiError, json } from '@/lib/api';
import { askConfirm } from '@/ui/confirm';

export type AcknowledgementKind = 'machine_program' | 'automatic_mode' | 'purchases';
interface Acknowledgement { title: string; text: string; action: string }

export interface Terms {
  version: string;
  required: boolean;
  accepted: boolean;
  summary: { title: string; intro: string; points: { title: string; text: string }[]; closing: string; agree: string };
  terms_url: string;
  privacy_url: string;
  acknowledgements: Partial<Record<AcknowledgementKind, string>>;
  acknowledgement_texts: Record<AcknowledgementKind, Acknowledgement>;
}

export const loadTerms = () => api<Terms>('/v1/terms');
export const acceptTerms = (version: string) => api<Terms>('/v1/terms/accept', json('POST', { version, agreed: true }));
const record = (kind: AcknowledgementKind) => api<unknown>(`/v1/terms/acknowledgements/${kind}`, { method: 'POST' });

/** Thrown when the person didn't confirm: nothing was changed. */
export class NotAcknowledged extends ApiError {
  constructor() { super('Nothing was changed.', 409, 'not_acknowledged'); }
}

async function ask(kind: AcknowledgementKind, said: Acknowledgement): Promise<boolean> {
  if (!await askConfirm({ title: said.title, detail: said.text, action: said.action, danger: false })) return false;
  await record(kind);
  return true;
}

/** Before a step that needs it: true once the person has acknowledged `kind` (asked now, if never before). */
export async function acknowledge(kind: AcknowledgementKind): Promise<boolean> {
  const terms = await loadTerms();
  if (!terms.required || terms.acknowledgements[kind]) return true;
  return ask(kind, terms.acknowledgement_texts[kind]);
}

/** Records an acknowledgement the person gave in a dialog of its own (the automatic mode prompt). */
export const recordAcknowledgement = record;

/** Runs `call`; when the server answers that an acknowledgement is needed first, asks for it and runs `call` again. */
export async function acknowledged<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (failure) {
    if (!(failure instanceof ApiError) || failure.code !== 'acknowledgement_required') throw failure;
    const { kind, title, text, action } = failure.data as unknown as { kind: AcknowledgementKind } & Acknowledgement;
    if (!await ask(kind, { title, text, action })) throw new NotAcknowledged();
    return call();
  }
}
