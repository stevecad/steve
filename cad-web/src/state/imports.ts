import { create } from 'zustand';
import { Api, ApiError, importInfo, uploadImport, type StepImport } from '@/lib/api';
import { call, ensureModel, insertFeature, nextId, parseModel, type Py } from '@/lib/modeling';
import { get, patchDoc, set, toast, type AppState } from './store';
import { componentPath, fileLabel, filesOf, withComponent, withLink } from './design';
import { saveDraft, setCode, updateModel } from './actions';
import { openTab } from './tabs';
import { modelingOf } from '@/modeling/bodies';
import { isMcmasterFile, MCMASTER_SUFFIXES, receiveMcmasterFile } from './mcmaster';
import { openFeature, setValue, useFeatureDialog } from '@/modeling/dialog';

/**
 * Importing a STEP or Autodesk Fusion (.f3d) file: upload (with progress), the server's kernel check, then one of
 * new part / insert into the open part / (designs) a component per solid or one linked part per solid.
 * The file is stored once by content; documents only reference its sha256 in `import_step(...)`.
 */
export const MAX_MB = 200;
export type ImportChoice = 'new' | 'insert' | 'components' | 'parts';
export type ImportPhase = 'idle' | 'uploading' | 'checking' | 'ready' | 'failed';

export interface ImportFlow {
  file: { name: string; size: number } | null;
  phase: ImportPhase;
  progress: number;
  record: StepImport | null;
  problem: { title: string; detail: string } | null;
  choice: ImportChoice;
  working: boolean;
  /** When the kernel started reading the file (ms), for the elapsed time shown while it works. */
  checkingSince: number | null;
  /** A comment kept above the import it adds (a standard part's catalog id, link, license and checksum). */
  provenance: string | null;
  /** The feature or component id and display name the import gets (a McMaster part number), instead of the file's. */
  naming: Naming | null;
}
export interface Naming { id: string; name: string }

const idle: ImportFlow = { file: null, phase: 'idle', progress: 0, record: null, problem: null, choice: 'new', working: false, checkingSince: null, provenance: null, naming: null };
export const useImport = create<ImportFlow>(() => idle);

let run = 0;
let controller: AbortController | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** STEP files and Autodesk Fusion designs (.f3d: imported as their exact solids, with their parameters listed). */
export const isImportName = (name: string) => /\.(step|stp|f3d)$/i.test(name);
export const INPUT_ID = 'step-file-input';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The system file picker (the import dialog keeps one hidden input mounted). */
export function chooseStepFile() {
  const input = document.getElementById(INPUT_ID) as HTMLInputElement | null;
  if (!input) return;
  input.value = '';
  input.click();
}

const titleFor = (message: string | null) =>
  !message ? 'Couldn’t import this file'
    : /no solids/i.test(message) ? 'No solids in this file'
      : /readable STEP|isn't a STEP|ISO-10303/i.test(message) ? 'Not a readable STEP file'
        : /Fusion/i.test(message) ? 'Couldn’t import this Fusion design'
        : /time limit/i.test(message) ? 'This file took too long to read'
          : /memory/i.test(message) ? 'This file is too large to read'
            : 'Couldn’t import this file';

/** Uploads and checks a file; the dialog shows each step. A newer file supersedes this one. */
export function startImport(file: File) {
  controller?.abort();
  const current = ++run;
  const fail = (title: string, detail: string) => { if (current === run) useImport.setState({ phase: 'failed', problem: { title, detail } }); };
  // In a design, the solids most often become its components.
  useImport.setState({ ...idle, file: { name: file.name, size: file.size }, phase: 'uploading', choice: get().doc.open && get().doc.kind === 'design' ? 'components' : 'new' });
  set({ dialog: 'import' });
  if (!isImportName(file.name)) { fail('Not a file STEVE can import', `${file.name} isn’t a STEP (.step, .stp) or Fusion (.f3d) file. Export STEP (AP203, AP214 or AP242) from your CAD tool and import that.`); return; }
  if (file.size > MAX_MB * 1024 * 1024) { fail('File too large', `${formatBytes(file.size)} is over the ${MAX_MB} MB import limit. Simplify the model or export fewer bodies.`); return; }
  if (!file.size) { fail('Empty file', `${file.name} has no content.`); return; }
  const abort = controller = new AbortController();
  void (async () => {
    try {
      let record = await uploadImport(file, (fraction) => { if (current === run) useImport.setState({ progress: fraction }); }, abort.signal);
      if (current !== run) return;
      useImport.setState({ phase: 'checking', progress: 1, record, checkingSince: Date.now() });
      while (record.status === 'validating') {
        await sleep(600);
        if (current !== run) return;
        record = await importInfo(record.id);
      }
      if (current !== run) return;
      if (record.status === 'failed') { fail(titleFor(record.error), record.error ?? 'The geometry kernel couldn’t read this file.'); return; }
      useImport.setState({ phase: 'ready', record });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      const status = error instanceof ApiError ? error.status : 0;
      const message = (error as Error).message;
      fail(status === 413 ? 'File too large' : status === 415 ? 'Not a file STEVE can import' : status === 422 ? titleFor(message) : 'Upload failed', message);
    }
  })();
}

export function closeImport() {
  controller?.abort();
  controller = null;
  run++;
  useImport.setState(idle);
  if (get().dialog === 'import') set({ dialog: null });
}

export const canInsert = (doc: AppState['doc']): true | string =>
  (doc.open && doc.kind === 'part') || (doc.open && doc.kind === 'design' ? 'Designs link parts rather than bodies.' : 'Open a part to insert into.');

export const canSplit = (doc: AppState['doc'], record: StepImport | null): boolean =>
  doc.open && doc.kind === 'design' && (record?.solids ?? 0) >= 1;

export async function confirmImport() {
  const { record, working } = useImport.getState();
  if (!record || record.status !== 'ready' || working) return;
  const state = get();
  if (state.busy) { toast('info', 'One moment', 'Wait for the current operation to finish.'); return; }
  const chosen = useImport.getState().choice;
  const choice = (chosen === 'insert' && canInsert(state.doc) !== true) || ((chosen === 'parts' || chosen === 'components') && !canSplit(state.doc, record)) ? 'new' : chosen;
  useImport.setState({ working: true });
  try {
    if (choice === 'insert') await insertIntoPart(record);
    else if (choice === 'parts') await partPerSolid(record);
    else if (choice === 'components') await componentPerSolid(record);
    else newPart(record);
    closeImport();
  } catch (error) {
    useImport.setState({ working: false });
    toast('danger', 'Couldn’t add the import', (error as Error).message);
  }
}

const solidsText = (record: StepImport) => `${record.solids} solid${record.solids === 1 ? '' : 's'}`;

/** The flow's provenance comment above the last `import_step` of this file in `code` (once). */
function annotate(code: string, sha256: string): string {
  const comment = useImport.getState().provenance;
  if (!comment) return code;
  const lines = code.split('\n');
  let index = -1;
  lines.forEach((line, i) => { if (line.includes('import_step(') && line.includes(sha256)) index = i; });
  if (index < 0 || lines[index - 1]?.trim() === comment) return code;
  lines.splice(index, 0, `${lines[index].match(/^\s*/)![0]}${comment}`);
  return lines.join('\n');
}

/**
 * Adds a checked import to the open document as the Import dialog would: into a part, as a component in a design,
 * or as a new part when nothing suitable is open. `provenance` is kept as a comment above the import.
 */
export async function addImport(record: StepImport, provenance: string | null = null, naming: Naming | null = null) {
  const { doc } = get();
  const choice: ImportChoice = doc.open && doc.kind === 'part' ? 'insert' : doc.open && doc.kind === 'design' ? 'components' : 'new';
  useImport.setState({ ...idle, phase: 'ready', record, choice, provenance, naming });
  await confirmImport();
}

/** A new tab with the checked part code: generating it reuses the check's build. */
function newPart(record: StepImport) {
  const naming = useImport.getState().naming;
  openTab({ kind: 'part', name: naming?.name ?? record.name });
  patchDoc({ code: annotate(naming ? partCode(call('model', 'import_step', [naming.id, record.sha256], { name: naming.name })) : record.part_code, record.sha256) });
  saveDraft();
  void updateModel();
  toast('success', `Imported ${record.filename}`, `${solidsText(record)} as a new part. Save to keep it.`);
}

async function insertIntoPart(record: StepImport) {
  let code = get().doc.code;
  let doc = await parseModel(code);
  if (!doc.canonical) { code = ensureModel(code, doc); doc = await parseModel(code); }
  const naming = useImport.getState().naming;
  const taken = new Set((doc.features ?? []).map((feature) => feature.id));
  const id = naming && !taken.has(naming.id) ? naming.id : nextId(doc, naming?.id ?? 'import');
  setCode(annotate(insertFeature(code, doc, call('model', 'import_step', [id, record.sha256], { name: naming?.name ?? record.name })), record.sha256));
  set({ activeFeature: id });
  await updateModel();
  // Step two: place it. Move opens on the imported bodies, with its gizmo on the canvas.
  const feature = modelingOf(get().displayed)?.features.find((f) => f.id === id);
  const bodies = ((feature?.detail as { bodies?: string[] } | undefined)?.bodies ?? []).filter(Boolean);
  if (feature?.status !== 'ok' || !bodies.length) { toast('warning', `Inserted ${record.filename}`, `${id} didn’t generate cleanly; check it in the timeline.`); return; }
  toast('success', `Inserted ${record.filename}`, `${solidsText(record)} added as ${id}. Drag the arrows to place ${bodies.length === 1 ? 'it' : 'them'}, then OK.`);
  set({ activeFeature: null });
  requestAnimationFrame(() => { void placeBodies(bodies); });
}

async function placeBodies(bodies: string[]) {
  await openFeature('move');
  if (!useFeatureDialog.getState().open || useFeatureDialog.getState().kind !== 'move') return;
  useFeatureDialog.setState({ target: null });
  setValue('bodies', `[${bodies.map((body) => JSON.stringify(body)).join(', ')}]`);
}

const partCode = (statement: string) => `import cadquery as cq\nfrom steve import Model\n\nmodel = Model()\n\n${statement}\n\nresult = model.result()\n`;

/** Designs: a part document per solid, each linked and placed where the file has it. */
async function partPerSolid(record: StepImport) {
  let { files, links } = { files: filesOf(get().doc), links: get().doc.links };
  for (let k = 1; k <= (record.solids ?? 0); k++) {
    const name = record.solids === 1 ? record.name : record.solid_names[k - 1] || `${record.name} ${k}`;
    const statement = call('model', 'import_step', ['import_1', record.sha256], { name, ...(record.solids === 1 ? {} : { solids: [k] as Py[] }) });
    const saved = await Api.createDocument({ name, kind: 'part', code: partCode(statement), preview_build_id: null });
    ({ files, links } = withLink(files, links, saved.id, name, saved.revision, [0, 0, 0]));
  }
  const { doc } = get();
  patchDoc({ files, links, code: files[doc.activeFile] ?? doc.code });
  saveDraft();
  void updateModel();
  const count = record.solids ?? 0;
  toast('success', `Imported ${record.filename}`, `${count} part document${count === 1 ? '' : 's'} linked into this design.`);
}

const RESERVED = new Set(['design', 'result', 'steve', 'params', 'components', 'links', 'cq', 'cadquery', 'model', 'main']);
const PYTHON = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'none', 'true', 'false']);

/** A component id for a solid's name: lowercase words joined by underscores, unique in the design (and apart from link aliases). */
function componentId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40) || 'component';
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED.has(id) || PYTHON.has(id); n++) id = `${base}_${n}`;
  return id;
}

/**
 * Designs: a component file per solid (`components/<id>.py` importing just that solid), placed in main.py. The solids
 * keep the file's coordinates and each is added at the design origin, as the linked-part import does: geometry and
 * placement can't drift apart, and importing the file again reproduces the same positions.
 */
async function componentPerSolid(record: StepImport) {
  const { doc } = get();
  let files = filesOf(doc);
  const taken = new Set([...Object.keys(files).filter((path) => path.startsWith('components/')).map(fileLabel), ...Object.keys(doc.links)]);
  const count = record.solids ?? 0;
  const added: string[] = [];
  const naming = useImport.getState().naming;
  for (let k = 1; k <= count; k++) {
    const name = count === 1 ? naming?.name ?? record.name : record.solid_names[k - 1] || `${naming?.name ?? record.name} ${k}`;
    const id = componentId(count === 1 && naming ? naming.id : name, taken);
    taken.add(id);
    files = withComponent(files, id, name);
    const statement = call(id, 'import_step', ['import_1', record.sha256], { name, ...(count === 1 ? {} : { solids: [k] as Py[] }) });
    files = { ...files, [componentPath(id)]: annotate(`${files[componentPath(id)]}${statement}\n`, record.sha256) };
    added.push(name);
  }
  patchDoc({ files, code: files[doc.activeFile] ?? doc.code });
  saveDraft();
  void updateModel();
  toast('success', `Imported ${record.filename}`, count === 1 ? `${added[0]} added as a component of this design.`
    : `${count} components added to this design, one file each, where the file places them.`);
}

/* ───────── Dropping a STEP or Fusion file anywhere on the app ───────── */

const hasFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
/** While dragging only MIME types are known: images belong to STEVE's message box, anything else may be an import. */
const mayBeStep = (event: DragEvent) => hasFiles(event)
  && Array.from(event.dataTransfer!.items).some((item) => item.kind === 'file' && !item.type.startsWith('image/'));

/** Window listeners for drag and drop; `onOver` shows or hides the drop target. Returns the uninstaller. */
export function installStepDrop(onOver: (over: boolean) => void) {
  let depth = 0;
  const enter = (event: DragEvent) => { if (mayBeStep(event)) { depth++; onOver(true); } };
  const leave = (event: DragEvent) => { if (mayBeStep(event) && --depth <= 0) { depth = 0; onOver(false); } };
  const over = (event: DragEvent) => { if (mayBeStep(event)) { event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; } };
  const drop = (event: DragEvent) => {
    depth = 0;
    onOver(false);
    if (!hasFiles(event)) return;
    const files = Array.from(event.dataTransfer!.files);
    // A McMaster-Carr download (its name leads with a part number, or the ZIP it came in) goes to the McMaster flow.
    // While the McMaster dialog is open, any STEP or ZIP dropped belongs to it.
    const vendor = files.find((file) => isMcmasterFile(file) || (get().dialog === 'mcmaster' && MCMASTER_SUFFIXES.test(file.name)));
    if (vendor) {
      event.preventDefault();
      event.stopPropagation();
      receiveMcmasterFile(vendor);
      return;
    }
    const step = files.find((file) => isImportName(file.name));
    if (step) {
      event.preventDefault();
      event.stopPropagation();  // Captured before the message box, which only takes images.
      startImport(step);
    } else if (files.some((file) => !file.type.startsWith('image/'))) {
      event.preventDefault();
      toast('warning', 'Only STEP and Fusion files can be imported', 'Drop a .step, .stp or .f3d file. Images go to STEVE’s message box.');
    }
  };
  window.addEventListener('dragenter', enter, true);
  window.addEventListener('dragleave', leave, true);
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop, true);
  return () => {
    window.removeEventListener('dragenter', enter, true);
    window.removeEventListener('dragleave', leave, true);
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop, true);
  };
}
