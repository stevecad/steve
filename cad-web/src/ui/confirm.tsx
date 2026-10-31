/**
 * STEVE's own confirmation (never the browser's confirm/prompt): `await askConfirm({...})` is true when the person
 * chose the action; `await askText({...})` is their text, or null when they cancelled. One at a time, mounted once in
 * dialogs/Dialogs.tsx (ConfirmHost); it opens above whatever dialog asked (Settings, a library).
 */
import { useState } from 'react';
import { create } from 'zustand';
import { Button, Dialog } from './index';
import ui from './ui.module.css';

interface Ask {
  title: string;
  detail?: string;
  /** The confirming button's label: what happens ("Revoke", "Delete sheet"). */
  action: string;
  /** A destructive action (the button is red). Default true. */
  danger?: boolean;
  /** Ask for a line of text too (askText). */
  text?: { label: string; placeholder?: string };
  done: (answer: string | null) => void;
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function askConfirm(ask: Omit<Ask, 'done' | 'text'>): Promise<boolean> {
  return new Promise((resolve) => useAsk.setState({ ask: { ...ask, done: (answer) => resolve(answer !== null) } }));
}

export function askText(ask: Omit<Ask, 'done'> & { text: NonNullable<Ask['text']> }): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ ask: { ...ask, done: resolve } }));
}

export function ConfirmHost() {
  const ask = useAsk((state) => state.ask);
  const [text, setText] = useState('');
  const finish = (answer: string | null) => {
    if (!ask) return;
    useAsk.setState({ ask: null });
    setText('');
    ask.done(answer);
  };
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) finish(null); }} title={ask?.title ?? ''} description={ask?.detail} width={440}
      footer={ask && <>
        <Button variant="ghost" onClick={() => finish(null)}>Cancel</Button>
        <Button variant={ask.danger === false ? 'primary' : 'danger'} id="confirm-action" autoFocus={!ask.text} onClick={() => finish(text)}>{ask.action}</Button>
      </>}>
      {ask?.text && (
        <input className={ui.input} autoFocus aria-label={ask.text.label} placeholder={ask.text.placeholder ?? ask.text.label} value={text}
               onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') finish(text); }} />
      )}
    </Dialog>
  );
}
