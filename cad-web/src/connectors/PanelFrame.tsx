/**
 * One connector panel in a pane: its page, framed sandboxed from the panels origin (app/connector_panels.py: an opaque
 * origin with no requests of its own, nothing of STEVE's page, session or cookies), and the bridge it talks to STEVE
 * through. It can still navigate its frame to STEVE's own origins (the app's frame-src), carrying what it was given, so
 * it's given little: never a document's name, and the open document's id only if its connector takes documents.
 *
 * The bridge (docs: Developers → Connectors → Panels). The panel posts {steve: 1, id, method, params} to
 * window.parent; STEVE answers {steve: 1, id, result} or {steve: 1, id, error: {code, message}} and pushes
 * {steve: 1, event, ...}. Methods: context; actions (its connector's, and which the panel may run); run {action,
 * inputs, note} (as the caller "panel": the owner's grant and confirmation apply), then "run" events until it ends;
 * run.get {id}; run.file {id, name} (a file of a run it started, as a Blob, at most FILE_MAX_BYTES); cancel {id} (runs
 * it started); events (the latest of each). Pushed: "event" (each new connector event), "context" (the open document or
 * theme changed), "run".
 *
 * A run that sends STEVE documents waits for the person, unless the owner let this action's panel send the open
 * document on a click: then the app vouches for the run (open_document) only when the browser says the
 * person just activated the page (navigator.userActivation, which no script can produce) with this panel's frame
 * focused (the click was in the panel, not elsewhere in STEVE), and every STEVE input is the document open now.
 *
 * Only messages from this frame's own window count. A panel that navigates away from its page is closed (after the
 * fact: the boundary is the app's frame-src, not this).
 */
import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Actions, isFinal, type ConnectorPanel, type Run } from '@/lib/actions';
import { useApp } from '@/state/store';
import { Button } from '@/ui';

const RUNS_PER_MINUTE = 20;
const FILE_MAX_BYTES = 20_000_000;   // a run file handed to its panel (run.file)
const MESSAGES_PER_SECOND = 100;
const runsOf = new Map<string, number[]>();   // per panel, over every pane it's open in

type Message = { steve?: unknown; id?: unknown; method?: unknown; params?: unknown };

const forPanel = (run: Run) => ({
  id: run.id, action: { name: run.action.name, title: run.action.title }, state: run.state, progress: run.progress, message: run.message,
  result: run.result, error: run.error, files: run.files.map((file) => ({ name: file.name, bytes: file.bytes, media_type: file.media_type })),
  created_at: run.created_at, updated_at: run.updated_at,
});

function context(panel: ConnectorPanel, documents: boolean) {
  const { doc } = useApp.getState();
  const saved = documents && doc.open && doc.saved ? doc.saved as unknown as { id: string; revision?: number } : null;
  return {
    panel: { id: panel.id, name: panel.name, title: panel.title, version: panel.version }, connector: { id: panel.connector_id },
    // Not its name: a panel can't make requests, but it could navigate away carrying what it was given.
    document: saved ? { id: saved.id, kind: doc.kind, revision: saved.revision ?? null } : null,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  };
}

export default function PanelFrame({ panel }: { panel: ConnectorPanel }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setClosed(null);
    const target = () => frame.current?.contentWindow ?? null;
    const post = (message: Record<string, unknown>) => target()?.postMessage({ steve: 1, ...message }, '*');   // its origin is opaque
    const mine = new Set<string>();
    const following = new Map<string, number>();
    const latest = new Map<string, { name: string; data: unknown; at: string }>();
    let messages: number[] = [];
    let documents = false;   // its connector has an action taking STEVE documents allowed for it: then it gets the open one's id
    let loads = 0;

    const follow = (run: Run) => {
      post({ event: 'run', run: forPanel(run) });
      if (isFinal(run.state) || following.has(run.id)) return;
      following.set(run.id, window.setInterval(async () => {
        try {
          const now = await Actions.get(run.id);
          post({ event: 'run', run: forPanel(now) });
          if (isFinal(now.state)) { window.clearInterval(following.get(run.id)); following.delete(run.id); }
        } catch { /* Try again on the next tick. */ }
      }, 1500));
    };

    /** The open document's id when the person just clicked in this panel and every STEVE input is that document, else
     * undefined (the run then waits for the person). */
    const clickedOpenDocument = (specs: Record<string, { 'x-steve'?: unknown }>, inputs: Record<string, unknown>) => {
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
      if (!activation?.isActive || !frame.current || document.activeElement !== frame.current) return undefined;
      const open = context(panel, true).document;
      const steve = Object.keys(specs).filter((name) => !!specs[name]['x-steve'] && inputs[name] !== undefined);
      if (!open || !steve.length) return undefined;
      return steve.every((name) => (inputs[name] as { document_id?: unknown } | null)?.document_id === open.id) ? open.id : undefined;
    };

    const takesDocuments = Actions.panelActions(panel.id).then(({ actions }) => {
      documents = actions.some((action) => action.allowed && Object.values(action.inputs.properties ?? {}).some((spec) => !!spec['x-steve']));
    }, () => undefined);
    const answer = async (method: string, params: Record<string, unknown>) => {
      if (method === 'context') await takesDocuments;
      switch (method) {
        case 'context': return context(panel, documents);
        case 'actions': return (await Actions.panelActions(panel.id)).actions;
        case 'events': return [...latest.values()];
        case 'run': {
          const now = Date.now();
          const runs = (runsOf.get(panel.id) ?? []).filter((at) => now - at < 60_000);
          if (runs.length >= RUNS_PER_MINUTE) throw { code: 'rate_limited', message: `A panel starts at most ${RUNS_PER_MINUTE} runs a minute.` };
          runsOf.set(panel.id, [...runs, now]);
          const listed = (await Actions.panelActions(panel.id)).actions;
          const action = listed.find((item) => item.id === params.action || item.name === params.action);
          if (!action) throw { code: 'action_not_found', message: 'This connector has no such action.' };
          const inputs = (params.inputs ?? {}) as Record<string, unknown>;
          const run = await Actions.runFromPanel(action.id, panel.id, inputs, typeof params.note === 'string' ? params.note.slice(0, 500) : undefined,
                                                 clickedOpenDocument(action.inputs.properties ?? {}, inputs));
          mine.add(run.id);
          follow(run);
          return forPanel(run);
        }
        case 'run.file': {
          const id = String(params.id ?? '');
          if (!mine.has(id)) throw { code: 'run_not_found', message: 'This panel started no run with that id.' };
          const name = String(params.name ?? '');
          const file = (await Actions.get(id)).files.find((item) => item.name === name);
          if (!file) throw { code: 'file_not_found', message: 'This run has no file by that name.' };
          if (file.bytes > FILE_MAX_BYTES) throw { code: 'file_too_large', message: `A panel takes run files of at most ${FILE_MAX_BYTES / 1_000_000} MB.` };
          const response = await fetch(Actions.fileUrl(id, name));
          if (!response.ok) throw { code: 'file_unavailable', message: `The file couldn't be read (${response.status}).` };
          const blob = new Blob([await response.arrayBuffer()], { type: file.media_type });
          return { name: file.name, media_type: file.media_type, bytes: file.bytes, blob };
        }
        case 'run.get': case 'cancel': {
          const id = String(params.id ?? '');
          if (!mine.has(id)) throw { code: 'run_not_found', message: 'This panel started no run with that id.' };
          const run = method === 'cancel' ? await Actions.cancel(id) : await Actions.get(id);
          return forPanel(run);
        }
        default: throw { code: 'method_unknown', message: `No method ${method}.` };
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!target() || event.source !== target()) return;   // only this frame's own window
      const message = event.data as Message;
      if (!message || typeof message !== 'object' || message.steve !== 1 || typeof message.method !== 'string') return;
      const now = Date.now();
      messages = messages.filter((at) => now - at < 1000);
      if (messages.length >= MESSAGES_PER_SECOND) return;
      messages.push(now);
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
      const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
      answer(message.method, params).then(
        (result) => post({ id, result }),
        (failure: unknown) => {
          const detail = (failure as { detail?: { code?: string; message?: string } })?.detail;
          const known = failure as { code?: string; message?: string };
          post({ id, error: { code: detail?.code ?? known?.code ?? 'failed', message: detail?.message ?? known?.message ?? String(failure) } });
        });
    };
    window.addEventListener('message', onMessage);

    // The connector's events, live (the latest of each first).
    const stream = new EventSource(`/v1/connectors/${encodeURIComponent(panel.connector_id)}/stream`);
    const relay = (push: boolean) => (event: MessageEvent) => {
      try {
        const item = JSON.parse(event.data) as { name: string; data: unknown; at: string };
        latest.set(item.name, { name: item.name, data: item.data, at: item.at });
        if (push) post({ event: 'event', name: item.name, data: item.data, at: item.at });
      } catch { /* A malformed line: skip it. */ }
    };
    stream.addEventListener('snapshot', relay(true) as EventListener);
    stream.addEventListener('event', relay(true) as EventListener);

    // The open document or the theme changed: tell it.
    let shown = JSON.stringify(context(panel, documents));
    const tell = () => {
      const now = JSON.stringify(context(panel, documents));
      if (now !== shown) { shown = now; post({ event: 'context', context: JSON.parse(now) }); }
    };
    const unsubscribe = useApp.subscribe(tell);
    const themes = new MutationObserver(tell);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // A panel stays on its own page: navigating away (to anything) closes it.
    const element = frame.current;
    const onLoad = () => {
      loads += 1;
      if (loads > 1) {
        element?.setAttribute('src', 'about:blank');
        setClosed('This panel tried to open another page, so STEVE closed it.');
      }
    };
    element?.addEventListener('load', onLoad);

    return () => {
      window.removeEventListener('message', onMessage);
      stream.close();
      unsubscribe();
      themes.disconnect();
      element?.removeEventListener('load', onLoad);
      following.forEach((timer) => window.clearInterval(timer));
    };
  }, [panel, nonce]);

  if (closed) {
    return (
      <div style={{ display: 'grid', gap: 10, padding: 16, color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }} data-panel-closed>
        <span><TriangleAlert size={13} /> {closed}</span>
        <div><Button size="sm" onClick={() => { setClosed(null); setNonce(nonce + 1); }}>Open it again</Button></div>
      </div>
    );
  }
  return (
    <iframe key={`${panel.id}:${panel.version}:${nonce}`} ref={frame} src={panel.url} title={panel.title} data-connector-panel={panel.id}
            sandbox="allow-scripts allow-forms" allow="" referrerPolicy="no-referrer"
            style={{ flex: 1, width: '100%', minHeight: 0, border: 0, display: 'block', background: 'var(--bg-1)' }} />
  );
}
