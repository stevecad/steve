import { Html } from '@react-three/drei';
import { set, useApp } from '@/state/store';
import { useComments } from '@/comments/comments';
import styles from './Viewport.module.css';

/** Numbered pins for the open document's comments (comments/comments.ts) at the geometry they were written about;
 * clicking one opens it in the Comments panel. Resolved ones show only while the panel shows resolved comments. */
export default function CommentPins() {
  const open = useApp((state) => state.doc.open && !!state.doc.saved);
  const { threads, focus, showResolved } = useComments();
  if (!open) return null;
  return (
    <group>
      {threads.filter((thread) => thread.status === 'open' || showResolved).flatMap((thread) =>
        thread.anchor.filter((anchor) => anchor.point).map((anchor, i) => (
          <Html key={`${thread.id}:${i}`} position={anchor.point!} center zIndexRange={[18, 8]}>
            <button type="button" className={styles.commentPin} data-focus={focus === thread.id || undefined} data-status={thread.status}
              data-comment-pin={thread.number} aria-label={`Comment ${thread.number}`} title={thread.body.slice(0, 140)}
              onClick={() => { useComments.setState({ focus: thread.id }); set({ dockOpen: true, dockTab: 'comments' }); }}>
              {thread.number}
            </button>
          </Html>
        )))}
    </group>
  );
}
