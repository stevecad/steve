/**
 * Automatic generation: when the source changes and the geometry on screen no longer matches it, the model rebuilds by
 * itself after a short pause, wherever the change came from (the editor, a sketch, the tree, a tool, STEVE). Nobody has
 * to "generate". The Source pane's Live switch (Settings → Code editor) turns it off for heavy models; then Update (Ctrl+Enter) builds.
 */
import { useFeatureDialog } from '@/modeling/dialog';
import { settleBuildFailure, updateModel } from './actions';
import { updateSetting } from '@/settings/store';
import { get, isPreviewStale, useApp, type AppState } from './store';
import { isStoppedBuild } from './stoppedBuild';

const PAUSE_MS = 700;

type Source = unknown[];
const sourceOf = (state: AppState): Source => [state.doc.kind, state.doc.code, state.doc.files, state.doc.links, state.rollback?.code];
const same = (a: Source | null, b: Source) => !!a && a.length === b.length && a.every((value, index) => value === b[index]);

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Source | null = null;
// The last source built automatically: if that build failed, it isn't retried until the source changes again (an
// abandoned one, e.g. when switching tabs, is).
let attempted: Source | null = null;

function wanted(state: AppState) {
  return state.doc.open && state.liveBuild && !state.busy && !state.pastVersion && !state.sketching && !useFeatureDialog.getState().open
    && isPreviewStale(state) && !isStoppedBuild(state) && !(state.phase === 'failed' && same(attempted, sourceOf(state)));
}

function check() {
  settleBuildFailure();
  const state = get();
  if (!wanted(state)) { clearTimeout(timer); pending = null; return; }
  const source = sourceOf(state);
  if (same(pending, source)) return;  // Already waiting for this source; hovering and selecting don't restart the pause.
  pending = source;
  clearTimeout(timer);
  timer = setTimeout(() => {
    pending = null;
    const now = get();
    if (!wanted(now)) return;
    // Half-typed code: the editor shows where the syntax breaks; building it would only fail.
    if (now.modeling?.diagnostics.some((d) => d.severity === 'error' && /syntax/i.test(d.message))) return;
    attempted = sourceOf(now);
    void updateModel({ quiet: true });
  }, PAUSE_MS);
}

/** Live build is an account setting (Settings → Code editor); the app state follows it (settings/install.ts). */
export function setLiveBuild(on: boolean) {
  void updateSetting('editor.liveBuild', on);
}

export function startAutoBuild() {
  useApp.subscribe(check);
  useFeatureDialog.subscribe(check);
  check();
}
