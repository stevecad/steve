/**
 * Sketches in 3D (outside sketch editing) as pick targets. The pointer over a shown sketch's
 * curves or closed regions lights it up; a click selects it as its browser row does (or fills
 * an open feature dialog's sketch field); Shift/Ctrl adds. Sketches come first, before the
 * faces and edges they lie on; a face clearly in front of the sketch still wins.
 */
import { create } from 'zustand';
import * as THREE from 'three';
import { get as app, set as setApp, useApp } from '@/state/store';
import type { ModelDoc, ModelFeature } from '@/lib/modeling';
import { parseList, setValue, useFeatureDialog } from '@/modeling/dialog';
import { SPECS } from '@/modeling/specs';
import { splitTuple } from '@/modeling/bodies';
import { viewer } from '@/viewport/viewer';
import { profileShapes, sample } from './geometry';
import type { Entity, XY } from './model';
import { toLocal, useSketch, type SketchPlane } from './session';
import { sketchPlane } from './actions';

/**
 * `point` is a sketch point's reference ("sketch_1.p1", a circle's id for its centre, "sketch_1.l1.start"), picked for hole
 * positions; `line` is a sketch line's ("sketch_1.l3"), picked for an axis.
 */
export interface SketchHover { sketch: string; name: string; on: 'curve' | 'region' | 'point' | 'line'; point?: string; line?: string }

/** The sketch under the pointer and the sketches picked in the view (ids, in pick order). */
export const useSketchPicks = create<{ hover: SketchHover | null; picked: string[] }>(() => ({ hover: null, picked: [] }));

const PICK_PX = 6;

/** A sketch is consumed once another feature's arguments name it (or one of its regions). */
export function consumed(doc: ModelDoc, id: string): boolean {
  const pattern = new RegExp(`["']${id}(["'.])`);
  return doc.features.some((f) => f.id !== id && [...(f.args ?? []), ...Object.values(f.kwargs ?? {})].some((a) => pattern.test(a.source)));
}

/**
 * Sketches drawn in 3D: shown or hidden from the browser wins; otherwise unused, selected and picked ones show (and,
 * while hole positions or an axis line are being picked, used ones too, so a feature being edited can take its sketch's
 * points or lines).
 */
export function shownSketches(doc: ModelDoc, active: string | null, visibility: Record<string, boolean>, picked: string[], all = false): ModelFeature[] {
  return doc.features.filter((f) => f.kind === 'sketch' && f.id && f.document
    && (visibility[f.id] ?? (all || active === f.id || picked.includes(f.id) || !consumed(doc, f.id))));
}

/** The items of a positions list (`[(0, 0), "sketch_1.p1"]`), as sources; a whole sketch (`"sketch_1"`) is one item. */
export function positionItems(source: string | undefined): string[] {
  const text = (source ?? '').trim();
  if (!text) return [];
  return (/^\[/.test(text) ? splitTuple(text) : null) ?? [text];
}

/** The positions list with the sketch point `ref` toggled in or out (typed positions are kept). */
export function togglePosition(source: string | undefined, ref: string): string {
  const quoted = JSON.stringify(ref);
  const text = (source ?? '').trim();
  // Code the dialog can't take apart (a variable, a comprehension) is left as written.
  if (text && !/^\[/.test(text) && !/^["'][^"']*["']$/.test(text)) return text;
  // A whole sketch (all its points) gives way to the points picked one by one.
  const items = positionItems(text).filter((item) => !/^["'][^"'.]*["']$/.test(item));
  const next = items.some((item) => item.replace(/'/g, '"') === quoted) ? items.filter((item) => item.replace(/'/g, '"') !== quoted) : [...items, quoted];
  return next.length ? `[${next.join(', ')}]` : '';
}

/** The dialog field a sketch pick goes into: the targeted one, or the first sketch field when none is targeted. */
function dialogField() {
  const dialog = useFeatureDialog.getState();
  if (!dialog.open) return undefined;
  const fields = SPECS[dialog.kind]?.fields ?? [];
  const isSketch = (field: { type: string; sketches?: boolean }) => field.type === 'sketch' || field.type === 'sketches' || !!field.sketches;
  if (dialog.target) {
    const field = fields.find((f) => f.key === dialog.target);
    // A targeted positions field (Hole's) takes sketch points; a targeted axis field takes a sketch line.
    return field && (isSketch(field) || field.type === 'points' || field.type === 'axis') ? field : null;
  }
  return fields.find(isSketch) ?? null;
}

/** Sketch picking applies in Design's plain selection (Auto filter), or while a dialog wants a sketch. */
function pickable(): boolean {
  const state = app();
  const sketching = useSketch.getState();
  if (sketching.active || sketching.choosing || !state.modeling?.canonical || state.workspace !== 'design') return false;
  if (state.filter !== 'auto' || state.tool !== 'select') return false;
  return dialogField() !== null;
}

interface Prepared { id: string; name: string; plane: SketchPlane; normal: THREE.Vector3; curves: XY[][]; regions: { outer: XY[]; holes: XY[][] }[]; points: SketchPoint[]; lines: SketchLine[] }

export interface SketchLine { ref: string; start: XY; end: XY }

/** The lines of a sketch an axis can run along ("sketch_1.l3"); construction lines count, as they often are axes. */
export function sketchLines(sketch: string, entities: Entity[]): SketchLine[] {
  return entities.flatMap((e) => (e.type === 'line' ? [{ ref: `${sketch}.${e.id}`, start: e.start, end: e.end }] : []));
}

/** The sketch line within `tolerance` of `p` (sketch coordinates), the nearest. */
export function lineNear(lines: SketchLine[], p: XY, tolerance: number): { line: SketchLine; distance: number } | null {
  let best: { line: SketchLine; distance: number } | null = null;
  for (const line of lines) {
    const distance = segmentDistance(p, line.start, line.end);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { line, distance };
  }
  return best;
}

export interface SketchPoint { ref: string; at: XY; kind: 'point' | 'center' | 'end' }

/** The points of a sketch a hole can be placed at: its points, circle and arc centres, and line ends ("sketch_1.l1.start"). */
export function sketchPoints(sketch: string, entities: Entity[]): SketchPoint[] {
  const out: SketchPoint[] = [];
  for (const e of entities) {
    if (e.type === 'point') out.push({ ref: `${sketch}.${e.id}`, at: e.at, kind: 'point' });
    else if (e.type === 'circle' || e.type === 'arc' || e.type === 'ellipse' || e.type === 'elliptical_arc') out.push({ ref: `${sketch}.${e.id}`, at: e.center, kind: 'center' });
    else if (e.type === 'line') out.push({ ref: `${sketch}.${e.id}.start`, at: e.start, kind: 'end' }, { ref: `${sketch}.${e.id}.end`, at: e.end, kind: 'end' });
  }
  return out;
}

/** The field a pick fills is a positions list (Hole's): picks take single sketch points. */
export const pickingPoints = () => dialogField()?.type === 'points';

/** The field a pick fills is an axis (Revolve's, a pattern's, Move's): picks take a single sketch line. */
export const pickingLine = () => dialogField()?.type === 'axis';

let cache: { doc: ModelDoc | null; model: unknown; version: number; sketches: Map<string, Prepared | null> } = { doc: null, model: null, version: -1, sketches: new Map() };

function prepared(feature: ModelFeature, doc: ModelDoc): Prepared | null {
  const version = app().modelVersion;
  if (cache.doc !== doc || cache.model !== viewer.model || cache.version !== version) cache = { doc, model: viewer.model, version, sketches: new Map() };
  if (cache.sketches.has(feature.id!)) return cache.sketches.get(feature.id!)!;
  const plane = sketchPlane(feature, doc);
  const entities = (feature.document?.entities ?? []) as unknown as Entity[];
  const value = plane ? {
    id: feature.id!, name: feature.name, plane, normal: plane.normal.clone(),
    curves: entities.filter((e) => e.type !== 'point' && e.type !== 'projection').map((e) => sample(e, 48)),
    regions: profileShapes(entities.filter((e) => !e.construction)).map((shape) => ({
      outer: shape.getPoints(24).map((p) => [p.x, p.y] as XY), holes: shape.holes.map((hole) => hole.getPoints(24).map((p) => [p.x, p.y] as XY)),
    })),
    points: sketchPoints(feature.id!, entities),
    lines: sketchLines(feature.id!, entities),
  } : null;
  cache.sketches.set(feature.id!, value);
  return value;
}

function inside(p: XY, loop: XY[]): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** World size of one screen pixel at `distance` along the view. */
function pixelSize(camera: THREE.Camera, distance: number, height: number): number {
  if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / Math.max(height, 1);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
  return (2 * distance * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(height, 1);
}

/** The shown sketch under a screen point (curves within a few pixels, or inside a closed region). */
export function sketchAt(clientX: number, clientY: number, element: HTMLElement, modelHit?: { point: THREE.Vector3 } | null): (SketchHover & { depth: number }) | null {
  const state = app();
  const doc = state.modeling;
  const camera = viewer.camera;
  if (!doc || !camera || !pickable()) return null;
  const rect = element.getBoundingClientRect();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
  const ray = raycaster.ray;
  const front = modelHit ? ray.origin.distanceTo(modelHit.point) : Infinity;
  const points = pickingPoints();
  const lines = pickingLine();
  let best: (SketchHover & { depth: number }) | null = null;
  let nearest = Infinity;
  for (const feature of shownSketches(doc, state.activeFeature, state.sketchVisibility, useSketchPicks.getState().picked, points || lines || !!dialogField()?.sketches)) {
    const sketch = prepared(feature, doc);
    if (!sketch) continue;
    const facing = ray.direction.dot(sketch.normal);
    if (Math.abs(facing) < 1e-6) continue;
    const depth = sketch.plane.origin.clone().sub(ray.origin).dot(sketch.normal) / facing;
    if (depth <= 0) continue;
    const px = pixelSize(camera, depth, rect.height);
    // Sketches usually lie on faces: equal depth (within a few pixels) still counts as in front.
    if (depth > front + 4 * px) continue;
    const p = toLocal(sketch.plane, ray.at(depth, new THREE.Vector3()));
    if (points) {
      // Picking hole positions: only a sketch point within a few pixels counts, the nearest (points before centres and line ends).
      for (const point of sketch.points) {
        const d = Math.hypot(p[0] - point.at[0], p[1] - point.at[1]) / px - (point.kind === 'point' ? 2 : 0);
        if (d <= PICK_PX && d < nearest) { nearest = d; best = { sketch: sketch.id, name: sketch.name, on: 'point', point: point.ref, depth }; }
      }
      continue;
    }
    if (lines) {
      // Picking an axis: only a sketch line within a few pixels counts (anything else falls through to the model's edges).
      const hit = lineNear(sketch.lines, p, PICK_PX * px);
      if (hit && hit.distance / px < nearest) { nearest = hit.distance / px; best = { sketch: sketch.id, name: sketch.name, on: 'line', line: hit.line.ref, depth }; }
      continue;
    }
    let near = Infinity;
    for (const curve of sketch.curves) for (let i = 1; i < curve.length; i++) near = Math.min(near, segmentDistance(p, curve[i - 1], curve[i]));
    const on = near <= PICK_PX * px ? 'curve' : sketch.regions.some((r) => inside(p, r.outer) && !r.holes.some((h) => inside(p, h))) ? 'region' : null;
    if (!on) continue;
    const better = !best || (on === 'curve' && best.on === 'region') || (on === best.on && depth < best.depth);
    if (better) best = { sketch: sketch.id, name: sketch.name, on, depth };
  }
  return best;
}

/** Pointer moved over the canvas: track the sketch under it. Returns whether a sketch is hovered. */
export function hoverSketch(event: { clientX: number; clientY: number }, element: HTMLElement, modelHit?: { point: THREE.Vector3 } | null): boolean {
  const hit = sketchAt(event.clientX, event.clientY, element, modelHit);
  const hover = hit ? { sketch: hit.sketch, name: hit.name, on: hit.on, point: hit.point, line: hit.line } : null;
  const current = useSketchPicks.getState().hover;
  if (current?.sketch !== hover?.sketch || current?.on !== hover?.on || current?.point !== hover?.point || current?.line !== hover?.line) useSketchPicks.setState({ hover });
  return !!hover;
}

export const clearSketchHover = () => { if (useSketchPicks.getState().hover) useSketchPicks.setState({ hover: null }); };

/** A left click: picks the sketch under the pointer (true), or, on empty space, lets the model handle it. */
export function clickSketch(event: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, element: HTMLElement, modelHit?: { point: THREE.Vector3 } | null): boolean {
  const additive = event.shiftKey || event.ctrlKey || event.metaKey;
  const hit = sketchAt(event.clientX, event.clientY, element, modelHit);
  if (!hit) {
    // Empty space (or a face) in plain selection drops the picked sketches, as it drops picked faces.
    if (!additive && pickable() && !useFeatureDialog.getState().open) clearPicks();
    return false;
  }
  const field = dialogField();
  if (field) {
    // A dialog waiting for a sketch takes it (a list field toggles it in, in order).
    const values = useFeatureDialog.getState().values;
    if (field.type === 'points') {
      // The first pick replaces the dialog's starting position (the face's origin).
      if (hit.point) setValue(field.key, togglePosition(values[field.key] === field.initial ? '' : values[field.key], hit.point));
    } else if (field.type === 'axis') {
      // The line becomes the axis, as a picked edge does.
      if (hit.line) setValue(field.key, JSON.stringify(hit.line));
    } else if (field.type === 'sketches' || field.sketches) {
      const current = parseList(values[field.key]);
      const next = current.includes(hit.sketch) ? current.filter((id) => id !== hit.sketch) : [...current, hit.sketch];
      setValue(field.key, next.length ? `[${next.map((id) => JSON.stringify(id)).join(', ')}]` : '');
    } else setValue(field.key, JSON.stringify(hit.sketch));
    return true;
  }
  const { picked } = useSketchPicks.getState();
  const next = additive ? (picked.includes(hit.sketch) ? picked.filter((id) => id !== hit.sketch) : [...picked, hit.sketch]) : [hit.sketch];
  useSketchPicks.setState({ picked: next });
  // As the browser row does: the sketch becomes the active feature, so Extrude, Revolve and the rest start from it.
  setApp({ activeFeature: next.at(-1) ?? null, selection: [], contextMenu: null });
  return true;
}

export function clearPicks() {
  const { picked } = useSketchPicks.getState();
  if (!picked.length) return;
  useSketchPicks.setState({ picked: [] });
  if (picked.includes(app().activeFeature ?? '')) setApp({ activeFeature: null });
}

let installed = false;

/** Keeps view picks in step with the rest of the app: Esc clears them, picking anything else replaces them, Loft starts from them. */
export function installSketchPicking() {
  if (installed) return;
  installed = true;
  useApp.subscribe((state, previous) => {
    const { picked } = useSketchPicks.getState();
    if (!picked.length) return;
    const replaced = (state.activeFeature !== previous.activeFeature && !picked.includes(state.activeFeature ?? ''))
      || (state.selection !== previous.selection && state.selection.length > 0) || state.workspace !== 'design';
    const next = replaced ? [] : picked.filter((id) => state.modeling?.features.some((f) => f.id === id && f.kind === 'sketch'));
    if (next.length !== picked.length) useSketchPicks.setState({ picked: next });
  });
  useFeatureDialog.subscribe((state, previous) => {
    const { picked } = useSketchPicks.getState();
    if (!state.open || previous.open || state.editing || picked.length < 2) return;
    // Several sketches picked, then Loft: they become its sections, in pick order. Only a list the feature is made of
    // (a loft's sections), never an optional one (a sweep's More sections).
    const field = SPECS[state.kind]?.fields.find((f) => f.type === 'sketches' && f.positional && f.required);
    if (field && !state.values[field.key]) setValue(field.key, `[${picked.map((id) => JSON.stringify(id)).join(', ')}]`);
  });
  useSketch.subscribe((state, previous) => { if ((state.active || state.choosing) && !(previous.active || previous.choosing)) clearSketchHover(); });
  window.addEventListener('keydown', (event) => {
    const typing = (event.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable], .cm-editor');
    if (event.key === 'Escape' && !typing && !useSketch.getState().active && !useFeatureDialog.getState().open) clearPicks();
  });
}
