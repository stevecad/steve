/**
 * Where a library field's value came from, beside its label: ◆ opens its sources (pages with their titles and when
 * they were read, or a document, measurement, catalog or note); "estimate" means nobody confirmed it, so dependent
 * checks stay "not assessed". Marks come from STEVE's drafts and are saved with the record. While editing, a mark
 * (or the faint ◇ on an unmarked field) lets the person set or remove the source by hand. A collapsed group shows
 * how many marks it holds.
 */
import { useState } from 'react';
import { Popover } from 'radix-ui';
import { ExternalLink, Pencil, TriangleAlert, X } from 'lucide-react';
import { Button, ui } from '@/ui';
import { kindLabel, SOURCE_KINDS, type FieldSource, type SourceKind, type SourceLink } from '@/workspaces/manufacture/provenance';
import styles from './Setup.module.css';
import { safeHref } from '@/lib/safeUrl';

export interface FieldNote {
  /** Page URLs (STEVE's drafts); `links` carries their titles and times when known. */
  sources?: string[];
  links?: SourceLink[];
  estimate?: boolean;
  kind?: SourceKind;
  note?: string;
}

const web = (url: string) => /^https?:\/\//i.test(url);
function place(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host.replace(/^www\./, ''), rest: decodeURIComponent(parsed.pathname + parsed.search).replace(/\/$/, '') };
  } catch { return { host: url, rest: '' }; }
}
const day = (iso?: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
};
const linksOf = (note: FieldNote): SourceLink[] => (note.links?.length ? note.links : (note.sources ?? []).map((url) => ({ url }))).filter((link) => web(link.url));
const stop = { onClick: (event: React.MouseEvent) => event.stopPropagation() };

function Details({ note, label, onEdit, onRemove }: { note: FieldNote; label: string; onEdit?: () => void; onRemove?: () => void }) {
  const links = linksOf(note);
  const kind = note.kind ?? (note.estimate ? 'estimate' : 'web');
  return (
    <>
      <div className={`caps ${styles.popLabel}`}>{label} · {kind === 'estimate' ? 'estimate' : kindLabel(kind).toLowerCase()}</div>
      {kind === 'estimate' && <p className={styles.popText}>Not confirmed. Checks that depend on it stay “not assessed” until a source replaces it.</p>}
      {links.map((link) => {
        const { host, rest } = place(link.url);
        return (
          <a key={link.url} className={styles.sourceLink} href={safeHref(link.url)} target="_blank" rel="noopener noreferrer" title={link.url}>
            <span>{link.title || host}</span><small>{link.title ? host : rest || '/'}{day(link.retrieved_at) && ` · read ${day(link.retrieved_at)}`}</small><ExternalLink size={11} />
          </a>
        );
      })}
      {note.note && <p className={styles.popText} data-source-note>{note.note}</p>}
      {(onEdit || onRemove) && (
        <div className={styles.popActions}>
          {onEdit && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onEdit} id="source-edit">Change source</Button>}
          {onRemove && <Button size="sm" variant="ghost" icon={<X />} onClick={onRemove} id="source-remove">Remove</Button>}
        </div>
      )}
    </>
  );
}

function Editor({ note, label, onSave, onCancel }: { note?: FieldNote; label: string; onSave: (claim: FieldSource) => void; onCancel: () => void }) {
  const first = note ? linksOf(note)[0] : undefined;
  const [kind, setKind] = useState<SourceKind>(note?.kind ?? (note?.estimate ? 'estimate' : 'measured'));
  const [url, setUrl] = useState(first?.url ?? '');
  const [title, setTitle] = useState(first?.title ?? '');
  const [text, setText] = useState(note?.note ?? '');
  const wantsLink = kind === 'web' || kind === 'catalog' || kind === 'document';
  const badUrl = url.trim() !== '' && !web(url.trim());
  const missing = kind === 'web' && !url.trim();
  const save = () => {
    const links = wantsLink && url.trim() ? [{ url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(first?.url === url.trim() && first.retrieved_at ? { retrieved_at: first.retrieved_at } : {}) }] : [];
    onSave({ kind, ...(links.length ? { urls: links } : {}), ...(text.trim() ? { note: text.trim() } : {}) });
  };
  return (
    <form className={styles.sourceForm} id="source-form" onSubmit={(event) => { event.preventDefault(); if (!badUrl && !missing) save(); }}>
      <div className={`caps ${styles.popLabel}`}>{label} · source</div>
      <label><span>From</span>
        <select value={kind} aria-label="Source kind" onChange={(event) => setKind(event.target.value as SourceKind)}>
          {SOURCE_KINDS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
        </select>
      </label>
      <small className={styles.formHint}>{SOURCE_KINDS.find((item) => item.kind === kind)?.hint}</small>
      {wantsLink && (
        <>
          <label><span>Link{kind === 'web' ? '' : ' (optional)'}</span><input value={url} placeholder="https://…" aria-label="Source link" spellCheck={false} onChange={(event) => setUrl(event.target.value)} data-invalid={badUrl || undefined} /></label>
          <label><span>Title</span><input value={title} placeholder="Optional" aria-label="Source title" onChange={(event) => setTitle(event.target.value)} /></label>
        </>
      )}
      <label><span>Note</span><textarea rows={2} value={text} placeholder={kind === 'measured' ? 'How and when it was measured' : 'Optional'} aria-label="Source note" maxLength={4096} onChange={(event) => setText(event.target.value)} /></label>
      {badUrl && <small className={styles.formError}>Links must start with http:// or https://.</small>}
      <div className={styles.popActions}>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" disabled={badUrl || missing} id="source-save">Save source</Button>
      </div>
    </form>
  );
}

/**
 * The mark beside a field label. `onSet` (while editing) lets the person set, change or remove the field's source;
 * the change is saved with the record.
 */
export default function FieldMarks({ note, label, onSet }: { note?: FieldNote; label: string; onSet?: (claim: FieldSource | null) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (!note && !onSet) return null;
  const links = note ? linksOf(note) : [];
  const estimate = !!note && (note.kind === 'estimate' || (!note.kind && note.estimate));
  const sourced = !!note && !estimate && (links.length > 0 || !!note.kind);
  const change = (value: boolean) => { setOpen(value); if (!value) setEditing(false); };
  const trigger = !note ? (
    <span role="button" tabIndex={0} className={styles.addSource} data-add-source aria-label={`${label}: set source`} title="Set where this value came from" {...stop}>◇</span>
  ) : estimate ? (
    <span role="button" tabIndex={0} className={styles.estimateMark} data-estimate-mark aria-label={`${label}: estimate`} title="An estimate: check it" {...stop}>
      <TriangleAlert size={10} strokeWidth={2.4} />estimate
    </span>
  ) : sourced ? (
    <span role="button" tabIndex={0} className={styles.sourceMark} data-source-mark data-kind={note.kind ?? 'web'} aria-label={`${label}: ${links.length > 1 ? `${links.length} sources` : `source (${kindLabel(note.kind ?? 'web').toLowerCase()})`}`} {...stop}>
      ◆{links.length > 1 && <small>{links.length}</small>}
    </span>
  ) : null;
  if (!trigger) return null;
  return (
    <span className={styles.marks}>
      <Popover.Root open={open} onOpenChange={change}>
        {/* A span, not a button: marks also sit inside a group's toggle button. */}
        <Popover.Trigger asChild onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); change(!open); } }}>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={`${ui.menu} ${styles.sourcesPop}`} side="top" align="start" sideOffset={6} collisionPadding={10} {...stop}>
            {editing || !note ? (
              <Editor note={note} label={label} onCancel={() => (note ? setEditing(false) : change(false))} onSave={(claim) => { onSet?.(claim); change(false); }} />
            ) : (
              <Details note={note} label={label} onEdit={onSet ? () => setEditing(true) : undefined} onRemove={onSet ? () => { onSet(null); change(false); } : undefined} />
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}

/** On a collapsed group: how many fields inside have a source, and how many are estimates. */
export function MarkCount({ sourced, estimated }: { sourced: number; estimated: number }) {
  if (!sourced && !estimated) return null;
  return (
    <span className={styles.markCount} data-mark-count>
      {sourced > 0 && <span className={styles.countSourced}>◆{sourced}</span>}
      {estimated > 0 && <span className={styles.countEstimated}><TriangleAlert size={9} strokeWidth={2.4} />{estimated}</span>}
    </span>
  );
}
