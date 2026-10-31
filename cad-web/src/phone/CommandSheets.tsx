/**
 * Tools: the desktop ribbon of the moment (the same groups, buttons and menus, from commands.ts) as a grid, the
 * panels, and every command by category, with one search over all of them.
 * View: camera, display and inspection, kept open so each change shows on the model above it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Code2, GitBranch, History, ListTree, MessageSquare, MessageSquareText, PackagePlus, Search, SlidersHorizontal } from 'lucide-react';
import { set, useApp, type DesignTab, type DockTab } from '@/state/store';
import { setDesignTab, shownTab } from '@/state/designTab';
import { partsTabShown } from '@/shell/Dock';
import { command } from '@/commands';
import { allCommands, listed, search, toolGroups, VIEW_GROUPS } from './commandModel';
import { CommandRow, CommandTile } from './CommandButtons';
import Sheet from './Sheet';
import { closeSheet, usePhoneUi } from './state';
import styles from './Phone.module.css';

const WORKSPACE_LABEL = { design: 'Design', simulate: 'Simulate', manufacture: 'Manufacture', electronics: 'Electronics' } as const;

function DesignTabs() {
  const tab = useApp(shownTab);
  const isDesign = useApp((state) => state.doc.kind === 'design');
  const tabs: [DesignTab, string][] = [['solid', 'Solid'], ['sheet', 'Sheet metal'], ['surface', 'Surface'], ...(isDesign ? [['motion', 'Motion'] as [DesignTab, string]] : [])];
  return (
    <div className={styles.segmented} role="tablist" aria-label="Design tools">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} data-design-tab={id} onClick={() => setDesignTab(id)}>{label}</button>
      ))}
    </div>
  );
}

const PANELS: { id: string; label: string; icon: typeof ListTree; open: () => void; visible?: () => boolean }[] = [
  { id: 'model', label: 'Model', icon: ListTree, open: () => set({ browserOpen: true, leftTab: 'model' }) },
  { id: 'versions', label: 'Versions', icon: GitBranch, open: () => set({ browserOpen: true, leftTab: 'versions' }) },
  { id: 'properties', label: 'Inspector', icon: SlidersHorizontal, open: () => dock('properties') },
  { id: 'parts', label: 'Parts', icon: PackagePlus, open: () => dock('parts') },
  { id: 'source', label: 'Source', icon: Code2, open: () => dock('source') },
  { id: 'assistant', label: 'STEVE', icon: MessageSquare, open: () => dock('assistant') },
  { id: 'comments', label: 'Comments', icon: MessageSquareText, open: () => dock('comments') },
  { id: 'history', label: 'History', icon: History, open: () => dock('history') },
];
const dock = (dockTab: DockTab) => set({ dockOpen: true, dockTab });

function Panels() {
  const parts = useApp(partsTabShown);
  return (
    <section className={styles.group} aria-label="Panels">
      <h3>Panels</h3>
      <div className={styles.grid}>
        {PANELS.filter((panel) => panel.id !== 'parts' || parts).map((panel) => {
          const Icon = panel.icon;
          return (
            <button key={panel.id} type="button" className={styles.tile} data-panel-open={panel.id} onClick={panel.open}>
              <Icon size={22} strokeWidth={1.55} /><span>{panel.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AllCommands({ after }: { after: () => void }) {
  // Recomputed when the sheet opens; availability inside each row stays live.
  const state = useApp.getState();
  const groups = useMemo(() => allCommands(state), [state.workspace, state.doc.kind, state.workspaces]);
  return (
    <div id="phone-all-commands">
      {groups.map((group) => (
        <section key={group.title} className={styles.list} aria-label={group.title}>
          <h3>{group.title}</h3>
          {group.items.map((cmd) => <CommandRow key={cmd.id} cmd={cmd} after={after} />)}
        </section>
      ))}
    </div>
  );
}

export function ToolsSheet() {
  const open = usePhoneUi((s) => s.sheet === 'tools');
  const focusSearch = usePhoneUi((s) => s.search);
  const workspace = useApp((state) => state.workspace);
  const sketching = useApp((state) => !!state.sketching && !state.sketching.choosing);
  const designTab = useApp(shownTab);
  // Re-list when anything that decides the shown groups changes (the masks, like Ribbon.tsx).
  const key = useApp((state) => toolGroups(state).map((group) => `${group.title}:${group.items.join(',')}`).join('|'));
  const groups = useMemo(() => toolGroups(useApp.getState()), [key]);
  const [query, setQuery] = useState('');
  const [everything, setEverything] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!open) { setQuery(''); setEverything(false); } else if (focusSearch) input.current?.focus(); }, [open, focusSearch]);
  const results = useMemo(() => search(useApp.getState(), query), [query]);
  const context = sketching ? 'Sketch' : workspace === 'design' ? `Design · ${designTab === 'sheet' ? 'Sheet metal' : designTab === 'motion' ? 'Motion' : 'Solid'}` : WORKSPACE_LABEL[workspace];
  return (
    <Sheet open={open} onClose={closeSheet} label="Tools" title={<>Tools <small>{context}</small></>} size="full" id="phone-tools">
      <label className={styles.search}>
        <Search size={17} />
        <input ref={input} type="search" placeholder="Search all commands" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search all commands" enterKeyHint="search" />
      </label>
      {query ? (
        <section className={styles.list} aria-label="Results" id="phone-search-results">
          {results.length ? results.map((cmd) => <CommandRow key={cmd.id} cmd={cmd} after={closeSheet} />) : <p className={styles.empty}>No command matches “{query}”.</p>}
        </section>
      ) : (
        <>
          {workspace === 'design' && !sketching && <DesignTabs />}
          {groups.map((group) => (
            <section key={group.title} className={styles.group} aria-label={group.title}>
              <h3>{group.title}</h3>
              <div className={styles.grid}>{group.items.map((id) => <CommandTile key={id} id={id} after={closeSheet} />)}</div>
            </section>
          ))}
          <Panels />
          <button type="button" className={styles.disclosure} aria-expanded={everything} id="phone-all-toggle" onClick={() => setEverything(!everything)}>
            <span>All commands</span><ChevronDown size={18} />
          </button>
          {everything && <AllCommands after={closeSheet} />}
        </>
      )}
    </Sheet>
  );
}

export function ViewSheet() {
  const open = usePhoneUi((s) => s.sheet === 'view');
  const shown = useApp((state) => VIEW_GROUPS.map((group) => group.items.filter((id) => listed(command(id), state)).join(',')).join('|')).split('|');
  return (
    <Sheet open={open} onClose={closeSheet} label="View" title="View" size="peek" id="phone-view">
      {VIEW_GROUPS.map((group) => (
        <section key={group.title} className={styles.group} aria-label={group.title}>
          <h3>{group.title}</h3>
          <div className={styles.grid}>{group.items.filter((id) => shown[VIEW_GROUPS.indexOf(group)].split(',').includes(id)).map((id) => <CommandTile key={id} id={id} />)}</div>
        </section>
      ))}
    </Sheet>
  );
}
