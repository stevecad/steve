import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircuitIcon, SetupIcon, StudyIcon } from '@/icons/cad';
import { motion } from 'motion/react';
import { AlertTriangle, Box, Factory, Layers3 } from 'lucide-react';
import { isDocumentKind, type FileSummary } from '@/lib/api';
import { useApp } from '@/state/store';
import { hasThumbnail, useThumbnail } from '@/viewport/thumbnails';
import styles from './OpenDialog.module.css';

/** Pieces the Open dialog's files and its Trash share. */

export const ease = [0.16, 1, 0.3, 1] as const;
export const exactTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const KindIcon = ({ kind, size = 13 }: { kind: string; size?: number }) => (
  kind === 'design' ? <Layers3 size={size} /> : kind === 'circuit' ? <CircuitIcon size={size} /> : kind === 'shop' ? <Factory size={size} />
    : kind === 'study' ? <StudyIcon size={size} /> : kind === 'program' ? <SetupIcon size={size} /> : <Box size={size} />);

/** A study's analysis, as Simulate names it. */
export const ANALYSES: Record<string, string> = {
  static: 'Static stress', modal: 'Modal frequencies', buckling: 'Structural buckling', thermal_steady: 'Steady-state thermal', thermal_transient: 'Transient thermal',
  thermal_stress: 'Thermal stress', flow_steady: 'Steady flow', flow_transient: 'Transient flow', cht_steady: 'Conjugate heat transfer',
  flow_compressible_steady: 'Steady compressible flow', flow_compressible_transient: 'Transient compressible flow',
};

/* ───────── Thumbnails ───────── */

export const ScrollRoot = createContext<HTMLElement | null>(null);

/** The design's isometric render; requested once the card comes near the visible part of the list. */
export function Thumb({ doc, size, eager }: { doc: Pick<FileSummary, 'kind' | 'preview_build_id' | 'analysis' | 'designs'>; size: 'card' | 'row' | 'hero'; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useContext(ScrollRoot);
  const theme = useApp((state) => state.theme);
  const [near, setNear] = useState(!!eager);
  // A shop builds library records, never geometry: there is nothing to render.
  const preview = doc.kind === 'shop' ? null : doc.preview_build_id ?? null;
  const [instant] = useState(() => hasThumbnail(preview, theme));
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (eager || !element) return;
    // Wanted while near the visible part of the list, so a fast scroll doesn't queue everything it passed.
    const observer = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), { root, rootMargin: '320px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, root]);
  const result = useThumbnail(preview, isDocumentKind(doc.kind) ? doc.kind : 'part', theme, near);
  const state = !preview ? 'none' : broken ? 'failed' : result?.status ?? 'loading';
  // Studies and programs have no render of their own: their card says what they are.
  const caption = doc.kind === 'study' ? (doc.analysis ? ANALYSES[doc.analysis] ?? doc.analysis.replace(/_/g, ' ') : '')
    : doc.kind === 'program' ? (doc.designs && doc.designs > 1 ? `${doc.designs} designs` : '') : doc.kind === 'shop' ? ''
      : state === 'broken' ? 'Needs regenerating' : state === 'empty' ? 'No solids' : state === 'none' ? 'No geometry yet' : '';
  return (
    <div ref={ref} className={styles.thumb} data-size={size} data-state={state}>
      {result?.status === 'ready' && !broken ? (
        <motion.img key={result.url} src={result.url} alt="" draggable={false} data-flat={result.flat || undefined} onError={() => setBroken(true)}
          initial={instant ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease }} />
      ) : state === 'loading' ? <span className={styles.shimmer}><KindIcon kind={doc.kind} size={size === 'row' ? 16 : 30} /></span> : (
        <span className={styles.placeholder}>
          {state === 'broken' ? <AlertTriangle size={size === 'row' ? 15 : 26} strokeWidth={1.4} /> : <KindIcon kind={doc.kind} size={size === 'row' ? 16 : 30} />}
          {size !== 'row' && caption && <small>{caption}</small>}
        </span>
      )}
    </div>
  );
}

/* ───────── Empty, failed ───────── */

export function Message({ icon, tone, title, children, actions, extra }: { icon: ReactNode; tone?: 'brand' | 'danger'; title: string; children?: ReactNode; actions?: ReactNode; extra?: ReactNode }) {
  return (
    <motion.div className={styles.message} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
      <div className={styles.messageArt} data-tone={tone}>{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className={styles.messageActions}>{actions}</div>}
      {extra}
    </motion.div>
  );
}
