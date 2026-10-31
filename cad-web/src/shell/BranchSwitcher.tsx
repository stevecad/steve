import { useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown, GitBranch, GitBranchPlus, GitMerge } from 'lucide-react';
import { Tip } from '@/ui';
import { set, useApp, type AppState } from '@/state/store';
import { refreshBranches, switchBranch } from '@/state/actions';
import { branchColor, branchOrder } from '@/lib/branches';
import { serverCapabilities } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import ui from '@/ui/ui.module.css';
import styles from './TopBar.module.css';

/** Keeps the branch list and version graph current for the open document. */
export function useBranchSync() {
  const id = useApp((state) => state.doc.saved?.id);
  const revision = useApp((state) => state.doc.saved?.revision);
  const branch = useApp((state) => state.doc.branch);
  const build = useApp((state) => state.displayed?.id);
  useEffect(() => { if (id) void refreshBranches(); }, [id, revision, branch, build]);
}

/** Current-branch pill beside the document name, with switching and merging. */
export default function BranchSwitcher() {
  const saved = useApp((state) => !!state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  const branches = useApp((state) => state.branches);
  const graph = useApp((state) => state.graph);
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  // A dialog chosen from the menu opens once the menu has closed, so the menu is gone and focus
  // stays in the dialog instead of returning to the pill (Escape or clicking away still return it).
  const pending = useRef<Partial<AppState> | null>(null);
  const openDialog = (next: Partial<AppState>) => { pending.current = next; setOpen(false); };
  useEffect(() => { void serverCapabilities().then((caps) => setAvailable(caps.branches)); }, []);
  if (!saved || !available) return null;
  const order = branchOrder(branches, graph);
  const color = branchColor(branch, order);
  const current = branches?.find((item) => item.name === branch);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip label={`Branch: ${branch}`} description="Switch branches, start a new one, or merge into main.">
        <Popover.Trigger asChild>
          <button type="button" className={styles.branchPill} style={{ ['--branch' as string]: color }} aria-label={`Branch ${branch}`}>
            <GitBranch size={12} strokeWidth={2} />
            <span>{branch}</span>
            {current && branch !== 'main' && current.behind > 0 && <i title="Main revisions not in this branch">↓{current.behind}</i>}
            <ChevronDown size={11} />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className={`${ui.menu} ${styles.branchMenu}`} align="start" sideOffset={8} collisionPadding={10} onCloseAutoFocus={(event) => {
          const next = pending.current;
          if (!next) return;
          pending.current = null;
          event.preventDefault();
          set(next);
        }}>
          <div className={`caps ${styles.branchMenuLabel}`}>Branches</div>
          {(branches ?? []).map((item) => (
            <button key={item.name} type="button" className={ui.menuItem} style={{ width: '100%', ['--branch' as string]: branchColor(item.name, order) }} onClick={() => { setOpen(false); switchBranch(item.name); }}>
              <span className={styles.branchMenuDot} />
              <span className="mono" style={{ fontSize: 12 }}>{item.name}</span>
              <span className={ui.menuHint}>{item.name !== 'main' && (item.ahead || item.behind) ? `↑${item.ahead} ↓${item.behind} · ` : ''}{relativeTime(item.updated_at)}</span>
              {item.name === branch && <span className={ui.menuCheck}><Check size={14} /></span>}
            </button>
          ))}
          <div className={ui.menuSeparator} />
          <button type="button" className={ui.menuItem} style={{ width: '100%' }} onClick={() => openDialog({ dialog: 'branch', branchFrom: null })}><GitBranchPlus size={15} /><span>New branch…</span></button>
          {branch !== 'main' && <button type="button" className={ui.menuItem} style={{ width: '100%' }} onClick={() => openDialog({ dialog: 'merge', mergeBranch: branch })}><GitMerge size={15} /><span>Compare & merge into main…</span></button>}
          <button type="button" className={ui.menuItem} style={{ width: '100%' }} onClick={() => { setOpen(false); set({ browserOpen: true, leftTab: 'versions' }); }}><GitBranch size={15} /><span>Show version graph</span></button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
