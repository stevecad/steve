import { visibleFields, type ArrayDescriptor, type ResultManifest } from './api';
import { withWorkspace } from '@/teams/current';

// The team workspace the app's tab works in (teams/current.ts): a worker has no session storage, so the app says.
let workspace: string | null = null;

let activeDownloads = 0;
const waitingDownloads: (() => void)[] = [];

async function download(descriptor: ArrayDescriptor): Promise<ArrayBuffer> {
  // Combined region plots can reference hundreds of arrays. Bound each viewer's
  // pressure on the API's verified-download disk slots.
  if (activeDownloads >= 3) await new Promise<void>((resolve) => waitingDownloads.push(resolve));
  else activeDownloads++;
  try { return await fetchArray(descriptor); }
  finally {
    const next = waitingDownloads.shift();
    if (next) next(); else activeDownloads--;
  }
}

async function fetchArray(descriptor: ArrayDescriptor): Promise<ArrayBuffer> {
  if (!descriptor.url.startsWith('/v1/simulation/runs/') || descriptor.bytes > 128*1024*1024 || descriptor.bytes !== descriptor.count * descriptor.components * 4) throw new Error('Result array exceeds its supported size or shape.');
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(withWorkspace(descriptor.url, workspace, self.location.origin));
    if (![429, 503].includes(response.status) || attempt >= 5) break;
    const requested = Number(response.headers.get('Retry-After')) || 2 ** attempt;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(5, Math.max(.25, requested))));
  }
  if (!response.ok) throw new Error(`Result download failed (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.bytes) throw new Error('Result array is incomplete.');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
  if (digest !== descriptor.sha256) throw new Error('Result checksum does not match its run.');
  return bytes;
}

// `surfaceOnly`: the undeformed surface and its values, without displacement or volume (the all-studies view).
self.onmessage = async (event: MessageEvent<{ manifest: ResultManifest; field: string; frame: number; region: string; yieldPa?: number | null; safetyCap?: number; surfaceOnly?: boolean; workspace?: string | null }>) => {
  workspace = event.data.workspace ?? null;
  try {
    const { manifest, frame, region, yieldPa, safetyCap = 10, surfaceOnly = false } = event.data;
    // Safety factor is derived here: yield strength ÷ von Mises stress, capped for a readable scale.
    const safety = event.data.field === 'safety';
    if (safety && !(yieldPa && yieldPa > 0)) throw new Error('Safety factor needs the material’s yield strength.');
    const field = safety ? 'von_mises' : event.data.field;
    const arrays = manifest.arrays;
    if (manifest.frames && (!Number.isInteger(frame) || frame < 0 || frame >= manifest.frames.length)) throw new Error('Invalid result time selection.');
    if (manifest.regions && region !== '' && !manifest.regions[region]) throw new Error('Invalid result region selection.');
    if (field !== 'mesh' && !visibleFields(manifest, region)[field]) throw new Error('This field is not defined in every selected region.');
    const datasets = manifest.regions ? Object.entries(manifest.regions).filter(([name]) => region === '' || name === region).map(([, data]) => data)
      : [{ surface: { positions: 'positions', triangles: 'triangles' }, fields: manifest.frames?.[frame]?.fields ?? Object.fromEntries(Object.keys(arrays).map((key) => [key, key])) }];
    const mode = manifest.modes?.find((item) => item.field === field);
    let budget = 0;
    const decoded = await Promise.all(datasets.map(async (dataset) => {
      const position = arrays[dataset.surface.positions], index = arrays[dataset.surface.triangles];
      const descriptor = field === 'mesh' ? undefined : arrays[dataset.fields[field]];
      const deformation = surfaceOnly ? undefined : mode ? descriptor : manifest.regions ? undefined : arrays.displacement;
      if (!position || !index || (field !== 'mesh' && !descriptor)) throw new Error('Incomplete region result dataset.');
      budget += position.bytes + index.bytes + (descriptor?.bytes ?? 0) + (deformation?.bytes ?? 0);
      if (budget > 128*1024*1024) throw new Error('Select a smaller region to view this result (128 MiB display limit).');
      if (position.dtype !== '<f4' || index.dtype !== '<u4' || descriptor && descriptor.dtype !== '<f4' || deformation && deformation.dtype !== '<f4') throw new Error('Invalid result array encoding.');
      const [positionData, indexData, fieldData, displacementData] = await Promise.all([
        download(position), download(index), descriptor ? download(descriptor) : null, deformation ? download(deformation) : null,
      ]);
      const positions = new Float32Array(positionData), triangles = new Uint32Array(indexData);
      const displacement = displacementData ? new Float32Array(displacementData) : null;
      if (mode && displacement) {
        const amplitude = manifest.modal?.display_amplitude_m;
        if (!amplitude || !Number.isFinite(amplitude) || amplitude <= 0) throw new Error('Invalid mode display amplitude.');
        for (let i = 0; i < displacement.length; i++) displacement[i] *= amplitude;
      }
      const count = positions.length / 3;
      if (position.components !== 3 || index.components !== 3 || !count || triangles.some((v) => v >= count)) throw new Error('Invalid result mesh connectivity.');
      if (positions.some((v) => !Number.isFinite(v)) || displacement && (displacement.length !== positions.length || displacement.some((v) => !Number.isFinite(v)))) throw new Error('Invalid result coordinates or displacement.');
      const values = new Float32Array(count);
      if (descriptor && fieldData) {
        if (descriptor.count !== count || ![1, 3].includes(descriptor.components)) throw new Error('Unsupported field shape.');
        const source = new Float32Array(fieldData);
        for (let i = 0; i < count; i++) values[i] = descriptor.components === 1 ? source[i] : Math.hypot(source[3*i], source[3*i+1], source[3*i+2]);
        if (safety) for (let i = 0; i < count; i++) values[i] = values[i] > 0 ? Math.min(safetyCap, yieldPa! / values[i]) : safetyCap;
        if (values.some((v) => !Number.isFinite(v))) throw new Error('Result contains nonfinite field values.');
      }
      return { positions, triangles, values, displacement };
    }));
    const positions = new Float32Array(decoded.reduce((sum, data) => sum + data.positions.length, 0));
    const triangles = new Uint32Array(decoded.reduce((sum, data) => sum + data.triangles.length, 0));
    const values = new Float32Array(positions.length / 3);
    const displacement = manifest.regions ? null : decoded[0].displacement;
    let vertexOffset = 0, indexOffset = 0;
    for (const data of decoded) {
      positions.set(data.positions, vertexOffset*3); values.set(data.values, vertexOffset);
      for (let i = 0; i < data.triangles.length; i++) triangles[indexOffset+i] = data.triangles[i] + vertexOffset;
      vertexOffset += data.values.length; indexOffset += data.triangles.length;
    }
    let min = Infinity, max = -Infinity, minIndex = 0, maxIndex = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) { min = values[i]; minIndex = i; }
      if (values[i] > max) { max = values[i]; maxIndex = i; }
    }
    // Solid results give every node a value and publish their tetrahedra (4 or 10 nodes): the viewer can cut through the part.
    let cells: Uint32Array | null = null, cellNodes = 0;
    const cellDescriptor = manifest.regions || surfaceOnly ? undefined : arrays.cells;
    if (cellDescriptor) {
      if (cellDescriptor.dtype !== '<u4' || ![4, 10].includes(cellDescriptor.components)) throw new Error('Invalid result volume encoding.');
      cellNodes = cellDescriptor.components;
      if (budget + cellDescriptor.bytes <= 128*1024*1024) {
        cells = new Uint32Array(await download(cellDescriptor));
        const count = positions.length / 3;
        if (cells.some((v) => v >= count)) throw new Error('Invalid result volume connectivity.');
      }
    }
    const onSurface = (index: number) => triangles.includes(index);
    const transfer: Transferable[] = [positions.buffer, triangles.buffer, values.buffer];
    if (displacement) transfer.push(displacement.buffer);
    if (cells) transfer.push(cells.buffer);
    self.postMessage({ ok: true, positions, triangles, values, displacement, min, max, cells, cellNodes, minIndex, maxIndex,
      minOnSurface: onSurface(minIndex), maxOnSurface: onSurface(maxIndex) }, { transfer });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
