/**
 * An invitation link opened (teams/invite.ts): what it's for (the team, the role, who invited you), then Accept. Only the
 * person it was made for sees it: the server answers for the verified email the invitation names, and nothing is used up
 * until they accept. Afterwards they can start working in the team.
 */
import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { loadWorkspaces } from './current';
import { teams, TeamError } from './api';
import { pendingInvite } from './invite';
import { workIn } from './switch';

type State =
  | { step: 'checking' }
  | { step: 'offer'; team: string; role: string; inviter: string; expires: string }
  | { step: 'joined'; team: string; workspace: string }
  | { step: 'refused'; message: string };

export default function InvitationDialog() {
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<State>({ step: 'checking' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const taken = pendingInvite();
    if (!taken) return;
    setCode(taken);
    void teams.peek(taken).then(
      (found) => setState({ step: 'offer', team: found.team_name, role: found.role, inviter: found.inviter, expires: found.expires_at }),
      (caught: Error) => setState({ step: 'refused', message: caught instanceof TeamError && caught.code === 'invitation_invalid'
        ? 'This invitation can’t be used: it was used already, it expired or was revoked, or it was made for another email than the one you’re signed in with.'
        : caught.message }));
  }, []);
  if (!code) return null;
  const close = () => setCode(null);
  const accept = async () => {
    setBusy(true);
    try {
      const joined = await teams.accept(code);
      await loadWorkspaces();
      setState({ step: 'joined', team: state.step === 'offer' ? state.team : 'the team', workspace: joined.workspace_id });
    } catch (caught) {
      setState({ step: 'refused', message: (caught as Error).message });
    } finally { setBusy(false); }
  };
  const footer = state.step === 'offer'
    ? <><Button variant="ghost" onClick={close} disabled={busy}>Not now</Button><Button variant="primary" onClick={() => void accept()} disabled={busy} data-accept-invitation>Join {state.team}</Button></>
    : state.step === 'joined'
      ? <><Button variant="ghost" onClick={close}>Stay here</Button><Button variant="primary" onClick={() => workIn(state.workspace)} data-work-in-team>Work in {state.team}</Button></>
      : <Button onClick={close}>Close</Button>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }} title="Team invitation" icon={<Users size={18} />} width={440} footer={footer}>
      <div id="team-invitation" data-step={state.step}>
        {state.step === 'checking' && <Spinner />}
        {state.step === 'offer' && <p>{state.inviter} invited you to <b>{state.team}</b> as a {state.role}. Its workspace (documents, history,
          integrations) is shared with its members; your own work, STEVE chats, AI keys and settings stay yours. The invitation works until{' '}
          {new Date(state.expires).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</p>}
        {state.step === 'joined' && <p>You’re in {state.team}. Switch to its workspace now, or later from the account menu (<b>Working in</b>).</p>}
        {state.step === 'refused' && <p role="alert">{state.message}</p>}
      </div>
    </Dialog>
  );
}
