/**
 * Search JLCPCB's in-stock parts (GET /v1/electronics/parts) and place one pinned to its exact part: the element type
 * and value come from the result (a 10kΩ resistor, an AO3400A MOSFET, an AMS1117 as a chip), with
 * `footprint="jlcpcb:C…"` and `supplierPartNumbers`, so the board, BOM and assembly all use that part.
 */
import { useEffect, useRef, useState } from 'react';
import type { PartSpec } from '../parts/catalog';
import { ExternalLink, Search, X } from 'lucide-react';
import { Spinner } from '@/ui';
import { EditError, type EditResult, type Target } from '../code/types';
import { partFor } from '../parts/catalog';
import { elementForJlcPart, formatPrice, formatStock, plainQuery, rankJlcParts, type JlcElement, type JlcPart, type JlcSearch as Result } from '../parts/jlcpcb';
import { placePart } from '../parts/place';
import { PartIcon } from './symbols';
import styles from './Palette.module.css';
import { safeHref } from '@/lib/safeUrl';

export interface JlcSearchProps {
  code: string;
  /** A part was placed (place mode). */
  onChange?: (code: string, edit: EditResult & { name: string | null }) => void;
  /** A result was picked in the Parts tab: put it on the pointer in the schematic (double-click/Enter still places it). */
  onArm?: (part: PartSpec, props: Record<string, unknown>) => void;
  /** Bumped to focus the search (opening the Parts tab). */
  focusKey?: number;
  parent?: Target;
  autoFocus?: boolean;
  /** Start with this search (picking a part for something already in the circuit). */
  initialQuery?: string;
  /** Pick mode: a result was chosen for an existing part, instead of placing a new one. */
  onPick?: (part: JlcPart, element: JlcElement) => void;
}

type Status = { state: 'idle' } | { state: 'loading' } | { state: 'done'; result: Result } | { state: 'error'; message: string };

const OFFLINE = 'Can’t reach the parts search. Check your connection, then try again.';

async function request(query: string, signal: AbortSignal): Promise<Result> {
  // A network failure says only "Failed to fetch": say what it means.
  const response = await fetch(`/v1/electronics/parts?query=${encodeURIComponent(query)}&limit=20`, { signal }).catch((failure: unknown) => {
    if (signal.aborted) throw failure;
    throw new Error(OFFLINE);
  });
  const body = await response.json().catch(() => null) as (Result & { detail?: unknown }) | null;
  if (!response.ok) {
    const detail = body?.detail;
    const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && 'message' in detail ? String((detail as { message: unknown }).message) : null;
    throw Object.assign(new Error(message ?? (response.status === 503 ? 'The JLCPCB parts index can’t be reached right now. Try again in a moment.' : `The search didn’t work (error ${response.status}). Try again in a moment.`)), { status: response.status });
  }
  return body ?? { parts: [] };
}

/** Searches with values as plain numbers and the kind they imply: the index matches those exactly (4.7k → 4.7 kΩ only). */
const search = (query: string, signal: AbortSignal) => request(plainQuery(query), signal);

/** How old the stock figures are: "stock as of 6 h ago" (the index is refreshed nightly). */
function stockAge(parts: JlcPart[]): string | null {
  const times = parts.map((part) => Date.parse(part.stock_as_of ?? '')).filter(Number.isFinite);
  if (!times.length) return null;
  const hours = Math.max(0, (Date.now() - Math.min(...times)) / 3.6e6);
  return `Stock as of ${hours < 1 ? 'less than an hour' : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`} ago; it’s checked again before ordering.`;
}

export default function JlcSearch({ code, onChange, onArm, focusKey, parent, autoFocus, initialQuery, onPick }: JlcSearchProps) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusKey) { input.current?.focus(); input.current?.select(); } }, [focusKey]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setStatus({ state: 'idle' }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus({ state: 'loading' });
      search(text, controller.signal)
        .then((result) => setStatus({ state: 'done', result: { ...result, parts: rankJlcParts(result.parts) } }))
        .catch((failure: unknown) => { if (!controller.signal.aborted) setStatus({ state: 'error', message: failure instanceof Error ? failure.message : String(failure) }); });
    }, 320);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, attempt]);

  /** A click: pick it for the inspector, else put it on the pointer (Parts tab), else place it. */
  const choose = (part: JlcPart) => {
    const element = elementForJlcPart(part);
    if (onPick) { onPick(part, element); return; }
    if (onArm) { onArm(partFor(element.tag) ?? partFor('chip')!, element.props); return; }
    place(part);
  };
  const place = (part: JlcPart) => {
    const element = elementForJlcPart(part);
    if (onPick) { onPick(part, element); return; }
    const spec = partFor(element.tag) ?? partFor('chip')!;
    try {
      const edit = placePart(code, spec, { parent, props: element.props });
      setError(null);
      onChange?.(edit.code, edit);
    } catch (failure) {
      if (!(failure instanceof EditError)) throw failure;
      setError(failure.message);
    }
  };
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-lcsc]') ?? [])];
  const parts = status.state === 'done' ? status.result.parts : [];

  return (
    <div className={styles.palette} id="circuit-jlcpcb">
      <div className={styles.search}>
        <Search size={13} />
        <input ref={input} autoFocus={autoFocus} aria-label="Search JLCPCB parts" placeholder="10k 0402, AMS1117, USB-C, ESP32-S3…" value={query} spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && parts[0]) { event.preventDefault(); choose(parts[0]); }
            if (event.key === 'ArrowDown') { event.preventDefault(); rows()[0]?.focus(); }
            if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
          }} />
        {status.state === 'loading' ? <Spinner size={12} /> : query && <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {status.state === 'error' && (
        <p className={styles.error} role="alert">
          <span>{status.message}</span>
          <button type="button" className={styles.retry} onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </p>
      )}
      {status.state === 'idle' && <p className={styles.none}>Search JLCPCB’s in-stock parts by value and package, part number or kind. Placed parts are pinned to that exact part for the BOM and assembly.</p>}
      <div className={styles.results} ref={list}
        onKeyDown={(event) => {
          const all = rows();
          const at = all.indexOf(document.activeElement as HTMLButtonElement);
          if (at < 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
          event.preventDefault();
          all[Math.min(all.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        }}>
        {parts.map((part) => {
          const element = elementForJlcPart(part);
          const value = element.props.resistance ?? element.props.capacitance ?? element.props.inductance ?? element.props.frequency ?? element.props.color;
          return (
            <div key={part.lcsc} className={styles.result} data-stock={part.in_stock ? 'in' : 'out'}>
              <button type="button" className={styles.resultMain} data-lcsc={part.lcsc} onClick={() => choose(part)}
                onDoubleClick={() => { if (onArm && !onPick) place(part); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && onArm && !onPick) { event.preventDefault(); place(part); } }}
                title={onPick ? `Use ${part.mpn} (${part.lcsc})` : onArm ? `${part.mpn} (${part.lcsc}): click, then click in the schematic to place it; double-click to add it without aiming`
                  : `Place ${part.mpn} (${part.lcsc}) as ${partFor(element.tag)?.label.toLowerCase() ?? element.tag}`}>
                <span className={styles.resultIcon}><PartIcon tag={element.tag} size={18} /></span>
                <span className={styles.resultText}>
                  <span className={styles.resultTitle}>
                    <b>{part.mpn}</b>
                    {value !== undefined && <span className={styles.value}>{String(value)}</span>}
                    {part.basic && <span className={styles.badge} data-tone="basic" title="Basic part: no loading fee for assembly">Basic</span>}
                    {!part.basic && part.preferred && <span className={styles.badge} data-tone="preferred" title="Preferred part: no loading fee for assembly">Preferred</span>}
                  </span>
                  <span className={styles.resultDescription}>{part.description}</span>
                  <span className={styles.resultMeta}>
                    <code>{part.lcsc}</code>
                    <span>{part.package}</span>
                    <span className={styles.stock}>{part.in_stock ? `${formatStock(part.stock)} in stock` : 'Out of stock'}</span>
                    <span>{formatPrice(part.unit_price_usd)}</span>
                  </span>
                </span>
              </button>
              {safeHref(part.url) && <a className={styles.resultLink} href={safeHref(part.url)} target="_blank" rel="noopener noreferrer" aria-label={`${part.lcsc} on JLCPCB`} title="Open on JLCPCB"><ExternalLink size={12} /></a>}
            </div>
          );
        })}
        {status.state === 'done' && !parts.length && <p className={styles.none}>{status.result.note ?? 'No in-stock part matched.'}</p>}
        {status.state === 'done' && parts.length > 0 && (
          // The server's note is written for STEVE (how to pin a part in TSX); people get the stock age and the fee rule.
          <p className={styles.footnote}>{[stockAge(parts), 'Basic and Preferred parts assemble without a loading fee.'].filter(Boolean).join(' ')}</p>
        )}
      </div>
    </div>
  );
}
