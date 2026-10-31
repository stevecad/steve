/**
 * Library import and export (docs/MANUFACTURING_LIBRARY_INTERCHANGE.md). An import is reviewed first (preview: the
 * whole batch is validated and rolled back) and then committed with the same request key and the reviewed source's
 * hash, all or nothing. Exports read exact revisions: a native JSON graph (with what the records use) or one kind as
 * CSV with the column mapping that imports it again.
 */
import { mfg, type Kind, type LibraryRecord, type Pin } from '../api';
import type { RecordProvenance } from '../provenance';

export interface TransferEntry {
  key: string;
  definition: Record<string, unknown>;
  archived?: boolean;
  provenance?: RecordProvenance | null;
  /** Where the entry came from (informational). */
  source_pin?: Pin | null;
  /** An existing record here to reuse instead of creating a copy; it must match completely. */
  reuse?: Pin | null;
  row?: number | null;
}
export interface NativeSource { version?: 1; format: 'native'; entries: TransferEntry[] }

export type Encoding = 'text' | 'number' | 'integer' | 'boolean' | 'json';
export type SourceUnits = 'native' | 'mm' | 'inch' | 'radian' | 'degree' | 'mm/min' | 'inch/min' | 'm/min' | 'ft/min' | 'kg' | 'g' | 'lb' | 'rpm' | 'mm3/min' | 'inch3/min';
export type Blank = 'omit' | 'null' | 'empty';
export interface CsvColumn { column: string; field: string; encoding?: Encoding; units?: SourceUnits; blank?: Blank }
export type ProvenanceKind = 'note' | 'catalog' | 'measured' | 'estimate';
export interface CsvSource {
  version?: 1; format: 'csv'; kind: Kind; content: string; columns: CsvColumn[];
  defaults?: Record<string, unknown>; delimiter?: ',' | ';' | '\t'; provenance_kind?: ProvenanceKind;
}
export type ImportSource = NativeSource | CsvSource;

export type ItemStatus = 'ready' | 'created' | 'reused' | 'invalid' | 'blocked';
export interface ImportItem { key: string; row?: number | null; status: ItemStatus; source_pin?: Pin | null; record?: LibraryRecord | null }
export interface ImportDiagnostic { entry?: string | null; row?: number | null; field?: string | null; column?: string | null; code: string; severity?: 'error' | 'warning'; message: string }
export interface ImportReport { source_sha256: string; valid: boolean; applied: boolean; items: ImportItem[]; diagnostics: ImportDiagnostic[] }

/** An external reference an export keeps but doesn't carry (a saved design, a geometry job, an uploaded file). */
export type ExternalRef = Record<string, unknown>;
export interface NativeExport { source: NativeSource; roots: string[]; external: ExternalRef[]; source_sha256: string }
export interface CsvExport { source: CsvSource; pins: Pin[]; diagnostics: ImportDiagnostic[] }

export const transfer = {
  preview: (key: string, source: ImportSource) => mfg<ImportReport>('/library-imports/preview', { body: { request_key: key, source } }),
  /** All or nothing; `sha256`: the reviewed source's hash (a changed source is refused). Retry with the same key and source. */
  commit: (key: string, source: ImportSource, sha256: string | null) =>
    mfg<ImportReport>('/library-imports', { body: { request_key: key, source, ...(sha256 ? { expected_source_sha256: sha256 } : {}) } }),
  exportNative: (pins: Pin[], dependencies = true) => mfg<NativeExport>('/library-exports/native', { body: { pins, dependencies } }),
  exportCsv: (pins: Pin[], fields?: string[]) => mfg<CsvExport>('/library-exports/csv', { body: { pins, ...(fields?.length ? { fields } : {}) } }),
};
