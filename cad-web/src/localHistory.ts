/** Document undo for local human feature/parameter edits; sketch/editor undo stays upstream. */
import { create } from 'zustand';
import { get, patchDoc, useApp, type DocState } from '@/state/store';
import { saveDraft } from '@/state/actions';
import { stored } from '@/state/design';

type Source = Pick<DocState, 'name' | 'kind' | 'code' | 'files' | 'activeFile' | 'links'>;
const capture = (doc: DocState): Source => ({ name: doc.name, kind: doc.kind, code: doc.code, files: { ...doc.files }, activeFile: doc.activeFile, links: { ...doc.links } });
const key = (doc: DocState) => JSON.stringify({ name: doc.name, kind: doc.kind, ...stored(doc) });
const undo: Source[] = [];
const redo: Source[] = [];
let applying = false;
let installed = false;
let lastEdit = 0;
export const useLocalHistory = create<{ undo: boolean; redo: boolean }>(() => ({ undo: false, redo: false }));
const publish = () => useLocalHistory.setState({ undo: undo.length > 0, redo: redo.length > 0 });

export function undoDocument(forward = false) {
  const state = get();
  if (state.busy || state.sketching || state.pastVersion || !state.doc.open) return;
  const from = forward ? redo : undo;
  const to = forward ? undo : redo;
  const previous = from.pop();
  if (!previous) return;
  to.push(capture(state.doc));
  applying = true;
  patchDoc(previous);
  saveDraft();
  applying = false;
  lastEdit = 0;
  publish();
}

export function installLocalHistory() {
  if (installed) return;
  installed = true;
  useApp.subscribe((state, previous) => {
    if (applying || state.doc === previous.doc) return;
    if (!state.doc.open || !previous.doc.open || state.doc.kind !== previous.doc.kind ||
        (previous.doc.saved?.id && state.doc.saved?.id !== previous.doc.saved.id)) {
      undo.length = redo.length = 0; lastEdit = 0; publish(); return;
    }
    if (key(state.doc) === key(previous.doc)) return;
    const now = Date.now();
    if (now - lastEdit > 600 || !undo.length) {
      undo.push(capture(previous.doc));
      if (undo.length > 50) undo.shift();
    }
    lastEdit = now;
    redo.length = 0;
    publish();
  });
  document.addEventListener('keydown', (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || get().sketching) return;
    if ((event.target as Element)?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    undoDocument(key === 'y' || event.shiftKey);
  });
}
