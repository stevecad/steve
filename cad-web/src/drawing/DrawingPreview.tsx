import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Maximize2, Minus, Plus } from 'lucide-react';
import { Button, Dialog, IconButton } from '@/ui';
import { sanitizeSvg } from '@/lib/sanitize';
import { downloadDrawing, useDrawingPreview } from './preview';
import styles from './Preview.module.css';

export default function DrawingPreview() {
  const drawing = useDrawingPreview();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { if (drawing.open) { setIndex(0); setZoom(1); } }, [drawing.open, drawing.sheets]);
  const selected = Math.min(index, drawing.sheets.length - 1);
  const markup = drawing.sheets[selected];
  // The animated portal mounts after the parent effect. Attach on mount and
  // whenever the sheet changes, including a reopened preview.
  const host = useCallback((container: HTMLDivElement | null) => {
    if (!container || !markup) return;
    const svg = sanitizeSvg(markup);
    container.replaceChildren(...(svg ? [svg] : []));
  }, [markup]);
  return <Dialog open={drawing.open} onOpenChange={(open) => useDrawingPreview.setState({ open })}
    title={drawing.title} description="Engineering drawings" icon={<FileText size={24} />} fill className={styles.dialog}>
    <div className={styles.toolbar} id="drawing-preview-toolbar">
      <IconButton label="Previous sheet" disabled={selected <= 0} onClick={() => setIndex(selected - 1)}><ChevronLeft /></IconButton>
      <span className={styles.page} aria-live="polite">Sheet {selected + 1} of {drawing.sheets.length}</span>
      <IconButton label="Next sheet" disabled={selected >= drawing.sheets.length - 1} onClick={() => setIndex(selected + 1)}><ChevronRight /></IconButton>
      <span className={styles.title}>{drawing.names[selected] ?? `Sheet ${selected + 1}`}</span>
      <IconButton label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(Math.max(.5, zoom - .25))}><Minus /></IconButton>
      <span className={styles.zoom}>{Math.round(zoom * 100)}%</span>
      <IconButton label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + .25))}><Plus /></IconButton>
      <IconButton label="Fit sheet" onClick={() => setZoom(1)}><Maximize2 /></IconButton>
      <Button variant="primary" disabled={!drawing.pdf} onClick={() => drawing.pdf && downloadDrawing(drawing.pdf, `${drawing.title}-drawings.pdf`)}><Download size={14} /> Save PDF</Button>
      <Button disabled={!drawing.archive} onClick={() => drawing.archive && downloadDrawing(drawing.archive, `${drawing.title}-drawings.zip`)}>SVG · DXF</Button>
    </div>
    <div className={styles.canvas} id="drawing-preview" key={selected}>
      <div ref={host} className={styles.sheet} style={{ width: `${zoom * 100}%`, height: zoom === 1 ? '100%' : 'auto' }} />
    </div>
  </Dialog>;
}
