/**
 * The account's application settings (Settings, ⚙ in the top bar): saved per account on the server (`/v1/settings`),
 * cached in this browser under the account (state/accountStorage.ts) so the app starts with them at once. A change shows
 * immediately and is saved in the background; one the server refuses is put back with its reason.
 */
import { create } from 'zustand';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/state/store';
import { accountKey } from '@/state/accountStorage';
import type { DisplayStyle, Projection, ViewportBackground } from '@/state/store';
import type { DrawingTemplate } from '@/drawing/code';
import type { Units } from '@/lib/format';

export interface Settings {
  'keyboard.preset': import('./keyboard').KeyboardPreset;
  'keyboard.overrides': import('./keyboard').Bindings;
  'viewport.zoomSpeed': number;
  'viewport.invertWheel': boolean;
  'viewport.zoomToCursor': boolean;
  'viewport.orbitSpeed': number;
  /** Which mouse buttons orbit, pan and zoom, as in other CAD programs (viewport/mouseStyle.ts). */
  'viewport.mouseStyle': 'steve' | 'solidworks' | 'fusion' | 'onshape';
  'display.style': DisplayStyle;
  'display.projection': Projection;
  'display.grid': boolean;
  'display.shadows': boolean;
  'display.originPlanes': boolean;
  /** The viewport's backdrop: 'theme' follows the app's theme. */
  'display.background': ViewportBackground;
  /** Units for lengths, areas and volumes shown in the design workspace (the status bar's chip flips it); models stay mm. */
  'display.units': Units;
  'editor.liveBuild': boolean;
  'editor.fontSize': number;
  'notifications.reports': boolean;
  'assistant.newChat.planning': boolean;
  'assistant.newChat.subagents': boolean;
  'assistant.newChat.autoCompact': boolean;
  /** Reasoning effort: 'auto' or a level (panels/effort.ts). */
  'assistant.effort': string;
  /** How long STEVE works on one message, in seconds (app/config.py RUN_CHOICES). */
  'assistant.timeBudget': number;
  'mcp.disabledTools': string[];
  /** Tools that start off (app/mcp_tool_settings.py DEFAULT_OFF) the person turned on. */
  'mcp.enabledTools': string[];
  /** Sheet templates saved in the Drawing tab (drawing/code.ts). */
  'drawing.templates': DrawingTemplate[];
  /** The top bar's quick button (shell/QuickButton.tsx): its menu's items, in order; [] = automatic. */
  'toolbar.quickItems': string[];
  /** Its main item; '' = the first item (or automatic). */
  'toolbar.quickMain': string;
  /** Automatic mode (app/connector_panels.py): the assistant and AI agents set connectors up without asking. */
  'connectors.automatic': boolean;
  /** Don't ask again whether to turn automatic mode on. */
  'connectors.automaticDeclined': boolean;
  /** An AI agent's request to turn it on, which the app asks about once ({} = none). */
  'connectors.automaticRequest': Record<string, string>;
}
export type SettingKey = keyof Settings;

/**
 * What a new account starts with. The server's defaults (app/account_settings.py, sent by `/v1/settings`) are the ones
 * that count; these are placeholders until it answers, or without a server. They equal the server's with no env
 * overrides (tests/settings/test_account_settings.py checks it), so keep them plain literals.
 */
export const DEFAULTS: Settings = {
  'keyboard.preset': 'steve',
  'keyboard.overrides': {},
  'viewport.zoomSpeed': 1,
  'viewport.invertWheel': false,
  'viewport.zoomToCursor': true,
  'viewport.orbitSpeed': 1,
  'viewport.mouseStyle': 'steve',
  'display.style': 'shaded-edges',
  'display.projection': 'orthographic',
  'display.grid': true,
  'display.shadows': true,
  'display.originPlanes': false,
  'display.background': 'theme',
  'display.units': 'mm',
  'editor.liveBuild': true,
  'editor.fontSize': 12.5,
  'notifications.reports': true,
  'assistant.newChat.planning': true,
  'assistant.newChat.subagents': false,
  'assistant.newChat.autoCompact': true,
  'assistant.effort': 'auto',
  'assistant.timeBudget': 14400,
  'mcp.disabledTools': [],
  'mcp.enabledTools': [],
  'toolbar.quickItems': [],
  'toolbar.quickMain': '',
  'drawing.templates': [],
  'connectors.automatic': false,
  'connectors.automaticDeclined': false,
  'connectors.automaticRequest': {},
};

interface SettingsState {
  values: Settings;
  defaults: Settings;
  /** The server answered at least once (false: cached or defaults only). */
  synced: boolean;
  /** Keys being saved right now. */
  saving: SettingKey[];
}

const CACHE = 'steve-settings';
const read = (): Partial<Settings> => {
  try { return JSON.parse(localStorage.getItem(accountKey(CACHE)) ?? '{}') as Partial<Settings>; } catch { return {}; }
};
const cache = (values: Settings) => { try { localStorage.setItem(accountKey(CACHE), JSON.stringify(values)); } catch { /* Optional. */ } };

export const useSettings = create<SettingsState>(() => ({ values: { ...DEFAULTS, ...read() }, defaults: DEFAULTS, synced: false, saving: [] }));

/** A setting's current value, outside React. */
export const setting = <K extends SettingKey>(key: K): Settings[K] => useSettings.getState().values[key];
/** A setting's current value, in React. */
export const useSetting = <K extends SettingKey>(key: K): Settings[K] => useSettings((state) => state.values[key]);

interface Reply { settings?: Partial<Settings>; defaults?: Partial<Settings> }

// Changes not yet sent (a slider sends one save when it comes to rest), and what each key was before them.
let pending: Partial<Settings> = {};
let before: Partial<Settings> = {};
let waiting: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let saves = Promise.resolve();
const SAVE_PAUSE_MS = 300;

/** The server's word, with changes made since it was asked still on top. */
const apply = (reply: Reply) => {
  const defaults = { ...DEFAULTS, ...(reply.defaults ?? {}) };
  const values = { ...defaults, ...(reply.settings ?? {}), ...pending };
  useSettings.setState({ values, defaults, synced: true });
  cache(values);
};

/** Loads the account's settings (after sign-in). Without a server, the cache and defaults stand. */
export async function loadSettings() {
  useSettings.setState({ values: { ...useSettings.getState().defaults, ...read() } });  // This account's cache (accountKey).
  try { apply(await api<Reply>('/v1/settings')); } catch { /* Offline or an older server: keep what's cached. */ }
}

async function save() {
  const change = pending;
  const was = before;
  const done = waiting;
  pending = {}; before = {}; waiting = [];
  const keys = Object.keys(change) as SettingKey[];
  if (!keys.length) { done.forEach((resolve) => resolve()); return; }
  try {
    apply(await api<Reply>('/v1/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) }));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {  // 404: a server without account settings; this browser keeps them.
      const restored = { ...useSettings.getState().values };
      for (const key of keys) if (!(key in pending)) (restored as Record<string, unknown>)[key] = was[key];
      useSettings.setState({ values: restored });
      cache(restored);
      toast('danger', 'Setting not saved', error instanceof Error ? error.message : 'The server refused it.');
    }
  } finally {
    useSettings.setState((state) => ({ saving: state.saving.filter((key) => key in pending) }));
    done.forEach((resolve) => resolve());
  }
}

/** Changes settings: shown at once, saved a moment later, put back (with the reason) if the server refuses. */
export function updateSettings(change: Partial<Settings>): Promise<void> {
  const current = useSettings.getState().values;
  const keys = Object.keys(change) as SettingKey[];
  for (const key of keys) if (!(key in before)) (before as Record<string, unknown>)[key] = current[key];
  Object.assign(pending, change);
  const values = { ...current, ...change };
  useSettings.setState((state) => ({ values, saving: [...new Set([...state.saving, ...keys])] }));
  cache(values);
  clearTimeout(timer);
  timer = setTimeout(() => { saves = saves.then(save); }, SAVE_PAUSE_MS);
  return new Promise((resolve) => { waiting.push(resolve); });
}

export const updateSetting = <K extends SettingKey>(key: K, value: Settings[K]) => updateSettings({ [key]: value } as Partial<Settings>);

/** Back to the account default (the server's). */
export function resetSettings(keys: SettingKey[]) {
  const { defaults } = useSettings.getState();
  return updateSettings(Object.fromEntries(keys.map((key) => [key, defaults[key]])) as Partial<Settings>);
}

/** How a model looks when it opens (Settings → Display), as the app state's fields. */
export function displayDefaults() {
  const values = useSettings.getState().values;
  return {
    style: values['display.style'], projection: values['display.projection'], showGrid: values['display.grid'],
    showShadows: values['display.shadows'], showOrigin: values['display.originPlanes'],
    viewportBackground: values['display.background'],
  };
}
