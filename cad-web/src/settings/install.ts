/**
 * Puts the account's settings to work once signed in: the display a model opens with, building as you type, and the
 * code editor's text size, following the setting as it changes (here or on another computer, at the next load).
 * The view's mouse settings are read where they act (viewport/Scene.tsx); report notifications in feedback/feedback.ts.
 */
import { get, set, type AppState } from '@/state/store';
import { displayDefaults, loadSettings, setting, updateSetting, useSettings, type Settings } from './store';

const LEGACY_LIVE = 'steve-source-live';  // Live build was this browser's until it became an account setting.

function follow(values: Settings, previous?: Settings) {
  // Follow changed preferences, including Reset and failed-save recovery.
  // Leave unrelated temporary view-bar choices alone.
  const appearance: Partial<AppState> = {};
  for (const [key, field] of [
    ['display.style', 'style'], ['display.projection', 'projection'],
    ['display.grid', 'showGrid'], ['display.shadows', 'showShadows'],
    ['display.originPlanes', 'showOrigin'], ['display.background', 'viewportBackground'],
  ] as const) {
    if (values[key] !== previous?.[key]) Object.assign(appearance, { [field]: values[key] });
  }
  if (Object.keys(appearance).length) set(appearance);
  if (values['editor.liveBuild'] !== get().liveBuild) set({ liveBuild: values['editor.liveBuild'] });
  if (values['editor.fontSize'] !== previous?.['editor.fontSize']) {
    document.documentElement.style.setProperty('--editor-font-size', `${values['editor.fontSize']}px`);
    if (previous) window.dispatchEvent(new Event('resize'));  // CodeMirror measures its lines again.
  }
}

export function installSettings() {
  const loaded = loadSettings();  // This account's cached settings now; the server's when it answers.
  set(displayDefaults());
  follow(useSettings.getState().values);
  useSettings.subscribe((state, previous) => follow(state.values, previous.values));
  void loaded.then(() => {
    set(displayDefaults());
    let legacy: string | null = null;
    try { legacy = localStorage.getItem(LEGACY_LIVE); localStorage.removeItem(LEGACY_LIVE); } catch { /* Optional. */ }
    if (legacy === '0' && setting('editor.liveBuild')) void updateSetting('editor.liveBuild', false);
  });
}
