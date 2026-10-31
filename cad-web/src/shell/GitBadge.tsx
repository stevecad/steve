import { useEffect, useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Tip } from '@/ui';
import { useApp } from '@/state/store';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { openSettings } from '@/settings/registry';
import styles from './TopBar.module.css';

interface GitStatus { synced: boolean; url?: string; path?: string; synced_at?: string | null; error?: string | null; stopped?: boolean }

const short = (url: string) => url.replace(/^(https|ssh):\/\/([^@/]+@)?(www\.)?/, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '');

/** Beside the branch pill, only for a document synced with a git repository (app/git_sync.py): which one, and
 * whether its sync needs the person. Opens Settings → Version control. */
export default function GitBadge() {
  const id = useApp((state) => state.doc.saved?.id);
  const revision = useApp((state) => state.doc.saved?.revision);
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!id) return;
    let live = true;
    const look = () => void api<GitStatus>(`/v1/git/documents/${id}`).then((found) => { if (live) setStatus(found); }, () => undefined);
    look();
    const timer = window.setTimeout(look, 15_000);   // a save is pushed a few seconds later: show that sync too
    return () => { live = false; window.clearTimeout(timer); };
  }, [id, revision]);
  if (!status?.synced || !status.url) return null;
  const trouble = status.stopped ? 'Its folder was deleted in git, so it no longer syncs.' : status.error;
  const where = `${short(status.url)}${status.path ? ` / ${status.path}` : ''}`;
  return (
    <Tip label={trouble ? 'Git sync needs you' : 'In git'} description={trouble ? `${where}: ${trouble}` : `${where} · synced ${status.synced_at ? relativeTime(status.synced_at) : 'soon'}`}>
      <button type="button" className={styles.gitBadge} data-trouble={trouble ? '' : undefined} aria-label={trouble ? 'Git sync needs you' : `In git: ${where}`}
              onClick={() => openSettings('version-control')} id="git-badge">
        <FolderGit2 size={13} strokeWidth={2} />
      </button>
    </Tip>
  );
}
