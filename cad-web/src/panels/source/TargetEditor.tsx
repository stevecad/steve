/**
 * The code editor on the object a workspace works on (state/codeTargets.ts): a CAM program, an older program, the shop,
 * a study. The same editor as a document's code (SourceEditor), with a header naming exactly what's shown, its files,
 * STEVE on a selection (Change… and Fix edit a CAM program or the shop in place and show what changed for review, as
 * for a part; a study's go to the chat, since STEVE's tools edit documents), download, and the workspace's action. Unsaved edits stay with that object; Save writes them as
 * its next revision (built first where it builds), and what the forms save shows here as soon as it's saved.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Check, Download, FileCode, Maximize2, Minimize2, Play, Plus, RotateCcw, Save, Square, X } from 'lucide-react';
import { Button, IconButton, Select, Spinner } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { useCodeEdits, type CodeTarget, type EmptyTarget } from '@/state/codeTargets';
import { useSteve } from '../steve';
import { changedPaths, edited, headerOf, orderedFiles, stale, withEdit } from './codeTarget';
import { describeSelection, runInlineOn } from './steveRun';
import { resolveAll, setBaseline } from './inlineDiff';
import { selectedLines, streamExplain } from './explain';
import type { SteveHandlers } from './steveInline';
import styles from '../SourcePanel.module.css';

const SourceEditor = lazy(() => import('./SourceEditor'));
const WIDE = 620;

export function EmptyCode({ target }: { target: EmptyTarget }) {
  return (
    <div className={styles.empty} id="source-empty">
      <FileCode size={26} />
      <p><b>{target.title}</b></p>
      {target.detail && <p style={{ maxWidth: 300, textAlign: 'center' }}>{target.detail}</p>}
      {target.start && <Button size="sm" variant="primary" icon={<Plus />} id={target.start.id} onClick={target.start.run}>{target.start.label}</Button>}
    </div>
  );
}

export default function TargetEditor({ target, inline = false, focus = null }: { target: CodeTarget; inline?: boolean; focus?: { file: string; line: number } | null }) {
  const edits = useCodeEdits((state) => state.edits[target.key]);
  const chosen = useCodeEdits((state) => state.active[target.key]);
  const dockWidth = useApp((state) => state.dockWidth);
  const [busy, setBusy] = useState<string | null>(null);
  // STEVE editing this object in place: the run, what it said, and the changes left to review (per object: `key`).
  const [task, setTask] = useState<{ key: string; label: string; signal: { stopped: boolean; runId?: string } } | null>(null);
  const [note, setNote] = useState<{ key: string; tone: 'info' | 'error'; text: string } | null>(null);
  const [review, setReview] = useState(0);
  const viewRef = useRef<EditorView | null>(null);
  const shown = useRef({ key: target.key, file: '' });
  const pendingBaseline = useRef<{ key: string; file: string; text: string } | null>(null);
  const paths = useMemo(() => orderedFiles(target.files, target.main), [target.files, target.main]);
  const file = chosen && (target.files[chosen] !== undefined || edits?.files[chosen] !== undefined) ? chosen : target.main;
  const value = edits?.files[file] ?? target.files[file] ?? '';
  const changed = changedPaths(target.files, edits);
  const next = edited(target.files, edits);
  const outdated = stale(edits, target.revision) && !!next;
  const header = headerOf(target.owner, target.label, file);
  shown.current = { key: target.key, file };
  const onView = useCallback((view: EditorView | null) => {
    viewRef.current = view;
    const pending = pendingBaseline.current;
    if (view && pending && pending.key === shown.current.key && pending.file === shown.current.file) {
      pendingBaseline.current = null;
      view.dispatch({ effects: setBaseline.of(pending.text) });
    }
  }, []);
  // What STEVE said belongs to the object it was about.
  const shownNote = note?.key === target.key ? note : null;
  const shownTask = task?.key === target.key ? task : null;
  useEffect(() => { if (review === 0) setNote((current) => (current?.tone === 'info' && current.key === target.key ? null : current)); }, [review]); // eslint-disable-line react-hooks/exhaustive-deps
  // A line to show (an item's source line, Edit in your shop): its file, selected and scrolled to.
  useEffect(() => { if (focus && target.files[focus.file] !== undefined) useCodeEdits.setState((state) => ({ active: { ...state.active, [target.key]: focus.file } })); }, [focus, target.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const reveal = useMemo(() => {
    if (!focus || focus.file !== file) return null;
    const lines = value.split('\n');
    const from = lines.slice(0, Math.max(0, focus.line - 1)).reduce((total, line) => total + line.length + 1, 0);
    return { from, to: from + (lines[focus.line - 1]?.length ?? 0), nonce: focus.line };
  }, [focus, file]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFile = (path: string) => useCodeEdits.setState((state) => ({ active: { ...state.active, [target.key]: path } }));
  const onChange = (text: string) => useCodeEdits.setState((state) => {
    const edit = withEdit(state.edits[target.key], target.files, target.revision, file, text);
    const all = { ...state.edits };
    if (edit) all[target.key] = edit; else delete all[target.key];
    return { edits: all };
  });
  const discard = () => useCodeEdits.setState((state) => { const all = { ...state.edits }; delete all[target.key]; return { edits: all }; });
  const save = async () => {
    if (!next || busy || outdated) return;
    setBusy('Saving');
    try { await target.save(next); } finally { setBusy(null); }
  };
  const act = async () => {
    if (busy) return;
    setBusy(target.action.label);
    try { await target.action.run(outdated ? null : next); } finally { setBusy(null); }
  };
  const download = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([value], { type: 'text/x-python' }));
    link.download = file.split('/').pop() ?? file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const expanded = dockWidth >= WIDE + 20;
  const expand = () => set({ dockWidth: expanded ? 384 : Math.round(Math.max(WIDE + 40, Math.min(window.innerWidth - 420, window.innerWidth * 0.56))), dockOpen: true });

  // STEVE changing this object (a document) in place: what's unsaved is saved first, so STEVE sees what's shown; then
  // the object is read back and its change shown against what was there for review (Keep / Undo, as for a part).
  const startInline = async (instruction: string, range: { from: number; to: number }) => {
    const document = target.steve;
    if (!document || task || busy) return;
    const key = target.key;
    if (outdated) { setNote({ key, tone: 'error', text: 'Your edits are on an older revision: take the saved one (or copy your edits) before STEVE changes it.' }); return; }
    if (next) {
      setBusy('Saving');
      const ok = await target.save(next).finally(() => setBusy(null));
      if (!ok) { setNote({ key, tone: 'error', text: 'Your edits didn’t save, so STEVE didn’t start: save them (or discard them) first.' }); return; }
    }
    const before = next?.[file] ?? target.files[file] ?? '';
    const where = describeSelection(value, range.from, range.to, file);
    const message = `${instruction}\n\nThis is about ${where.lines} of the ${target.label} (document ${document.documentId}):\n\`\`\`python\n${where.text}\n\`\`\`\n`
      + `Change only what this needs in ${file} (edit_design on that document with path="${file}"), and keep the rest of the ${document.kind} as it is`
      + (document.kind === 'shop' ? '; then generate it, so the shop’s records update.' : '. Don’t run the program: the person runs it from Manufacture.');
    const signal = { stopped: false };
    setNote(null);
    setTask({ key, label: instruction, signal });
    try {
      const outcome = await runInlineOn({ documentId: document.documentId, file, before, reload: async () => (await document.reload())?.[file] }, message, signal);
      const say = (tone: 'info' | 'error', text: string) => setNote({ key, tone, text });
      if (outcome.status === 'changed' && outcome.before !== undefined) {
        const view = viewRef.current;
        if (view && shown.current.key === key && shown.current.file === file) view.dispatch({ effects: setBaseline.of(outcome.before) });
        else pendingBaseline.current = { key, file, text: outcome.before };
        if (outcome.reply) say('info', outcome.reply);
      } else if (outcome.status === 'unchanged') say('info', outcome.reply ? `STEVE didn’t change ${file}: ${outcome.reply}` : `STEVE didn’t change ${file}.`);
      else if (outcome.status === 'stopped') say('info', `Stopped. Anything STEVE had already saved stays in the ${document.kind}’s history.`);
      else say('error', outcome.error ?? 'STEVE could not finish.');
    } catch (error) {
      setNote({ key, tone: 'error', text: (error as Error).message });
    } finally {
      setTask(null);
    }
  };
  const inlineRun = useRef(startInline);
  inlineRun.current = startInline;

  // STEVE on a selection: about this object and this file, by name.
  const steve = useMemo<SteveHandlers>(() => {
    const ask = (text: string) => { useSteve.setState({ prefill: text }); set({ dockOpen: true, dockTab: 'assistant' }); };
    const about = (code: string, range: { from: number; to: number }) => {
      const where = describeSelection(code, range.from, range.to, header);
      return `${where.lines}:\n\`\`\`python\n${where.text}\n\`\`\`\n`;
    };
    const inPlace = !!target.steve;
    return {
      explain: (range, code, sink) => {
        const lines = selectedLines(code, range.from, range.to);
        const controller = new AbortController();
        void streamExplain({ file: header, document_name: get().doc.name || undefined, selection_text: lines.text, start_line: lines.start, end_line: lines.end, context_code: code }, controller.signal, sink);
        return () => controller.abort();
      },
      continueInChat: (range, code, explanation) => ask(`About ${about(code, range)}You explained:\n${explanation}\n\n`),
      change: (instruction, range) => (inPlace ? void inlineRun.current(instruction, range)
        : ask(`${instruction}\n\nThis is about ${about(value, range)}Change only what this needs in ${file} of the ${target.label}, and keep the rest as it is.`)),
      fix: (range, message) => (inPlace ? void inlineRun.current(`Fix this error: ${message.trim()}`, range)
        : ask(`Fix this error in ${file} of the ${target.label}: ${message.trim()}\n\nAt ${about(value, range)}`)),
    };
  }, [header, value, file, target.label, target.steve]);

  return (
    <div className={styles.panel} id="source-panel" data-target={target.kind} data-target-key={target.key} style={inline ? { height: '100%' } : undefined}>
      <div className={styles.toolbar}>
        <span className={styles.crumbs} id="source-target" title={header}>
          <span className={styles.crumbDoc} style={{ maxWidth: 'none' }}>{headerOf(target.owner, target.label, '')}</span>
          <span className={styles.crumbSep}>·</span>
          {paths.length > 1
            ? <Select ariaLabel="Code file" id="source-target-file" value={file} onChange={setFile} options={paths.map((path) => ({ value: path, label: `${path}${changed.includes(path) ? ' •' : ''}` }))} />
            : <span className={styles.crumbFile} data-static>{file}{changed.includes(file) ? ' •' : ''}</span>}
        </span>
        <div className={styles.toolbarRight}>
          <IconButton small label={`Download ${file}`} onClick={download} disabled={!value}><Download /></IconButton>
          {!inline && <IconButton small label={expanded ? 'Back to the side pane' : 'Expand the editor'} onClick={expand} id="source-expand">{expanded ? <Minimize2 /> : <Maximize2 />}</IconButton>}
        </div>
      </div>
      {outdated && (
        <div className={styles.steveBar} data-tone="error" id="source-target-stale">
          <span className={styles.steveText}>Saved meanwhile (revision {target.revision}): your edits are on revision {edits!.revision}.</span>
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={discard} id="source-target-discard-stale">Take the saved one</Button>
        </div>
      )}
      {(shownTask || review > 0 || shownNote) && (
        <div className={styles.steveBar} data-tone={shownNote?.tone} id="source-steve">
          <span className={styles.steveMark}>S</span>
          {shownTask ? <>
            <Spinner size={12} />
            <span className={styles.steveText}>STEVE is working on “{shownTask.label}”…</span>
            <Button size="sm" variant="ghost" icon={<Square />} onClick={() => { shownTask.signal.stopped = true; }} id="source-steve-stop">Stop</Button>
          </> : review > 0 ? <>
            <span className={styles.steveText}>Review STEVE’s change · {review} {review === 1 ? 'place' : 'places'}{shownNote ? ` — ${shownNote.text.split('\n')[0]}` : ''}</span>
            <Button size="sm" variant="ghost" icon={<Check />} onClick={() => { if (viewRef.current) resolveAll(viewRef.current, true); setNote(null); }} id="source-keep-all">Keep all</Button>
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => { if (viewRef.current) resolveAll(viewRef.current, false); setNote(null); }} id="source-undo-all">Undo all</Button>
          </> : shownNote && <>
            <span className={styles.steveText} title={shownNote.text}>{shownNote.text.split('\n')[0]}</span>
            <IconButton small label="Dismiss" onClick={() => setNote(null)}><X /></IconButton>
          </>}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.editor}>
          <Suspense fallback={<div className={styles.loading}><Spinner /></div>}>
            <SourceEditor key={`${target.key}:${file}`} language="python" value={value} onChange={onChange}
              onSave={() => void save()} onRun={() => void act()} readOnly={!!busy || !!shownTask} steve={steve} reveal={reveal} onView={onView} onDiff={setReview} />
          </Suspense>
        </div>
      </div>
      <div className={styles.footer}>
        <span className={styles.status} data-tone={busy ? 'busy' : changed.length ? 'stale' : 'ok'} id="source-status">
          <span className={styles.statusDot} />{busy ? `${busy}…` : changed.length ? `${changed.length} ${changed.length === 1 ? 'file' : 'files'} edited` : `Revision ${target.revision}`}
        </span>
        <span className={styles.spacer} />
        {changed.length > 0 && <Button size="sm" variant="ghost" disabled={!!busy} onClick={discard} id="source-target-discard">Discard</Button>}
        <Button size="sm" variant={changed.length ? 'secondary' : 'ghost'} icon={<Save />} disabled={!next || !!busy || outdated} onClick={() => void save()} id="source-target-save">Save</Button>
        <Button size="sm" variant="primary" icon={busy ? <Spinner size={13} /> : <Play />} disabled={!!busy} onClick={() => void act()} id={target.action.id}>{target.action.label}</Button>
      </div>
    </div>
  );
}
