/**
 * Standard parts: search the step.parts catalog (open-source STEP models of bought-in parts, MIT) and insert one.
 * Inserting downloads the part's STEP file through the API (verified against the catalog's checksum), checks it like
 * an upload, then adds it as the Import dialog would: into the open part, as a component of the open design, or as a
 * new part — with a comment above the import naming the catalog part, its page, license and checksum.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Package, Search } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { ApiError, importInfo, importStandardPart, standardParts, type StandardPart, type StandardPartSearch } from '@/lib/api';
import { get, set, toast, useApp } from '@/state/store';
import { addImport } from '@/state/imports';
import CopyMessage from '@/shell/CopyMessage';
import styles from './StandardPartsDialog.module.css';
import { safeHref, standardPartImage } from '@/lib/safeUrl';

const SUGGESTIONS = ['608 bearing', 'M3 socket head', 'NEMA 17', 'GT2 pulley', '2020 extrusion', 'M5 hex nut'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `outerDiameterMm: 22` → "outer diameter 22 mm"; booleans show their label when true. */
function fact(name: string, value: string | number | boolean): string | null {
  if (value === false || value === '' || value === null) return null;
  const mm = /Mm$/.test(name);
  const label = name.replace(/Mm$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (value === true) return label;
  if (['nominal size', 'bearing code', 'thread'].includes(label)) return String(value);
  return `${label} ${value}${mm ? ' mm' : ''}`;
}

function Card({ part, selected, onSelect, onInsert, index }: { part: StandardPart; selected: boolean; onSelect: () => void; onInsert: () => void; index: number }) {
  // Catalogs repeat a value under two names (nominal size and bearing code): show each fact once.
  const facts = [...new Set(Object.entries(part.attributes).map(([name, value]) => fact(name, value)).filter(Boolean) as string[])].slice(0, 3);
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className={styles.card} aria-selected={selected} data-part={part.id} onClick={onSelect} onDoubleClick={onInsert}
      style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }} title={part.description ?? part.name}>
      <span className={styles.thumb}>
        {standardPartImage(part.thumbnail) && !broken ? <img src={standardPartImage(part.thumbnail)} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Package size={28} />}
      </span>
      <span className={styles.info}>
        <span className={styles.name}>{part.name}</span>
        <span className={styles.kind}>{[part.standard, part.family?.replaceAll('-', ' ')].filter(Boolean).join(' · ')}</span>
        {!!facts.length && <span className={styles.facts}>{facts.map((text) => <span key={text} className={styles.fact}>{text}</span>)}</span>}
      </span>
    </button>
  );
}

export default function StandardPartsDialog({ open }: { open: boolean }) {
  const doc = useApp((state) => state.doc);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [result, setResult] = useState<StandardPartSearch | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StandardPart | null>(null);
  const [inserting, setInserting] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { if (!inserting) set({ dialog: null }); };

  useEffect(() => { if (open) { setSelected(null); setError(null); setPage(1); requestAnimationFrame(() => input.current?.focus()); } }, [open]);

  // Debounced search; a newer query aborts the older request.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const found = await standardParts({ q: query, category: category ? [category] : [], page, pageSize: 24 }, controller.signal);
        setResult((previous) => (page > 1 && previous ? { ...found, items: [...previous.items, ...found.items] } : found));
        setError(null);
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') setError((caught as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, page > 1 ? 0 : 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query, category, page]);

  // The catalog's own categories (about fifteen; the counts are catalog-wide, not for this search, so they aren't shown).
  const categories = useMemo(() => result?.facets.categories ?? [], [result]);
  const target = doc.open && doc.kind === 'part' ? `Insert into ${doc.name || 'this part'}` : doc.open && doc.kind === 'design' ? `Add to ${doc.name || 'this design'}` : 'Insert as a new part';

  const insert = async (part: StandardPart | null) => {
    if (!part || inserting) return;
    if (get().busy) { toast('info', 'One moment', 'Wait for the current operation to finish.'); return; }
    setInserting(part.id); setError(null);
    try {
      let record = await importStandardPart(part.id);
      while (record.status === 'validating') {
        await sleep(600);
        record = { ...(await importInfo(record.id)), standard_part: record.standard_part };
      }
      if (record.status === 'failed') throw new Error(record.error ?? 'The geometry kernel couldn’t read this part.');
      set({ dialog: null });
      await addImport(record, record.standard_part.provenance);
    } catch (caught) {
      const message = caught instanceof ApiError && caught.status === 503 ? caught.message : (caught as Error).message;
      setError(`${part.name}: ${message}`);
    } finally {
      setInserting(null);
    }
  };

  const items = result?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={960} icon={<Package size={18} />} title="Standard parts"
      description="Open-source STEP models of bought-in parts: bearings, fasteners, motors, pulleys, extrusions, connectors and more. Inserted parts are checked like an imported STEP file."
      footer={<>
        <span className={styles.selection} id="standard-part-selection">
          {selected ? <><b>{selected.name}</b>{safeHref(selected.page) && <a href={safeHref(selected.page)} target="_blank" rel="noopener noreferrer">step.parts <ExternalLink size={11} /></a>}</>
            : <span className={styles.credit}>From <a href="https://www.step.parts" target="_blank" rel="noopener noreferrer">step.parts</a> · MIT licensed</span>}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={close} disabled={!!inserting}>Cancel</Button>
        <Button size="sm" variant="primary" id="insert-standard-part" disabled={!selected || !!inserting} onClick={() => void insert(selected)}>
          {inserting ? <><Spinner size={12} /> Checking the part…</> : target}
        </Button>
      </>}>
      <div className={styles.body} id="standard-parts">
        <div className={styles.searchRow}>
          <label className={styles.search}>
            <Search size={15} />
            <input ref={input} value={query} id="standard-parts-search" aria-label="Search standard parts" placeholder="608 bearing, M3 socket head 10, NEMA 17, GT2 pulley…"
              onChange={(event) => { setQuery(event.target.value); setPage(1); setSelected(null); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && selected) void insert(selected); }} />
          </label>
          <span className={styles.count} role="status">{loading ? 'Searching…' : result ? `${result.total.toLocaleString()} part${result.total === 1 ? '' : 's'}` : ''}</span>
        </div>
        {!!categories.length && (
          <div className={styles.chips} role="group" aria-label="Category">
            <button type="button" className={styles.chip} aria-pressed={!category} onClick={() => { setCategory(null); setPage(1); }}>All</button>
            {categories.map((item) => (
              <button key={item.value} type="button" className={styles.chip} aria-pressed={category === item.value} data-category={item.value}
                onClick={() => { setCategory(category === item.value ? null : item.value); setPage(1); setSelected(null); }}>
                {item.value.replaceAll('-', ' ')}
              </button>
            ))}
          </div>
        )}
        {error && <div className={styles.error} role="alert"><span>{error}</span><CopyMessage text={error} /></div>}
        <div className={styles.results}>
          {!items.length && !loading ? (
            <div className={styles.empty}>
              {query.trim() ? <span><strong>No parts match “{query.trim()}”.</strong><br />Try the designation without a vendor prefix, or the standard (ISO 4762, DIN 912).</span>
                : <span><strong>Search about {(result?.catalog.parts ?? 17000).toLocaleString()} parts</strong><br />{SUGGESTIONS.map((text, index) => (
                  <span key={text}>{index ? ' · ' : ''}<button type="button" className={styles.chip} style={{ marginTop: 8 }} onClick={() => setQuery(text)}>{text}</button></span>))}</span>}
            </div>
          ) : (
            <div className={styles.grid} role="listbox" aria-label="Standard parts">
              {items.map((part, index) => <Card key={part.id} part={part} index={index} selected={selected?.id === part.id} onSelect={() => setSelected(part)} onInsert={() => void insert(part)} />)}
            </div>
          )}
          {result?.has_next && !loading && <div className={styles.more}><Button size="sm" onClick={() => setPage(page + 1)}>Show more</Button></div>}
        </div>
      </div>
    </Dialog>
  );
}
