import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { ContextContent, ContextRoot, ContextTrigger } from '@/ui';
import styles from './Browser.module.css';

export interface TreeRowProps {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  selected?: boolean;
  partial?: boolean;
  dimmed?: boolean;
  actions?: ReactNode;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  onHover?: (hovering: boolean) => void;
  testId?: string;
  title?: string;
  /** Marks a failed feature. */
  error?: boolean;
  /** Right-click (and Menu key / Shift+F10) menu items; rendered only while the menu is open. */
  menu?: ReactNode;
  /** Right-clicking an item that isn't selected selects it first (as desktop CAD browsers do); groups leave this out. */
  onContextSelect?: () => void;
  /** Shown instead of the label while it is edited in place. */
  editor?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Stable handle for the row (`sketch:sketch_1`, `body:extrude_1`, …). */
  item?: string;
}

/** The Menu key or Shift+F10 opens a row's menu at the row, like a right click. */
function menuKey(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.defaultPrevented || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
  event.preventDefault();
  event.stopPropagation();
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + Math.min(28, box.width / 2), clientY: box.bottom - 2 }));
}

export default function TreeRow({ depth, icon, label, meta, expanded, onToggle, selected, partial, dimmed, actions, onClick, onDoubleClick, onContextMenu, onContextSelect, onHover, testId, title, error, menu, editor, onKeyDown, item }: TreeRowProps) {
  const row = (
    <div
      className={styles.row}
      data-selected={selected || undefined}
      data-partial={partial || undefined}
      data-dimmed={dimmed || undefined}
      data-component={testId}
      data-error={error || undefined}
      data-item={item}
      data-editing={editor ? true : undefined}
      style={{ paddingLeft: 6 + depth * 14 }}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      // With a menu, Radix opens it from this same event: select without preventing it.
      onContextMenu={menu ? () => { if (!selected && !editor) onContextSelect?.(); } : (event) => { if (onContextMenu) { event.preventDefault(); onContextMenu(event); } }}
    >
      {onToggle ? (
        <button type="button" className={styles.chevron} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded} onClick={onToggle}>
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }} style={{ display: 'grid' }}>
            <ChevronRight size={13} strokeWidth={2} />
          </motion.span>
        </button>
      ) : <span className={styles.chevronSpacer} />}
      {editor ? (
        <div className={styles.rowMain}>
          <span className={styles.rowIcon}>{icon}</span>
          {editor}
        </div>
      ) : (
        <button type="button" className={styles.rowMain} title={title} aria-pressed={selected} aria-haspopup={menu ? 'menu' : undefined} onClick={onClick} onDoubleClick={onDoubleClick}
          onKeyDown={(event) => { onKeyDown?.(event); if (menu) menuKey(event); }}>
          <span className={styles.rowIcon}>{icon}</span>
          <span className={styles.rowLabel}>{label}</span>
          {meta && <span className={styles.rowMeta}>{meta}</span>}
        </button>
      )}
      {actions && !editor && <span className={styles.rowActions}>{actions}</span>}
    </div>
  );
  if (!menu) return row;
  return (
    <ContextRoot>
      {/* While a name is edited, right click is the field's own (paste, spelling). */}
      <ContextTrigger asChild disabled={!!editor}>{row}</ContextTrigger>
      <ContextContent>{menu}</ContextContent>
    </ContextRoot>
  );
}
