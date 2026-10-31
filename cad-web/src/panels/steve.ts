/**
 * What the right pane's STEVE and History tabs and Settings → STEVE share: model choices, the open conversation
 * (remembered in this browser), unsent drafts per conversation, and a conversation picked in History
 * for the chat to open. Only one of those tabs is mounted at a time, so this lives outside them.
 */
import { create } from 'zustand';
import { Api, type AssistantConfig, type Conversation, type KeyStorage } from '@/lib/api';
import { accountKey, forgetShared } from '@/state/accountStorage';

export const MODEL_KEY = 'steve-ai-model'; // The last model used in this browser, `provider|model`.
export const DEFAULT_KEY = 'steve-ai-default'; // Mirror of the person's saved default (server preference).
export const CONVERSATION_KEY = 'steve-conversation';
export const PROVIDER_KEY = 'steve-ai-provider';

/**
 * Model choices are kept in this browser for the signed-in account (state/accountStorage.ts): another account here
 * starts with its own. The open conversation's id stays shared: the API answers 404 for another account's, and the
 * chat forgets it.
 */
const keyOf = (key: string) => (key === CONVERSATION_KEY ? key : accountKey(key));
export function stored(key: string) { try { return localStorage.getItem(keyOf(key)); } catch { return null; } }
export function store(key: string, value: string | null) {
  if (key !== CONVERSATION_KEY) forgetShared(key);
  try { if (value) localStorage.setItem(keyOf(key), value); else localStorage.removeItem(keyOf(key)); } catch { /* Optional. */ }
}

const PROVIDERS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI (Grok)', google: 'Google (Gemini)', openrouter: 'OpenRouter' };
export const providerName = (id?: string | null) => (id && PROVIDERS[id]) || id || '';
/** Why keys can't be added or used right now, when key storage isn't ready. */
export const STORAGE_NOTE: Partial<Record<KeyStorage, string>> = {
  sealed: 'Key storage is locked after a server restart. Your saved keys are safe; STEVE can use them again once an administrator unlocks it.',
  unavailable: 'Key storage isn’t reachable right now, so keys can’t be added or used. Try again shortly.',
  not_configured: 'Key storage isn’t set up on this server yet, so keys can’t be saved.',
};
export const fmtPrice = (value: number) => (value < 1 ? value.toFixed(2) : Number(value.toFixed(2)).toString());

export type Choice = { provider: string; model: string };
export const choiceKey = (choice: Choice) => `${choice.provider}|${choice.model}`;
/** `provider|model`; a bare model ID (older browsers stored only that) is matched to its provider. */
export function parseChoice(value: string | null, config: AssistantConfig | null): Choice | null {
  if (!value) return null;
  if (value.includes('|')) { const [provider, model] = value.split('|'); return provider && model ? { provider, model } : null; }
  const provider = config?.providers.find((item) => item.models?.some((m) => m.id === value));
  return provider ? { provider: provider.id, model: value } : null;
}
/** A provider's models; without a list, its default alone (none for OpenRouter before a key lists its models). */
export const modelsOf = (provider: AssistantConfig['providers'][number]) => (provider.models?.length ? provider.models
  : provider.model ? [{ id: provider.model, label: provider.model, default: true, price_per_million: null }] : []);
export function modelInfo(config: AssistantConfig | null, choice: Choice | null) {
  const provider = choice && config?.providers.find((item) => item.id === choice.provider);
  const model = provider && modelsOf(provider).find((item) => item.id === choice!.model);
  return provider && model ? { provider, model } : null;
}
/** The server's default model: its default provider when configured, else the first configured one. */
export function serverDefaultOf(config: AssistantConfig | null): Choice | null {
  const item = config?.providers.find((p) => p.id === config.default && p.configured) ?? config?.providers.find((p) => p.configured) ?? config?.providers[0];
  return item ? { provider: item.id, model: item.model } : null;
}

let configLoad: Promise<AssistantConfig> | null = null;
/** The assistant's providers, models, defaults and the person's preferences (loaded once; `fresh` reloads). */
export function assistantConfig(fresh = false): Promise<AssistantConfig> {
  if (!configLoad || fresh) {
    configLoad = Api.assistantConfig();
    configLoad.catch(() => { configLoad = null; });
  }
  return configLoad;
}

/** Unsent messages per conversation ('unsaved' before one exists); they survive switching tabs. */
export const drafts = new Map<string, string>();

/**
 * What History asked the chat to show when it mounts (a conversation it opened, or a new chat), and a question
 * another part of the app wrote for the person to send (it replaces the composer's text once).
 */
/** `prefill`: a question written elsewhere for the composer; `autoSend`: the same text, sent as soon as it shows. */
export const useSteve = create<{ opening: Conversation | 'new' | null; prefill: string | null; autoSend: string | null }>(() => ({ opening: null, prefill: null, autoSend: null }));

/** Ask STEVE in the STEVE tab, straight away (e.g. "Explain this code" from the editor). */
export function askSteveNow(text: string) { useSteve.setState({ prefill: text, autoSend: text }); }
