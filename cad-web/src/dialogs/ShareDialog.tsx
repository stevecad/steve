/**
 * Share a link to this design's saved version. The person picks what the link allows, reads in plain words what
 * anyone with it can do, and confirms. The link is shown once, when it's made. Existing links are listed with their views and can be revoked. Only a person can
 * do this: the server refuses STEVE, MCP and API tokens (app/shares.py).
 */
import { useEffect, useState } from 'react';
import { Copy, Link2, Share2, Trash2 } from 'lucide-react';
import { Button, Dialog, Field, Segmented, Select } from '@/ui';
import { set, toast, useApp } from '@/state/store';
import { ApiError } from '@/lib/api';
import { reauthenticate } from '@/auth/auth';
import { Shares, shareLink, type Preparation, type Share, type ShareLevel, type ShareTerms } from '@/lib/shares';
import { kinematicsOf } from '@/motion/kinematics';
import styles from './Dialogs.module.css';

const LEVELS: { value: ShareLevel; label: string; title: string }[] = [
  { value: 'view', label: 'View only', title: 'Explore the 3D model. No files.' },
  { value: 'step', label: 'View + STEP', title: 'Also download the STEP file.' },
  { value: 'code', label: 'View + STEP + code', title: 'Also download the design’s source code.' },
];
const EXPIRY: { value: string; label: string }[] = [
  { value: 'never', label: 'Never expires' }, { value: '7', label: 'Expires in 7 days' }, { value: '30', label: 'Expires in 30 days' }, { value: '365', label: 'Expires in a year' },
];
/** The choice in progress while the person signs in again (this tab only). */
const PENDING = 'steve.pendingShare';
interface Pending { document_id: string; revision: number; level: ShareLevel; expiry: string; motion?: boolean }

export function pendingShare(): Pending | null {
  try { return JSON.parse(sessionStorage.getItem(PENDING) || 'null') as Pending | null; } catch { return null; }
}

function when(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATES: Record<Preparation, string> = { ready: 'ready', preparing: 'being prepared…', unavailable: 'not available' };

/** What the new link's STEP file and preview picture are waiting for: each is made for this version on its own. */
function Preparing({ share }: { share: Share }) {
  const prepared = share.prepared;
  if (!prepared) return null;
  const items = [...(share.level !== 'view' ? [['STEP file', prepared.step] as const] : []), ['Link preview picture', prepared.picture] as const];
  if (items.every(([, state]) => state === 'ready') && !share.note) return null;
  return (
    <div role="status" className={styles.message} style={{ color: 'var(--text-3)' }}>
      The link works now. {items.map(([label, state]) => `${label}: ${STATES[state]}`).join(' · ')}
      {items.some(([, state]) => state === 'preparing') ? ' (being made for this version).' : ''}
      {share.note ? <><br />{share.note}</> : null}
    </div>
  );
}

export default function ShareDialog({ open }: { open: boolean }) {
  const saved = useApp((state) => state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  const name = useApp((state) => state.doc.name);
  // A design with joints: the owner may let visitors move it (off unless they tick it).
  const jointed = useApp((state) => state.doc.kind === 'design' && !!kinematicsOf(state.displayed?.metadata)?.joints.some((joint) => joint.type !== 'rigid'));
  // Until the model is built (e.g. just back from signing in again) its joints aren't known yet: say so, rather than
  // hiding the option or sharing without the motion the person chose.
  const loadingJoints = useApp((state) => state.doc.kind === 'design' && !state.displayed?.metadata && state.busy);
  const [terms, setTerms] = useState<ShareTerms | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [level, setLevel] = useState<ShareLevel>('view');
  const [expiry, setExpiry] = useState('never');
  const [motion, setMotion] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Share | null>(null);

  // Keyed on the saved version, not the object: a finished build patches `saved` (its preview), which must not reset the
  // person's choice or the link just made.
  const savedId = saved?.id;
  const savedRevision = saved?.revision;
  useEffect(() => {
    if (!open || !savedId) return;
    const pending = pendingShare();
    const resumed = pending && pending.document_id === savedId && pending.revision === savedRevision ? pending : null;
    setLevel(resumed?.level ?? 'view'); setExpiry(resumed?.expiry ?? 'never'); setMotion(!!resumed?.motion); setUnderstood(!!resumed);
    setCreated(null); setError(null);
    try { sessionStorage.removeItem(PENDING); } catch { /* Storage is optional. */ }
    Shares.terms().then(setTerms, (e: Error) => setError(e.message));
    Shares.list(savedId).then((result) => setShares(result.shares), () => setShares([]));
  }, [open, savedId, savedRevision]);

  // The link works at once; its STEP file and picture follow the full model of this version (the server builds it if
  // needed). Check now and then while the dialog is open, so the person sees when they're ready.
  const waiting = !!created?.prepared && Object.values(created.prepared).includes('preparing');
  useEffect(() => {
    if (!waiting || !created) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 180) { clearInterval(timer); return; }
      Shares.get(created.id).then((share) => setCreated((current) => (current?.id === share.id ? { ...current, prepared: share.prepared } : current)), () => { /* Next time. */ });
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, created?.id]);

  const choose = (value: ShareLevel) => { setLevel(value); setUnderstood(false); };   // Each level is acknowledged on its own.
  const allowMotion = (value: boolean) => { setMotion(value); setUnderstood(false); };   // So is what moving it reveals.
  const moving = jointed && motion;
  const waitingForJoints = motion && loadingJoints;   // Their choice to let visitors move it waits for the joints.
  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => toast('success', 'Link copied'), () => toast('danger', 'Couldn’t copy the link'));
  };
  const create = async () => {
    if (!saved || !terms || !understood || waitingForJoints) return;
    setBusy(true); setError(null);
    try {
      const share = await Shares.create({ document_id: saved.id, branch, revision: saved.revision, level, acknowledged: true,
        terms_version: terms.version, expires_in_days: expiry === 'never' ? null : Number(expiry), motion: moving });
      setCreated(share);
      setShares((list) => [share, ...(list ?? [])]);
      if (share.url) copy(shareLink(share));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauthentication_required') {
        // Confirm it's really them: the provider's sign-in, then back here with the same choice.
        try { sessionStorage.setItem(PENDING, JSON.stringify({ document_id: saved.id, revision: saved.revision, level, expiry, motion: moving } satisfies Pending)); } catch { /* Storage is optional. */ }
        if (reauthenticate()) return;
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (share: Share) => {
    try {
      const revoked = await Shares.revoke(share.id);
      setShares((list) => (list ?? []).map((item) => (item.id === share.id ? revoked : item)));
      if (created?.id === share.id) setCreated(null);
      toast('success', 'Link revoked', 'It no longer works for anyone.');
    } catch (e) {
      toast('danger', 'Couldn’t revoke the link', (e as Error).message);
    }
  };

  const active = (shares ?? []).filter((share) => !share.revoked_at && !(share.expires_at && new Date(share.expires_at) < new Date()));
  const onBranch = branch !== 'main';
  return (
    <Dialog open={open} onOpenChange={(value) => !value && set({ dialog: null })} width={560}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><Share2 size={17} /></div>}
      title={`Share “${name}”`}
      description={!saved ? 'Save the design first.' : onBranch ? 'Only main’s saved version can be shared for now. Switch to main, or merge first.'
        : `Creates a link to revision ${saved.revision} as it is now. Later edits are not shared.`}
      footer={<>
        <Button onClick={() => set({ dialog: null })}>Close</Button>
        {!created && <Button variant="primary" disabled={!saved || onBranch || !terms || !understood || waitingForJoints || busy} onClick={() => { void create(); }}>
          {busy ? 'Creating…' : 'Create link'}
        </Button>}
      </>}>
      {created?.url ? (
        <>
          <Field label="Your link" hint="Copied to the clipboard. It is shown only now: keep it somewhere, or make a new one later. Anyone who has it can open it.">
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={shareLink(created)} className="mono" style={{ flex: 1 }} onFocus={(event) => event.target.select()} />
              <Button onClick={() => copy(shareLink(created))}><Copy size={14} /> Copy</Button>
            </div>
          </Field>
          <Preparing share={created} />
        </>
      ) : !onBranch && (
        <>
          <Field label="Anyone with the link can">
            <Segmented value={level} onChange={choose} options={LEVELS.map(({ value, label, title }) => ({ value, label, title }))} />
          </Field>
          <Field label="Expiry">
            <Select value={expiry} onChange={setExpiry} options={EXPIRY} ariaLabel="Expiry" />
          </Field>
          {loadingJoints && !jointed && (
            <p role="status" className={styles.message} style={{ color: 'var(--text-3)', margin: '0 0 8px' }}>
              Loading the model’s joints…{motion ? ' Your choice to let them move the mechanism is kept.' : ''}
            </p>
          )}
          {jointed && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', margin: '0 0 8px' }}>
              <input type="checkbox" checked={motion} onChange={(event) => allowMotion(event.target.checked)} />
              <span>Let them move the mechanism: drag its parts along their joints and play its motors and animations, as in the Motion tab.</span>
            </label>
          )}
          <div role="note" style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '10px 12px', margin: '4px 0 10px' }}>
            <strong>Before you share</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {[...(terms?.levels[level] ?? []), ...(moving ? terms?.motion ?? [] : [])].map((line) => <li key={line} style={{ margin: '3px 0' }}>{line}</li>)}
            </ul>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
            <span>I understand what anyone with this link can do{level !== 'view' ? ', and that downloaded files can’t be recalled' : ''}.</span>
          </label>
        </>
      )}
      {error && <p className={styles.message} style={{ color: 'var(--warning)' }}>{error}</p>}
      {active.length > 0 && (
        <Field label={`Links to this design (${active.length})`}>
          <div style={{ display: 'grid', gap: 6 }}>
            {active.map((share) => (
              <div key={share.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link2 size={14} />
                <span style={{ flex: 1 }}>
                  {LEVELS.find((item) => item.value === share.level)?.label}{share.motion ? ' · movable' : ''} · revision {share.revision} · {share.views} view{share.views === 1 ? '' : 's'}
                  {share.expires_at ? ` · until ${when(share.expires_at)}` : ''} · made {when(share.created_at)}
                </span>
                <Button size="sm" variant="danger" onClick={() => { void revoke(share); }} title="Revoke: the link stops working for everyone"><Trash2 size={14} /> Revoke</Button>
              </div>
            ))}
          </div>
        </Field>
      )}
    </Dialog>
  );
}
