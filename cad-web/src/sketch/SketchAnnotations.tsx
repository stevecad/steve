import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { inUnits, lengthDigits, type Units } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { useApp } from '@/state/store';
import { useScrub } from '@/ui/useScrub';
import { usePixelSize } from '@/viewport/usePixelSize';
import { bounds, closestOnSegment } from './geometry';
import { DIMENSION_OPS, points as pointMap, type Entity, type XY } from './model';
import { entityOf, screen, toWorld, useSketch } from './session';
import { moveLabel, setDimension } from './tools';
import styles from './Sketch.module.css';

const GLYPHS: Record<string, string> = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', concentric: '◎', midpoint: 'M',
  symmetric: '⇆', fix: '⚲', collinear: '⋯', point_on: '·',
};

/** Inferences shown while drawing, as the constraints the click adds (the point-to-point alignments marked with their guide). */
const INFERRED: Record<string, [string, string]> = {
  snap: ['●', 'Coincident'], midpoint: ['M', 'Midpoint'], on_curve: ['◦', 'On the curve'], horizontal: ['H', 'Horizontal'], vertical: ['V', 'Vertical'],
  parallel: ['∥', 'Parallel'], perpendicular: ['⊥', 'Perpendicular'], tangent: ['T', 'Tangent'], concentric: ['◎', 'Concentric'],
  align_h: ['⋯H', 'Horizontal with the point the guide comes from'], align_v: ['⋮V', 'Vertical with the point the guide comes from'],
};

/** Beside the cursor while a tool draws: what the next click adds. Nothing when Alt places freely (no hints). */
function InferenceBadges() {
  const hints = useSketch((s) => s.hints);
  const tool = useSketch((s) => s.tool);
  if (tool === 'select' || tool === 'dimension' || tool === 'project' || tool === 'trim') return null;
  const groups = new Map<string, { at: XY; kinds: string[] }>();
  for (const h of hints) {
    if (!INFERRED[h.kind]) continue;
    const key = `${h.at[0].toFixed(6)},${h.at[1].toFixed(6)}`;
    const group = groups.get(key) ?? { at: h.at, kinds: [] };
    if (!group.kinds.includes(h.kind)) group.kinds.push(h.kind);
    groups.set(key, group);
  }
  return (
    <>
      {/* Keyed by order, not position: the badges follow the cursor without remounting on every move. */}
      {[...groups.values()].map((g, index) => (
        <Html key={index} position={[g.at[0], g.at[1], 0]} zIndexRange={[45, 0]} style={{ pointerEvents: 'none' }}>
          <span className={styles.inference} data-inference>
            {g.kinds.map((kind) => <b key={kind} data-kind={kind} title={INFERRED[kind][1]}>{INFERRED[kind][0]}</b>)}
          </span>
        </Html>
      ))}
    </>
  );
}

const COLORS = {
  dark: { normal: '#a9b6c0', selected: '#ffb347', conflict: '#ff6b6b', placing: '#8fdcc0' },
  light: { normal: '#4d5963', selected: '#e07400', conflict: '#d03030', placing: '#1f9a73' },
};

const mid = (a: XY, b: XY): XY => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const add = (a: XY, b: XY, k = 1): XY => [a[0] + b[0] * k, a[1] + b[1] * k];
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
const len = (a: XY) => Math.hypot(a[0], a[1]);
const unit = (a: XY, fallback: XY = [1, 0]): XY => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : fallback; };
const perp = (a: XY): XY => [-a[1], a[0]];

function anchorOf(ref: string, entities: Entity[], pts: Map<string, XY>): XY | null {
  if (pts.has(ref)) return pts.get(ref)!;
  const e = entities.find((x) => x.id === ref);
  if (!e) return null;
  switch (e.type) {
    case 'line': return mid(e.start, e.end);
    case 'circle': return [e.center[0] + e.radius * Math.SQRT1_2, e.center[1] + e.radius * Math.SQRT1_2];
    case 'arc': { const a = (e.start_angle + e.end_angle) / 2 + (e.end_angle < e.start_angle ? Math.PI : 0); return [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)]; }
    case 'ellipse': case 'elliptical_arc': return [e.center[0] + e.major_radius, e.center[1]];
    case 'bspline': return e.poles[Math.floor(e.poles.length / 2)];
    default: return null;
  }
}

/* ───────── dimension graphics (sketch coordinates) ───────── */

interface Drawing { lines: [XY, XY][]; extensions: [XY, XY][]; arrows: { tip: XY; dir: XY }[]; at: XY }

/** What a dimension measures, resolved to points and curves. */
type Measure =
  | { kind: 'linear'; p: XY; q: XY; dir: XY }
  | { kind: 'radius' | 'diameter'; center: XY; r: number }
  | { kind: 'angle'; vertex: XY; from: number; sweep: number; reach: number };

function measureOf(op: string, refs: string[], entities: Entity[], pts: Map<string, XY>): Measure | null {
  const e = (ref: string) => entities.find((x) => x.id === ref);
  if (op === 'radius' || op === 'diameter') {
    const c = e(refs[0]);
    return c && (c.type === 'circle' || c.type === 'arc') ? { kind: op, center: c.center, r: c.radius } : null;
  }
  if (op === 'length') {
    const l = e(refs[0]);
    return l?.type === 'line' ? { kind: 'linear', p: l.start, q: l.end, dir: unit(sub(l.end, l.start)) } : null;
  }
  if (op === 'angle') {
    const a = e(refs[0]), b = refs[1] ? e(refs[1]) : null;
    if (a?.type !== 'line') return null;
    const d1 = unit(sub(a.end, a.start));
    const from = Math.atan2(d1[1], d1[0]);
    if (!b) return { kind: 'angle', vertex: a.start, from: 0, sweep: from, reach: len(sub(a.end, a.start)) };
    if (b.type !== 'line') return null;
    const d2 = unit(sub(b.end, b.start));
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-9) return null;
    const t = ((b.start[0] - a.start[0]) * d2[1] - (b.start[1] - a.start[1]) * d2[0]) / cross;
    const vertex = add(a.start, d1, t);
    const sweep = Math.atan2(cross, dot(d1, d2));
    return { kind: 'angle', vertex, from, sweep, reach: Math.min(len(sub(a.end, a.start)), len(sub(b.end, b.start))) };
  }
  const [ra, rb] = refs;
  const pa = pts.get(ra), pb = pts.get(rb);
  if (op === 'horizontal_distance' || op === 'vertical_distance') {
    return pa && pb ? { kind: 'linear', p: pa, q: pb, dir: op === 'horizontal_distance' ? [1, 0] : [0, 1] } : null;
  }
  if (pa && pb) return { kind: 'linear', p: pa, q: pb, dir: unit(sub(pb, pa)) };
  const point = pa ?? pb;
  const line = e(pa ? rb : ra);
  if (point && line?.type === 'line') {
    const along = unit(sub(line.end, line.start));
    const foot = add(line.start, along, dot(sub(point, line.start), along));
    return { kind: 'linear', p: point, q: foot, dir: unit(sub(foot, point), perp(along)) };
  }
  const la = e(ra), lb = e(rb);
  if (la?.type === 'line' && lb?.type === 'line') {
    const foot = closestOnSegment(lb.start, la.start, la.end);
    return { kind: 'linear', p: foot, q: lb.start, dir: unit(sub(lb.start, foot)) };
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Where a dimension's value sits when the code doesn't say: off the geometry, away from the sketch's middle, and the
 * direction it may be pushed further out when crowded. The offset follows zoom (`px`, world units per screen pixel): a
 * steady distance on screen, so values stay beside what they measure whether the view is zoomed in or out.
 */
function defaultLabel(m: Measure, middle: XY, offset: number, px: number): { at: XY; out: XY } {
  switch (m.kind) {
    case 'linear': {
      const c = mid(m.p, m.q);
      let n = perp(m.dir);
      if (dot(sub(c, middle), n) < 0) n = [-n[0], -n[1]];
      const base = dot(n, m.p) > dot(n, m.q) ? m.p : m.q;
      return { at: add(add(c, n, dot(sub(base, c), n)), n, clamp(offset, 28 * px, 90 * px)), out: n };
    }
    case 'radius': case 'diameter': {
      const out: XY = [Math.SQRT1_2, Math.SQRT1_2];
      return { at: add(m.center, out, m.r + clamp(offset, 24 * px, 90 * px)), out };
    }
    case 'angle': {
      const a = m.from + m.sweep / 2;
      const out: XY = [Math.cos(a), Math.sin(a)];
      return { at: add(m.vertex, out, clamp(Math.max(m.reach * 0.6, offset), 36 * px, 160 * px)), out };
    }
  }
}

/** A value tag's size on screen in pixels (11px monospace, as `.dimension` draws it). */
const tagSize = (text: string): XY => [text.length * 6.8 + 18, 20];

interface Tag { at: XY; text: string; out: XY | null }

/**
 * Keeps value tags from covering each other at the current zoom. Code-placed tags (no `out`) stay put and claim their
 * space first; a default tag that lands on one is pushed outward a tag's height (or width) at a time. Whatever still
 * overlaps after a few steps keeps its usual place and is drawn faded (crowded) until the view is zoomed in.
 */
function declutter(tags: Tag[], px: number, toScreen: (p: XY) => XY): { at: XY; crowded: boolean }[] {
  const taken: { c: XY; half: XY }[] = [];
  const box = (at: XY, text: string) => { const s = tagSize(text); return { c: toScreen(at), half: [s[0] / 2 + 2, s[1] / 2 + 2] as XY }; };
  const hits = (b: { c: XY; half: XY }) => taken.some((t) => Math.abs(t.c[0] - b.c[0]) < t.half[0] + b.half[0] && Math.abs(t.c[1] - b.c[1]) < t.half[1] + b.half[1]);
  const out: { at: XY; crowded: boolean }[] = tags.map((t) => ({ at: t.at, crowded: false }));
  const order = [...tags.keys()].sort((a, b) => Number(tags[a].out !== null) - Number(tags[b].out !== null));
  for (const i of order) {
    const { at, text, out: dir } = tags[i];
    let b = box(at, text);
    if (hits(b) && dir) {
      // Screen pixels moved per world unit along `dir`, and the tag's extent that way: one step clears a neighbour.
      const from = toScreen(at), to = toScreen(add(at, dir, px));
      const d = unit(sub(to, from)), perPx = len(sub(to, from)) || 1;
      const step = (Math.abs(d[0]) * b.half[0] * 2 + Math.abs(d[1]) * b.half[1] * 2) / perPx * px;
      for (let k = 1; k <= 3; k++) {
        const moved = box(add(at, dir, step * k), text);
        if (!hits(moved)) { out[i].at = add(at, dir, step * k); b = moved; break; }
      }
    }
    if (out[i].at === at && hits(b)) out[i].crowded = true;
    taken.push(b);
  }
  return out;
}

function drawing(m: Measure, at: XY, px: number): Drawing {
  const gap = 3 * px, over = 7 * px;
  const out: Drawing = { lines: [], extensions: [], arrows: [], at };
  if (m.kind === 'linear') {
    const n = perp(m.dir);
    const a = add(m.p, n, dot(sub(at, m.p), n)), b = add(m.q, n, dot(sub(at, m.q), n));
    for (const [from, to] of [[m.p, a], [m.q, b]] as [XY, XY][]) {
      const d = sub(to, from), l = len(d);
      if (l > gap) { const u = unit(d); out.extensions.push([add(from, u, gap), add(to, u, over)]); }
    }
    const span = dot(sub(b, a), m.dir), t = dot(sub(at, a), m.dir);
    const dir = unit(sub(b, a), m.dir);
    out.lines.push([a, b]);
    if (t < Math.min(0, span)) out.lines.push([add(a, m.dir, t), a]);
    if (t > Math.max(0, span)) out.lines.push([b, add(a, m.dir, t)]);
    if (Math.abs(span) > 1e-9) out.arrows.push({ tip: a, dir: [-dir[0], -dir[1]] }, { tip: b, dir });
    return out;
  }
  if (m.kind === 'radius' || m.kind === 'diameter') {
    const u = unit(sub(at, m.center), [Math.SQRT1_2, Math.SQRT1_2]);
    const reach = Math.max(len(sub(at, m.center)), m.r);
    const tip = add(m.center, u, m.r);
    if (m.kind === 'radius') {
      out.lines.push([m.center, add(m.center, u, reach)]);
      out.arrows.push({ tip, dir: u });
    } else {
      const far = add(m.center, u, -m.r);
      out.lines.push([far, add(m.center, u, reach)]);
      out.arrows.push({ tip, dir: u }, { tip: far, dir: [-u[0], -u[1]] });
    }
    return out;
  }
  const g = m as Extract<Measure, { kind: 'angle' }>;
  const r = Math.max(len(sub(at, g.vertex)), 4 * px);
  const steps = Math.max(8, Math.ceil(Math.abs(g.sweep) / (Math.PI / 36)));
  const point = (a: number): XY => add(g.vertex, [Math.cos(a), Math.sin(a)], r);
  for (let i = 0; i < steps; i++) out.lines.push([point(g.from + (g.sweep * i) / steps), point(g.from + (g.sweep * (i + 1)) / steps)]);
  const s = Math.sign(g.sweep) || 1;
  const tangent = (a: number, k: number): XY => [-Math.sin(a) * k, Math.cos(a) * k];
  out.arrows.push({ tip: point(g.from), dir: tangent(g.from, -s) }, { tip: point(g.from + g.sweep), dir: tangent(g.from + g.sweep, s) });
  return out;
}

/** World units per screen pixel on the sketch plane; follows zoom. */
function useSketchPixelSize(): number {
  return usePixelSize(useSketch((s) => s.plane.origin));
}

interface Placed { key: string; index: number | null; op: string; value: number; source: string; draw: Drawing; tone: 'normal' | 'selected' | 'conflict' | 'placing'; cid?: string; crowded?: boolean }

const isExpression = (source: string) => !/^-?[\d.]+(e-?\d+)?$/i.test(source.trim());

/** Dimension values and constraint glyphs, attached to the geometry they govern. */
export default function SketchAnnotations() {
  const statements = useSketch((s) => s.statements);
  const expansion = useSketch((s) => s.expansion);
  const selection = useSketch((s) => s.selection);
  const editing = useSketch((s) => s.editing);
  const placing = useSketch((s) => s.placing);
  const labelDrag = useSketch((s) => s.labelDrag);
  const units = useSetting('display.units');
  const result = useSketch((s) => s.result);
  const theme = useApp((s) => s.theme);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const plane = useSketch((s) => s.plane);
  const px = useSketchPixelSize();
  const pts = useMemo(() => pointMap(expansion.entities), [expansion]);
  const bad = new Set([...(result?.conflicting ?? []), ...(result?.redundant ?? [])]);
  const palette = COLORS[theme === 'light' ? 'light' : 'dark'];

  const frame = useMemo(() => {
    const box = bounds(expansion.entities.filter((e) => !e.construction));
    if (!box) return { middle: [0, 0] as XY, offset: 8 };
    const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);
    return { middle: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2] as XY, offset: Math.max(size * 0.12, 4) };
  }, [expansion]);

  const found: { dim: Omit<Placed, 'draw'>; m: Measure; tag: Tag }[] = [];
  statements.forEach((s, index) => {
    if (!DIMENSION_OPS.has(s.op)) return;
    const owner = expansion.owners[index];
    const cid = owner?.constraints[0];
    const constraint = expansion.constraints.find((c) => c.id === cid);
    if (!constraint) return;
    const m = measureOf(s.op, constraint.refs, expansion.entities, pts);
    if (!m) return;
    const written = s.kwargs.label?.value as XY | undefined;
    const valueArg = s.args[s.op === 'length' || s.op === 'radius' || s.op === 'diameter' ? 1 : 2] ?? s.kwargs.value;
    const value = Number(valueArg?.value ?? 0), source = valueArg?.source ?? '';
    const text = (isExpression(source) ? `${source} = ` : '') + format(s.op, value, units);
    const tag: Tag = labelDrag?.statement === index ? { at: labelDrag.at, text, out: null }
      : Array.isArray(written) && written.length === 2 ? { at: written, text, out: null }
      : { ...defaultLabel(m, frame.middle, frame.offset, px), text };
    found.push({ dim: { key: `d${index}`, index, op: s.op, value, source, tone: bad.has(cid) ? 'conflict' : selection.includes(cid) ? 'selected' : 'normal', cid }, m, tag });
  });
  const toScreen = (p: XY): XY => {
    const v = toWorld(plane, p).project(camera);
    return [(v.x + 1) / 2 * size.width, (1 - v.y) / 2 * size.height];
  };
  const laid = declutter(found.map((f) => f.tag), px, toScreen);
  const dims: Placed[] = found.map((f, i) => ({ ...f.dim, draw: drawing(f.m, laid[i].at, px), crowded: laid[i].crowded }));
  if (placing) {
    const m = measureOf(placing.op, placing.refs, expansion.entities, pts);
    if (m) dims.push({ key: 'placing', index: null, op: placing.op, value: placing.measured, source: '', draw: drawing(m, placing.at, px), tone: 'placing' });
  }

  return (
    <>
      <DimensionLines dims={dims} px={px} palette={palette} invalidate={invalidate} />
      <InferenceBadges />
      {dims.map((d) => d.index === null
        ? <Html key={d.key} position={[d.draw.at[0], d.draw.at[1], 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}><span className={styles.dimension} data-placing>{format(d.op, d.value, units)}</span></Html>
        : <Dimension key={d.key} index={d.index} at={d.draw.at} op={d.op} source={d.source} value={d.value} units={units} selected={d.tone === 'selected'} conflict={d.tone === 'conflict'} crowded={!!d.crowded} editing={editing?.statement === d.index} />)}
      {statements.map((s, index) => {
        const owner = expansion.owners[index];
        if (!owner || owner.entities.length || DIMENSION_OPS.has(s.op)) return null;  // Constraints inside composites (a rectangle's corners) stay implicit.
        const cid = owner.constraints[0];
        const constraint = expansion.constraints.find((c) => c.id === cid);
        const glyph = GLYPHS[s.op];
        if (!constraint || !glyph || s.op === 'point_on') return null;
        // On the first ref that has a place in the sketch (an axis, as in "point on the X axis", has none).
        const at = constraint.refs.map((ref) => anchorOf(ref, expansion.entities, pts)).find((p) => p) ?? null;
        if (!at) return null;
        return (
          <Html key={`c${index}`} position={[at[0], at[1], 0]} zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <button type="button" className={styles.glyph} data-selected={selection.includes(cid) || undefined} data-conflict={bad.has(cid) || undefined}
              title={`${s.op.replace('_', ' ')} · ${constraint.refs.join(', ')}`}
              onPointerDown={(event) => { event.stopPropagation(); useSketch.setState((state) => ({ selection: event.shiftKey ? [...state.selection, cid] : [cid] })); }}>
              {glyph}
            </button>
          </Html>
        );
      })}
    </>
  );
}

/** A dimension's value as a number: degrees, or a length (mm in the code) in the units the status bar shows. */
const amount = (op: string, value: number, units: Units) => Number(op === 'angle' ? value.toFixed(3) : inUnits(value, units).toFixed(lengthDigits(units, 3)));
const format = (op: string, value: number, units: Units) => `${op === 'diameter' ? 'Ø' : op === 'radius' ? 'R' : ''}${amount(op, value, units)}${op === 'angle' ? '°' : ''}`;

/** Dimension and extension lines plus arrowheads, one draw call per tone. */
function DimensionLines({ dims, px, palette, invalidate }: { dims: Placed[]; px: number; palette: typeof COLORS.dark; invalidate: () => void }) {
  const objects = useMemo(() => {
    const out: THREE.Object3D[] = [];
    for (const tone of ['normal', 'selected', 'conflict', 'placing'] as const) {
      const group = dims.filter((d) => d.tone === tone);
      if (!group.length) continue;
      const color = palette[tone];
      const flat = (segs: [XY, XY][]) => segs.flatMap(([a, b]) => [a[0], a[1], 0, b[0], b[1], 0]);
      const lines = flat(group.flatMap((d) => d.draw.lines));
      const extensions = flat(group.flatMap((d) => d.draw.extensions));
      if (lines.length) {
        const object = new LineSegments2(new LineSegmentsGeometry().setPositions(lines), new LineMaterial({ color, linewidth: tone === 'normal' ? 1.1 : 1.6, transparent: true, depthTest: false, worldUnits: false }));
        object.renderOrder = 25; object.frustumCulled = false; out.push(object);
      }
      if (extensions.length) {
        const object = new LineSegments2(new LineSegmentsGeometry().setPositions(extensions), new LineMaterial({ color, linewidth: 1, dashed: true, dashSize: 2.5 * px, gapSize: 2 * px, transparent: true, opacity: 0.85, depthTest: false, worldUnits: false }));
        object.computeLineDistances(); object.renderOrder = 25; object.frustumCulled = false; out.push(object);
      }
      const tri: number[] = [];
      const length = 9 * px, half = 3.2 * px;
      for (const { tip, dir } of group.flatMap((d) => d.draw.arrows)) {
        const u = unit(dir), n = perp(u);
        const base = add(tip, u, -length);
        const l = add(base, n, half), r = add(base, n, -half);
        tri.push(tip[0], tip[1], 0, l[0], l[1], 0, r[0], r[1], 0);
      }
      if (tri.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true }));
        mesh.renderOrder = 26; mesh.frustumCulled = false; out.push(mesh);
      }
    }
    return out;
  }, [dims, px, palette]);
  useEffect(() => {
    invalidate();
    return () => objects.forEach((o) => { (o as THREE.Mesh).geometry.dispose(); ((o as THREE.Mesh).material as THREE.Material).dispose(); });
  }, [objects, invalidate]);
  return <>{objects.map((o) => <primitive key={o.uuid} object={o} />)}</>;
}

function Dimension({ index, at, op, source, value, units, selected, conflict, crowded, editing }: { index: number; at: XY; op: string; source: string; value: number; units: Units; selected: boolean; conflict: boolean; crowded: boolean; editing: boolean }) {
  const expression = isExpression(source);
  // A plain length opens in the units the status bar shows; an expression keeps its text (parameters are mm).
  const opening = !expression && op !== 'angle' && units !== 'mm' ? String(amount(op, Number(source), units)) : source;
  const [text, setText] = useState(opening);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setText(opening); setError(null); requestAnimationFrame(() => input.current?.select()); } }, [editing, opening]);
  const shown = format(op, value, units);
  const commit = async (typed = text) => {
    // Unchanged: nothing is written (inches shown to 4 places don't round-trip to the mm in the code).
    if (units !== 'mm' && typed.trim() === opening.trim()) { useSketch.setState({ editing: null }); return; }
    const outcome = await setDimension(index, typed);
    if (outcome !== true) setError(outcome);
  };
  // The open editor's unit is a grab handle: dragging it sideways changes a plain number (the input keeps focus and its
  // text selection), applied once on release; Esc puts it back.
  const scrub = useScrub({ text, positive: op !== 'angle', onScrub: (next) => { setText(next); setError(null); }, onCommit: (next) => { void commit(next); }, onCancel: () => setText(text) });
  /** Drag moves the label; a click without moving edits the value. */
  const onPointerDown = (event: React.PointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      moved = true;
      const p = screen.toSketch(e.clientX, e.clientY);
      if (p) useSketch.setState({ labelDrag: { statement: index, at: p } });
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const cid = useSketch.getState().expansion.owners[index]?.constraints[0];
      if (moved) {
        const drop = useSketch.getState().labelDrag?.at;
        useSketch.setState({ labelDrag: null });
        if (drop) moveLabel(index, drop);
        return;
      }
      if (e.shiftKey && cid) useSketch.setState((state) => ({ selection: [...state.selection, cid] }));
      else useSketch.setState({ editing: { statement: index, at }, selection: cid ? [cid] : [] });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <Html position={[at[0], at[1], 0]} center zIndexRange={[40, 0]}>
      {editing ? (
        <span className={styles.dimensionEdit} data-error={error ? true : undefined}>
          <span className={styles.dimensionEditRow}>
            <input ref={input} value={text} aria-label="Dimension value" spellCheck={false} onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') void commit();
                if (event.key === 'Escape') useSketch.setState({ editing: null });
              }}
              onBlur={() => useSketch.setState({ editing: null })} />
            {scrub.scrubbable && <em {...scrub.props} data-dimension-scrub title="Drag sideways to change the value">{op === 'angle' ? '°' : units}</em>}
          </span>
          {error && <small>{error}</small>}
        </span>
      ) : (
        <button type="button" className={styles.dimension} data-selected={selected || undefined} data-conflict={conflict || undefined} data-expression={expression || undefined}
          data-crowded={crowded || undefined} data-dimension={index} title={expression ? `${source} = ${shown} · drag to move` : 'Click to change · drag to move'} onPointerDown={onPointerDown}>
          {expression ?<><span className={styles.dimensionExpr}>{source}</span>{shown}</> : shown}
        </button>
      )}
    </Html>
  );
}

export { entityOf };
