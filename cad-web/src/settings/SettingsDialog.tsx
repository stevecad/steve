/**
 * Settings (⚙ in the top bar, Ctrl+,): everything people can change about the application, one section at a time,
 * in the same sectioned dialog as the Manufacturing library. Sections come from settings/registry.ts.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Search, Settings } from 'lucide-react';
import { set, useApp } from '@/state/store';
import { isPhone } from '@/phone/detect';
import { Spinner } from '@/ui';
import { SectionedDialog } from '@/ui/SectionedDialog';
import { GROUP_ORDER, loadIntegrationStatus, settingsSections, teamManagedElsewhere, useIntegrationStatus, useSettingsDialog } from './registry';
import { Note, SettingsPage } from './ui';
import { useAccount } from '@/auth/auth';
import { loadSettings } from './store';
import styles from './Settings.module.css';

export default function SettingsDialog({ open }: { open: boolean }) {
  const active = useSettingsDialog((state) => state.section);
  const [query, setQuery] = useState('');
  const status = useIntegrationStatus();
  useEffect(() => { if (open) { setQuery(''); void loadSettings(); void loadIntegrationStatus(); } }, [open]);
  const all = settingsSections();
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter((section) => {
      const text = [section.label, section.description, ...(section.keywords ?? [])].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [query, all]);
  const current = all.find((section) => section.id === active) ?? all[0];
  // Searching jumps to the first match, so the panel always shows something that matches.
  useEffect(() => {
    if (query && shown.length && !shown.some((section) => section.id === active)) useSettingsDialog.setState({ section: shown[0].id });
  }, [query, shown, active]);
  const Panel = current.panel;
  useAccount((state) => state.account?.team_role);   // re-render when the role is known
  const managedElsewhere = teamManagedElsewhere();
  // Tablets and desktops: nearly the whole window, so cards, tables and forms have room. Phones keep their sheet.
  const phone = isPhone();
  return (
    <SectionedDialog open={open} onOpenChange={(value) => { if (!value) set({ dialog: null }); }} width={phone ? 1120 : undefined} height={phone ? 800 : undefined}
      icon={<Settings size={18} />} title="Settings" description="Make Steve work your way. Preferences stay on this machine."
      id="settings" className={styles.dialog} navLabel="Settings sections" active={current.id} onSelect={(id) => useSettingsDialog.setState({ section: id })}
      navHead={(
        <div className={styles.navSearch}>
          <Search size={13} />
          <input type="search" placeholder="Search settings" aria-label="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} id="settings-search" />
        </div>
      )}
      nav={GROUP_ORDER.map((group) => ({
        title: group,
        items: shown.filter((section) => section.group === group).map((section) => {
          const Icon = section.icon;
          return { id: section.id, label: section.label, icon: <Icon size={15} />, count: status[section.id]?.attention ? '!' : undefined,
                   attrs: { id: `settings-nav-${section.id}`, 'data-attention': status[section.id]?.attention ? '' : undefined } };
        }),
      })).filter((group) => group.items.length)}
      navFooter={!shown.length ? <p className={styles.navEmpty}>No settings match “{query}”.</p> : undefined}>
      <section className={styles.panel} aria-label={current.label} id={`settings-${current.id}`} data-section={current.id}>
        <Suspense fallback={<div className={styles.loading}><Spinner size={18} /></div>}>
          {current.teamAdmin && managedElsewhere ? <TeamAdminsOnly section={current} /> : <Panel />}
        </Suspense>
      </section>
    </SectionedDialog>
  );
}

/** The settings dialog is open (for shortcuts that must not fire inside it). */
export const settingsOpen = () => useApp.getState().dialog === 'settings';

/** A team's integrations, devices and keys, for a member or viewer: the team's admins manage them (docs/TEAMS.md). */
function TeamAdminsOnly({ section }: { section: ReturnType<typeof settingsSections>[number] }) {
  return (
    <SettingsPage section={section} id={`settings-${section.id}-team`}>
      <Note>Team admins manage this for the team. You use what they set up: send, quote and order, run the actions they allow,
        and use the team's panels. Switch to Personal (account menu, <b>Working in</b>) for your own.</Note>
    </SettingsPage>
  );
}
