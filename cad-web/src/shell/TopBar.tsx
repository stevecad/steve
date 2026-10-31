import StudioAccountItems from '@/studio/StudioAccountItems';
import {refreshStudio,useStudio,useStudioStatus} from '@/studio/studio';
import { HOSTED_SERVICES } from '@/localCapabilities';
import { openDesktop } from '@/localDesktop';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { DropdownMenu } from 'radix-ui';
import { Bolt, Box, Bug, ChevronDown, CircleHelp, Copy, Download, FolderInput, Hand, Factory, FolderOpen, Import, Inbox, Layers3, Library, Lightbulb, LogOut, Maximize2, MessageSquare, Minimize2, Monitor, Moon, Package, Plug, Save, Search, Settings, Shapes, Sparkles, Store, Sun, User, Users, Workflow, X } from 'lucide-react';
import { openDocs, openWhatsNew } from '@/lib/docs';
import { usePendingRuns, watchPendingRuns } from '@/lib/pendingRuns';
import { openRmfgOrders, ordersSummary, useRmfgOrders } from '@/lib/rmfgOrders';
import { CircuitIcon, StudyIcon, SetupIcon } from '@/icons/cad';
import { Badge, Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '@/ui';
import { isDirty, set, toast, useApp, type DesignTab, type Workspace } from '@/state/store';
import { setName } from '@/state/actions';
import { activateTab, closeTab, type DocTab } from '@/state/tabs';
import { availability, command, fullscreenAvailable, runCommand, setWorkspace, toggleFullscreen } from '@/commands';
import { openSettings } from '@/settings/registry';
import { setThemeChoice, useThemeChoice, type ThemeChoice } from '@/state/theme';
import { chooseStepFile } from '@/state/imports';
import { NO_LIBRARIES, openLibrary, refreshLibraries, useLibraries } from '@/state/libraries';
import { sceneAnimated, setDesignTab, shownTab } from '@/state/designTab';
import { modKey } from '@/lib/format';
import mark from '@/steve/mark.svg';
import BranchSwitcher from './BranchSwitcher';
import GitBadge from './GitBadge';
import CarbonBadge from './CarbonBadge';
import ExportMenuItems, { exportsCircuit } from './ExportMenu';
import QuickButton from './QuickButton';
import { EXPORT_FORMATS, useExportFormat } from '@/state/exportFormat';
import { meshScope } from '@/state/meshExport';
import { signOut, useAccount } from '@/auth/auth';
import { openBugReport, openFeatureRequest, openMyReports, useFeedback } from '@/feedback/feedback';
import { useWorkspace } from '@/teams/current';
import { openCopyDialog } from '@/teams/CopyDialog';
import { workIn } from '@/teams/switch';
import styles from './TopBar.module.css';
import { Undo2, Redo2 } from 'lucide-react';
import { undoDocument, useLocalHistory } from '@/localHistory';

// experimental: shown with an Experimental pill wherever the workspace is named (owner, 2026-10-18).
const WORKSPACES: { id: Workspace; label: string; icon: typeof Box; hint: string; experimental?: boolean }[] = [
  { id: 'design', label: 'Design', icon: Box, hint: 'Model parts and designs' },
  { id: 'simulate', label: 'Simulate', icon: StudyIcon as unknown as typeof Box, hint: 'Studies, materials, loads and results' },
  { id: 'manufacture', label: 'Manufacture', icon: SetupIcon as unknown as typeof Box, hint: 'Setups, tools and toolpaths', experimental: true },
  { id: 'electronics', label: 'Electronics', icon: CircuitIcon as unknown as typeof Box, hint: 'Circuits: schematic, board and 3D, with tscircuit' },
];

/** A document kind's glyph: a part's box, a design's layers, a circuit's chip. */
const kindIcon = (kind: string) => (kind === 'design' ? Layers3 : kind === 'circuit' ? CircuitIcon as unknown as typeof Box : kind === 'shop' ? Factory : kind === 'blender' ? Shapes : Box);

/**
 * The wordmark. In Electronics the T drops out and STEVE reads SEVE, for tscircuit's author Seve Ibarluzea; it comes
 * back on leaving. Reduced motion swaps it without the fall.
 */
function Wordmark() {
  const seve = useApp((state) => state.workspace === 'electronics');
  const reduced = useReducedMotion();
  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 26 };
  return (
    <span className={styles.wordmark} aria-label={seve ? 'SEVE' : 'STEVE'} data-seve={seve || undefined} id="wordmark">
      {/* Always as wide as STEVE: when the T drops out, the space it leaves stays at the end and nothing beside it moves. */}
      <span aria-hidden="true" className={styles.wordmarkSizer}>STEVE</span>
      <span aria-hidden="true" className={styles.wordmarkText}>
        S
        <motion.span className={styles.wordmarkT} initial={false}
          animate={{ width: seve ? 0 : 'auto' }} transition={reduced ? { duration: 0 } : { duration: 0.42, ease: [0.4, 0, 0.2, 1], delay: seve ? 0.12 : 0 }}>
          <motion.span initial={false} style={{ display: 'inline-block', transformOrigin: '30% 90%' }}
            animate={seve ? { y: 9, rotate: 28, opacity: 0 } : { y: 0, rotate: 0, opacity: 1 }} transition={spring}>T</motion.span>
        </motion.span>
        EVE
      </span>
    </span>
  );
}

/** File: new, open, import, save and export, where every CAD tool keeps them (top left). */
function FileMenu() {
  const electronics = useApp((state) => state.workspaces.includes('electronics'));
  const circuit = useApp(exportsCircuit);
  const enabled = useApp((state) => ['doc.save', 'doc.close'].map((id) => (availability(command(id), state) === true ? '1' : '0')).join(''));
  const on = (index: number) => enabled[index] === '1';
  // Copy or move the open document to another of the person's workspaces (teams/CopyDialog.tsx): only for people in a team.
  const elsewhere = useWorkspace((state) => state.workspaces.length > 1);
  const movable = useApp((state) => !!state.doc.saved && ['part', 'design', 'circuit', 'blender'].includes(state.doc.kind));
  const blenderInstalled = useApp((state) => state.blenderInstalled);
  const blender = useApp((state) => state.doc.open && state.doc.kind === 'blender');
  return (
    <Menu onOpenChange={(open) => { if (open) void refreshLibraries(); }}>
      <MenuTrigger asChild>
        <button type="button" className={styles.fileMenu} id="file-menu" aria-label="File">File<ChevronDown size={13} className={styles.chevron} /></button>
      </MenuTrigger>
      <MenuContent align="start" className={styles.fileList}>
        <MenuItem icon={<Box size={15} />} shortcut="Alt+N" onSelect={() => runCommand('doc.new.part')}>New part</MenuItem>
        <MenuItem icon={<Layers3 size={15} />} onSelect={() => runCommand('doc.new.design')}>New design</MenuItem>
        {electronics && <MenuItem icon={<CircuitIcon size={15} />} onSelect={() => runCommand('doc.new.circuit')}>New circuit</MenuItem>}
        {blenderInstalled && <MenuItem icon={<Shapes size={15} />} onSelect={() => runCommand('doc.new.blender')}>New Blender scene</MenuItem>}
        <MenuItem icon={<FolderOpen size={15} />} shortcut={`${modKey}+O`} onSelect={() => runCommand('doc.open')}>Open…</MenuItem>
        {/* Mechanical imports: a circuit takes its parts from Place and JLCPCB instead. */}
        {!circuit && !blender && <>
          <MenuItem icon={<Import size={15} />} onSelect={chooseStepFile}>Import…</MenuItem>
          <MenuItem icon={<FolderOpen size={15} />} onSelect={() => runCommand('doc.importProject')}>Import project archive…</MenuItem>
          <MenuItem icon={<Bolt size={15} />} onSelect={() => set({ dialog: 'standardParts' })}>Standard parts…</MenuItem>
          <LibraryItems />
          <MenuItem icon={<Store size={15} />} onSelect={() => set({ dialog: 'mcmaster' })}>McMaster-Carr…</MenuItem>
        </>}
        <MenuSeparator />
        <MenuItem icon={<Save size={15} />} shortcut={`${modKey}+S`} disabled={!on(0)} onSelect={() => runCommand('doc.save')}>Save</MenuItem>
        {elsewhere && <>
          <MenuItem icon={<Copy size={15} />} disabled={!movable} onSelect={() => openCopyDialog(false)}>Copy to…</MenuItem>
          <MenuItem icon={<FolderInput size={15} />} disabled={!movable} onSelect={() => openCopyDialog(true)}>Move to…</MenuItem>
        </>}
        <MenuSeparator />
        <ExportMenuItems label="Export" />
        {HOSTED_SERVICES && <MenuItem icon={<Workflow size={15} />} onSelect={() => runCommand('app.runAction')}>Run an action…</MenuItem>}
        <MenuSeparator />
        <MenuItem icon={<X size={15} />} disabled={!on(1)} onSelect={() => runCommand('doc.close')}>Close</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** File → Libraries: each library folder, opening the Link dialog inside it. Off outside a design (links belong to
 * designs), and with none yet it says how to make one. */
function LibraryItems() {
  const list = useLibraries((state) => state.list);
  const usable = useApp((state) => availability(command('insert.library'), state));
  if (usable !== true || !list?.length) {
    return <MenuItem icon={<Library size={15} />} disabled reason={usable !== true ? usable : list ? NO_LIBRARIES : undefined} command="insert.library">Libraries</MenuItem>;
  }
  return (
    <>
      <MenuLabel>Libraries</MenuLabel>
      {list.map((library) => (
        <MenuItem key={library.id} icon={<Library size={15} />} command="insert.library" onSelect={() => openLibrary(library.id)}>{library.name}</MenuItem>
      ))}
    </>
  );
}

/** Save, always in the same place; the dot says there are unsaved changes. */
function SaveButton() {
  const open = useApp((state) => state.doc.open);
  const dirty = useApp((state) => isDirty(state));
  const saving = useApp((state) => state.phase === 'saving');
  const available = useApp((state) => availability(command('doc.save'), state) === true);
  const can = open && dirty && available && !saving;
  return (
    <Tip label="Save" shortcut={`${modKey}+S`} description={!open ? 'Open or create a design first.' : dirty ? 'Save your changes as a new revision.' : 'Everything is saved.'}>
      <button type="button" className={styles.saveButton} id="save-button" aria-label="Save" aria-disabled={!can} data-dirty={dirty || undefined}
        onClick={() => { if (can) runCommand('doc.save'); }}>
        <Save size={16} strokeWidth={1.7} />
        {dirty && <span className={styles.saveButtonDot} />}
      </button>
    </Tip>
  );
}

/** The workspace (Design, Simulate, Manufacture): changed rarely, so a menu; its badge carries the workspace colour. */
function WorkspaceMenu() {
  const workspace = useApp((state) => state.workspace);
  const enabled = useApp((state) => state.workspaces);
  const current = WORKSPACES.find((item) => item.id === workspace) ?? WORKSPACES[0];
  const Icon = current.icon;
  // Only the workspaces this deployment offers (STEVE_DISABLED_WORKSPACES turns some off), each with the key its command
  // is really bound to: turning one off doesn't renumber the others, so Manufacture off reads Alt+1 / 2 / 4.
  const offered = WORKSPACES.filter((item) => enabled.includes(item.id)).map((item) => ({ ...item, shortcut: command(`workspace.${item.id}`).shortcut ?? '' }));
  return (
    <Menu>
      <Tip label="Workspace" description={offered.map((item) => item.label).join(', ')} shortcut={`Alt+${offered.map((item) => item.shortcut.replace(/^Alt\+/, '')).join(' / ')}`}>
        <MenuTrigger asChild>
          <button type="button" className={styles.workspaceMenu} data-workspace-menu data-current={workspace} aria-label={`Workspace: ${current.label}`}>
            <Icon size={15} strokeWidth={1.7} />
            <span>{current.label}</span>
            {current.experimental && <Badge tone="soon">Experimental</Badge>}
            <ChevronDown size={13} className={styles.chevron} />
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent align="start" className={styles.workspaceList}>
        {offered.map((item) => {
          const ItemIcon = item.icon;
          return (
            <MenuItem key={item.id} icon={<ItemIcon size={15} />} shortcut={item.shortcut} checked={item.id === workspace} onSelect={() => setWorkspace(item.id)}>
              <span className={styles.workspaceItem} data-ws={item.id}><b>{item.label}{item.experimental && <> <Badge tone="soon">Experimental</Badge></>}</b><small>{item.hint}</small></span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

// The Design workspace's tools, one menu beside the workspace's: they follow the work by themselves (state/designTab.ts),
// so they're chosen rarely, and the top bar's room goes to the open documents.
const TOOL_HINTS: Record<DesignTab, string> = {
  solid: 'Sketches, features and patterns', sheet: 'Flanges, bends and flat patterns', surface: 'Surfaces, fills and analysis',
  motion: 'Joints, couplings and motion studies', drawing: 'Engineering drawings of the model', animation: 'The scene’s animation',
};

/** What the ribbon shows: Solid | Sheet metal | Surface (| Motion in a design) | Drawing (| Animation in an animated
 *  Blender scene) in Design, as a menu; the sketch while sketching, which Finish sketch leaves. */
function ToolMenu() {
  const workspace = useApp((state) => state.workspace);
  const designTab = useApp(shownTab);
  const isDesign = useApp((state) => state.doc.kind === 'design');
  const isBlender = useApp((state)=>state.doc.kind==='blender');
  const isCad = useApp((state) => state.doc.open && (state.doc.kind === 'part' || state.doc.kind === 'design'));
  const animated = useApp(sceneAnimated);
  const sketching = useApp((state) => !!state.sketching && !state.sketching.choosing);
  if (workspace !== 'design') return null;
  if (sketching) return <span className={styles.toolMenu} data-context="sketch" role="status" aria-label="Tools: Sketch">Sketch</span>;
  const tabs: [DesignTab, string][] = isBlender ? [['solid','Scene'], ...(animated ? [['animation','Animation'] as [DesignTab,string]] : [])] : [['solid', 'Solid'], ['sheet', 'Sheet metal'], ['surface', 'Surface'], ...(isDesign ? [['motion', 'Motion'] as [DesignTab, string]] : []),
    ...(isCad ? [['drawing', 'Drawing'] as [DesignTab, string]] : []), ...(animated ? [['animation', 'Animation'] as [DesignTab, string]] : [])];
  const current = tabs.find(([id]) => id === designTab)?.[1] ?? 'Solid';
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={styles.toolMenu} id="tool-menu" data-design-tab-menu data-current={designTab} aria-label={`Tools: ${current}`}>
          <span>{current}</span>
          <ChevronDown size={13} className={styles.chevron} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className={styles.workspaceList}>
        {tabs.map(([id, label]) => (
          <MenuItem key={id} checked={designTab === id} onSelect={() => setDesignTab(id)}>
            <span className={styles.workspaceItem} data-design-tab={id}><b>{label}</b><small>{isBlender&&id==='solid'?'Source, local rendering and Blender editing':TOOL_HINTS[id]}</small></span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function SaveState() {
  const open = useApp((state) => state.doc.open);
  const saved = useApp((state) => state.doc.saved);
  const dirty = useApp((state) => isDirty(state));
  const phase = useApp((state) => state.phase);
  if (!open) return null;
  const saving = phase === 'saving';
  const label = saving ? 'Saving…' : dirty ? (saved ? 'Edited' : 'Not saved') : 'Saved';
  const tone = saving ? 'busy' : dirty ? 'dirty' : 'clean';
  // The chip is the save button: click it (or Ctrl+S) while there are changes.
  return (
    <Tip label={dirty ? 'Save' : saved ? `Revision ${saved.revision}` : 'Unsaved design'} shortcut={dirty ? `${modKey}+S` : undefined}
      description={dirty ? (saved ? `Save as revision ${saved.revision + 1}.` : 'Save this design on the server.') : 'All changes are saved on the server.'}>
      <button type="button" className={styles.saveState} data-tone={tone} id="save-state" aria-disabled={!dirty || saving}
        onClick={() => { if (dirty && !saving) runCommand('doc.save'); }}>
        <span className={styles.saveDot} />
        <span role="status" className={styles.saveLabel}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>{label}</motion.span>
          </AnimatePresence>
        </span>
      </button>
    </Tip>
  );
}

function ActiveTabContent() {
  const doc = useApp((state) => state.doc);
  const busy = useApp((state) => state.busy);
  const editing = useApp((state) => state.renaming);
  const setEditing = (renaming: boolean) => set({ renaming });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  useEffect(() => () => set({ renaming: false }), []);
  const KindIcon = kindIcon(doc.kind);
  return (
    <>
      <KindIcon size={14} className={styles.kindIcon} />
      {editing ? (
        <input
          ref={input}
          className={styles.nameInput}
          defaultValue={doc.name}
          maxLength={100}
          aria-label="Design name"
          onBlur={(event) => { setName(event.target.value.trim() || 'Untitled'); setEditing(false); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <Tip label="Rename" description="Double-click to rename this design." shortcut="F2">
          <button type="button" id="view-name" className={styles.name} onDoubleClick={() => !busy && setEditing(true)}>{doc.name || 'Untitled'}</button>
        </Tip>
      )}
      <BranchSwitcher />
      {HOSTED_SERVICES && <GitBadge />}
      {HOSTED_SERVICES && <CarbonBadge />}
      <SaveState />
    </>
  );
}

interface TabProps { tab: DocTab; active: boolean }

/** One document tab. Only the present, active tab shows the live name, branch and save state. */
function Tab({ tab, active }: TabProps) {
  const present = useIsPresent();
  const live = active && present;
  const Icon = kindIcon(tab.kind);
  return (
    <motion.div
      layout="position"
      role="tab"
      data-key={tab.key}
      aria-selected={live}
      data-active={live || undefined}
      data-dirty={tab.dirty || undefined}
      className={styles.tab}
      initial={{ opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 38 }}
      onClick={() => !active && activateTab(tab.key)}
      onAuxClick={(event) => { if (event.button === 1) closeTab(tab.key); }}
      title={live ? undefined : tab.name}
    >
      {live && <motion.span layoutId="doc-tab" className={styles.tabThumb} transition={{ type: 'spring', stiffness: 520, damping: 42 }} />}
      {live ? <ActiveTabContent /> : (
        <>
          <Icon size={13} className={styles.kindIcon} />
          <span className={styles.tabName}>{tab.name}</span>
          {tab.branch !== 'main' && <span className={styles.tabBranch}>{tab.branch}</span>}
        </>
      )}
      <span className={styles.tabEnd}>
        {tab.dirty && <span className={styles.tabDirty} aria-label="Unsaved changes" />}
        <button type="button" className={styles.tabClose} aria-label={`Close ${tab.name}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.key); }}><X size={12} /></button>
      </span>
    </motion.div>
  );
}

// Tab widths the strip plans with: the active tab (name, branch, save state), any other tab at its narrowest, and the
// "N more" button. Tabs that don't fit wait in that button's menu, so the active tab is always whole and in view.
const ACTIVE_ROOM = 300;
const TAB_ROOM = 136;
const MORE_ROOM = 64;

/** Which tabs show: the active one and as many others as fit, nearest to it first, in their own order. */
export function shownTabs(tabs: DocTab[], active: string | null, width: number): { shown: DocTab[]; hidden: DocTab[] } {
  if (!width) return { shown: tabs, hidden: [] };
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === active));
  const others = tabs.length - (tabs.length ? 1 : 0);
  let fit = Math.max(0, Math.floor((width - ACTIVE_ROOM) / TAB_ROOM));
  if (others > fit) fit = Math.max(0, Math.floor((width - ACTIVE_ROOM - MORE_ROOM) / TAB_ROOM));
  if (others <= fit) return { shown: tabs, hidden: [] };
  const nearest = tabs.map((tab, at) => ({ tab, at })).filter(({ at }) => at !== index)
    .sort((a, b) => Math.abs(a.at - index) - Math.abs(b.at - index) || a.at - b.at).slice(0, fit).map(({ at }) => at);
  const keep = new Set([index, ...nearest]);
  return { shown: tabs.filter((_, at) => keep.has(at)), hidden: tabs.filter((_, at) => !keep.has(at)) };
}

/** Open documents as tabs; the active one carries its name, branch and save state. New, open and import are in File. */
function DocumentTabs() {
  const tabs = useApp((state) => state.tabs);
  const active = useApp((state) => state.activeTab);
  const open = useApp((state) => state.doc.open);
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { shown, hidden } = shownTabs(tabs, active, width);
  return (
    <div className={styles.tabs} ref={strip} role="tablist" aria-label="Open documents">
      {!tabs.length && !open && <span className={styles.noDoc}>No design open</span>}
      <AnimatePresence initial={false}>
        {shown.map((tab) => <Tab key={tab.uid} tab={tab} active={tab.key === active} />)}
      </AnimatePresence>
      {hidden.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={styles.moreTabs} id="more-tabs" aria-label={`${hidden.length} more open documents`}
              data-dirty={hidden.some((tab) => tab.dirty) || undefined}>
              {hidden.length} more<ChevronDown size={13} className={styles.chevron} />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className={styles.moreList}>
            {hidden.map((tab) => {
              const Icon = kindIcon(tab.kind);
              return (
                <MenuItem key={tab.uid} icon={<Icon size={14} />} onSelect={() => activateTab(tab.key)}
                  hint={tab.dirty ? <span className={styles.tabDirty} aria-label="Unsaved changes" /> : tab.branch !== 'main' ? <span className={styles.tabBranch}>{tab.branch}</span> : undefined}>
                  {tab.name}
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

/**
 * Export, top right: a compact split button, the download icon and the format. The main part repeats the last format used
 * (STEP until another is chosen, remembered per browser), or for a circuit its fabrication files; ▾ lists every export
 * (shell/ExportMenu.tsx). Narrow windows show the icon and ▾ only.
 */
function ExportButton() {
  const remembered = useExportFormat((state) => state.format);
  // A board's export is what the board house needs; the remembered format is for models.
  const circuit = useApp(exportsCircuit);
  // A Blender scene's export is its .blend file.
  const blender = useApp((state) => state.doc.open && state.doc.kind === 'blender');
  const format = circuit ? 'gerbers' : blender ? 'blend' : remembered;
  const { command: id, label } = circuit ? { command: 'circuit.export.fabrication', label: 'Gerbers' }
    : blender ? { command: 'export.blend', label: '.blend' } : EXPORT_FORMATS[remembered];
  const available = useApp((state) => availability(command(id), state));
  const picks = useApp((state) => state.selection);
  const selection = useMemo(() => (circuit || remembered === 'step' || !picks.length ? null : meshScope().selection), [circuit, remembered, picks]);
  const description = circuit ? 'Gerbers and drill files, the bill of materials and pick-and-place, zipped for the board house.'
    : blender ? 'The scene as a Blender (.blend) file.'
    : remembered === 'step' ? 'The complete CAD model, including hidden components.'
    : `${selection ? `The selection (${selection})` : 'The whole model'}${remembered === '3mf' ? ' for your slicer: each body a named object, placed as modelled.' : ' as one binary STL.'} Millimetres.`;
  const enabled = available === true;
  return (
    <div className={styles.split} role="group" aria-label="Export">
      <Tip label={`Export ${label}`} description={description} reason={enabled ? undefined : available}>
        <Button id="download" variant="secondary" icon={<Download />} aria-label={`Export ${label}`} aria-disabled={!enabled} data-disabled={!enabled || undefined}
          data-format={format} className={styles.export} onClick={() => (enabled ? runCommand(id) : toast('info', `Can’t export ${label} yet`, String(available)))}>
          <span>{label}</span>
        </Button>
      </Tip>
      {/* No tooltip: the menu returns focus here, and a focus tooltip would cover the ribbon. */}
      <Menu>
        <MenuTrigger asChild>
          <Button id="export-menu" variant="secondary" aria-label="Export formats" title="Export formats" className={styles.splitToggle}><ChevronDown /></Button>
        </MenuTrigger>
        <MenuContent align="end"><ExportMenuItems /></MenuContent>
      </Menu>
    </div>
  );
}

/** Feedback, next to MCP: report a bug, request a feature, see "My reports" or "What's new". Only when reports can reach STEVE (feedback/feedback.ts). */
function FeedbackMenu() {
  const reporting = useFeedback((state) => state.enabled);
  const unseen = useFeedback((state) => state.unseen);
  if (!reporting) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={styles.mcp} id="feedback-menu" aria-label="Feedback" title="Report a bug, request a feature, or see what became of your reports">
          <MessageSquare size={14} />
          <span>Feedback</span>
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<Bug size={14} />} onSelect={() => openBugReport()}>Report a bug…</MenuItem>
        <MenuItem icon={<Lightbulb size={14} />} onSelect={() => openFeatureRequest()}>Request a feature…</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Inbox size={14} />} onSelect={() => openMyReports()}>{unseen ? `My reports (${unseen} new)` : 'My reports'}</MenuItem>
        <MenuItem icon={<Sparkles size={14} />} onSelect={() => openWhatsNew()}>What's new</MenuItem>
      </MenuContent>
    </Menu>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light, dark or the system's, chosen in place: the menu stays open so the change shows. */
function ThemeChoices() {
  const choice = useThemeChoice((state) => state.choice);
  return (
    <DropdownMenu.RadioGroup className={styles.themes} value={choice} onValueChange={(value) => setThemeChoice(value as ThemeChoice)} aria-label="Theme" id="theme-choices">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <DropdownMenu.RadioItem key={value} value={value} className={styles.theme} onSelect={(event) => event.preventDefault()} data-theme-choice={value}>
          <Icon size={15} />
          <span>{label}</span>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

/** Connector runs, outside MCP calls and RMFG purchases someone asked for that wait for this person's confirmation:
 * shown only while there are some. Runs open the Run an action dialog; calls alone open Settings → MCP servers;
 * purchases alone open Order from RMFG on them. */
function WaitingRunsButton() {
  const runs = usePendingRuns((state) => state.runs.length);
  const calls = usePendingRuns((state) => state.calls.length);
  const buying = useRmfgOrders((state) => state.orders.filter((order) => order.state === 'awaiting_confirmation').length);
  const count = runs + calls + buying;
  useEffect(() => { watchPendingRuns(); }, []);
  if (!count) return null;
  return (
    <Tip label={`${count} waiting for you`} description="The STEVE assistant, an AI agent, a key or an app asked a connector, an outside MCP server or RMFG to do something. Confirm or cancel it.">
      <button type="button" className={styles.mcp} data-waiting-runs-button
              onClick={() => (runs ? set({ dialog: 'runAction' }) : calls ? openSettings('mcp-servers') : openRmfgOrders())}>
        <Hand size={14} />
        <span>{count} waiting</span>
      </button>
    </Tip>
  );
}

/** RMFG's quotes, carts and orders still in play (whoever asked: the person, STEVE or an AI agent): shown only while
 * RMFG is connected and there are some; it opens them all in Order from RMFG. A purchase waiting for the person
 * gives it the attention tone. */
function RmfgButton() {
  const orders = useRmfgOrders((state) => state.orders);
  if (!orders.length) return null;
  const waiting = orders.some((order) => order.state === 'awaiting_confirmation');
  return (
    <Tip label={`RMFG: ${ordersSummary(orders)}`} description="Your quotes, carts and orders at RMFG, from you, STEVE or your AI agents. See what's in them and their prices, and buy.">
      <button type="button" className={styles.mcp} data-rmfg-button data-attention={waiting || undefined} onClick={() => openRmfgOrders()}>
        <Package size={14} />
        <span>RMFG · {orders.length}</span>
      </button>
    </Tip>
  );
}

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' } as const;

/** The team this tab works in, beside the account button (nothing in Personal): opens Settings → Teams. */
function TeamChip() {
  const team = useWorkspace((state) => state.team);
  if (!team) return null;
  return (
    <Tip label={`Working in ${team.name}`} description={`The team's workspace: its documents and integrations. You're ${team.role === 'admin' ? 'an' : 'a'} ${ROLE_NAMES[team.role].toLowerCase()}. Switch in the account menu.`}>
      <button type="button" className={styles.teamChip} id="team-chip" data-role={team.role} onClick={() => openSettings('teams')}>
        <Users size={13} />
        <span>{team.name}</span>
        {team.role === 'viewer' && <small>viewer</small>}
      </button>
    </Tip>
  );
}

/**
 * The person: who's signed in (or the local user of a development server, who never signs in), Settings, the theme,
 * their reports and feedback (as in the Feedback menu, when reports can reach STEVE), and Sign out.
 */
function AccountAvatar({url,initials}:{url?:string;initials:string}) {
  const [failed,setFailed]=useState<string>();
  return url?.startsWith('https://') && failed!==url
    ? <img className={styles.accountPhoto} src={url} alt="" referrerPolicy="no-referrer" onError={()=>setFailed(url)}/>
    : <>{initials}</>;
}

function AccountMenu() {
  const studio = useStudioStatus();
  const person = studio?.connected ? studio.account : null;
  const menuOpen=useStudio(s=>s.accountMenuOpen);
  const account = useAccount((state) => state.account);
  const reporting = useFeedback((state) => state.enabled);
  const unseen = useFeedback((state) => state.unseen);
  const dev = !account || account.mode !== 'oidc';
  const name = person ? person.name || person.email || 'Studio account' : account?.name || account?.username || 'Local user';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || '?';
  const workspaces = useWorkspace((state) => state.workspaces);
  const team = useWorkspace((state) => state.team);
  return (
    <Menu modal={false} open={menuOpen} onOpenChange={open=>{useStudio.setState({accountMenuOpen:open});if(open)void refreshStudio();}}>
      <MenuTrigger asChild>
        <button type="button" className={styles.account} id="account-menu" aria-label={`Account: ${name}`} title={name} data-dev={dev || undefined} data-unseen={unseen || undefined}>
          <AccountAvatar url={person?.avatar_url} initials={initials}/>
        </button>
      </MenuTrigger>
      <MenuContent align="end" className={styles.accountMenu}>
        <div className={styles.accountCard} id="account-card">
          <span className={styles.accountAvatar} aria-hidden="true"><AccountAvatar url={person?.avatar_url} initials={initials}/></span>
          <div>
            <strong>{name}</strong>
            <span title={person?.email || person?.id}>{person ? person.email || person.id : dev ? 'Steve · local CAD' : account.email || account.username}</span>
            {person && <small>Steve Studio · Connected</small>}
            {team ? <small title={`Workspace ${team.workspace}`}>Working in {team.name} · {ROLE_NAMES[team.role]}</small>
              : account?.workspace && <small title={`Workspace ${account.workspace}`}>Workspace <code>{account.workspace.slice(0, 8)}</code>{account.admin && ' · admin'}</small>}
          </div>
        </div>
        <StudioAccountItems />
        {workspaces.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Working in</MenuLabel>
            {workspaces.map((item) => {
              const current = item.kind === 'personal' ? !team : team?.workspace === item.workspace_id;
              return (
                <MenuItem key={item.id} icon={item.kind === 'team' ? <Users size={14} /> : <User size={14} />} checked={current}
                  hint={item.kind === 'team' ? ROLE_NAMES[item.role] : undefined}
                  onSelect={() => { if (!current) workIn(item.kind === 'team' ? item.workspace_id : null); }}>
                  {item.name}
                </MenuItem>
              );
            })}
            <MenuItem icon={<Settings size={14} />} onSelect={() => openSettings('teams')}>Manage teams…</MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={<Settings size={14} />} shortcut={`${modKey}+,`} onSelect={() => openSettings()}>Settings…</MenuItem>
        <MenuItem icon={<User size={14} />} onSelect={() => void openDesktop('account')}>Subscription account</MenuItem>
        <MenuItem icon={<CircleHelp size={14} />} shortcut="F1" onSelect={() => openDocs()}>Documentation</MenuItem>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <ThemeChoices />
        {reporting && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Bug size={14} />} onSelect={() => openBugReport()}>Report a bug…</MenuItem>
            <MenuItem icon={<Lightbulb size={14} />} onSelect={() => openFeatureRequest()}>Request a feature…</MenuItem>
            <MenuItem icon={<Inbox size={14} />} hint={unseen ? <span className={styles.unseen}>{unseen} new</span> : undefined} onSelect={() => openMyReports()}>My reports</MenuItem>
          </>
        )}
        {!dev && (
          <>
            <MenuSeparator />
            <MenuItem icon={<LogOut size={14} />} onSelect={() => { void signOut(); }}>Sign out</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

export default function TopBar() {
  const fullscreen = useApp((state) => state.fullscreen);
  const localHistory = useLocalHistory();
  const editing = useApp((state) => state.busy || !!state.sketching || !!state.pastVersion);
  return (
    <header className={styles.topbar}>
      <a className={styles.brand} href="/" aria-label="STEVE Studio home" onClick={(event) => event.preventDefault()}>
        <img src={mark} alt="" />
        <Wordmark />
      </a>
      <FileMenu />
      <SaveButton />
      <IconButton label="Undo model edit" shortcut={`${modKey}+Z`} disabled={editing || !localHistory.undo} onClick={() => undoDocument()}><Undo2 /></IconButton>
      <IconButton label="Redo model edit" shortcut={`${modKey}+Y`} disabled={editing || !localHistory.redo} onClick={() => undoDocument(true)}><Redo2 /></IconButton>
      <span className={styles.divider} />
      <WorkspaceMenu />
      <ToolMenu />
      <span className={styles.divider} />
      <DocumentTabs />
      <div className={styles.right}>
        <IconButton label="Search commands and designs" shortcut={`${modKey}+K`} onClick={() => set({ dialog: 'palette', paletteQuery: '' })} id="search-button">
          <Search />
        </IconButton>
        <IconButton label="Documentation" shortcut="F1" description="How-tos, concepts and reference, in a new tab." onClick={() => openDocs()} id="docs-button">
          <CircleHelp />
        </IconButton>
        <Tip label="MCP servers" description="Connect Steve to your configured MCP tools">
          <button type="button" className={styles.mcp} onClick={() => void openDesktop('mcp')} data-mcp-button>
            <Plug size={14} />
            <span>MCP</span>
          </button>
        </Tip>
        {HOSTED_SERVICES && <RmfgButton />}
        {HOSTED_SERVICES && <WaitingRunsButton />}
        {HOSTED_SERVICES && <FeedbackMenu />}
        {fullscreenAvailable() && (
          <IconButton label={fullscreen ? 'Exit full screen' : 'Full screen'} description={fullscreen ? 'Or press Esc.' : 'Fill the screen with STEVE. Esc leaves full screen.'} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        )}
        <QuickButton fallback={<ExportButton />} />
        <IconButton label="Settings" shortcut={`${modKey}+,`} description="Everything you can change about STEVE Studio." onClick={() => openSettings()} id="settings-button" className={styles.settingsButton}>
          <Settings />
        </IconButton>
        {HOSTED_SERVICES && <TeamChip />}
        <AccountMenu />
      </div>
    </header>
  );
}
