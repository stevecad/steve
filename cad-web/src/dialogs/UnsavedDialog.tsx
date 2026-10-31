import { TriangleAlert } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { forgetDraft, saveDocument } from '@/state/actions';
import styles from './Dialogs.module.css';

export default function UnsavedDialog({ open }: { open: boolean }) {
  const name = useApp((state) => state.doc.name);
  const cancel = () => set({ dialog: null, pendingLeave: null });
  const discard = () => {
    const action = get().pendingLeave;
    set({ dialog: null, pendingLeave: null });
    forgetDraft();
    action?.();
  };
  const save = async () => {
    const action = get().pendingLeave;
    set({ dialog: null, pendingLeave: null });
    if (await saveDocument()) action?.();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && cancel()}
      width={440}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--warning)' }}><TriangleAlert size={17} /></div>}
      title="Save changes?"
      description={<span id="unsaved-description">“{name.trim() || 'Untitled'}” has unsaved changes.</span>}
      footer={<>
        <Button variant="ghost" id="discard-changes" onClick={discard} style={{ marginRight: 'auto' }}>Discard changes</Button>
        <Button id="cancel-leave" onClick={cancel} autoFocus>Cancel</Button>
        <Button id="save-and-leave" variant="primary" onClick={() => { void save(); }}>Save</Button>
      </>}
    />
  );
}
