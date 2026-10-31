import { openDesktop, syncLocalDocument } from '@/localDesktop';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { circuitSelectionContext } from '@/workspaces/electronics/state';
import { loadLinkedStudies } from '@/workspaces/simulate/state';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu } from 'radix-ui';
import clsx from 'clsx';
import { ArrowUp, BookOpenCheck, Camera, Check, ChevronDown, Clock3, CornerDownRight, ExternalLink, ImagePlus, MousePointer2, Plus, RotateCcw, Square, Star, Wrench, X } from 'lucide-react';
import { Button, IconButton, MenuContent, MenuSeparator, Spinner, Tip, ui } from '@/ui';
import { tokens, usd } from '@/lib/format';
import { Api, ApiError, type AssistantConfig, type AttachmentMeta, type ChatTurn, type QueuedMessage } from '@/lib/api';
import { get, isDirty, snapshot, useApp } from '@/state/store';
import { openDocument, saveDocument } from '@/state/actions';
import SteveMarkdown from '@/steve/markdown.js';
import { openTab } from '@/state/tabs';
import { VIEW_LABELS, viewer } from '@/viewport/viewer';
import { analyze, selectionContext } from '@/viewport/semantics';
import mark from '@/steve/mark.svg';
import styles from './Assistant.module.css';
import { useConversation } from './useConversation';
import ConversationSettings from './ConversationSettings';
import { EFFORT_KEY, effectiveEffort, effortLabel, effortsOf, type Effort } from './effort';
import { updateSetting, useSetting } from '@/settings/store';
import { useAssistantRun } from './useAssistantRun';
import { uuid } from '@/lib/uuid';
import CopyMessage from '@/shell/CopyMessage';
import { stepLabel, statusOf, type Step } from './activity';
import { WaitingRuns } from '@/dialogs/RunActionDialog';
import { checkPendingSoon } from '@/lib/pendingRuns';
import { DraftTray, Lightbox, MAX_IMAGES, MessageImages, draftsFrom, isImage, useDraftImages, viewSnapshot } from './attachments';
import ModelUnavailableNotice, { type OfferedModel } from './ModelUnavailableNotice';

import { useSteve, assistantConfig, choiceKey, DEFAULT_KEY, fmtPrice, MODEL_KEY, modelInfo, modelsOf, parseChoice, providerName, serverDefaultOf, store, stored, type Choice } from './steve';

/** When the chosen provider has no usable key: how to add one, or use STEVE from a subscription over MCP. */
function NoKey(_props: { provider: string; storage?: AssistantConfig['key_storage'] }) {
  return <div className={styles.noKey} role="status"><strong>Connect your ChatGPT account</strong>
    <p>Steve uses your subscription and the tools enabled on this machine.</p>
    <Button onClick={() => void openDesktop('account')}>Sign in or refresh models</Button></div>;
}



const SUGGESTIONS: Record<string, { label: string; prompt: string }[]> = {
  design: [
    { label: 'Make a mounting plate', prompt: 'Create a new part: an 80 × 50 × 6 mm mounting plate with four 6 mm holes centered 10 mm from each edge and 4 mm corner fillets.' },
    { label: 'Explain this design', prompt: 'Explain how the open design is built, what its key dimensions are, and anything that looks fragile.' },
    { label: 'Add a counterbore', prompt: 'Change the holes in this part to M5 counterbored holes.' },
  ],
  simulate: [
    { label: 'Where will this fail?', prompt: 'Looking at this design, which features are likely stress concentrations under a load on the top face, and how could I reinforce them?' },
    { label: 'Suggest a material', prompt: 'Suggest a material for this part for a light-duty bracket and explain the trade-offs.' },
  ],
  manufacture: [
    { label: 'Machinability review', prompt: 'Review this part for CNC milling: internal corner radii, deep pockets, thin walls and tool access. Suggest design changes.' },
    { label: 'Plan operations', prompt: 'Propose a 3-axis milling operation plan for this part with suggested tools.' },
  ],
  electronics: [
    { label: 'Design a board', prompt: 'Help me design a circuit board. Ask me what it needs to do first, then pick real in-stock parts and lay it out.' },
    { label: 'Explain this circuit', prompt: 'Explain what the open circuit does, block by block, in plain words, and anything that looks risky.' },
    { label: 'Is it ready to order?', prompt: 'Check the open board and tell me, in plain words, what stands between it and ordering it, and fix what you can.' },
  ],
};

/** What STEVE does, as the empty conversation introduces it, per workspace. */
const INTRO: Record<string, string> = {
  design: 'Describe what you want to build, inspect or change. STEVE writes CadQuery, generates the geometry and saves it as a document.',
  electronics: 'Describe the board you need, or ask about the open one. STEVE writes the circuit, picks real in-stock parts and checks it’s ready to order.',
};

function Message({ turn, onOpen, onView, currentId }: { turn: ChatTurn; onOpen: (id: string) => void; onView: (image: AttachmentMeta) => void; currentId?: string | null }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.querySelectorAll('a').forEach((link) => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
  }, [turn.assistant]);
  return (
    <>
      {turn.steered && turn.user && <div className={styles.steeredNote}><CornerDownRight size={11} />Sent while STEVE was working</div>}
      {!!turn.attachments?.length && (
        <motion.div className={styles.userImages} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
          <MessageImages images={turn.attachments} onOpen={onView} />
        </motion.div>
      )}
      {turn.user && <motion.div className={styles.user} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>{turn.user}</motion.div>}
      {(turn.assistant || turn.stopped || turn.failed) && (
        <motion.div className={styles.assistant} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.05 }}>
          <img src={mark} alt="" className={styles.avatar} />
          <div className={styles.assistantBody}>
            {(!!turn.skills?.length || !!turn.tools?.some((tool) => tool !== 'load_capability')) && (
              <div className={styles.tools}>
                <Wrench size={11} />
                {turn.skills?.map((skill) => <span key={'skill:' + skill} className={styles.skillChip} data-loaded-skill={skill}><BookOpenCheck size={10} />Loaded skill: {skill}</span>)}
                {turn.tools?.filter((tool) => tool !== 'load_capability').map((tool, index) => <span key={index} className={styles.tool} data-tool={tool}>{stepLabel({ name: tool, status: 'finished', agent: 'steve' })}</span>)}
              </div>
            )}
            {turn.assistant && <div ref={body} className={styles.markdown} dangerouslySetInnerHTML={{ __html: SteveMarkdown.render(turn.assistant) }} />}
            {(turn.stopped || turn.failed || turn.usage) && <div className={styles.meta}>
              {turn.stopped && !turn.error && <span className={styles.stopped} data-testid="stopped"><Square size={8} fill="currentColor" />{turn.assistant ? 'Stopped' : 'Stopped before replying'}</span>}
              {turn.stopped && turn.error && (
                <Tip label="STEVE reached its time limit" description={turn.error}>
                  <span className={styles.stopped} data-testid="stopped"><Square size={8} fill="currentColor" />Stopped at its time limit · say “continue”</span>
                </Tip>
              )}
              {turn.failed && (
                <Tip label="STEVE couldn't finish" description={turn.error}>
                  <span className={styles.stopped} data-testid="failed"><X size={9} />{turn.assistant ? 'Didn’t finish' : 'Failed before replying'}</span>
                </Tip>
              )}
              {turn.usage && (
                <Tip label={turn.stopped || turn.failed ? 'What STEVE used before it stopped' : 'What this answer used'} description={`${turn.usage.input_tokens.toLocaleString()} input · ${turn.usage.output_tokens.toLocaleString()} output · ${turn.usage.cache_read_tokens.toLocaleString()} cached tokens · ${turn.usage.requests} model calls · ${turn.usage.tool_calls} tool calls${turn.usage.cost_usd === null ? ' · price unknown for this model' : ''}${turn.usage.effort ? ` · ${effortLabel(turn.usage.effort)} reasoning effort` : ''}${turn.usage.effort_note ? `. ${turn.usage.effort_note}` : ''}`}>
                  <span className={styles.usage}>{tokens(turn.usage.input_tokens + turn.usage.output_tokens)} tokens{usd(turn.usage.cost_usd) ? ` · ${usd(turn.usage.cost_usd)}` : ''}{turn.usage.effort && turn.usage.effort !== 'auto' ? ` · ${effortLabel(turn.usage.effort)} effort` : ''}</span>
                </Tip>
              )}
            </div>}
            {/* Only offer navigation when STEVE worked on a different design than the one open. */}
            {turn.document_id && turn.document_id !== currentId && (
              <button type="button" className={styles.openDesign} onClick={() => onOpen(turn.document_id!)}><ExternalLink size={12} />Open the design STEVE worked on</button>
            )}
          </div>
        </motion.div>
      )}
    </>
  );
}

/** Provider and model for STEVE's next message, grouped by provider, with prices and the person's default. */
function ModelPicker({ config, value, preferred, fallback, busy, onChange, onMakeDefault }: {
  config: AssistantConfig | null; value: Choice | null; preferred: Choice | null; fallback: Choice | null; busy: boolean;
  onChange: (choice: Choice) => void; onMakeDefault: (choice: Choice | null) => void;
}) {
  const info = modelInfo(config, value);
  const label = info?.model.label ?? value?.model ?? 'Loading models…';
  const marked = preferred && modelInfo(config, preferred) ? preferred : fallback;
  const isMarked = (choice: Choice | null) => !!choice && !!marked && choiceKey(choice) === choiceKey(marked);
  return (
    <DropdownMenu.Root modal={false}>
      <Tip label="STEVE's AI model" description={busy ? 'A change applies to your next message; STEVE finishes this one with its current model.' : 'Choose the provider and model STEVE uses for your next message.'}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={styles.modelTrigger} id="model-picker" aria-label={`AI model: ${providerName(value?.provider)} ${label}`}>
            <span className={styles.modelText}>
              <span className={styles.modelEyebrow}>AI model</span>
              <span className={styles.modelValue}>{value && <span className={styles.modelProvider}>{providerName(value.provider)}</span>}<strong>{label}</strong></span>
            </span>
            <ChevronDown size={14} />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <MenuContent className={styles.modelMenu} align="start">
        <DropdownMenu.RadioGroup value={value ? choiceKey(value) : ''} onValueChange={(next) => { const choice = parseChoice(next, config); if (choice) onChange(choice); }}>
          {(config?.providers ?? []).map((provider, index) => (
            <DropdownMenu.Group key={provider.id} aria-label={providerName(provider.id)}>
              {index > 0 && <MenuSeparator />}
              <DropdownMenu.Label className={styles.modelGroup}>
                <span className="caps">{providerName(provider.id)}</span>
                {provider.configured ? <span className={styles.modelUnit}>ChatGPT subscription</span> : <span className={styles.modelMissing}>No API key</span>}
              </DropdownMenu.Label>
              {!provider.configured && <p className={styles.modelReason}>Add your {providerName(provider.id)} API key in Settings → STEVE to use these models.</p>}
              {modelsOf(provider).map((model) => {
                const choice = { provider: provider.id, model: model.id };
                const price = model.price_per_million;
                return (
                  <DropdownMenu.RadioItem key={model.id} value={choiceKey(choice)} disabled={!provider.configured} className={clsx(ui.menuItem, styles.modelItem)}>
                    <span className={styles.modelCheck}><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>
                    <span className={styles.modelName}>{model.label}{isMarked(choice) && <span className={styles.defaultTag}>{preferred && isMarked(preferred) ? 'Your default' : 'Default'}</span>}</span>
                    <span className={styles.modelPrice}>{price ? `$${fmtPrice(price.input)} / $${fmtPrice(price.output)}` : 'Included with subscription'}</span>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.RadioGroup>
        <MenuSeparator />
        <DropdownMenu.Item className={ui.menuItem} disabled={!info || !info.provider.configured || (!!preferred && isMarked(value))} onSelect={() => { if (value) onMakeDefault(value); }}>
          <Star /><span>{preferred && isMarked(value) ? `${label} is your default` : `Make ${label} my default`}</span>
        </DropdownMenu.Item>
        {preferred && <DropdownMenu.Item className={ui.menuItem} onSelect={() => onMakeDefault(null)}><RotateCcw /><span>Use the server default</span></DropdownMenu.Item>}
        <p className={styles.modelFootnote}>STEVE keeps using the model you last picked. Your default applies on a new device. If a model is no longer offered, STEVE asks you to pick another.</p>
      </MenuContent>
    </DropdownMenu.Root>
  );
}

/** A message sent while STEVE works, until it is delivered. */
function QueuedBubble({ item, note, onRemove, onView }: { item: QueuedMessage; note: string; onRemove: () => void; onView: (image: AttachmentMeta) => void }) {
  return (
    <motion.div className={styles.queued} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
      transition={{ type: 'spring', stiffness: 460, damping: 36 }} data-queued={item.id}>
      <div className={styles.queuedHead}>
        <Clock3 size={11} /><span>{note}</span>
        <Tip label="Remove" description="Take this message back before STEVE sees it.">
          <button type="button" className={styles.queuedRemove} aria-label="Remove queued message" onClick={onRemove}><X size={12} /></button>
        </Tip>
      </div>
      {!!item.attachments.length && <div className={styles.queuedImages}><MessageImages images={item.attachments} onOpen={onView} /></div>}
      {item.message && <div className={styles.queuedText}>{item.message}</div>}
    </motion.div>
  );
}

export default function Assistant() {
  const currentDocumentId = useApp((state) => state.doc.saved?.id ?? null);
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const { chat, setChat, provider: conversationProvider, setProvider, message, setMessage, loading, error, setError, select, ensure, settings, mounted } = useConversation();
  const turns = chat?.turns ?? [];
  // The model: the last one used in this browser, else the person's default, else the server's.
  const [lastUsed, setLastUsed] = useState<string | null>(() => stored(MODEL_KEY));
  const [preferred, setPreferred] = useState<Choice | null>(() => parseChoice(stored(DEFAULT_KEY), null));
  // The server refused the model as no longer offered (this tab's model list was older than the server's).
  const [refused, setRefused] = useState<{ provider: string; model: string; offered: OfferedModel[] } | null>(null);
  const [stopAsked, setStopAsked] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; attachments: AttachmentMeta[] } | null>(null);
  const [viewing, setViewing] = useState<AttachmentMeta | null>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const images = useDraftImages(useCallback((text: string) => setError(text), [setError]));
  const [started, setStarted] = useState(0);
  const inFlight = useRef(false);
  const followResult = useRef<string | null>(null);
  const designBusy = useApp((state) => state.busy);
  // Switching chats and settings wait for the run; the composer, model and Stop don't.
  const locked = loading || !!pending || !!chat?.busy;
  const working = !!chat?.busy;
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const docName = useApp((state) => (state.doc.open ? state.doc.name : null));
  const hasModel = useApp((state) => !!state.displayed);
  const picks = useApp((state) => state.selection);
  const modelVersion = useApp((state) => state.modelVersion);
  // What STEVE will be told about the selection, in the same words the Inspector uses.
  const selection = useMemo(() => (viewer.model && picks.length ? picks.map((pick) => analyze(viewer.model!, pick)) : []), [picks, modelVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const workspace = useApp((state) => state.workspace);
  const live = useAssistantRun(chat, setChat, setError, (reply) => {
    const before = followResult.current;
    followResult.current = null;
    const designId = get().doc.saved?.id;
    let refreshed: Promise<unknown> = Promise.resolve();
    // Follow STEVE's result only if the user hasn't moved on: refresh this design in place,
    // or open a design STEVE created in its own tab.
    if (before !== null && reply.document_id && snapshot() === before && !isDirty()) {
      const state = get();
      if (reply.document_id === state.doc.saved?.id) refreshed = openDocument(reply.document_id, state.doc.branch, { pose: viewer.capturePose() });
      else openTab({ id: reply.document_id });
    }
    // Studies STEVE created or ran are on the server: show them without a reload (after any reopen).
    if (designId && get().workspace === 'simulate') {
      void refreshed.then(() => (get().doc.saved?.id === designId ? loadLinkedStudies(designId) : undefined)).catch(() => { /* The list stays as it was; reopening the design loads it. */ });
    }
  });
  // The assistant ran a connector action or used a connected service: it may wait for this person's confirmation (shown below its steps),
  // or have made an RMFG quote or cart (the top bar's RMFG button).
  const askedConnector = live.activity.filter((step) => (step.name === 'run_action' || step.name === 'connectors' || step.name === 'integrations') && step.status !== 'started').length;
  useEffect(() => { if (askedConnector) checkPendingSoon(); }, [askedConnector]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await assistantConfig(true);
        if (cancelled) return;
        setConfig(loaded);
      } catch (caught) { if (!cancelled) setError((caught as Error).message); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!config?.preferences) return;
    const saved = config.preferences.default_model;
    setPreferred(saved);
    store(DEFAULT_KEY, saved ? choiceKey(saved) : null);
  }, [config]);

  const settingsOpen = useApp(state => state.dialog === 'settings');
  useEffect(() => {
    if (!settingsOpen) void assistantConfig(true).then(setConfig).catch(() => undefined);
  }, [settingsOpen]);

  const queued = chat?.queued ?? [];
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [turns, pending, live.text, live.timeline.length, live.activity.length, queued.length]);

  const offered = (choice: Choice | null) => !!modelInfo(config, choice)?.provider.configured;
  const serverDefault = useMemo<Choice | null>(() => serverDefaultOf(config), [config]);
  // Resolved without writing anything back, so a late or failed config load never replaces the stored choice.
  const last = parseChoice(lastUsed, config);
  const lastProvider = config?.providers.find((item) => item.id === last?.provider);
  // The provider has a key but no longer offers the last model: it stays chosen and STEVE asks for another (no silent switch).
  const retired = last && lastProvider?.configured && !modelInfo(config, last) ? last : null;
  const choice = config
    ? retired ?? [last, preferred, serverDefault].find(offered) ?? serverDefault
    : parseChoice(lastUsed, null) ?? preferred;
  const provider = choice?.provider ?? conversationProvider;
  const model = choice?.model ?? null;
  const configured = !!config?.providers.find((item) => item.id === provider)?.configured;
  const unavailable = refused ?? (retired && lastProvider ? { ...retired, offered: modelsOf(lastProvider) } : null);
  const choose = (next: Choice) => { setRefused(null); setLastUsed(choiceKey(next)); store(MODEL_KEY, choiceKey(next)); setProvider(next.provider); };
  /** A send refused because the model isn't offered any more: ask for another, and reload this tab's model list. */
  const modelGone = (caught: unknown) => {
    if (!(caught instanceof ApiError && caught.code === 'model_unavailable')) return false;
    const { provider: from, model: gone, offered: models } = caught.data as { provider?: string; model?: string; offered?: OfferedModel[] };
    setRefused({ provider: String(from ?? provider), model: String(gone ?? model ?? ''), offered: models ?? [] });
    void assistantConfig(true).then((loaded) => { if (mounted.current) setConfig(loaded); }).catch(() => { /* The notice already lists the offered models. */ });
    return true;
  };
  const makeDefault = async (next: Choice | null) => {
    try {
      const saved = await Api.assistantPreferences({ default_model: next });
      setPreferred(saved.default_model);
      store(DEFAULT_KEY, saved.default_model ? choiceKey(saved.default_model) : null);
      if (next) choose(next);
    } catch (caught) { setError((caught as Error).message); }
  };
  // Reasoning effort, chosen like the model: the chat's choice in this browser, else the account's (Settings → STEVE).
  const accountEffort = useSetting('assistant.effort');
  const [effortChoice, setEffortChoice] = useState<string | null>(() => stored(EFFORT_KEY));
  const offeredEfforts = effortsOf(config, choice);
  const effort = effectiveEffort(effortChoice ?? accountEffort, offeredEfforts);
  const chooseEffort = (next: Effort) => { setEffortChoice(next); store(EFFORT_KEY, next); };
  const effortAsDefault = async (next: Effort) => {
    await updateSetting('assistant.effort', next);
    setEffortChoice(null); store(EFFORT_KEY, null);  // The chat follows the default again.
  };
  // Sent only when the chat chose: otherwise the server applies the account's (and falls back the same way).
  const effortSent = effortChoice ? effort.effort : undefined;
  const labelOf = (item: { provider?: string | null; model?: string | null }) => {
    const target = item.provider ? { provider: item.provider, model: item.model || config?.providers.find((p) => p.id === item.provider)?.model || '' } : null;
    return modelInfo(config, target)?.model.label ?? target?.model ?? '';
  };
  const queuedNote = (item: QueuedMessage) => {
    const run = live.run;
    const same = !run?.provider || (item.provider === run.provider && (item.model || config?.providers.find((p) => p.id === item.provider)?.model) === run.model);
    return same ? 'Queued · STEVE will see this at its next step' : `Queued · runs next with ${labelOf(item)}`;
  };
  const stopping = !!live.run?.stop_requested || (!!chat?.active_run_id && stopAsked === chat.active_run_id);

  const hasDraft = !!message.trim() || !!images.ready.length;
  const status = stopping ? 'Stopping STEVE…' : live.reconnecting ? 'Reconnecting — STEVE keeps working' : live.run?.status === 'queued' ? 'Waiting to start' : statusOf(live.activity, live.writing);
  const liveBlocks = useMemo(() => live.timeline.reduce<({ kind: 'text'; key: string; text: string } | { kind: 'steer'; key: string; message: QueuedMessage })[]>((blocks, item) => {
    const last = blocks[blocks.length - 1];
    if (item.kind === 'text' && last?.kind === 'text') return [...blocks.slice(0, -1), { ...last, text: last.text + '\n\n' + item.text }];
    return [...blocks, item];
  }, []), [live.timeline]);

  /** What STEVE is told with a message: the open design, branch and selection. */
  const context = () => {
    const documentId = get().doc.saved?.id ?? null;
    // A circuit's picks are parts, pins and nets (workspaces/electronics); a CAD model's are its geometry.
    const detail: { description: string }[] = get().doc.kind === 'circuit' ? circuitSelectionContext() : viewer.model ? selectionContext(viewer.model, get().selection) : [];
    return { document_id: documentId, branch: documentId ? get().doc.branch : null, ui_workspace: get().workspace,
      selection: detail.length ? detail.map((item) => item.description).join(' ').slice(0, 200) : null, selection_detail: detail };
  };

  /** Talk to STEVE while it works: delivered at its next step (or run next); starts a run if it has just finished. */
  const queue = async (conversationId: string, body: Parameters<typeof Api.sendAssistantMessage>[1]) => {
    const outcome = await Api.sendAssistantMessage(conversationId, body);
    if (!mounted.current) return;
    if (outcome.run) setChat((current) => current?.conversation_id === conversationId ? { ...current, busy: true, active_run_id: outcome.run!.run_id } : current);
    else if (outcome.message) {
      const item = outcome.message;
      setChat((current) => current?.conversation_id === conversationId && outcome.status === 'queued'
        ? { ...current, queued: [...(current.queued ?? []).filter((q) => q.id !== item.id), item] } : current);
    }
  };

  const sendWhileWorking = async (trimmed: string) => {
    if (!chat) return;
    inFlight.current = true;
    const { taken, attachments } = images.take();
    setMessage('');
    setError(null);
    try {
      await queue(chat.conversation_id, { request_id: uuid(), message: trimmed, attachments: attachments.map((item) => item.id), provider, model, effort: effortSent, ...context() });
    } catch (caught) {
      if (mounted.current) {
        if (!modelGone(caught)) setError((caught as Error).message);
        setMessage((draft) => draft || trimmed);
        images.restore(taken);
      }
    } finally { inFlight.current = false; }
  };

  const send = async (text = message) => {
    const trimmed = text.trim();
    if ((!trimmed && !images.ready.length) || images.uploading || loading || inFlight.current || !configured || unavailable) return;
    if (working) { if (config?.steering) return void sendWhileWorking(trimmed); return; }
    if (pending || get().busy) return;
    inFlight.current = true;
    const { taken, attachments } = images.take();
    setPending({ text: trimmed, attachments });
    setStarted(Date.now());
    setMessage('');
    setError(null);
    let activeId = chat?.conversation_id;
    const requestId = uuid();
    let body: Parameters<typeof Api.sendAssistantMessage>[1] | null = null;
    try {
      const state = get();
      // Hosted agents edit saved documents. The local agent receives the live
      // draft below; saving here would promote it and unnecessarily rebuild CAD.
      if (!config?.local && state.doc.open && (isDirty(state) || !state.doc.saved) && !await saveDocument()) {
        setMessage((draft) => draft || trimmed);
        images.restore(taken);
        return;
      }
      await syncLocalDocument(true);
      const before = snapshot();
      body = { request_id: requestId, message: trimmed, attachments: attachments.map((item) => item.id), provider, model, effort: effortSent, ...context() };
      const currentChat = await ensure();
      activeId = currentChat.conversation_id;
      if (!mounted.current) return;
      followResult.current = before;
      const run = await Api.startAssistantRun({ ...body, conversation_id: currentChat.conversation_id });
      if (!mounted.current) return;
      setChat({ ...currentChat, provider, busy: true, active_run_id: run.run_id,
        title: currentChat.turn_count ? currentChat.title : trimmed.slice(0, 80) || 'Image' });
    } catch (caught) {
      if (mounted.current) {
        // Another window started a run first: this message joins it instead.
        if (caught instanceof ApiError && caught.status === 409 && activeId && body) {
          try {
            followResult.current = null;
            await queue(activeId, body);
            const value = await Api.conversation(activeId);
            if (mounted.current) setChat(value);
            return;
          } catch { /* Fall through: keep the draft. */ }
        }
        // Not offered any more: nothing was committed; keep the draft and ask for another model.
        if (modelGone(caught)) {
          setMessage((draft) => draft || trimmed);
          images.restore(taken);
          return;
        }
        // A failed submission response may still have committed its durable request.
        try {
          const run = await Api.assistantRun(requestId);
          const value = await Api.conversation(run.conversation_id);
          if (mounted.current) setChat({ ...value, busy: true, active_run_id: run.run_id });
          return;
        } catch { /* No confirmed run: preserve the draft for a retry. */ }
        setError((caught as Error).message);
        setMessage((draft) => draft || trimmed);
        images.restore(taken);
        // A disconnected browser does not imply the server stopped working.
        if (activeId) {
          try { const value = await Api.conversation(activeId); if (mounted.current) setChat(value); } catch { /* Keep the visible transcript. */ }
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(null);
    }
  };
  // A question asked elsewhere to go out at once (the editor's Explain): send it when the composer shows it.
  useEffect(() => {
    const auto = useSteve.getState().autoSend;
    // Wait until STEVE can send (conversation loaded, model configured, nothing else going out).
    if (!auto || loading || !configured || unavailable || pending || (designBusy && !working) || message !== auto) return;
    useSteve.setState({ autoSend: null });
    void send(auto);
  }, [message, loading, configured, !!unavailable, pending, designBusy, working]); // eslint-disable-line react-hooks/exhaustive-deps


  /** Stop: the server cancels the run; messages STEVE hadn't seen come back to the draft. */
  const stop = async () => {
    const id = chat?.active_run_id;
    if (!id || stopping) return;
    setStopAsked(id);
    try {
      const outcome = await Api.stopAssistantRun(id);
      if (!mounted.current) return;
      const texts = outcome.returned.map((item) => item.message).filter(Boolean);
      if (texts.length) setMessage((draft) => [...texts, draft].filter(Boolean).join('\n\n'));
      const returnedImages = outcome.returned.flatMap((item) => item.attachments);
      if (returnedImages.length) images.restore(draftsFrom(returnedImages));
      if (outcome.returned.length) setChat((current) => current ? { ...current, queued: [] } : current);
    } catch (caught) {
      if (mounted.current) { setStopAsked(null); setError((caught as Error).message); }
    }
  };

  const unqueue = async (item: QueuedMessage) => {
    if (!chat) return;
    try {
      await Api.removeQueuedMessage(chat.conversation_id, item.id);
      if (mounted.current) setChat((current) => current ? { ...current, queued: (current.queued ?? []).filter((q) => q.id !== item.id) } : current);
    } catch (caught) { if (mounted.current) setError((caught as Error).message); }
  };

  const reset = async () => {
    if (locked || inFlight.current) return;
    await select();
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const addFiles = (files: Iterable<File>) => images.add(Array.from(files, (file) => ({ blob: file, name: file.name })));
  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files).filter(isImage);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files.map((file, index) => (file.name && file.name !== 'image.png' ? file : new File([file], `Pasted image${files.length > 1 ? ` ${index + 1}` : ''}`, { type: file.type }))));
  };
  const attachView = async () => {
    const frame = viewer.screenshot();
    if (!frame) return;
    try {
      const view = get().view;
      images.add([{ blob: await viewSnapshot(frame), name: `${get().doc.name || 'Model'} · ${view ? `${VIEW_LABELS[view]} view` : 'current view'}` }]);
      input.current?.focus();
    } catch (caught) { setError((caught as Error).message); }
  };
  const picker = useRef<HTMLInputElement>(null);
  const full = images.drafts.length >= MAX_IMAGES;

  return (
    <div className={styles.panel} id="assistant-panel"
      onDragEnter={(event) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current++; setDropping(true); }}
      onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(event) => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
      onDrop={(event) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDropping(false); addFiles(event.dataTransfer.files); input.current?.focus(); }}>
      
      <AnimatePresence>
        {dropping && (
          <motion.div className={styles.dropZone} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            <motion.div initial={{ scale: 0.94, y: 6 }} animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
              <ImagePlus size={26} strokeWidth={1.5} />
              <strong>Show STEVE</strong>
              <span>Drop screenshots, sketches or photos · up to {MAX_IMAGES}</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <Lightbox image={viewing} onClose={() => setViewing(null)} />
      <div className={styles.header}>
        <div className={styles.picker}>
          <ModelPicker config={config} value={choice} preferred={preferred} fallback={serverDefault} busy={working} onChange={choose} onMakeDefault={(next) => void makeDefault(next)} />
        </div>
        <ConversationSettings config={config} chat={chat} locked={locked} onSettings={settings}
          effort={{ value: effort.effort, offered: offeredEfforts, fallback: effort.fallback, wanted: effortChoice ?? accountEffort, account: accountEffort,
            chosen: effortChoice !== null, model: labelOf({ provider, model }), onChoose: chooseEffort, onMakeDefault: (next) => void effortAsDefault(next) }} />
        <button type="button" className={styles.textButton} onClick={() => void reset()} disabled={locked} id="new-chat"><Plus size={14} />New chat</button>
      </div>
      <div className={styles.conversationBar}>
        <span title={chat?.title}>{chat?.title || 'New conversation'}</span>
      </div>
      {error && <div className={styles.error} id="assistant-error" role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}><span style={{ flex: 1 }}>{error}</span><CopyMessage text={error} /></div>}
      <div className={styles.scroll} ref={scroll}>
        {loading && <p className={styles.historyHint} role="status">Loading conversation…</p>}
        {!turns.length && !pending && !loading && !chat?.busy && (
          <div className={styles.welcome} id="assistant-welcome">
            <motion.img src={mark} alt="" initial={{ scale: 0.8, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 18 }} />
            <h2>Good ideas.<br /><em>A little guidance.</em></h2>
            <p>{INTRO[workspace] ?? INTRO.design}</p>
            {(!config || configured) && <div className={styles.suggestions}>
              {(SUGGESTIONS[workspace] ?? SUGGESTIONS.design).map((item, index) => (
                <motion.button key={item.label} type="button" className={styles.suggestion} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + index * 0.05 }} onClick={() => { setMessage(item.prompt); input.current?.focus(); }}>
                  {item.label}<ArrowUp size={12} style={{ rotate: '45deg' }} />
                </motion.button>
              ))}
            </div>}
          </div>
        )}
        <div className={styles.conversation} id="conversation" aria-live="polite">
          {turns.map((turn, index) => <Message key={index} turn={turn} currentId={currentDocumentId} onOpen={(id) => openTab({ id })} onView={setViewing} />)}
          {(pending || live.run) && <Message turn={{ user: pending ? pending.text : live.run!.message, attachments: pending ? pending.attachments : live.run!.attachments, assistant: '' }} onOpen={() => {}} onView={setViewing} />}
          {/* STEVE's live text, with messages delivered while it worked shown where STEVE received them. */}
          {live.run && liveBlocks.map((block) => block.kind === 'steer'
            ? <Message key={block.key} turn={{ user: block.message.message, attachments: block.message.attachments, assistant: '', steered: true }} onOpen={() => {}} onView={setViewing} />
            : <Message key={block.key} turn={{ user: '', assistant: block.text }} onOpen={() => {}} onView={setViewing} />)}
          {!!live.activity.length && <Steps steps={live.activity} />}
          <WaitingRuns kinds={['assistant']} title="STEVE asked your connector: waiting for you" />
          <AnimatePresence>
            {(pending || live.run) && (
              <motion.div className={styles.thinking} id="assistant-thinking" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <img src={mark} alt="" className={styles.avatar} />
                <span className={styles.dots}><i /><i /><i /></span>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span key={status} id="assistant-status" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.15 }}>{status}</motion.span>
                </AnimatePresence>
                <Elapsed since={live.run ? new Date(live.run.created_at).getTime() : started} />
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {queued.map((item) => <QueuedBubble key={item.id} item={item} note={queuedNote(item)} onRemove={() => void unqueue(item)} onView={setViewing} />)}
          </AnimatePresence>
        </div>
        {chat?.busy && !pending && !live.run && <p className={styles.historyHint} role="status">{live.reconnecting ? 'Reconnecting to STEVE…' : 'STEVE is working. This conversation will update when it finishes.'}</p>}
        {!!chat?.plan.length && <details className={styles.plan}><summary>Task plan</summary><ol>{chat.plan.map((item) => <li key={item.id} data-status={item.status}>{item.content} <small>({item.status.replaceAll('_', ' ')})</small></li>)}</ol></details>}
        {config && !configured && <NoKey provider={provider} storage={config.key_storage} />}
        {configured && unavailable && (
          <div className={styles.modelUnavailable}>
            <ModelUnavailableNotice id="assistant-model-choice" model={unavailable.model} offered={unavailable.offered}
              onChoose={(next) => { choose({ provider: unavailable.provider, model: next }); input.current?.focus(); }} />
          </div>
        )}
      </div>
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className={styles.context}>
          <span id="assistant-context">{docName ? `Working with ${docName}` : 'No design open'}</span>
          {selection.length > 0 && (
            <Tip label={`STEVE will see ${selection.length === 1 ? 'this selection' : `these ${selection.length} selections`}`} description={<span style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 260 }}>{selection.slice(0, 4).map((item, index) => <span key={index}>{item.description}</span>)}</span>}>
              <span className={styles.selectionChip}><MousePointer2 size={10} />{selection[0].headline}{selection.length > 1 ? ` +${selection.length - 1}` : ''}</span>
            </Tip>
          )}
        </div>
        <div className={styles.inputWrap}>
          <DraftTray drafts={images.drafts} onRemove={images.remove} />
          <label htmlFor="chat-message" className="sr-only">Message STEVE</label>
          <textarea
            ref={input}
            id="chat-message"
            rows={2}
            disabled={loading || (working && !config?.steering)}
            maxLength={20000}
            placeholder={working ? 'Add to what STEVE is doing — it reads this at its next step' : images.drafts.length ? 'What should STEVE look for?' : 'What are we making?'}
            value={message}
            onPaste={onPaste}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void send(); } }}
          />
          <div className={styles.inputBar}>
            <div className={styles.inputTools}>
              <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
                onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
              <IconButton small label="Attach images" description="Screenshots, sketches, photos or drawings. You can also paste or drop them here." disabled={full} onClick={() => picker.current?.click()} id="attach-image"><ImagePlus /></IconButton>
              <IconButton small label="Attach the current view" description="A snapshot of the 3D viewport, exactly as you see it." disabled={full || !hasModel} onClick={() => { void attachView(); }} id="attach-view"><Camera /></IconButton>
              <span className={styles.hint}>{working ? 'STEVE sees new messages at its next step' : 'Ctrl + Enter to send · Enter for a new line'}</span>
            </div>
            <div className={styles.actions}>
              <AnimatePresence initial={false}>
                {working && (
                  <motion.span key="stop" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.14 }}>
                    <Tip label={stopping ? 'Stopping…' : 'Stop STEVE'} description="Ends this run. Design changes STEVE already made stay saved, and so does what it wrote so far. Queued messages come back to your draft.">
                      <button type="button" id="stop-steve" className={styles.stop} onClick={() => void stop()} disabled={stopping || !chat?.active_run_id} aria-label={stopping ? 'Stopping STEVE' : 'Stop STEVE'}>
                        {stopping ? <Spinner size={12} /> : <Square size={10} fill="currentColor" strokeWidth={0} />}
                      </button>
                    </Tip>
                  </motion.span>
                )}
                {(!working || (hasDraft && config?.steering)) && (
                  <motion.span key="send" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.14 }}>
                    <Tip label={working ? 'Send to STEVE now' : 'Send'} description={working ? 'STEVE reads it before its next step.' : undefined} disabled={!working}>
                      <button type="submit" id="send-chat" className={styles.send} disabled={!configured || !!unavailable || loading || images.uploading || !hasDraft || (!working && (!!pending || designBusy))} aria-label={working ? 'Send to STEVE while it works' : 'Send'}><ArrowUp size={15} strokeWidth={2.2} /></button>
                    </Tip>
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

/** STEVE's steps so far: finished ones checked, the current one spinning; repeats of a finished step fold into one row. */
function Steps({ steps }: { steps: (Step & { call_id: string })[] }) {
  const rows: { key: string; step: Step; label: string; count: number }[] = [];
  for (const step of steps) {
    const label = stepLabel(step);
    const last = rows.at(-1);
    if (last && step.status === 'finished' && last.step.status === 'finished' && last.label === label) last.count++;
    else rows.push({ key: step.agent + ':' + step.call_id, step, label, count: 1 });
  }
  return (
    <ol className={styles.steps} aria-label="STEVE's steps" id="assistant-steps">
      {rows.map(({ key, step, label, count }) => (
        <motion.li key={key} data-status={step.status} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }}>
          <span className={styles.stepIcon}>{step.status === 'started' ? <Spinner size={10} /> : step.status === 'failed' ? <X size={11} /> : step.skill ? <BookOpenCheck size={11} /> : <Check size={11} />}</span>
          <span {...(step.skill ? { 'data-loaded-skill': step.skill } : {})}>{label}</span>
          {count > 1 && <small>×{count}</small>}
          {step.status === 'failed' && <small>failed</small>}
        </motion.li>
      ))}
    </ol>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  return <span className={styles.elapsed}>{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}
