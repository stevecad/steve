import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { get, set, useApp, type AppState, type Pick } from '@/state/store';
import { viewer } from './viewer';
import { pickLabel } from './measure';
import ui from '@/ui/ui.module.css';
import styles from './Viewport.module.css';

type List = NonNullable<AppState['pickList']>;

/** "Cylindrical face" and the body or component it belongs to. */
function describePick(pick: Pick): { kind: string; owner: string } {
  const name = get().tree[pick.node]?.name ?? '';
  return pick.kind === 'component' ? { kind: name || 'Component', owner: '' } : { kind: pickLabel(viewer.model, pick), owner: name };
}

const close = () => set({ pickList: null, hover: null });

/**
 * Select other (deep selection): everything under a point of the 3D view, front to back, hidden behind other faces or
 * not (Interaction's press and hold, or the context menu's Select other…). Hovering a row lights it in the view (edges and
 * corners through what's in front); choosing one does what clicking it would have, into an open tool or dialog or the selection.
 */
export default function PickList() {
  const list = useApp((state) => state.pickList);
  return <AnimatePresence>{list && <Menu key={`${list.x},${list.y}`} list={list} />}</AnimatePresence>;
}

function Menu({ list }: { list: List }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const timer = setTimeout(() => window.addEventListener('pointerdown', outside), 0);
    // Focus is taken once the menu is in place, so the keyboard works it at once.
    const focus = requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return () => { clearTimeout(timer); cancelAnimationFrame(focus); window.removeEventListener('pointerdown', outside); };
  }, []);

  const light = (index: number) => { setActive(index); set({ hover: list.picks[index], hoverAlso: [] }); };
  const choose = (pick: Pick) => {
    close();
    viewer.choosePick(pick, list.additive, { x: list.x, y: list.y });
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step) ref.current?.querySelectorAll<HTMLButtonElement>('button')[(active + step + list.picks.length) % list.picks.length]?.focus();
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const x = Math.min(list.x, window.innerWidth - 280);
  const y = Math.max(8, Math.min(list.y, window.innerHeight - 64 - list.picks.length * 31));

  return (
    <motion.div
      ref={ref}
      className={`${ui.menu} ${styles.contextMenu}`}
      role="menu"
      aria-label="Select other"
      style={{ left: x, top: y, maxHeight: window.innerHeight - y - 8 }}
      onKeyDown={onKeyDown}
      onPointerLeave={() => set({ hover: null })}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={`${ui.menuLabel} ${styles.pickListTitle}`}>Select other · nearest first</div>
      {list.picks.map((pick, index) => {
        const { kind, owner } = describePick(pick);
        return (
          <button key={JSON.stringify(pick)} type="button" role="menuitem" className={ui.menuItem} style={{ width: '100%' }}
            data-highlighted={index === active || undefined}
            onPointerEnter={() => light(index)} onFocus={() => light(index)} onClick={() => choose(pick)}>
            <span>{kind}</span>
            {owner && <span className={ui.menuHint}>{owner}</span>}
          </button>
        );
      })}
    </motion.div>
  );
}
