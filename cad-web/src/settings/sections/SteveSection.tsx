/**
 * Settings → STEVE: the person's own provider keys, the default model for new chats, how new chats start, and the
 * spending limits they set. (How STEVE works in one conversation, and what it cost, sit in the chat's header.)
 */
import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, RotateCcw } from 'lucide-react';
import { Button, Select, Switch } from '@/ui';
import {
  Api, type AssistantConfig, type ProviderId, type ProviderKey, type ProviderKeys, type QuotaUsage, type SelfLimitName, type SelfLimits,
} from '@/lib/api';
import { tokens, usd } from '@/lib/format';
import { DOCS_ROOT } from '@/lib/docs';
import {
  assistantConfig, choiceKey, DEFAULT_KEY, fmtPrice, MODEL_KEY, modelInfo, modelsOf, providerName, serverDefaultOf, STORAGE_NOTE, store, type Choice,
} from '@/panels/steve';
import styles from '@/panels/Assistant.module.css';
import own from '@/panels/Steve.module.css';
import { updateSetting, useSetting, useSettings, type SettingKey } from '../store';
import EffortChoices from '@/panels/EffortChoices';
import { effectiveEffort, effortLabel, effortsOf } from '@/panels/effort';
import { settingsSections } from '../registry';
import { Card, Note, Row, SettingsPage } from '../ui';

const KEY_PAGES: Record<ProviderId, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  xai: 'https://console.x.ai',
  google: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
};
const KEY_SHAPES: Record<ProviderId, string> = {
  anthropic: 'sk-ant-…', openai: 'sk-…', xai: 'xai-…', google: 'Google AI Studio key', openrouter: 'OpenRouter API key',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

function KeyRow({ item, onChange }: { item: ProviderKey; onChange: (next: ProviderKeys) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState(false);
  const close = () => { setEditing(false); setValue(''); setError(''); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const next = await Api.saveProviderKey(item.provider, value.trim());
      close();   // The key leaves this component's state as soon as it's stored.
      onChange(next);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { onChange(await Api.deleteProviderKey(item.provider)); setConfirming(false); setDeleted(true); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const status = item.source === 'development' ? 'Development server key'
    : item.configured ? `Key ending ${item.hint} · added ${when(item.added_at)} · ${item.last_used_at ? `last used ${when(item.last_used_at)}` : 'not used yet'}`
      : 'No key';
  return (
    <div className={own.keyRow} data-provider={item.provider} data-configured={item.configured || undefined}>
      <div className={own.keyHead}>
        <KeyRound size={14} className={own.keyIcon} />
        <span className={own.keyName}>{item.name}</span>
        {item.configured && <span className={own.keyOk}><Check size={11} />Ready</span>}
      </div>
      <p className={own.keyMeta}>{status}</p>
      {editing ? (
        <form className={own.keyForm} onSubmit={(event) => { event.preventDefault(); if (value.trim()) void save(); }}>
          <input type="password" className={own.keyInput} value={value} onChange={(event) => setValue(event.target.value)} autoFocus
            placeholder={KEY_SHAPES[item.provider]} aria-label={`${item.name} API key`}
            autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" disabled={busy} />
          <div className={own.keyActions}>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>{busy ? 'Checking…' : 'Save key'}</Button>
            <Button size="sm" onClick={close} disabled={busy}>Cancel</Button>
            <a className={own.keyLink} href={KEY_PAGES[item.provider]} target="_blank" rel="noopener noreferrer">Get a key<ExternalLink size={11} /></a>
          </div>
          <p className={own.hint}>STEVE checks it with {item.name}, then stores it encrypted. It’s never shown again.</p>
        </form>
      ) : confirming ? (
        <div className={own.confirmRow}>
          Delete your {item.name} key? New keys can’t be added, so STEVE’s in-app assistant can’t use {item.name} again.
          <div className={own.confirmButtons}>
            <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
            <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>Delete key</Button>
          </div>
        </div>
      ) : item.source !== 'development' && item.configured && (
        // The in-app assistant retires on 30 October: keys can be deleted, not added or replaced.
        <div className={own.keyActions}>
          <Button size="sm" onClick={() => setConfirming(true)}>Delete key</Button>
        </div>
      )}
      {deleted && !item.configured && <p className={own.hint} role="status">Key deleted. Your key has been removed from STEVE.</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

/** The in-app assistant retires on 30 October (docs: steve/assistant-retirement): one line, the reasons in the docs. */
export function RetiringNote() {
  return (
    <p className={own.note} role="status" data-assistant-retiring>
      The in-app assistant retires on 30 October.{' '}
      <a href={`${DOCS_ROOT}steve/assistant-retirement/`} target="_blank" rel="noopener noreferrer">Why</a>
    </p>
  );
}

function ApiKeys({ onChange }: { onChange: () => void }) {
  const [keys, setKeys] = useState<ProviderKeys | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Api.providerKeys().then((value) => { if (!cancelled) setKeys(value); }).catch((caught) => { if (!cancelled) setError((caught as Error).message); });
    return () => { cancelled = true; };
  }, []);
  const changed = (next: ProviderKeys) => { setKeys(next); onChange(); };
  const anyDev = keys?.providers.some((item) => item.source === 'development');
  return (
    <Card title="API keys" id="steve-keys" description="STEVE runs on your own Anthropic, OpenAI, xAI, Google (Gemini) or OpenRouter account; they bill you directly. OpenRouter offers many other vendors’ models.">
      <RetiringNote />
      {keys && keys.storage !== 'ready' && !anyDev && STORAGE_NOTE[keys.storage] && <p className={own.note} role="status">{STORAGE_NOTE[keys.storage]}</p>}
      {keys?.providers.map((item) => <KeyRow key={item.provider} item={item} onChange={changed} />)}
      {!keys && !error && <p className={own.hint}>Loading…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Card>
  );
}

function DefaultModel({ config, onConfig }: { config: AssistantConfig; onConfig: (next: AssistantConfig) => void }) {
  const [error, setError] = useState('');
  const preferred = config.preferences?.default_model ?? null;
  const serverDefault = serverDefaultOf(config);
  const marked = preferred ?? serverDefault;
  const choose = async (next: Choice | null) => {
    setError('');
    try {
      const saved = await Api.assistantPreferences({ default_model: next });
      store(DEFAULT_KEY, saved.default_model ? choiceKey(saved.default_model) : null);
      if (next) store(MODEL_KEY, choiceKey(next));  // The next message uses it too.
      onConfig({ ...config, preferences: saved });
    } catch (caught) { setError((caught as Error).message); }
  };
  return (
    <Card title="Default model" id="steve-model" description="Used for new chats and on a new device. The chat’s model picker changes the model for your next message.">
      <div className={own.models} role="radiogroup" aria-label="Default model">
        {config.providers.map((provider) => (
          <div key={provider.id} className={own.provider}>
            <div className={styles.modelGroup}>
              <span className="caps">{providerName(provider.id)}</span>
              {provider.configured ? <span className={styles.modelUnit}>$ in / out per 1M tokens</span> : <span className={styles.modelMissing}>Add a key above</span>}
            </div>
            {modelsOf(provider).map((model) => {
              const choice = { provider: provider.id, model: model.id };
              const on = !!marked && choiceKey(choice) === choiceKey(marked);
              const price = model.price_per_million;
              return (
                <button key={model.id} type="button" role="radio" aria-checked={on} className={own.model} data-on={on || undefined} disabled={!provider.configured}
                  data-model={choiceKey(choice)} onClick={() => { if (!on) void choose(choice); }}>
                  <span className={own.radio}>{on && <Check size={12} />}</span>
                  <span className={own.modelName}>{model.label}{!preferred && on && <span className={styles.defaultTag}>Server default</span>}</span>
                  <span className={styles.modelPrice}>{price ? `$${fmtPrice(price.input)} / $${fmtPrice(price.output)}` : 'Price n/a'}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {preferred && <button type="button" className={styles.textButton} onClick={() => void choose(null)}><RotateCcw size={13} />Use the server default</button>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Card>
  );
}

const LIMITS: { name: SelfLimitName; label: string; unit: 'usd' | 'tokens' }[] = [
  { name: 'steve_usd_day', label: 'Per day', unit: 'usd' },
  { name: 'steve_usd_month', label: 'Per month', unit: 'usd' },
  { name: 'steve_tokens_day', label: 'Per day', unit: 'tokens' },
  { name: 'steve_tokens_month', label: 'Per month', unit: 'tokens' },
];
const shown = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

function SpendingLimits() {
  const [saved, setSaved] = useState<SelfLimits | null>(null);
  const [usage, setUsage] = useState<Record<string, QuotaUsage>>({});
  const [draft, setDraft] = useState<Record<SelfLimitName, string>>({ steve_usd_day: '', steve_usd_month: '', steve_tokens_day: '', steve_tokens_month: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const adopt = (self: SelfLimits) => {
    setSaved(self);
    setDraft(Object.fromEntries(LIMITS.map(({ name }) => [name, shown(self[name])])) as Record<SelfLimitName, string>);
  };
  useEffect(() => {
    let cancelled = false;
    Api.quotas().then((value) => {
      if (cancelled) return;
      adopt(value.self);
      setUsage(Object.fromEntries(value.quotas.map((item) => [item.quota, item])));
    }).catch((caught) => { if (!cancelled) setError((caught as Error).message); });
    return () => { cancelled = true; };
  }, []);
  const invalid = LIMITS.find(({ name }) => draft[name].trim() !== '' && !(Number(draft[name]) >= 0));
  const dirty = !!saved && LIMITS.some(({ name }) => draft[name].trim() !== shown(saved[name]));
  const save = async () => {
    setBusy(true); setError(''); setDone(false);
    try {
      const limits = Object.fromEntries(LIMITS.map(({ name }) => [name, draft[name].trim() === '' ? null : Number(draft[name])]));
      adopt((await Api.setSelfLimits(limits)).self);
      setDone(true);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const used = (name: SelfLimitName, unit: 'usd' | 'tokens') => {
    const value = usage[name]?.used;
    return value === undefined ? '' : unit === 'usd' ? `${usd(String(value))} used` : `${tokens(value)} used`;
  };
  return (
    <Card title="Spending limits" id="steve-limits" description="Optional. When you reach a limit, STEVE stops starting new work until it resets (UTC days and months). Dollar amounts are estimated from published prices. Leave a box empty for no limit.">
      {saved && (['usd', 'tokens'] as const).map((unit) => (
        <div key={unit}>
          <h4 className={own.subhead}>{unit === 'usd' ? 'Estimated cost (USD)' : 'Tokens (input + output)'}</h4>
          <div className={own.limits}>
            {LIMITS.filter((item) => item.unit === unit).map(({ name, label }) => (
              <label key={name} className={own.limit}>
                <span>{label}</span>
                {/* Typed only, deliberately not a scrubbable NumberField: a spending limit should never change by a stray drag. */}
                <input type="number" min={0} step={unit === 'usd' ? 0.5 : 1000} inputMode="decimal" placeholder="No limit" value={draft[name]}
                  data-limit={name} onChange={(event) => { setDraft({ ...draft, [name]: event.target.value }); setDone(false); }} disabled={busy} />
                <small>{used(name, unit)}</small>
              </label>
            ))}
          </div>
        </div>
      ))}
      {saved && (
        <div className={own.keyActions}>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || !dirty || !!invalid}>{busy ? 'Saving…' : 'Save limits'}</Button>
          {done && <span className={own.saved}><Check size={12} />Saved</span>}
        </div>
      )}
      {invalid && <p className={styles.error} role="alert">Limits must be zero or more.</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Card>
  );
}

const NEW_CHAT: { key: SettingKey; title: string; hint: string }[] = [
  { key: 'assistant.newChat.planning', title: 'Planning', hint: 'A short task list for work with multiple steps.' },
  { key: 'assistant.newChat.autoCompact', title: 'Manage context automatically', hint: 'Summarize older working context; your chat history stays.' },
  { key: 'assistant.newChat.subagents', title: 'CAD reviewer subagent', hint: 'A read-only review, up to two per message. Uses additional model tokens.' },
];

function NewChats() {
  const values = useSettings((state) => state.values);
  return (
    <Card title="New chats start with" id="steve-new-chats" description="Each chat can still change these for itself, from the chat’s header.">
      {NEW_CHAT.map(({ key, title, hint }) => (
        <Row key={key} label={title} hint={hint} setting={key}>
          <Switch checked={values[key] as boolean} onCheckedChange={(on) => void updateSetting(key, on as never)} label={title} />
        </Row>
      ))}
    </Card>
  );
}

/** How hard STEVE thinks (app/assistant_effort.py): the account's choice; the chat can change it for its next messages. */
function ReasoningEffort({ config }: { config: AssistantConfig }) {
  const wanted = useSetting('assistant.effort');
  const target = config.preferences?.default_model ?? serverDefaultOf(config);
  const offered = effortsOf(config, target);
  const { effort, fallback } = effectiveEffort(wanted, offered);
  const name = modelInfo(config, target)?.model.label ?? 'Your default model';
  return (
    <Card title="Reasoning effort" id="steve-effort"
      description="How hard STEVE thinks before it answers. Higher levels think longer, so they’re slower and cost more. The chat can change it for its next messages.">
      {fallback && <Note tone="warning">You chose {effortLabel(wanted)}, which {name} doesn’t offer, so STEVE uses Automatic with it.</Note>}
      {!offered.length && <Note>{name} doesn’t offer effort levels: it decides for itself.</Note>}
      <div data-setting="assistant.effort" data-effort-value={wanted}>
        <EffortChoices value={effort} offered={offered} onChoose={(next) => void updateSetting('assistant.effort', next)} />
      </div>
      <p className={own.hint} style={{ marginTop: 8 }}>The levels {name}, your default model, offers. With a model that doesn’t offer your level, STEVE uses Automatic.</p>
    </Card>
  );
}

/** "15 min", "1 h", "1 h 30 min", or seconds for a short (lab) budget. */
export function budgetLabel(seconds: number) {
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

/** What each working time suits (the server may offer others: its default, or its cap). */
const BUDGET_HINTS: Record<number, string> = {
  900: 'Questions and small edits',
  1800: 'Most parts and designs',
  3600: 'Large designs and assemblies',
  7200: 'Boards and long builds',
};

/** How long STEVE works on one message (app/config.py): then it wraps up, and the person says “continue” for more. */
function WorkingTime({ config }: { config: AssistantConfig }) {
  const chosen = useSetting('assistant.timeBudget');
  // The server's default (its own word, or what /v1/settings sent): never one of the web's own.
  const accountDefault = useSettings((state) => state.defaults['assistant.timeBudget']);
  const fallback = config.limits?.seconds ?? accountDefault;
  const choices = config.limits?.time_budgets?.length ? config.limits.time_budgets
    : [...new Set([900, 1800, 3600, 7200, fallback])].sort((a, b) => a - b);
  const max = config.limits?.time_budget_max;
  return (
    <Card title="Working time" id="steve-time-budget"
      description="How long STEVE works on one message. When the time is up it starts nothing new: it tells you what’s done and what’s left, and “continue” picks up from there with nothing lost.">
      <Row label="Each message" setting="assistant.timeBudget"
        hint={`Longer suits big designs and boards; shorter keeps a stuck request from using your tokens.${max ? ` This server allows up to ${budgetLabel(max)}.` : ''}`}>
        <Select ariaLabel="Working time for each message" value={String(choices.includes(chosen) ? chosen : fallback)}
          onChange={(value) => void updateSetting('assistant.timeBudget', Number(value))}
          options={choices.map((seconds) => ({ value: String(seconds), label: `${budgetLabel(seconds)}${seconds === fallback ? ' (default)' : ''}`,
            hint: BUDGET_HINTS[seconds] }))} />
      </Row>
    </Card>
  );
}

export default function SteveSection() {
  const section = settingsSections().find((item) => item.id === 'steve')!;
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    assistantConfig().then((value) => { if (!cancelled) setConfig(value); }).catch((caught) => { if (!cancelled) setError((caught as Error).message); });
    return () => { cancelled = true; };
  }, []);
  return (
    <SettingsPage section={section}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <ApiKeys onChange={() => { void assistantConfig(true).then(setConfig).catch(() => undefined); }} />
      {config ? <DefaultModel config={config} onConfig={(next) => { setConfig(next); void assistantConfig(true); }} />
        : !error && <Card title="Default model"><p className={own.hint}>Loading STEVE’s models…</p></Card>}
      {config && <ReasoningEffort config={config} />}
      {config && <WorkingTime config={config} />}
      <NewChats />
      <SpendingLimits />
    </SettingsPage>
  );
}
