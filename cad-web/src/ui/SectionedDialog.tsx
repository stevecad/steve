/**
 * A large dialog of sections: a nav of sections on the left (optionally grouped, with icons and counts) and panes on
 * the right. The Manufacturing library and Settings share it. The caller owns the grid's columns (`className`) and
 * passes its panes as children, so every pane and the nav stay direct children of the grid (tests and responsive rules
 * rely on that). On phone widths the nav becomes a strip and a pane marked `overlay` slides over the rest while
 * `detailOpen` is set.
 */
import { Fragment, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronLeft } from 'lucide-react';
import { Dialog } from './index';
import styles from './SectionedDialog.module.css';

export interface SectionNavItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  count?: ReactNode;
  /** Extra attributes for the item button (`data-kind`, `id`, …). */
  attrs?: Record<string, string | undefined>;
}

/** A group of items; a group without a title renders its items straight into the nav (no wrapper). */
export interface SectionNavGroup { title?: string; items: SectionNavItem[] }

export function SectionedDialog({ open, onOpenChange, title, description, icon, width, height, id, className, rootAttrs, nav, navLabel, active, onSelect,
  navHead, navFooter, detailOpen, children, after }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Fixed size in px; omitted, the dialog fills nearly the whole window. */
  width?: number;
  height?: number;
  id?: string;
  /** The grid's columns (and any caller-specific layout). */
  className?: string;
  rootAttrs?: Record<string, string | boolean | undefined>;
  nav: SectionNavGroup[];
  navLabel: string;
  active: string;
  onSelect: (id: string) => void;
  /** Above the sections (a search box). */
  navHead?: ReactNode;
  navFooter?: ReactNode;
  /** Phone widths: an `overlay` pane is showing over the list. */
  detailOpen?: boolean;
  children: ReactNode;
  /** Rendered after the grid, inside the dialog (nested dialogs, notes). */
  after?: ReactNode;
}) {
  const item = (entry: SectionNavItem) => (
    <button key={entry.id} type="button" className={styles.navItem} data-on={entry.id === active || undefined} data-section={entry.id}
      aria-current={entry.id === active ? 'page' : undefined} onClick={() => onSelect(entry.id)} {...entry.attrs}>
      {entry.icon}<span className={styles.navLabel}>{entry.label}</span>{entry.count !== undefined && <small>{entry.count}</small>}
    </button>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} fill={!width} width={width} height={width ? height ?? 780 : undefined} icon={icon} title={title} description={description}>
      <div className={clsx(styles.shell, className)} id={id} data-detail={detailOpen || undefined} {...rootAttrs}>
        <nav className={styles.nav} aria-label={navLabel}>
          {navHead}
          {nav.map((group, index) => (group.title ? (
            <div key={group.title} className={styles.navSection}>
              <div className={styles.navGroup}>{group.title}</div>
              {group.items.map(item)}
            </div>
          ) : <Fragment key={`group-${index}`}>{group.items.map(item)}</Fragment>))}
          {navFooter && <div className={styles.navFoot}>{navFooter}</div>}
        </nav>
        {children}
      </div>
      {after}
    </Dialog>
  );
}

export interface PaneTab { id: string; label: ReactNode }

/** One pane: a header (back on phones, title, subtitle, actions), optional tabs, a scrolling body and a footer. */
export function SectionPane({ title, subtitle, icon, onBack, backLabel = 'Back', actions, before, tabs, tab, onTab, footer, empty, overlay, className, bodyClassName, id, label, children }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  /** Between the header and the tabs (an overview). */
  before?: ReactNode;
  tabs?: PaneTab[];
  tab?: string;
  onTab?: (id: string) => void;
  footer?: ReactNode;
  /** Shown instead of everything else (nothing chosen yet). */
  empty?: ReactNode;
  /** On phone widths, slides over the other panes while the dialog's `detailOpen` is set. */
  overlay?: boolean;
  className?: string;
  bodyClassName?: string;
  id?: string;
  label: string;
  children?: ReactNode;
}) {
  return (
    <section className={clsx(styles.pane, className)} aria-label={label} id={id} data-overlay={overlay || undefined}>
      {empty ?? (
        <>
          {(title !== undefined || actions) && (
            <header className={styles.paneHead}>
              {onBack && <button type="button" className={styles.paneBack} aria-label={backLabel} onClick={onBack}><ChevronLeft size={16} /></button>}
              {icon && <span className={styles.paneIcon}>{icon}</span>}
              <div className={styles.paneTitle}>
                {title !== undefined && <h3>{title}</h3>}
                {subtitle && <p>{subtitle}</p>}
              </div>
              {actions}
            </header>
          )}
          {before}
          {tabs && tabs.length > 0 && (
            <div className={styles.paneTabs} role="tablist">
              {tabs.map((entry) => (
                <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={styles.tab} data-on={tab === entry.id || undefined}
                  data-tab={entry.id} onClick={() => onTab?.(entry.id)}>{entry.label}</button>
              ))}
            </div>
          )}
          <div className={clsx(styles.paneBody, bodyClassName)}>{children}</div>
          {footer && <footer className={styles.paneFoot}>{footer}</footer>}
        </>
      )}
    </section>
  );
}

/** Pushes what follows to the far end of a pane's footer. */
export const PaneSpacer = () => <span className={styles.spacer} />;

/** A pane's "nothing here yet" state. */
export function PaneEmpty({ icon, children, hint }: { icon?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return <div className={styles.paneEmpty}>{icon}<p>{children}</p>{hint && <small>{hint}</small>}</div>;
}
