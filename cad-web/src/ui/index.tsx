import { perFrame } from '@/viewport/dragStep';
import { arithmetic } from '@/lib/arithmetic';
import { MM_PER_INCH } from '@/lib/format';
import { ANGLE_UNITS, hasLengthUnit, lengthCode } from '@/lib/lengths';
import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ContextMenu as RContextMenu, Dialog as RDialog, DropdownMenu, Select as RSelect, Slider as RSlider, Switch as RSwitch, Tooltip } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronRight, CircleAlert, X } from 'lucide-react';
import styles from './ui.module.css';
import { useScrub } from './useScrub';

export { styles as ui };

/* ───────── Tooltip ───────── */

export function Shortcut({ keys }: { keys: string }) {
  return <span className={styles.shortcut}>{keys.split('+').map((key) => <kbd key={key}>{key}</kbd>)}</span>;
}

export interface TipProps {
  label: ReactNode;
  description?: ReactNode;
  shortcut?: string;
  reason?: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
  disabled?: boolean;
}

export function Tip({ label, description, shortcut, reason, side = 'bottom', children, disabled }: TipProps) {
  if (disabled) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltip} side={side} sideOffset={7} collisionPadding={10}>
          <div className={styles.tooltipRow}><span>{label}</span>{shortcut && <Shortcut keys={shortcut} />}</div>
          {description && <div className={styles.tooltipDescription}>{description}</div>}
          {reason && <div className={styles.tooltipReason}><CircleAlert />{reason}</div>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <Tooltip.Provider delayDuration={420} skipDelayDuration={250}>{children}</Tooltip.Provider>
);

/* ───────── Buttons ───────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  active?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, active, className, children, ...props }, ref) {
  return (
    <button ref={ref} type="button" data-active={active || undefined} className={clsx(styles.button, styles[variant], size !== 'md' && styles[size], className)} {...props}>
      {icon}{children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  description?: ReactNode;
  active?: boolean;
  small?: boolean;
  tipSide?: TipProps['side'];
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, shortcut, description, active, small, tipSide, className, children, ...props }, ref) {
  return (
    <Tip label={label} shortcut={shortcut} description={description} side={tipSide}>
      <button ref={ref} type="button" aria-label={label} aria-pressed={active} data-active={active || undefined} className={clsx(styles.iconButton, small && styles.small, className)} {...props}>
        {children}
      </button>
    </Tip>
  );
});

/* ───────── Menus ───────── */

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ children, align = 'start', side = 'bottom', sideOffset = 6, className }: { children: ReactNode; align?: 'start' | 'center' | 'end'; side?: 'top' | 'bottom' | 'left' | 'right'; sideOffset?: number; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className={clsx(styles.menu, className)} align={align} side={side} sideOffset={sideOffset} collisionPadding={10} loop>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

/** `reason` shows under a disabled item why it is unavailable; `command` tags the item with its command id (data-command). */
export function MenuItem({ icon, children, shortcut, hint, reason, disabled, danger, onSelect, checked, command }: { icon?: ReactNode; children: ReactNode; shortcut?: string; hint?: ReactNode; reason?: ReactNode; disabled?: boolean; danger?: boolean; checked?: boolean; onSelect?: () => void; command?: string }) {
  return (
    <DropdownMenu.Item className={clsx(styles.menuItem, danger && styles.dangerItem)} disabled={disabled} onSelect={onSelect} data-command={command} data-active={checked || undefined} data-reason={reason ? '' : undefined}>
      {icon}
      {reason ? <span className={styles.menuText}><span>{children}</span><small className={styles.menuReason}>{reason}</small></span> : <span>{children}</span>}
      {checked && <span className={styles.menuCheck}><Check size={14} /></span>}
      {shortcut && !checked && <span className={styles.menuShortcut}><Shortcut keys={shortcut} /></span>}
      {hint && !shortcut && !checked && <span className={styles.menuHint}>{hint}</span>}
    </DropdownMenu.Item>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className={styles.menuSeparator} />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <DropdownMenu.Label className={clsx(styles.menuLabel, 'caps')}>{children}</DropdownMenu.Label>;

/* ───────── Context menu (right click), styled like Menu ───────── */

export function ContextMenu({ trigger, children, onOpenChange }: { trigger: ReactNode; children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  return (
    <RContextMenu.Root onOpenChange={onOpenChange}>
      <RContextMenu.Trigger asChild>{trigger}</RContextMenu.Trigger>
      <ContextContent>{children}</ContextContent>
    </RContextMenu.Root>
  );
}

/** Parts of ContextMenu, for triggers that already sit inside another asChild wrapper (e.g. a Tip). */
export const ContextRoot = RContextMenu.Root;
export const ContextTrigger = RContextMenu.Trigger;

/** Focus stays in a field an item opened (an inline rename) instead of returning to the trigger. */
const keepFieldFocus = (event: Event) => { if (document.activeElement?.matches('input, textarea, [contenteditable]')) event.preventDefault(); };

export function ContextContent({ children }: { children: ReactNode }) {
  return (
    <RContextMenu.Portal>
      <RContextMenu.Content className={styles.menu} collisionPadding={10} loop onCloseAutoFocus={keepFieldFocus}>{children}</RContextMenu.Content>
    </RContextMenu.Portal>
  );
}

export function ContextItem({ icon, children, hint, shortcut, reason, disabled, danger, onSelect }: { icon?: ReactNode; children: ReactNode; hint?: ReactNode; shortcut?: string; reason?: ReactNode; disabled?: boolean; danger?: boolean; onSelect?: () => void }) {
  return (
    <RContextMenu.Item className={clsx(styles.menuItem, danger && styles.dangerItem)} disabled={disabled} onSelect={onSelect} data-reason={reason ? '' : undefined}>
      {icon}
      {reason ? <span className={styles.menuText}><span>{children}</span><small className={styles.menuReason}>{reason}</small></span> : <span>{children}</span>}
      {shortcut && <span className={styles.menuShortcut}><Shortcut keys={shortcut} /></span>}
      {hint && !shortcut && <span className={styles.menuHint}>{hint}</span>}
    </RContextMenu.Item>
  );
}

/** A context menu row that opens more items beside it (hover, →, a click or a tap), e.g. Move to setup ▸. */
export function ContextSub({ icon, label, children, id }: { icon?: ReactNode; label: ReactNode; children: ReactNode; id?: string }) {
  return (
    <RContextMenu.Sub>
      <RContextMenu.SubTrigger className={styles.menuItem} id={id}>
        {icon}<span>{label}</span><span className={styles.menuHint}><ChevronRight /></span>
      </RContextMenu.SubTrigger>
      <RContextMenu.Portal>
        <RContextMenu.SubContent className={styles.menu} collisionPadding={10} sideOffset={4} alignOffset={-6}>{children}</RContextMenu.SubContent>
      </RContextMenu.Portal>
    </RContextMenu.Sub>
  );
}

export const ContextSeparator = () => <RContextMenu.Separator className={styles.menuSeparator} />;
export const ContextLabel = ({ children }: { children: ReactNode }) => <RContextMenu.Label className={clsx(styles.menuLabel, 'caps')}>{children}</RContextMenu.Label>;

/* ───────── Segmented control ───────── */

export interface SegmentOption<T extends string> { value: T; label?: ReactNode; icon?: ReactNode; title?: string; disabled?: boolean }

export function Segmented<T extends string>({ value, options, onChange, className, size }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; className?: string; size?: 'sm' }) {
  const id = useId();
  return (
    <div className={clsx(styles.segmented, className)} role="radiogroup" data-size={size}>
      {options.map((option) => {
        const selected = option.value === value;
        const button = (
          <button key={option.value} type="button" role="radio" aria-checked={selected} aria-label={option.title} data-selected={selected} disabled={option.disabled} className={styles.segment} onClick={() => onChange(option.value)}>
            {selected && <motion.span layoutId={`seg-${id}`} className={styles.segmentThumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            {option.icon}{option.label}
          </button>
        );
        return option.title && !option.label ? <Tip key={option.value} label={option.title}>{button}</Tip> : button;
      })}
    </div>
  );
}

/* ───────── Dialog ───────── */

export function Dialog({ open, onOpenChange, title, description, icon, children, footer, width, height, className, fill }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** A fixed height (capped to the window); the body fills it, as with `fill`. */
  height?: number;
  className?: string;
  /** Nearly the whole window (libraries and other workbenches); the body fills the height. */
  fill?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div className={styles.overlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            </RDialog.Overlay>
            <RDialog.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={clsx(styles.dialog, fill && styles.dialogFill, className)}
                style={{ width: width && !fill ? `min(${width}px, calc(100vw - 32px))` : undefined, height: height && !fill ? `min(${height}px, calc(100vh - 48px))` : undefined, x: '-50%', y: '-50%' }}
                initial={{ opacity: 0, scale: 0.96, y: 'calc(-50% + 10px)' }}
                animate={{ opacity: 1, scale: 1, y: '-50%' }}
                exit={{ opacity: 0, scale: 0.97, y: 'calc(-50% + 6px)' }}
                transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.8 }}
              >
                <div className={styles.dialogHeader}>
                  {icon}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <RDialog.Title className={styles.dialogTitle}>{title}</RDialog.Title>
                    {description ? <RDialog.Description className={styles.dialogDescription}>{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RDialog.Description>}
                  </div>
                </div>
                {children && <div className={clsx(styles.dialogBody, (fill || height) && styles.dialogBodyFill)}>{children}</div>}
                {footer && <div className={styles.dialogFooter}>{footer}</div>}
                {/* Last in the DOM so opening focuses the dialog's content, not this (its tooltip would take Escape). */}
                <RDialog.Close asChild><IconButton label="Close" shortcut="Esc" small className={styles.dialogClose}><X /></IconButton></RDialog.Close>
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  );
}

/* ───────── Form controls ───────── */

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={styles.tooltipDescription}>{hint}</span>}
    </label>
  );
}

/**
 * A number input that also takes simple arithmetic. Press and drag sideways to scrub it (`step` per 5 px, Shift ×10,
 * Alt or Ctrl ÷10): on the input while it isn't focused (mouse or pen), or on its unit/prefix label (a finger too, so a
 * drag on the input still scrolls the panel). The value is applied once on release, or on every step with `live` (for
 * cheap previews); Esc puts back what was there.
 */
export function NumberField(props: NumberFieldProps) {
  const { value, unit = 'mm', prefix, prefixColor, step = 1, min, max, disabled, ariaLabel, precision, live, integer, eager, optional, placeholder, id, className } = props;
  const onChange = props.onChange as (value: number | undefined) => void;
  const [draft, setDraft] = useState<string | null>(null);
  const limit = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, integer ? Math.round(n) : n));
  const commit = (text: string) => {
    setDraft(null);
    if (optional && !text.trim()) { if (value !== undefined) onChange(undefined); return; }
    const parsed = evaluate(text, unit);
    if (parsed === null) return;
    const clamped = limit(parsed);
    if (clamped !== value) onChange(clamped);
  };
  const text = draft ?? (value === undefined ? '' : String(precision ? Number(value.toPrecision(precision)) : Number(value.toFixed(4))));
  const input = useRef<HTMLInputElement>(null);
  const scrub = useScrub({
    text, step, min, max, integer, disabled,
    onScrub: (next) => { setDraft(next); if (live) onChange(Number(next)); },
    onCommit: (next) => { setDraft(null); if (!live) onChange(Number(next)); },
    onCancel: (start) => { setDraft(null); if (live) onChange(Number(start)); },
  });
  // A click on the unit or prefix without dragging types into the field, as it did when the label let clicks through.
  const handle = { ...scrub.handleProps, onClick: () => input.current?.focus() };
  return (
    <div className={clsx(styles.numberField, prefix && styles.prefixed)} data-unit={unit ? true : undefined}>
      {prefix && <span {...handle} className={clsx(styles.numberPrefix, handle.className)} style={{ color: prefixColor }}>{prefix}</span>}
      <input
        ref={input}
        {...scrub.props}
        id={id}
        className={clsx(styles.input, className, scrub.props.className)}
        aria-label={ariaLabel}
        aria-invalid={unit === '°' && draft !== null && hasLengthUnit(draft) ? true : undefined}
        title={unit === '°' && draft !== null && hasLengthUnit(draft) ? ANGLE_UNITS : undefined}
        inputMode="decimal"
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (!eager) return;
          if (optional && !next.trim()) { if (value !== undefined) onChange(undefined); return; }
          const parsed = evaluate(next, unit);
          const typed = parsed === null ? null : integer ? Math.round(parsed) : parsed;
          if (typed !== null && typed !== value) onChange(typed);
        }}
        // Only what was typed is committed: leaving the field untouched never rewrites a value it shows rounded.
        onBlur={() => { if (draft !== null) commit(draft); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft !== null) commit(draft);
          if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : event.altKey && !integer ? 0.1 : 1);
            const base = (draft === null ? null : evaluate(draft, unit)) ?? value ?? min ?? 0;
            setDraft(null);
            onChange(limit(Number((base + delta).toFixed(6))));
          }
        }}
      />
      {unit && <span {...handle} className={clsx(styles.numberUnit, handle.className)}>{unit}</span>}
    </div>
  );
}

interface NumberFieldOptions {
  /** The unit shown in the field, and its grab handle (`""` for none, when the label already says it). */
  unit?: string; prefix?: string; prefixColor?: string; step?: number; min?: number; max?: number; disabled?: boolean; ariaLabel?: string;
  /** Significant digits shown, for very small or very precise values (default: four decimals). */
  precision?: number;
  /** Call onChange on every scrub step, not only on release (for cheap previews that already follow a slider). */
  live?: boolean;
  /** Whole numbers only: typed values, scrubs and arrow steps round. */
  integer?: boolean;
  /** Call onChange as each typed value reads, not only on Enter or leaving the field (forms whose checks and results follow the typing); min/max still clamp when it's committed. A scrub still applies once, on release. */
  eager?: boolean;
  placeholder?: string; id?: string;
  /** The input's own class, besides the field's (a form's input look, or its error border). */
  className?: string;
}

type NumberFieldProps = NumberFieldOptions & (
  | { optional?: false; value: number; onChange: (value: number) => void }
  /** Blank is a value ("no limit", "use the listed one"): clearing the field reports undefined. */
  | { optional: true; value: number | undefined; onChange: (value: number | undefined) => void }
);

/**
 * Accepts plain numbers and simple arithmetic such as "25.4*2" or "100/3", through the parameter expression parser
 * (lib/arithmetic.ts) with no names: no eval, so the app runs under a CSP without 'unsafe-eval'. Millimetre and inch fields
 * also take explicit lengths ("0.25in", "1in + 3mm", lib/lengths.ts), converted into the field's displayed unit.
 */
function evaluate(text: string, unit: string): number | null {
  const cleaned = unit === 'mm' || unit === 'in' ? lengthCode(text, unit) : text.replace(/mm$/i, '').trim();
  if (!/^[\d\s+\-*/().eE]+$/.test(cleaned)) return null;
  const value = arithmetic(cleaned);
  return value !== null && Number.isFinite(value) ? value / (unit === 'in' ? MM_PER_INCH : 1) : null;
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <RSwitch.Root className={styles.switch} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} disabled={disabled}>
      <RSwitch.Thumb className={styles.switchThumb} />
    </RSwitch.Root>
  );
}

export function Slider({ value, onChange, min = 0, max = 1, step = 0.001, label, disabled }: { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; label: string; disabled?: boolean }) {
  // While dragging, the thumb shows the pointer's value immediately; the owner hears it once per frame.
  const [live, setLive] = useState<number | null>(null);
  const owner = useRef(onChange);
  owner.current = onChange;
  const frames = useMemo(() => perFrame((next: number) => owner.current(next)), []);
  useEffect(() => () => frames.cancel(), [frames]);
  return (
    <RSlider.Root className={styles.slider} value={[live ?? value]} min={min} max={max} step={step} aria-label={label} disabled={disabled}
      onValueChange={([next]) => { setLive(next); frames.push(next); }}
      onValueCommit={([next]) => { frames.flush(); setLive(null); owner.current(next); }}
      onPointerUp={() => { frames.flush(); setLive(null); }}>
      <RSlider.Track className={styles.sliderTrack}><RSlider.Range className={styles.sliderRange} /></RSlider.Track>
      <RSlider.Thumb className={styles.sliderThumb} aria-label={label} />
    </RSlider.Root>
  );
}

export function Select<T extends string>({ value, onChange, onOpenChange, options, ariaLabel, disabled, id }: { value: T; onChange: (value: T) => void; onOpenChange?: (open: boolean) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[]; ariaLabel: string; disabled?: boolean; id?: string }) {
  return (
    <RSelect.Root value={value} onValueChange={(next) => onChange(next as T)} onOpenChange={onOpenChange} disabled={disabled}>
      <RSelect.Trigger className={styles.selectTrigger} aria-label={ariaLabel} id={id}>
        <RSelect.Value placeholder={options.find((option) => option.value === '')?.label} />
        <RSelect.Icon><ChevronDown /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className={clsx(styles.menu, styles.selectContent)} position="popper" sideOffset={5} collisionPadding={10}>
          <RSelect.Viewport className={styles.selectViewport}>
            {options.map((option) => (
              <RSelect.Item key={option.value} value={option.value} className={styles.menuItem}>
                <RSelect.ItemText>{option.label}</RSelect.ItemText>
                {option.hint && <span className={styles.menuHint}>{option.hint}</span>}
                <RSelect.ItemIndicator className={styles.menuCheck}><Check size={14} /></RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/* ───────── Collapsible section ───────── */

export function Section({ title, children, defaultOpen = true, actions, id }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.section} data-section={id}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button type="button" className={styles.sectionHeader} data-open={open} onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronRight />{title}
        </button>
        {actions && <div className={styles.sectionActions} style={{ paddingRight: 8 }}>{actions}</div>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            <div className={styles.sectionBody}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export const Badge = ({ children, tone }: { children: ReactNode; tone?: 'ws' | 'warning' | 'soon' }) => <span className={styles.badge} data-tone={tone}>{children}</span>;
export const Spinner = ({ size = 14 }: { size?: number }) => <span className={styles.spinner} style={{ width: size, height: size }} />;
