/**
 * An Excel workbook (.xlsx) read in the browser as one sheet's cell values, written out as CSV for Import table…
 * Native APIs only: the zip's central directory is read here, entries are inflated with DecompressionStream
 * ('deflate-raw') and parts parsed with DOMParser ('application/xml'). Nothing is sent anywhere: the result is a
 * plain .csv the design saves like any imported table.
 *
 * Only what a table needs is read: [Content_Types].xml, the workbook and its relationships (to find the sheets),
 * the shared strings and the chosen sheet. Cells give numbers, strings and booleans; a formula gives only the value
 * Excel cached, never evaluated. Macros, external links, DDE, embedded objects, styles, comments, drawings and
 * hidden sheets are never opened. Every limit is checked while reading, and refusals name a sheet, row or column,
 * never a cell's value.
 */

export const XLSX_LIMITS = {
  /** The .xlsx file itself. */
  fileBytes: 10 * 1024 * 1024,
  /** Everything inflated from the zip together (stops zip bombs as soon as they pass it). */
  totalBytes: 50 * 1024 * 1024,
  /** One XML part, inflated. */
  partBytes: 32 * 1024 * 1024,
  /** Entries in the zip's central directory. */
  entries: 10_000,
  /** Cells read from the sheet. */
  cells: 200_000,
};

/**
 * What Import table… makes of a file by its name: a .csv, an .xlsx, or why neither (every other workbook format,
 * macro-enabled .xlsm, binary .xlsb and old .xls among them, is refused rather than guessed at).
 */
export function tableFileKind(name: string): 'csv' | 'xlsx' | { problem: string } {
  if (/\.csv$/i.test(name)) return 'csv';
  if (/\.xlsx$/i.test(name)) return 'xlsx';
  if (/\.(xlsm|xlsb|xls|xlt[xm]?|xlam|ods|numbers)$/i.test(name)) return { problem: 'Only .xlsx workbooks and .csv files import: save it as Excel Workbook (.xlsx) or as CSV. Macro-enabled (.xlsm), binary (.xlsb) and old (.xls) workbooks aren’t read.' };
  return { problem: 'Choose a .csv or .xlsx file (a spreadsheet saves one with Save As → CSV or Excel Workbook).' };
}

/** Why a workbook can't be imported, in words for the person. */
export class XlsxProblem extends Error {}

/** The DOM subset read here: DOMParser's documents, or a stand-in in tests. */
interface XmlElement { localName: string; children: ArrayLike<XmlElement>; textContent: string | null; getAttribute(name: string): string | null }
interface XmlDocument { documentElement: XmlElement | null; getElementsByTagName(name: string): ArrayLike<unknown> }
export type ParseXml = (text: string) => XmlDocument;

export interface XlsxOptions { parseXml?: ParseXml; limits?: Partial<typeof XLSX_LIMITS> }

export interface Workbook {
  /** The visible worksheets' names, in the workbook's order. */
  sheets: string[];
  /** The sheet's cell values as CSV; refuses once the text would pass `maxChars`. */
  csv(sheet: string, maxChars: number): Promise<string>;
}

const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NOT_XLSX = 'That file isn’t an Excel workbook (.xlsx): save it from the spreadsheet as Excel Workbook (.xlsx) or as CSV.';
const DAMAGED = 'That workbook can’t be read (the file looks damaged): save it again as .xlsx, or as CSV.';
const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
// Inflated a slice at a time, so one write can never expand past ~1,000× this before the byte counter sees it.
const INFLATE_SLICE = 4096;

interface Entry { method: number; flags: number; compressed: number; size: number; offset: number }

const defaultParse: ParseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

const kids = (element: XmlElement | null | undefined, name: string) =>
  element ? Array.from(element.children).filter((child) => child.localName === name) : [];
const kid = (element: XmlElement | null | undefined, name: string) => kids(element, name)[0];

/** "B12" → [12, 2] (row, column, 1-based); null when it isn't a cell reference. */
function cellRef(ref: string): [number, number] | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref.trim().toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return [Number(match[2]), column];
}
const columnName = (column: number) => {
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;

/** One CSV field: quoted when it holds a delimiter steve.table could take, a quote or a line break. */
const csvField = (value: string) => (/[",;\t\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * Opens an .xlsx (its bytes) and lists its visible worksheets; `csv(sheet)` then reads one. Throws XlsxProblem.
 */
export async function openXlsx(data: ArrayBuffer | Uint8Array, options: XlsxOptions = {}): Promise<Workbook> {
  const limits = { ...XLSX_LIMITS, ...options.limits };
  const parseXml = options.parseXml ?? defaultParse;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > limits.fileBytes) throw new XlsxProblem(`That workbook is larger than ${MB(limits.fileBytes)}: save the table on its own, or as CSV.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  // The end-of-central-directory record: the last 22 bytes plus at most a 65,535-byte comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new XlsxProblem(NOT_XLSX);
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryStart = u32(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff) throw new XlsxProblem(`That workbook is larger than ${MB(limits.fileBytes)}: save the table on its own, or as CSV.`);
  if (count > limits.entries) throw new XlsxProblem(`That workbook holds more than ${limits.entries.toLocaleString('en-US')} parts: save the table on its own, or as CSV.`);
  if (directoryStart + directorySize > end) throw new XlsxProblem(DAMAGED);

  const names = new TextDecoder();
  const entries = new Map<string, Entry>();
  let at = directoryStart;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) throw new XlsxProblem(DAMAGED);
    const nameLength = u16(at + 28);
    const next = at + 46 + nameLength + u16(at + 30) + u16(at + 32);
    if (next > end) throw new XlsxProblem(DAMAGED);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { flags: u16(at + 8), method: u16(at + 10), compressed: u32(at + 20), size: u32(at + 24), offset: u32(at + 42) });
    at = next;
  }

  let inflated = 0;  // every part read so far, against limits.totalBytes
  const tooBig = () => new XlsxProblem(`That workbook unpacks to more than ${MB(Math.min(limits.totalBytes, limits.partBytes))} of data: save the table on its own, or as CSV.`);
  const counted = (size: number) => {
    inflated += size;
    if (inflated > limits.totalBytes) throw tooBig();
  };

  /** One part's bytes, counted while they inflate; null when the zip has no such part. */
  async function part(name: string): Promise<Uint8Array | null> {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 1) throw new XlsxProblem('That workbook is password-protected: save a copy without a password, or as CSV.');
    if (entry.size > limits.partBytes || inflated + entry.size > limits.totalBytes) throw tooBig();
    const local = entry.offset;
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) throw new XlsxProblem(DAMAGED);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + entry.compressed > bytes.length) throw new XlsxProblem(DAMAGED);
    const raw = bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) {
      if (raw.length > limits.partBytes) throw tooBig();
      counted(raw.length);
      return raw;
    }
    if (entry.method !== 8) throw new XlsxProblem(DAMAGED);
    // The declared size is only a hint: the bytes are counted as they come, and reading stops at a limit.
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const feeding = (async () => {
      for (let offset = 0; offset < raw.length; offset += INFLATE_SLICE) await writer.write(raw.slice(offset, offset + INFLATE_SLICE));
      await writer.close();
    })();
    feeding.catch(() => undefined);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limits.partBytes) throw tooBig();
        counted(value.length);
        chunks.push(value);
      }
      await feeding;
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      void writer.abort().catch(() => undefined);
      throw error instanceof XlsxProblem ? error : new XlsxProblem(DAMAGED);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  /** A part as an XML document's root element; null when the zip has no such part. */
  async function xml(name: string): Promise<XmlElement | null> {
    const data = await part(name);
    if (!data) return null;
    const text = new TextDecoder().decode(data);
    // No document type declarations: an .xlsx never has one, and they are how entity expansion attacks start.
    if (/<!DOCTYPE/i.test(text)) throw new XlsxProblem(DAMAGED);
    const document = parseXml(text);
    if (!document.documentElement || document.getElementsByTagName('parsererror').length) throw new XlsxProblem(DAMAGED);
    return document.documentElement;
  }

  // What the package says it is: a plain workbook, not a macro-enabled or binary one under another name.
  const types = await xml('[Content_Types].xml');
  if (!types) throw new XlsxProblem(NOT_XLSX);
  let workbookPath: string | null = null;
  for (const override of kids(types, 'Override')) {
    const type = override.getAttribute('ContentType') ?? '';
    if (/macroEnabled|sheet\.binary/i.test(type)) throw new XlsxProblem('That workbook has macros or is a binary workbook: save it as Excel Workbook (.xlsx) or as CSV.');
    if (type === MAIN_TYPE) workbookPath = (override.getAttribute('PartName') ?? '').replace(/^\//, '');
  }
  if (!workbookPath) throw new XlsxProblem(NOT_XLSX);
  const folder = workbookPath.replace(/[^/]*$/, '');

  /** A relationship target as a part name in this zip (no external targets, nothing outside the package). */
  const resolve = (target: string) => {
    const parts = (target.startsWith('/') ? target.slice(1) : folder + target).split('/');
    const out: string[] = [];
    for (const piece of parts) {
      if (piece === '..') out.pop();
      else if (piece && piece !== '.') out.push(piece);
    }
    return out.join('/');
  };
  const relations = new Map<string, { type: string; target: string }>();
  for (const relation of kids(await xml(`${folder}_rels/${workbookPath.slice(folder.length)}.rels`), 'Relationship')) {
    if (relation.getAttribute('TargetMode') === 'External') continue;
    relations.set(relation.getAttribute('Id') ?? '', { type: relation.getAttribute('Type') ?? '', target: resolve(relation.getAttribute('Target') ?? '') });
  }
  const workbook = await xml(workbookPath);
  if (!workbook) throw new XlsxProblem(NOT_XLSX);
  const sheets = new Map<string, string>();
  for (const sheet of kids(kid(workbook, 'sheets'), 'sheet')) {
    const state = sheet.getAttribute('state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const relation = relations.get(sheet.getAttribute('r:id') ?? (sheet as unknown as Element).getAttributeNS?.(REL_TYPE, 'id') ?? '');
    const name = sheet.getAttribute('name');
    if (!relation || !relation.type.endsWith('/worksheet') || !name || !entries.has(relation.target)) continue;  // chart sheets have no cells
    if (!sheets.has(name)) sheets.set(name, relation.target);
  }
  if (!sheets.size) throw new XlsxProblem('That workbook has no visible worksheet with cells.');
  const stringsPath = [...relations.values()].find((relation) => relation.type.endsWith('/sharedStrings'))?.target;

  let shared: string[] | null = null;
  /** A string item's text: its own <t>, or its runs' (phonetic guides left out). */
  const itemText = (item: XmlElement) => {
    const own = kid(item, 't');
    return own ? own.textContent ?? '' : kids(item, 'r').map((run) => kid(run, 't')?.textContent ?? '').join('');
  };

  return {
    sheets: [...sheets.keys()],
    async csv(sheetName: string, maxChars: number) {
      const path = sheets.get(sheetName);
      if (!path) throw new XlsxProblem(`That workbook has no visible sheet “${sheetName}”.`);
      if (shared === null) shared = stringsPath ? kids(await xml(stringsPath), 'si').map(itemText) : [];
      const strings = shared;
      const root = await xml(path);
      const rows = new Map<number, Map<number, string>>();
      let cells = 0;
      let lastRow = 0;
      let firstColumn = MAX_COLUMN + 1;
      let last = 0;
      for (const row of kids(kid(root, 'sheetData'), 'row')) {
        const rowNumber = Number(row.getAttribute('r') ?? lastRow + 1);
        if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROW || rowNumber <= lastRow) throw new XlsxProblem(`Sheet “${sheetName}” can’t be read near row ${lastRow + 1}: save it again as .xlsx, or as CSV.`);
        lastRow = rowNumber;
        let column = 0;
        for (const cell of kids(row, 'c')) {
          if (++cells > limits.cells) throw new XlsxProblem(`Sheet “${sheetName}” has more than ${limits.cells.toLocaleString('en-US')} cells (past row ${rowNumber}): keep only the table’s rows and columns, or save it as CSV.`);
          const ref = cell.getAttribute('r');
          const at = ref ? cellRef(ref) : [rowNumber, column + 1];
          if (!at || at[0] !== rowNumber || at[1] <= column || at[1] > MAX_COLUMN) throw new XlsxProblem(`Sheet “${sheetName}” can’t be read at row ${rowNumber}: save it again as .xlsx, or as CSV.`);
          column = at[1];
          const where = `Sheet “${sheetName}”, cell ${columnName(column)}${rowNumber}`;
          const type = cell.getAttribute('t') ?? 'n';
          // Only the cached value: <f> (a formula) is never read.
          const cached = kid(cell, 'v')?.textContent ?? null;
          let value: string | null;
          if (type === 'inlineStr') value = kid(cell, 'is') ? itemText(kid(cell, 'is')) : null;
          else if (cached === null) value = null;
          else if (type === 's') {
            const index = Number(cached);
            if (!Number.isInteger(index) || index < 0 || index >= strings.length) throw new XlsxProblem(`${where} can’t be read (its text is missing): save it again as .xlsx, or as CSV.`);
            value = strings[index];
          } else if (type === 'b') value = cached.trim() === '1' ? 'TRUE' : 'FALSE';
          else value = type === 'n' ? cached.trim() : cached;  // str (a formula's text), e (an error like #N/A), d (an ISO date)
          if (value === null || value === '') continue;
          let line = rows.get(rowNumber);
          if (!line) rows.set(rowNumber, (line = new Map()));
          line.set(column, value.replace(/\r\n?/g, '\n'));
          firstColumn = Math.min(firstColumn, column);
          last = rowNumber;
        }
      }
      if (!rows.size) throw new XlsxProblem(`Sheet “${sheetName}” is empty.`);
      // Rows keep their sheet numbers (CSV line n is sheet row n; steve.table skips the blank ones); empty columns before
      // the table are left out.
      const lines: string[] = [];
      let length = 0;
      for (let rowNumber = 1; rowNumber <= last; rowNumber++) {
        const line = rows.get(rowNumber);
        let text = '';
        if (line) {
          let width = 0;
          for (const column of line.keys()) width = Math.max(width, column);
          const fields: string[] = [];
          for (let column = firstColumn; column <= width; column++) fields.push(csvField(line.get(column) ?? ''));
          text = fields.join(',');
        }
        length += text.length + 1;
        if (length > maxChars) throw new XlsxProblem(`Sheet “${sheetName}” is too large for this design as a table (past row ${rowNumber}): a design’s files hold 2,000,000 characters together.`);
        lines.push(text);
      }
      return lines.join('\n') + '\n';
    },
  };
}
