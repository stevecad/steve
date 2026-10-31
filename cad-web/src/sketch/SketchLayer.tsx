import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { useApp } from '@/state/store';
import { points as pointMap, type Entity, type XY } from './model';
import { profileShapes, sample } from './geometry';
import { entityOf, screen, toLocal, useSketch } from './session';
import * as tools from './tools';
import SketchAnnotations from './SketchAnnotations';
import SketchFields from './SketchFields';

/** Half-length (mm) of a highlighted sketch axis: well past anything on screen. */
const AXIS = 1e5;

type Style = 'free' | 'defined' | 'construction' | 'selected' | 'hover' | 'conflict' | 'preview' | 'external' | 'projected' | 'trim';

const PALETTE: Record<'dark' | 'light', Record<Exclude<Style, 'trim'> | 'profile' | 'point', string>> = {
  dark: { free: '#63b4ff', defined: '#eef3f6', construction: '#d8a860', selected: '#ffb347', hover: '#b6e3ff', conflict: '#ff6b6b', preview: '#8fdcc0', external: '#b78cff', projected: '#c7a2ff', profile: '#63b4ff', point: '#eef3f6' },
  light: { free: '#1d6fd6', defined: '#141a1f', construction: '#a4741f', selected: '#e07400', hover: '#2d8ce0', conflict: '#d03030', preview: '#18936b', external: '#7a52d8', projected: '#6a3fd0', profile: '#1d6fd6', point: '#141a1f' },
};

function segments(entities: Entity[]): number[] {
  const out: number[] = [];
  for (const e of entities) {
    const pts = sample(e);
    for (let i = 1; i < pts.length; i++) out.push(pts[i - 1][0], pts[i - 1][1], 0, pts[i][0], pts[i][1], 0);
  }
  return out;
}

function dot(color: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The open sketch, drawn on its plane over the model, plus pointer input for the tools. */
export default function SketchLayer() {
  const active = useSketch((s) => s.active);
  return active ? <SketchScene /> : null;
}

function SketchScene() {
  const plane = useSketch((s) => s.plane);
  const expansion = useSketch((s) => s.expansion);
  const preview = useSketch((s) => s.preview);
  const hints = useSketch((s) => s.hints);
  const selection = useSketch((s) => s.selection);
  const hover = useSketch((s) => s.hover);
  const highlight = useSketch((s) => s.highlight);
  const result = useSketch((s) => s.result);
  const theme = useApp((s) => s.theme);
  const invalidate = useThree((s) => s.invalidate);
  const palette = PALETTE[theme === 'light' ? 'light' : 'dark'];

  const matrix = useMemo(() => new THREE.Matrix4().makeBasis(plane.x, plane.y, plane.normal).setPosition(plane.origin), [plane]);

  const materials = useMemo(() => {
    const make = (color: string, width: number, extra: Partial<ConstructorParameters<typeof LineMaterial>[0]> = {}) =>
      new LineMaterial({ color, linewidth: width, transparent: true, depthTest: false, worldUnits: false, ...extra });
    return {
      free: make(palette.free, 2), defined: make(palette.defined, 2), construction: make(palette.construction, 1.4, { dashed: true, dashSize: 3, gapSize: 2.2, opacity: 0.9 }),
      selected: make(palette.selected, 3), hover: make(palette.hover, 3), conflict: make(palette.conflict, 2.6), preview: make(palette.preview, 1.8, { opacity: 0.9 }),
      external: make(palette.external, 1.6, { dashed: true, dashSize: 1.5, gapSize: 1.5 }), projected: make(palette.projected, 2.2), guide: make(palette.preview, 1, { dashed: true, dashSize: 4, gapSize: 3, opacity: 0.7 }),
      // Inference: the curve a new line is drawn parallel/perpendicular/tangent to, softly lit while the cursor holds it.
      reference: make(palette.preview, 5, { opacity: 0.28 }),
      trim: make(palette.conflict, 5, { depthWrite: false }),
    };
  }, [palette]);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  const conflicting = useMemo(() => {
    const ids = new Set<string>();
    for (const cid of [...(result?.conflicting ?? []), ...(result?.redundant ?? [])]) {
      const c = expansion.constraints.find((item) => item.id === cid);
      c?.refs.forEach((ref) => { const e = entityOf(ref, expansion.entities); if (e) ids.add(e); });
    }
    return ids;
  }, [result, expansion]);

  // Geometry a constraint mentions lights up while the constraint is selected (or its panel row is under the pointer).
  const lit = useMemo(() => {
    const refs = new Set(highlight);
    for (const ref of selection) expansion.constraints.find((c) => c.id === ref)?.refs.forEach((r) => refs.add(r));
    return refs;
  }, [highlight, selection, expansion]);

  const buckets = useMemo(() => {
    const groups: Record<Style, Entity[]> = { free: [], defined: [], construction: [], selected: [], hover: [], conflict: [], preview: [], external: [], projected: [], trim: [] };
    // A selected point (a corner, an end, a center) shows as the point, not as the curve it belongs to.
    const curves = new Set(expansion.entities.map((e) => e.id));
    const selected = new Set(selection.filter((ref) => curves.has(ref)));
    const solved = result?.status === 'ok' && result.dof !== null;
    for (const e of expansion.entities) {
      if (e.type === 'point' || e.type === 'projection') continue;
      const style: Style = selected.has(e.id) ? 'selected' : hover === e.id || lit.has(e.id) ? 'hover' : conflicting.has(e.id) ? 'conflict'
        : e.external ? (e.construction ? 'external' : 'projected') : e.construction ? 'construction' : solved && result?.free?.[e.id] === false ? 'defined' : 'free';
      groups[style].push(e);
    }
    // The sketch's axes are pickable in Select (they're drawn by the grid): lit along their length when picked or pointed at.
    for (const axis of ['x_axis', 'y_axis'] as const) {
      const style = selection.includes(axis) ? 'selected' : hover === axis || lit.has(axis) ? 'hover' : null;
      if (style) groups[style].push({ id: axis, type: 'line', start: axis === 'x_axis' ? [-AXIS, 0] : [0, -AXIS], end: axis === 'x_axis' ? [AXIS, 0] : [0, AXIS] } as Entity);
    }
    // Trim's piece to cut away is drawn in the warning colour over the curve it belongs to.
    const cut = (e: Entity) => e.id === '~trim';
    groups.preview = preview.filter((e) => !e.construction && e.type !== 'point' && !cut(e));
    groups.construction.push(...preview.filter((e) => e.construction && !cut(e)));
    groups.trim = preview.filter(cut);
    return groups;
  }, [expansion, selection, hover, lit, conflicting, result, preview]);

  const lines = useMemo(() => {
    return (Object.keys(buckets) as Style[]).filter((style) => buckets[style].length).map((style) => {
      const geometry = new LineSegmentsGeometry().setPositions(segments(buckets[style]));
      const object = new LineSegments2(geometry, materials[style]);
      object.computeLineDistances();
      object.renderOrder = style === 'trim' ? 30 : style === 'selected' || style === 'hover' ? 22 : 20;
      object.frustumCulled = false;
      return object;
    });
  }, [buckets, materials]);
  useEffect(() => () => lines.forEach((line) => line.geometry.dispose()), [lines]);

  // Inference guides: dashed from the start of a horizontal/vertical segment and from a point the cursor lines up with;
  // the reference curve of a parallel/perpendicular/tangent/concentric inference softly lit along its length.
  const guides = useMemo(() => {
    const pos: number[] = [];
    for (const h of hints) {
      if ((h.kind === 'horizontal' || h.kind === 'vertical' || h.kind === 'align_h' || h.kind === 'align_v') && h.from) pos.push(h.from[0], h.from[1], 0, h.at[0], h.at[1], 0);
    }
    const references = expansion.entities.filter((e) => hints.some((h) => (h.kind === 'parallel' || h.kind === 'perpendicular' || h.kind === 'tangent' || h.kind === 'concentric') && h.ref === e.id));
    const out: LineSegments2[] = [];
    if (pos.length) out.push(new LineSegments2(new LineSegmentsGeometry().setPositions(pos), materials.guide));
    if (references.length) out.push(new LineSegments2(new LineSegmentsGeometry().setPositions(segments(references)), materials.reference));
    for (const object of out) { object.computeLineDistances(); object.renderOrder = 21; object.frustumCulled = false; }
    return out;
  }, [hints, materials, expansion]);
  useEffect(() => () => guides.forEach((g) => g.geometry.dispose()), [guides]);

  const profiles = useMemo(() => {
    const shapes = profileShapes(expansion.entities);
    return shapes.length ? new THREE.ShapeGeometry(shapes, 24) : null;
  }, [expansion]);
  useEffect(() => () => profiles?.dispose(), [profiles]);

  // Points, with the selected and hovered ones in a larger layer on top: a corner or a chain's joint is two coincident
  // points, and the plain twin must not hide the one that is picked.
  const [pointCloud, markedPoints] = useMemo(() => {
    const refs = [...pointMap(expansion.entities)].filter(([ref]) => {
      const owner = expansion.entities.find((e) => e.id === (entityOf(ref, expansion.entities) ?? ref));
      return !(owner?.type === 'projection');
    });
    const selectedPoints = new Set(selection);
    const pos: number[] = [], colors: number[] = [];
    const markedPos: number[] = [], markedColors: number[] = [];
    const color = new THREE.Color();
    for (const [ref, [x, y]] of refs) {
      const marked = selectedPoints.has(ref) ? palette.selected : hover === ref || lit.has(ref) ? palette.hover : null;
      color.set(marked ?? (ref === 'origin' ? palette.preview : palette.point));
      (marked ? markedPos : pos).push(x, y, 0);
      (marked ? markedColors : colors).push(color.r, color.g, color.b);
    }
    for (const e of preview) if (e.type === 'point') {
      pos.push(e.at[0], e.at[1], 0);
      color.set(palette.preview);
      colors.push(color.r, color.g, color.b);
    }
    for (const h of hints) if (h.kind === 'snap' || h.kind === 'midpoint' || h.kind === 'on_curve' || h.kind === 'concentric') {
      pos.push(h.at[0], h.at[1], 0);
      color.set(palette.selected);
      colors.push(color.r, color.g, color.b);
    }
    const geometry = (at: number[], tint: number[]) => {
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.Float32BufferAttribute(at, 3));
      out.setAttribute('color', new THREE.Float32BufferAttribute(tint, 3));
      return out;
    };
    return [geometry(pos, colors), geometry(markedPos, markedColors)];
  }, [expansion, selection, hover, lit, hints, palette, preview]);
  useEffect(() => () => { pointCloud.dispose(); markedPoints.dispose(); }, [pointCloud, markedPoints]);
  const pointMaterial = useMemo(() => new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true, map: dot('#ffffff'), alphaTest: 0.5, transparent: true, depthTest: false }), []);
  const markedMaterial = useMemo(() => new THREE.PointsMaterial({ size: 12, sizeAttenuation: false, vertexColors: true, map: dot('#ffffff'), alphaTest: 0.5, transparent: true, depthTest: false }), []);

  useEffect(() => { invalidate(); }, [lines, guides, profiles, pointCloud, markedPoints, invalidate]);

  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      {profiles && (
        <mesh geometry={profiles} renderOrder={18}>
          <meshBasicMaterial color={palette.profile} transparent opacity={theme === 'light' ? 0.1 : 0.13} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      {lines.map((line) => <primitive key={line.uuid} object={line} />)}
      {guides.map((guide) => <primitive key={guide.uuid} object={guide} />)}
      <points geometry={pointCloud} material={pointMaterial} renderOrder={24} />
      <points geometry={markedPoints} material={markedMaterial} renderOrder={25} />
      <SketchAnnotations />
      <SketchFields />
      <SketchInput />
    </group>
  );
}

/** Pointer input on the sketch plane; left button drives the tools, others keep navigating. */
function SketchInput() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const toLocalAt = (clientX: number, clientY: number): XY | null => {
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cameraRef.current);
      const { plane } = useSketch.getState();
      const p = new THREE.Plane().setFromNormalAndCoplanarPoint(plane.normal, plane.origin);
      if (!raycaster.ray.intersectPlane(p, hit)) return null;
      return toLocal(plane, hit);
    };
    const pointer = (event: PointerEvent | MouseEvent): tools.Pointer | null => {
      const p = toLocalAt(event.clientX, event.clientY);
      const q = toLocalAt(event.clientX + 8, event.clientY);
      if (!p || !q) return null;
      return { p, tol: Math.hypot(q[0] - p[0], q[1] - p[1]), shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey || event.metaKey, client: [event.clientX, event.clientY] as [number, number] };
    };
    screen.toSketch = toLocalAt;
    const onMove = (event: PointerEvent) => { const ptr = pointer(event); if (ptr) { tools.move(ptr); invalidate(); } };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopImmediatePropagation();
      const ptr = pointer(event);
      if (ptr) { element.setPointerCapture(event.pointerId); tools.down(ptr); invalidate(); }
    };
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopImmediatePropagation();
      const ptr = pointer(event);
      if (ptr) { tools.up(ptr); invalidate(); }
    };
    const onDouble = (event: MouseEvent) => { event.stopImmediatePropagation(); tools.doubleClick(); invalidate(); };
    const onLeave = () => useSketch.setState({ cursor: null, hover: null });
    element.addEventListener('pointermove', onMove, true);
    element.addEventListener('pointerdown', onDown, true);
    element.addEventListener('pointerup', onUp, true);
    element.addEventListener('dblclick', onDouble, true);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      screen.toSketch = () => null;
      element.removeEventListener('pointermove', onMove, true);
      element.removeEventListener('pointerdown', onDown, true);
      element.removeEventListener('pointerup', onUp, true);
      element.removeEventListener('dblclick', onDouble, true);
      element.removeEventListener('pointerleave', onLeave);
    };
  }, [gl, invalidate]);
  return null;
}
