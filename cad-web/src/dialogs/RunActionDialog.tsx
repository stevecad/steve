/**
 * Run a connector action (app/connector_runs.py): pick one of the actions you may run, fill in its inputs (a form made
 * from the action's own description of them; STEVE documents default to the one open), run it, and follow it live:
 * progress, the connector's messages, its result and files. Actions that need a person ask you to confirm first.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Check, Download, Play, Workflow } from 'lucide-react';
import { Button, Dialog, Field, NumberField, Select, Spinner, Switch } from '@/ui';
import { set, useApp } from '@/state/store';
import { Api, ApiError, type DocumentSummary, type Kind } from '@/lib/api';
import { openSettings } from '@/settings/registry';
import { usePendingRuns } from '@/lib/pendingRuns';
import { Actions, ASKED_BY, describeInput, isFinal, STATE_LABEL, type InputSpec, type Run, type RunnableAction } from '@/lib/actions';
import styles from './RunActionDialog.module.css';

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
const size = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);
const kindsOf = (spec: InputSpec): Kind[] =>
  (spec['x-steve'] === 'program' ? ['cam'] : (spec.kinds ?? (spec['x-steve'] === 'file' ? ['part', 'design'] : ['part', 'design', 'circuit', 'cam']))) as Kind[];

interface InputReference { kind?: string; format?: string; name?: string; document_kind?: string; revision?: number; setup?: string;
  machine_name?: string | null; verification?: string }

/** One input of a run, in words: a STEVE document by name and revision (a program with its setup, machine and check),
 * or the value given. Shown so a person sees exactly what they confirm. */
function describeValue(value: unknown): string {
  if (value && typeof value === 'object' && 'kind' in (value as InputReference)) {
    const item = value as InputReference;
    const what = item.kind === 'program' ? 'CAM program' : item.kind === 'document' ? (item.document_kind ?? 'document') : `${item.format?.toUpperCase()} file`;
    return [`${item.name ?? 'document'} (${what}, revision ${item.revision})`, item.setup && `setup ${item.setup}`,
      item.machine_name && `for ${item.machine_name}`, item.verification].filter(Boolean).join(' · ');
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** A run's inputs and note: what the connector will be asked to do. */
export function RunInputs({ run }: { run: Run }) {
  const entries = Object.entries(run.inputs ?? {});
  if (!entries.length && !run.note) return <p className={styles.muted}>No inputs.</p>;
  return (
    <dl className={styles.inputs} data-run-inputs>
      {entries.map(([name, value]) => (
        <div key={name}><dt>{name}</dt><dd>{describeValue(value)}</dd></div>
      ))}
      {run.note && <div><dt>Note</dt><dd>{run.note}</dd></div>}
    </dl>
  );
}

/** A run, followed live until it ends: state, progress, the connector's message, result and files. */
export function RunStatus({ run: initial, onChange }: { run: Run; onChange?: (run: Run) => void }) {
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  useEffect(() => setRun(initial), [initial]);
  useEffect(() => {
    if (isFinal(run.state)) return;
    const timer = window.setInterval(() => {
      Actions.get(run.id).then((next) => { setRun(next); onChange?.(next); }, () => { /* Next tick. */ });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [run.id, run.state, onChange]);
  const act = async (call: (id: string) => Promise<Run>) => {
    setError(null);
    try { const next = await call(run.id); setRun(next); onChange?.(next); } catch (failure) { setError(message(failure)); }
  };
  const progress = run.progress == null ? null : Math.round(run.progress * 100);
  return (
    <div className={styles.status} data-run={run.id} data-state={run.state}>
      <div className={styles.statusHead}>
        {!isFinal(run.state) && run.state !== 'awaiting_confirmation' ? <Spinner size={14} /> : run.state === 'succeeded' ? <Check size={15} className={styles.good} /> : null}
        <b>{STATE_LABEL[run.state]}</b>
        {progress != null && !isFinal(run.state) && <span className={styles.muted}>{progress}%</span>}
        <span className={styles.muted}>· asked by {ASKED_BY[run.requested_by.kind]}</span>
      </div>
      {run.state === 'awaiting_confirmation' && <RunInputs run={run} />}
      {progress != null && !isFinal(run.state) && <div className={styles.bar}><span style={{ width: `${progress}%` }} /></div>}
      {run.message && <p className={styles.muted}>{run.message}</p>}
      {run.error && <p className={styles.warn}>{run.error}</p>}
      {run.state === 'queued' && (run.waiting
        ? <p className={styles.muted} data-waiting>{run.waiting} It goes out once that’s ready.</p>
        : <p className={styles.muted}>It goes out as soon as the connector is connected (it waits a day).</p>)}
      {run.result != null && <pre className={styles.result}>{JSON.stringify(run.result, null, 2)}</pre>}
      {run.files.length > 0 && (
        <div className={styles.files}>
          {run.files.map((file) => (
            <a key={file.name} href={Actions.fileUrl(run.id, file.name)} download={file.name} className={styles.file}>
              <Download size={13} /><span>{file.name}</span><span className={styles.muted}>{size(file.bytes)}</span>
            </a>
          ))}
        </div>
      )}
      {error && <p className={styles.warn}>{error}</p>}
      {run.state === 'awaiting_confirmation' && run.can_stop_asking && (
        <label className={styles.stopAsking}>
          <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} />
          <span>Don’t ask again when {ASKED_BY[run.requested_by.kind]} runs {run.action.title}</span>
        </label>
      )}
      {!isFinal(run.state) && (
        <div className={styles.row}>
          {run.state === 'awaiting_confirmation' && <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => void act((id) => Actions.confirm(id, always))}>Confirm</Button>}
          {!run.cancel_requested && <Button size="sm" variant="ghost" icon={<Ban size={13} />} onClick={() => void act(Actions.cancel)}>Cancel</Button>}
          {run.cancel_requested && <span className={styles.muted}>Asked the connector to stop…</span>}
        </div>
      )}
    </div>
  );
}

/** Runs waiting for this person's confirmation (from `kinds` of caller, or any), each with Confirm and Cancel. */
export function WaitingRuns({ kinds, title = 'Needs your confirmation' }: { kinds?: string[]; title?: string }) {
  const runs = usePendingRuns((state) => state.runs).filter((run) => !kinds || kinds.includes(run.requested_by.kind));
  const refresh = usePendingRuns((state) => state.refresh);
  if (!runs.length) return null;
  return (
    <section className={styles.waiting} aria-label={title} data-waiting-runs>
      <b className={styles.waitingTitle}>{title}</b>
      {runs.map((run) => (
        <div key={run.id} className={styles.waitingRun}>
          <span className={styles.title}>{run.action.title}</span>
          <RunStatus run={run} onChange={() => void refresh()} />
        </div>
      ))}
    </section>
  );
}

/** A STEVE document for an input: defaults to the open one when it fits. */
function DocumentInput({ spec, value, onChange }: { spec: InputSpec; value: { document_id: string; revision: number; setup?: string } | undefined;
  onChange: (value: { document_id: string; revision: number; setup?: string } | undefined) => void }) {
  const kinds = kindsOf(spec);
  const open = useApp((state) => state.doc.saved);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all(kinds.map((kind) => Api.documents({ kind, limit: 100 }).then((body) => body.documents))).then(
      (lists) => { if (alive) setDocuments(lists.flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at))); }, () => alive && setDocuments([]));
    return () => { alive = false; };
  }, [kinds.join()]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (value || !documents?.length) return;
    const chosen = (open && kinds.includes(open.kind) && documents.find((doc) => doc.id === open.id)) || null;
    if (chosen) onChange({ document_id: chosen.id, revision: chosen.revision });
  }, [documents]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!documents) return <Spinner size={14} />;
  if (!documents.length) return <p className={styles.muted}>No {kinds.join(' or ')} documents yet.</p>;
  return (
    <div className={styles.row}>
      <Select value={value?.document_id ?? ''} ariaLabel={spec.title ?? 'Document'}
              options={[{ value: '', label: 'Choose…' }, ...documents.map((doc) => ({ value: doc.id, label: doc.name, hint: `${doc.kind} · rev ${doc.revision}` }))]}
              onChange={(id) => { const doc = documents.find((item) => item.id === id); onChange(doc ? { document_id: doc.id, revision: doc.revision } : undefined); }} />
      {spec['x-steve'] === 'program' && (
        <input className={styles.input} placeholder="Setup (if several)" value={value?.setup ?? ''} aria-label="Setup"
               onChange={(event) => value && onChange({ ...value, setup: event.target.value || undefined })} />
      )}
    </div>
  );
}

function ValueInput({ name, spec, value, onChange }: { name: string; spec: InputSpec; value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => (spec.type === 'object' && value !== undefined ? JSON.stringify(value, null, 2) : ''));
  if (spec.enum) return <Select value={(value as string) ?? ''} ariaLabel={spec.title ?? name} options={[{ value: '', label: 'Choose…' }, ...spec.enum.map((item) => ({ value: item, label: item }))]} onChange={(next) => onChange(next || undefined)} />;
  if (spec.type === 'boolean') return <Switch checked={!!value} onCheckedChange={onChange} label={spec.title ?? name} />;
  if (spec.type === 'number' || spec.type === 'integer') {
    return <NumberField className={styles.input} unit="" optional eager integer={spec.type === 'integer'} min={spec.minimum} max={spec.maximum} ariaLabel={spec.title ?? name}
                        value={typeof value === 'number' ? value : undefined} onChange={onChange} />;
  }
  if (spec.type === 'object') {
    return <textarea className={styles.area} aria-label={spec.title ?? name} value={text} placeholder="{ }"
                     onChange={(event) => { setText(event.target.value); try { onChange(event.target.value.trim() ? JSON.parse(event.target.value) : undefined); } catch { onChange(Symbol.for('invalid')); } }} />;
  }
  return <input className={styles.input} aria-label={spec.title ?? name} maxLength={spec.maxLength} value={(value as string) ?? ''} onChange={(event) => onChange(event.target.value || undefined)} />;
}

function Form({ action, onRun }: { action: RunnableAction; onRun: (run: Run) => void }) {
  const properties = Object.entries(action.inputs.properties);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(properties.filter(([, spec]) => spec.default !== undefined).map(([name, spec]) => [name, spec.default])));
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const missing = action.inputs.required.filter((name) => values[name] === undefined);
  const invalid = Object.values(values).some((value) => value === Symbol.for('invalid'));
  // STEVE documents among the inputs are generated first; while that takes longer than one request, the server answers
  // "not ready" and this asks again (for up to ten minutes) instead of making the person press Run again.
  const run = async () => {
    setBusy(true); setError(null); stop.current = false;
    const inputs = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    const until = Date.now() + 10 * 60_000;
    try {
      for (;;) {
        try {
          onRun(await Actions.run(action.id, inputs, note, action.needs_confirmation && confirmed));
          return;
        } catch (failure) {
          const notReady = failure instanceof ApiError && (failure.code === 'not_ready' || failure.code === 'program_not_ready');
          if (!notReady || Date.now() > until || stop.current) throw failure;
          setWaiting(true);
          await new Promise((resolve) => window.setTimeout(resolve, 10_000));
          if (stop.current) return;
        }
      }
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); setWaiting(false); }
  };
  return (
    <div className={styles.form}>
      {action.description && <p className={styles.lead}>{action.description}</p>}
      {properties.map(([name, spec]) => (
        <Field key={name} label={<>{spec.title ?? name}{action.inputs.required.includes(name) ? '' : <span className={styles.muted}> (optional)</span>}</>}
               hint={spec.description ?? describeInput(spec)}>
          {spec['x-steve']
            ? <DocumentInput spec={spec} value={values[name] as never} onChange={(value) => setValues((now) => ({ ...now, [name]: value }))} />
            : <ValueInput name={name} spec={spec} value={values[name]} onChange={(value) => setValues((now) => ({ ...now, [name]: value }))} />}
        </Field>
      ))}
      <Field label={<>Note <span className={styles.muted}>(optional)</span></>} hint="Sent with the run, for whoever reads the connector’s log.">
        <input className={styles.input} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} aria-label="Note" />
      </Field>
      {action.result && <p className={styles.muted}>Result: {action.result}</p>}
      {action.machine && <p className={styles.muted}>Runs on {action.machine.name ?? 'your machine'}: a program is accepted only if it was posted for it.</p>}
      {action.needs_confirmation && (
        <label className={styles.confirm}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I confirm this run. {action.title} acts on {action.connector.name} as soon as it receives it.</span>
        </label>
      )}
      {!action.connector.online && <p className={styles.muted}>{action.connector.name} isn’t connected right now: the run waits for it (up to a day).</p>}
      {error && <p className={styles.warn}>{error}</p>}
      <div className={styles.row}>
        <Button variant="primary" icon={<Play size={13} />} disabled={busy || missing.length > 0 || invalid || (action.needs_confirmation && !confirmed)} onClick={() => void run()} id="run-action">
          {busy ? (waiting ? 'Generating…' : 'Preparing…') : 'Run'}
        </Button>
        {waiting && <><span className={styles.muted}>STEVE is generating the documents first: it starts as soon as they’re ready.</span>
          <Button size="sm" variant="ghost" onClick={() => { stop.current = true; setBusy(false); setWaiting(false); }}>Stop</Button></>}
        {missing.length > 0 && <span className={styles.muted}>Fill in {missing.map((name) => action.inputs.properties[name].title ?? name).join(', ')}.</span>}
      </div>
    </div>
  );
}

export default function RunActionDialog({ open }: { open: boolean }) {
  const [actions, setActions] = useState<RunnableAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    if (!open) return;
    setActions(null); setRun(null); setError(null);
    const wanted = useApp.getState().runActionId;   // opened on one action (the quick button's "Run: …")
    useApp.setState({ runActionId: null });
    Actions.runnable().then((list) => {
      setActions(list);
      setChosen((now) => (wanted && list.some((item) => item.id === wanted) ? wanted : now && list.some((item) => item.id === now) ? now : list[0]?.id ?? null));
    }, (failure) => setError(message(failure)));
  }, [open]);
  const action = useMemo(() => actions?.find((item) => item.id === chosen) ?? null, [actions, chosen]);
  const close = () => set({ dialog: null });
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }} title="Run an action" icon={<Workflow size={18} />} width={760}
            description="Things your own software can do for you, through the connectors you've paired.">
      <WaitingRuns />
      {error && <p className={styles.warn}>{error}</p>}
      {!actions && !error && <Spinner size={16} />}
      {actions && actions.length === 0 && (
        <div className={styles.empty}>
          <p>No actions you can run yet. Pair a connector and allow its actions in Settings → Connectors.</p>
          <Button onClick={() => openSettings('connectors')}>Open Connectors settings</Button>
        </div>
      )}
      {actions && actions.length > 0 && (
        <div className={styles.layout}>
          <nav className={styles.list} aria-label="Actions">
            {actions.map((item) => (
              <button key={item.id} type="button" className={styles.item} data-active={item.id === chosen || undefined} data-action={item.name}
                      onClick={() => { setChosen(item.id); setRun(null); }}>
                <b>{item.title}</b>
                <span><i className={styles.dot} data-online={item.connector.online || undefined} />{item.connector.name}</span>
              </button>
            ))}
          </nav>
          <div className={styles.pane}>
            {action && (run ? (
              <>
                <h3 className={styles.title}>{action.title}</h3>
                <RunStatus run={run} />
                <div className={styles.row}><Button size="sm" onClick={() => setRun(null)}>Run again</Button></div>
              </>
            ) : (
              <>
                <h3 className={styles.title}>{action.title}</h3>
                <Form key={action.id} action={action} onRun={setRun} />
              </>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
