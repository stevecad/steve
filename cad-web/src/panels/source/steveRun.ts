/**
 * STEVE working inline from the editor: the request goes through the same conversation and durable runs as the
 * STEVE tab (so it appears in that history), STEVE edits the saved design with its tools, and the editor then
 * shows what changed in the file as an inline review (Keep / Undo per change).
 */
import { Api } from '@/lib/api';
import { uuid } from '@/lib/uuid';
import { get, isDirty, snapshot } from '@/state/store';
import { openDocument, openFile, saveDocument } from '@/state/actions';
import { filesOf, hasFiles, MAIN } from '@/state/design';
import { viewer } from '@/viewport/viewer';
import { assistantConfig, CONVERSATION_KEY, MODEL_KEY, parseChoice, serverDefaultOf, store, stored } from '../steve';

export interface InlineOutcome {
  status: 'changed' | 'unchanged' | 'stopped' | 'failed' | 'moved-on';
  /** The file's text before STEVE's change (the review's baseline). */
  before?: string;
  /** What STEVE said. */
  reply?: string;
  error?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);

interface Asked { status: 'succeeded' | 'failed' | 'stopped'; reply?: string; error?: string }

/**
 * One message to STEVE in the STEVE tab's conversation (so it shows in that history), about the saved document
 * `documentId`: a durable run that may edit it with its tools. Resolves when the run is done (or stopped).
 */
async function askSteve(message: string, documentId: string, branch: string, signal: { stopped: boolean; runId?: string }): Promise<Asked | { error: string }> {
  const config = await assistantConfig();
  const choice = parseChoice(stored(MODEL_KEY), config) ?? serverDefaultOf(config);
  if (!choice) return { error: 'Add an Anthropic, OpenAI, xAI, Google (Gemini) or OpenRouter API key in STEVE’s settings first.' };
  let conversation = stored(CONVERSATION_KEY);
  if (conversation) {
    try { if ((await Api.conversation(conversation)).busy) conversation = null; } catch { conversation = null; }
  }
  if (!conversation) {
    conversation = (await Api.createConversation(choice.provider)).conversation_id;
    store(CONVERSATION_KEY, conversation);
  }
  const run = await Api.startAssistantRun({
    request_id: uuid(), message, attachments: [], provider: choice.provider, model: choice.model,
    conversation_id: conversation, document_id: documentId, branch, selection: null, selection_detail: [], ui_workspace: get().workspace,
  });
  signal.runId = run.run_id;
  let current = run;
  while (!TERMINAL.has(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (signal.stopped && !current.stop_requested) { try { await Api.stopAssistantRun(run.run_id); } catch { /* It may have just finished. */ } }
    current = await Api.assistantRun(run.run_id);
  }
  return { status: current.status as Asked['status'], reply: current.result?.assistant ?? undefined, error: current.error ?? undefined };
}

/**
 * STEVE changing one file of an object the code editor shows besides the open document (a CAM program, the shop:
 * documents STEVE edits with the same tools), the way runInline does for the document itself. The object's saved
 * revision is what STEVE sees (the caller saves unsaved edits first); `reload` reads it back afterwards and returns
 * the file's text then.
 */
export async function runInlineOn(target: { documentId: string; file: string; before: string; reload: () => Promise<string | undefined> },
  message: string, signal: { stopped: boolean; runId?: string }): Promise<InlineOutcome> {
  const asked = await askSteve(message, target.documentId, 'main', signal);
  if (!('status' in asked)) return { status: 'failed', error: asked.error };
  const { before } = target;
  if (asked.status === 'stopped') return { status: 'stopped', before, reply: asked.reply };
  if (asked.status === 'failed') return { status: 'failed', before, error: asked.error ?? 'STEVE could not finish.' };
  const after = await target.reload();
  return { status: after === undefined || after === before ? 'unchanged' : 'changed', before, reply: asked.reply };
}

/** One message to STEVE about `file`, answered by a run that may edit the design; resolves when it is done. */
export async function runInline(message: string, file: string, signal: { stopped: boolean; runId?: string }): Promise<InlineOutcome> {
  const state = get();
  if (!state.doc.open) return { status: 'failed', error: 'Open a design first.' };
  // STEVE edits saved documents: it must see exactly what is in the editor.
  if ((isDirty(state) || !state.doc.saved) && !await saveDocument()) return { status: 'failed', error: 'Save the design first.' };
  const saved = get().doc.saved;
  if (!saved) return { status: 'failed', error: 'Save the design first.' };
  const before = filesOf(get().doc)[file] ?? (file === MAIN || !hasFiles(get().doc.kind) ? get().doc.code : '');
  const startedFrom = snapshot();
  const asked = await askSteve(message, saved.id, get().doc.branch, signal);
  if (!('status' in asked)) return { status: 'failed', error: asked.error };
  const { status, reply, error } = asked;
  if (status === 'stopped') return { status: 'stopped', before, reply };
  if (status === 'failed') return { status: 'failed', before, error: error ?? 'STEVE could not finish.' };
  // Follow STEVE's edit only if the person hasn't moved on (another document, or new edits meanwhile).
  const now = get();
  if (now.doc.saved?.id !== saved.id || snapshot() !== startedFrom) return { status: 'moved-on', before, reply };
  await openDocument(saved.id, now.doc.branch, { pose: viewer.capturePose() });
  if (file !== MAIN && hasFiles(get().doc.kind)) openFile(file);
  const after = filesOf(get().doc)[file] ?? get().doc.code;
  return { status: after === before ? 'unchanged' : 'changed', before, reply };
}

/** Where the selection is, in words STEVE can act on: the file, 1-based lines and the code itself. */
export function describeSelection(code: string, from: number, to: number, file: string): { lines: string; text: string } {
  const lineOf = (offset: number) => code.slice(0, offset).split('\n').length;
  const first = lineOf(from), last = lineOf(Math.max(from, to - 1));
  const startOffset = code.lastIndexOf('\n', from - 1) + 1;
  const endOffset = code.indexOf('\n', Math.max(from, to - 1));
  const text = code.slice(startOffset, endOffset < 0 ? code.length : endOffset);
  return { lines: first === last ? `line ${first} of ${file}` : `lines ${first}–${last} of ${file}`, text };
}
