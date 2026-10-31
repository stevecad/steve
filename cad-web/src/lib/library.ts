import { Api, isDocumentKind, type CadDocument, type DocumentSummary, type FileKind, type FileSummary, type Folder } from './api';

/** The person's saved designs, as the Open dialog and command palette list them. */

export type KindFilter = 'all' | string;
export type SortKey = 'modified' | 'name' | 'created';

const PAGE = 100;
const LIMIT = 2000;

const KIND_LABELS: Record<string, [string, string]> = {
  part: ['Part', 'Parts'], design: ['Design', 'Designs'], circuit: ['Circuit', 'Circuits'], blender: ['Blender scene', 'Blender scenes'], shop: ['Shop', 'Shops'],
  study: ['Simulation', 'Simulations'], program: ['CAM program', 'CAM programs'],
};
const titled = (kind: string) => kind.replace(/^./, (c) => c.toUpperCase());
export const kindLabel = (kind: string, plural = false) => KIND_LABELS[kind]?.[plural ? 1 : 0] ?? `${titled(kind)}${plural ? 's' : ''}`;
/** Filter order: parts and designs always, then the other kinds in their usual order when the list has them (or
 * `also`, the open workspace's own kind, so its filter is there even before anything of it exists). */
const ORDER: FileKind[] = ['part', 'design', 'circuit', 'blender', 'shop', 'study', 'program'];
export const kindsIn = (documents: { kind: string }[], also?: string | null) => {
  const present = new Set<string>(['part', 'design', ...documents.map((doc) => doc.kind), ...(also ? [also] : [])]);
  return [...ORDER.filter((kind) => present.has(kind)), ...[...present].filter((kind) => !ORDER.includes(kind as FileKind))];
};

/** Shops and CAM programs are kept as documents but worked in Manufacture (its Shop page, and a part's programs): no
 *  list of files shows them. */
export const listed = (kind: string) => kind !== 'shop' && kind !== 'cam';

/** Every saved design, most recently edited first. onPage sees the list grow page by page. */
export async function loadDocuments(onPage?: (documents: DocumentSummary[]) => void): Promise<DocumentSummary[]> {
  const byId = new Map<string, DocumentSummary>();
  for (let offset = 0; offset < LIMIT; offset += PAGE) {
    const { documents } = await Api.documents({ limit: PAGE, offset });
    // An edit during paging moves a design to the front; ids keep it listed once.
    for (const doc of documents) if (!byId.has(doc.id) && listed(doc.kind)) byId.set(doc.id, doc);
    onPage?.([...byId.values()]);
    if (documents.length < PAGE) break;
  }
  return [...byId.values()];
}

/** Everything the Open dialog lists: documents, simulation studies and CAM programs (GET /v1/files). */
export async function loadFiles(onPage?: (files: FileSummary[]) => void): Promise<FileSummary[]> {
  const byId = new Map<string, FileSummary>();
  for (let offset = 0; offset < LIMIT; offset += PAGE) {
    const { files } = await Api.files({ limit: PAGE, offset });
    for (const file of files) if (!byId.has(file.id) && listed(file.kind)) byId.set(file.id, file);
    onPage?.([...byId.values()]);
    if (files.length < PAGE) break;
  }
  return [...byId.values()];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Every word of the query must appear in the name; the chosen order is kept. */
export function arrange<T extends { name: string; kind: string; updated_at: string; created_at: string }>(documents: T[], query: string, kind: KindFilter, sort: SortKey): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = documents.filter((doc) => (kind === 'all' || doc.kind === kind) && words.every((word) => doc.name.toLowerCase().includes(word)));
  const time = (value: string) => new Date(value).getTime();
  return matches.sort(sort === 'name' ? (a, b) => collator.compare(a.name, b.name) || time(b.updated_at) - time(a.updated_at)
    : sort === 'created' ? (a, b) => time(b.created_at) - time(a.created_at)
      : (a, b) => time(b.updated_at) - time(a.updated_at));
}

/** Every word of the query appears in the name. */
export const matches = (name: string, query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean).every((word) => name.toLowerCase().includes(word));

/**
 * The file list as Open shows it: parts, designs and circuits at the top level, each with the simulations and CAM
 * programs that belong to it (a program under every part or design it machines), most recently changed first.
 * Studies and programs whose part or design isn't listed (deleted, in the Trash) are `orphans`, never dropped.
 */
export interface Nested { tops: FileSummary[]; children: Map<string, FileSummary[]>; orphans: FileSummary[] }
export function nest(files: FileSummary[]): Nested {
  const tops = files.filter((file) => isDocumentKind(file.kind));
  const listed = new Set(tops.map((top) => top.id));
  const children = new Map<string, FileSummary[]>();
  const orphans: FileSummary[] = [];
  for (const file of files) {
    if (isDocumentKind(file.kind)) continue;
    const parents = [...new Set(file.design_ids ?? (file.design ? [file.design.id] : []))].filter((id) => listed.has(id));
    if (!parents.length) orphans.push(file);
    for (const id of parents) { const list = children.get(id); if (list) list.push(file); else children.set(id, [file]); }
  }
  const recent = (a: FileSummary, b: FileSummary) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  for (const list of children.values()) list.sort(recent);
  return { tops, children, orphans };
}

/** "3 simulations · 1 CAM program": what belongs to a part or design. */
export const childSummary = (children: FileSummary[] | undefined) => {
  const studies = children?.filter((child) => child.kind === 'study').length ?? 0;
  const programs = children?.filter((child) => child.kind === 'program').length ?? 0;
  const label = (n: number, kind: string) => `${n} ${kindLabel(kind, n !== 1).toLowerCase().replace('cam', 'CAM')}`;
  return [studies && label(studies, 'study'), programs && label(programs, 'program')].filter(Boolean).join(' · ');
};

export const summary = ({ code: _code, files: _files, link_status: _status, ...doc }: CadDocument): DocumentSummary => doc;

/** Renames main by saving its current content under the new name (one new version, "Renamed to …"). */
export async function renameDocument(id: string, name: string): Promise<CadDocument> {
  const doc = await Api.document(id);
  return Api.updateDocument(id, { name, kind: doc.kind, code: doc.code, files: doc.files ?? {}, links: doc.links ?? {}, preview_build_id: doc.preview_build_id, revision: doc.revision });
}

/** A new, independent design from main's latest version, in the same folder. It shares the geometry, so its thumbnail is instant. */
export async function duplicateDocument(id: string, folderId: string | null = null): Promise<CadDocument> {
  const doc = await Api.document(id);
  return Api.createDocument({ name: `${doc.name} copy`.slice(0, 100), kind: doc.kind, code: doc.code, files: doc.files ?? {}, links: doc.links ?? {}, preview_build_id: doc.preview_build_id, folder_id: folderId });
}

/* ───────── Folders ───────── */

/** Each folder's subfolders by name (null: the top level). */
export function folderChildren(folders: Folder[]): Map<string | null, Folder[]> {
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parent_id);
    if (list) list.push(folder); else children.set(folder.parent_id, [folder]);
  }
  for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  return children;
}

/** The folders from the top level down to `id` (empty for the top level, or a folder that isn't there). */
export function folderTrail(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: Folder[] = [];
  for (let folder = id ? byId.get(id) : undefined; folder && trail.length <= folders.length; folder = folder.parent_id ? byId.get(folder.parent_id) : undefined) trail.unshift(folder);
  return trail;
}

/** "Fixtures/Brackets", as the server reports it; null at the top level. */
export const folderPath = (folders: Folder[], id: string | null) => folderTrail(folders, id).map((folder) => folder.name).join('/') || null;

/** Whether `id` is `ancestor` or inside it (a folder can't move there). */
export const within = (folders: Folder[], id: string | null, ancestor: string) => folderTrail(folders, id).some((folder) => folder.id === ancestor);
