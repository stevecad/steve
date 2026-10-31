import { useEffect, useState } from 'react';
import { GitBranchPlus } from 'lucide-react';
import { Button, Dialog, Field, ui } from '@/ui';
import { set, useApp } from '@/state/store';
import { createBranch } from '@/state/actions';
import { BRANCH_NAME_RULE, slugBranch, validBranchName } from '@/lib/branches';
import styles from './Dialogs.module.css';

export default function BranchDialog({ open }: { open: boolean }) {
  const from = useApp((state) => state.branchFrom);
  const revision = useApp((state) => state.doc.saved?.revision);
  const branch = useApp((state) => state.doc.branch);
  const branches = useApp((state) => state.branches);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setName(''); }, [open]);
  const slug = slugBranch(name);
  const taken = branches?.some((item) => item.name === slug);
  const valid = validBranchName(slug) && !taken;
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    if (await createBranch(slug, from)) set({ dialog: null, browserOpen: true, leftTab: 'versions' });
    setBusy(false);
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && set({ dialog: null })} width={460}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><GitBranchPlus size={17} /></div>}
      title="New branch"
      description={from ? `Starts from main revision ${from}.` : `Starts from the latest main${branch !== 'main' ? '' : revision ? ` (revision ${revision})` : ''}. Changes stay on the branch until you merge them.`}
      footer={<><Button onClick={() => set({ dialog: null })}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={() => { void submit(); }}>{busy ? 'Creating…' : 'Create branch'}</Button></>}>
      <Field label="Name" hint={name && slug !== name ? <>Will be created as <span className="mono">{slug || '—'}</span></> : BRANCH_NAME_RULE}>
        <input className={ui.input} autoFocus placeholder="wider-flange" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} style={{ fontFamily: 'var(--font-mono)' }} />
      </Field>
      {taken && <p className={styles.message} style={{ color: 'var(--warning)' }}>A branch with that name already exists.</p>}
    </Dialog>
  );
}
