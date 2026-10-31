/**
 * Import and export the manufacturing library (docs/MANUFACTURING_LIBRARY_INTERCHANGE.md).
 *
 * Export: the selected record, a kind's list or everything, as a STEVE library file (JSON: the records and, by
 * default, what they use) or a spreadsheet (CSV: one kind, every field or the chosen ones). Exact revisions are read;
 * nothing in the library changes. Designs, geometry jobs and uploaded files a record uses are listed, not carried.
 *
 * Import: a file (or pasted text) is reviewed first — the server validates the whole batch and rolls it back — and
 * the review shows what would be new, what is already here (reused), and every problem by row, column and field in
 * plain words. A spreadsheet's columns are mapped to fields first (with their units). "Import" then saves all of it
 * or none, with the same request key and the reviewed file's hash: if the file or library changed since the review,
 * nothing is saved and it asks for another review.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowLeft, Check, CircleAlert, Download, FileJson, FileSpreadsheet, FileUp, Repeat2, TriangleAlert, Upload } from 'lucide-react';
import { Button, Dialog, NumberField, Segmented, Spinner } from '@/ui';
import { toast } from '@/state/store';
import { MfgError, pinOf, requestKey, type Kind, type LibraryRecord } from '../api';
import { definitionSchema, labelOf, type OpenApi } from '../schema';
import { KIND_LABELS } from '../kinds';
import { friendlyMessage, slugify } from '../fieldHelp';
import { loadLibrary, useMfg } from '../state';
import { transfer, type CsvColumn, type CsvSource, type ExternalRef, type ImportDiagnostic, type ImportItem, type ImportReport, type ImportSource, type ItemStatus, type NativeSource, type ProvenanceKind, type SourceUnits } from './api';
import { CSV_KINDS, STEVE_COLUMNS, encodingFor, fieldOptions, guessColumns, guessDelimiter, headerUnits, parseCsv, unitChoices, unitLabel, type Delimiter, type FieldOption } from './csv';
import styles from './Transfer.module.css';

export const useTransfer = create<{ mode: 'import' | 'export' | null }>(() => ({ mode: null }));

const today = () => new Date().toISOString().slice(0, 10);

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const bytes = (count: number) => (count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1024 / 1024).toFixed(1)} MB`);

/** A server problem in plain words, with the server's own text kept for "Details". */
function problemOf(error: unknown): { message: string; raw?: string } {
  if (!(error instanceof MfgError)) return { message: (error as Error).message };
  const raw = [`${error.code}: ${error.message}`, ...error.fields.map((field) => `${field.path}: ${field.message}`)].join('\n');
  const plain: Record<string, string> = {
    library_import_changed: 'The file or the library changed after the review, so nothing was imported. Review it again.',
    idempotency_conflict: 'This import’s key was already used for different content, so nothing was imported. Review it again.',
    library_import_invalid: 'Nothing was imported: some entries have problems (listed below).',
    library_export_bound: 'That’s more than 1,000 records with what they use. Export a kind at a time.',
    csv_mixed_kinds: 'A spreadsheet holds one kind of record. Choose one kind, or export a STEVE library file.',
    csv_export_bound: 'Some records are too large for a spreadsheet cell. Export a STEVE library file instead.',
    network: 'The manufacturing service couldn’t be reached. Nothing changed; try again.',
  };
  if (plain[error.code]) return { message: plain[error.code], raw };
  if (error.status === 422 && error.fields.length) return { message: `The file isn’t in a shape the library reads: ${error.fields.slice(0, 3).map((field) => `${field.path || 'the file'} — ${field.message}`).join('; ')}.`, raw };
  return { message: error.message, raw };
}

function Problem({ problem }: { problem: { message: string; raw?: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.problem} role="alert" data-transfer-problem>
      <CircleAlert size={14} />
      <div>
        <span>{problem.message}</span>
        {problem.raw && <button type="button" className={styles.link} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide details' : 'Details'}</button>}
        {open && <pre data-selectable>{problem.raw}</pre>}
      </div>
    </div>
  );
}

/* ───────────────────────────── Export ───────────────────────────── */

type Scope = 'selected' | 'kind' | 'all';

/** An external reference in a few words: what it is and which revision. */
function externalText(ref: ExternalRef): string {
  const kind = String(ref.kind ?? ref.type ?? 'reference');
  const id = typeof ref.document_id === 'string' ? ref.document_id : typeof ref.job_id === 'string' ? ref.job_id : typeof ref.sha256 === 'string' ? ref.sha256 : typeof ref.id === 'string' ? ref.id : '';
  const revision = typeof ref.revision === 'number' ? ` · revision ${ref.revision}` : '';
  return `${labelOf(kind)} ${id ? id.slice(0, 8) : ''}${revision}`.trim();
}

function ExportPanel({ records, kind, selected, api }: { records: LibraryRecord[]; kind: Kind | 'all'; selected: LibraryRecord | null; api: OpenApi | null }) {
  const [scope, setScope] = useState<Scope>(selected ? 'selected' : kind === 'all' ? 'all' : 'kind');
  const [format, setFormat] = useState<'native' | 'csv'>('native');
  const [dependencies, setDependencies] = useState(true);
  const [archived, setArchived] = useState(false);
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; raw?: string } | null>(null);
  const [result, setResult] = useState<{ name: string; size: number; count: number; roots: number; external: ExternalRef[]; warnings: ImportDiagnostic[]; content: string; type: string } | null>(null);
  const chosen = useMemo(() => {
    if (scope === 'selected') return selected ? [selected] : [];
    return records.filter((record) => (scope === 'all' || record.kind === kind) && (archived || !record.archived));
  }, [scope, selected, records, kind, archived]);
  const kinds = new Set(chosen.map((record) => record.kind));
  const csvKind = kinds.size === 1 ? [...kinds][0] : null;
  useEffect(() => { if (format === 'csv' && !csvKind) setFormat('native'); }, [format, csvKind]);
  useEffect(() => { setResult(null); setProblem(null); }, [scope, format, dependencies, archived, fields]);
  const fieldChoices = useMemo(() => (api && csvKind ? Object.keys(definitionSchema(api, csvKind)?.properties ?? {}).filter((name) => name !== 'kind' && name !== 'version') : []), [api, csvKind]);
  const scopeName = (scope === 'selected' && selected ? slugify(selected.definition.name) ?? 'record' : scope === 'kind' && kind !== 'all' ? slugify(KIND_LABELS[kind].many) ?? kind : 'library').replace(/_/g, '-');

  const run = async () => {
    setBusy(true); setProblem(null); setResult(null);
    try {
      const pins = chosen.map(pinOf);
      if (format === 'native') {
        const exported = await transfer.exportNative(pins, dependencies);
        const content = `${JSON.stringify(exported.source, null, 2)}\n`;
        const name = `steve-${scopeName}-${today()}.json`;
        download(name, content, 'application/json');
        setResult({ name, size: new Blob([content]).size, count: exported.source.entries.length, roots: exported.roots.length, external: exported.external, warnings: [], content, type: 'application/json' });
      } else {
        const exported = await transfer.exportCsv(pins, fields.size ? [...fields] : undefined);
        const content = exported.source.content;
        const name = `steve-${scopeName}-${today()}.csv`;
        download(name, content, 'text/csv');
        setResult({ name, size: new Blob([content]).size, count: exported.pins.length, roots: exported.pins.length, external: [], warnings: exported.diagnostics, content, type: 'text/csv' });
      }
    } catch (error) { setProblem(problemOf(error)); }
    finally { setBusy(false); }
  };

  const options: { value: Scope; label: string; count: number; disabled?: boolean }[] = [
    { value: 'selected', label: selected ? `“${selected.definition.name}”` : 'The selected record', count: selected ? 1 : 0, disabled: !selected },
    { value: 'kind', label: kind === 'all' ? 'This list' : KIND_LABELS[kind].many, count: kind === 'all' ? 0 : records.filter((record) => record.kind === kind && (archived || !record.archived)).length, disabled: kind === 'all' },
    { value: 'all', label: 'The whole library', count: records.filter((record) => archived || !record.archived).length },
  ];
  return (
    <div className={styles.panel} id="library-export">
      <section className={styles.step}>
        <h4>What to export</h4>
        <div className={styles.choices} role="radiogroup" aria-label="What to export">
          {options.map((option) => (
            <label key={option.value} className={styles.choice} data-on={scope === option.value || undefined} data-disabled={option.disabled || undefined} data-scope={option.value}>
              <input type="radio" name="export-scope" checked={scope === option.value} disabled={option.disabled} onChange={() => setScope(option.value)} />
              <span>{option.label}</span>
              {!option.disabled && <small>{option.count} record{option.count === 1 ? '' : 's'}</small>}
            </label>
          ))}
        </div>
        {scope !== 'selected' && <label className={styles.check}><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Include archived records</label>}
      </section>
      <section className={styles.step}>
        <h4>As</h4>
        <div className={styles.formats}>
          <button type="button" className={styles.format} data-on={format === 'native' || undefined} onClick={() => setFormat('native')} data-format="native">
            <FileJson size={18} /><b>STEVE library file</b><small>.json · any kinds, with the records they use; imports back exactly</small>
          </button>
          <button type="button" className={styles.format} data-on={format === 'csv' || undefined} disabled={!csvKind} onClick={() => setFormat('csv')} data-format="csv"
            title={csvKind ? undefined : 'A spreadsheet holds one kind of record'}>
            <FileSpreadsheet size={18} /><b>Spreadsheet</b><small>{csvKind ? `.csv · ${KIND_LABELS[csvKind].many.toLowerCase()}, one row each` : '.csv · one kind at a time'}</small>
          </button>
        </div>
        {format === 'native' && (
          <label className={styles.check}><input type="checkbox" checked={dependencies} onChange={(event) => setDependencies(event.target.checked)} data-dependencies />
            Include the records they use (a tool assembly’s cutter and holders, a machine’s model and controller)</label>
        )}
        {format === 'csv' && fieldChoices.length > 0 && (
          <div className={styles.fieldChips}>
            <span className={styles.muted}>Columns: {fields.size ? `${fields.size} chosen` : 'every field'} (a partial sheet needs values filled in to import again)</span>
            <div className={styles.chips}>
              {fieldChoices.map((name) => (
                <button key={name} type="button" className={styles.chip} data-on={fields.has(name) || undefined} aria-pressed={fields.has(name)}
                  onClick={() => { const next = new Set(fields); if (next.has(name)) next.delete(name); else next.add(name); setFields(next); }}>{labelOf(name)}</button>
              ))}
            </div>
          </div>
        )}
      </section>
      {problem && <Problem problem={problem} />}
      {result && (
        <div className={styles.done} data-export-result>
          <Check size={16} />
          <div>
            <b>{result.name}</b>
            <span>{result.count} record{result.count === 1 ? '' : 's'}{format === 'native' && result.count > result.roots ? ` (${result.roots} chosen, ${result.count - result.roots} they use)` : ''} · {bytes(result.size)}</span>
            {result.external.length > 0 && (
              <p className={styles.note} data-tone="warning" data-external>
                They use {result.external.length} thing{result.external.length === 1 ? '' : 's'} the file doesn’t carry ({result.external.slice(0, 3).map(externalText).join(', ')}{result.external.length > 3 ? '…' : ''}): saved designs, geometry jobs or uploaded files must exist where it’s imported.
              </p>
            )}
            {result.warnings.map((warning, index) => <p key={index} className={styles.note} data-tone="warning">{warning.message}</p>)}
          </div>
          <Button size="sm" icon={<Download />} onClick={() => download(result.name, result.content, result.type)}>Download again</Button>
        </div>
      )}
      <footer className={styles.foot}>
        <span className={styles.muted}>Exact revisions are exported; nothing in the library changes.</span>
        <Button variant="primary" size="sm" icon={busy ? <Spinner size={12} /> : <Download />} disabled={busy || !chosen.length} onClick={() => void run()} id="export-run">
          {busy ? 'Exporting…' : `Export ${chosen.length} record${chosen.length === 1 ? '' : 's'}`}
        </Button>
      </footer>
    </div>
  );
}

/* ───────────────────────────── Import ───────────────────────────── */

interface CsvDraft { text: string; delimiter: Delimiter; kind: Kind; columns: (CsvColumn | null)[]; defaults: Record<string, unknown>; provenance: ProvenanceKind; steve: boolean }
type Stage = 'source' | 'map' | 'review' | 'done';

const STATUS: Record<ItemStatus, { label: string; tone: string }> = {
  ready: { label: 'New', tone: 'new' }, created: { label: 'Imported', tone: 'ok' }, reused: { label: 'Already here', tone: 'same' },
  invalid: { label: 'Has problems', tone: 'bad' }, blocked: { label: 'Waits on a problem', tone: 'blocked' },
};
const PROVENANCE: { value: ProvenanceKind; label: string; hint: string }[] = [
  { value: 'note', label: 'Not stated', hint: 'Each value notes the file, row and column it came from.' },
  { value: 'catalog', label: 'Vendor catalog', hint: 'Values were copied from a manufacturer’s catalog.' },
  { value: 'measured', label: 'Measured', hint: 'Values were measured on the actual items.' },
  { value: 'estimate', label: 'Estimates', hint: 'Values are estimates: checks that use them stay unassessed.' },
];

/** Where a diagnostic points, in words: "Row 3 · Diameter" / "“6 mm end mill” · Cutter". */
function whereOf(diagnostic: ImportDiagnostic, names: Map<string, string>): string {
  const parts = [diagnostic.row ? `Row ${diagnostic.row}` : diagnostic.entry ? `“${names.get(diagnostic.entry) ?? diagnostic.entry}”` : 'The file'];
  if (diagnostic.column) parts.push(`column “${diagnostic.column}”`);
  else if (diagnostic.field) parts.push(diagnostic.field.split('.').map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : labelOf(part))).join(' › '));
  return parts.join(' · ');
}

function ImportPanel({ records, api, onOpen }: { records: LibraryRecord[]; api: OpenApi | null; onOpen: (record: LibraryRecord) => void }) {
  const [stage, setStage] = useState<Stage>('source');
  const [fileName, setFileName] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [native, setNative] = useState<NativeSource | null>(null);
  const [reuseHere, setReuseHere] = useState(true);
  const [copies, setCopies] = useState<Set<string>>(new Set());
  const [csv, setCsv] = useState<CsvDraft | null>(null);
  const [busy, setBusy] = useState<'review' | 'import' | null>(null);
  const [problem, setProblem] = useState<{ message: string; raw?: string } | null>(null);
  const [review, setReview] = useState<{ key: string; source: ImportSource; report: ImportReport } | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);

  const reset = () => { setStage('source'); setNative(null); setCsv(null); setReview(null); setResult(null); setProblem(null); setFileName(null); setPaste(''); setCopies(new Set()); };

  /** The native source to send: entries from this library can be reused rather than copied (unless asked for copies). */
  const nativeSource = (source: NativeSource): NativeSource => ({
    ...source, format: 'native',
    entries: source.entries.map((entry) => ({ ...entry, reuse: reuseHere && entry.source_pin && byId.has(entry.source_pin.id) && !copies.has(entry.key) ? entry.source_pin : entry.reuse ?? null })),
  });

  const csvSource = (draft: CsvDraft): CsvSource => ({
    format: 'csv', kind: draft.kind, content: draft.text, delimiter: draft.delimiter, provenance_kind: draft.provenance,
    columns: draft.columns.filter((column): column is CsvColumn => !!column),
    defaults: Object.fromEntries(Object.entries(draft.defaults).filter(([, value]) => value !== '' && value !== undefined)),
  });

  const runReview = async (source: ImportSource) => {
    setBusy('review'); setProblem(null);
    try {
      // A new key per reviewed source; the import reuses it (and retries with it) for exactly that source.
      const key = requestKey('library-import');
      const report = await transfer.preview(key, source);
      setReview({ key, source, report });
      setStage('review');
    } catch (error) { setProblem(problemOf(error)); }
    finally { setBusy(null); }
  };

  const commit = async () => {
    if (!review) return;
    setBusy('import'); setProblem(null);
    try {
      const report = await transfer.commit(review.key, review.source, review.report.source_sha256);
      setResult(report);
      setStage('done');
      await loadLibrary();
      const made = report.items.filter((item) => item.status === 'created').length;
      toast('success', 'Imported', `${made} new record${made === 1 ? '' : 's'}${report.items.length > made ? `, ${report.items.length - made} already here` : ''}.`);
    } catch (error) {
      // An invalid batch comes back with its report: show it in place of the review's.
      if (error instanceof MfgError && error.code === 'library_import_invalid' && error.details && typeof error.details === 'object') {
        setReview({ ...review, report: error.details as ImportReport });
      }
      setProblem(problemOf(error));
    } finally { setBusy(null); }
  };

  /** Read a file or pasted text: a STEVE library file (or a full import request) is reviewed at once; a CSV is mapped first. */
  const take = (text: string, name: string | null) => {
    setProblem(null); setFileName(name);
    const trimmed = text.trim();
    if (!trimmed) { setProblem({ message: 'The file is empty.' }); return; }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let data: unknown;
      try { data = JSON.parse(trimmed); } catch (error) { setProblem({ message: 'This looks like JSON but can’t be read. Check the file isn’t cut off or edited by hand.', raw: (error as Error).message }); return; }
      const object = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const source = (object.source && typeof object.source === 'object' ? object.source : object) as Record<string, unknown>;
      if (source.format === 'csv' && typeof source.content === 'string') {
        const given = source as unknown as CsvSource;
        const headers = parseCsv(given.content, given.delimiter ?? ',', 1)[0] ?? [];
        const columns = headers.map((header) => given.columns.find((column) => column.column === header) ?? null);
        setCsv({ text: given.content, delimiter: given.delimiter ?? ',', kind: given.kind, columns, defaults: { ...(given.defaults ?? {}) }, provenance: given.provenance_kind ?? 'note', steve: headers.includes('@archived') });
        setStage('map');
        return;
      }
      if (Array.isArray(source.entries)) {
        const nativeFile = { format: 'native', version: 1, entries: source.entries } as NativeSource;
        setNative(nativeFile);
        void runReview(nativeSource(nativeFile));
        return;
      }
      setProblem({ message: 'This JSON isn’t a STEVE library file: it has no entries. Export one from a library with Export.' });
      return;
    }
    // A spreadsheet: guess the kind from the column names, then map.
    const delimiter = guessDelimiter(trimmed);
    const headers = parseCsv(trimmed, delimiter, 1)[0] ?? [];
    if (headers.length < 2 && !trimmed.includes('\n')) { setProblem({ message: 'This doesn’t look like a spreadsheet (CSV) or a STEVE library file.' }); return; }
    const scored = api ? CSV_KINDS.map((kind) => {
      const schema = definitionSchema(api, kind);
      const guess = schema ? guessColumns(headers, fieldOptions(api, schema)) : null;
      const exact = text.split(/\r?\n/, 3).slice(1).some((line) => line.includes(`""${kind}""`) || line.includes(`"${kind}"`));
      return { kind, mapped: guess ? guess.columns.filter(Boolean).length + (exact ? 100 : 0) : 0 };
    }).sort((a, b) => b.mapped - a.mapped) : [];
    const kind = scored[0]?.kind ?? 'rotary_cutter';
    setCsv(mapFor(text, delimiter, kind, {}, 'note'));
    setStage('map');
  };

  const mapFor = (text: string, delimiter: Delimiter, kind: Kind, defaults: Record<string, unknown>, provenance: ProvenanceKind): CsvDraft => {
    const headers = parseCsv(text, delimiter, 1)[0] ?? [];
    const schema = api ? definitionSchema(api, kind) : null;
    const { columns, steve } = schema && api ? guessColumns(headers, fieldOptions(api, schema)) : { columns: headers.map(() => null), steve: false };
    return { text, delimiter, kind, columns, defaults, provenance, steve };
  };

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) { setProblem({ message: 'That file is over 16 MB, more than one import takes. Split it into smaller files.' }); return; }
    take(await file.text(), file.name);
  };

  // Reusing (or copying) records already here changes what's imported: review it again.
  const reviewedChoice = useRef({ reuseHere, copies });
  useEffect(() => {
    if (reviewedChoice.current.reuseHere === reuseHere && reviewedChoice.current.copies === copies) return;
    reviewedChoice.current = { reuseHere, copies };
    if (stage === 'review' && native) void runReview(nativeSource(native));
  }, [reuseHere, copies]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => new Map((review?.source.format === 'native' ? review.source.entries : []).map((entry) => [entry.key, String(entry.definition.name ?? entry.key)])), [review]);
  // A spreadsheet row's name (its mapped Name column), for rows that have no record to show yet.
  const rowNames = useMemo(() => {
    const out = new Map<number, string>();
    if (review?.source.format !== 'csv') return out;
    const source = review.source;
    const rows = parseCsv(source.content, source.delimiter ?? ',');
    const at = rows[0]?.findIndex((header) => source.columns.some((column) => column.column === header && column.field === 'name')) ?? -1;
    const json = source.columns.find((column) => column.field === 'name')?.encoding === 'json';
    const read = (cell: string) => { if (!json) return cell; try { return String(JSON.parse(cell)); } catch { return cell; } };
    if (at >= 0) rows.slice(1).forEach((row, index) => { if (row[at]) out.set(index + 2, read(row[at])); });
    return out;
  }, [review]);
  const sameName = (item: ImportItem) => {
    const entry = review?.source.format === 'native' ? review.source.entries.find((candidate) => candidate.key === item.key) : null;
    const name = item.record?.definition.name ?? entry?.definition.name;
    const kind = item.record?.kind ?? entry?.definition.kind;
    return item.status === 'ready' && !!name && records.some((record) => record.kind === kind && record.definition.name === name && !record.archived);
  };

  return (
    <div className={styles.panel} id="library-import" data-stage={stage}>
      <ol className={styles.steps} aria-label="Import steps">
        {(['source', ...(csv ? ['map'] : []), 'review', 'done'] as Stage[]).map((item, index) => (
          <li key={item} data-on={stage === item || undefined} data-past={(['source', 'map', 'review', 'done'].indexOf(stage) > ['source', 'map', 'review', 'done'].indexOf(item)) || undefined}>
            <span>{index + 1}</span>{{ source: 'File', map: 'Columns', review: 'Review', done: 'Imported' }[item]}
          </li>
        ))}
      </ol>

      {stage === 'source' && (
        <section className={styles.step}>
          <div className={styles.drop} data-dragging={dragging || undefined} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void onFiles(event.dataTransfer.files); }}>
            <FileUp size={22} />
            <b>Drop a STEVE library file (.json) or a spreadsheet (.csv)</b>
            <span className={styles.muted}>A spreadsheet’s columns are matched to fields next; everything is reviewed before anything is saved.</span>
            <Button size="sm" icon={<Upload />} onClick={() => fileInput.current?.click()} id="import-choose" disabled={!!busy}>Choose a file</Button>
            <input ref={fileInput} type="file" accept=".json,.csv,.tsv,.txt,application/json,text/csv" hidden data-import-file onChange={(event) => { void onFiles(event.target.files); event.target.value = ''; }} />
          </div>
          <details className={styles.paste}>
            <summary>Or paste the text</summary>
            <textarea className={styles.textarea} rows={6} value={paste} onChange={(event) => setPaste(event.target.value)} aria-label="Pasted library data" placeholder="Name,Diameter (in),Flutes…" />
            <Button size="sm" disabled={!paste.trim() || !!busy} onClick={() => take(paste, null)} id="import-paste">Read it</Button>
          </details>
          {busy === 'review' && <p className={styles.muted}><Spinner size={12} /> Checking every entry…</p>}
        </section>
      )}

      {stage === 'map' && csv && api && <CsvMapping api={api} draft={csv} fileName={fileName} onChange={setCsv} onKind={(kind) => setCsv(mapFor(csv.text, csv.delimiter, kind, {}, csv.provenance))}
        onDelimiter={(delimiter) => setCsv(mapFor(csv.text, delimiter, csv.kind, csv.defaults, csv.provenance))} />}

      {stage === 'review' && review && (
        <section className={styles.step} data-review>
          <ReviewSummary report={review.report} />
          {review.source.format === 'native' && native && (
            <label className={styles.check}>
              <input type="checkbox" checked={reuseHere} data-reuse onChange={(event) => { setReuseHere(event.target.checked); setCopies(new Set()); }} />
              Reuse records that are already in this library (identical ones aren’t copied)
            </label>
          )}
          <ul className={styles.items} data-items>
            {review.report.items.map((item) => {
              const status = STATUS[item.status];
              const entry = review.source.format === 'native' ? review.source.entries.find((candidate) => candidate.key === item.key) : null;
              const name = item.record?.definition.name ?? entry?.definition.name ?? (item.row ? rowNames.get(item.row) ?? `Row ${item.row}` : item.key);
              const kind = (item.record?.kind ?? entry?.definition.kind ?? (review.source.format === 'csv' ? review.source.kind : null)) as Kind | null;
              const problems = review.report.diagnostics.filter((diagnostic) => (diagnostic.entry && diagnostic.entry === item.key) || (item.row && diagnostic.row === item.row));
              // Rejected with nothing of its own to fix: the file's other problems stopped it being checked.
              const unchecked = item.status === 'invalid' && !problems.length;
              return (
                <li key={item.key} data-status={item.status} data-item={item.key} data-unchecked={unchecked || undefined}>
                  <span className={styles.badge} data-tone={unchecked ? 'blocked' : status.tone} title={unchecked ? 'It’s checked once the problems below are fixed' : undefined}>{unchecked ? 'Not checked yet' : status.label}</span>
                  <span className={styles.itemName}>{String(name)}</span>
                  <small>{kind ? KIND_LABELS[kind]?.one ?? kind : ''}{item.row ? ` · row ${item.row}` : ''}</small>
                  {sameName(item) && <small className={styles.hint} data-same-name>Same name as a record here; imports as a separate copy</small>}
                  {problems.length > 0 && <small className={styles.hint} data-tone="bad">{problems.length} problem{problems.length === 1 ? '' : 's'}</small>}
                </li>
              );
            })}
          </ul>
          {review.report.diagnostics.length > 0 && (
            <div className={styles.diagnostics} data-diagnostics>
              <h5>Problems and warnings</h5>
              <ul>
                {review.report.diagnostics.map((diagnostic, index) => (
                  <li key={index} data-severity={diagnostic.severity ?? 'error'} data-code={diagnostic.code}>
                    {diagnostic.severity === 'warning' ? <TriangleAlert size={12} /> : <CircleAlert size={12} />}
                    <b>{whereOf(diagnostic, names)}</b>
                    <span>{diagnostic.field ? friendlyMessage({ path: diagnostic.field, message: diagnostic.message, code: diagnostic.code }) : diagnostic.message.replace(/^Value error, /, '')}</span>
                  </li>
                ))}
              </ul>
              {review.source.format === 'native' && review.report.diagnostics.some((diagnostic) => diagnostic.code === 'import_reuse_mismatch') && (
                <Button size="sm" icon={<Repeat2 />} onClick={() => {
                  const keys = new Set(review.report.diagnostics.filter((diagnostic) => diagnostic.code === 'import_reuse_mismatch' && diagnostic.entry).map((diagnostic) => diagnostic.entry!));
                  setCopies(new Set([...copies, ...keys]));
                }}>Import copies of the ones that differ</Button>
              )}
            </div>
          )}
        </section>
      )}

      {stage === 'done' && result && (
        <section className={styles.step} data-done>
          <div className={styles.done}>
            <Check size={16} />
            <div>
              <b>{result.items.filter((item) => item.status === 'created').length} records imported</b>
              <span>{result.items.filter((item) => item.status === 'reused').length} already here and reused · saved together, all at once</span>
            </div>
          </div>
          <ul className={styles.items} data-items>
            {result.items.map((item) => (
              <li key={item.key} data-status={item.status}>
                <span className={styles.badge} data-tone={STATUS[item.status].tone}>{STATUS[item.status].label}</span>
                <span className={styles.itemName}>{item.record?.definition.name ?? item.key}</span>
                <small>{item.record ? `${KIND_LABELS[item.record.kind]?.one ?? item.record.kind} · revision ${item.record.revision}` : ''}</small>
                {item.record && <button type="button" className={styles.link} onClick={() => onOpen(item.record!)}>Show</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {problem && <Problem problem={problem} />}

      <footer className={styles.foot}>
        {stage !== 'source' && stage !== 'done' && <Button size="sm" icon={<ArrowLeft />} onClick={() => { setProblem(null); setStage(stage === 'review' && csv ? 'map' : 'source'); if (stage === 'map' || !csv) reset(); }} disabled={!!busy}>Back</Button>}
        <span className={styles.spacer} />
        {stage === 'map' && csv && (
          <Button size="sm" variant="primary" disabled={!!busy || !csv.columns.some(Boolean)} onClick={() => void runReview(csvSource(csv))} id="import-review">
            {busy === 'review' ? 'Checking…' : 'Review'}
          </Button>
        )}
        {stage === 'review' && review && (
          <>
            {problem && /Review it again/.test(problem.message) && <Button size="sm" onClick={() => void runReview(review.source)} disabled={!!busy} id="import-review-again">Review again</Button>}
            <Button size="sm" variant="primary" id="import-commit" disabled={!!busy || !review.report.valid} onClick={() => void commit()}>
              {busy === 'import' ? 'Importing…' : review.report.valid ? `Import ${review.report.items.length} record${review.report.items.length === 1 ? '' : 's'}` : 'Fix the problems to import'}
            </Button>
          </>
        )}
        {stage === 'done' && <Button size="sm" onClick={reset} id="import-another">Import another file</Button>}
      </footer>
    </div>
  );
}

function ReviewSummary({ report }: { report: ImportReport }) {
  const own = (item: ImportItem) => report.diagnostics.some((diagnostic) => (diagnostic.entry && diagnostic.entry === item.key) || (item.row && diagnostic.row === item.row));
  const unchecked = report.items.filter((item) => item.status === 'invalid' && !own(item)).length;
  const count = (status: ItemStatus) => report.items.filter((item) => item.status === status).length - (status === 'invalid' ? unchecked : 0);
  const warnings = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const errors = report.diagnostics.length - warnings;
  return (
    <div className={styles.summary} data-valid={report.valid || undefined} data-summary>
      {report.valid ? <Check size={16} /> : <CircleAlert size={16} />}
      <div>
        <b>{report.valid ? 'Ready to import' : 'Can’t import yet'}</b>
        <span>
          {[count('ready') && `${count('ready')} new`, count('reused') && `${count('reused')} already here`, count('invalid') && `${count('invalid')} with problems`,
            count('blocked') && `${count('blocked')} waiting on one with problems`, unchecked && `${unchecked} not checked yet`, errors && `${errors} problem${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`]
            .filter(Boolean).join(' · ')}
        </span>
        <small className={styles.muted}>Nothing is saved yet. Import saves all of it or none; new records get new identities, so nothing here is overwritten.</small>
      </div>
    </div>
  );
}

/** Mapping a spreadsheet's columns to the kind's fields, with units, blank cells and values for every row. */
function CsvMapping({ api, draft, fileName, onChange, onKind, onDelimiter }: {
  api: OpenApi; draft: CsvDraft; fileName: string | null; onChange: (draft: CsvDraft) => void; onKind: (kind: Kind) => void; onDelimiter: (delimiter: Delimiter) => void;
}) {
  const rows = useMemo(() => parseCsv(draft.text, draft.delimiter, 6), [draft.text, draft.delimiter]);
  const total = useMemo(() => Math.max(parseCsv(draft.text, draft.delimiter).length - 1, 0), [draft.text, draft.delimiter]);
  const headers = rows[0] ?? [];
  const schema = definitionSchema(api, draft.kind);
  const options = useMemo(() => (schema ? fieldOptions(api, schema) : []), [api, schema]);
  const mapped = new Set(draft.columns.filter(Boolean).map((column) => column!.field));
  const missing = options.filter((option) => option.required && !option.path.includes('.') && !mapped.has(option.path) && draft.defaults[option.path] === undefined);
  const setColumn = (index: number, column: CsvColumn | null) => onChange({ ...draft, columns: draft.columns.map((item, at) => (at === index ? column : item)) });
  return (
    <section className={styles.step} data-mapping>
      <div className={styles.mapHead}>
        <label>What’s in {fileName ? `“${fileName}”` : 'it'}
          <select className={styles.select} value={draft.kind} onChange={(event) => onKind(event.target.value as Kind)} aria-label="Kind of records">
            {CSV_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind].many}</option>)}
          </select>
        </label>
        <label>Separated by
          <select className={styles.select} value={draft.delimiter} onChange={(event) => onDelimiter(event.target.value as Delimiter)} aria-label="Separator">
            <option value=",">Commas</option><option value=";">Semicolons</option><option value={'\t'}>Tabs</option>
          </select>
        </label>
        <label>The values are
          <select className={styles.select} value={draft.provenance} onChange={(event) => onChange({ ...draft, provenance: event.target.value as ProvenanceKind })} aria-label="Where the values come from" data-provenance>
            {PROVENANCE.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <p className={styles.muted}>{total} row{total === 1 ? '' : 's'}. {draft.steve ? 'A STEVE export: its columns are mapped as they were saved.' : 'Match each column to a field (or leave it out) and say its units; values are converted exactly.'} {PROVENANCE.find((item) => item.value === draft.provenance)!.hint}</p>
      <div className={styles.mapTable} role="table" aria-label="Column mapping">
        <div className={styles.mapRow} role="row" data-head>
          <span role="columnheader">Column</span><span role="columnheader">Field</span><span role="columnheader">Units</span><span role="columnheader">Empty cells</span>
        </div>
        {headers.map((header, index) => {
          const column = draft.columns[index] ?? null;
          const option = column ? options.find((item) => item.path === column.field) : undefined;
          const units: SourceUnits[] = column ? unitChoices(column.field) : ['native'];
          const samples = rows.slice(1).map((row) => row[index]).filter((cell) => cell !== undefined && cell !== '').slice(0, 3);
          return (
            <div key={`${index}:${header}`} className={styles.mapRow} role="row" data-column={header} data-mapped={!!column || undefined}>
              <span className={styles.mapSource}><b>{header || `Column ${index + 1}`}</b><small title={samples.join(' · ')}>{samples.join(' · ') || 'empty'}</small></span>
              <select className={styles.select} aria-label={`Field for ${header}`} value={column?.field ?? ''} onChange={(event) => {
                const path = event.target.value;
                if (!path) { setColumn(index, null); return; }
                if (STEVE_COLUMNS.includes(path)) { setColumn(index, { column: header, field: path, encoding: 'json', units: 'native', blank: 'omit' }); return; }
                const chosen = options.find((item) => item.path === path)!;
                setColumn(index, { column: header, field: path, encoding: draft.steve ? 'json' : encodingFor(chosen.schema), units: draft.steve ? 'native' : headerUnits(header, path), blank: column?.blank ?? 'omit' });
              }}>
                <option value="">Leave out</option>
                {options.map((item) => <option key={item.path} value={item.path} disabled={mapped.has(item.path) && column?.field !== item.path}>{item.label}{item.required ? ' *' : ''}</option>)}
                {draft.steve && <><option value="kind">Kind (STEVE)</option><option value="version">Format version (STEVE)</option><option value="@provenance">Sources (STEVE)</option><option value="@archived">Archived (STEVE)</option></>}
              </select>
              <select className={styles.select} aria-label={`Units for ${header}`} value={column?.units ?? 'native'} disabled={!column || units.length < 2}
                onChange={(event) => column && setColumn(index, { ...column, units: event.target.value as CsvColumn['units'] })}>
                {units.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
              </select>
              <select className={styles.select} aria-label={`Empty cells in ${header}`} value={column?.blank ?? 'omit'} disabled={!column}
                onChange={(event) => column && setColumn(index, { ...column, blank: event.target.value as CsvColumn['blank'] })}>
                <option value="omit">Use the value for every row</option>
                <option value="null">Mean “none”</option>
                {option && (option.schema.type === 'string' || option.schema.enum === undefined && encodingFor(option.schema) === 'text') && <option value="empty">Mean empty text</option>}
              </select>
            </div>
          );
        })}
      </div>
      <Defaults options={options} draft={draft} missing={missing} onChange={(defaults) => onChange({ ...draft, defaults })} />
    </section>
  );
}

/** Values for every row: the required fields no column fills first, then any others the person adds. */
function Defaults({ options, draft, missing, onChange }: { options: FieldOption[]; draft: CsvDraft; missing: FieldOption[]; onChange: (defaults: Record<string, unknown>) => void }) {
  const [adding, setAdding] = useState('');
  const shown = [...missing.map((option) => option.path), ...Object.keys(draft.defaults).filter((path) => !missing.some((option) => option.path === path))];
  const set = (path: string, value: unknown) => onChange({ ...draft.defaults, [path]: value });
  return (
    <div className={styles.defaults} data-defaults>
      <h5>Values for every row</h5>
      {missing.length > 0 && <p className={styles.note} data-tone="warning">{missing.length} required field{missing.length === 1 ? ' has' : 's have'} no column: give {missing.length === 1 ? 'it a value' : 'them values'} for every row, or map a column.</p>}
      {shown.map((path) => {
        const option = options.find((item) => item.path === path);
        const value = draft.defaults[path];
        const type = option?.schema.enum ? 'enum' : option ? encodingFor(option.schema) : 'json';
        return (
          <label key={path} className={styles.defaultRow} data-default={path}>
            <span>{option?.label ?? labelOf(path)}{option?.required ? ' *' : ''}</span>
            {type === 'enum' ? (
              <select className={styles.select} value={value === undefined ? '' : String(value)} aria-label={`${option!.label} for every row`} onChange={(event) => set(path, event.target.value || undefined)}>
                <option value="">Choose…</option>
                {option!.schema.enum!.filter((item) => item !== 'fff').map((item) => <option key={String(item)} value={String(item)}>{labelOf(String(item))}</option>)}
              </select>
            ) : type === 'boolean' ? (
              <input type="checkbox" checked={value === true} aria-label={`${option?.label ?? path} for every row`} onChange={(event) => set(path, event.target.checked)} />
            ) : type === 'number' || type === 'integer' ? (
              <NumberField className={styles.input} unit="" optional eager integer={type === 'integer'} value={typeof value === 'number' ? value : undefined} ariaLabel={`${option?.label ?? path} for every row`}
                onChange={(next) => set(path, next)} />
            ) : type === 'text' ? (
              <input className={styles.input} value={typeof value === 'string' ? value : ''} aria-label={`${option?.label ?? path} for every row`} onChange={(event) => set(path, event.target.value)} />
            ) : (
              <textarea className={styles.textarea} rows={2} defaultValue={value === undefined ? '' : JSON.stringify(value)} aria-label={`${option?.label ?? path} for every row (JSON)`}
                onBlur={(event) => { try { set(path, event.target.value.trim() ? JSON.parse(event.target.value) : undefined); } catch { /* keep the text until it reads */ } }} />
            )}
          </label>
        );
      })}
      <span className={styles.addDefault}>
        <select className={styles.select} value={adding} onChange={(event) => setAdding(event.target.value)} aria-label="Add a value for every row">
          <option value="">Add a value for every row…</option>
          {options.filter((option) => !option.path.includes('.') && !shown.includes(option.path)).map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
        </select>
        <Button size="sm" disabled={!adding} onClick={() => { set(adding, ''); setAdding(''); }}>Add</Button>
      </span>
    </div>
  );
}

/* ───────────────────────────── Dialog ───────────────────────────── */

export default function TransferDialog({ records, kind, selected, api }: { records: LibraryRecord[]; kind: Kind | 'all'; selected: LibraryRecord | null; api: OpenApi | null }) {
  const mode = useTransfer((state) => state.mode);
  const close = () => useTransfer.setState({ mode: null });
  return (
    <Dialog open={!!mode} onOpenChange={(open) => { if (!open) close(); }} width={860} icon={mode === 'export' ? <Download size={18} /> : <Upload size={18} />}
      title={mode === 'export' ? 'Export library records' : 'Import library records'}
      description={mode === 'export' ? 'Share records with another workspace or keep a copy. Exact revisions; nothing here changes.'
        : 'Bring in a STEVE library file or a vendor’s spreadsheet. You review everything before it’s saved, and it saves all at once.'}>
      <div className={styles.modes}>
        <Segmented size="sm" value={mode ?? 'import'} onChange={(value) => useTransfer.setState({ mode: value })}
          options={[{ value: 'import', label: 'Import', icon: <Upload size={13} /> }, { value: 'export', label: 'Export', icon: <Download size={13} /> }]} />
      </div>
      {mode === 'export' && <ExportPanel records={records} kind={kind} selected={selected} api={api} />}
      {mode === 'import' && <ImportPanel records={records} api={api} onOpen={(record) => { close(); useMfg.setState({ libraryKind: record.kind, librarySelect: record.id }); }} />}
    </Dialog>
  );
}
