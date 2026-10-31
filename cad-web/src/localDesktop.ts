/** Steve transport. Studio modeling, rendering and editing remain upstream. */
import { get, set, patchDoc, snapshot, toast } from '@/state/store';
import { stored, opened } from '@/state/design';
import { applyDocumentRevision, restoreDisplayed } from '@/state/actions';
import type { Build, CadDocument } from '@/lib/api';
import { viewer } from '@/viewport/viewer';
import { selectionContext } from '@/viewport/semantics';
import { installLocalHistory } from '@/localHistory';

function document() {
  const { doc } = get();
  return doc.open ? { name: doc.name, kind: doc.kind, ...stored(doc) } : null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
let syncing: Promise<void> | null = null;
let ack = 0;
const restoreInitial = !location.search;
export async function syncLocalDocument(flush = false): Promise<void> {
  // A chat submission needs a fresh snapshot, even when a periodic request
  // carrying an older draft is still in flight. Never overlap context writes.
  if (!flush && syncing) return syncing;
  while (syncing) await syncing;
  const request = postLocalDocument();
  syncing = request;
  try { await request; }
  finally { if (syncing === request) syncing = null; }
}

async function postLocalDocument(): Promise<void> {
  try {
    const state = get();
    const response = await fetch('/v1/local/context', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: document(), document_id: state.doc.saved?.id, build_id: state.displayed?.id,
        selection: viewer.model ? selectionContext(viewer.model, state.selection) : [], ack }) });
    if (!response.ok) return;
    const { pending } = await response.json() as { pending: { version: number; expected: unknown; document: CadDocument; build: Build } | null };
    if (pending && pending.version !== ack) {
      if (canonical(document()) === canonical(pending.expected)) {
        await applyDocumentRevision(pending.document, pending.build);
      } else {
        toast('warning', 'Your edits were preserved', 'Steve finished a build while you were editing. Its result is saved in the document library; reconcile the versions before continuing.');
      }
      ack = pending.version;
    }
  } catch { /* A closing desktop stops its local server. */ }
}

export async function openDesktop(action: 'steve' | 'account' | 'mcp' | 'agent') {
  if (action === 'steve') { set({ dockOpen: true, dockTab: 'assistant' }); return; }
  const { openSettings } = await import('@/settings/registry');
  openSettings({ account: 'steve', mcp: 'local-mcp', agent: 'local-instructions' }[action]);
}

export async function startLocalDesktop() {
  try {
    const response = await fetch('/v1/local/context');
    const context = await response.json();
    if (context.document && restoreInitial) {
      const doc = context.document as CadDocument;
      let saved: CadDocument | null = null;
      if (context.document_id) {
        const result = await fetch(`/v1/documents/${context.document_id}`);
        if (result.ok) saved = await result.json();
      }
      patchDoc({ open: true, name: doc.name, kind: doc.kind, ...opened(doc), saved, savedSnapshot: null });
      if (context.build_id) await restoreDisplayed(context.build_id);
      if (saved && canonical({ name: saved.name, kind: saved.kind, code: saved.code, files: saved.files ?? {}, links: saved.links ?? {} }) === canonical(document())) patchDoc({ savedSnapshot: snapshot() });
    }
  } catch { toast('warning', 'Could not restore the last session', 'Saved documents remain in File → Open.'); }
  installLocalHistory();
  setInterval(() => void syncLocalDocument(), 300);
}

window.addEventListener('steve:navigate', ((event: CustomEvent) => {
  if (['account', 'mcp', 'agent', 'steve'].includes(event.detail)) void openDesktop(event.detail);
}) as EventListener);
