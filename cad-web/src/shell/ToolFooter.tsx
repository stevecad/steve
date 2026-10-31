/**
 * The footer every right-pane tool shares, as in Fusion: it belongs to the operation in progress, never to the mode
 * around it. OK commits the operation and Cancel discards it; either way the tool closes and Select is back. Tools that
 * only inspect (measure, section, explode) have a single Close. Enter is OK and Esc is Cancel for the tool opened last
 * (App's key handler asks `handleToolKeys`); a sketch keeps its own Enter/Esc ladder (web/src/sketch/tools.ts).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button, Spinner, Tip } from '@/ui';
import styles from './ToolFooter.module.css';

export interface ToolFooterProps {
  /** Commits the operation. Absent: the tool has nothing to commit (Close only). */
  onOk?: () => void;
  /** Discards the operation (or closes an inspecting tool). */
  onCancel: () => void;
  /** What OK does, for its tooltip: "Add the joint", "Create plane_1". */
  okTitle?: string;
  /** Why OK can't run yet; disables it. */
  okDisabled?: string | false | null;
  okBusy?: boolean;
  okId?: string;
  cancelId?: string;
  /** "Close" for tools that don't change the design. */
  cancelLabel?: string;
  /** Secondary actions of the tool (Clear, Flip side, Save only…), left of Cancel/OK. */
  extra?: ReactNode;
  /** Enter/Esc go to this footer while it is the newest one (default). */
  keys?: boolean;
  /** Show Enter/Esc in the tooltips even though another handler binds them (the sketch's own keys). */
  hintKeys?: boolean;
  /** Inside a footer block that already has its own border (the sketch panel). */
  inline?: boolean;
  /** Esc's first job inside the tool (stop picking faces…); true when it did something, so the tool stays open. */
  onEscape?: () => boolean;
  /** The primary button's word when it doesn't finish the tool (a step: "Next"). */
  okLabel?: string;
}

interface Keys { ok: () => void; cancel: () => void; escape?: () => boolean }
const stack: { current: Keys }[] = [];

/**
 * A key pressed inside a dropdown, menu or popover. Its Esc closes that popup, which has already left the document by the
 * time the app's handler runs, so this looks at where the key was pressed rather than at what's open now: Esc that
 * closes a list must never also cancel the tool behind it.
 */
export const fromPopup = (event: KeyboardEvent) =>
  !!(event.target as HTMLElement | null)?.closest?.('[role="menu"], [role="listbox"], [role="option"], [role="menuitem"], [data-radix-popper-content-wrapper]');

/** Enter/Esc for the newest tool footer; true when handled. Not while typing, in a menu, or on a focused button. */
export function handleToolKeys(event: KeyboardEvent): boolean {
  const top = stack.at(-1);
  if (!top || (event.key !== 'Enter' && event.key !== 'Escape') || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, select, [contenteditable], .cm-editor')) return false;
  if (document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]')) return false;
  if (fromPopup(event)) return false;
  if (event.key === 'Enter' && target?.closest?.('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"]')) return false;
  event.preventDefault();
  if (event.key === 'Enter') top.current.ok();
  else if (!top.current.escape?.()) top.current.cancel();
  return true;
}

export default function ToolFooter({ onOk, onCancel, okTitle, okDisabled, okBusy, okId, cancelId, cancelLabel = 'Cancel', extra, keys = true, hintKeys = keys, inline, onEscape, okLabel = 'OK' }: ToolFooterProps) {
  const blocked = okBusy ? 'Working…' : okDisabled || null;
  const handlers = useRef<Keys>({ ok: () => {}, cancel: onCancel });
  handlers.current = { ok: () => { if (onOk && !blocked) onOk(); }, cancel: onCancel, escape: onEscape };
  useEffect(() => {
    if (!keys) return;
    const entry = { get current() { return handlers.current; } };
    stack.push(entry);
    return () => { stack.splice(stack.indexOf(entry), 1); };
  }, [keys]);
  const close = !onOk && cancelLabel !== 'Cancel';  // An inspecting tool's Close is its only (primary) button.
  const ok = onOk && (
    <Button size="sm" variant="primary" icon={okBusy ? <Spinner size={12} /> : <Check />} id={okId} disabled={!!blocked} onClick={onOk} data-tool-ok>{okLabel}</Button>
  );
  return (
    <div className={styles.footer} data-inline={inline || undefined} data-tool-footer>
      {extra && <div className={styles.extra}>{extra}</div>}
      <span className={styles.spacer} />
      <Tip label={cancelLabel} description={close ? 'Close this tool.' : 'Discard this operation and go back to Select.'} shortcut={hintKeys ? 'Esc' : undefined} side="top">
        <Button size="sm" variant={close ? 'primary' : 'secondary'} id={cancelId} onClick={onCancel} data-tool-cancel>{cancelLabel}</Button>
      </Tip>
      {ok && (blocked
        ? <Tip label="OK" description={okTitle} reason={blocked} side="top"><span className={styles.disabled}>{ok}</span></Tip>
        : <Tip label="OK" description={okTitle ? `${okTitle}, then go back to Select.` : 'Apply, then go back to Select.'} shortcut={hintKeys ? 'Enter' : undefined} side="top">{ok}</Tip>)}
    </div>
  );
}
