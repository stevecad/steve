/**
 * The sheets a full build drew: every sheet's SVG from drawings.zip (runtime/steve/drawing.py writes them as
 * `01-<name>.svg`, `02-…`, in the order the code declares them), read in the browser with its own DecompressionStream,
 * so no ZIP library is needed. Falls back to drawing.svg (the first sheet) when the archive can't be read.
 * The markup is sanitized before it's shown (lib/sanitize.ts).
 */
import type { Build } from '@/lib/api';

const cache = new Map<string, Promise<string[]>>();

const u16 = (data: DataView, at: number) => data.getUint16(at, true);
const u32 = (data: DataView, at: number) => data.getUint32(at, true);

async function inflate(bytes: Uint8Array<ArrayBuffer>, method: number): Promise<string> {
  if (method === 0) return new TextDecoder().decode(bytes);
  if (method !== 8) throw new Error('Unsupported compression');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Each `.svg` entry of a ZIP, by name. */
export async function svgEntries(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const data = new DataView(buffer);
  let end = -1;
  for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 22 - 0xffff); at--) {
    if (u32(data, at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = u16(data, end + 10);
  let at = u32(data, end + 16);
  const out = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    if (u32(data, at) !== 0x02014b50) throw new Error('Damaged ZIP directory');
    const method = u16(data, at + 10);
    const size = u32(data, at + 20);
    const nameLength = u16(data, at + 28);
    const local = u32(data, at + 42);
    const name = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLength));
    at += 46 + nameLength + u16(data, at + 30) + u16(data, at + 32);
    if (!name.toLowerCase().endsWith('.svg') || u32(data, local) !== 0x04034b50) continue;
    const start = local + 30 + u16(data, local + 26) + u16(data, local + 28);
    out.set(name, await inflate(new Uint8Array(buffer, start, size), method));
  }
  return out;
}

/** Every sheet's SVG markup, in sheet order (empty when the build has no drawing). */
export function sheetMarkup(build: Build): Promise<string[]> {
  const key = build.artifacts.drawings ?? build.artifacts.drawing;
  if (!key) return Promise.resolve([]);
  let request = cache.get(key);
  if (!request) {
    request = (async () => {
      if (build.artifacts.drawings) {
        try {
          const response = await fetch(build.artifacts.drawings);
          if (response.ok) {
            const entries = await svgEntries(await response.arrayBuffer());
            const sheets = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, svg]) => svg);
            if (sheets.length) return sheets;
          }
        } catch { /* The first sheet alone, below. */ }
      }
      if (!build.artifacts.drawing) return [];
      const response = await fetch(build.artifacts.drawing);
      if (!response.ok) throw new Error(`The drawing didn’t load (${response.status}).`);
      return [await response.text()];
    })();
    request.catch(() => cache.delete(key));
    cache.set(key, request);
    while (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return request;
}
