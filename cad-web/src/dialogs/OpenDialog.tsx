import StudioProjects from '@/studio/StudioProjects';
import {finishStudioBrowserExit,useStudio} from '@/studio/studio';
import { Fragment, memo, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as RDialog, DropdownMenu } from 'radix-ui';
import {
  AlertTriangle, ArrowDownUp, ChevronDown, ChevronRight, Copy, CornerDownLeft, ExternalLink, FilePlus2, Files, Folder as FolderIcon, FolderInput, FolderOpen,
  FolderPlus, GitBranch, LayoutGrid, Library, Link2, List, MoreHorizontal, PackagePlus, Pencil, RefreshCw, Search, Sparkles, SquareArrowOutUpRight, Trash2, X,
} from 'lucide-react';
import {
  Button, ContextContent, ContextItem, ContextLabel, ContextRoot, ContextSeparator, ContextTrigger, Dialog, IconButton, Menu, MenuContent,
  MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Segmented, Select, Spinner, ui,
} from '@/ui';
import { commands } from '@/commands';
import { Api, ApiError, isDocumentKind, type FileSummary, type Folder } from '@/lib/api';
import { BRANCH_COLORS, Branches, type Branch } from '@/lib/branches';
import { relativeTime } from '@/lib/format';
import {
  arrange, childSummary, duplicateDocument, folderChildren, folderPath, folderTrail, kindLabel, kindsIn, loadDocuments, loadFiles, matches, nest,
  renameDocument, summary, within, type KindFilter, type SortKey,
} from '@/lib/library';
import { adoptRename, linkDocument, openReferenceModel } from '@/state/actions';
import { get, set, useApp } from '@/state/store';
import { openHere, openTab } from '@/state/tabs';
import { openStudyOrProgram } from '@/state/files';
import { fileNewTab } from '@/state/newInFolder';
import { adoptFolders } from '@/state/libraries';
import { deletionCheck, moveToTrash, onTrashChange, UNDO_MS, type DeletionCheck } from '@/state/trash';
import { Trash } from '@/lib/trash';
import { ANALYSES, count, ease, exactTime, KindIcon, Message, ScrollRoot, Thumb } from './LibraryParts';
import TrashView from './TrashView';
import styles from './OpenDialog.module.css';

type View = 'grid' | 'list';
/** What Open filters to first in each workspace; All is one click away. */
const WORKSPACE_FILTERS: Record<string, string> = { electronics: 'circuit' };
/** Simulate and Manufacture list first the parts and designs that have their simulations or CAM programs. */
const WORKSPACE_CHILDREN: Record<string, string> = { simulate: 'study', manufacture: 'program' };
type Sample = { id: string; name: string; description: string };
type Notice = { tone: 'success' | 'danger'; text: string; undo?: () => void };

const PREFS = 'steve-open-browser';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'modified', label: 'Last modified' }, { value: 'name', label: 'Name' }, { value: 'created', label: 'Date created' },
];
function readPrefs(): { view: View; sort: SortKey } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) || '{}') as { view?: string; sort?: string };
    return { view: saved.view === 'list' ? 'list' : 'grid', sort: SORTS.some((item) => item.value === saved.sort) ? saved.sort as SortKey : 'modified' };
  } catch { return { view: 'grid', sort: 'modified' }; }
}

let samples: Promise<Sample[]> | null = null;
const loadSamples = () => (samples ??= Api.exampleCatalog().then(({ examples }) => examples).catch(() => { samples = null; return []; }));

/* ───────── Actions ───────── */

interface Handlers {
  openNew: (doc: FileSummary, branch?: string) => void;
  openHere: (doc: FileSummary) => void;
  rename: (doc: FileSummary) => void;
  renamed: (doc: FileSummary, name: string | null) => void;
  duplicate: (doc: FileSummary) => void;
  /** Deletes the document, or the whole selection when the document is part of it (to the Trash, with Undo). */
  remove: (doc: FileSummary) => void;
  /** Move to folder…: the document, or the whole selection when the document is part of it. */
  move: (doc: FileSummary) => void;
  /** List view: shows or hides what belongs to a part or design. */
  expand: (doc: FileSummary) => void;
}

const branchCache = new Map<string, Promise<Branch[] | null>>();
function useBranches(doc: FileSummary | null, delay = 0): Branch[] | null | undefined {
  const [state, setState] = useState<{ key: string; branches: Branch[] | null } | null>(null);
  const key = doc ? `${doc.id}:${doc.updated_at}` : '';
  useEffect(() => {
    if (!doc) return;
    if (!isDocumentKind(doc.kind)) { setState({ key, branches: null }); return; }  // Studies and programs: no branches here.
    let live = true;
    const timer = setTimeout(() => {
      let request = branchCache.get(key);
      if (!request) {
        request = Branches.available().then((available) => (available ? Branches.list(doc.id).then((list) => list.branches) : null)).catch(() => null);
        branchCache.set(key, request);
      }
      void request.then((branches) => { if (live) setState({ key, branches }); });
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [doc, key, delay]);
  return state?.key === key ? state.branches : undefined;
}

/** Open, branches, rename, duplicate, delete: the same items in the right-click menu and the card's ⋯ menu. `together`:
 * how many selected designs Delete applies to (this one among them). */
function DocActions({ doc, menu, handlers, renamable, together = 1 }: { doc: FileSummary; menu: 'context' | 'dropdown'; handlers: Handlers; renamable: true | string; together?: number }) {
  const Item = menu === 'context' ? ContextItem : MenuItem;
  const Separator = menu === 'context' ? ContextSeparator : MenuSeparator;
  const Label = menu === 'context' ? ContextLabel : MenuLabel;
  const branches = useBranches(doc)?.filter((branch) => branch.name !== 'main') ?? [];
  const openTabs = useApp((state) => state.tabs);
  const already = openTabs.some((tab) => tab.id === doc.id && tab.branch === 'main');
  return (
    <>
      <Item icon={<FolderOpen />} hint="This tab" onSelect={() => handlers.openHere(doc)}>Open</Item>
      <Item icon={<SquareArrowOutUpRight />} shortcut="Enter" onSelect={() => handlers.openNew(doc)}>{already ? 'Switch to its tab' : 'Open in new tab'}</Item>
      {branches.length > 0 && (
        <>
          <Separator />
          <Label>Branches</Label>
          {branches.slice(0, 6).map((branch) => (
            <Item key={branch.name} icon={<GitBranch />} hint={`r${branch.revision}`} onSelect={() => handlers.openNew(doc, branch.name)}>{branch.name}</Item>
          ))}
        </>
      )}
      <Separator />
      {menu === 'context'
        ? <ContextItem icon={<Pencil />} shortcut="F2" disabled={renamable !== true} reason={renamable === true ? undefined : renamable} onSelect={() => handlers.rename(doc)}>Rename</ContextItem>
        : <MenuItem icon={<Pencil />} shortcut="F2" disabled={renamable !== true} onSelect={() => handlers.rename(doc)}>Rename</MenuItem>}
      <Item icon={<Copy />} onSelect={() => handlers.duplicate(doc)}>Duplicate</Item>
      {/* Simulations and CAM programs stay with their part or design. */}
      {isDocumentKind(doc.kind) && <Item icon={<FolderInput />} onSelect={() => handlers.move(doc)}>{together > 1 ? `Move ${together} to folder…` : 'Move to folder…'}</Item>}
      <Separator />
      <Item icon={<Trash2 />} shortcut="Del" danger onSelect={() => handlers.remove(doc)}>{together > 1 ? `Delete ${together}` : 'Delete'}</Item>
    </>
  );
}

/* ───────── Entries ───────── */

function NameField({ doc, onDone, label = 'Name' }: { doc: { name: string }; onDone: (name: string | null) => void; label?: string }) {
  const [value, setValue] = useState(doc.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const since = useRef(0);
  const finish = (name: string | null) => { if (done.current) return; done.current = true; onDone(name); };
  useEffect(() => {
    since.current = performance.now();
    const timer = setTimeout(() => { ref.current?.focus(); ref.current?.select(); });
    return () => clearTimeout(timer);
  }, []);
  return (
    <input
      ref={ref}
      className={`${ui.input} ${styles.rename}`}
      aria-label={label}
      maxLength={100}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      // A menu closing right after "Rename" may take focus back once; keep editing.
      onBlur={() => { if (performance.now() - since.current < 400) ref.current?.focus(); else finish(value); }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(value);
        if (event.key === 'Escape') finish(null);
      }}
    />
  );
}

interface EntryProps {
  doc: FileSummary;
  index: number;
  selected: boolean;
  renaming: boolean;
  pending: boolean;
  openInTab: boolean;
  renamable: true | string;
  /** How many selected designs the ⋯ menu's Delete applies to. */
  together: number;
  handlers: Handlers;
  /** The simulations and CAM programs that belong to it (a part or design), and the ones a search matched. */
  childFiles?: FileSummary[];
  matched?: FileSummary[];
  /** List view: 1 for a child row under its part or design; whether a parent row shows its children. */
  depth?: 0 | 1;
  expanded?: boolean;
  /** Its folder's path, shown muted (all documents, and search results); null when it isn't shown. */
  path?: string | null;
  /** Can be dragged onto a folder (a part, design or circuit in the Open browser). */
  movable?: boolean;
}

/** What belongs to a part or design, on its card: "3 simulations · 1 CAM program" (or what a search matched), a menu
 * that opens any of them. The details panel lists them too, but it isn't there on narrow screens. */
function ChildrenChip({ files, matched, handlers }: { files: FileSummary[]; matched?: FileSummary[]; handlers: Handlers }) {
  const label = matched?.length ? `${matched[0].name}${matched.length > 1 ? ` +${matched.length - 1}` : ''}` : childSummary(files);
  const groups = (['study', 'program'] as const).map((kind) => [kind, files.filter((child) => child.kind === kind)] as const).filter(([, list]) => list.length);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.childChip} data-match={matched?.length ? '' : undefined} tabIndex={-1} aria-label={`${childSummary(files)}: open one`}
          title={matched?.length ? `Matches ${matched.map((child) => child.name).join(', ')}` : childSummary(files)}
          onClick={stop} onDoubleClick={stop}>
          {matched?.length ? <><KindIcon kind={matched[0].kind} size={11} /><span>{label}</span></> : <>
            <span className={styles.chipLong}>{label}</span>
            {/* Narrow cards: the same counts as kind icons. */}
            <span className={styles.chipShort}>{groups.map(([kind, list]) => <span key={kind}><KindIcon kind={kind} size={11} />{list.length}</span>)}</span>
          </>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${ui.menu} ${styles.childMenu}`} align="start" sideOffset={6} collisionPadding={10} loop onClick={stop}>
          {groups.map(([kind, list], index) => (
            <div key={kind}>
              {index > 0 && <MenuSeparator />}
              <MenuLabel>{kindLabel(kind, true)}</MenuLabel>
              {list.map((child) => (
                <MenuItem key={child.id} icon={<KindIcon kind={child.kind} />} onSelect={() => handlers.openNew(child)}>
                  <span className={styles.childText}><span>{child.name}</span><small>{childInfo(child)}</small></span>
                </MenuItem>
              ))}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A simulation's analysis and solves, or a CAM program's designs and jobs (and when it changed). */
function childInfo(child: FileSummary, withTime = true) {
  const parts = child.kind === 'study'
    ? [child.analysis ? ANALYSES[child.analysis] ?? child.analysis.replace(/_/g, ' ') : '', count(child.runs ?? 0, 'solve')]
    : [(child.designs ?? 0) > 1 ? `${child.designs} designs` : '', count(child.jobs ?? 0, 'CAM job')];
  return [...parts, withTime ? relativeTime(child.updated_at) : ''].filter(Boolean).join(' · ');
}

const Card = memo(function Card({ doc, index, selected, renaming, pending, openInTab, renamable, together, handlers, childFiles, matched, path, movable }: EntryProps) {
  const branches = doc.branch_count ?? 0;
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-id={doc.id}
      data-kind={doc.kind}
      draggable={(movable && !renaming) || undefined}
      className={`${styles.card} model-item`}
      style={{ animationDelay: `${Math.min(index * 18, 240)}ms` }}
    >
      <div className={styles.media}>
        <Thumb doc={doc} size="card" />
        <span className={styles.kindChip}><KindIcon kind={doc.kind} size={11} />{kindLabel(doc.kind)}</span>
        {openInTab && <span className={styles.openChip} title="Open in a tab"><i />Open</span>}
        {childFiles?.length ? <ChildrenChip files={childFiles} matched={matched} handlers={handlers} /> : null}
        {pending ? <span className={styles.more} data-busy><Spinner size={12} /></span> : (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={styles.more} aria-label={`More actions for ${doc.name}`} tabIndex={-1} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                <MoreHorizontal size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              {/* Focus stays where the chosen action puts it (the rename field), not on this button. */}
              <DropdownMenu.Content className={ui.menu} align="end" sideOffset={6} collisionPadding={10} loop onCloseAutoFocus={(event) => event.preventDefault()}>
                <DocActions doc={doc} menu="dropdown" handlers={handlers} renamable={renamable} together={together} />
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      <div className={styles.cardText}>
        {renaming ? <NameField doc={doc} onDone={(name) => handlers.renamed(doc, name)} /> : <div className={styles.cardName} title={doc.name}>{doc.name}</div>}
        <div className={styles.cardMeta}>
          <time dateTime={doc.updated_at} title={`Modified ${exactTime(doc.updated_at)}`}>{relativeTime(doc.updated_at)}</time>
          {path && <span className={styles.folderPath} title={`In ${path}`} data-testid="folder-path"><FolderIcon size={10} />{path}</span>}
          <span className={styles.counts}>
            {branches > 0 && <span title={`${count(branches, 'branch', 'branches')} besides main`}><GitBranch size={11} />{branches}</span>}
            <span title={count(doc.revision, 'version')}>v{doc.revision}</span>
          </span>
        </div>
      </div>
    </div>
  );
});

const Row = memo(function Row({ doc, index, selected, renaming, pending, openInTab, handlers, childFiles, depth = 0, expanded, path, movable }: EntryProps) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-expanded={childFiles?.length ? !!expanded : undefined}
      aria-level={depth + 1}
      tabIndex={selected ? 0 : -1}
      data-id={doc.id}
      data-kind={doc.kind}
      data-depth={depth}
      draggable={(movable && !renaming) || undefined}
      className={`${styles.row} model-item`}
      style={{ animationDelay: `${Math.min(index * 12, 200)}ms` }}
    >
      {depth === 1 ? <span /> : <Thumb doc={doc} size="row" />}
      <div className={styles.rowName}>
        {childFiles?.length ? (
          <button type="button" className={styles.disclosure} data-open={expanded || undefined} tabIndex={-1}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${childSummary(childFiles)}`} onClick={(event) => { stop(event); handlers.expand(doc); }} onDoubleClick={stop}>
            <ChevronRight size={13} />
          </button>
        ) : depth === 0 && <span className={styles.disclosureSpace} />}
        {renaming ? <NameField doc={doc} onDone={(name) => handlers.renamed(doc, name)} /> : <span className={styles.rowLabel} title={doc.name}>{doc.name}</span>}
        {path && <small className={styles.rowPath} title={`In ${path}`} data-testid="folder-path">{path}</small>}
        {childFiles?.length ? <small className={styles.rowChildren}>{childSummary(childFiles)}</small> : null}
        {depth === 1 && <small className={styles.rowChildren}>{childInfo(doc, false)}</small>}
        {openInTab && <span className={styles.openDot} title="Open in a tab" />}
        {pending && <Spinner size={11} />}
        <small className={styles.rowMeta}>{kindLabel(doc.kind)} · {relativeTime(doc.updated_at)}</small>
      </div>
      <span className={styles.rowKind}><KindIcon kind={doc.kind} />{kindLabel(doc.kind)}</span>
      <span className={styles.rowNum}>{doc.revision}</span>
      <span className={`${styles.rowNum} ${styles.rowBranches}`}>{doc.branch_count ?? '—'}</span>
      <time className={styles.rowTime} dateTime={doc.updated_at} title={exactTime(doc.updated_at)}>{relativeTime(doc.updated_at)}</time>
    </div>
  );
});

function Skeleton({ view }: { view: View }) {
  return (
    <div className={view === 'grid' ? styles.grid : styles.list} aria-hidden>
      {Array.from({ length: view === 'grid' ? 8 : 9 }, (_, index) => (
        view === 'grid'
          ? <div key={index} className={styles.skeletonCard} style={{ animationDelay: `${index * 60}ms` }}><span /><b /><i /></div>
          : <div key={index} className={styles.skeletonRow} style={{ animationDelay: `${index * 50}ms` }}><span /><b /><i /></div>
      ))}
    </div>
  );
}

/* ───────── Details ───────── */

/** The simulations and CAM programs of the selected part or design: each opens in a tab; right-click for the rest. */
function Children({ files, matched, renaming, handlers, renamable }: { files: FileSummary[]; matched: ReadonlySet<string>; renaming: string | null; handlers: Handlers; renamable: (doc: FileSummary) => true | string }) {
  const [menu, setMenu] = useState<FileSummary | null>(null);
  const groups = (['study', 'program'] as const).map((kind) => [kind, files.filter((child) => child.kind === kind)] as const).filter(([, list]) => list.length);
  return (
    <ContextRoot onOpenChange={(value) => { if (!value) setMenu(null); }}>
      <ContextTrigger asChild>
        <div onContextMenu={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>('[data-child-id]')?.dataset.childId;
          const child = files.find((item) => item.id === id);
          if (child) setMenu(child); else event.preventDefault();
        }}>
          {groups.map(([kind, list]) => (
            <div key={kind} className={styles.branches} data-testid={`file-${kind === 'study' ? 'simulations' : 'programs'}`}>
              <div className={`${styles.branchHead} caps`}>{kindLabel(kind, true)} <span>{list.length}</span></div>
              {list.map((child) => (renaming === child.id ? (
                <div key={child.id} className={styles.childRow} data-child-id={child.id}><KindIcon kind={child.kind} size={13} /><NameField doc={child} onDone={(name) => handlers.renamed(child, name)} /></div>
              ) : (
                <button key={child.id} type="button" className={styles.childRow} data-child-id={child.id} data-match={matched.has(child.id) || undefined}
                  onClick={() => handlers.openNew(child)} title={`Open ${child.name} in a new tab`}>
                  <KindIcon kind={child.kind} size={13} />
                  <span className={styles.childText}><span>{child.name}</span><small>{childInfo(child)}</small></span>
                  <ChevronRight size={13} />
                </button>
              )))}
            </div>
          ))}
        </div>
      </ContextTrigger>
      {menu && <ContextContent><DocActions doc={menu} menu="context" handlers={handlers} renamable={renamable(menu)} /></ContextContent>}
    </ContextRoot>
  );
}

function Details({ doc, openInTab, onOpenBranch, onOpenDesign, children }: { doc: FileSummary; openInTab: boolean; onOpenBranch: (branch: string) => void; onOpenDesign: (id: string) => void; children?: ReactNode }) {
  const branches = useBranches(doc, 140);
  const links = Object.keys((doc as { links?: Record<string, unknown> }).links ?? {}).length;
  return (
    <motion.div className={styles.detailInner} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease }}>
      <div className={styles.hero}><Thumb doc={doc} size="hero" eager /></div>
      <h3 className={styles.detailName} title={doc.name}>{doc.name}</h3>
      <div className={styles.detailKind} data-kind={doc.kind}>
        <KindIcon kind={doc.kind} />{kindLabel(doc.kind)}
        {openInTab && <><span>·</span><span className={styles.openText}><i />Open in a tab</span></>}
      </div>
      <dl className={styles.props}>
        <dt>Modified</dt><dd title={exactTime(doc.updated_at)}>{relativeTime(doc.updated_at)}</dd>
        <dt>Created</dt><dd title={exactTime(doc.created_at)}>{new Date(doc.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
        <dt>Versions</dt><dd>{doc.revision}</dd>
        {doc.folder_path && <><dt>Folder</dt><dd title={doc.folder_path}>{doc.folder_path}</dd></>}
        {(doc.kind === 'design' || doc.kind === 'shop') && links > 0 && <><dt>Links</dt><dd>{count(links, 'link')}</dd></>}
        {doc.kind === 'study' && doc.analysis && <><dt>Analysis</dt><dd>{ANALYSES[doc.analysis] ?? doc.analysis.replace(/_/g, ' ')}</dd></>}
        {doc.kind === 'study' && <><dt>Solves</dt><dd>{doc.runs ?? 0}</dd></>}
        {doc.kind === 'program' && <><dt>CAM jobs</dt><dd>{doc.jobs ?? 0}</dd></>}
      </dl>
      {!isDocumentKind(doc.kind) && (
        <div className={styles.branches} data-testid="file-design">
          <div className={`${styles.branchHead} caps`}>{doc.kind === 'program' && (doc.designs ?? 0) > 1 ? `Designs ${doc.designs}` : 'Design'}</div>
          {doc.design ? (
            <button type="button" className={styles.branchRow} onClick={() => onOpenDesign(doc.design!.id)} title="Open the design in a new tab">
              <KindIcon kind="design" size={12} />
              <span className={styles.branchName}>{doc.design.name ?? 'Deleted design'}</span>
              <small>{doc.kind === 'study' ? 'analysed' : 'machined'}</small>
              <ChevronRight size={13} />
            </button>
          ) : <small className={styles.branchLoading}>Its design was deleted.</small>}
        </div>
      )}
      {children}
      {branches !== null && (
        <div className={styles.branches}>
          <div className={`${styles.branchHead} caps`}>Branches {branches && <span>{branches.length}</span>}</div>
          {branches === undefined ? <div className={styles.branchLoading}><Spinner size={12} /></div> : branches.map((branch, index) => (
            <button key={branch.name} type="button" className={styles.branchRow} onClick={() => onOpenBranch(branch.name)} title={`Open ${branch.name} in a new tab`}>
              <i style={{ background: BRANCH_COLORS[index % BRANCH_COLORS.length] }} />
              <span className={styles.branchName}>{branch.name}</span>
              <small>{branch.name === 'main' ? `v${branch.revision}` : branch.ahead ? `${branch.ahead} ahead` : `r${branch.revision}`} · {relativeTime(branch.updated_at)}</small>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** Several designs selected: what they are, and what can be done with all of them. */
function SelectionDetails({ docs, onOpen, onDelete }: { docs: FileSummary[]; onOpen: () => void; onDelete: () => void }) {
  const kinds = [...new Set(docs.map((doc) => doc.kind))].map((value) => count(docs.filter((doc) => doc.kind === value).length, kindLabel(value).toLowerCase(), kindLabel(value, true).toLowerCase()));
  return (
    <motion.div className={styles.detailInner} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease }} data-testid="selection-details">
      <div className={styles.stack} data-count={Math.min(docs.length, 3)}>
        {docs.slice(0, 3).reverse().map((doc) => <div key={doc.id}><Thumb doc={doc} size="hero" eager /></div>)}
      </div>
      <h3 className={styles.detailName}>{count(docs.length, 'file')} selected</h3>
      <div className={styles.detailKind}>{kinds.join(' · ')}</div>
      <ul className={styles.selectionList}>
        {docs.slice(0, 8).map((doc) => <li key={doc.id} data-kind={doc.kind}><KindIcon kind={doc.kind} size={12} /><span>{doc.name}</span></li>)}
        {docs.length > 8 && <li className={styles.selectionMore}>and {docs.length - 8} more</li>}
      </ul>
      <div className={styles.selectionActions}>
        <Button size="sm" icon={<SquareArrowOutUpRight />} onClick={onOpen} disabled={!docs.some((doc) => isDocumentKind(doc.kind))}>Open in tabs</Button>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>Delete</Button>
      </div>
    </motion.div>
  );
}

/** Before deleting what something uses (or what has unsaved edits): what that means, then Move to Trash. */
function ConfirmDelete({ check, onCancel, onConfirm }: { check: DeletionCheck<FileSummary> | null; onCancel: () => void; onConfirm: () => void }) {
  const list = check ?? [];
  const one = list.length === 1;
  const flagged = list.filter((item) => item.references?.count || item.unsaved);
  const names = (item: DeletionCheck<FileSummary>[number]) => [
    ...(item.references?.designs ?? []).map((design) => design.name + (design.branches.length && !design.branches.includes('main') ? ` (${design.branches.join(', ')})` : '')),
    ...(item.references?.studies ?? []).map((study) => `${study.name} (study)`),
    ...(item.references?.programs ?? []).map((program) => `${program.name} (CAM)`),
  ];
  return (
    <Dialog open={!!check} onOpenChange={(open) => { if (!open) onCancel(); }} width={500} className={styles.confirm}
      icon={<span className={styles.confirmIcon}><Trash2 size={17} /></span>}
      title={one ? `Delete “${list[0].doc.name}”?` : `Delete ${count(list.length, 'file')}?`}
      description={one ? 'It goes to the Trash, where you can restore it.' : 'They go to the Trash, where you can restore them.'}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" icon={<Trash2 />} onClick={onConfirm} autoFocus id="confirm-delete">Move to Trash</Button>
      </>}>
      <ul className={styles.confirmList}>
        {flagged.map((item) => (
          <li key={item.doc.id}>
            {!one && <b>{item.doc.name}</b>}
            {item.usedBy && (
              <p data-testid="delete-used-by"><Link2 size={13} /><span>{item.usedBy}. Their pinned revisions keep working while it’s in the Trash.
                <small>{names(item).slice(0, 4).join(' · ')}{names(item).length > 4 ? ` · and ${names(item).length - 4} more` : ''}</small></span></p>
            )}
            {item.unsaved && <p data-tone="warning"><AlertTriangle size={13} /><span>Its open tab has unsaved edits. The tab closes; Undo brings it back.</span></p>}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ───────── Folders ───────── */

/** Renaming a folder, or naming a new one inside `create` (null: the top level). */
type FolderEdit = { rename: string } | { create: string | null };
type DropTarget = Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
/** What a drag from this browser carries (the ids; the browser keeps what they are). */
const DRAG_TYPE = 'application/x-steve-files';

/** What the folder tree and the breadcrumb do. A target is a folder's id, or null for All documents (the top level). */
interface FolderOps {
  /** Open browser (not Link): folders can be made, renamed, deleted, and files and folders dragged onto them. */
  manage: boolean;
  open: (id: string | null) => void;
  create: (parent: string | null) => void;
  rename: (folder: Folder) => void;
  remove: (folder: Folder) => void;
  /** Use as library, or Stop using as library (File → Libraries lists them). */
  library: (folder: Folder) => void;
  edited: (name: string | null) => void;
  drop: (target: string | null) => DropTarget;
  dragFolder: (id: string, event: DragEvent) => void;
  dragEnd: () => void;
}

/** "New folder", or "New folder 2", … when that's taken among the siblings. */
function freshName(siblings: Folder[]) {
  const taken = new Set(siblings.map((folder) => folder.name.toLowerCase()));
  let name = 'New folder';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New folder ${n}`;
  return name;
}

function editedName(edit: FolderEdit, folders: Folder[]) {
  return 'create' in edit ? freshName(folderChildren(folders).get(edit.create) ?? []) : folders.find((folder) => folder.id === edit.rename)?.name ?? '';
}

/** Beside the list: All documents, then the folders. Click opens one; right-click (or F2, Del) for the rest. */
function FolderTree({ folders, here, counts, total, edit, dropOn, ops }: {
  folders: Folder[]; here: string | null; counts: ReadonlyMap<string, number>; total: number; edit: FolderEdit | null; dropOn: string | null; ops: FolderOps;
}) {
  const children = useMemo(() => folderChildren(folders), [folders]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<Folder | null | undefined>(undefined);
  const creating = edit && 'create' in edit ? edit.create : undefined;
  const renaming = edit && 'rename' in edit ? edit.rename : null;
  // The open folder (and one getting a new subfolder) shows with its way there expanded.
  const reveal = creating !== undefined ? creating : here;
  useEffect(() => {
    const trail = folderTrail(folders, reveal).map((folder) => folder.id);
    if (trail.length) setOpen((current) => (trail.every((id) => current.has(id)) ? current : new Set([...current, ...trail])));
  }, [folders, reveal]);
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pad = (depth: number) => ({ paddingLeft: 6 + depth * 14 });
  const field = (depth: number, icon: ReactNode) => (
    <div className={styles.folderRow} style={pad(depth)} data-editing>
      <span className={styles.folderToggle} data-empty />{icon}
      <NameField doc={{ name: edit ? editedName(edit, folders) : '' }} label="Folder name" onDone={ops.edited} />
    </div>
  );

  const node = (folder: Folder, depth: number): ReactNode => {
    const subs = children.get(folder.id) ?? [];
    const expanded = open.has(folder.id) && subs.length > 0;
    return (
      <Fragment key={folder.id}>
        {renaming === folder.id ? field(depth, <FolderIcon size={14} />) : (
          <button type="button" role="treeitem" aria-level={depth + 1} aria-selected={here === folder.id} aria-expanded={subs.length ? expanded : undefined}
            className={styles.folderRow} style={pad(depth)} data-folder-id={folder.id} data-drop={dropOn === folder.id || undefined}
            draggable={ops.manage || undefined} onDragStart={(event) => ops.dragFolder(folder.id, event)} onDragEnd={ops.dragEnd} {...ops.drop(folder.id)}
            onClick={() => ops.open(folder.id)}>
            <span className={styles.folderToggle} data-open={expanded || undefined} data-empty={!subs.length || undefined}
              onClick={(event) => { event.stopPropagation(); if (subs.length) toggle(folder.id); }}><ChevronRight size={12} /></span>
            {here === folder.id ? <FolderOpen size={14} /> : <FolderIcon size={14} />}
            <span className={styles.folderName} title={folder.name}>{folder.name}</span>
            {folder.library && <span className={styles.folderLibrary} title="Library: File → Libraries links from it" aria-label="Library" data-testid="folder-library"><Library size={12} /></span>}
            {counts.get(folder.id) ? <small>{counts.get(folder.id)}</small> : null}
          </button>
        )}
        {expanded && subs.map((sub) => node(sub, depth + 1))}
        {creating === folder.id && field(depth + 1, <FolderPlus size={14} />)}
      </Fragment>
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-folder-id]');
    if (!row || edit) return;
    const folder = folders.find((item) => item.id === row.dataset.folderId);
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-folder-id]')];
    const index = rows.indexOf(row);
    const hasSubs = !!folder && !!children.get(folder.id)?.length;
    switch (event.key) {
      case 'ArrowDown': rows[index + 1]?.focus(); break;
      case 'ArrowUp': rows[index - 1]?.focus(); break;
      case 'ArrowRight': if (folder && hasSubs && !open.has(folder.id)) toggle(folder.id); else rows[index + 1]?.focus(); break;
      case 'ArrowLeft':
        if (folder && hasSubs && open.has(folder.id)) toggle(folder.id);
        else if (folder) rows.find((element) => element.dataset.folderId === (folder.parent_id ?? ''))?.focus();
        break;
      case 'F2': if (folder && ops.manage) ops.rename(folder); break;
      case 'Delete': if (folder && ops.manage) ops.remove(folder); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <ContextRoot onOpenChange={(value) => { if (!value) setMenu(undefined); }}>
      <ContextTrigger asChild>
        <nav className={styles.folders} aria-label="Folders" data-testid="folder-tree" onKeyDown={onKeyDown}
          onContextMenu={(event) => {
            if (!ops.manage || edit) { event.preventDefault(); return; }
            const id = (event.target as HTMLElement).closest<HTMLElement>('[data-folder-id]')?.dataset.folderId;
            setMenu(id ? folders.find((folder) => folder.id === id) ?? null : null);
          }}>
          <div className={`${styles.foldersHead} caps`}>
            <span>Folders</span>
            {ops.manage && <IconButton label="New folder" description="Inside the folder that's open" small onClick={() => ops.create(here)} id="new-folder"><FolderPlus /></IconButton>}
          </div>
          <div role="tree" aria-label="Folders" className={styles.folderList}>
            <button type="button" role="treeitem" aria-level={1} aria-selected={here === null} className={styles.folderRow} style={pad(0)} data-folder-id=""
              data-drop={dropOn === '' || undefined} {...ops.drop(null)} onClick={() => ops.open(null)}>
              <span className={styles.folderToggle} data-empty /><Files size={14} /><span className={styles.folderName}>All documents</span>{total ? <small>{total}</small> : null}
            </button>
            {(children.get(null) ?? []).map((folder) => node(folder, 1))}
            {creating === null && field(1, <FolderPlus size={14} />)}
          </div>
        </nav>
      </ContextTrigger>
      {menu !== undefined && (
        <ContextContent>
          <ContextItem icon={<FolderPlus />} onSelect={() => ops.create(menu?.id ?? null)}>{menu ? 'New folder inside' : 'New folder'}</ContextItem>
          {menu && <>
            <ContextItem icon={<Pencil />} shortcut="F2" onSelect={() => ops.rename(menu)}>Rename</ContextItem>
            <ContextItem icon={<Library />} hint={menu.library ? undefined : 'File → Libraries'} onSelect={() => ops.library(menu)}>
              {menu.library ? 'Stop using as library' : 'Use as library'}
            </ContextItem>
            <ContextSeparator />
            <ContextItem icon={<Trash2 />} shortcut="Del" danger onSelect={() => ops.remove(menu)}>Delete folder</ContextItem>
          </>}
        </ContextContent>
      )}
    </ContextRoot>
  );
}

/** Narrow screens and phones: the open folder's path instead of the tree; its last menu goes into a subfolder. */
function FolderCrumbs({ folders, here, edit, dropOn, ops }: { folders: Folder[]; here: string | null; edit: FolderEdit | null; dropOn: string | null; ops: FolderOps }) {
  const trail = folderTrail(folders, here);
  const subs = folderChildren(folders).get(here) ?? [];
  const current = trail[trail.length - 1];
  return (
    <nav className={styles.crumbs} aria-label="Folder" data-testid="folder-crumbs">
      <button type="button" className={styles.crumb} data-folder-id="" data-current={here === null || undefined} data-drop={dropOn === '' || undefined}
        {...ops.drop(null)} onClick={() => ops.open(null)}>
        <Files size={13} /><span>All documents</span>
      </button>
      {trail.map((folder) => (
        <Fragment key={folder.id}>
          <ChevronRight size={12} className={styles.crumbSep} />
          <button type="button" className={styles.crumb} data-folder-id={folder.id} data-current={folder.id === here || undefined}
            data-drop={dropOn === folder.id || undefined} {...ops.drop(folder.id)} onClick={() => ops.open(folder.id)}>
            <span>{folder.name}</span>
          </button>
        </Fragment>
      ))}
      {edit ? (
        <span className={styles.crumbEdit}>
          {'create' in edit ? <FolderPlus size={13} /> : <Pencil size={13} />}
          <NameField doc={{ name: editedName(edit, folders) }} label="Folder name" onDone={ops.edited} />
        </span>
      ) : (subs.length > 0 || ops.manage) && (
        <Menu>
          <MenuTrigger asChild><button type="button" className={styles.crumbMore} aria-label="Folders here" title="Folders here"><ChevronDown size={14} /></button></MenuTrigger>
          <MenuContent align="start">
            {subs.map((folder) => <MenuItem key={folder.id} icon={<FolderIcon />} onSelect={() => ops.open(folder.id)}>{folder.name}</MenuItem>)}
            {ops.manage && <>
              {subs.length > 0 && <MenuSeparator />}
              <MenuItem icon={<FolderPlus />} onSelect={() => ops.create(here)}>New folder</MenuItem>
              {current && <MenuItem icon={<Pencil />} onSelect={() => ops.rename(current)}>Rename this folder</MenuItem>}
              {current && <MenuItem icon={<Library />} onSelect={() => ops.library(current)}>{current.library ? 'Stop using as library' : 'Use as library'}</MenuItem>}
              {current && <MenuItem icon={<Trash2 />} danger onSelect={() => ops.remove(current)}>Delete this folder</MenuItem>}
            </>}
          </MenuContent>
        </Menu>
      )}
    </nav>
  );
}

/** Move to folder…: every folder, indented, with All documents (the top level) first. */
function MoveToFolder({ targets, folders, onCancel, onMove }: { targets: FileSummary[] | null; folders: Folder[]; onCancel: () => void; onMove: (folder: string | null) => void }) {
  const list = targets ?? [];
  const rows = useMemo(() => {
    const children = folderChildren(folders);
    const out: { folder: Folder | null; depth: number }[] = [{ folder: null, depth: 0 }];
    const walk = (parent: string | null, depth: number) => { for (const folder of children.get(parent) ?? []) { out.push({ folder, depth }); walk(folder.id, depth + 1); } };
    walk(null, 1);
    return out;
  }, [folders]);
  const places = new Set(list.map((doc) => doc.folder_id ?? null));
  const now = places.size === 1 ? [...places][0] : undefined;
  return (
    <Dialog open={!!targets} onOpenChange={(open) => { if (!open) onCancel(); }} width={440} className={styles.confirm}
      icon={<span className={styles.confirmIcon} data-tone="move"><FolderInput size={17} /></span>}
      title={list.length === 1 ? `Move “${list[0].name}”` : `Move ${count(list.length, 'file')}`}
      description="Choose a folder. Versions, links and history stay as they are."
      footer={<Button onClick={onCancel}>Cancel</Button>}>
      <div className={styles.movePicker} data-testid="move-picker">
        {rows.map(({ folder, depth }) => {
          const id = folder?.id ?? null;
          return (
            <button key={id ?? ''} type="button" className={styles.moveRow} style={{ paddingLeft: 10 + depth * 16 }} data-folder-id={id ?? ''}
              disabled={id === now} onClick={() => onMove(id)}>
              {folder ? <FolderIcon size={14} /> : <Files size={14} />}
              <span>{folder ? folder.name : 'All documents (top level)'}</span>
              {id === now && <small>{list.length === 1 ? 'It’s here' : 'They’re here'}</small>}
            </button>
          );
        })}
        {rows.length === 1 && <p className={styles.moveEmpty}>No folders yet. Make one with New folder beside the list, then move files into it.</p>}
      </div>
    </Dialog>
  );
}

/** Deleting a folder that has something in it: what's in it moves up, nothing else is deleted. */
function ConfirmFolderDelete({ state, parentName, onCancel, onConfirm }: {
  state: { folder: Folder; folders: number; documents: number } | null; parentName: string; onCancel: () => void; onConfirm: () => void;
}) {
  const what = [state?.documents ? count(state.documents, 'file') : '', state?.folders ? count(state.folders, 'folder') : ''].filter(Boolean).join(' and ');
  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onCancel(); }} width={460} className={styles.confirm}
      icon={<span className={styles.confirmIcon}><Trash2 size={17} /></span>}
      title={state ? `Delete the folder “${state.folder.name}”?` : ''}
      description={`Its ${what || 'contents'} move up to ${parentName}. No file is deleted.`}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" icon={<Trash2 />} onClick={onConfirm} autoFocus id="confirm-folder-delete">Delete folder</Button>
      </>} />
  );
}

/* ───────── Empty ───────── */

const IsoArt = () => (
  <svg viewBox="0 0 120 120" fill="none" aria-hidden>
    <path d="M60 18 96 39v42L60 102 24 81V39Z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M24 39 60 60l36-21M60 60v42" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
    <path d="M60 18v42M24 81l36-21 36 21" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.35" />
  </svg>
);

/* ───────── Dialog ───────── */

/** `open`: open saved designs in tabs. `link`: the same browser to link a part or design into the open design. */
export type BrowseMode = 'open' | 'link';

export default function OpenDialog({ open, mode = 'open' }: { open: boolean; mode?: BrowseMode }) {
  return (
    <RDialog.Root open={open} onOpenChange={(value) => !value && set({ dialog: null })}>
      <AnimatePresence onExitComplete={finishStudioBrowserExit}>{open && <Browser mode={mode} />}</AnimatePresence>
    </RDialog.Root>
  );
}

function Browser({ mode }: { mode: BrowseMode }) {
  const linking = mode === 'link';
  const source=useStudio(s=>s.source);
  const studio=!linking&&source==='studio';
  const self = useApp((state) => state.doc.saved?.id ?? null);
  // A shop links other shops (never geometry); a design links parts, designs and circuits (never a shop).
  const shopLinks = useApp((state) => linking && state.doc.kind === 'shop');
  const circuitsEnabled = useApp((state) => state.workspaces.includes('electronics'));
  const [docs, setDocs] = useState<FileSummary[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  // Insert circuit board opens the picker on circuits; Link on everything.
  const ownKind = linking ? null : WORKSPACE_FILTERS[get().workspace] ?? null;
  const [kind, setKind] = useState<KindFilter>(() => (linking ? get().linkFilter : ownKind) || 'all');
  const [prefer] = useState(() => (linking ? null : WORKSPACE_CHILDREN[get().workspace] ?? null));
  // List view: parts and designs shown open (or closed, overriding a search that opened them).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => () => { if (linking) set({ linkFilter: null, linkFolder: null }); }, [linking]);
  const [{ view, sort }, setPrefs] = useState(readPrefs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Several selected (Ctrl/⌘-click, Shift-click, Ctrl+A); empty means just `selected`.
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<DeletionCheck<FileSummary> | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [menuDoc, setMenuDoc] = useState<FileSummary | null>(null);
  const [sampleList, setSampleList] = useState<Sample[]>([]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reveal = useRef<{ id: string; focus: boolean } | null>(null);
  const tabs = useApp((state) => state.tabs);
  // Folders: the open one (null: All documents), a name being edited, Move to folder…, a folder to delete with its contents.
  const manage = !linking;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersIn, setFoldersIn] = useState(false);
  // File → Libraries opens the link picker in that library.
  const [here, setHere] = useState<string | null>(() => (linking ? get().linkFolder : null));
  const [folderEdit, setFolderEdit] = useState<FolderEdit | null>(null);
  const [moving, setMoving] = useState<FileSummary[] | null>(null);
  const [folderDelete, setFolderDelete] = useState<{ folder: Folder; folders: number; documents: number } | null>(null);
  const dragging = useRef<{ files: FileSummary[] } | { folder: string } | null>(null);
  /** The folder a drag is over ('' for All documents). */
  const [dropOn, setDropOn] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setLoadingMore(true);
    branchCache.clear();
    (linking ? loadDocuments : loadFiles)((page: FileSummary[]) => { if (live) setDocs(page); })
      .catch((caught: Error) => { if (live) setError(caught.message || 'The server didn’t answer.'); })
      .finally(() => { if (live) setLoadingMore(false); });
    // Without its folders the list still works: everything shows under All documents.
    Api.folders().then(({ folders: list }) => { if (live) { setFolders(list); setFoldersIn(true); adoptFolders(list); } }).catch(() => undefined);
    return () => { live = false; };
  }, [attempt, linking]);
  // A folder deleted (here or elsewhere): back to All documents. (A library opened from File waits for the list.)
  useEffect(() => { if (foldersIn && here && !folders.some((folder) => folder.id === here)) setHere(null); }, [folders, foldersIn, here]);
  useEffect(() => { void loadSamples().then(setSampleList); }, []);
  const countTrash = () => { if (!linking) void Trash.list().then(({ documents }) => setTrashCount(documents.length)).catch(() => setTrashCount(null)); };
  useEffect(countTrash, [linking]);
  // Deleted here, restored by Undo or from the Trash: the list follows.
  useEffect(() => onTrashChange(() => { setAttempt((n) => n + 1); countTrash(); }), [linking]);
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify({ view, sort })); } catch { /* Optional. */ } }, [view, sort]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.undo ? UNDO_MS : notice.tone === 'danger' ? 8000 : 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  // Parts, designs and circuits at the top; each part's or design's simulations and CAM programs belong to it.
  const nested = useMemo(() => nest(docs ?? []), [docs]);
  const searching = query.trim() !== '';
  // Linking: everything but the design itself (the server refuses links that would loop back).
  // Linking places a part, design or circuit board in a design (docs/ELECTRONICS.md, "Circuits in CAD designs").
  const { entries, matchedOf, orphanStart, shown } = useMemo(() => {
    const childrenOf = (id: string) => nested.children.get(id) ?? [];
    const matchedOf = new Map<string, FileSummary[]>();
    if (searching) for (const [id, list] of nested.children) { const hits = list.filter((child) => matches(child.name, query)); if (hits.length) matchedOf.set(id, hits); }
    // A part or design shows when its name matches or something of it does; Simulate and Manufacture list first the
    // ones with their kind of children (the order is otherwise kept). A design links geometry: never a shop.
    // An open folder shows what's filed in it; a search looks in every folder. Linking from a library shows what's in
    // its subfolders too: it's one collection of parts.
    const wholeLibrary = linking && !!here && !!folders.find((folder) => folder.id === here)?.library;
    const inView = (doc: FileSummary) => searching || here === null || (doc.folder_id ?? null) === here
      || (wholeLibrary && !!doc.folder_id && within(folders, doc.folder_id, here!));
    let tops = arrange(nested.tops.filter((doc) => !linking || (doc.id !== self && (doc.kind === 'shop') === shopLinks)), '', kind, sort)
      .filter((doc) => (!searching || matches(doc.name, query) || matchedOf.has(doc.id)) && inView(doc));
    if (prefer) tops = [...tops.filter((doc) => childrenOf(doc.id).some((child) => child.kind === prefer)), ...tops.filter((doc) => !childrenOf(doc.id).some((child) => child.kind === prefer))];
    // Studies and programs whose part or design isn't listed (deleted, in the Trash): never hidden, after everything else
    // (once the whole list is in, so one whose design is on a later page isn't shown here meanwhile). They have no folder.
    const orphans = kind === 'all' && !linking && !loadingMore && (here === null || searching) ? arrange(nested.orphans, query, 'all', sort) : [];
    const entries: { doc: FileSummary; parent: string | null }[] = [];
    for (const doc of tops) {
      entries.push({ doc, parent: null });
      if (view !== 'list') continue;
      const open = toggled.get(doc.id) ?? matchedOf.has(doc.id);
      // Opened by a search: what matched; opened by hand: everything.
      if (open) for (const child of (toggled.get(doc.id) ? childrenOf(doc.id) : matchedOf.get(doc.id) ?? childrenOf(doc.id))) entries.push({ doc: child, parent: doc.id });
    }
    const orphanStart = entries.length;
    for (const doc of orphans) entries.push({ doc, parent: null });
    return { entries, matchedOf, orphanStart: orphans.length ? orphanStart : -1, shown: tops.length + orphans.length };
  }, [nested, query, searching, kind, sort, linking, shopLinks, self, prefer, loadingMore, view, toggled, here, folders]);
  // Paths show where documents from several folders are listed together: All documents, search results, a library.
  const showPaths = here === null || searching || (linking && !!folders.find((folder) => folder.id === here)?.library);
  // How many parts, designs and circuits each folder holds (directly), for the tree.
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of nested.tops) if (doc.folder_id) counts.set(doc.folder_id, (counts.get(doc.folder_id) ?? 0) + 1);
    return counts;
  }, [nested]);
  const visible = useMemo(() => entries.map((entry) => entry.doc), [entries]);
  const isOpen = (doc: FileSummary) => toggled.get(doc.id) ?? matchedOf.has(doc.id);
  const kinds = useMemo(() => kindsIn(nested.tops, ownKind), [nested, ownKind]);
  const selected = visible.find((doc) => doc.id === selectedId) ?? visible[0] ?? null;
  const chosen = useMemo(() => (marked.size ? visible.filter((doc) => marked.has(doc.id)) : selected ? [selected] : []), [marked, visible, selected]);
  const chosenIds = useMemo(() => new Set(chosen.map((doc) => doc.id)), [chosen]);
  const openIds = useMemo(() => new Set(tabs.filter((tab) => tab.id).map((tab) => tab.id!)), [tabs]);
  const dirtyMain = useMemo(() => new Set(tabs.filter((tab) => tab.id && tab.branch === 'main' && tab.dirty).map((tab) => tab.id!)), [tabs]);
  const renamable = (doc: FileSummary): true | string => (dirtyMain.has(doc.id) ? 'Save or discard its unsaved edits first.' : true);

  const card = (id: string) => scroller?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null;
  const select = (id: string, focus: boolean) => { setSelectedId(id); setMarked(new Set()); anchor.current = id; reveal.current = { id, focus }; };
  const mark = (ids: Iterable<string>, primary: string) => {
    const next = new Set(ids);
    setSelectedId(primary);
    setMarked(next.size > 1 ? next : new Set());
  };
  /** Ctrl/⌘-click: adds or removes one design. */
  const toggle = (id: string) => {
    const next = new Set(marked.size ? marked : selected ? [selected.id] : []);
    if (next.has(id)) next.delete(id); else next.add(id);
    anchor.current = id;
    mark(next, next.has(id) ? id : [...next][next.size - 1] ?? id);
  };
  /** Shift-click: everything between the last clicked design and this one. */
  const extend = (id: string) => {
    const from = visible.findIndex((doc) => doc.id === (anchor.current ?? selected?.id));
    const to = visible.findIndex((doc) => doc.id === id);
    if (from < 0 || to < 0) { select(id, true); return; }
    mark(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((doc) => doc.id), id);
  };
  const clearMarks = () => setMarked(new Set());
  useEffect(() => {
    const target = reveal.current;
    if (!target) return;
    const element = card(target.id);
    if (!element) return;
    reveal.current = null;
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (target.focus) element.focus({ preventScroll: true });
  });

  const close = () => set({ dialog: null });
  const actions = useRef<Handlers>(null!);
  actions.current = {
    openNew: (doc, branch) => {
      close();
      if (linking) { void linkDocument(doc.id, doc.name, doc.revision, [0, 0, 0]); return; }
      if (!isDocumentKind(doc.kind)) { openStudyOrProgram(doc); return; }
      openTab({ id: doc.id, ...(branch && branch !== 'main' ? { branch } : {}) });
    },
    openHere: (doc) => { close(); if (isDocumentKind(doc.kind)) openHere({ id: doc.id }); else openStudyOrProgram(doc, true); },
    rename: (doc) => { if (renamable(doc) === true) { if (visible.includes(doc)) setSelectedId(doc.id); setRenaming(doc.id); } },
    renamed: (doc, name) => { void finishRename(doc, name); },
    duplicate: (doc) => { void duplicate(doc); },
    remove: (doc) => { void requestDelete(chosenIds.has(doc.id) ? chosen : [doc]); },
    move: (doc) => { if (manage) setMoving((chosenIds.has(doc.id) ? chosen : [doc]).filter((item) => isDocumentKind(item.kind))); },
    expand: (doc) => setToggled((map) => new Map(map).set(doc.id, !isOpen(doc))),
  };
  // Stable, so unchanged cards skip re-rendering while the selection moves.
  const handlers = useMemo<Handlers>(() => ({
    openNew: (doc, branch) => actions.current.openNew(doc, branch),
    openHere: (doc) => actions.current.openHere(doc),
    rename: (doc) => actions.current.rename(doc),
    renamed: (doc, name) => actions.current.renamed(doc, name),
    duplicate: (doc) => actions.current.duplicate(doc),
    remove: (doc) => actions.current.remove(doc),
    move: (doc) => actions.current.move(doc),
    expand: (doc) => actions.current.expand(doc),
  }), []);

  /** Delete: straight to the Trash with Undo, unless something uses a design or it has unsaved edits (then ask). */
  const requestDelete = async (targets: FileSummary[]) => {
    if (!targets.length || linking) return;
    setPending(targets[0].id);
    const check = await deletionCheck(targets);
    setPending(null);
    if (check.some((item) => item.references?.count || item.unsaved)) setConfirm(check);
    else void performDelete(targets, '');
  };
  const performDelete = async (targets: FileSummary[], note: string) => {
    setConfirm(null);
    const deleted = await moveToTrash(targets, note);
    if (!deleted) return;
    // The toasts sit under this dialog: Undo is offered here too.
    setNotice({ tone: 'success', text: deleted.title, undo: () => { setNotice(null); deleted.undo(); } });
    const gone = new Set(deleted.ids);
    if (selected && !gone.has(selected.id)) {
      // A simulation or CAM program deleted from the details panel: the selection stays.
      setDocs((list) => list && list.filter((doc) => !gone.has(doc.id)));
      setMarked(new Set());
      return;
    }
    // The selection moves to the design after the deleted ones (or before, at the end of the list).
    const first = visible.findIndex((doc) => gone.has(doc.id));
    const rest = visible.filter((doc) => !gone.has(doc.id));
    const next = rest[Math.min(Math.max(first, 0), rest.length - 1)];
    setDocs((list) => list && list.filter((doc) => !gone.has(doc.id)));
    setMarked(new Set());
    setSelectedId(next?.id ?? null);
    if (next) reveal.current = { id: next.id, focus: !!scroller?.contains(document.activeElement) };
  };
  const confirmed = () => {
    if (!confirm) return;
    void performDelete(confirm.map((item) => item.doc), confirm.length === 1 ? confirm[0].usedBy : '');
  };
  /** Documents open in tabs; a study or program opens on its own (only one is active at a time). */
  const openAll = (docs: FileSummary[]) => {
    const documents = docs.filter((doc) => isDocumentKind(doc.kind));
    close();
    if (!documents.length) { if (docs[0]) openStudyOrProgram(docs[0]); return; }
    for (const doc of documents) openTab({ id: doc.id });
  };

  const finishRename = async (doc: FileSummary, value: string | null) => {
    setRenaming(null);
    const name = value?.trim().slice(0, 100);
    requestAnimationFrame(() => card(doc.id)?.focus({ preventScroll: true }));
    if (!name || name === doc.name) return;
    setPending(doc.id);
    setDocs((list) => list && list.map((item) => (item.id === doc.id ? { ...item, name } : item)));
    try {
      if (!isDocumentKind(doc.kind)) {
        const saved = await Api.renameFile(doc.id, name);
        setDocs((list) => list && list.map((item) => (item.id === doc.id ? saved : item)));
        setNotice({ tone: 'success', text: `Renamed to ${saved.name}` });
        return;
      }
      const saved = await renameDocument(doc.id, name);
      setDocs((list) => list && list.map((item) => (item.id === doc.id ? { ...item, ...summary(saved) } : item)));
      adoptRename(saved);
      set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === saved.id && tab.branch === 'main' && state.activeTab !== tab.key ? { ...tab, name: saved.name } : tab)) }));
      setNotice({ tone: 'success', text: `Renamed to ${saved.name}` });
    } catch (caught) {
      setDocs((list) => list && list.map((item) => (item.id === doc.id ? { ...item, name: doc.name } : item)));
      setNotice({ tone: 'danger', text: `Couldn’t rename ${doc.name}: ${(caught as Error).message}` });
    } finally {
      setPending(null);
    }
  };

  const duplicate = async (doc: FileSummary) => {
    setPending(doc.id);
    try {
      // A copy of a document goes in the original's folder.
      const copy: FileSummary = isDocumentKind(doc.kind)
        ? { ...summary(await duplicateDocument(doc.id, doc.folder_id ?? null)), branch_count: 0, folder_id: doc.folder_id ?? null, folder_path: doc.folder_path ?? null }
        : await Api.duplicateFile(doc.id, `${doc.name} copy`.slice(0, 200));
      setDocs((list) => [copy, ...(list ?? [])]);
      if (!arrange([copy], query, kind, sort).length) { setQuery(''); setKind('all'); }
      select(copy.id, true);
      setNotice({ tone: 'success', text: `Created ${copy.name}` });
    } catch (caught) {
      setNotice({ tone: 'danger', text: `Couldn’t duplicate ${doc.name}: ${(caught as Error).message}` });
    } finally {
      setPending(null);
    }
  };

  /* Folders */

  const folderName = (id: string | null) => (id ? folders.find((folder) => folder.id === id)?.name ?? 'the folder' : 'All documents');
  /** New folders from the server, and every listed document's path with them. */
  const refreshFolders = async () => {
    try {
      const { folders: list } = await Api.folders();
      setFolders(list);
      adoptFolders(list);
      setDocs((items) => items && items.map((item) => (item.folder_id ? { ...item, folder_path: folderPath(list, item.folder_id) } : item)));
    } catch { /* The next open shows them. */ }
  };
  const failed = (what: string, caught: unknown) => setNotice({ tone: 'danger', text: `Couldn’t ${what}: ${(caught as Error).message}` });

  /** Files documents in a folder (null: the top level), with Undo. Studies and programs stay with their part or design. */
  const moveFiles = async (targets: FileSummary[], folder: string | null) => {
    setMoving(null);
    const list = targets.filter((doc) => isDocumentKind(doc.kind) && (doc.folder_id ?? null) !== folder);
    if (!list.length) return;
    setPending(list[0].id);
    const results = await Promise.allSettled(list.map((doc) => Api.placeDocument(doc.id, folder)));
    setPending(null);
    const done = list.filter((_, index) => results[index].status === 'fulfilled');
    const ids = new Set(done.map((doc) => doc.id));
    const path = folderPath(folders, folder);
    setDocs((items) => items && items.map((item) => (ids.has(item.id) ? { ...item, folder_id: folder, folder_path: path } : item)));
    setMarked(new Set());
    const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (refused) { failed(`move ${done.length ? `${list.length - done.length} of them` : list.length === 1 ? list[0].name : 'them'}`, refused.reason); return; }
    const undo = async () => {
      setNotice(null);
      const back = await Promise.allSettled(done.map((doc) => Api.placeDocument(doc.id, doc.folder_id ?? null)));
      const was = new Map(done.filter((_, index) => back[index].status === 'fulfilled').map((doc) => [doc.id, doc]));
      setDocs((items) => items && items.map((item) => { const before = was.get(item.id); return before ? { ...item, folder_id: before.folder_id ?? null, folder_path: before.folder_path ?? null } : item; }));
    };
    setNotice({ tone: 'success', text: `Moved ${done.length === 1 ? done[0].name : count(done.length, 'file')} to ${folder ? folderName(folder) : 'the top level'}`, undo: () => { void undo(); } });
  };

  const createFolder = async (parent: string | null, name: string) => {
    try {
      const folder = await Api.createFolder(name, parent);
      await refreshFolders();
      setNotice({ tone: 'success', text: `Created the folder ${folder.name}` });
    } catch (caught) { failed('create the folder', caught); }
  };
  const updateFolder = async (folder: Folder, change: { name?: string; parent_id?: string | null }) => {
    try {
      const saved = await Api.updateFolder(folder.id, change);
      await refreshFolders();
      setNotice({ tone: 'success', text: change.name ? `Renamed to ${saved.name}` : `Moved ${saved.name} to ${saved.parent_id ? folderName(saved.parent_id) : 'the top level'}` });
    } catch (caught) { failed(change.name ? `rename ${folder.name}` : `move ${folder.name}`, caught); }
  };
  /** Use as library / Stop using as library: File → Libraries lists the library folders. */
  const toggleLibrary = async (folder: Folder) => {
    const library = !folder.library;
    setFolders((list) => list.map((item) => (item.id === folder.id ? { ...item, library } : item)));
    try {
      await Api.updateFolder(folder.id, { library });
      await refreshFolders();
      setNotice({ tone: 'success', text: library ? `${folder.name} is a library: link from it with File → Libraries` : `${folder.name} isn’t a library any more` });
    } catch (caught) {
      setFolders((list) => list.map((item) => (item.id === folder.id ? { ...item, library: folder.library } : item)));
      failed(library ? `make ${folder.name} a library` : `stop using ${folder.name} as a library`, caught);
    }
  };
  /** Deletes an empty folder at once; one with something in it asks first, then moves that up to its parent. */
  const deleteFolder = async (folder: Folder, up = false) => {
    setFolderDelete(null);
    try {
      await Api.deleteFolder(folder.id, up);
      const parent = folder.parent_id;
      if (here === folder.id) setHere(parent);
      setDocs((items) => items && items.map((item) => (item.folder_id === folder.id ? { ...item, folder_id: parent, folder_path: parent ? item.folder_path : null } : item)));
      await refreshFolders();
      setNotice({ tone: 'success', text: `Deleted the folder ${folder.name}` });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'folder_not_empty') {
        setFolderDelete({ folder, folders: Number(caught.data.folders ?? 0), documents: Number(caught.data.documents ?? 0) });
        return;
      }
      failed(`delete ${folder.name}`, caught);
    }
  };
  const folderEdited = (value: string | null) => {
    const edit = folderEdit;
    setFolderEdit(null);
    const name = value?.trim().slice(0, 100);
    if (!edit || !name) return;
    if ('create' in edit) { void createFolder(edit.create, name); return; }
    const folder = folders.find((item) => item.id === edit.rename);
    if (folder && name !== folder.name) void updateFolder(folder, { name });
  };

  // Dragging documents (the selection, when the dragged one is in it) or a folder onto a folder or the breadcrumb.
  const endDrag = () => { dragging.current = null; setDropOn(null); };
  const canDrop = (target: string | null) => {
    const drag = dragging.current;
    if (!drag || !manage) return false;
    if ('folder' in drag) {
      const folder = folders.find((item) => item.id === drag.folder);
      return !!folder && (folder.parent_id ?? null) !== target && !within(folders, target, drag.folder);
    }
    return drag.files.some((doc) => (doc.folder_id ?? null) !== target);
  };
  const dropTarget = (target: string | null): DropTarget => (!manage ? {} : {
    onDragOver: (event) => {
      if (!canDrop(target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropOn(target ?? '');
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropOn((value) => (value === (target ?? '') ? null : value));
    },
    onDrop: (event) => {
      event.preventDefault();
      const drag = dragging.current;
      const ok = canDrop(target);
      endDrag();
      if (!drag || !ok) return;
      if ('files' in drag) { void moveFiles(drag.files, target); return; }
      const folder = folders.find((item) => item.id === drag.folder);
      if (folder) void updateFolder(folder, { parent_id: target });
    },
  });
  const folderOps: FolderOps = {
    manage,
    open: (id) => { setHere(id); setSelectedId(null); clearMarks(); setFolderEdit(null); },
    create: (parent) => { if (manage) setFolderEdit({ create: parent }); },
    rename: (folder) => { if (manage) setFolderEdit({ rename: folder.id }); },
    remove: (folder) => { if (manage) void deleteFolder(folder); },
    library: (folder) => { if (manage) void toggleLibrary(folder); },
    edited: folderEdited,
    drop: dropTarget,
    dragFolder: (id, event) => {
      if (!manage) { event.preventDefault(); return; }
      dragging.current = { folder: id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, id);
    },
    dragEnd: endDrag,
  };

  const columns = () => {
    if (view === 'list' || !scroller) return 1;
    const grid = scroller.querySelector(`.${styles.grid}`);
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
  };
  const step = (delta: number, focus: boolean) => {
    if (!visible.length) return;
    const index = selected ? visible.indexOf(selected) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index < 0 ? 0 : index + delta))];
    select(next.id, focus);
  };
  const rowsPerPage = () => Math.max(1, Math.floor((scroller?.clientHeight ?? 400) / (view === 'grid' ? 260 : 56)));

  const onKeys = (event: KeyboardEvent, inSearch: boolean) => {
    if (studio || renaming || trashOpen || event.altKey) return;
    if (!inSearch && !linking && (event.ctrlKey || event.metaKey)) {
      // Ctrl/⌘+A selects every design shown; ⌘⌫ deletes, as in Finder.
      if (event.key.toLowerCase() === 'a' && visible.length) { mark(visible.map((doc) => doc.id), selected?.id ?? visible[0].id); event.preventDefault(); }
      if (event.key === 'Backspace' && chosen.length) { void requestDelete(chosen); event.preventDefault(); }
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const across = columns();
    switch (event.key) {
      case 'ArrowDown': step(across, !inSearch); break;
      case 'ArrowUp': step(-across, !inSearch); break;
      case 'ArrowRight':
        if (inSearch) return;
        // List view: Right opens a part's or design's simulations and CAM programs, Left closes them (or goes to the parent).
        if (view === 'list' && selected && nested.children.get(selected.id)?.length && !isOpen(selected) && !parentOf(selected)) handlers.expand(selected);
        else step(1, true);
        break;
      case 'ArrowLeft': {
        if (inSearch) return;
        const parent = view === 'list' && selected ? parentOf(selected) : null;
        if (parent) select(parent, true);
        else if (view === 'list' && selected && isOpen(selected) && nested.children.get(selected.id)?.length) handlers.expand(selected);
        else step(-1, true);
        break;
      }
      case 'PageDown': step(across * rowsPerPage(), !inSearch); break;
      case 'PageUp': step(-across * rowsPerPage(), !inSearch); break;
      case 'Home': if (inSearch) return; if (visible[0]) select(visible[0].id, true); break;
      case 'End': if (inSearch) return; if (visible.length) select(visible[visible.length - 1].id, true); break;
      case 'Enter': if (selected) handlers.openNew(selected); break;
      case 'F2': if (selected && !linking) handlers.rename(selected); break;
      case 'Delete': if (inSearch || linking || !chosen.length) return; void requestDelete(chosen); break;
      default:
        // Typing anywhere in the browser searches.
        if (inSearch || !(event.key.length === 1 || event.key === 'Backspace')) return;
        searchRef.current?.focus();
        setQuery((value) => (event.key === 'Backspace' ? value.slice(0, -1) : value + event.key));
    }
    event.preventDefault();
  };

  /** The part or design a list-view child row sits under. */
  const parentOf = (doc: FileSummary) => entries[visible.indexOf(doc)]?.parent ?? null;

  const entryFor = (target: EventTarget | null) => {
    const id = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-id]')?.dataset.id;
    return id ? visible.find((doc) => doc.id === id) ?? null : null;
  };

  const ready = docs !== null;
  // Top-level files: parts, designs and circuits, and studies or programs without one.
  const total = nested.tops.length + nested.orphans.length;
  const filtered = query.trim() !== '' || kind !== 'all' || here !== null;
  const noun = shopLinks ? 'shop' : linking ? 'document' : 'file';
  const status = !ready ? (error ? '' : `Loading ${noun}s…`)
    : `${filtered ? `${shown} of ${count(total, noun)}` : count(total, noun)}${error ? ' · the rest couldn’t load' : ''}`;
  // New part, design, … as the Document commands define them.
  const creators = commands.filter((cmd) => cmd.id.startsWith('doc.new.'));
  // A new document goes into the folder that's open when it's first saved.
  const create = (run: () => void) => {
    const folder = manage ? here : null;
    close();
    requestAnimationFrame(() => {
      const before = get().activeTab;
      run();
      const key = get().activeTab;
      if (folder && key && key !== before) fileNewTab(key, folder);
    });
  };
  const newItems = (
    <>
      {creators.map((cmd) => <MenuItem key={cmd.id} icon={<cmd.icon />} onSelect={() => create(cmd.run)}>{cmd.label}</MenuItem>)}
      {sampleList.length > 0 && <><MenuSeparator /><MenuLabel>Start from a sample</MenuLabel></>}
      {sampleList.map((sample) => <MenuItem key={sample.id} icon={<Sparkles />} onSelect={() => { close(); void openReferenceModel(sample.id); }}>{sample.name}</MenuItem>)}
    </>
  );

  let body: ReactNode;
  if (error && !docs?.length) {
    body = (
      <Message icon={<AlertTriangle size={30} strokeWidth={1.3} />} tone="danger" title={`Couldn’t load your ${noun}s`} actions={<Button icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
        {error}
      </Message>
    );
  } else if (!ready) {
    body = <Skeleton view={view} />;
  } else if (!total) {
    body = (
      <Message icon={<IsoArt />} tone="brand" title="No designs yet" actions={creators.map((cmd, index) => (
        <Button key={cmd.id} variant={index ? 'secondary' : 'primary'} icon={<cmd.icon />} onClick={() => create(cmd.run)}>{cmd.label}</Button>
      ))} extra={sampleList.length > 0 && (
        <div className={styles.samples}>
          <span className="caps">Or start from a sample</span>
          <div>{sampleList.slice(0, 4).map((sample) => <button key={sample.id} type="button" onClick={() => { close(); void openReferenceModel(sample.id); }}><Sparkles size={12} />{sample.name}</button>)}</div>
        </div>
      )}>
        Everything you save, and what STEVE makes for you, appears here with a preview of the model.
      </Message>
    );
  } else if (!visible.length && here !== null && !searching && kind === 'all') {
    body = (
      <Message icon={<FolderIcon size={28} strokeWidth={1.3} />} title={`${folderName(here)} is empty`}
        actions={<Button icon={<Files />} onClick={() => folderOps.open(null)}>Show all documents</Button>}>
        {manage ? 'Drag parts and designs onto it, or choose Move to folder… in a file’s menu.' : 'Nothing is filed here yet.'}
      </Message>
    );
  } else if (!visible.length) {
    body = (
      <Message icon={<Search size={28} strokeWidth={1.3} />} title={query.trim() ? `Nothing matches “${query.trim()}”` : `No ${kindLabel(kind, true).toLowerCase()} yet`}
        actions={<Button onClick={() => { setQuery(''); setKind('all'); setHere(null); searchRef.current?.focus(); }}>Show everything</Button>}>
        {query.trim() && kind !== 'all' ? `Searching ${kindLabel(kind, true).toLowerCase()} only.` : 'Search looks for every word in the name.'}
      </Message>
    );
  } else {
    const Entry = view === 'grid' ? Card : Row;
    body = (
      <ContextRoot onOpenChange={(value) => { if (!value) setMenuDoc(null); }}>
        <ContextTrigger asChild>
          <div
            id="model-list"
            role="listbox"
            aria-label={linking ? 'Designs' : 'Files'}
            className={view === 'grid' ? styles.grid : styles.list}
            onKeyDown={(event) => onKeys(event, false)}
            onPointerDown={(event) => {
              const doc = entryFor(event.target);
              // Ctrl/⌘ and Shift clicks change the selection on click; the primary design waits for that too.
              if (doc) { if (!linking) setMenuDoc(doc); if (!renaming && !event.ctrlKey && !event.metaKey && !event.shiftKey) setSelectedId(doc.id); }
            }}
            onMouseDown={(event: MouseEvent) => { if (event.shiftKey) event.preventDefault(); }}  // No text selection on Shift-click.
            onContextMenu={(event) => {
              const doc = entryFor(event.target);
              if (!doc || linking) { event.preventDefault(); if (doc) setSelectedId(doc.id); return; }
              setMenuDoc(doc);
              // Right-click inside a selection acts on all of it; elsewhere it selects just that design.
              if (!chosenIds.has(doc.id)) select(doc.id, false); else setSelectedId(doc.id);
            }}
            onClick={(event) => {
              const doc = entryFor(event.target);
              if (!doc || renaming === doc.id) return;
              // A tap on a phone opens; a click selects and a double-click opens.
              if ((event.nativeEvent as PointerEvent).pointerType === 'touch' && !marked.size) handlers.openNew(doc);
              else if (!linking && (event.ctrlKey || event.metaKey)) toggle(doc.id);
              else if (!linking && event.shiftKey) extend(doc.id);
              else select(doc.id, true);
            }}
            onDoubleClick={(event) => { const doc = entryFor(event.target); if (doc && renaming !== doc.id) handlers.openNew(doc); }}
            onDragStart={(event) => {
              const doc = entryFor(event.target);
              if (!doc || !manage || !isDocumentKind(doc.kind)) { event.preventDefault(); return; }
              // The selection goes together when the dragged file is in it.
              const files = (chosenIds.has(doc.id) ? chosen : [doc]).filter((item) => isDocumentKind(item.kind));
              dragging.current = { files };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(DRAG_TYPE, files.map((item) => item.id).join(','));
            }}
            onDragEnd={endDrag}
          >
            {view === 'list' && (
              <div className={styles.listHead} role="presentation">
                <span />
                <button type="button" data-active={sort === 'name' || undefined} onClick={() => setPrefs({ view, sort: 'name' })}>Name</button>
                <span className={styles.rowKind}>Kind</span>
                <span className={styles.rowNum}>Versions</span>
                <span className={`${styles.rowNum} ${styles.rowBranches}`}>Branches</span>
                <button type="button" data-active={sort === 'modified' || undefined} onClick={() => setPrefs({ view, sort: 'modified' })}>Modified</button>
              </div>
            )}
            {entries.map(({ doc, parent }, index) => (
              <Fragment key={`${parent ?? ''}/${doc.id}`}>
                {index === orphanStart && <div className={styles.groupHead} role="presentation" data-testid="orphans">Without a part or design</div>}
                <Entry
                  doc={doc}
                  index={index}
                  selected={chosenIds.has(doc.id)}
                  renaming={renaming === doc.id}
                  pending={pending === doc.id}
                  openInTab={openIds.has(doc.id)}
                  renamable={renamable(doc)}
                  together={chosen.length > 1 && chosenIds.has(doc.id) ? chosen.length : 1}
                  handlers={handlers}
                  childFiles={parent ? undefined : nested.children.get(doc.id)}
                  matched={parent ? undefined : matchedOf.get(doc.id)}
                  depth={parent ? 1 : 0}
                  expanded={!parent && isOpen(doc)}
                  path={showPaths && !parent ? doc.folder_path ?? null : null}
                  movable={manage && !parent && isDocumentKind(doc.kind)}
                />
              </Fragment>
            ))}
          </div>
        </ContextTrigger>
        {menuDoc && <ContextContent><DocActions doc={menuDoc} menu="context" handlers={handlers} renamable={renamable(menuDoc)}
          together={chosen.length > 1 && chosenIds.has(menuDoc.id) ? chosen.length : 1} /></ContextContent>}
      </ContextRoot>
    );
  }

  return (
    <RDialog.Portal forceMount>
      <RDialog.Overlay asChild forceMount>
        <motion.div className={ui.overlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      </RDialog.Overlay>
      <RDialog.Content
        asChild
        forceMount
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // Ready to type on a desktop; on a phone the keyboard would cover the designs, so it waits for a tap.
          if (matchMedia('(pointer: coarse)').matches) (event.currentTarget as HTMLElement | null)?.focus?.();
          else searchRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => { if (renaming || confirm || folderEdit || moving || folderDelete) event.preventDefault(); }}
      >
        <motion.div
          className={styles.dialog}
          id="open-dialog"
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 6 }}
          transition={{ type: 'spring', stiffness: 440, damping: 36, mass: 0.8 }}
        >
          <header className={styles.header}>
            <div className={styles.title}>
              <span className={styles.titleIcon} data-trash={trashOpen || undefined}>{linking ? <PackagePlus size={16} /> : trashOpen ? <Trash2 size={16} /> : <FolderOpen size={16} />}</span>
              <RDialog.Title>{linking ? (shopLinks ? 'Link a shop' : kind === 'circuit' ? 'Insert a circuit board' : circuitsEnabled ? 'Link a part, design or circuit board' : 'Link a part or design') : studio ? 'Studio projects' : trashOpen ? 'Trash' : 'Open'}</RDialog.Title>
            </div>
            {!studio&&<label className={styles.search}>
              <Search size={15} />
              <input
                ref={searchRef}
                id="model-search"
                className={ui.input}
                placeholder={trashOpen ? 'Search the Trash' : shopLinks ? 'Search shops' : linking ? 'Search parts and designs' : 'Search files'}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => { setQuery(event.target.value); setSelectedId(null); clearMarks(); }}
                onKeyDown={(event) => onKeys(event, true)}
              />
              <AnimatePresence>
                {query && (
                  <motion.button type="button" className={styles.clear} aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                    initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }}>
                    <X size={12} />
                  </motion.button>
                )}
              </AnimatePresence>
            </label>}
            <RDialog.Close asChild><IconButton label="Close" shortcut="Esc" className={styles.close}><X /></IconButton></RDialog.Close>
          </header>
          {!linking&&<nav className={styles.toolbar} aria-label="Project locations"><Button variant={!studio?'primary':'ghost'} onClick={()=>{useStudio.setState({source:'local'});setAttempt(n=>n+1);}}>On this machine</Button><Button variant={studio?'primary':'ghost'} onClick={()=>{useStudio.setState({source:'studio'});setTrashOpen(false);}}>Steve Studio</Button></nav>}
          {studio ? <StudioProjects /> : trashOpen ? <TrashView query={query} onBack={() => { setTrashOpen(false); searchRef.current?.focus(); }} onCount={setTrashCount} /> : <>
          <div className={styles.toolbar}>
            <AnimatePresence initial={false} mode="popLayout">
              {chosen.length > 1 ? (
                <motion.div key="selection" className={styles.selectionBar} id="selection-bar" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease }}>
                  <IconButton label="Clear selection" small onClick={clearMarks}><X /></IconButton>
                  <b>{chosen.length} selected</b>
                  <span className={styles.spacer} />
                  <Button size="sm" icon={<SquareArrowOutUpRight />} onClick={() => openAll(chosen)}>Open in tabs</Button>
                  {manage && (
                    <Button size="sm" icon={<FolderInput />} id="move-selected" disabled={!chosen.some((doc) => isDocumentKind(doc.kind))}
                      onClick={() => setMoving(chosen.filter((doc) => isDocumentKind(doc.kind)))}>Move to folder…</Button>
                  )}
                  <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => { void requestDelete(chosen); }} id="delete-selected">Delete</Button>
                </motion.div>
              ) : (
                <motion.div key="filters" className={styles.filters} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease }}>
                  <Segmented value={kind} onChange={(value) => { setKind(value); setSelectedId(null); clearMarks(); }} options={[{ value: 'all', label: 'All' }, ...kinds.map((value) => ({ value, label: kindLabel(value, true) }))]} />
                  <span className={styles.spacer} />
                  <div className={styles.sort}>
                    <ArrowDownUp size={13} />
                    <Select ariaLabel="Sort by" value={sort} onChange={(value) => setPrefs({ view, sort: value })} options={SORTS} />
                  </div>
                  <Segmented value={view} onChange={(value) => setPrefs({ view: value, sort })} options={[{ value: 'grid', icon: <LayoutGrid />, title: 'Grid' }, { value: 'list', icon: <List />, title: 'List' }]} />
                  {!linking && (
                    <Button variant="ghost" size="sm" icon={<Trash2 />} id="open-trash" className={styles.trashButton} onClick={() => { clearMarks(); setTrashOpen(true); }}
                      title="Deleted files: restore them, or delete them permanently">
                      Trash{trashCount ? <span className={styles.trashCount}>{trashCount}</span> : null}
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <FolderCrumbs folders={folders} here={here} edit={folderEdit} dropOn={dropOn} ops={folderOps} />
          <div className={styles.body} data-details={(error && !docs?.length) || (ready && !total) ? undefined : ''} data-folders="">
            <FolderTree folders={folders} here={here} counts={folderCounts} total={nested.tops.length} edit={folderEdit} dropOn={dropOn} ops={folderOps} />
            <div className={styles.scroller} ref={setScroller} data-view={view}>
              <ScrollRoot.Provider value={scroller}>
                <motion.div key={view} className={styles.pane} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}>
                  {body}
                </motion.div>
              </ScrollRoot.Provider>
            </div>
            <aside className={styles.detail} aria-label="Selected file">
              {chosen.length > 1
                ? <SelectionDetails docs={chosen} onOpen={() => openAll(chosen)} onDelete={() => { void requestDelete(chosen); }} />
                : selected
                  ? <Details key={selected.id} doc={selected} openInTab={openIds.has(selected.id)} onOpenBranch={(branch) => handlers.openNew(selected, branch)}
                      onOpenDesign={(id) => { close(); openTab({ id }); }}>
                      {!linking && nested.children.get(selected.id)?.length ? (
                        <Children files={nested.children.get(selected.id)!} matched={new Set((matchedOf.get(selected.id) ?? []).map((child) => child.id))}
                          renaming={renaming} handlers={handlers} renamable={renamable} />
                      ) : null}
                    </Details>
                  : ready && <p className={styles.detailEmpty}>Select a file to see its versions and what it belongs to.</p>}
            </aside>
          </div>
          <footer className={styles.footer}>
            <div className={styles.status} aria-live="polite">
              <motion.span key={notice?.text ?? 'status'} data-tone={notice?.tone} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
                {notice?.text ?? status}
              </motion.span>
              {notice?.undo && <button type="button" className={styles.undo} onClick={notice.undo} id="undo-delete">Undo</button>}
              {ready && loadingMore && <Spinner size={11} />}
            </div>
            <div className={styles.hints}>
              <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> select</span>
              {linking
                ? <span><kbd><CornerDownLeft size={10} /></kbd> link at its current revision</span>
                : <><span><kbd><CornerDownLeft size={10} /></kbd> open in a new tab</span><span><kbd>F2</kbd> rename</span><span><kbd>Del</kbd> delete</span></>}
            </div>
            {!linking && (
              <Menu>
                <MenuTrigger asChild><Button icon={<FilePlus2 />}>New</Button></MenuTrigger>
                <MenuContent align="end" side="top">{newItems}</MenuContent>
              </Menu>
            )}
            {linking
              ? <Button id="place-part" variant="primary" icon={<PackagePlus />} disabled={!selected} onClick={() => { if (selected) handlers.openNew(selected); }}>{shopLinks ? 'Link' : 'Link and place'}</Button>
              : <Button id="open-selected" variant="primary" icon={<ExternalLink />} disabled={!selected} onClick={() => { if (chosen.length > 1) openAll(chosen); else if (selected) handlers.openNew(selected); }}>
                {chosen.length > 1 ? `Open ${chosen.length}` : 'Open'}
              </Button>}
          </footer>
          </>}
          <ConfirmDelete check={confirm} onCancel={() => setConfirm(null)} onConfirm={confirmed} />
          <MoveToFolder targets={moving} folders={folders} onCancel={() => setMoving(null)} onMove={(folder) => { if (moving) void moveFiles(moving, folder); }} />
          <ConfirmFolderDelete state={folderDelete} parentName={folderDelete?.folder.parent_id ? `“${folderName(folderDelete.folder.parent_id)}”` : 'the top level'}
            onCancel={() => setFolderDelete(null)} onConfirm={() => { if (folderDelete) void deleteFolder(folderDelete.folder, true); }} />
        </motion.div>
      </RDialog.Content>
    </RDialog.Portal>
  );
}
