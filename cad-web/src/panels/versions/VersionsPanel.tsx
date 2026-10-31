import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownToLine, Code2, Copy, Eye, EyeOff, GitBranch, GitBranchPlus, GitCompareArrows, GitMerge, History, RotateCcw, Trash2 } from 'lucide-react';
import { Button, ContextItem, ContextLabel, ContextSeparator, IconButton, Spinner, Tip } from '@/ui';
import { hasUnsavedWork, isDirty, set, toast, useApp } from '@/state/store';
import { activateRevision, deleteBranch, leaveRevision, setCode, switchBranch, viewRevision } from '@/state/actions';
import { branchColor, branchOrder, type GraphNode } from '@/lib/branches';
import { fetchHistory, historicalDocument } from '@/lib/history';
import { serverCapabilities } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { whoLabel } from '@/teams/attribution';
import VersionGraph from './VersionGraph';
import styles from './Versions.module.css';
import { copyText } from '@/lib/clipboard';

type Source = { mode: 'loading' } | { mode: 'none'; reason: string } | { mode: 'branches' } | { mode: 'linear'; nodes: GraphNode[] };

/** Linear revision history for servers without the branch API. */
function useLinearFallback(documentId: string | undefined, revision: number | undefined, branchesAvailable: boolean | null): Source {
  const [source, setSource] = useState<Source>({ mode: 'loading' });
  useEffect(() => {
    if (!documentId) { setSource({ mode: 'none', reason: 'Save the design to start its version history.' }); return; }
    if (branchesAvailable === null) return;
    if (branchesAvailable) { setSource({ mode: 'branches' }); return; }
    let cancelled = false;
    void fetchHistory(documentId).then((result) => {
      if (cancelled) return;
      if (result.state !== 'ready') { setSource({ mode: 'none', reason: result.state === 'error' ? result.message : 'This server doesn’t keep version history yet.' }); return; }
      const revisions = new Set(result.revisions.map((item) => item.revision));
      setSource({ mode: 'linear', nodes: result.revisions.map((item) => ({
        key: `main@${item.revision}`, branch: 'main', revision: item.revision, recorded_at: item.recorded_at,
        parents: revisions.has(item.revision - 1) ? [`main@${item.revision - 1}`] : [], kind: 'edit',
        message: item.message || (item.revision === 1 ? 'Created' : 'Saved revision'), commit_id: item.commit_id, by: item.by,
        preview_build_id: item.preview_build_id,
      })) });
    });
    return () => { cancelled = true; };
  }, [documentId, revision, branchesAvailable]);
  return source;
}

export default function VersionsPanel() {
  const saved = useApp((state) => state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  const dirty = useApp((state) => isDirty(state));
  const branches = useApp((state) => state.branches);
  const graph = useApp((state) => state.graph);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [preview, setPreview] = useState<{ node: GraphNode; code: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pastVersion = useApp((state) => state.pastVersion);
  useEffect(() => { void serverCapabilities().then((caps) => setAvailable(caps.branches)); }, []);
  const source = useLinearFallback(saved?.id, saved?.revision, available);

  const nodes = source.mode === 'branches' ? graph?.nodes ?? [] : source.mode === 'linear' ? source.nodes : [];
  const lanes = useMemo(() => {
    const names = ['main'];
    for (const node of [...nodes].reverse()) if (!names.includes(node.branch)) names.push(node.branch);
    for (const item of branches ?? []) if (!names.includes(item.name)) names.push(item.name);
    return names;
  }, [nodes, branches]);
  const order = useMemo(() => branchOrder(branches, graph), [branches, graph]);
  const colorOf = (name: string) => branchColor(name, order.includes(name) ? order : [...order, name]);
  const heads = useMemo(() => {
    const result = new Set<string>();
    if (graph?.branches) graph.branches.forEach((item) => result.add(item.head_key));
    else if (nodes[0]) result.add(nodes[0].key);
    return result;
  }, [graph, nodes]);
  const currentKey = saved ? `${branch}@${saved.revision}` : null;

  if (!saved) return <div className={styles.empty}><History size={26} /><h3>No versions yet</h3><p>Save the design to start its history. Every save becomes a revision you can compare, restore or branch from.</p></div>;

  const current = branches?.find((item) => item.name === branch);
  const viewSource = async (node: GraphNode) => {
    if (!node.commit_id) { toast('info', 'Checkpoint pending', 'This revision is still being written to history.'); return; }
    try { setPreview({ node, code: (await historicalDocument(saved.id, node.commit_id)).document.code }); }
    catch (error) { toast('danger', 'Couldn’t read that revision', (error as Error).message); }
  };
  const restore = async (node: GraphNode) => {
    setBusy(node.key);
    try { await activateRevision(node, node.branch.includes('~') ? branch : node.branch); }
    finally { setBusy(null); }
  };
  const unsaved = hasUnsavedWork();
  const live = new Set((branches ?? []).map((item) => item.name));
  /** Right-click menu for a history row: every revision can be viewed, restored or branched from. */
  const menu = (node: GraphNode) => {
    const nodeBranch = node.branch.includes('~') ? null : node.branch;  // Deleted branches keep a suffixed label.
    const isHead = heads.has(node.key);
    const viewingThis = pastVersion?.key === node.key;
    const targets = [...new Set([nodeBranch ?? 'main', branch])].filter((name) => live.has(name) || name === 'main' || name === branch);
    return (
      <>
        <ContextLabel>{node.branch} · r{node.revision}</ContextLabel>
        {viewingThis
          ? <ContextItem icon={<EyeOff size={15} />} onSelect={() => { void leaveRevision(); }}>Back to the current version</ContextItem>
          : <ContextItem icon={<Eye size={15} />} disabled={!node.preview_build_id || node.key === currentKey} hint={!node.preview_build_id ? 'No model saved' : node.key === currentKey ? 'Open now' : undefined} onSelect={() => { void viewRevision(node); }}>View this version</ContextItem>}
        {targets.map((target) => {
          const current = isHead && target === nodeBranch;
          const blocked = target === branch && unsaved;
          return (
            <ContextItem key={target} icon={<RotateCcw size={15} />} disabled={current || blocked || !node.commit_id}
              hint={current ? 'Already current' : blocked ? 'Unsaved edits' : !node.commit_id ? 'Pending' : undefined}
              onSelect={() => { void activateRevision(node, target); }}>
              Make current on {target}
            </ContextItem>
          );
        })}
        <ContextSeparator />
        {nodeBranch && nodeBranch !== branch && live.has(nodeBranch) && <ContextItem icon={<GitBranch size={15} />} onSelect={() => switchBranch(nodeBranch)}>Switch to {nodeBranch}</ContextItem>}
        {available && <ContextItem icon={<GitBranchPlus size={15} />} disabled={node.branch !== 'main'} hint={node.branch !== 'main' ? 'From main only' : undefined} onSelect={() => set({ dialog: 'branch', branchFrom: node.revision })}>New branch from here</ContextItem>}
        {available && nodeBranch && nodeBranch !== 'main' && isHead && live.has(nodeBranch) && <ContextItem icon={<GitCompareArrows size={15} />} onSelect={() => set({ dialog: 'merge', mergeBranch: nodeBranch })}>Compare & merge {nodeBranch}</ContextItem>}
        <ContextItem icon={<Code2 size={15} />} disabled={!node.commit_id} onSelect={() => { void viewSource(node); }}>View source</ContextItem>
        <ContextItem icon={<Copy size={15} />} disabled={!node.commit_id} onSelect={() => {
          void copyText(node.commit_id!).then((ok) => ok ? toast('success', 'Revision ID copied', node.commit_id!.slice(0, 12)) : toast('warning', 'Couldn’t copy', 'The browser blocked clipboard access.'));
        }}>Copy revision ID</ContextItem>
      </>
    );
  };

  return (
    <div className={styles.panel}>
      {/* Current branch */}
      <div className={styles.current} style={{ ['--branch' as string]: colorOf(branch) }}>
        <span className={styles.currentIcon}><GitBranch size={16} /></span>
        <div className={styles.currentText}>
          <div className={styles.currentName}>{branch}</div>
          <div className={styles.currentMeta}>
            revision {saved.revision}
            {current && branch !== 'main' && <> · <span title="Revisions on this branch since it left main">↑{current.ahead}</span> <span title="Main revisions not yet in this branch">↓{current.behind}</span></>}
            {dirty && <span className={styles.dirty}> · unsaved edits</span>}
          </div>
        </div>
        {available && (
          <div className={styles.currentActions}>
            {branch !== 'main' && <Tip label="Compare & merge into main"><IconButton small label="Merge into main" onClick={() => set({ dialog: 'merge', mergeBranch: branch })}><GitMerge /></IconButton></Tip>}
            <Tip label="New branch" description="Try a variant without touching main."><IconButton small label="New branch" onClick={() => set({ dialog: 'branch', branchFrom: null })}><GitBranchPlus /></IconButton></Tip>
          </div>
        )}
      </div>

      <div className={styles.scroll}>
        {/* Branches */}
        {source.mode === 'branches' && (
          <section className={styles.section}>
            <div className={styles.sectionHead}><span className="caps">Branches</span><span className={styles.count}>{branches?.length ?? ''}</span></div>
            {!branches && <div className={styles.loading}><Spinner /></div>}
            {branches?.map((item) => {
              const active = item.name === branch;
              return (
                <div key={item.name} className={styles.branchRow} data-active={active || undefined} style={{ ['--branch' as string]: colorOf(item.name) }}>
                  <button type="button" className={styles.branchMain} onClick={() => switchBranch(item.name)} disabled={active}>
                    <span className={styles.branchDot} />
                    <span className={styles.branchText}>
                      <span className={styles.branchName}>{item.name}</span>
                      <span className={styles.branchMeta}>
                        {item.name === 'main' ? `r${item.revision}` : <>
                          {item.ahead > 0 && <b title="Revisions on this branch since it left main">↑{item.ahead}</b>}
                          {item.behind > 0 && <i title="Main revisions not in this branch">↓{item.behind}</i>}
                          {item.merged && <span className={styles.merged}>merged</span>}
                        </>}
                        <span>{relativeTime(item.updated_at)}</span>
                        {item.by && item.name !== 'main' && <span className={styles.branchBy}>{whoLabel(item.by)}</span>}
                      </span>
                    </span>
                  </button>
                  {item.name !== 'main' && (
                    <span className={styles.branchActions}>
                      <Tip label="Compare & merge"><button type="button" className={styles.rowAction} aria-label={`Merge ${item.name}`} onClick={() => set({ dialog: 'merge', mergeBranch: item.name })}><GitCompareArrows size={13} /></button></Tip>
                      <Tip label="Delete branch"><button type="button" className={styles.rowAction} aria-label={`Delete ${item.name}`} onClick={() => { void deleteBranch(item.name); }}><Trash2 size={12} /></button></Tip>
                    </span>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* Graph */}
        <section className={styles.section}>
          <div className={styles.sectionHead}><span className="caps">History</span><span className={styles.count}>{nodes.length || ''}</span></div>
          {source.mode === 'loading' && <div className={styles.loading}><Spinner /></div>}
          {source.mode === 'none' && <p className={styles.hint}>{source.reason}</p>}
          {nodes.length > 0 && (
            <VersionGraph nodes={nodes} lanes={lanes} colorOf={colorOf} heads={heads} current={currentKey} selected={selected?.key ?? null}
              onSelect={(node) => setSelected((currentNode) => (currentNode?.key === node.key ? null : node))} menu={menu} viewing={pastVersion?.key ?? null} />
          )}
          {source.mode === 'linear' && <p className={styles.hint}>Branches and merges appear here when the server supports them.</p>}
        </section>
      </div>

      {/* Selected revision */}
      <AnimatePresence>
        {selected && (
          <motion.div className={styles.detail} initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 36 }}>
            <div className={styles.detailHead}>
              <span className={styles.branchDot} style={{ background: colorOf(selected.branch) }} />
              <b>{selected.branch} · r{selected.revision}</b>
              <span className={styles.branchTime}>{relativeTime(selected.recorded_at)}</span>
            </div>
            <p className={styles.detailMessage}>{selected.message}{selected.change && selected.change !== selected.message && <span className={styles.branchTime}> · {selected.change}</span>}</p>
            {selected.by && <p className={styles.detailBy} data-revision-by>By {whoLabel(selected.by)}{selected.by.note ? <><br />{selected.by.note}</> : null}</p>}
            <div className={styles.detailActions}>
              <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => { void (pastVersion?.key === selected.key ? leaveRevision() : viewRevision(selected)); }} disabled={!selected.preview_build_id || selected.key === currentKey}>{pastVersion?.key === selected.key ? 'Back to current' : 'View'}</Button>
              <Button size="sm" variant="ghost" icon={<Code2 />} onClick={() => { void viewSource(selected); }} disabled={!selected.commit_id}>Source</Button>
              {available && <Button size="sm" variant="ghost" icon={<GitBranchPlus />} onClick={() => set({ dialog: 'branch', branchFrom: selected.branch === 'main' ? selected.revision : null })} disabled={selected.branch !== 'main'}>Branch here</Button>}
              {!heads.has(selected.key) && (
                <Tip label="Make this the current version" description={dirty ? 'Save or discard your edits first.' : 'Saved as a new revision; later revisions stay in history. Right-click for more targets.'}>
                  <Button size="sm" variant="ghost" icon={busy === selected.key ? <Spinner size={12} /> : <RotateCcw />} disabled={(dirty && (selected.branch === branch || selected.branch.includes('~'))) || !!busy || !selected.commit_id} onClick={() => { void restore(selected); }}>Restore</Button>
                </Tip>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {preview && (
          <motion.div className={styles.preview} initial={{ height: 0 }} animate={{ height: '42%' }} exit={{ height: 0 }} transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}>
            <div className={styles.previewHead}>
              <span className="mono">{preview.node.branch} r{preview.node.revision}</span>
              <Tip label="Copy into the editor" description="Replaces the editor text; save to keep it."><button type="button" className={styles.rowAction} aria-label="Load into editor" onClick={() => { setCode(preview.code); set({ dockOpen: true, dockTab: 'source' }); setPreview(null); }}><ArrowDownToLine size={13} /></button></Tip>
              <button type="button" className={styles.rowAction} onClick={() => setPreview(null)} aria-label="Close preview">✕</button>
            </div>
            <pre>{preview.code}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

