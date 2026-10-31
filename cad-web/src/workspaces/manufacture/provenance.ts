/**
 * Field sources saved with library records (docs/MANUFACTURING_PROVENANCE.md): per field path, where the value came
 * from (a web page, a document, a measurement, a catalog) or that it is an estimate, plus record-level notes. The
 * server binds each claim to the exact value it was saved with and drops it when that value changes; the returned
 * record is authoritative.
 *
 * While a record is edited, each claim remembers the value it was made for (client-side only), so a field edited by
 * hand loses its mark at once and the save never sends a stale claim.
 */
import type { FieldNote } from '@/setup/FieldMarks';
import type { Provenance as SetupMarks } from '@/setup/api';

export type SourceKind = 'web' | 'document' | 'note' | 'measured' | 'catalog' | 'estimate';
export interface SourceLink { url: string; title?: string | null; retrieved_at?: string | null }
export interface FieldSource { kind: SourceKind; urls?: SourceLink[]; note?: string | null; value_sha256?: string | null }
export interface RecordProvenance { fields?: Record<string, FieldSource>; notes?: string | null }

/** Pages STEVE saw in a setup, by URL: their titles and when they were read. */
export type PageInfo = Record<string, { title?: string; retrieved_at?: string }>;

export const SOURCE_KINDS: { kind: SourceKind; label: string; hint: string }[] = [
  { kind: 'web', label: 'Web page', hint: 'A spec sheet or product page' },
  { kind: 'catalog', label: 'Catalog', hint: 'The maker’s catalog or datasheet' },
  { kind: 'document', label: 'Document', hint: 'A manual or drawing you have' },
  { kind: 'measured', label: 'Measured', hint: 'Measured on the machine or tool' },
  { kind: 'note', label: 'Note', hint: 'Where it came from, in words' },
  { kind: 'estimate', label: 'Estimate', hint: 'Not confirmed: dependent checks stay “not assessed”' },
];
export const kindLabel = (kind: SourceKind) => SOURCE_KINDS.find((item) => item.kind === kind)?.label ?? kind;

/** A claim and the value it was made for; `at` orders claims for the same field (the newest wins). */
interface Bound { claim: FieldSource | null; value: string; at: number }
let clock = 0;
/** An edit session's sources: the record's saved claims, STEVE's draft claims and the person's own, each bound. */
export interface SourceSession {
  saved: Record<string, Bound>;
  steve: Record<string, Bound>;
  /** Set by hand, or removed (a null claim). */
  manual: Record<string, Bound>;
  notes: string | null;
  /** Whether the record had sources when editing began (an empty save must then clear them). */
  had: boolean;
}

export const valueAt = (data: unknown, path: string): unknown => path.split('.').reduce<unknown>((at, key) =>
  (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), data);
const key = (value: unknown) => JSON.stringify(value ?? null);
const bind = (claims: Record<string, FieldSource> | undefined, definition: unknown, fresh = false): Record<string, Bound> =>
  Object.fromEntries(Object.entries(claims ?? {}).filter(([path]) => valueAt(definition, path) !== undefined)
    .map(([path, claim]) => [path, { claim: fresh ? { ...claim, value_sha256: undefined } : claim, value: key(valueAt(definition, path)), at: 0 }]));

/** Starts editing a record (or a revision of it). `copy`: for a duplicate, whose claims are new to the server. */
export function sessionOf(record: { definition: unknown; provenance?: RecordProvenance | null } | null, copy = false): SourceSession {
  const provenance = record?.provenance ?? null;
  return { saved: bind(provenance?.fields, record?.definition, copy), steve: {}, manual: {}, notes: provenance?.notes ?? null, had: !!provenance && !copy };
}

/** The claims in effect for what the form holds now: a field edited since its claim was made has none. */
export function effective(session: SourceSession, current: unknown): Record<string, FieldSource> {
  const out: Record<string, FieldSource> = {};
  const paths = new Set([...Object.keys(session.saved), ...Object.keys(session.steve), ...Object.keys(session.manual)]);
  for (const path of paths) {
    const value = valueAt(current, path);
    if (value === undefined) continue;
    const held = key(value);
    const bound = [session.manual[path], session.steve[path], session.saved[path]]
      .filter((item): item is Bound => !!item && item.value === held).sort((a, b) => b.at - a.at)[0];
    if (bound?.claim) out[path] = bound.claim;
  }
  return out;
}

const clean = (claim: FieldSource): FieldSource => ({
  kind: claim.kind,
  ...(claim.urls?.length ? { urls: claim.urls.map((link) => ({ url: link.url, ...(link.title ? { title: link.title } : {}), ...(link.retrieved_at ? { retrieved_at: link.retrieved_at } : {}) })) } : {}),
  ...(claim.note ? { note: claim.note } : {}),
  ...(claim.value_sha256 ? { value_sha256: claim.value_sha256 } : {}),
});

/** What a save sends: undefined leaves sources to the server (nothing was ever claimed); {} clears them. */
export function payload(session: SourceSession | null, current: unknown): RecordProvenance | undefined {
  if (!session) return undefined;
  const fields = Object.fromEntries(Object.entries(effective(session, current)).map(([path, claim]) => [path, clean(claim)]));
  const notes = session.notes?.trim() || null;
  if (!Object.keys(fields).length && !notes) return session.had ? {} : undefined;
  return { fields, ...(notes ? { notes } : {}) };
}

/** Marks for the form, by field path. */
export function notesOf(claims: Record<string, FieldSource>): Map<string, FieldNote> {
  return new Map(Object.entries(claims).map(([path, claim]) => [path, noteOf(claim)]));
}
export const noteOf = (claim: FieldSource): FieldNote => ({
  kind: claim.kind, links: claim.urls ?? [], note: claim.note ?? undefined, estimate: claim.kind === 'estimate',
  sources: (claim.urls ?? []).map((link) => link.url),
});
export const recordNotes = (record: { provenance?: RecordProvenance | null }) => notesOf(record.provenance?.fields ?? {});

/** STEVE's marks in the setup endpoint's terms (pages per path, estimated paths), for its follow-ups. */
export function toSetupMarks(claims: Record<string, FieldSource>): SetupMarks {
  const sources: Record<string, string[]> = {};
  const estimates: string[] = [];
  for (const [path, claim] of Object.entries(claims)) {
    const urls = (claim.urls ?? []).map((link) => link.url);
    if (urls.length) sources[path] = urls;
    if (claim.kind === 'estimate') estimates.push(path);
  }
  return { sources, estimates };
}

/**
 * A STEVE draft's marks as claims bound to the values it delivered. A mark that matches a claim already in effect
 * (same pages, or still an estimate) keeps that claim, with its titles, times and server binding.
 */
export function fromSetupMarks(marks: SetupMarks, definition: unknown, pages: PageInfo, existing: Record<string, FieldSource>): Record<string, Bound> {
  const out: Record<string, Bound> = {};
  const at = ++clock;
  const paths = new Set([...Object.keys(marks.sources), ...marks.estimates]);
  for (const path of paths) {
    const value = valueAt(definition, path);
    if (value === undefined) continue;
    const urls = marks.sources[path] ?? [];
    const estimate = marks.estimates.includes(path);
    const before = existing[path];
    const same = before && (before.kind === 'estimate') === estimate
      && key([...(before.urls ?? []).map((link) => link.url)].sort()) === key([...urls].sort());
    const claim: FieldSource = same ? before : {
      kind: estimate ? 'estimate' : 'web',
      urls: urls.map((url) => ({ url, ...(pages[url]?.title ? { title: pages[url].title } : {}), ...(pages[url]?.retrieved_at ? { retrieved_at: pages[url].retrieved_at } : {}) })),
    };
    out[path] = { claim, value: key(value), at };
  }
  return out;
}

/** A claim the person sets by hand on the value the field holds now (null clears it). */
export function manualClaim(claim: FieldSource | null, current: unknown, path: string): Bound {
  return { claim: claim ? { ...claim, value_sha256: undefined } : null, value: key(valueAt(current, path)), at: ++clock };
}
