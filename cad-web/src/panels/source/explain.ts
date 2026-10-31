/**
 * The editor's Explain: a one-shot answer streamed from POST /v1/assistant/explain, outside STEVE's conversation
 * (nothing is added to the chat unless the person chooses "Continue in chat").
 */
import { isProviderId } from '@/lib/api';
import { MODEL_KEY, stored } from '../steve';

export interface ExplainSink {
  /** The explanation so far (Markdown), after each new piece. */
  text(markdown: string): void;
  done(): void;
  error(message: string): void;
}

export interface ExplainBody {
  file: string;
  document_name?: string;
  selection_text: string;
  start_line: number;
  end_line: number;
  context_code: string;
}

/** Whole lines covered by `from`–`to`, with their numbers. */
export function selectedLines(code: string, from: number, to: number) {
  const lineOf = (offset: number) => code.slice(0, offset).split('\n').length;
  const start = lineOf(from), end = lineOf(Math.max(from, to - 1));
  const lines = code.split('\n').slice(start - 1, end).join('\n');
  return { start, end, text: lines, label: start === end ? `line ${start}` : `lines ${start}–${end}` };
}

/** The model the chat uses in this browser (`provider|model`), or the server's default. */
function choice(): { provider?: string; model?: string } {
  const [provider, model] = (stored(MODEL_KEY) ?? '').split('|');
  return isProviderId(provider) ? { provider, ...(model ? { model } : {}) } : {};
}

function detailOf(value: unknown, status: number): string {
  const detail = (value as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((item) => (item as { msg?: string }).msg ?? String(item)).join('; ');
  const message = (detail as { message?: unknown } | null)?.message;   // A structured error (model_unavailable).
  if (typeof message === 'string') return `${message} Choose a model in STEVE’s settings.`;
  return `STEVE couldn’t explain this (HTTP ${status}).`;
}

/** Streams the explanation into `sink`. Aborting `signal` stops it quietly (no error). */
export async function streamExplain(body: ExplainBody, signal: AbortSignal, sink: ExplainSink): Promise<void> {
  let text = '';
  try {
    const response = await fetch('/v1/assistant/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ ...body, ...choice() }),
    });
    if (!response.ok || !response.body) {
      sink.error(detailOf(await response.json().catch(() => null), response.status));
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
        const event = JSON.parse(line) as { type: string; text?: string; message?: string };
        if (event.type === 'text' && event.text) { text += event.text; sink.text(text); }
        else if (event.type === 'error') { sink.error(event.message ?? 'STEVE couldn’t explain this.'); return; }
        else if (event.type === 'done') { sink.done(); return; }
      }
    }
    if (text) sink.done();
    else sink.error('STEVE stopped without an explanation. Try again.');
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    sink.error(`STEVE couldn’t be reached (${(error as Error).message}).`);
  }
}
