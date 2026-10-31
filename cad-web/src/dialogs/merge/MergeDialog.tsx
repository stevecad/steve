import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, GitMerge, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Dialog, Segmented, Spinner } from '@/ui';
import { get, set, toast, useApp } from '@/state/store';
import { applyDocumentRevision, openDocument, refreshBranches } from '@/state/actions';
import { Api, ApiError, type Build, type LinkRef } from '@/lib/api';
import { Branches, branchColor, branchOrder, type Comparison, type MergeBody, type MergeConflict } from '@/lib/branches';
import { areaText, lengthText, volumeText } from '@/lib/format';
import { useSetting } from '@/settings/store';
import CompareViewer, { type CompareMode } from './CompareViewer';
import SourceCompare from './SourceCompare';
import SourceEditor, { type SourceDiagnostic } from '@/panels/source/SourceEditor';
import styles from './Merge.module.css';

interface Block { start: number; end: number; ours: string; base: string; theirs: string }

/** Finds diff3 conflict blocks: <<<<<<< ours ||||||| base ======= theirs >>>>>>>. */
function conflictBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /^<{7}[^\n]*\n([\s\S]*?)(?:^\|{7}[^\n]*\n([\s\S]*?))?^={7}\n([\s\S]*?)^>{7}[^\n]*(?:\n|$)/gm;
  for (const match of text.matchAll(pattern)) {
    blocks.push({ start: match.index!, end: match.index! + match[0].length, ours: match[1] ?? '', base: match[2] ?? '', theirs: match[3] ?? '' });
  }
  return blocks;
}

const hasMarkers = (text: string) => /^(<{7}|={7}|>{7})/m.test(text);

const markerDiagnostics = (text: string): SourceDiagnostic[] => text.split('\n').flatMap((line, index) =>
  /^<{7}/.test(line) ? [{ line: index + 1, message: 'Unresolved conflict: choose a side above or edit this block', severity: 'warning' as const }] : []);

function Stat({ label, main, branch, format }: { label: string; main?: number; branch?: number; format: (value: number) => string }) {
  const delta = main !== undefined && branch !== undefined ? branch - main : undefined;
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className="tnum">{main !== undefined ? format(main) : '—'}</span>
      <span className="tnum">{branch !== undefined ? format(branch) : '—'}</span>
      <span className={`tnum ${styles.delta}`} data-sign={delta === undefined || Math.abs(delta) < 1e-6 ? 0 : delta > 0 ? 1 : -1}>{delta === undefined ? '' : Math.abs(delta) < 1e-6 ? '±0' : `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`}</span>
    </div>
  );
}

interface Failure { message: string; detail?: string; stale?: boolean }

function failure(caught: unknown): Failure {
  if (caught instanceof ApiError) {
    const detail = typeof caught.data.error === 'string' ? caught.data.error.trim().split('\n').pop() : undefined;
    return { message: caught.message, detail, stale: caught.code === 'stale_revision' };
  }
  return { message: (caught as Error).message };
}

export default function MergeDialog({ open }: { open: boolean }) {
  const name = useApp((state) => state.mergeBranch);
  const saved = useApp((state) => state.doc.saved);
  const branches = useApp((state) => state.branches);
  const graph = useApp((state) => state.graph);
  const units = useSetting('display.units');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [builds, setBuilds] = useState<{ main: Build | null; branch: Build | null }>({ main: null, branch: null });
  const [error, setError] = useState<Failure | null>(null);
  const [nonce, setNonce] = useState(0);
  const [linkChoice, setLinkChoice] = useState<Record<string, 'ours' | 'theirs'>>({});
  const [linkNames, setLinkNames] = useState<Record<string, string>>({});
  const [result, setResult] = useState('');
  const [mode, setMode] = useState<CompareMode>('overlay');
  const [pane, setPane] = useState<'changes' | 'result'>('changes');
  const [working, setWorking] = useState<'merge' | 'sync' | null>(null);
  const documentId = saved?.id;

  useEffect(() => {
    if (!open || !name || !documentId) return;
    let cancelled = false;
    setComparison(null); setError(null); setMode('overlay'); setPane('changes'); setLinkChoice({});
    Branches.compare(documentId, name).then(async (data) => {
      if (cancelled) return;
      setComparison(data);
      setResult(data.merge.code ?? data.branch.code);
      if (data.merge.status === 'conflict') setPane('result');
      const ids = [...new Set(data.merge.conflicts.flatMap((item) => (item.kind === 'link' ? [item.ours, item.theirs] : []))
        .filter((value): value is string => !!value).map((value) => unpackLink(value).document_id))];
      void Promise.all(ids.map((id) => Api.document(id).then((doc) => [id, doc.name] as const).catch(() => [id, 'Unavailable document'] as const)))
        .then((pairs) => { if (!cancelled) setLinkNames(Object.fromEntries(pairs)); });
      const [main, branch] = await Promise.all([
        data.main.preview_build_id ? Api.build(data.main.preview_build_id).catch(() => null) : null,
        data.branch.preview_build_id ? Api.build(data.branch.preview_build_id).catch(() => null) : null,
      ]);
      if (!cancelled) setBuilds({ main, branch });
    }).catch((caught: unknown) => { if (!cancelled) setError(failure(caught)); });
    return () => { cancelled = true; };
  }, [open, name, documentId, nonce]);

  const order = branchOrder(branches, graph);
  const color = name ? branchColor(name, order) : '#a99bff';
  const blocks = useMemo(() => conflictBlocks(result), [result]);
  const linkConflicts = (comparison?.merge.conflicts ?? []).filter((item) => item.kind === 'link');
  const codeConflict = (comparison?.merge.conflicts ?? []).some((item) => item.kind === 'code');
  const openLinks = linkConflicts.filter((item) => !linkChoice[item.alias!]).length;
  const unresolved = hasMarkers(result) || openLinks > 0;
  const status = comparison?.merge.status;
  const close = () => set({ dialog: null });

  const resolve = (block: Block, choice: 'ours' | 'theirs' | 'both') => {
    const replacement = choice === 'ours' ? block.ours : choice === 'theirs' ? block.theirs : block.ours + block.theirs;
    setResult((text) => text.slice(0, block.start) + replacement + text.slice(block.end));
  };

  /** The compared revisions plus whatever the user resolved or edited. */
  const body = (): MergeBody => {
    const links = Object.fromEntries(Object.entries(comparison!.merge.links ?? {}).map(([alias, value]) => [alias, unpackLink(value)]));
    for (const item of linkConflicts) {
      const value = linkChoice[item.alias!] === 'theirs' ? item.theirs : item.ours;
      if (value) links[item.alias!] = unpackLink(value); else delete links[item.alias!];
    }
    return {
      main_revision: comparison!.main.revision,
      branch_revision: comparison!.branch.revision,
      ...(codeConflict || result !== comparison!.merge.code ? { code: result } : {}),
      ...(linkConflicts.length ? { links } : {}),
    };
  };

  const merge = async () => {
    if (!comparison || !documentId || !name) return;
    setError(null);
    setWorking('merge');
    set({ busy: true, phase: 'running', phaseLabel: `Merging ${name} into main`, phaseStarted: Date.now() });
    try {
      const response = await Branches.merge(documentId, name, body());
      set({ busy: false, dialog: null });
      if (get().doc.branch === 'main') await applyDocumentRevision(response.document, response.model, 'main');
      else await openDocument(documentId, 'main');
      void refreshBranches();
      set({ browserOpen: true, leftTab: 'versions' });
      toast('success', `Merged ${name} into main`, `Verified and saved as main revision ${response.document.revision}.`);
    } catch (caught) {
      set({ busy: false, phase: 'failed', phaseLabel: 'Merge rejected' });
      setError(failure(caught));
    } finally { setWorking(null); }
  };

  const sync = async () => {
    if (!comparison || !documentId || !name) return;
    setWorking('sync');
    setError(null);
    try {
      await Branches.sync(documentId, name, body());
      toast('success', `Updated ${name} from main`, 'The branch now includes main’s latest changes.');
      set({ dialog: null });
      if (get().doc.branch === name) await openDocument(documentId, name);
      void refreshBranches();
    } catch (caught) { setError(failure(caught)); }
    finally { setWorking(null); }
  };

  const mainMeta = builds.main?.metadata, branchMeta = builds.branch?.metadata;
  const statusChip = !comparison ? null : status === 'conflict'
    ? <span className={styles.chip} data-tone="warning"><TriangleAlert size={12} />{unresolved ? `${blocks.length + openLinks} conflict${blocks.length + openLinks === 1 ? '' : 's'} to resolve` : 'Conflicts resolved'}</span>
    : status === 'up_to_date' ? <span className={styles.chip}><Check size={12} />Already in main</span>
    : <span className={styles.chip} data-tone="ok"><Check size={12} />{status === 'fast_forward' ? 'Fast-forward — main hasn’t changed' : 'Merges cleanly'}</span>;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && close()}
      width={1180}
      className={styles.dialog}
      icon={<div className={styles.icon} style={{ color }}><GitMerge size={18} /></div>}
      title={<span className={styles.title}>Merge <span className={styles.pill} style={{ ['--branch' as string]: color }}>{name}</span><ArrowRight size={15} /><span className={styles.pill} style={{ ['--branch' as string]: branchColor('main', order) }}>main</span></span>}
      description={comparison ? <span className={styles.subtitle}>{comparison.ahead} revision{comparison.ahead === 1 ? '' : 's'} on {name} · main moved {comparison.behind} since the branch point {statusChip}</span> : 'Comparing…'}
      footer={<>
        {error && <span className={styles.error} role="alert"><TriangleAlert size={13} /><span>{error.message}{error.detail && <small className={styles.errorDetail}>{error.detail}</small>}</span></span>}
        {error?.stale && <Button variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => setNonce((value) => value + 1)}>Compare again</Button>}
        <span style={{ marginRight: 'auto' }} />
        {comparison && comparison.behind > 0 && !unresolved && <Button variant="ghost" icon={working === 'sync' ? <Spinner size={12} /> : <RefreshCw />} disabled={!!working} onClick={() => { void sync(); }}>Update {name} from main</Button>}
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" icon={working === 'merge' ? <Spinner size={12} /> : <GitMerge />} disabled={!comparison || status === 'up_to_date' || unresolved || !!working} onClick={() => { void merge(); }}>
          {working === 'merge' ? 'Regenerating & verifying…' : 'Merge into main'}
        </Button>
      </>}
    >
      {!comparison && !error && <div className={styles.loading}><Spinner /></div>}
      {comparison && (
        <div className={styles.body}>
          <div className={styles.left}>
            <div className={styles.paneHead}>
              <span className="caps">Geometry</span>
              <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'overlay', label: 'Overlay' }, { value: 'main', label: 'main' }, { value: 'branch', label: name ?? 'branch' }]} />
            </div>
            <CompareViewer
              mainUrl={comparison.main.preview_build_id ? `/v1/builds/${comparison.main.preview_build_id}/artifacts/preview` : null}
              branchUrl={comparison.branch.preview_build_id ? `/v1/builds/${comparison.branch.preview_build_id}/artifacts/preview` : null}
              branchColor={color}
              mode={mode}
            />
            <div className={styles.legend}>
              <span><i style={{ background: '#9aa6ae', opacity: 0.6 }} />main (ghost)</span>
              <span><i style={{ background: color }} />{name}</span>
            </div>
            <div className={styles.stats}>
              <div className={`${styles.stat} ${styles.statHead}`}><span /><span>main</span><span>{name}</span><span>Δ</span></div>
              <Stat label="Volume" main={mainMeta?.volume_mm3} branch={branchMeta?.volume_mm3} format={(value) => volumeText(value, units)} />
              <Stat label="Surface" main={mainMeta?.surface_area_mm2} branch={branchMeta?.surface_area_mm2} format={(value) => areaText(value, units)} />
              <Stat label="Faces" main={mainMeta?.faces} branch={branchMeta?.faces} format={(value) => `${value}`} />
              {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                <Stat key={axis} label={`Size ${axis}`} main={mainMeta?.bounds_mm[index]} branch={branchMeta?.bounds_mm[index]} format={(value) => lengthText(value, units)} />
              ))}
            </div>
          </div>
          <div className={styles.right}>
            <div className={styles.paneHead}>
              <Segmented size="sm" value={pane} onChange={setPane} options={[{ value: 'changes', label: 'Changes' }, { value: 'result', label: status === 'conflict' ? `Resolve${blocks.length + openLinks ? ` (${blocks.length + openLinks})` : ''}` : 'Merged source' }]} />
              <span className={styles.diffLegend}><span>main</span><ArrowRight size={12} /><span style={{ color }}>{name}</span></span>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              {pane === 'changes' ? (
                <motion.div key="changes" className={styles.paneBody} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <SourceCompare main={comparison.main.code} branch={comparison.branch.code} />
                </motion.div>
              ) : (
                <motion.div key="result" className={styles.paneBody} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {linkConflicts.length > 0 && (
                    <div className={styles.conflicts}>
                      {linkConflicts.map((item) => (
                        <LinkConflict key={item.alias} conflict={item} names={linkNames} branch={name ?? 'branch'} color={color} choice={linkChoice[item.alias!]}
                          onChoose={(choice) => setLinkChoice((current) => ({ ...current, [item.alias!]: choice }))} />
                      ))}
                    </div>
                  )}
                  {blocks.length > 0 && (
                    <div className={styles.conflicts}>
                      {blocks.map((block, index) => (
                        <motion.div key={`${index}:${block.start}`} className={styles.conflict} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                          <div className={styles.conflictHead}><TriangleAlert size={13} /><b>Conflict {index + 1}</b><span>Both sides changed the same lines.</span></div>
                          <div className={styles.conflictSides}>
                            <div><span className={styles.sideLabel}>main</span><pre>{block.ours || '(removed)'}</pre></div>
                            <div><span className={styles.sideLabel} style={{ color }}>{name}</span><pre>{block.theirs || '(removed)'}</pre></div>
                          </div>
                          <div className={styles.conflictActions}>
                            <Button size="sm" variant="ghost" onClick={() => resolve(block, 'ours')}>Keep main</Button>
                            <Button size="sm" variant="ghost" onClick={() => resolve(block, 'theirs')}>Take {name}</Button>
                            <Button size="sm" variant="ghost" onClick={() => resolve(block, 'both')}>Keep both</Button>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                  <div className={styles.result}>
                    <SourceEditor value={result} onChange={setResult} diagnostics={markerDiagnostics(result)} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** A link alias that main and the branch point at different documents or revisions ("<document_id>@<revision>", with
 *  "#<component>" when it links one component of a design). */
const unpackLink = (value: string): LinkRef => {
  const [pinned, component] = value.split('#');
  const [documentId, revision] = pinned.split('@');
  return { document_id: documentId, revision: revision && revision !== 'None' ? Number(revision) : null, ...(component ? { component } : {}) };
};

function LinkConflict({ conflict, names, branch, color, choice, onChoose }: {
  conflict: MergeConflict; names: Record<string, string>; branch: string; color: string; choice?: 'ours' | 'theirs'; onChoose: (choice: 'ours' | 'theirs') => void;
}) {
  const label = (value: string | null) => {
    if (!value) return 'Removed';
    const link = unpackLink(value);
    return `${link.component ? `${link.component} of ` : ''}${names[link.document_id] ?? 'Loading…'}${link.revision ? ` · revision ${link.revision}` : ''}`;
  };
  return (
    <motion.div className={styles.conflict} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} data-resolved={!!choice || undefined}>
      <div className={styles.conflictHead}>{choice ? <Check size={13} /> : <TriangleAlert size={13} />}<b>Link <code>{conflict.alias}</code></b><span>Both sides changed what this link points at.</span></div>
      <div className={styles.conflictSides}>
        <div><span className={styles.sideLabel}>main</span><pre>{label(conflict.ours)}</pre></div>
        <div><span className={styles.sideLabel} style={{ color }}>{branch}</span><pre>{label(conflict.theirs)}</pre></div>
      </div>
      <div className={styles.conflictActions}>
        <Button size="sm" variant="ghost" active={choice === 'ours'} onClick={() => onChoose('ours')}>Keep main</Button>
        <Button size="sm" variant="ghost" active={choice === 'theirs'} onClick={() => onChoose('theirs')}>Take {branch}</Button>
      </div>
    </motion.div>
  );
}
