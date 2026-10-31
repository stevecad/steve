/**
 * Mark up the screenshot of the canvas before it goes with a report ("Report a bug" / "Request a feature"): a red pen,
 * red arrows whose ends can be dragged (length and direction), and comment bubbles whose tip points at a spot. Opened
 * from the report dialog, over it. The marks stay editable until the report is sent; `flattenMarks` burns them into
 * the image that's sent (feedback.ts compresses it like any capture). Nothing leaves the browser from here.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, MessageSquare, PenLine, PencilLine, Trash2, Undo2 } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import ui from '@/ui/ui.module.css';
import { reportBackground } from './feedback';
import styles from './Annotator.module.css';

export interface Point { x: number; y: number }
export type Mark =
  | { kind: 'pen'; points: Point[] }
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'comment'; at: Point; tip: Point; text: string };
type Tool = 'pen' | 'arrow' | 'comment';
type Grab = { index: number; part: 'draw' | 'from' | 'to' | 'tip' | 'body'; offset: Point };

const RED = '#e5322d';
const PLACEHOLDER = 'Type a comment';

/** Line width in the image's pixels, so marks stay readable after the report's downscale (to 1600 px at most). */
export const unitFor = (width: number, height: number) => Math.max(2, Math.round(Math.max(width, height) / 400));

/** A pointer position in the image's pixels: the canvas is shown scaled to fit, on any pixel ratio. */
export function toImage(event: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / (rect.width || 1), y: (event.clientY - rect.top) * canvas.height / (rect.height || 1) };
}

const near = (a: Point, b: Point, radius: number) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** A comment's box (its top-left corner is `at`) and its wrapped text; sets the context's font. */
function bubble(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: 'comment' }>, unit: number) {
  const font = Math.round(unit * 4.5);
  context.font = `500 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const lines = wrap(context, mark.text.trim() || PLACEHOLDER, font * 16);
  const pad = font * 0.6;
  const line = font * 1.3;
  const width = Math.max(...lines.map((text) => context.measureText(text).width)) + pad * 2;
  return { x: mark.at.x, y: mark.at.y, width, height: lines.length * line + pad * 2, lines, pad, line, font };
}

function drawComment(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: 'comment' }>, unit: number, selected: boolean) {
  const box = bubble(context, mark, unit);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const inside = mark.tip.x >= box.x && mark.tip.x <= box.x + box.width && mark.tip.y >= box.y && mark.tip.y <= box.y + box.height;
  const tail = new Path2D();
  if (!inside) {
    const length = Math.hypot(mark.tip.x - center.x, mark.tip.y - center.y) || 1;
    const half = Math.min(box.width, box.height) * 0.22;
    const normal = { x: -(mark.tip.y - center.y) / length * half, y: (mark.tip.x - center.x) / length * half };
    tail.moveTo(center.x + normal.x, center.y + normal.y);
    tail.lineTo(mark.tip.x, mark.tip.y);
    tail.lineTo(center.x - normal.x, center.y - normal.y);
    tail.closePath();
  }
  const body = new Path2D();
  body.roundRect(box.x, box.y, box.width, box.height, box.font * 0.5);
  // Outlines first, then the fills over their inner halves: the tail and the box read as one bubble.
  context.strokeStyle = RED;
  context.lineJoin = 'round';
  context.lineWidth = unit * 1.6;
  context.stroke(tail);
  context.stroke(body);
  context.fillStyle = '#fff';
  context.fill(tail);
  context.fill(body);
  context.fillStyle = mark.text.trim() ? '#1a1a1a' : '#8a8a8a';
  context.textBaseline = 'top';
  box.lines.forEach((text, row) => context.fillText(text, box.x + box.pad, box.y + box.pad + row * box.line + (box.line - box.font) / 2));
  if (selected) {
    context.save();
    context.setLineDash([unit * 2, unit * 1.5]);
    context.lineWidth = unit * 0.6;
    context.strokeStyle = '#1a1a1a';
    context.strokeRect(box.x - unit * 2, box.y - unit * 2, box.width + unit * 4, box.height + unit * 4);
    context.restore();
  }
}

function drawArrow(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: 'arrow' }>, unit: number) {
  const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
  const head = Math.min(unit * 6, Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) * 0.6);
  context.strokeStyle = RED;
  context.fillStyle = RED;
  context.lineWidth = unit;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(mark.from.x, mark.from.y);
  context.lineTo(mark.to.x - Math.cos(angle) * head * 0.7, mark.to.y - Math.sin(angle) * head * 0.7);
  context.stroke();
  context.beginPath();
  context.moveTo(mark.to.x, mark.to.y);
  context.lineTo(mark.to.x - head * Math.cos(angle - 0.42), mark.to.y - head * Math.sin(angle - 0.42));
  context.lineTo(mark.to.x - head * Math.cos(angle + 0.42), mark.to.y - head * Math.sin(angle + 0.42));
  context.closePath();
  context.fill();
}

function drawPen(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: 'pen' }>, unit: number) {
  context.strokeStyle = RED;
  context.lineWidth = unit;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  mark.points.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
  if (mark.points.length === 1) context.lineTo(mark.points[0].x + 0.01, mark.points[0].y);
  context.stroke();
}

function handle(context: CanvasRenderingContext2D, point: Point, unit: number) {
  context.beginPath();
  context.arc(point.x, point.y, unit * 1.8, 0, Math.PI * 2);
  context.fillStyle = '#fff';
  context.fill();
  context.lineWidth = unit * 0.7;
  context.strokeStyle = RED;
  context.stroke();
}

/** The image and its marks. While editing, the ends that can be dragged show as handles and empty comments as a hint. */
function paint(context: CanvasRenderingContext2D, image: HTMLImageElement, marks: Mark[], editing: { selected: number | null } | null) {
  const unit = unitFor(image.width, image.height);
  context.fillStyle = reportBackground();
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  marks.forEach((mark, index) => {
    if (mark.kind === 'pen') drawPen(context, mark, unit);
    else if (mark.kind === 'arrow') drawArrow(context, mark, unit);
    else if (editing || mark.text.trim()) drawComment(context, mark, unit, editing?.selected === index);
  });
  if (!editing) return;
  for (const mark of marks) {
    if (mark.kind === 'arrow') { handle(context, mark.from, unit); handle(context, mark.to, unit); }
    else if (mark.kind === 'comment') handle(context, mark.tip, unit);
  }
}

/** The image with the marks burned in (no handles, no empty comments), ready for `compressForReport`. */
export function flattenMarks(image: HTMLImageElement, marks: Mark[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (context) paint(context, image, marks, null);
  return canvas;
}

function hitTest(context: CanvasRenderingContext2D, marks: Mark[], point: Point, unit: number): Grab | null {
  const radius = unit * 4;
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    const at = (target: Point) => ({ x: target.x - point.x, y: target.y - point.y });
    if (mark.kind === 'arrow') {
      if (near(point, mark.to, radius)) return { index, part: 'to', offset: at(mark.to) };
      if (near(point, mark.from, radius)) return { index, part: 'from', offset: at(mark.from) };
    } else if (mark.kind === 'comment') {
      if (near(point, mark.tip, radius)) return { index, part: 'tip', offset: at(mark.tip) };
      const box = bubble(context, mark, unit);
      if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) return { index, part: 'body', offset: at(mark.at) };
    }
  }
  return null;
}

export default function Annotator({ open, image, marks: initial, onCancel, onDone }: {
  open: boolean; image: HTMLImageElement | null; marks: Mark[]; onCancel: () => void; onDone: (marks: Mark[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [marks, setMarks] = useState<Mark[]>(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [undoable, setUndoable] = useState(0);
  const current = useRef(marks);
  current.current = marks;
  const history = useRef<Mark[][]>([]);
  const grab = useRef<Grab | null>(null);
  const fresh = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMarks(initial); setSelected(null); setTool('pen'); history.current = []; setUndoable(0);
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps -- The marks it opens with, not later renders'.

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!open || !image || !canvas || !context) return;
    if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
    paint(context, image, marks, { selected });
  }, [open, image, marks, selected]);

  const record = () => {
    history.current.push(current.current);
    if (history.current.length > 200) history.current.shift();
    setUndoable(history.current.length);
  };
  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    setMarks(previous); setSelected(null); setUndoable(history.current.length);
  };
  const clear = () => { if (!marks.length) return; record(); setMarks([]); setSelected(null); };
  const remove = () => {
    if (selected === null) return;
    record(); setMarks(marks.filter((_, index) => index !== selected)); setSelected(null);
  };
  const update = (index: number, change: (mark: Mark) => Mark) => setMarks((all) => all.map((mark, at) => (at === index ? change(mark) : mark)));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches?.('input, textarea')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (event.button !== 0 || !canvas || !context || !image) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = toImage(event, canvas);
    const unit = unitFor(image.width, image.height);
    const hit = tool === 'pen' ? null : hitTest(context, marks, point, unit);
    record();
    if (hit) { grab.current = hit; setSelected(hit.index); return; }
    const index = marks.length;
    if (tool === 'pen') {
      setMarks([...marks, { kind: 'pen', points: [point] }]);
      grab.current = { index, part: 'draw', offset: { x: 0, y: 0 } };
      setSelected(null);
    } else if (tool === 'arrow') {
      setMarks([...marks, { kind: 'arrow', from: point, to: point }]);
      grab.current = { index, part: 'to', offset: { x: 0, y: 0 } };
      setSelected(index);
    } else {
      // The click is the spot the comment points at; the bubble sits up and to the right of it, inside the image.
      const at = { x: Math.max(0, Math.min(point.x + unit * 8, image.width - unit * 60)), y: Math.max(0, point.y - unit * 20) };
      setMarks([...marks, { kind: 'comment', at, tip: point, text: '' }]);
      grab.current = { index, part: 'body', offset: { x: at.x - point.x, y: at.y - point.y } };
      setSelected(index);
      fresh.current = true;
    }
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const held = grab.current;
    const canvas = canvasRef.current;
    if (!held || !canvas || !image) return;
    const point = toImage(event, canvas);
    const moved = { x: point.x + held.offset.x, y: point.y + held.offset.y };
    const unit = unitFor(image.width, image.height);
    update(held.index, (mark) => {
      if (mark.kind === 'pen' && held.part === 'draw') {
        const last = mark.points[mark.points.length - 1];
        return near(last, point, unit / 2) ? mark : { ...mark, points: [...mark.points, point] };
      }
      if (mark.kind === 'arrow' && held.part === 'from') return { ...mark, from: moved };
      if (mark.kind === 'arrow' && held.part === 'to') return { ...mark, to: moved };
      if (mark.kind === 'comment' && held.part === 'tip') return { ...mark, tip: moved };
      if (mark.kind === 'comment' && held.part === 'body') return { ...mark, at: moved };
      return mark;
    });
  };
  const up = () => {
    const held = grab.current;
    grab.current = null;
    if (!held || !image) return;
    const mark = current.current[held.index];
    const before = history.current[history.current.length - 1];
    // A click with the arrow tool, not a drag: no arrow. A click that changed nothing: nothing to undo.
    const stray = mark?.kind === 'arrow' && near(mark.from, mark.to, unitFor(image.width, image.height) * 3) && before?.length === current.current.length - 1;
    if (stray || before === current.current) {
      if (stray) { setMarks(before); setSelected(null); }
      history.current.pop(); setUndoable(history.current.length);
    }
    if (fresh.current) { fresh.current = false; window.setTimeout(() => textRef.current?.focus(), 0); }
  };

  const comment = selected !== null && marks[selected]?.kind === 'comment' ? marks[selected] as Extract<Mark, { kind: 'comment' }> : null;
  const tools: { id: Tool; label: string; icon: ReactNode; hint: string }[] = [
    { id: 'pen', label: 'Pen', icon: <PenLine />, hint: 'Draw freehand' },
    { id: 'arrow', label: 'Arrow', icon: <ArrowUpRight />, hint: 'Drag from the tail to the point; drag either end later to change it' },
    { id: 'comment', label: 'Comment', icon: <MessageSquare />, hint: 'Click the spot to point at, then type; drag the bubble or its tip' },
  ];
  const footer = <>
    <Button onClick={onCancel}>Cancel</Button>
    <Button variant="primary" id="annotate-done" icon={<Check />} onClick={() => onDone(marks.filter((mark) => mark.kind !== 'comment' || mark.text.trim()))}>Attach</Button>
  </>;

  return (
    <Dialog open={open} fill title="Mark up the screenshot" icon={<div className={styles.icon}><PencilLine size={18} /></div>} footer={footer}
      description="Draw, point with arrows and add comments to show the team exactly where. It's attached to your report as one image."
      onOpenChange={(value) => {
        if (value) return;
        // Escape while typing a comment finishes the comment; it doesn't throw the markings away.
        if (textRef.current && document.activeElement === textRef.current) { textRef.current.blur(); return; }
        onCancel();
      }}>
      <div className={styles.toolbar} id="annotate-tools">
        {tools.map((item) => (
          <Button key={item.id} size="sm" icon={item.icon} active={tool === item.id} aria-pressed={tool === item.id} title={item.hint} data-tool={item.id}
            onClick={() => { setTool(item.id); if (item.id === 'pen') setSelected(null); }}>{item.label}</Button>
        ))}
        <span className={styles.gap} />
        <Button size="sm" icon={<Undo2 />} onClick={undo} disabled={!undoable} title="Undo (Ctrl+Z)">Undo</Button>
        <Button size="sm" icon={<Trash2 />} onClick={selected !== null ? remove : clear} disabled={!marks.length}
          title={selected !== null ? 'Remove the selected mark (Delete)' : 'Remove every mark'}>{selected !== null ? 'Remove' : 'Clear'}</Button>
        {comment && (
          <input ref={textRef} className={`${ui.input} ${styles.text}`} id="annotate-text" placeholder={PLACEHOLDER} maxLength={300} value={comment.text}
            aria-label="Comment text" onFocus={record}
            onChange={(event) => { const text = event.target.value; if (selected !== null) update(selected, (mark) => (mark.kind === 'comment' ? { ...mark, text } : mark)); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        )}
      </div>
      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} id="annotate-canvas" data-tool={tool} aria-label="The screenshot, to draw on"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
    </Dialog>
  );
}
