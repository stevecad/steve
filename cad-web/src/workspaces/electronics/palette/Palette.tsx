/**
 * The parts library in the Parts tab: every part people can put in a circuit, searchable and grouped by category, as a
 * compact list. Clicking a part puts it on the pointer in the schematic (`onArm`: click there to place it); a
 * double-click or Enter on it places it without aiming (`onPlace`). Rows can also be dragged onto a view
 * (`PART_DRAG_TYPE`; `partFromDrop` + `placePart(code, part, { at })`).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Spinner } from '@/ui';
import { CATEGORIES, partFor, searchParts, type Category, type PartSpec } from '../parts/catalog';
import { PART_DRAG_TYPE } from '../parts/place';
import { allParts } from '../parts/schema';
import { useCircuitEngine } from '../inspector/useEngine';
import { PartIcon } from './symbols';
import { searchJlcpcb } from './partsTab';
import styles from './Palette.module.css';

export interface PartPaletteProps {
  /** A part was picked: put it on the pointer in the schematic. */
  onArm: (part: PartSpec) => void;
  /** A part was double-clicked (or Enter on it): place it without aiming. */
  onPlace: (part: PartSpec) => void;
  /** The part on the pointer now (its row shows it). */
  armed?: string | null;
  /** Bumped to focus the search (opening the Parts tab). */
  focusKey?: number;
}

/** A dragged part, if the drag came from the library. */
export function partFromDrop(event: DragEvent | globalThis.DragEvent): PartSpec | null {
  const tag = event.dataTransfer?.getData(PART_DRAG_TYPE);
  return tag ? partFor(tag) ?? allParts().find((part) => part.tag === tag) ?? null : null;
}

/** What a row says beside its name: the default value and footprint (10k · 0402). */
function summary(part: PartSpec): string {
  const values = Object.entries(part.defaults).filter(([key]) => key !== 'name').map(([, value]) => value).filter((value) => typeof value === 'string' || typeof value === 'number');
  return values.slice(0, 2).join(' · ');
}

function Library({ onArm, onPlace, armed, focusKey }: PartPaletteProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'All'>('All');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusKey]);
  const parts = useMemo(() => allParts(), []);
  const present = useMemo(() => CATEGORIES.filter((item) => parts.some((part) => part.category === item)), [parts]);
  const shown = useMemo(() => searchParts(parts, query).filter((part) => category === 'All' || part.category === category), [parts, query, category]);
  const sections = present.map((item) => ({ category: item, parts: shown.filter((part) => part.category === item) })).filter((section) => section.parts.length);

  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-part]') ?? [])];
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -all.length, End: all.length }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && at === 0) { input.current?.focus(); return; }
    all[Math.min(all.length - 1, Math.max(0, at + step))]?.focus();
  };

  return (
    <div className={styles.palette} id="circuit-palette">
      <div className={styles.search}>
        <Search size={13} />
        <input ref={input} aria-label="Search parts" placeholder="Search parts: resistor, usb, 0603…" value={query} spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter picks the first match: it's on the pointer, ready to place.
            if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onArm(shown[0]); }
            if (event.key === 'ArrowDown') { event.preventDefault(); rows()[0]?.focus(); }
            if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
          }} />
        {query && <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}
      </div>
      <div className={styles.categories} role="tablist" aria-label="Categories" id="parts-categories">
        {(['All', ...present] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={category === item} className={styles.category} data-on={category === item || undefined} onClick={() => setCategory(item)}>{item}</button>
        ))}
      </div>
      <div className={styles.list} ref={list} onKeyDown={onListKey} role="listbox" aria-label="Parts">
        {sections.map((section) => (
          <section key={section.category} className={styles.section} aria-label={section.category}>
            {category === 'All' && <h4 className={styles.heading}>{section.category}</h4>}
            {section.parts.map((part) => (
              <button key={part.tag} type="button" role="option" aria-selected={armed === part.tag} className={styles.row} data-part={part.tag} data-armed={armed === part.tag || undefined}
                title={`${part.description} Click, then click in the schematic to place it; double-click to add it without aiming.`} draggable
                onClick={() => onArm(part)}
                onDoubleClick={() => onPlace(part)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onPlace(part); } }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(PART_DRAG_TYPE, part.tag);
                  event.dataTransfer.setData('text/plain', `<${part.tag} />`);
                  event.dataTransfer.effectAllowed = 'copy';
                }}>
                <span className={styles.rowIcon}><PartIcon tag={part.tag} size={18} /></span>
                <span className={styles.rowName}>{part.label}</span>
                <span className={styles.rowMeta}>{summary(part) || `<${part.tag}>`}</span>
              </button>
            ))}
          </section>
        ))}
        {!sections.length && (
          <div className={styles.noneBlock}>
            <p className={styles.none}>No part in the library matches “{query}”. JLCPCB has real, in-stock parts; any other tscircuit element can be written in the code.</p>
            <button type="button" className={styles.noneAction} id="parts-search-jlcpcb" onClick={() => searchJlcpcb(query)}><Search size={12} />Search JLCPCB for “{query}”</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The parts library. Loads the parser and prop schemas on first use. */
export default function PartPalette(props: PartPaletteProps) {
  const { ready, error } = useCircuitEngine();
  if (error) return <p className={styles.error} role="alert">Couldn’t load the parts: {error}</p>;
  if (!ready) return <p className={styles.none}><Spinner /> Loading parts…</p>;
  return <Library {...props} />;
}
