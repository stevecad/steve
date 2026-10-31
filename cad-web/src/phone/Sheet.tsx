/**
 * The phone's one surface for everything that isn't the model: a sheet from the bottom (from the right in landscape).
 * Drag its handle down to close it or up to give it the screen; tap outside to close it. A `peek` sheet leaves the
 * canvas live above it and has no scrim, for tools whose picks are on the model.
 */
import { useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { useLandscape } from './useLandscape';
import styles from './Phone.module.css';

export type SheetSize = 'peek' | 'half' | 'full';

export default function Sheet({ open, onClose, title, size = 'half', label, actions, children, id, bare }: {
  /** bare: the content brings its own header and close button (the panels' tab rows); the sheet adds only its grabber. */
  bare?: boolean; open: boolean; onClose: () => void; title?: ReactNode; size?: SheetSize; label: string; actions?: ReactNode; children: ReactNode; id?: string;
}) {
  const reduced = useReducedMotion();
  const landscape = useLandscape();
  const [grown, setGrown] = useState<SheetSize | null>(null);
  const drag = useRef<{ y: number; x: number; id: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const shown = grown ?? size;
  const scrim = shown !== 'peek';
  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 520, damping: 46 };

  const onDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = { y: event.clientY, x: event.clientX, id: event.pointerId };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onMove = (event: React.PointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    setOffset(Math.max(0, event.clientY - drag.current.y));
  };
  const onUp = (event: React.PointerEvent) => {
    const start = drag.current;
    drag.current = null;
    setOffset(0);
    if (!start || start.id !== event.pointerId) return;
    const dy = event.clientY - start.y;
    if (dy > 70) {
      if (shown === 'full' && size !== 'full') setGrown(null);
      else { setGrown(null); onClose(); }
    } else if (dy < -40) setGrown('full');
    else if (Math.abs(dy) < 6) setGrown(shown === 'full' ? null : 'full');
  };

  return (
    <AnimatePresence onExitComplete={() => setGrown(null)}>
      {open && (
        <>
          {scrim && <motion.div key="scrim" className={styles.scrim} aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onClick={onClose} />}
          <motion.section
            key="sheet"
            id={id}
            role="dialog"
            aria-modal={scrim || undefined}
            aria-label={label}
            className={styles.sheet}
            data-size={shown}
            style={{ translate: offset && !landscape ? `0 ${offset}px` : undefined }}
            initial={landscape ? { x: '105%' } : { y: '105%' }}
            animate={landscape ? { x: 0 } : { y: 0 }}
            exit={landscape ? { x: '105%' } : { y: '105%' }}
            transition={spring}
          >
            <header className={styles.sheetHead} data-bare={bare || undefined} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
              <span className={styles.grabber} aria-hidden />
              {title !== undefined && <h2 className={styles.sheetTitle}>{title}</h2>}
              {!bare && (
                <span className={styles.sheetActions}>
                  {actions}
                  <button type="button" className={styles.iconButton} aria-label={`Close ${label}`} onClick={onClose}><X size={20} /></button>
                </span>
              )}
            </header>
            <div className={styles.sheetBody}>{children}</div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
