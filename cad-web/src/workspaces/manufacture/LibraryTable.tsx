/**
 * The library's record table: dense, sortable, filterable, keyboard-driven, like a CAM tool library. Columns come
 * from libraryColumns.ts; a narrow table gives way column by column down to a list of names.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, X } from 'lucide-react';
import type { Kind, LibraryRecord } from './api';
import type { OpenApi } from './schema';
import { KIND_LABELS, kindLabel } from './kinds';
import { cellText, columnsFor, enumOf, prettyValue, type Column, type Lookup } from './libraryColumns';
import TextNumber from './TextNumber';
import styles from './Manufacture.module.css';

interface Sort { column: string; descending: boolean }

export default function LibraryTable({ kind, records, lookup, api, selectedId, creating, tools, onSelect, onEdit, empty }: {
  kind: Kind | 'all';
  /** This kind's records (archived ones included when shown). */
  records: LibraryRecord[];
  lookup: Lookup;
  api: OpenApi | null;
  selectedId: string | null;
  /** A new record's name while it's being created (shown as the first row). */
  creating: string | null;
  /** The toolbar's actions (New…). */
  tools: ReactNode;
  onSelect: (id: string) => void;
  onEdit: (record: LibraryRecord) => void;
  empty: string;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>({ column: 'name', descending: false });
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<{ min: string; max: string }>({ min: '', max: '' });
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => { setSort({ column: 'name', descending: false }); setChips(new Set()); setRange({ min: '', max: '' }); }, [kind]);

  // A column no listed record fills is left out (name, revision and date always show).
  const columns = useMemo(() => columnsFor(kind).filter((column) => ['name', 'revision', 'updated', 'kind'].includes(column.id)
    || records.some((record) => column.value(record, lookup) !== null)), [kind, records, lookup]);
  const chipColumn = columns.find((column) => column.chips);
  const rangeColumn = columns.find((column) => column.range);
  const choices = useMemo(() => {
    if (!chipColumn?.chips) return [];
    const counts = new Map<string, number>();
    for (const record of records) { const value = String(record.definition[chipColumn.chips] ?? ''); counts.set(value, (counts.get(value) ?? 0) + 1); }
    // The values these records use, in the schema's order (a chip for every possible value would mostly read 0).
    const order = enumOf(api, kind, chipColumn.chips);
    const present = [...counts.keys()].filter((value) => value);
    return [...order.filter((value) => counts.has(value)), ...present.filter((value) => !order.includes(value))]
      .map((value) => ({ value, count: counts.get(value) ?? 0 }));
  }, [chipColumn, records, api, kind]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const min = range.min === '' ? null : Number(range.min), max = range.max === '' ? null : Number(range.max);
    const shown = records.filter((record) => {
      if (chipColumn?.chips && chips.size && !chips.has(String(record.definition[chipColumn.chips] ?? ''))) return false;
      if (rangeColumn && (min !== null || max !== null)) {
        const value = rangeColumn.value(record, lookup);
        if (typeof value !== 'number' || (min !== null && value < min) || (max !== null && value > max)) return false;
      }
      return !needle || columns.some((column) => cellText(column, record, lookup).toLowerCase().includes(needle));
    });
    const column = columns.find((item) => item.id === sort.column) ?? columns[0];
    const direction = sort.descending ? -1 : 1;
    return shown.sort((a, b) => {
      const x = column.value(a, lookup), y = column.value(b, lookup);
      // Blank cells sort last either way.
      if (x === null || y === null) return x === y ? a.definition.name.localeCompare(b.definition.name) : x === null ? 1 : -1;
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return order * direction || a.definition.name.localeCompare(b.definition.name);
    });
  }, [records, search, chips, range, sort, columns, chipColumn, rangeColumn, lookup]);

  useEffect(() => {
    body.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const move = (step: number) => {
    if (!rows.length) return;
    const index = rows.findIndex((record) => record.id === selectedId);
    const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step));
    onSelect(rows[next].id);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); if (rows.length) onSelect(rows[event.key === 'Home' ? 0 : rows.length - 1].id); }
    else if (event.key === 'Enter') { const record = rows.find((item) => item.id === selectedId); if (record) { event.preventDefault(); onEdit(record); } }
  };
  const toggleSort = (column: Column) => setSort((current) => (current.column === column.id ? { column: column.id, descending: !current.descending } : { column: column.id, descending: false }));
  const filtered = !!search || chips.size > 0 || range.min !== '' || range.max !== '';

  return (
    <section className={styles.listPane} aria-label="Library records">
      <div className={styles.listTools}>
        <label className={styles.searchBox}>
          <Search size={13} />
          <input placeholder={`Search ${kind === 'all' ? 'the library' : KIND_LABELS[kind].many.toLowerCase()}`} aria-label="Search the library" value={search} onChange={(event) => setSearch(event.target.value)} />
          {search && <button type="button" aria-label="Clear the search" onClick={() => setSearch('')}><X size={12} /></button>}
        </label>
        {rangeColumn && (
          <div className={styles.rangeBox} data-range={rangeColumn.id} title={`${rangeColumn.label} range`}>
            <span>{rangeColumn.label}</span>
            <TextNumber min={0} step={0.1} placeholder="min" ariaLabel={`Minimum ${rangeColumn.label}`} value={range.min} onChange={(min) => setRange((current) => ({ ...current, min }))} />
            <i>–</i>
            <TextNumber min={0} step={0.1} placeholder="max" ariaLabel={`Maximum ${rangeColumn.label}`} value={range.max} onChange={(max) => setRange((current) => ({ ...current, max }))} />
            {rangeColumn.unit && <small>{rangeColumn.unit}</small>}
          </div>
        )}
        <span className={styles.toolsSpacer} />
        <span className={styles.rowCount} aria-live="polite">{filtered ? `${rows.length} of ${records.length}` : `${records.length}`}</span>
        {tools}
      </div>
      {choices.length > 1 && (
        <div className={styles.chipBar} role="group" aria-label={`Filter by ${chipColumn!.label.toLowerCase()}`}>
          {choices.map(({ value, count }) => (
            <button key={value} type="button" className={styles.filterChip} data-on={chips.has(value) || undefined} data-chip={value}
              aria-pressed={chips.has(value)} onClick={() => setChips((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; })}>
              {prettyValue(value)}<small>{count}</small>
            </button>
          ))}
          {chips.size > 0 && <button type="button" className={styles.chipClear} onClick={() => setChips(new Set())}>Clear</button>}
        </div>
      )}
      <div className={styles.tableWrap} tabIndex={0} onKeyDown={onKeyDown} data-library-table aria-label="Library records table">
        <table className={styles.libraryTable} role="grid" aria-label="Library records" aria-rowcount={rows.length + (creating ? 1 : 0)}>
          <thead>
            <tr>
              {columns.map((column) => {
                const on = sort.column === column.id;
                const numeric = column.unit !== undefined || column.id === 'revision';
                return (
                  <th key={column.id} data-col={column.id} data-priority={column.priority} data-numeric={numeric || undefined} aria-sort={on ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
                    <button type="button" onClick={() => toggleSort(column)} title={`Sort by ${column.label.toLowerCase()}`}>
                      <span>{column.label}</span>{column.unit && <small>{column.unit}</small>}
                      {on && (sort.descending ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={body}>
            {creating !== null && (
              <tr className={styles.row} aria-selected data-on data-new>
                <td data-col="name" data-priority={0}><span className={styles.rowName}><Plus size={13} /><span>{creating}</span></span><small className={styles.rowMeta}>Not saved yet</small></td>
                <td colSpan={columns.length - 1} data-priority={1} className={styles.rowNote}>Not saved yet</td>
              </tr>
            )}
            {rows.map((record) => {
              const Icon = kindLabel(record.kind).icon;
              const on = record.id === selectedId && creating === null;
              return (
                <tr key={record.id} className={styles.row} aria-selected={on} data-on={on || undefined} data-record={record.id} data-archived={record.archived || undefined}
                  onClick={() => onSelect(record.id)} onDoubleClick={() => onEdit(record)}>
                  {columns.map((column) => {
                    const text = cellText(column, record, lookup);
                    const numeric = column.unit !== undefined || column.id === 'revision';
                    if (column.id === 'name') {
                      return (
                        <td key={column.id} data-col="name" data-priority={0} title={record.definition.name}>
                          <span className={styles.rowName}><Icon size={13} /><span>{record.definition.name}</span>{record.archived && <em>archived</em>}</span>
                          <small className={styles.rowMeta}>{kindLabel(record.kind).one} · rev {record.revision}</small>
                        </td>
                      );
                    }
                    return (
                      <td key={column.id} data-col={column.id} data-priority={column.priority} data-numeric={numeric || undefined} title={text || undefined}>
                        {column.code && text ? <code>{text}</code> : text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && creating === null && <p className={styles.listEmpty}>{records.length ? 'Nothing matches.' : empty}</p>}
      </div>
    </section>
  );
}
