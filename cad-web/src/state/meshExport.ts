/**
 * 3MF and STL export, for the person's own slicer. Full builds carry a print-grade binary STL per body as modelled
 * (runtime/run.py, bodies-mesh.zip, the same tessellation the FFF pipeline slices); GET /v1/builds/{id}/body-mesh/{i}
 * serves one. The browser assembles the file:
 * - 3MF: millimetres, one named object per body, each build item carrying its instance's placement as modelled
 *   (identity for a part), the design's name as the title.
 * - STL: one binary mesh of every body in design coordinates (mm).
 * The whole model by default; with a selection, the selected components/instances or bodies. At the resolution the
 * Export menu remembers (exportFormat.ts): fine is the print-grade mesh; medium and coarse are smaller files for large
 * curved models, made on demand like it (?resolution=…).
 */
import { bodyMeshes, NETWORK_ERROR, type BodyMesh, type MeshResolution } from '@/lib/api';
import { pretty } from '@/lib/format';
import { surfaceNote } from '@/lib/modeling';
import { zip } from '@/lib/zip';
import { bodiesOfPick, designOf } from '@/modeling/bodies';
import { viewer } from '@/viewport/viewer';
import { ensurePrintMeshes, exportStatus } from './actions';
import { selectionTarget } from './componentStep';
import { MESH_RESOLUTIONS, useMeshResolution } from './exportFormat';
import { dismissToast, get, toast, type AppState, type Pick } from './store';

export type MeshFormat = '3mf' | 'stl';

/** What an export covers: `selection` names the selection (null: the whole model); `name` names the file. */
export interface MeshScope { selection: string | null; name: string; match: (item: BodyRef) => boolean }
/** What a scope matches by: an instance ("part" for a part) and a body id (a mesh's, or a surface body's). */
type BodyRef = { instance: string; body: string };

export const inInstance = (item: BodyRef, instance: string) => item.instance === instance || item.instance.startsWith(`${instance}/`);

/** The body a pick in a design shows, by the face ranges of its component's bodies (faces restart per instance). */
function designBody(component: string, pick: Pick): string | null {
  const model = viewer.model;
  if (!model || pick.kind === 'component') return null;
  const topology = model.topologyFor(pick.mesh);
  const face = pick.kind === 'face' ? pick.index
    : pick.kind === 'edge' ? topology?.edges[pick.index]?.faces?.[0]
      : topology?.edges.find((edge) => edge.vertices?.includes(pick.index))?.faces?.[0];
  if (face === undefined) return null;
  const bodies = Object.entries(designOf(model.build)?.components[component]?.bodies ?? {}).sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0));
  let start = 0;
  for (const [id, body] of bodies) {
    if (face >= start && face < start + body.faces) return id;
    start += body.faces;
  }
  return null;
}

/** What an export covers now; `components` widens a design selection to its whole components/instances. */
export function meshScope(state: AppState = get(), components = false): MeshScope {
  const name = state.doc.name || state.displayed?.name || 'model';
  const everything: MeshScope = { selection: null, name, match: () => true };
  const model = viewer.model;
  if (!state.selection.length || !model) return everything;
  if (state.doc.kind !== 'design') {
    const bodies = new Set(state.selection.flatMap((pick) => bodiesOfPick(pick, model)));
    if (!bodies.size) return everything;
    return { selection: bodies.size === 1 ? 'the selected body' : `${bodies.size} selected bodies`, name, match: (item) => bodies.has(item.body) };
  }
  // A component pick, a linked document or an unknown body takes the whole instance; a face, edge or vertex its body.
  const wanted: { instance: string; body: string | null }[] = [];
  for (const pick of state.selection) {
    const instance = model.instanceOf(pick.node);
    if (!instance) return everything;
    wanted.push({ instance: instance.name, body: components || pick.kind === 'component' || instance.link ? null : designBody(instance.component, pick) });
  }
  const target = selectionTarget(state);
  const whole = wanted.every((item) => item.body === null);
  const instances = new Set(wanted.map((item) => item.instance));
  return {
    selection: whole ? target?.name ?? `${instances.size} instances` : 'the selected bodies',
    name: target?.name ?? name,
    match: (item) => wanted.some((want) => inInstance(item, want.instance) && (want.body === null || want.body === item.body)),
  };
}

// ── Meshes ────────────────────────────────────────────────────────────────

export interface Mesh { item: BodyMesh; stl: DataView }

export const triangles = (stl: DataView) => (stl.byteLength >= 84 ? Math.min(stl.getUint32(80, true), Math.floor((stl.byteLength - 84) / 50)) : 0);

// Exports fetch one mesh per body: a few at a time (as the simulation results worker does), so a many-body design
// doesn't burst past the server's request rate limit; a 429/503 waits (Retry-After, else backoff) and tries again.
const MESH_FETCHES = 4;
let meshFetches = 0;
const meshQueue: (() => void)[] = [];

async function meshResponse(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    // No answer at all (the connection dropped): wait and ask again too, then say so plainly, not "Failed to fetch".
    try { response = await fetch(url); } catch {
      if (attempt >= 5) throw new Error(NETWORK_ERROR);
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(5, 2 ** attempt)));
      continue;
    }
    if (![429, 503].includes(response.status) || attempt >= 5) return response;
    const requested = Number(response.headers.get('Retry-After')) || 2 ** attempt;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(5, Math.max(.25, requested))));
  }
}

export async function fetchMesh(build: string, index: number, resolution: MeshResolution = 'fine'): Promise<DataView> {
  // A finished fetch hands its slot straight to the next in line (the count stays), so the cap always holds.
  if (meshFetches >= MESH_FETCHES) await new Promise<void>((resolve) => meshQueue.push(resolve));
  else meshFetches++;
  try {
    const response = await meshResponse(`/v1/builds/${build}/body-mesh/${index}${resolution === 'fine' ? '' : `?resolution=${resolution}`}`);
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { detail?: string | { message?: string } };
        detail = (typeof body.detail === 'string' ? body.detail : body.detail?.message) ?? '';
      } catch { /* not JSON */ }
      throw new Error(detail || ([429, 503].includes(response.status)
        ? 'The server is busy; try the export again in a moment.'
        : `Mesh request failed (${response.status}).`));
    }
    return new DataView(await response.arrayBuffer());
  } finally {
    const next = meshQueue.shift();
    if (next) next();
    else meshFetches--;
  }
}

/** Every entry's mesh, counting them in the status bar ("Downloading STL · 3 of 12 bodies") while they arrive. */
export async function fetchMeshes(build: string, entries: { item: BodyMesh; index: number }[], label: string, resolution: MeshResolution = 'fine'): Promise<Mesh[]> {
  let done = 0;
  const progress = () => exportStatus(`Downloading ${label} · ${done} of ${entries.length} ${entries.length === 1 ? 'body' : 'bodies'}`);
  progress();
  return Promise.all(entries.map(async ({ item, index }) => {
    const stl = await fetchMesh(build, index, resolution);
    done++;
    progress();
    return { item, stl };
  }));
}

/** Hands a file to the browser's downloads: the link in the page while it's clicked, its blob kept long enough to save. */
export function saveBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

export const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fixed = (value: number) => {
  const text = value.toFixed(5).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
};

export type Matrix = number[][]; // [R|t], 3 rows of 4
export const IDENTITY: Matrix = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
const isIdentity = (m: Matrix) => m.every((row, r) => row.every((value, c) => Math.abs(value - IDENTITY[r][c]) < 1e-12));

/** The inverse of [R|t] (a general 3×3 inverse: placements are rigid, but nothing here relies on it). */
export function invert(m: Matrix): Matrix | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const r = [
    [A, -(b * i - c * h), b * f - c * e],
    [B, a * i - c * g, -(a * f - c * d)],
    [C, -(a * h - b * g), a * e - b * d],
  ].map((row) => row.map((value) => value / det));
  const t = [m[0][3], m[1][3], m[2][3]];
  return r.map((row) => [...row, -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2])]);
}

/** 3MF's transform attribute: "m00 m01 m02 m10 … m32", row vectors (x' = x·M), so the rotation transposed, then t. */
export const transform3mf = (m: Matrix) => [0, 1, 2].flatMap((c) => [m[0][c], m[1][c], m[2][c]]).concat([m[0][3], m[1][3], m[2][3]]).map(fixed).join(' ');

/** One 3MF <object>: the body's mesh moved by `toLocal` (its instance's frame), vertices shared, degenerate triangles left out. */
export function objectXml(id: number, name: string, stl: DataView, toLocal: Matrix | null): string {
  const index = new Map<string, number>();
  const vertices: string[] = [];
  const faces: string[] = [];
  const count = triangles(stl);
  for (let t = 0; t < count; t++) {
    const corner: number[] = [];
    for (let k = 0; k < 3; k++) {
      const at = 84 + 50 * t + 12 + 12 * k;
      const key = `${stl.getUint32(at, true)},${stl.getUint32(at + 4, true)},${stl.getUint32(at + 8, true)}`;
      let vertex = index.get(key);
      if (vertex === undefined) {
        let p = [stl.getFloat32(at, true), stl.getFloat32(at + 4, true), stl.getFloat32(at + 8, true)];
        if (toLocal) p = toLocal.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
        vertex = vertices.length;
        index.set(key, vertex);
        vertices.push(`<vertex x="${fixed(p[0])}" y="${fixed(p[1])}" z="${fixed(p[2])}"/>`);
      }
      corner.push(vertex);
    }
    if (corner[0] !== corner[1] && corner[1] !== corner[2] && corner[0] !== corner[2]) faces.push(`<triangle v1="${corner[0]}" v2="${corner[1]}" v3="${corner[2]}"/>`);
  }
  return `<object id="${id}" type="model" name="${escape(name)}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`;
}

/** Object names: the body's name in a part (the document's when it has one body); in a design, its instance's. */
function objectNames(meshes: Mesh[], document: string): string[] {
  const perInstance = new Map<string, number>();
  for (const { item } of meshes) perInstance.set(item.instance, (perInstance.get(item.instance) ?? 0) + 1);
  return meshes.map(({ item }) => {
    if (item.instance === 'part') return meshes.length === 1 ? document : item.name;
    const instance = item.instance.split('/').map(pretty).join(' / ');
    return perInstance.get(item.instance)! > 1 ? `${instance} · ${item.name}` : instance;
  });
}

async function threeMf(meshes: Mesh[], title: string): Promise<Blob> {
  const names = objectNames(meshes, title);
  const objects: string[] = [];
  const items: string[] = [];
  meshes.forEach(({ item, stl }, index) => {
    const placement = item.placement?.length === 3 ? item.placement : IDENTITY;
    const local = isIdentity(placement) ? null : invert(placement);
    objects.push(objectXml(index + 1, names[index], stl, local));
    items.push(local ? `<item objectid="${index + 1}" transform="${transform3mf(placement)}"/>` : `<item objectid="${index + 1}"/>`);
  });
  return package3mf(title, objects, items);
}

/** A 3MF package of <object>s and build <item>s, in millimetres; `description` is its Description metadata. */
export function package3mf(title: string, objects: string[], items: string[], description?: string): Promise<Blob> {
  const model = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
    + `<metadata name="Title">${escape(title)}</metadata>\n<metadata name="Application">STEVE</metadata>\n`
    + (description ? `<metadata name="Description">${escape(description)}</metadata>\n` : '')
    + `<resources>\n${objects.join('\n')}\n</resources>\n<build>\n${items.join('\n')}\n</build>\n</model>\n`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n'],
    ['3D/3dmodel.model', model],
  ]);
}

/** One binary STL of every mesh (they are already in design coordinates). */
function mergedStl(meshes: Mesh[], title: string): Blob {
  const count = meshes.reduce((sum, { stl }) => sum + triangles(stl), 0);
  const head = new Uint8Array(84);
  head.set(new TextEncoder().encode(`STEVE ${title} (mm)`.slice(0, 80)));
  new DataView(head.buffer).setUint32(80, count, true);
  const records = meshes.map(({ stl }) => new Uint8Array(stl.buffer, stl.byteOffset + 84, 50 * triangles(stl)));
  return new Blob([head, ...records] as BlobPart[], { type: 'model/stl' });
}

// ── Export ────────────────────────────────────────────────────────────────

const megabytes = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`);
const fileName = (name: string, format: MeshFormat) => `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'model'}.${format}`;
let running = false;

export async function exportMesh(format: MeshFormat, components = false) {
  const label = format === '3mf' ? '3MF' : 'STL';
  if (running) {
    toast('info', 'An export is already running', 'Its file downloads when it’s ready; the status bar shows how far it is.');
    return;
  }
  const scope = meshScope(get(), components);
  const { resolution } = useMeshResolution.getState();
  running = true;
  // Said at once: preparing and downloading the meshes of a big model can take a while.
  const preparing = toast('info', `Preparing ${label}`, 'Choose where to save when the export is ready.');
  let downloading = false;
  try {
    const build = await ensurePrintMeshes(label, false, resolution);
    if (!build) return;
    const entries = (bodyMeshes(build, resolution) ?? []).map((item, index) => ({ item, index })).filter(({ item }) => scope.match(item));
    // Surface bodies in what's exported have no mesh to print (the runtime leaves them out): said, never dropped silently.
    const surfaces = (build.metadata?.surface_bodies?.bodies ?? []).filter((item) => scope.match(item)).length;
    const left = surfaces ? ` ${surfaceNote({ count: surfaces })}` : '';
    if (!entries.length) {
      toast('warning', `Nothing to export as ${label}`, (scope.selection ? 'The selection has no solid bodies. Clear it to export the whole model.' : 'The model has no solid bodies.') + left);
      return;
    }
    downloading = true;
    const meshes = await fetchMeshes(build.id, entries, label, resolution);
    const title = get().doc.name || build.name;
    const blob = format === '3mf' ? await threeMf(meshes, title) : mergedStl(meshes, scope.name);
    const file = fileName(scope.name, format);
    saveBlob(blob, file);
    exportStatus(null);
    downloading = false;
    const what = scope.selection ?? 'the whole model';
    const bodies = `${meshes.length} ${meshes.length === 1 ? 'body' : 'bodies'}`;
    // The resolution and size, so the trade-off is visible (Export menu → Mesh resolution changes it).
    const count = meshes.reduce((sum, { stl }) => sum + triangles(stl), 0);
    const detail = `${MESH_RESOLUTIONS[resolution].label} mesh, ${count.toLocaleString()} triangles, ${megabytes(blob.size)}.`;
    toast(surfaces ? 'warning' : 'success', `Exported ${file}`, `${format === '3mf'
      ? `${what[0].toUpperCase()}${what.slice(1)}: ${bodies} in millimetres, placed as modelled. Open it in your slicer.`
      : `${what[0].toUpperCase()}${what.slice(1)}: ${bodies} as one binary STL in millimetres.`}${left} ${detail}`);
  } catch (error) {
    if (downloading) exportStatus(null, true);
    downloading = false;
    toast('danger', `Couldn’t export ${label}`, (error as Error).message);
  } finally {
    dismissToast(preparing);
    if (downloading) exportStatus(null);
    running = false;
  }
}
