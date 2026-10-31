/** A plain CodeMirror editor for a skill's SKILL.md: line-wrapped Markdown with the Source panel's theme. */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { sourceTheme } from './source/theme';
import own from './Steve.module.css';

export default function SkillEditor({ value, onChange, onSave, readOnly, label }: {
  value: string; onChange: (text: string) => void; onSave?: () => void; readOnly: boolean; label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  const locked = useRef(new Compartment());
  useLayoutEffect(() => { handlers.current = { onChange, onSave }; });

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Ctrl/Cmd+S saves the skill and must not also reach the app's own Save.
          EditorView.domEventHandlers({ keydown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault(); event.stopPropagation(); handlers.current.onSave?.(); return true;
            }
            return false;
          } }),
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping, sourceTheme(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          locked.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
          EditorView.updateListener.of((update) => { if (update.docChanged) handlers.current.onChange(update.state.doc.toString()); }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // Created once; value and readOnly changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: locked.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);

  return <div ref={host} className={own.editor} data-readonly={readOnly || undefined} />;
}
