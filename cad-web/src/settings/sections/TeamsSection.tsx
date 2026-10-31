/**
 * Settings → Teams (app/teams.py, docs/TEAMS.md): your teams and the workspace each one has, creating one, joining with
 * an invitation code, and for each team its people and roles, invitations, activity, export and deletion; plus which AI
 * clients may work in which of your teams.
 *
 * Privileged changes (making an admin, handing over ownership, deleting the team, the MFA option) are confirmed here
 * and done only by you in the web app (the server refuses them from anything else); a team whose owner turned on
 * "Require MFA for admin actions" also needs a fresh MFA sign-in for them. Invitation codes are shown once and kept
 * nowhere. Every change reloads the team: a change that may or may not have happened is never repeated by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Select, Spinner, Switch } from '@/ui';
import { verifyTeamIdentity } from '@/auth/auth';
import { loadWorkspaces, switchWorkspace, useWorkspace, type TeamRole } from '@/teams/current';
import { openIn, workIn } from '@/teams/switch';
import { describeEvent, teams, TeamError, type AiClient, type Job, type Team, type TeamDetail, type TeamList } from '@/teams/api';
import { activityText, whoLabel, type ActivityItem, type OpenBranch } from '@/teams/attribution';
import { relativeTime } from '@/lib/format';
import { settingsSections } from '../registry';
import { Card, Note, Past, SettingsPage } from '../ui';
import own from './Developers.module.css';
import styles from './TeamsSection.module.css';

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
const ROLE_HINT: Record<TeamRole, string> = {
  owner: 'everything an admin can, and deleting the team or handing it over',
  admin: 'people, invitations, the team’s integrations and keys',
  member: 'creates, edits, builds and runs the team’s work',
  viewer: 'looks at the team’s work and comments',
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b, i) =>
  (i === 6 ? (b & 15) | 64 : i === 8 ? (b & 63) | 128 : b).toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const size = (bytes: number | null) => (bytes == null ? '' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

interface Confirmation { title: string; text: string; action: string; danger?: boolean; run: () => Promise<unknown>; done: string }

export default function TeamsSection() {
  const section = settingsSections().find((item) => item.id === 'teams')!;
  const here = useWorkspace((state) => state.team?.workspace ?? null);
  const [list, setList] = useState<TeamList | null>(null);
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const generation = useRef(0);
  const selectedRef = useRef('');

  const load = useCallback(async (id: string) => {
    const ticket = ++generation.current;
    const next = await teams.list();
    const current = next.teams.some((item) => item.id === id) ? id : next.teams.find((item) => item.workspace_id === here)?.id ?? next.teams[0]?.id ?? '';
    const detail = current ? await teams.get(current) : null;
    if (ticket !== generation.current) return;
    setList(next); setSelected(current); selectedRef.current = current; setTeam(detail);
    // The account menu's Working in follows (a new team, one left, a rename); a team this tab worked in and left: Personal.
    void loadWorkspaces().then((left) => { if (left) switchWorkspace(null); });
  }, [here]);
  useEffect(() => {
    void load('').catch((caught: Error) => setError(caught.message));
    return () => { generation.current++; };
  }, [load]);

  /** Runs a change, then reloads (never repeats an uncertain change by itself). */
  async function perform(work: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setError(''); setCode(''); setNotice('');
    try {
      await work();
      setNotice(success);
    } catch (caught) {
      setError((caught as Error).message);
      setCode(caught instanceof TeamError ? caught.code : '');
    } finally {
      try { await load(selectedRef.current); } catch { setTeam(null); setError((old) => old || 'Couldn’t refresh the team. Open Settings again before changing anything else.'); }
      setBusy(false);
      setConfirmation(null);
    }
  }
  const choose = (id: string) => {
    setTeam(null); setSelected(id); selectedRef.current = id; setError(''); setNotice('');
    void load(id).catch((caught: Error) => setError(caught.message));
  };

  return (
    <div className={styles.teams} data-teams>
      <SettingsPage section={section} id="team-settings">
        {error && <Note tone="warning"><span role="alert">{error}</span></Note>}
        {notice && <Note><span role="status">{notice}</span></Note>}
        {code === 'team_step_up' && (
          <Card title="Confirm with MFA" description="This team asks for a fresh MFA sign-in for admin actions: you sign in again, then type the code from your authenticator app. The first time, the sign-in helps you set one up.">
            {list?.mfa_acr
              ? <div className={own.actions}><Button variant="primary" disabled={busy} onClick={() => { if (!verifyTeamIdentity(list.mfa_acr!)) setError('MFA needs the deployment’s sign-in.'); }}>Sign in with MFA</Button></div>
              : <Note>This server can’t check MFA at the moment.</Note>}
            <Note>Afterwards you’re back here: review the change and make it again.</Note>
          </Card>
        )}

        <Card title="Your teams" id="teams-list" description="Each team has a workspace of its own: its documents, history, builds, CAM programs and integrations. Your STEVE chats, AI keys and settings stay yours wherever you work.">
          {!list ? <Spinner /> : !list.teams.length ? <p className={own.empty}>You’re not in a team yet. Create one, or join one with an invitation code.</p> : list.teams.map((item) => (
            <div key={item.id} className={own.key} data-team={item.name}>
              <div>
                <b>{item.name}</b>
                <p>{ROLE_LABEL[item.role]}</p>
              </div>
              <div className={own.actions}>
                {item.id !== selected && <Button size="sm" variant="ghost" onClick={() => choose(item.id)}>Manage</Button>}
                {item.workspace_id === here
                  ? <><Button size="sm" variant="ghost" onClick={() => workIn(null)}>Back to Personal</Button>
                      <Button size="sm" disabled aria-current="true">Working here</Button></>
                  : <Button size="sm" onClick={() => workIn(item.workspace_id)}>Work here</Button>}
              </div>
            </div>
          ))}
          <CreateTeam busy={busy} perform={perform} onCreated={(id) => { selectedRef.current = id; }} />
          <JoinTeam busy={busy} perform={perform} verifiedEmail={list?.verified_email ?? ''} onJoined={(id) => { selectedRef.current = id; }} />
        </Card>

        {team && list && <TeamCards key={team.id} team={team} list={list} busy={busy} perform={perform} confirm={setConfirmation} />}

        <AiClients teams={list?.teams ?? []} />
      </SettingsPage>

      <Dialog open={!!confirmation} onOpenChange={(open) => { if (!open) setConfirmation(null); }} title={confirmation?.title ?? ''} width={460}
        footer={confirmation && (
          <>
            <Button variant="ghost" onClick={() => setConfirmation(null)} disabled={busy}>Cancel</Button>
            <Button variant={confirmation.danger ? 'danger' : 'primary'} disabled={busy} onClick={() => void perform(confirmation.run, confirmation.done)} data-confirm-change>{confirmation.action}</Button>
          </>
        )}>
        {confirmation && <p className={styles.confirmText}>{confirmation.text}</p>}
      </Dialog>
    </div>
  );
}

function CreateTeam({ busy, perform, onCreated }: { busy: boolean; perform: (work: () => Promise<unknown>, done: string) => Promise<void>; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const request = useRef(newId());
  return (
    <form className={styles.inline} onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const made = await teams.create(name.trim(), request.current);   // the same request id on a retry: one team
      onCreated(made.id); request.current = newId(); setName('');
    }, 'Team created. Use “Work here” to work in its workspace.'); }}>
      <label className={own.label} htmlFor="team-name">New team</label>
      <div className={own.actions}>
        <input id="team-name" className={own.input} placeholder="Team name" value={name} maxLength={100} disabled={busy}
          onChange={(event) => { setName(event.target.value); request.current = newId(); }} />
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Create team</Button>
      </div>
    </form>
  );
}

function JoinTeam({ busy, perform, verifiedEmail, onJoined }: { busy: boolean; perform: (work: () => Promise<unknown>, done: string) => Promise<void>; verifiedEmail: string; onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form className={styles.inline} onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const joined = await teams.accept(code.trim()); setCode(''); onJoined(joined.id);
    }, 'You joined the team.'); }}>
      <label className={own.label} htmlFor="team-invitation-code">Invitation code</label>
      <div className={own.actions}>
        <input id="team-invitation-code" className={own.input} type="password" autoComplete="off" value={code} maxLength={43} disabled={busy} onChange={(event) => setCode(event.target.value)} />
        <Button type="submit" disabled={busy || !code.trim()}>Join team</Button>
      </div>
      <p className={own.empty}>Codes work once, for 48 hours, for the email they were made for{verifiedEmail ? ` (yours: ${verifiedEmail})` : ''}.</p>
    </form>
  );
}

function TeamCards({ team, list, busy, perform, confirm }: { team: TeamDetail; list: TeamList; busy: boolean;
  perform: (work: () => Promise<unknown>, done: string) => Promise<void>; confirm: (confirmation: Confirmation) => void }) {
  const me = list.personal_workspace;
  const manages = team.role === 'owner' || team.role === 'admin';
  const [name, setName] = useState(team.name);
  const mine = team.members.find((member) => member.principal_id === me)?.display_name ?? '';
  const [myName, setMyName] = useState(mine);
  const who = (member: { display_name: string; email: string | null; principal_id: string }) => `${member.display_name}${member.email ? ` (${member.email})` : ''}`;
  return (
    <>
      <Card title={team.name} id="team-members" description={`Your role: ${ROLE_LABEL[team.role]} — ${ROLE_HINT[team.role]}.`}>
        <form className={styles.inline} onSubmit={(event) => { event.preventDefault(); void perform(() => teams.setName(team, myName.trim()), 'Your name in the team changed.'); }}>
          <label className={own.label} htmlFor="team-my-name">Your name in this team</label>
          <div className={own.actions}>
            <input id="team-my-name" className={own.input} value={myName} maxLength={120} disabled={busy} onChange={(event) => setMyName(event.target.value)} />
            <Button type="submit" disabled={busy || !myName.trim() || myName.trim() === mine}>Change</Button>
          </div>
          <p className={own.empty}>What the team’s people and its activity show for you, instead of the name from your Google or X sign-in. Its admins also see your sign-in email.</p>
        </form>
        {manages && (
          <form className={styles.inline} onSubmit={(event) => { event.preventDefault(); void perform(() => teams.rename(team, name.trim()), 'Team renamed.'); }}>
            <label className={own.label} htmlFor="team-rename">Name</label>
            <div className={own.actions}>
              <input id="team-rename" className={own.input} value={name} maxLength={100} disabled={busy} onChange={(event) => setName(event.target.value)} />
              <Button type="submit" disabled={busy || !name.trim() || name.trim() === team.name}>Rename</Button>
            </div>
          </form>
        )}
        <div role="list" aria-label="Team members">
          {team.members.map((member) => {
            const self = member.principal_id === me;
            const canRemove = member.role !== 'owner' && (self || team.role === 'owner' || (team.role === 'admin' && (member.role === 'member' || member.role === 'viewer')));
            const roles: ('admin' | 'member' | 'viewer')[] = team.role === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
            const canRole = !self && member.role !== 'owner' && (team.role === 'owner' || (team.role === 'admin' && member.role !== 'admin'));
            return (
              <div key={member.principal_id} className={own.key} role="listitem" data-member={member.display_name}>
                <div>
                  <b>{member.display_name}{self ? ' (you)' : ''}</b>
                  <p>{member.email ? `${member.email} · ` : ''}{ROLE_LABEL[member.role]} · joined {new Date(member.joined_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</p>
                </div>
                <div className={own.actions}>
                  {canRole && (
                    <Select ariaLabel={`Role of ${member.display_name}`} value={member.role as 'admin' | 'member' | 'viewer'} disabled={busy}
                      options={roles.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
                      onChange={(role) => {
                        if (role === member.role) return;
                        const run = () => teams.role(team, member.principal_id, role);
                        if (role === 'admin') confirm({ title: 'Make an admin?', action: 'Make admin', run, done: `${member.display_name} is an admin.`,
                          text: `${who(member)} will manage ${team.name}'s people, invitations, integrations and API keys.` });
                        else void perform(run, `${member.display_name} is now ${ROLE_LABEL[role].toLowerCase()}.`);
                      }} />
                  )}
                  {team.role === 'owner' && !self && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm({ title: 'Hand over ownership?', action: 'Transfer ownership',
                      run: () => teams.transfer(team, member.principal_id), done: `${member.display_name} owns ${team.name} now.`,
                      text: `${who(member)} becomes the owner of ${team.name}; you stay as an admin. Only the new owner can delete the team or hand it on.` })}>Transfer ownership</Button>
                  )}
                  {canRemove && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm({ title: self ? `Leave ${team.name}?` : 'Remove from the team?', action: self ? 'Leave team' : 'Remove', danger: true,
                      run: () => teams.remove(team, member.principal_id), done: self ? `You left ${team.name}.` : `${member.display_name} was removed.`,
                      text: self ? `You lose access to ${team.name}'s workspace at once. What you made there stays the team's.`
                        : `${who(member)} loses access to ${team.name}'s workspace at once, and their work STEVE or their AI clients still had queued there stops. What they made stays the team's.` })}>{self ? 'Leave team' : 'Remove'}</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <WorkCard team={team} />
      {manages && <InviteCard team={team} busy={busy} perform={perform} />}
      {manages && (
        <Card title="Membership history" id="team-membership-history" description="Every change to the team's people and settings, with who made it. It can't be edited.">
          {!team.events.length ? <p className={own.empty}>Nothing yet.</p> : (
            <ul className={styles.events}>
              {team.events.map((event) => (
                <li key={event.id}><b>{event.actor_name}</b> {event.action === 'remove' && event.details.member_id === event.actor_id ? 'left the team' : describeEvent(event)}
                  <time dateTime={event.created_at}>{when(event.created_at)}</time></li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {team.role === 'owner' && <MfaCard team={team} list={list} busy={busy} confirm={confirm} />}
      {manages && <ExportCard team={team} />}
      {team.role === 'owner' && <DeleteCard team={team} busy={busy} perform={perform} />}
    </>
  );
}

function InviteCard({ team, busy, perform }: { team: TeamDetail; busy: boolean; perform: (work: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'viewer'>('member');
  const [issued, setIssued] = useState<{ email: string; token: string; link: string } | null>(null);   // in memory only, shown once
  const pending = team.invitations.filter((item) => !item.revoked_at && !item.accepted_at && Date.parse(item.expires_at) > Date.now());
  const past = team.invitations.filter((item) => !pending.includes(item));
  return (
    <Card title="Invite people" id="team-invite" description="An invitation is a link (or its code) you give the person yourself: it works once, for 48 hours, and only for someone signed in with that verified email. STEVE sends no email.">
      <form className={own.form} onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        setIssued(null);
        const made = await teams.invite(team, email.trim(), role);
        setIssued({ email: email.trim(), token: made.token, link: made.link }); setEmail('');
      }, 'Invitation made. Give the link (or the code) to the person.'); }}>
        <div className={own.actions}>
          <input id="team-invite-email" aria-label="Email address" className={own.input} type="email" placeholder="name@example.com" maxLength={254} required value={email}
            disabled={busy} onChange={(event) => setEmail(event.target.value)} />
          <Select ariaLabel="Role" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }]} />
          <Button type="submit" disabled={busy || !email.trim()}>Create invitation</Button>
        </div>
      </form>
      {issued && (
        <div className={own.secret} data-invitation-code>
          <p>The invitation for {issued.email}. It's shown only now: copy the link (or the code) and give it to them. They open it signed in
            with that email and accept; it works once, for 48 hours.</p>
          <div className={own.secretValue}>
            <code aria-label="New invitation link">{issued.link}</code>
            <Button size="sm" onClick={() => void navigator.clipboard?.writeText(issued.link)} data-copy-invitation-link>Copy link</Button>
          </div>
          <div className={own.secretValue}>
            <code aria-label="New invitation code">{issued.token}</code>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(issued.token)}>Copy code</Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>Done</Button>
          </div>
        </div>
      )}
      {pending.map((item) => (
        <div key={item.id} className={own.key} data-invitation={item.email}>
          <div><b>{item.email}</b><p>{item.role === 'viewer' ? 'Viewer' : 'Member'} · until {when(item.expires_at)}</p></div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(() => teams.revoke(team, item.id), 'Invitation revoked.')}>Revoke</Button>
        </div>
      ))}
      <Past label="Used, revoked or expired" count={past.length}>
        {past.map((item) => (
          <div key={item.id} className={own.key} data-revoked><div><b>{item.email}</b>
            <p>{item.accepted_at ? `Joined ${when(item.accepted_at)}` : item.revoked_at ? `Revoked ${when(item.revoked_at)}` : `Expired ${when(item.expires_at)}`}</p></div></div>
        ))}
      </Past>
    </Card>
  );
}

function MfaCard({ team, list, busy, confirm }: { team: TeamDetail; list: TeamList; busy: boolean; confirm: (confirmation: Confirmation) => void }) {
  const available = list.mfa_available;
  return (
    <Card title="Admin actions" id="team-mfa" description="Making an admin, handing over ownership and deleting the team are done only by you, in STEVE's web app (never by an AI client, app, API key or script), after you confirm them here.">
      <div className={styles.switchRow}>
        <div>
          <b>Require MFA for admin actions</b>
          <p>{available ? 'Also ask for a fresh sign-in with MFA (a code from an authenticator app) before each of them.' : list.mfa_unavailable_reason ?? 'This server can’t check MFA.'}</p>
        </div>
        <Switch label="Require MFA for admin actions" checked={team.mfa_required} disabled={busy || !available}
          onCheckedChange={(on) => confirm({ title: on ? 'Require MFA for admin actions?' : 'Stop requiring MFA?', action: on ? 'Require MFA' : 'Stop requiring it',
            run: () => teams.settings(team, on), done: on ? 'Admin actions now need a fresh MFA sign-in.' : 'Admin actions no longer need MFA.',
            text: on ? `From now on, making an admin, handing over ownership, deleting ${team.name} and changing this need a fresh sign-in with MFA: a code from an authenticator app on your phone. If you haven’t set one up, the sign-in helps you the first time.`
              : `Turning it off needs a fresh MFA sign-in too, so a stolen session can't switch it off.` })} />
      </div>
    </Card>
  );
}

function useExports(team: Team) {
  const [exports, setExports] = useState<Job[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => teams.exports(team).then((body) => setExports(body.exports), (caught: Error) => setError(caught.message)), [team]);
  useEffect(() => { void load(); }, [load]);
  const working = exports?.some((job) => job.status === 'waiting' || job.status === 'building');
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [working, load]);
  const start = async () => { setError(''); try { await teams.startExport(team); await load(); } catch (caught) { setError((caught as Error).message); } };
  const download = async (job: Job) => {
    setError('');
    try {
      const response = await fetch(teams.exportUrl(team, job), { headers: { 'X-Steve-Workspace': 'personal' } });
      if (!response.ok) throw new Error('That export isn’t available any more. Make a new one.');
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: `steve-team-${(job.finished_at ?? '').slice(0, 10)}.zip` });
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) { setError((caught as Error).message); }
  };
  return { exports, error, working: !!working, start, download };
}

function ExportList({ team }: { team: Team }) {
  const { exports, error, working, start, download } = useExports(team);
  return (
    <>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}><Button onClick={() => void start()} disabled={working} data-team-export>Prepare a download</Button></div>
      {!exports ? <Spinner /> : !exports.length ? <p className={own.empty}>No downloads yet.</p> : exports.map((job) => (
        <div key={job.id} className={own.key} data-export={job.id}>
          <div><b>{when(job.created_at)}</b>
            <p>{job.status === 'ready' ? `Ready${job.size ? ` · ${size(job.size)}` : ''}` : job.status === 'failed' ? (job.error ?? 'Couldn’t be made.') : 'Preparing…'}</p></div>
          {job.status === 'ready' ? <Button size="sm" onClick={() => void download(job)}>Download</Button> : job.status === 'failed' ? null : <Spinner />}
        </div>
      ))}
    </>
  );
}

function ExportCard({ team }: { team: Team }) {
  return (
    <Card title="Download the team's data" id="team-export" description="One zip with everything in the team's workspace: its documents and their history, uploads, and its people and activity. Nobody's personal work is in it.">
      <ExportList team={team} />
    </Card>
  );
}

function DeleteCard({ team, busy, perform }: { team: TeamDetail; busy: boolean; perform: (work: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const close = () => { setOpen(false); setTyped(''); };
  return (
    <Card title="Delete the team" id="team-delete" description="Deletes the team and everything in its workspace for good: documents, history, builds, CAM programs, integrations and keys. Its members' own work stays theirs.">
      <div className={own.actions}><Button variant="danger" onClick={() => setOpen(true)} disabled={busy}>Delete the team…</Button></div>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }} title={`Delete ${team.name}?`} width={520}
        description="Nobody can reach its workspace from the moment you confirm; then everything in it is erased. It can't be undone."
        footer={<>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" disabled={busy || typed !== team.name} data-delete-team
            onClick={() => void perform(async () => { await teams.remove_team(team, typed); close(); }, `${team.name} is being deleted.`)}>Delete the team</Button>
        </>}>
        <div className={own.form}>
          <p className={styles.confirmText}>Download its data first if anyone may need it:</p>
          <ExportList team={team} />
          <label className={own.label} htmlFor="team-delete-confirm">Type <b>{team.name}</b> to confirm.</label>
          <input id="team-delete-confirm" className={own.input} value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
        </div>
      </Dialog>
    </Card>
  );
}

function AiClients({ teams: mine }: { teams: Team[] }) {
  const [clients, setClients] = useState<AiClient[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  useEffect(() => { void teams.clients().then((body) => setClients(body.clients), (caught: Error) => setError(caught.message)); }, []);
  if (!mine.length) return null;
  const toggle = async (client: AiClient, teamId: string, on: boolean) => {
    setSaving(client.client); setError('');
    const wanted = on ? [...new Set([...client.teams, teamId])] : client.teams.filter((id) => id !== teamId);
    try { setClients((await teams.setClient(client.client, wanted)).clients); } catch (caught) { setError((caught as Error).message); }
    finally { setSaving(''); }
  };
  return (
    <Card title="AI clients" id="team-ai-clients" description="Which of your teams each AI client (Claude, ChatGPT, Codex… connected over MCP) may work in. Without a tick it works in your personal workspace only. An agent picks a team with the workspace argument of STEVE's tools. A client is told apart by the sign-in it registered with STEVE: if several of your AI tools share one (a server set up with a single MCP client), allowing it allows them all. Its name here comes from what the client says it is, so check when you last used it.">
      {error && <Note tone="warning">{error}</Note>}
      {!clients ? <Spinner /> : !clients.length ? <p className={own.empty}>No AI client has used your account yet. Connect one in Settings → MCP; it shows here after its first call.</p> : clients.map((client) => (
        <div key={client.client} className={own.key} data-ai-client={client.label}>
          <div>
            <b>{client.label === 'other' ? 'An AI client' : client.label}</b>
            <p>Last used {when(client.last_seen)} · <code>{client.client.length > 28 ? `${client.client.slice(0, 28)}…` : client.client}</code></p>
          </div>
          <div className={styles.clientTeams}>
            {mine.map((item) => (
              <label key={item.id} className={own.scope}>
                <input type="checkbox" checked={client.teams.includes(item.id)} disabled={saving === client.client}
                  onChange={(event) => void toggle(client, item.id, event.target.checked)} />
                {item.name}
              </label>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

/** The team's work: who changed what and how (people, their AI clients, STEVE), and the branches waiting for review.
 * Any member reads it; each line opens the document (in the team's workspace). */
function WorkCard({ team }: { team: TeamDetail }) {
  const [data, setData] = useState<{ activity: ActivityItem[]; branches: OpenBranch[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    void teams.activity(team.id).then(setData, (caught: Error) => setError(caught.message));
  }, [team.id]);
  useEffect(() => { load(); }, [load]);
  const open = (document: string, branch?: string | null) => openIn(team.workspace_id, document, branch ?? 'main');
  return (
    <Card title="Team activity" id="team-work" description="What changed in the team's workspace, who did it and how: in the web app, through an AI client, or with STEVE. Agents work on branches; a member reviews and merges them."
      actions={<Button size="sm" variant="ghost" onClick={load}>Refresh</Button>}>
      {error && <Note tone="warning">{error}</Note>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <h4 className={styles.subhead}>Open branches to review</h4>
          {!data.branches.length ? <p className={own.empty}>No open branches.</p> : (
            <ul className={styles.work} aria-label="Open branches">
              {data.branches.map((item) => (
                <li key={`${item.document.id}:${item.branch}`} data-open-branch={item.branch}>
                  <button type="button" className={styles.workLink} onClick={() => open(item.document.id, item.branch)}>
                    <b>{item.document.name}</b> · {item.branch}
                  </button>
                  <span className={styles.workMeta}>
                    {whoLabel(item.who) || 'Someone'}{item.ahead ? ` · ↑${item.ahead}` : ''}{item.behind ? ` ↓${item.behind}` : ''}
                    {item.updated_at ? ` · ${relativeTime(item.updated_at)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h4 className={styles.subhead}>Latest changes</h4>
          {!data.activity.length ? <p className={own.empty}>Nothing yet.</p> : (
            <ul className={styles.work} aria-label="Team activity">
              {data.activity.map((item, index) => (
                <li key={`${item.at}:${index}`} data-activity={item.kind}>
                  <span><b>{whoLabel(item.who) || 'Someone'}</b>{' '}
                    <button type="button" className={styles.workLink} onClick={() => open(item.document.id, item.branch)}>{activityText(item)}</button>
                    {item.text && <span className={styles.workQuote}>“{item.text}”</span>}
                  </span>
                  <time dateTime={item.at} className={styles.workMeta}>{relativeTime(item.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
