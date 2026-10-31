/**
 * A sheet body's flat pattern drawn from the exact report: outline and holes, each bend line with
 * its bend zone (the developed width), up bends solid-dashed and down bends dash-dotted so the
 * direction never depends on colour alone. The pointer and the bend table share the hovered bend.
 */
import { useMemo } from 'react';
import { num } from '@/lib/format';
import { hoverBend, selectBend, useSheetView, type Flat, type FlatBend, type FlatForm, type Segment, type XY } from './sheet';
import styles from './Sheet.module.css';

const near = (a: XY | undefined, b: XY | undefined) => !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4;

function arc(center: XY, radius: number, from: number, sweep: number): XY[] {
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = from + (sweep * i) / steps;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)] as XY;
  });
}

/** A segment as points from its start to its end. */
function pointsOf(segment: Segment): XY[] {
  if (segment.type === 'line') return [segment.start!, segment.end!];
  if (segment.type === 'polyline') return segment.points ?? [];
  const center = segment.center!, radius = segment.radius_mm!;
  if (segment.type === 'circle') return arc(center, radius, 0, Math.PI * 2);
  const angle = (point: XY) => Math.atan2(point[1] - center[1], point[0] - center[0]);
  const turn = (value: number) => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const a0 = angle(segment.start!), total = turn(angle(segment.end!) - a0) || Math.PI * 2, mid = turn(angle(segment.midpoint!) - a0);
  return arc(center, radius, a0, mid < total ? total : total - Math.PI * 2);
}

/** OCCT reports wire edges in arbitrary order and orientation. Join by endpoints. */
function loop(segments: Segment[]): XY[] {
  const remaining = segments.map(pointsOf).filter((points) => points.length > 1);
  const out = remaining.shift() ?? [];
  while (remaining.length) {
    const last = out.at(-1);
    const index = remaining.findIndex((points) => near(points[0], last) || near(points.at(-1), last));
    // A malformed/disconnected report must not invent a cut across the sheet.
    if (index < 0) return [];
    const points = remaining.splice(index, 1)[0];
    out.push(...(near(points[0], last) ? points : [...points].reverse()).slice(1));
  }
  return out;
}

const PAD = 0.06;

export default function FlatView({ flat, compact }: { flat: Flat; compact?: boolean }) {
  const hover = useSheetView((state) => state.hover);
  const [x0, y0, x1, y1] = flat.bounds_mm;
  const width = Math.max(x1 - x0, 1e-6), height = Math.max(y1 - y0, 1e-6);
  const pad = Math.max(width, height) * PAD;
  // Screen y runs down; the flat's y runs up.
  const map = ([x, y]: XY): XY => [x - x0 + pad, y1 - y + pad];
  const outline = useMemo(() => flat.outlines.map((wire) => {
    const points = loop(wire.segments).map(map);
    return points.length ? `M${points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L')}Z` : '';
  }).join(''), [flat]); // eslint-disable-line react-hooks/exhaustive-deps
  const stroke = Math.max(width, height) / (compact ? 260 : 360);
  return (
    <svg className={styles.flat} viewBox={`0 0 ${width + pad * 2} ${height + pad * 2}`} preserveAspectRatio="xMidYMid meet" data-flat-view role="img"
      aria-label={`Flat pattern ${num(width, 1)} by ${num(height, 1)} millimetres with ${flat.bends.length} bends`}>
      <path className={styles.sheet} d={outline} fillRule="evenodd" strokeWidth={stroke} />
      {flat.bends.map((bend, index) => <BendLine key={`${bend.id}:${bend.segment ?? index}`} bend={bend} map={map} stroke={stroke} hovered={hover === bend.id} />)}
      {(flat.forms ?? []).map((form) => <FormMarks key={form.id} form={form} map={map} stroke={stroke} />)}
    </svg>
  );
}

function BendLine({ bend, map, stroke, hovered }: { bend: FlatBend; map: (p: XY) => XY; stroke: number; hovered: boolean }) {
  const [a, b] = [map(bend.start), map(bend.end)];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const n: XY = [-(b[1] - a[1]) / length * bend.allowance_mm / 2, (b[0] - a[0]) / length * bend.allowance_mm / 2];
  const zone = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]];
  const dash = bend.direction === 'up' ? `${stroke * 8} ${stroke * 5}` : `${stroke * 8} ${stroke * 3} ${stroke * 1.5} ${stroke * 3}`;
  return (
    <g className={styles.bend} data-direction={bend.direction} data-hover={hovered || undefined} data-bend={bend.id}
      onPointerEnter={() => hoverBend(bend.id)} onPointerLeave={() => hoverBend(null)} onClick={() => selectBend(bend.id)}>
      <title>{`${bend.id}: ${num(bend.angle_deg, 1)}° ${bend.direction}, R ${num(bend.radius_mm, 2)} mm, allowance ${num(bend.allowance_mm, 3)} mm`}</title>
      <polygon className={styles.zone} points={zone.map((p) => p.join(',')).join(' ')} />
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={stroke * (hovered ? 2.2 : 1.4)} strokeDasharray={dash} />
      <line className={styles.hit} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={Math.max(stroke * 10, bend.allowance_mm)} />
    </g>
  );
}

/** A form's process marks (as on the forming DXF, not cut lines) and a cross at its center; down forms dashed. */
function FormMarks({ form, map, stroke }: { form: FlatForm; map: (p: XY) => XY; stroke: number }) {
  const d = form.marks.map((segment) => pointsOf(segment).map(map)).filter((points) => points.length > 1)
    .map((points) => `M${points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L')}`).join('');
  const [cx, cy] = map(form.center);
  const r = stroke * 5;
  return (
    <g className={styles.form} data-form={form.id} data-direction={form.direction}>
      <title>{`${form.id}: ${form.kind}, formed ${form.direction}`}</title>
      <path d={d} strokeWidth={stroke * 1.1} strokeDasharray={form.direction === 'down' ? `${stroke * 4} ${stroke * 3}` : undefined} />
      <path className={styles.center} d={`M${cx - r} ${cy}L${cx + r} ${cy}M${cx} ${cy - r}L${cx} ${cy + r}`} strokeWidth={stroke} />
    </g>
  );
}
