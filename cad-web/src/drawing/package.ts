/**
 * Export → Product drawings: a product made of linked documents as one drawing package. Every document's sheets go to
 * one print (print.ts, Save as PDF: one multi-page PDF) and every document's STEP into one zip, the open document
 * first, then its linked documents at their pinned revisions, depth-first in the order the code declares them, each
 * once (the server's walk, app/main.py package_walk). The parts here take their builds and downloads as arguments, so
 * they run without a browser; state/actions.ts exportProductDrawings does the building and downloading.
 */
import type { Build, PackageDocument } from '@/lib/api';

/** A document's link aliases in the order its code first names them (main.py, then its files by path); aliases the
 *  code never names come last, by name. The same order as app/main.py declared_order. */
export function declaredOrder(doc: Pick<PackageDocument, 'code' | 'files' | 'links'>): string[] {
  const files = doc.files ?? {};
  const text = [doc.code ?? '', ...Object.keys(files).sort().map((path) => files[path])].join('\n');
  const at = (alias: string) => { const found = new RegExp(`\\b${alias}\\b`).exec(text); return found ? found.index : text.length + 1; };
  return Object.keys(doc.links ?? {}).sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const keyOf = (doc: Pick<PackageDocument, 'document_id' | 'revision'>) => `${doc.document_id}@${doc.revision}`;

/** The host, then each link's walk (in the host's declared order) adding the documents not listed yet. */
export function assemblyOrder(host: PackageDocument, walks: PackageDocument[][]): PackageDocument[] {
  const out = [host];
  const seen = new Set([keyOf(host)]);
  for (const doc of walks.flat()) {
    if (seen.has(keyOf(doc)) || (host.document_id && doc.document_id === host.document_id)) continue;
    seen.add(keyOf(doc));
    out.push(doc);
  }
  return out;
}

const safe = (text: string) => text.replace(/[^\w.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'document';

/** A file name per document, `<name>.step`, numbered when two documents share a name. */
export function stepNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let file = `${safe(name)}.step`;
    for (let n = 2; used.has(file.toLowerCase()); n++) file = `${safe(name)}_${n}.step`;
    used.add(file.toLowerCase());
    return file;
  });
}

/** What a product's package needs from the app: each document's full build, a build's sheets and its STEP. */
export interface PackageSteps {
  build: (doc: PackageDocument, index: number) => Promise<Build>;
  sheets: (build: Build) => Promise<string[]>;
  step: (build: Build) => Promise<Uint8Array | null>;
}

export interface ProductPackage {
  /** Every sheet's SVG markup, in assembly order. */
  sheets: string[];
  /** The builds whose sheets are in it, in assembly order, when every one has its sheets as a PDF (else null: print). */
  pdfs: string[] | null;
  /** [file name, STEP] per document that has one, in assembly order. */
  steps: [string, Uint8Array][];
  /** Documents without a drawing sheet, and those that didn't build (with why), by name. */
  withoutSheets: string[];
  failed: { name: string; error: string }[];
}

/** Builds each document in turn (a failure is noted and the rest carry on) and gathers its sheets and STEP. Circuits,
 *  shops and CAM programs have neither: they're listed as without sheets. */
export async function collectPackage(documents: PackageDocument[], steps: PackageSteps): Promise<ProductPackage> {
  const sheets: string[] = [];
  let pdfs: string[] | null = [];
  const stepped: { name: string; data: Uint8Array }[] = [];
  const withoutSheets: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const [index, doc] of documents.entries()) {
    if (doc.kind !== 'part' && doc.kind !== 'design') { withoutSheets.push(doc.name); continue; }
    try {
      const build = await steps.build(doc, index);
      const own = await steps.sheets(build);
      if (own.length) {
        sheets.push(...own);
        pdfs = build.artifacts.drawings_pdf && pdfs ? [...pdfs, build.id] : null;
      } else withoutSheets.push(doc.name);
      const data = await steps.step(build);
      if (data) stepped.push({ name: doc.name, data });
    } catch (error) {
      failed.push({ name: doc.name, error: (error as Error).message });
    }
  }
  const names = stepNames(stepped.map((item) => item.name));
  return { sheets, pdfs: pdfs?.length ? pdfs : null, steps: stepped.map((item, index) => [names[index], item.data]), withoutSheets, failed };
}
