import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import { sourceTheme } from '@/panels/source/theme';
import styles from './Merge.module.css';

/** Read-only side-by-side diff: main on the left, the branch on the right. */
export default function SourceCompare({ main, branch }: { main: string; branch: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [lineNumbers(), python(), sourceTheme(), EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new MergeView({
      a: { doc: main, extensions },
      b: { doc: branch, extensions },
      parent: host.current,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
      highlightChanges: true,
    });
    return () => view.destroy();
  }, [main, branch]);
  return <div ref={host} className={styles.diff} />;
}
