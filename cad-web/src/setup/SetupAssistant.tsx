/**
 * Set up with STEVE, beside a library form. The person describes the item; STEVE researches it and fills the form
 * as a draft, with marks for each field's pages and for estimates. When the item pins records the library doesn't
 * have (a machine's model and control), STEVE drafts those too: one review card lists them and "Save all" saves
 * them together. Nothing is saved until the person saves.
 * This conversation lives here only: closing the pane or switching records ends it, and it never enters the chat.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Check, ChevronRight, FileText, Globe, Layers, Library, Search, Sparkles, Square, TriangleAlert, Undo2, X } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import CopyMessage from '@/shell/CopyMessage';
import SteveMarkdown from '@/steve/markdown.js';
import { openLinksOutside } from '@/lib/safeUrl';
import ModelUnavailableNotice from '@/panels/ModelUnavailableNotice';
import { chooseModel, mergeProvenance, ModelUnavailable, setupOptions, streamSetup, type BundleItem, type Provenance, type SetupBundle, type SetupDraft, type SetupOptions, type SetupStep } from './api';
import { MarkCount } from './FieldMarks';
import type { PageInfo } from '@/workspaces/manufacture/provenance';
import styles from './Setup.module.css';

interface Turn {
  id: number;
  person: string;
  steps: SetupStep[];
  text: string;
  state: 'running' | 'done' | 'error' | 'stopped';
  error?: string;
  draft?: SetupDraft;
  /** This turn drafted several records (a bundle); the dialog holds them. */
  bundled?: boolean;
  /** STEVE asked the person something instead of drafting. */
  question?: string;
  review?: 'pending' | 'applied' | 'discarded';
  /** The form before this turn's draft, for Discard. */
  before: { definition: Record<string, unknown> | null; provenance: Provenance; notes: string | null };
  showSteps?: boolean;
}

export interface SetupAssistantProps {
  kind: string;
  /** What the form holds now, its marks and the record's notes on sources. */
  draft: Record<string, unknown> | null;
  provenance: Provenance;
  notes: string | null;
  /**
   * Fills the form: with STEVE's draft, or with what it held before when a draft is discarded. `pages`: titles and
   * read times of the pages STEVE cited; `notes`: the record's notes on sources (STEVE's for a draft).
   */
  onDraft: (definition: Record<string, unknown>, provenance: Provenance, details: { pages: PageInfo; notes: string | null }) => void;
  /** Several records to set up together (LibraryDialog keeps them, shows each in the form and saves them all). */
  onBundle?: (bundle: SetupBundle, details: { pages: PageInfo }) => void;
  /** The bundle in progress, as the card shows it, and its records as the form holds them (sent with a follow-up). */
  bundle?: BundleView | null;
  bundleItems?: BundleItem[] | null;
  onClose: () => void;
}

/** One record of a bundle, as the review card lists it. */
export interface BundleRow {
  ref: string;
  label: string;
  name: string;
  main: boolean;
  active: boolean;
  state: 'draft' | 'saving' | 'saved' | 'failed';
  revision?: number;
  error?: string;
  facts: string[];
  sourced: number;
  estimated: number;
  /** What it pins: a record drafted here (new) or one already in the library. */
  uses: { label: string; name: string; source: 'new' | 'saved' | 'library' }[];
}
export interface BundleView {
  notes: string;
  rows: BundleRow[];
  saving: boolean;
  onShow: (ref: string) => void;
  onSaveAll: () => void;
  onDiscard: () => void;
}

const place = (url: string) => {
  try { const parsed = new URL(url); return { host: parsed.host.replace(/^www\./, ''), path: parsed.pathname.replace(/\/$/, '') }; } catch { return { host: url, path: '' }; }
};
const web = (url?: string) => !!url && /^https?:\/\//i.test(url);

function StepRow({ step }: { step: SetupStep }) {
  const running = step.state === 'running';
  const icon = running ? <Spinner size={10} /> : step.kind === 'search' ? <Search size={12} /> : step.kind === 'fetch' ? <FileText size={12} />
    : step.kind === 'library' ? <Library size={12} /> : step.state === 'done' ? <Check size={12} /> : <Sparkles size={12} />;
  let body: ReactNode = step.text;
  if (step.kind === 'search') {
    const query = step.text ? <q>{step.text}</q> : 'the web';
    body = running ? <>Searching {query}…</> : step.state === 'failed' ? <>Searched {query}: nothing usable</> : (
      <>
        Searched {query}
        {!!step.results?.length && (
          <span className={styles.results}>
            {step.results.filter((result) => web(result.url)).map((result) => (
              <a key={result.url} className={styles.result} href={result.url} target="_blank" rel="noopener noreferrer" title={result.title || result.url}>{place(result.url).host}</a>
            ))}
          </span>
        )}
      </>
    );
  } else if (step.kind === 'fetch') {
    const where = step.text ? place(step.text) : null;
    const name = step.title || (where ? `${where.host}${where.path.length > 28 ? `…${where.path.slice(-26)}` : where.path}` : 'a page');
    body = running ? <>Reading {name}…</> : step.state === 'failed' ? <>Couldn’t open {name}</>
      : web(step.text) ? <>Read <a href={step.text} target="_blank" rel="noopener noreferrer" title={step.text}>{name}</a></> : <>Read {name}</>;
  }
  return (
    <motion.li className={styles.step} data-state={step.state} data-step={step.kind} layout="position"
      initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
      <span className={styles.stepIcon}>{icon}</span>
      <span className={styles.stepText}>{body}</span>
    </motion.li>
  );
}

function summary(steps: SetupStep[]): string {
  const searches = steps.filter((step) => step.kind === 'search').length;
  const pages = steps.filter((step) => step.kind === 'fetch' && step.state === 'done').length;
  const library = steps.some((step) => step.kind === 'library');
  return [searches && `${searches} search${searches === 1 ? '' : 'es'}`, pages && `${pages} page${pages === 1 ? '' : 's'} read`, library && 'your library']
    .filter(Boolean).join(' · ') || `${steps.length} step${steps.length === 1 ? '' : 's'}`;
}

function DraftCard({ turn, latest, onApply, onDiscard }: { turn: Turn; latest: boolean; onApply: () => void; onDiscard: () => void }) {
  const draft = turn.draft!;
  const fields = Object.keys(draft.sources).length;
  const pages = new Set(Object.values(draft.sources).flat()).size;
  const name = typeof draft.definition.name === 'string' ? draft.definition.name : 'Draft';
  return (
    <motion.div className={styles.card} data-review={turn.review} id={latest ? 'setup-draft' : undefined}
      initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
      <div className={styles.cardTitle}><Sparkles size={14} /><span>{name}</span></div>
      <div className={styles.tally}>
        <span className={styles.tallySourced}><b>◆ {fields}</b> field{fields === 1 ? '' : 's'} from {pages} page{pages === 1 ? '' : 's'}</span>
        <span className={styles.tallyEstimated}><b>{draft.estimates.length}</b> estimate{draft.estimates.length === 1 ? '' : 's'} to check</span>
      </div>
      {draft.notes && <p className={styles.notes}>{draft.notes}</p>}
      {turn.review === 'pending' && latest ? (
        <div className={styles.cardActions}>
          <Button size="sm" variant="primary" icon={<Check />} id="setup-apply" onClick={onApply}>Apply</Button>
          <Button size="sm" variant="ghost" icon={<Undo2 />} id="setup-discard" onClick={onDiscard}>Discard draft</Button>
        </div>
      ) : (
        <span className={styles.cardState}>{turn.review === 'discarded' ? 'Discarded: the form is back as it was.' : 'In the form. Review it, then save.'}</span>
      )}
    </motion.div>
  );
}

const STATE_TEXT: Record<BundleRow['state'], string> = { draft: 'New', saving: 'Saving…', saved: 'Saved', failed: 'Not saved' };

function BundleCard({ turn, view, latest }: { turn: Turn; view: BundleView | null | undefined; latest: boolean }) {
  if (!latest || !view) {
    return <div className={styles.card} data-review="discarded"><span className={styles.cardState}>{turn.review === 'discarded' ? 'Discarded: the form is back as it was.' : 'Replaced by a later draft.'}</span></div>;
  }
  const left = view.rows.filter((row) => row.state !== 'saved').length;
  const done = left === 0;
  const failed = view.rows.some((row) => row.state === 'failed');
  return (
    <motion.div className={styles.card} id="setup-bundle" data-done={done || undefined}
      initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
      <div className={styles.cardTitle}><Layers size={14} /><span>{done ? `Saved ${view.rows.length} records` : `Set up ${view.rows.length} records together`}</span></div>
      {view.notes && <p className={styles.notes}>{view.notes}</p>}
      <ul className={styles.bundleRows}>
        {view.rows.map((row) => (
          <li key={row.ref}>
            <button type="button" className={styles.bundleRow} data-ref={row.ref} data-state={row.state} data-active={row.active || undefined}
              aria-current={row.active || undefined} onClick={() => view.onShow(row.ref)} title={row.active ? 'In the form now' : 'Show it in the form'}>
              <span className={styles.bundleHead}>
                <span className={styles.bundleKind}>{row.label}</span>
                <b className={styles.bundleName}>{row.name || 'Untitled'}</b>
                <span className={styles.bundleState} data-state={row.state}>
                  {row.state === 'saving' ? <Spinner size={9} /> : row.state === 'saved' ? <Check size={11} /> : row.state === 'failed' ? <TriangleAlert size={11} /> : null}
                  {STATE_TEXT[row.state]}{row.state === 'saved' && row.revision ? ` · rev ${row.revision}` : ''}
                </span>
              </span>
              {(row.facts.length > 0 || row.sourced > 0 || row.estimated > 0) && (
                <span className={styles.bundleFacts}>{row.facts.join(' · ')}<MarkCount sourced={row.sourced} estimated={row.estimated} /></span>
              )}
              {row.uses.length > 0 && (
                <span className={styles.bundleUses}>Uses {row.uses.map((use, index) => (
                  <span key={use.label}>{index ? ', ' : ''}{use.label.toLowerCase()} <i>{use.name}</i> ({use.source === 'new' ? 'new, saved first' : use.source === 'saved' ? 'saved' : 'already in your library'})</span>
                ))}</span>
              )}
              {row.error && <span className={styles.bundleError} role="alert">{row.error}</span>}
            </button>
          </li>
        ))}
      </ul>
      {done ? (
        <span className={styles.cardState}>All saved. Each record keeps its sources.</span>
      ) : (
        <div className={styles.cardActions}>
          <Button size="sm" variant="primary" icon={<Check />} id="setup-save-all" disabled={view.saving} onClick={view.onSaveAll}>
            {view.saving ? 'Saving…' : failed ? `Save the rest (${left})` : `Save all (${left})`}
          </Button>
          <Button size="sm" variant="ghost" icon={<Undo2 />} id="setup-discard" disabled={view.saving} onClick={view.onDiscard}>Discard</Button>
        </div>
      )}
      {!done && <span className={styles.fine}>Click a record to check it in the form. Save all saves them in order and links them.</span>}
    </motion.div>
  );
}

export default function SetupAssistant({ kind, draft, provenance, notes, onDraft, onBundle, bundle, bundleItems, onClose }: SetupAssistantProps) {
  const [options, setOptions] = useState<SetupOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const abort = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ draft, provenance, notes, onDraft, onBundle, bundleItems });
  latest.current = { draft, provenance, notes, onDraft, onBundle, bundleItems };
  // Titles and read times of every page STEVE cited in this conversation.
  const pages = useRef<PageInfo>({});
  const running = turns.some((turn) => turn.state === 'running');
  const about = options?.kinds[kind];

  // The stored model isn't offered any more: the ones that are, to pick from (nothing is switched without asking).
  const [unavailable, setUnavailable] = useState<ModelUnavailable | null>(null);
  const loadOptions = () => {
    setOptionsError(null); setUnavailable(null);
    setupOptions().then(setOptions).catch((error) => {
      if (error instanceof ModelUnavailable) setUnavailable(error);
      else setOptionsError((error as Error).message);
    });
  };
  useEffect(() => {
    loadOptions();
    return () => abort.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const node = transcript.current; if (node) node.scrollTop = node.scrollHeight; }, [turns]);
  useEffect(() => { field.current?.focus(); }, [options]);

  const update = (id: number, change: (turn: Turn) => Turn) => setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));
  const send = (text: string) => {
    const request = text.trim();
    if (!request || running) return;
    const id = Date.now();
    const before = { definition: latest.current.draft, provenance: latest.current.provenance, notes: latest.current.notes };
    const messages = turns.filter((turn) => turn.state === 'done').flatMap((turn) => [
      { role: 'person' as const, text: turn.person },
      { role: 'steve' as const, text: [turn.text.trim(), turn.question ?? '', turn.draft ? `(Drafted the form. ${turn.draft.notes})` : turn.bundled ? '(Drafted the records of this setup.)' : ''].filter(Boolean).join('\n') || '(No reply.)' },
    ]);
    const items = latest.current.bundleItems;
    // A new request keeps whatever earlier draft is in the form.
    setTurns((all) => [...all.map((turn) => (turn.review === 'pending' ? { ...turn, review: 'applied' as const } : turn)),
      { id, person: request, steps: [], text: '', state: 'running', before }]);
    setInput('');
    const controller = new AbortController();
    abort.current = controller;
    const current = items?.length ? { bundle: items } : { draft: before.definition, sources: before.provenance.sources, estimates: before.provenance.estimates };
    void streamSetup({ kind, request, ...current, messages }, controller.signal, (event) => {
      if (event.type === 'step') {
        const { type: _type, ...step } = event;
        update(id, (turn) => ({ ...turn, steps: turn.steps.some((item) => item.id === step.id) ? turn.steps.map((item) => (item.id === step.id ? step : item)) : [...turn.steps, step] }));
      } else if (event.type === 'text') {
        update(id, (turn) => ({ ...turn, text: turn.text + event.text }));
      } else if (event.type === 'draft') {
        const { type: _type, ...result } = event;
        pages.current = { ...pages.current, ...result.pages };
        latest.current.onDraft(result.definition, mergeProvenance(before.provenance, before.definition, result), { pages: pages.current, notes: result.notes || null });
        update(id, (turn) => ({ ...turn, draft: result, review: 'pending' }));
      } else if (event.type === 'bundle') {
        const { type: _type, ...result } = event;
        for (const record of result.records) pages.current = { ...pages.current, ...record.pages };
        const [only] = result.records;
        // Everything it pins is already saved, and nothing is in a bundle yet: an ordinary draft of that one record.
        if (result.records.length === 1 && Object.values(only.links).every((link) => link.pin) && !items?.length) {
          const definition = { ...only.definition, ...Object.fromEntries(Object.entries(only.links).map(([name, link]) => [name, link.pin])) };
          const single: SetupDraft = { definition, sources: only.sources, estimates: only.estimates, notes: [only.notes, result.notes].filter(Boolean).join(' '), pages: only.pages };
          latest.current.onDraft(definition, mergeProvenance(before.provenance, before.definition, single), { pages: pages.current, notes: single.notes || null });
          update(id, (turn) => ({ ...turn, draft: single, review: 'pending' }));
        } else {
          latest.current.onBundle?.(result, { pages: pages.current });
          update(id, (turn) => ({ ...turn, bundled: true, review: 'pending' }));
        }
      } else if (event.type === 'question') {
        update(id, (turn) => ({ ...turn, question: event.text }));
      } else if (event.type === 'done') {
        update(id, (turn) => ({ ...turn, state: 'done' }));
      } else if (event.type === 'error') {
        update(id, (turn) => ({ ...turn, state: 'error', error: event.message }));
      }
    }).finally(() => { if (abort.current === controller) abort.current = null; });
  };
  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setTurns((all) => all.map((turn) => (turn.state === 'running' ? { ...turn, state: 'stopped' } : turn)));
  };
  const discard = (turn: Turn) => {
    if (turn.before.definition) latest.current.onDraft(turn.before.definition, turn.before.provenance, { pages: pages.current, notes: turn.before.notes });
    update(turn.id, (item) => ({ ...item, review: 'discarded' }));
  };
  const lastDraft = [...turns].reverse().find((turn) => turn.draft || turn.bundled)?.id;
  const label = about?.label ?? 'record';

  return (
    <aside className={styles.pane} id="setup-assistant" aria-label="Set up with STEVE">
      <header className={styles.paneHead}>
        <span className={styles.steveMark}>S</span>
        <span className={styles.paneTitle}>Set up with STEVE</span>
        {options && <span className={styles.modelChip} title={`${options.model.label} (STEVE’s model in this browser)`}>{options.model.label}</span>}
        <button type="button" className={styles.close} aria-label="Close Set up with STEVE" onClick={() => { stop(); onClose(); }} style={options ? undefined : { marginLeft: 'auto' }}><X size={14} /></button>
      </header>
      {options && (options.web.search ? (
        <div className={styles.webNote} id="setup-web"><Globe size={12} />{options.web.fetch ? 'Searches the web and reads spec sheets.' : 'Searches the web (this model can’t open pages directly).'} Every value cites its page or is marked as an estimate.</div>
      ) : (
        <div className={styles.webNote} data-off id="setup-web"><TriangleAlert size={12} />{options.model.label} can’t search the web. STEVE drafts from what you paste and marks the rest as estimates. A Claude model in STEVE’s settings can research.</div>
      ))}
      <div className={styles.transcript} ref={transcript}>
        {optionsError && <div className={styles.error}><span>{optionsError}</span><CopyMessage text={optionsError} /></div>}
        {unavailable && (
          <ModelUnavailableNotice id="setup-model-choice" model={unavailable.model} offered={unavailable.offered}
            onChoose={(model) => { chooseModel(unavailable.provider, model); loadOptions(); }} />
        )}
        {!turns.length && (
          <div className={styles.intro}>
            <span><b>Which {label}?</b> {about?.hint ?? 'Describe it, give a link to its spec sheet, or paste the specs.'}</span>
            <ul className={styles.introList}>
              <li>STEVE fills the form as a draft. <span style={{ color: 'var(--ws)' }}>◆</span> shows the pages a value came from; <span style={{ color: 'var(--warning)' }}>estimate</span> marks a value to check.</li>
              <li>Follow up to change it: options, your shop’s settings, a better source.</li>
              <li>Nothing is saved until you save.</li>
            </ul>
            {!!about?.examples.length && (
              <div className={styles.examples}>
                {about.examples.map((example) => <button key={example} type="button" className={styles.example} onClick={() => { setInput(example); field.current?.focus(); }}>{example}</button>)}
              </div>
            )}
          </div>
        )}
        {turns.map((turn) => {
          const collapsed = turn.state !== 'running' && turn.steps.length > 0 && !turn.showSteps;
          return (
            <div key={turn.id} style={{ display: 'contents' }}>
              <div className={styles.person} data-long={turn.person.length > 400 || undefined}>{turn.person}</div>
              <div className={styles.steve} data-turn-state={turn.state}>
                {turn.state !== 'running' && turn.steps.length > 0 && (
                  <button type="button" className={styles.stepsSummary} aria-expanded={!collapsed} onClick={() => update(turn.id, (item) => ({ ...item, showSteps: !item.showSteps }))}>
                    <ChevronRight size={12} />{summary(turn.steps)}
                  </button>
                )}
                {!collapsed && turn.steps.length > 0 && <ul className={styles.steps}><AnimatePresence initial={false}>{turn.steps.map((step) => <StepRow key={step.id} step={step} />)}</AnimatePresence></ul>}
                {turn.state === 'running' && !turn.steps.length && !turn.text && <span className={styles.stopped}><Spinner size={10} /> Thinking…</span>}
                {turn.text.trim() && <div className={styles.prose} ref={(element) => openLinksOutside(element)} dangerouslySetInnerHTML={{ __html: SteveMarkdown.render(turn.text) }} />}
                {turn.question && <div className={styles.question} data-setup-question role="status">{turn.question}</div>}
                {turn.draft && <DraftCard turn={turn} latest={turn.id === lastDraft} onApply={() => update(turn.id, (item) => ({ ...item, review: 'applied' }))} onDiscard={() => discard(turn)} />}
                {turn.bundled && <BundleCard turn={turn} latest={turn.id === lastDraft} view={bundle} />}
                {turn.state === 'error' && <div className={styles.error} role="alert" data-setup-error><span>{turn.error}</span><CopyMessage text={turn.error ?? ''} /></div>}
                {turn.state === 'stopped' && <span className={styles.stopped}>Stopped.</span>}
              </div>
            </div>
          );
        })}
      </div>
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(input); }}>
        <div className={styles.inputRow}>
          <textarea ref={field} className={styles.input} id="setup-input" rows={1} value={input} aria-label={`Tell STEVE about the ${label}`}
            placeholder={turns.at(-1)?.question ? 'Your answer' : turns.some((turn) => turn.draft || turn.bundled) ? 'Ask for changes, e.g. “it has the 12k spindle”' : `Model, link or specs of the ${label}`}
            onChange={(event) => { setInput(event.target.value); const node = event.target; node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 150)}px`; }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(input); } }} />
          {running
            ? <button type="button" className={styles.send} data-stop id="setup-stop" aria-label="Stop" onClick={stop}><Square size={11} fill="currentColor" /></button>
            : <button type="submit" className={styles.send} id="setup-send" aria-label="Send" disabled={!input.trim() || !options}><ArrowUp size={15} /></button>}
        </div>
        <span className={styles.fine}>Drafts only: nothing is saved until you save. Not in your chat history.</span>
      </form>
    </aside>
  );
}
