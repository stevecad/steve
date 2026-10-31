import { useRef } from 'react';
import { set } from '@/state/store';
import styles from './Resizer.module.css';

/** Drag handle on a side panel's inner edge; double-click restores the default width. */
export default function Resizer({ side }: { side: 'left' | 'right' }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const key = side === 'left' ? 'browserWidth' : 'dockWidth';
  const [min, max, initial] = side === 'left' ? [200, 460, 264] : [300, 760, 384];
  return (
    <div
      className={styles.resizer}
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(event) => {
        const panel = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        start.current = { x: event.clientX, width: panel.width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = 'col-resize';
        set({ resizing: true });
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const delta = (event.clientX - start.current.x) * (side === 'left' ? 1 : -1);
        set({ [key]: Math.round(Math.min(max, Math.max(min, start.current.width + delta))) });
      }}
      onPointerUp={() => { start.current = null; document.body.style.cursor = ''; set({ resizing: false }); }}
      onDoubleClick={() => set({ [key]: initial })}
    />
  );
}
