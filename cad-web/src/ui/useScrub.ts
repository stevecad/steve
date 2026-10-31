/**
 * Press-and-drag scrubbing for a number field, as the code editor's Alt+drag on a literal: drag sideways to change the
 * value (5 px a step, the literal's own precision or the field's own `step`); Shift is ×10, Alt or Ctrl ÷10. Release applies it once through the
 * field's own commit; Esc puts back what was there before the drag. Only a plain number literal scrubs, so an expression
 * or a parameter name (`width / 2`) is never replaced by a number. On an input the drag starts only while it isn't
 * focused: a click without moving focuses it as before, and a focused input keeps its caret and text selection. On any
 * other element (a grab handle beside a focused input) the press never takes focus away.
 */
import { useRef } from 'react';
import { decimals, format, numberAt } from '@/lib/numberText';
import styles from './ui.module.css';

const PX_PER_STEP = 5;
/** Sideways travel before a press becomes a scrub (a click without moving stays a click). */
const THRESHOLD = 3;

/** Whether `text` is just one number literal (`12`, `-0.5`), the only text a scrub may rewrite. */
export function isLiteral(text: string): boolean {
  const trimmed = text.trim();
  const found = trimmed ? numberAt(trimmed, 0) : null;
  return !!found && found.from === 0 && found.to === trimmed.length;
}

export interface ScrubLimits {
  integer?: boolean; min?: number; max?: number; positive?: boolean;
  /** A fixed step (a NumberField's own), instead of one in the literal's last decimal place. */
  step?: number;
}

/** Decimal places of a step such as 0.25 or 1e-7. */
export function stepPlaces(step: number): number {
  const [mantissa, exponent] = String(step).split('e');
  return Math.max(0, decimals(mantissa) - Number(exponent ?? 0));
}

/** The literal `start` moved `dx` pixels: steps follow its precision (or `step`), coarse ×10, fine ÷10 (one more decimal shown). */
export function scrubbed(start: string, dx: number, { coarse = false, fine = false }: { coarse?: boolean; fine?: boolean }, limits: ScrubLimits = {}): string {
  const own = limits.step !== undefined && limits.step > 0 ? limits.step : undefined;
  const places = limits.integer ? 0 : Math.max(decimals(start.trim()), own ? stepPlaces(own) : 0);
  const finer = fine && !limits.integer;
  const step = (own ?? (places ? 10 ** -places : 1)) * (coarse ? 10 : 1) / (finer ? 10 : 1);
  const shown = finer ? places + 1 : places;
  let value = Number(start) + Math.round(dx / PX_PER_STEP) * step;
  if (limits.positive) value = Math.max(value, 10 ** -shown);
  if (limits.min !== undefined) value = Math.max(limits.min, value);
  if (limits.max !== undefined) value = Math.min(limits.max, value);
  return format(value, shown);
}

export interface ScrubOptions extends ScrubLimits {
  /** The text the field shows now. */
  text: string;
  disabled?: boolean;
  /** Each new value while dragging (show it; don't commit). */
  onScrub(text: string): void;
  /** Once on release, with the value scrubbed to (only if it changed). */
  onCommit(text: string): void;
  /** Esc, or a release back where it started: undo whatever onScrub showed (`start` is the text before the drag). */
  onCancel(start: string): void;
}

/** After a scrub, the release's click is swallowed (a grab handle inside a <label> would otherwise focus its input). */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

export function useScrub(options: ScrubOptions) {
  const latest = useRef(options);
  latest.current = options;
  const armed = useRef(false);
  const scrubbable = !options.disabled && isLiteral(options.text);

  const press = (event: React.PointerEvent<HTMLElement>, touch: boolean) => {
    const o = latest.current;
    const element = event.currentTarget;
    const input = element instanceof HTMLInputElement;
    if (o.disabled || event.button !== 0 || (event.pointerType === 'touch' && !touch) || !isLiteral(o.text)) return;
    if (input && document.activeElement === element) return;
    // Captured, so moves over the view don't reach the sketch's pointer handling.
    armed.current = true;
    element.setPointerCapture(event.pointerId);
    const start = o.text.trim();
    const startX = event.clientX;
    let started = false, shown = false, last = start;
    const finish = () => {
      armed.current = false;
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      document.body.classList.remove(styles.scrubbing);
    };
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < THRESHOLD) return;
        started = true;
        document.body.classList.add(styles.scrubbing);
      }
      const next = scrubbed(start, dx, { coarse: e.shiftKey, fine: e.altKey || e.ctrlKey }, o);
      if (next === last) return;
      last = next; shown = true;
      latest.current.onScrub(next);
    };
    const up = () => {
      finish();
      if (!started) { if (input) element.focus(); return; }
      swallowNextClick();
      if (last !== start) latest.current.onCommit(last);
      else if (shown) latest.current.onCancel(start);
    };
    const cancel = () => { finish(); if (shown) latest.current.onCancel(start); };
    // Esc puts the value back and does nothing else (not the sketch's own Esc, which leaves the tool).
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      cancel();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };
  // The press neither focuses the input nor starts a text selection (a click without moving focuses it on release).
  const onMouseDown = (event: React.MouseEvent) => { if (armed.current) event.preventDefault(); };

  return {
    scrubbable,
    /** For the field itself: a mouse or pen scrubs; a finger doesn't, so a drag on it still scrolls the panel. */
    props: { onPointerDown: (event: React.PointerEvent<HTMLElement>) => press(event, false), onMouseDown, className: scrubbable ? styles.scrub : undefined, 'data-scrub': scrubbable || undefined },
    /** For a grab handle beside it (a unit or prefix label): any pointer scrubs, a finger too. */
    handleProps: { onPointerDown: (event: React.PointerEvent<HTMLElement>) => press(event, true), onMouseDown, className: scrubbable ? styles.scrubHandle : undefined, 'data-scrub-handle': scrubbable || undefined },
  };
}
