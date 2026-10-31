import { useEffect, useState } from 'react';
import { Factory } from 'lucide-react';
import { Tip } from '@/ui';
import { set, useApp } from '@/state/store';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { issueText, jobText, methodText, type CarbonIssue, type CarbonJob, type CarbonMethod } from '@/dialogs/CarbonDialog';
import styles from './TopBar.module.css';

interface CarbonItem { url: string | null; sent_at: string; document_revision: number | null; method?: CarbonMethod | null }
interface ForDocument { connected: boolean; number: string; revision: string; item: CarbonItem | null; jobs?: CarbonJob[]; issues?: CarbonIssue[] }

/** Beside the branch pill, only for a part or design sent to Carbon (app/carbon.py): its Carbon item, whether the
 * document changed since it was sent, where its method stands (released, or a Draft on a change notice), its open quality
 * issues (in red) and its open jobs. Opens Send to Carbon. */
export default function CarbonBadge() {
  const id = useApp((state) => state.doc.saved?.id);
  const revision = useApp((state) => state.doc.saved?.revision);
  const kind = useApp((state) => state.doc.kind);
  const [found, setFound] = useState<ForDocument | null>(null);
  useEffect(() => {
    setFound(null);
    if (!id || (kind !== 'part' && kind !== 'design')) return;
    let live = true;
    void api<ForDocument>(`/v1/carbon/documents/${id}`).then((answer) => { if (live) setFound(answer); }, () => undefined);
    return () => { live = false; };
  }, [id, kind]);
  if (!found?.item) return null;
  const sent = found.item.document_revision;
  const changed = sent != null && revision != null && revision > sent;
  const what = `${found.number} rev ${found.revision}`;
  const issues = found.issues ?? [];
  const jobs = (found.jobs ?? []).filter((job) => job.open);
  const floor = [...issues.map((issue) => `Quality issue ${issueText(issue)}`), ...jobs.slice(0, 3).map(jobText)];
  return (
    <Tip label={issues.length ? `${issues.length} open quality issue${issues.length > 1 ? 's' : ''} in Carbon` : sent == null ? 'Linked to Carbon' : changed ? 'Changed since sent to Carbon' : 'In Carbon'}
         description={<>
           {sent == null ? `${what} · opened from a Carbon quote, not sent back yet` :
             `${what} · sent ${relativeTime(found.item.sent_at)} (revision ${sent})${changed ? '. Send it again to update the Carbon item.' : ''}`}
           {found.item.method && <div>{methodText(found.item.method)}</div>}
           {floor.map((line) => <div key={line}>{line}</div>)}
         </>}>
      <button type="button" className={styles.carbonBadge} data-changed={changed ? '' : undefined} data-issues={issues.length ? '' : undefined}
              aria-label={issues.length ? `Open quality issues in Carbon: ${what}` : changed ? `Changed since sent to Carbon: ${what}` : `In Carbon: ${what}`}
              onClick={() => set({ dialog: 'carbon' })} id="carbon-badge">
        <Factory size={13} strokeWidth={2} />
      </button>
    </Tip>
  );
}

