/**
 * File → Export → Print set: every instance a design marks as 3D printed (`design.add(..., print={...})`,
 * runtime/steve/design.py) as print-ready files in one zip. Built in the browser, like the 3MF export, from the full
 * build's print meshes (bodies-mesh.zip) and the design's bill of materials.
 *
 * - One file per bill-of-materials row of printed instances: the same component (or link with the same overrides) and
 *   the same print settings share a file, with a quantity.
 * - Each part is brought back to its own frame, turned so its `build_direction` points up (+Z), centred on the origin
 *   in X and Y and set on Z = 0. 3MF (millimetres, a named object per body) or binary STL.
 * - Each file's mesh is checked as written: closed, consistently wound, positive volume.
 * - Plates (plates/plate_<n>): every copy the quantities ask for, laid out on the bed chosen in the Export menu (Print
 *   bed), one process and material per plate, so a plate opens in a slicer ready to print. One standard 3MF per plate
 *   (core 3MF has one build per file; multi-plate files are slicer-specific), each part an object once and each copy a
 *   build item. A part bigger than the bed gets a plate of its own, flagged.
 * - manifest.json ties every file to the document, revision and build (SHA-256, transform applied, size, volume,
 *   estimated mass); PRINT_LIST.md is the same as a table. Same build, same files, byte for byte.
 */
import { bodyMeshes, type BodyMesh, type MeshResolution } from '@/lib/api';
import { pretty } from '@/lib/format';
import { zip } from '@/lib/zip';
import { ensurePrintMeshes, exportStatus } from './actions';
import { MESH_RESOLUTIONS, PRINT_BEDS, useMeshResolution, usePrintBed } from './exportFormat';
import { escape, fetchMeshes, IDENTITY, inInstance, invert, meshScope, objectXml, package3mf, saveBlob, transform3mf, triangles, type Matrix, type MeshFormat } from './meshExport';
import { dismissToast, get, hasSourceEdits, toast } from './store';

export interface PrintSettings { process: string; build_direction: string; material?: string; group?: string; notes?: string; density_g_cm3?: number }
export interface PrintRow { item: string; name: string; link: boolean; parameters?: Record<string, unknown>; quantity: number; print?: PrintSettings; instances?: string[] }
export interface PrintInstance { name: string; placement?: number[][] }
export interface PrintSource { document_id: string | null; revision: number | null; branch: string | null; build_id: string; unsaved_edits: boolean }

/** Turns the part's own `build_direction` onto +Z (proper rotations). */
const UP: Record<string, Matrix> = {
  '+Z': IDENTITY,
  '-Z': [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0]],
  '+X': [[0, 0, -1, 0], [0, 1, 0, 0], [1, 0, 0, 0]],
  '-X': [[0, 0, 1, 0], [0, 1, 0, 0], [-1, 0, 0, 0]],
  '+Y': [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0]],
  '-Y': [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0]],
};

/** a ∘ b: b first, then a. */
const compose = (a: Matrix, b: Matrix): Matrix => a.map((row) => [0, 1, 2, 3].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c] + (c === 3 ? row[3] : 0)));
const apply = (m: Matrix, p: number[]) => m.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
const num = (value: number, digits = 6) => { const v = Number(value.toFixed(digits)); return v === 0 ? 0 : v; };
const safe = (text: string) => text.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';

const vertexAt = (t: number, k: number) => 84 + 50 * t + 12 + 12 * k;
const keyAt = (stl: DataView, at: number) => `${stl.getUint32(at, true)},${stl.getUint32(at + 4, true)},${stl.getUint32(at + 8, true)}`;
const pointAt = (stl: DataView, at: number) => [stl.getFloat32(at, true), stl.getFloat32(at + 4, true), stl.getFloat32(at + 8, true)];

export interface MeshCheck { triangles: number; closed: boolean; consistent_winding: boolean; volume_mm3: number }

/** One body's mesh as the files write it (vertices welded, degenerate triangles left out): every edge shared by exactly
 *  two triangles, in opposite directions, and the volume it encloses (positive: outward normals). */
export function checkMesh(stl: DataView): MeshCheck {
  const index = new Map<string, number>();
  const edges = new Map<string, number>();
  let count = 0, volume = 0;
  for (let t = 0; t < triangles(stl); t++) {
    const corner = [0, 1, 2].map((k) => {
      const key = keyAt(stl, vertexAt(t, k));
      let vertex = index.get(key);
      if (vertex === undefined) { vertex = index.size; index.set(key, vertex); }
      return vertex;
    });
    if (corner[0] === corner[1] || corner[1] === corner[2] || corner[0] === corner[2]) continue;
    count++;
    for (let k = 0; k < 3; k++) { const edge = `${corner[k]}>${corner[(k + 1) % 3]}`; edges.set(edge, (edges.get(edge) ?? 0) + 1); }
    const [a, b, c] = [0, 1, 2].map((k) => pointAt(stl, vertexAt(t, k)));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  let closed = count > 0, consistent = count > 0;
  for (const [edge, uses] of edges) {
    const [from, to] = edge.split('>');
    const back = edges.get(`${to}>${from}`) ?? 0;
    if (uses + back !== 2) closed = false;
    if (uses !== 1 || back !== 1) consistent = false;
  }
  return { triangles: count, closed, consistent_winding: consistent, volume_mm3: volume };
}

/** One binary STL of meshes each moved by its `m`, normals from the moved triangles, degenerate triangles left out. */
function orientedStl(meshes: { stl: DataView; m: Matrix }[], title: string): Uint8Array {
  const records: number[][] = [];
  for (const { stl, m } of meshes) {
    for (let t = 0; t < triangles(stl); t++) {
      const keys = [0, 1, 2].map((k) => keyAt(stl, vertexAt(t, k)));
      if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
      const [a, b, c] = [0, 1, 2].map((k) => apply(m, pointAt(stl, vertexAt(t, k))));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(n[0], n[1], n[2]) || 1;
      records.push([...n.map((x) => x / length), ...a, ...b, ...c]);
    }
  }
  const out = new Uint8Array(84 + 50 * records.length);
  out.set(new TextEncoder().encode(`STEVE ${title} (mm)`).slice(0, 80));
  const view = new DataView(out.buffer);
  view.setUint32(80, records.length, true);
  records.forEach((record, t) => record.forEach((value, k) => view.setFloat32(84 + 50 * t + 4 * k, value, true)));
  return out;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ── Plates ────────────────────────────────────────────────────────────────

/** Plates keep parts EDGE mm in from the bed's edges and GAP mm apart (their bounding boxes). */
const EDGE = 3, GAP = 5;

/** One copy on a plate: the part (its index), the centre of its footprint on the bed, and whether it's turned 90° about Z. */
export interface PlateCopy { part: number; x: number; y: number; turned: boolean }
export interface PlateLayout { process: string; material: string | null; copies: PlateCopy[]; fits: boolean }

/**
 * Lays `quantity` copies of every part on beds `bed` mm (width × depth), corner at the origin: one process and material
 * per plate, footprints (bounding boxes, each the way round that's shallowest) on shelves, deepest first, each copy on
 * the first plate and shelf with room, the whole layout centred on the bed. A part too big for the bed either way round
 * gets a plate of its own, flagged (`fits: false`), never left out. Same parts, same plates.
 */
export function layPlates(parts: { size_mm: number[]; quantity: number; process: string; material: string | null }[], bed: [number, number]): PlateLayout[] {
  const [W, D] = [bed[0] - 2 * EDGE, bed[1] - 2 * EDGE];
  const groups = new Map<string, number[]>();
  parts.forEach((part, index) => {
    const key = `${part.process}\n${part.material ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const plates: PlateLayout[] = [];
  for (const members of groups.values()) {
    const { process, material } = parts[members[0]];
    type Copy = { part: number; w: number; d: number; turned: boolean };
    const copies: Copy[] = [], oversize: number[] = [];
    for (const index of members) {
      const [sx, sy] = parts[index].size_mm;
      const ways = [{ w: sx, d: sy, turned: false }, { w: sy, d: sx, turned: true }].filter((way) => way.w <= W && way.d <= D);
      if (!ways.length) { for (let q = 0; q < parts[index].quantity; q++) oversize.push(index); continue; }
      const way = ways.reduce((best, next) => (next.d < best.d ? next : best));
      for (let q = 0; q < parts[index].quantity; q++) copies.push({ part: index, ...way });
    }
    copies.sort((a, b) => b.d - a.d || b.w - a.w || a.part - b.part);
    type Slot = Copy & { x: number; y: number };
    const beds: { shelves: { y: number; depth: number; x: number }[]; top: number; slots: Slot[] }[] = [];
    for (const copy of copies) {
      let placed = false;
      for (const plate of beds) {
        const shelf = plate.shelves.find((s) => s.x + copy.w <= W && copy.d <= s.depth);
        if (shelf) { plate.slots.push({ ...copy, x: shelf.x, y: shelf.y }); shelf.x += copy.w + GAP; placed = true; break; }
      }
      if (placed) continue;
      let plate = beds.find((p) => p.top + copy.d <= D);
      if (!plate) beds.push(plate = { shelves: [], top: 0, slots: [] });
      plate.shelves.push({ y: plate.top, depth: copy.d, x: copy.w + GAP });
      plate.slots.push({ ...copy, x: 0, y: plate.top });
      plate.top += copy.d + GAP;
    }
    for (const plate of beds) {
      const wide = Math.max(...plate.shelves.map((s) => s.x - GAP)), deep = plate.top - GAP;
      const [ox, oy] = [(bed[0] - wide) / 2, (bed[1] - deep) / 2];
      plates.push({ process, material, fits: true,
        copies: plate.slots.map((slot) => ({ part: slot.part, x: num(ox + slot.x + slot.w / 2, 3), y: num(oy + slot.y + slot.d / 2, 3), turned: slot.turned })) });
    }
    for (const part of oversize) plates.push({ process, material, fits: false, copies: [{ part, x: bed[0] / 2, y: bed[1] / 2, turned: false }] });
  }
  return plates;
}

/** A copy's move from its part's file (centred on the origin, on Z = 0) onto the bed. */
const onBed = (copy: PlateCopy): Matrix => (copy.turned
  ? [[0, -1, 0, copy.x], [1, 0, 0, copy.y], [0, 0, 1, 0]]
  : [[1, 0, 0, copy.x], [0, 1, 0, copy.y], [0, 0, 1, 0]]);

export interface PrintPlate {
  file: string; process: string; material: string | null; bed_mm: number[];
  /** False: a part too big for the bed, on a plate of its own. */
  fits: boolean;
  parts: { file: string; name: string; copies: number }[];
  bytes: number; sha256: string;
}

export interface PrintPart {
  file: string; name: string; item: string; link: boolean; parameters?: Record<string, unknown>; instances: string[]; quantity: number;
  process: string; material: string | null; group: string | null; notes: string | null; build_direction: string;
  /** From the part's own frame (as modelled in its file) to the file's, [R|t] in mm. */
  transform: number[][];
  size_mm: number[]; volume_mm3: number; mass_g: number | null;
  checks: { closed: boolean; consistent_winding: boolean; positive_volume: boolean; triangles: number };
  bytes: number; sha256: string;
}

export interface PrintSetInput {
  name: string; format: MeshFormat; rows: PrintRow[]; instances: PrintInstance[]; bodies: { item: BodyMesh; stl: DataView }[]; source: PrintSource;
  /** The meshes' resolution (Export menu → Mesh resolution); fine, the print-grade mesh, when not given. */
  resolution?: MeshResolution;
  /** The print bed the plates are laid out on, width × depth in mm (Export menu → Print bed); 220 × 220 when not given. */
  bed?: [number, number];
}

/** The build's print meshes' deflection at a resolution (runtime/run.py MESH_RESOLUTIONS). */
const tessellation = (resolution: MeshResolution) => {
  const { linear_mm, angular_rad } = MESH_RESOLUTIONS[resolution];
  return resolution === 'fine' ? { linear_mm, angular_rad } : { resolution, linear_mm, angular_rad };
};

/** The files of a print set (one per printed row, the plates, manifest.json, PRINT_LIST.md), its parts and plates. */
export async function printSet(input: PrintSetInput): Promise<{ files: [string, Uint8Array | string][]; parts: PrintPart[]; plates: PrintPlate[]; missing: string[] }> {
  const placements = new Map(input.instances.map((instance) => [instance.name, instance.placement?.length === 3 ? instance.placement : IDENTITY]));
  const rows = input.rows.filter((row) => row.print && row.instances?.length);
  // File names: the component or link, and its first instance when two rows would share it. Stable across revisions.
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.item, (counts.get(row.item) ?? 0) + 1);
  const used = new Set<string>();
  const files: [string, Uint8Array | string][] = [];
  const parts: PrintPart[] = [];
  const meshes: { bodies: { item: BodyMesh; stl: DataView }[]; m: Matrix; named: string[] }[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const settings = row.print!, instances = row.instances!, first = instances[0];
    const bodies = input.bodies.filter(({ item }) => inInstance(item, first));
    if (!bodies.length) { missing.push(first); continue; }
    let base = safe(counts.get(row.item)! > 1 ? `${row.item}__${first}` : row.item);
    for (let n = 2; used.has(base); n++) base = safe(`${row.item}__${first}_${n}`);
    used.add(base);
    const file = `parts/${base}.${input.format}`;

    // Own frame, then build direction up, then centred in X and Y on Z = 0.
    const turned = compose(UP[settings.build_direction] ?? IDENTITY, invert(placements.get(first) ?? IDENTITY) ?? IDENTITY);
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const { stl } of bodies) {
      for (let t = 0; t < triangles(stl); t++) {
        for (let k = 0; k < 3; k++) {
          const p = apply(turned, pointAt(stl, vertexAt(t, k)));
          for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], p[a]); high[a] = Math.max(high[a], p[a]); }
        }
      }
    }
    const shift = [-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, -low[2]];
    const m = turned.map((r, a) => [r[0], r[1], r[2], r[3] + shift[a]]);

    const title = instances.length === 1 ? pretty(first) : row.name;
    const description = [`${row.quantity} × ${settings.process.toUpperCase()}`, settings.material, settings.notes].filter(Boolean).join(', ');
    const named = bodies.length === 1 ? [title] : bodies.map(({ item }) => `${title} · ${item.name}`);
    meshes.push({ bodies, m, named });
    let data: Uint8Array;
    if (input.format === '3mf') {
      const objects = bodies.map(({ stl }, i) => objectXml(i + 1, named[i], stl, m));
      data = new Uint8Array(await (await package3mf(title, objects, bodies.map((_, i) => `<item objectid="${i + 1}"/>`), description)).arrayBuffer());
    } else {
      data = orientedStl(bodies.map(({ stl }) => ({ stl, m })), title);
    }
    files.push([file, data]);

    const checks = bodies.map(({ stl }) => checkMesh(stl));
    const meshVolume = checks.reduce((sum, check) => sum + check.volume_mm3, 0);
    const exact = bodies.every(({ item }) => item.mass_properties);
    const volume = exact ? bodies.reduce((sum, { item }) => sum + item.mass_properties!.volume_mm3, 0) : meshVolume;
    const density = (item: BodyMesh) => settings.density_g_cm3 ?? item.density_g_cm3 ?? null;
    const mass = exact && bodies.every(({ item }) => density(item))
      ? bodies.reduce((sum, { item }) => sum + item.mass_properties!.volume_mm3 * density(item)! / 1000, 0) : null;
    parts.push({
      file, name: title, item: row.item, link: row.link, ...(row.parameters && Object.keys(row.parameters).length ? { parameters: row.parameters } : {}),
      instances, quantity: row.quantity, process: settings.process, material: settings.material ?? bodies[0].item.material ?? null,
      group: settings.group ?? null, notes: settings.notes ?? null, build_direction: settings.build_direction,
      transform: m.map((r) => r.map((v) => num(v, 9))), size_mm: [0, 1, 2].map((a) => num(high[a] - low[a], 3)),
      volume_mm3: num(volume, 3), mass_g: mass === null ? null : num(mass, 2),
      checks: { closed: checks.every((c) => c.closed), consistent_winding: checks.every((c) => c.consistent_winding),
        positive_volume: checks.every((c) => c.volume_mm3 > 0), triangles: checks.reduce((sum, c) => sum + c.triangles, 0) },
      bytes: data.length, sha256: await sha256(data),
    });
  }

  // Plates: every copy each quantity asks for, on the bed. A 3MF plate holds each part once (an object, or one of its
  // bodies' objects as components) and a build item per copy, so slicers see copies as instances; an STL plate is one mesh.
  const bed: [number, number] = input.bed ?? [220, 220];
  const plates: PrintPlate[] = [];
  const layouts = layPlates(parts, bed);
  for (const [n, layout] of layouts.entries()) {
    const file = `plates/plate_${n + 1}.${input.format}`;
    const used = [...new Set(layout.copies.map((copy) => copy.part))].sort((a, b) => a - b);
    const title = `${input.name} · plate ${n + 1}`;
    let data: Uint8Array;
    if (input.format === '3mf') {
      const objects: string[] = [], ids = new Map<number, number>();
      let id = 0;
      for (const index of used) {
        const { bodies, m, named } = meshes[index];
        const first = id + 1;
        bodies.forEach(({ stl }, i) => objects.push(objectXml(++id, named[i], stl, m)));
        if (bodies.length > 1) {
          const components = bodies.map((_, i) => `<component objectid="${first + i}"/>`).join('');
          objects.push(`<object id="${++id}" type="model" name="${escape(parts[index].name)}"><components>${components}</components></object>`);
        }
        ids.set(index, id);
      }
      const items = layout.copies.map((copy) => `<item objectid="${ids.get(copy.part)}" transform="${transform3mf(onBed(copy))}"/>`);
      const description = [layout.process.toUpperCase(), layout.material, `${layout.copies.length} part${layout.copies.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
      data = new Uint8Array(await (await package3mf(title, objects, items, description)).arrayBuffer());
    } else {
      data = orientedStl(layout.copies.flatMap((copy) => meshes[copy.part].bodies.map(({ stl }) => ({ stl, m: compose(onBed(copy), meshes[copy.part].m) }))), title);
    }
    files.push([file, data]);
    plates.push({
      file, process: layout.process, material: layout.material, bed_mm: [...bed], fits: layout.fits,
      parts: used.map((index) => ({ file: parts[index].file, name: parts[index].name, copies: layout.copies.filter((copy) => copy.part === index).length })),
      bytes: data.length, sha256: await sha256(data),
    });
  }

  const { source } = input;
  const manifest = {
    version: 1, generator: 'STEVE', kind: 'print_set', design: input.name, source,
    options: { units: 'mm', format: input.format, orientation: 'build direction up (+Z), centred in X and Y, lowest point on Z = 0',
      tessellation: tessellation(input.resolution ?? 'fine'),
      plates: { bed_mm: [...bed], edge_mm: EDGE, gap_mm: GAP, layout: 'every copy on its bed, bounding boxes apart; one process and material per plate' } },
    parts, plates,
  };
  const failed = (part: PrintPart) => [!part.checks.closed && 'not closed', !part.checks.consistent_winding && 'inconsistent winding',
    !part.checks.positive_volume && 'no positive volume'].filter(Boolean).join(', ');
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const list = [
    `# Print list: ${input.name}`, '',
    `Document ${source.document_id ?? 'unsaved'}, revision ${source.revision ?? '-'}${source.branch && source.branch !== 'main' ? ` (branch ${source.branch})` : ''}`
      + `${source.unsaved_edits ? ' with unsaved edits' : ''}, build ${source.build_id}. Millimetres; each part stands on its print bed as oriented.`, '',
    '| File | Qty | Process | Material | Up | Size (mm) | Volume (cm³) | Mass (g) | Instances | Notes |',
    '|---|---:|---|---|---|---|---:|---:|---|---|',
    ...parts.map((part) => `| ${cell(part.file.replace(/^parts\//, ''))} | ${part.quantity} | ${part.process.toUpperCase()} | ${cell(part.material ?? '-')} | ${part.build_direction}`
      + ` | ${part.size_mm.join(' × ')} | ${num(part.volume_mm3 / 1000, 2)} | ${part.mass_g ?? '-'} | ${cell(part.instances.join(', '))}`
      + ` | ${cell([part.group && `group ${part.group}`, part.notes, failed(part) && `**check: ${failed(part)}**`].filter(Boolean).join('; ') || '-')} |`),
    '', `${parts.reduce((sum, part) => sum + part.quantity, 0)} prints of ${parts.length} file${parts.length === 1 ? '' : 's'}.`
      + ' Mass is solid (100% infill) from the material\'s density; a part without a known material has none.',
    ...(missing.length ? ['', `No geometry (left out): ${missing.join(', ')}.`] : []), '',
    ...(plates.length ? [
      `## Plates (${bed[0]} × ${bed[1]} mm bed)`, '',
      '| File | Process | Material | Parts | Notes |',
      '|---|---|---|---|---|',
      ...plates.map((plate) => `| ${plate.file.replace(/^plates\//, '')} | ${plate.process.toUpperCase()} | ${cell(plate.material ?? '-')}`
        + ` | ${cell(plate.parts.map((part) => `${part.copies} × ${part.file.replace(/^parts\//, '')}`).join(', '))}`
        + ` | ${plate.fits ? '-' : '**bigger than the bed**'} |`),
      '', `Every copy the quantities ask for, one process and material per plate, ${GAP} mm apart by their bounding boxes:`
        + ' your slicer\'s arrange can pack them tighter. Choose the bed in the Export menu (Print bed).', '',
    ] : []),
  ];
  files.push(['PRINT_LIST.md', list.join('\n')], ['manifest.json', `${JSON.stringify(manifest, null, 1)}\n`]);
  return { files, parts, plates, missing };
}

// ── Export ────────────────────────────────────────────────────────────────

interface DesignSummary { bom?: PrintRow[]; instances?: PrintInstance[] }
const designOf = (metadata: unknown) => (metadata as { modeling?: { design?: DesignSummary } } | null | undefined)?.modeling?.design ?? null;

/** Bill-of-materials rows of printed instances in a build's design summary. */
export const printedRows = (metadata: unknown) => (designOf(metadata)?.bom ?? []).filter((row) => row.print && row.instances?.length);

let running = false;

/** Downloads every printed part (the selected ones, if the selection covers any) as a print set zip. */
export async function exportPrintSet(format: MeshFormat = '3mf') {
  if (running) {
    toast('info', 'An export is already running', 'Its file downloads when it’s ready; the status bar shows how far it is.');
    return;
  }
  running = true;
  const label = 'print set';
  const preparing = toast('info', 'Preparing the print set', 'Choose where to save when the export is ready.');
  const { resolution } = useMeshResolution.getState();
  let downloading = false;
  try {
    const build = await ensurePrintMeshes(label, false, resolution);
    if (!build) return;
    const full = build;
    let rows = printedRows(full.metadata);
    if (!rows.length) {
      toast('warning', 'No printed parts yet', 'Mark parts as printed in main.py: design.add(bracket, print={"build_direction": "+Z", "material": "petg"}).');
      return;
    }
    const scope = meshScope(get(), true);
    const items = bodyMeshes(full, resolution) ?? [];
    if (scope.selection) {
      const picked = rows.filter((row) => row.instances!.some((instance) => items.some((item) => inInstance(item, instance) && scope.match(item))));
      if (picked.length) rows = picked;
    }
    const wanted = items.map((item, index) => ({ item, index })).filter(({ item }) => rows.some((row) => inInstance(item, row.instances![0])));
    downloading = true;
    const bodies = await fetchMeshes(full.id, wanted, label, resolution);
    const state = get();
    const name = state.doc.name || full.name;
    const { files, parts, plates, missing } = await printSet({
      name, format, resolution, bed: PRINT_BEDS[usePrintBed.getState().bed]?.size_mm ?? [220, 220], rows, instances: designOf(full.metadata)?.instances ?? [], bodies,
      source: { document_id: state.doc.saved?.id ?? null, revision: state.doc.saved?.revision ?? null, branch: state.doc.saved ? state.doc.branch : null,
        build_id: full.id, unsaved_edits: hasSourceEdits(state) },
    });
    if (!parts.length) { toast('warning', 'Nothing to export', 'The printed parts have no solid bodies, or errors to fix first.'); return; }
    const blob = await zip(files);
    saveBlob(blob, `${safe(name)}-print-set.zip`);
    const prints = parts.reduce((sum, part) => sum + part.quantity, 0);
    const flagged = parts.filter((part) => !part.checks.closed || !part.checks.consistent_winding || !part.checks.positive_volume);
    const oversize = plates.filter((plate) => !plate.fits).length;
    const problems = [flagged.length && `${flagged.length} mesh${flagged.length === 1 ? '' : 'es'} to check (${flagged.map((part) => part.name).join(', ')})`,
      missing.length && `${missing.length} without geometry`, oversize && `${oversize} part${oversize === 1 ? '' : 's'} bigger than the bed`].filter(Boolean).join('; ');
    toast(problems ? 'warning' : 'success', 'Exported a print set',
      `${parts.length} file${parts.length === 1 ? '' : 's'} for ${prints} print${prints === 1 ? '' : 's'}${scope.selection && rows.length < printedRows(full.metadata).length ? ' (the selection)' : ''},`
      + ` each standing on its bed, and ${plates.length} plate${plates.length === 1 ? '' : 's'} of ${plates[0]?.bed_mm.join(' × ')} mm laid out ready to slice.`
      + ` PRINT_LIST.md has quantities and materials.${problems ? ` ${problems}: see PRINT_LIST.md.` : ''}`);
  } catch (error) {
    if (downloading) exportStatus(null, true);
    downloading = false;
    toast('danger', 'Couldn’t export the print set', (error as Error).message);
  } finally {
    dismissToast(preparing);
    if (downloading) exportStatus(null);
    running = false;
  }
}
