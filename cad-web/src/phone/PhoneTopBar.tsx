/**
 * The phone's top bar: what's open and whether it's saved (tap for everything about the document), Save only while
 * there's something to save, the workspace, and the rest of the app (⋯). The desktop's tabs, File menu, search, MCP,
 * feedback, full screen, export split button and account live in the sheets these open.
 */
import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Box, Bug, ChevronDown, ChevronRight, CircleHelp, Download, Factory, Inbox, Layers3, Lightbulb, LogOut, Maximize2, Monitor, Moon, MoreHorizontal, Plug, Save, Search, Settings, Sparkles, Sun, X } from 'lucide-react';
import { openDocs, openWhatsNew } from '@/lib/docs';
import { CircuitIcon, SetupIcon, StudyIcon } from '@/icons/cad';
import { Badge, MenuContent } from '@/ui';
import { isDirty, set, useApp, type Workspace } from '@/state/store';
import { setName } from '@/state/actions';
import { activateTab, closeTab } from '@/state/tabs';
import { command, fullscreenAvailable, runCommand, setWorkspace, toggleFullscreen } from '@/commands';
import { openSettings } from '@/settings/registry';
import { setThemeChoice, useThemeChoice, type ThemeChoice } from '@/state/theme';
import { signOut, useAccount } from '@/auth/auth';
import { openBugReport, openFeatureRequest, openMyReports, useFeedback } from '@/feedback/feedback';
import BranchSwitcher from '@/shell/BranchSwitcher';
import ExportMenuItems from '@/shell/ExportMenu';
import { ActionRow, CommandRow } from './CommandButtons';
import Sheet from './Sheet';
import { closeSheet, openSheet, usePhoneUi } from './state';
import styles from './Phone.module.css';

const WORKSPACES: { id: Workspace; label: string; icon: typeof Box; hint: string; experimental?: boolean }[] = [
  { id: 'design', label: 'Design', icon: Box, hint: 'Parts, designs, sheet metal and motion' },
  { id: 'simulate', label: 'Simulate', icon: StudyIcon as unknown as typeof Box, hint: 'Studies, loads and results' },
  { id: 'manufacture', label: 'Manufacture', icon: SetupIcon as unknown as typeof Box, hint: 'Setups, tools and toolpaths', experimental: true },
  { id: 'electronics', label: 'Electronics', icon: CircuitIcon as unknown as typeof Box, hint: 'Circuits: schematic, board and 3D' },
];

const kindIcon = (kind: string) => (kind === 'design' ? Layers3 : kind === 'circuit' ? CircuitIcon as unknown as typeof Box : kind === 'shop' ? Factory : Box);

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  return <>{Math.max(0, (now - since) / 1000).toFixed(0)} s</>;
}

/** One line under the name: building, failed, unsaved, or saved and where. */
function DocStatus() {
  const open = useApp((state) => state.doc.open);
  const busy = useApp((state) => state.busy);
  const phase = useApp((state) => state.phase);
  const label = useApp((state) => state.phaseLabel);
  const started = useApp((state) => state.phaseStarted);
  const dirty = useApp((state) => isDirty(state));
  const saved = useApp((state) => state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  if (busy) return <small data-tone="busy" role="status">{label || 'Working…'}{started ? <> · <Elapsed since={started} /></> : null}</small>;
  if (phase === 'failed') return <small data-tone="danger" role="status">{label || 'Failed'}</small>;
  if (!open) return <small>Open or create a document</small>;
  const where = branch !== 'main' ? ` · ${branch}` : '';
  if (phase === 'saving') return <small data-tone="busy" role="status">Saving…</small>;
  if (dirty) return <small data-tone="dirty" role="status">{saved ? 'Edited' : 'Not saved'}{where}</small>;
  return <small role="status">{saved ? `Saved · revision ${saved.revision}` : 'Saved'}{where}</small>;
}

export default function PhoneTopBar() {
  const name = useApp((state) => (state.doc.open ? state.doc.name || 'Untitled' : 'STEVE Studio'));
  const kind = useApp((state) => state.doc.kind);
  const open = useApp((state) => state.doc.open);
  const dirty = useApp((state) => state.doc.open && isDirty(state));
  const canSave = useApp((state) => state.doc.open && !state.busy && state.phase !== 'saving');
  const workspace = useApp((state) => state.workspace);
  const tabs = useApp((state) => state.tabs.length);
  const current = WORKSPACES.find((item) => item.id === workspace) ?? WORKSPACES[0];
  const KindIcon = kindIcon(kind);
  const WorkspaceIcon = current.icon;
  return (
    <header className={styles.topbar} id="phone-topbar">
      <button type="button" className={styles.title} id="phone-title" aria-label={`Document: ${name}`} onClick={() => openSheet('document')}>
        <span className={styles.titleLine}>
          {open && <KindIcon size={15} className={styles.kind} />}
          <span className={styles.name} id="view-name">{name}</span>
          {tabs > 1 && <span className={styles.count} aria-label={`${tabs} documents open`}>{tabs}</span>}
          <ChevronDown size={15} className={styles.chevron} />
        </span>
        <DocStatus />
      </button>
      {dirty && (
        <button type="button" className={styles.iconButton} id="save-button" aria-label="Save" data-dirty aria-disabled={!canSave} onClick={() => canSave && runCommand('doc.save')}>
          <Save size={20} strokeWidth={1.7} />
        </button>
      )}
      <button type="button" className={styles.workspaceButton} data-workspace-menu data-current={workspace} aria-label={`Workspace: ${current.label}`} onClick={() => openSheet('workspace')}>
        <WorkspaceIcon size={19} strokeWidth={1.7} />
      </button>
      <button type="button" className={styles.iconButton} id="phone-more" aria-label="More" onClick={() => openSheet('more')}>
        <MoreHorizontal size={22} />
      </button>
    </header>
  );
}

function RenameField() {
  const name = useApp((state) => state.doc.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  return (
    <input ref={input} className={styles.renameInput} defaultValue={name} maxLength={100} aria-label="Document name" enterKeyHint="done"
      onBlur={(event) => { setName(event.target.value.trim() || 'Untitled'); set({ renaming: false }); }}
      onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') set({ renaming: false }); }} />
  );
}

/** Export: the desktop's export list (shell/ExportMenu.tsx), every format and variant, as a menu from its row. */
function ExportRow() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.row} id="phone-export">
          <Download size={19} strokeWidth={1.6} />
          <span className={styles.rowText}><span>Export</span><small>STEP, 3MF, STL, print set, image, source</small></span>
          <ChevronRight size={17} className={styles.rowEnd} />
        </button>
      </DropdownMenu.Trigger>
      <MenuContent align="end" side="top"><ExportMenuItems /></MenuContent>
    </DropdownMenu.Root>
  );
}

export function DocumentSheet() {
  const shown = usePhoneUi((s) => s.sheet === 'document');
  const open = useApp((state) => state.doc.open);
  const name = useApp((state) => state.doc.name);
  const renaming = useApp((state) => state.renaming);
  const tabs = useApp((state) => state.tabs);
  const active = useApp((state) => state.activeTab);
  const circuits = useApp((state) => state.workspaces.includes('electronics'));
  const row = (id: string) => <CommandRow cmd={command(id)} after={closeSheet} />;
  return (
    <Sheet open={shown} onClose={() => { set({ renaming: false }); closeSheet(); }} label="Document" title={open ? undefined : 'Documents'} size="full" id="phone-document">
      {open && (
        <section className={styles.docHead}>
          {renaming ? <RenameField /> : <button type="button" className={styles.docName} onClick={() => set({ renaming: true })} aria-label="Rename">{name || 'Untitled'}</button>}
          <BranchSwitcher />
        </section>
      )}
      {open && (
        <section className={styles.list} aria-label="This document">
          {row('doc.save')}
          {row('doc.share')}
          <ExportRow />
          {row('branch.versions')}
          {row('doc.rename')}
          {row('doc.close')}
        </section>
      )}
      {tabs.length > 0 && (
        <section className={styles.list} aria-label="Open documents">
          <h3>Open</h3>
          {tabs.map((tab) => {
            const Icon = kindIcon(tab.kind);
            return (
              <div key={tab.uid} className={styles.tabRow} data-active={tab.key === active || undefined}>
                <button type="button" className={styles.row} onClick={() => { activateTab(tab.key); closeSheet(); }} aria-current={tab.key === active || undefined}>
                  <Icon size={19} strokeWidth={1.6} />
                  <span className={styles.rowText}><span>{tab.name}</span><small>{[tab.kind, tab.branch !== 'main' ? tab.branch : null, tab.dirty ? 'unsaved changes' : null].filter(Boolean).join(' · ')}</small></span>
                </button>
                <button type="button" className={styles.iconButton} aria-label={`Close ${tab.name}`} onClick={() => closeTab(tab.key)}><X size={18} /></button>
              </div>
            );
          })}
        </section>
      )}
      <section className={styles.list} aria-label="New and open">
        <h3>New and open</h3>
        {row('doc.open')}
        {row('doc.new.part')}
        {row('doc.new.design')}
        {circuits && row('doc.new.circuit')}
        {row('doc.import')}
        {row('insert.standardPart')}
        {row('insert.library')}
        {row('insert.mcmaster')}
      </section>
    </Sheet>
  );
}

export function WorkspaceSheet() {
  const shown = usePhoneUi((s) => s.sheet === 'workspace');
  const workspace = useApp((state) => state.workspace);
  const enabled = useApp((state) => state.workspaces);
  return (
    <Sheet open={shown} onClose={closeSheet} label="Workspace" title="Workspace" size="half" id="phone-workspace">
      <section className={styles.list}>
        {WORKSPACES.filter((item) => enabled.includes(item.id)).map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className={styles.row} data-ws={item.id} aria-current={item.id === workspace || undefined} onClick={() => { setWorkspace(item.id); closeSheet(); }}>
              <Icon size={19} strokeWidth={1.6} />
              <span className={styles.rowText}><span>{item.label}{item.experimental && <> <Badge tone="soon">Experimental</Badge></>}</span><small>{item.hint}</small></span>
            </button>
          );
        })}
      </section>
    </Sheet>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor },
];

export function MoreSheet() {
  const shown = usePhoneUi((s) => s.sheet === 'more');
  const account = useAccount((state) => state.account);
  const reporting = useFeedback((state) => state.enabled);
  const unseen = useFeedback((state) => state.unseen);
  const theme = useThemeChoice((state) => state.choice);
  const fullscreen = useApp((state) => state.fullscreen);
  const dev = !account || account.mode !== 'oidc';
  const name = account?.name || account?.username || 'Local user';
  const then = (run: () => void) => () => { closeSheet(); run(); };
  return (
    <Sheet open={shown} onClose={closeSheet} label="More" title="STEVE Studio" size="full" id="phone-more-sheet">
      <section className={styles.account} id="account-card">
        <strong>{name}</strong>
        <span>{dev ? 'Development server · no sign-in' : account.email || account.username}</span>
      </section>
      <section className={styles.list}>
        <ActionRow icon={<Search size={19} />} label="Search commands" onClick={() => openSheet('tools', true)} />
        <ActionRow icon={<Settings size={19} />} label="Settings" id="settings-button" onClick={then(() => openSettings())} />
        <ActionRow icon={<Plug size={19} />} label="Connect AI tools (MCP)" detail="Use STEVE from Claude, ChatGPT or Codex" onClick={then(() => openSettings('mcp'))} />
        <ActionRow icon={<CircleHelp size={19} />} label="Documentation" detail="How-tos, concepts and reference" id="docs-button" onClick={then(() => openDocs())} />
        {fullscreenAvailable() && <ActionRow icon={<Maximize2 size={19} />} label={fullscreen ? 'Leave full screen' : 'Full screen'} onClick={then(toggleFullscreen)} />}
      </section>
      <section className={styles.list} aria-label="Theme">
        <h3>Theme</h3>
        <div className={styles.segmented} role="radiogroup" aria-label="Theme" id="theme-choices">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button key={value} type="button" role="radio" aria-checked={theme === value} data-theme-choice={value} onClick={() => setThemeChoice(value)}><Icon size={16} />{label}</button>
          ))}
        </div>
      </section>
      {reporting && (
        <section className={styles.list} aria-label="Feedback">
          <h3>Feedback</h3>
          <ActionRow icon={<Bug size={19} />} label="Report a bug" onClick={then(() => openBugReport())} />
          <ActionRow icon={<Lightbulb size={19} />} label="Request a feature" onClick={then(() => openFeatureRequest())} />
          <ActionRow icon={<Inbox size={19} />} label="My reports" detail={unseen ? `${unseen} new` : undefined} onClick={then(() => openMyReports())} />
          <ActionRow icon={<Sparkles size={19} />} label="What's new" onClick={then(() => openWhatsNew())} />
        </section>
      )}
      {!dev && (
        <section className={styles.list}>
          <ActionRow icon={<LogOut size={19} />} label="Sign out" danger onClick={then(() => { void signOut(); })} />
        </section>
      )}
    </Sheet>
  );
}
