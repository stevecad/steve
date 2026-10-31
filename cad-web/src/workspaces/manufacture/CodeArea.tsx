/** A plain CodeMirror editor (post source, raw JSON definitions) with the Source panel's theme. */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { sourceTheme } from '@/panels/source/theme';
import styles from './Manufacture.module.css';

export default function CodeArea({ value, onChange, readOnly, label, line }: { value: string; onChange?: (text: string) => void; readOnly: boolean; label: string; line?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handler = useRef(onChange);
  const locked = useRef(new Compartment());
  useLayoutEffect(() => { handler.current = onChange; });

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), sourceTheme(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          locked.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          EditorView.updateListener.of((update) => { if (update.docChanged) handler.current?.(update.state.doc.toString()); }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: locked.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);
  // A line to show (an item's source line): selected and scrolled into view.
  useEffect(() => {
    const editor = view.current;
    if (!editor || !line || line < 1 || line > editor.state.doc.lines) return;
    const at = editor.state.doc.line(line);
    editor.dispatch({ selection: { anchor: at.from, head: at.to }, effects: EditorView.scrollIntoView(at.from, { y: 'center' }) });
  }, [line, value]);

  return <div className={styles.code} data-readonly={readOnly || undefined}><div ref={host} /></div>;
}
