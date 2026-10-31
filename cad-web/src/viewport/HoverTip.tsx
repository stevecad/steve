import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { pickKey, useApp, useCursor } from '@/state/store';
import { viewer } from './viewer';
import { describe } from './measure';
import { analyze } from './semantics';
import { useSketchPicks } from '@/sketch/picking';
import styles from './Viewport.module.css';

/** After the pointer rests on an entity, a small readout describes it. */
export default function HoverTip() {
  const hover = useApp((state) => state.hover);
  const tree = useApp((state) => state.tree);
  const screen = useCursor((state) => state.screen);
  const sketch = useSketchPicks((state) => state.hover);
  const [shown, setShown] = useState<string | null>(null);
  const key = sketch ? `sketch:${sketch.sketch}:${sketch.line ?? ''}` : hover ? pickKey(hover) : null;

  useEffect(() => {
    setShown(null);
    if (!key) return;
    const timer = setTimeout(() => setShown(key), 520);
    return () => clearTimeout(timer);
  }, [key]);

  const visible = !!key && shown === key && !!screen && (!!sketch || !!viewer.model);
  // What the pointer is on, first: sketches, faces and edges overlap.
  const kind = sketch ? 'Sketch' : hover ? ({ component: 'Component', face: 'Face', edge: 'Edge', vertex: 'Vertex' } as Record<string, string>)[hover.kind] ?? '' : '';
  let title = '', detail = '';
  if (visible && sketch) {
    title = sketch.name;
    detail = sketch.on === 'region' ? 'Closed profile · click to select' : sketch.on === 'line' ? 'Line · click to use it as the axis' : 'Click to select';
  } else if (visible && hover && viewer.model) {
    if (hover.kind === 'component') {
      title = tree[hover.node]?.name ?? 'Component';
      detail = tree[hover.node]?.documentId ? 'Linked document' : tree[hover.node]?.type === 'assembly' ? 'Subassembly' : 'Component';
    } else {
      const info = describe(viewer.model, hover);
      const semantics = analyze(viewer.model, hover);
      title = info.title;
      const primary = info.rows.find((row) => row.emphasis) ?? info.rows[0];
      const parts = [semantics.pattern ? `${semantics.pattern.index + 1} of ${semantics.pattern.count}` : '', primary && !title.includes(primary.value) ? `${primary.label} ${primary.value}` : ''];
      detail = parts.filter(Boolean).join(' · ');
    }
  }
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={key}
          className={styles.hoverTip}
          data-kind={kind.toLowerCase()}
          style={{ left: screen![0] + 14, top: screen![1] + 16 }}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: 0.14 }}
        >
          <b><i className={styles.hoverKind}>{kind}</i>{title}</b>{detail && <span>{detail}</span>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
