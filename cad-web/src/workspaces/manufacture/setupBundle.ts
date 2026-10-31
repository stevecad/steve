/**
 * Set up with STEVE, several records at once: a machine and the model and control it needs (app/setup_assistant.py,
 * docs/SETUP_ASSISTANT.md). The form shows each draft in turn; "Save all" saves them together, dependencies first,
 * filling each link with the record it just saved. Each record keeps its own sources. A retry after a failure saves
 * only what is left, with the same request keys for unchanged drafts, so nothing is saved twice.
 */
import type { BundleItem, SetupBundle } from '@/setup/api';
import { sha256Hex } from '@/lib/sha256';
import { uuid } from '@/lib/uuid';
import { pinOf, type Kind, type LibraryRecord } from './api';
import { KIND_LABELS } from './kinds';
import { effective, fromSetupMarks, sessionOf, toSetupMarks, type PageInfo, type RecordProvenance, type SourceSession } from './provenance';

export type EntryState = 'draft' | 'saving' | 'saved' | 'failed';

export interface BundleEntry {
  ref: string;
  kind: Kind;
  /** The draft as the form holds it: pins to saved records included, links to drafted records left out. */
  definition: Record<string, unknown>;
  /** Fields that pin a record drafted in this setup, by the record's ref. */
  links: Record<string, string>;
  session: SourceSession;
  /** The saved record this draft revises (the one open when the setup began), or null for a new record. */
  base: LibraryRecord | null;
  state: EntryState;
  saved?: LibraryRecord;
  error?: string;
  errors?: Map<string, string>;
}

export interface BundleState {
  id: string;
  kind: Kind;
  main: string;
  notes: string;
  entries: BundleEntry[];
  /** The draft the form shows. */
  active: string;
  /** The form before the bundle arrived, for Discard. */
  origin: { creating: Kind | null; draft: Record<string, unknown> | null; sources: SourceSession | null };
}

/** The bundle's drafts as entries. A follow-up keeps what was already saved. */
export function entriesOf(bundle: SetupBundle, pages: PageInfo, base: LibraryRecord | null, previous: BundleEntry[] = []): BundleEntry[] {
  return bundle.records.map((record) => {
    const kept = previous.find((entry) => entry.ref === record.ref && entry.state === 'saved');
    if (kept) return kept;
    const definition: Record<string, unknown> = { ...record.definition };
    const links: Record<string, string> = {};
    for (const [name, link] of Object.entries(record.links)) {
      if (link.ref) links[name] = link.ref;
      else if (link.pin) definition[name] = link.pin;
    }
    const revises = record.ref === bundle.main ? base : null;
    const start = sessionOf(revises);
    const steve = fromSetupMarks({ sources: record.sources, estimates: record.estimates }, definition, pages, effective(start, definition));
    return { ref: record.ref, kind: record.kind as Kind, definition, links, session: { ...start, steve, notes: record.notes || start.notes },
      base: revises, state: 'draft' as const };
  });
}

/** Dependencies first: a record after every record it links to. */
export function saveOrder(entries: BundleEntry[]): BundleEntry[] {
  const out: BundleEntry[] = [];
  const seen = new Set<string>();
  const visit = (entry: BundleEntry) => {
    if (seen.has(entry.ref)) return;
    seen.add(entry.ref);
    for (const ref of Object.values(entry.links)) {
      const dependency = entries.find((item) => item.ref === ref);
      if (dependency) visit(dependency);
    }
    out.push(entry);
  };
  entries.forEach(visit);
  return out;
}

export const entryLabel = (entry: Pick<BundleEntry, 'kind' | 'definition'>) => `${KIND_LABELS[entry.kind]?.one ?? entry.kind} “${String(entry.definition.name ?? '')}”`;

/** The definition to save, its links filled with the pins of records saved first; a string says what's missing. */
export function toSave(entry: BundleEntry, entries: BundleEntry[]): Record<string, unknown> | string {
  const definition = { ...entry.definition };
  for (const [name, ref] of Object.entries(entry.links)) {
    const target = entries.find((item) => item.ref === ref);
    if (!target?.saved) return `${target ? entryLabel(target) : ref} has to be saved first.`;
    definition[name] = pinOf(target.saved);
  }
  return definition;
}

/** The same draft gives the same key (a retry replays a save that already happened); an edited draft a new one. */
export async function requestKeyFor(bundleId: string, ref: string, definition: unknown, provenance: RecordProvenance | undefined): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([definition, provenance ?? null]));
  return `setup:${bundleId}:${ref}:${(await sha256Hex(bytes.buffer as ArrayBuffer)).slice(0, 16)}`;
}

/** The bundle as the dialog holds it now, for STEVE's follow-ups. */
export function bundleItems(bundle: BundleState): BundleItem[] {
  return bundle.entries.map((entry) => {
    const marks = toSetupMarks(effective(entry.session, entry.definition));
    return {
      ref: entry.ref, kind: entry.kind, definition: entry.definition,
      links: Object.fromEntries(Object.entries(entry.links).map(([name, ref]) => [name, { ref }])),
      sources: marks.sources, estimates: marks.estimates, ...(entry.state === 'saved' ? { saved: true } : {}),
    };
  });
}

export const newBundleId = () => uuid();
