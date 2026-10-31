import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { evaluate, type ModelDoc } from '@/lib/modeling';
import { viewer } from '@/viewport/viewer';
import { usePixelSize } from '@/viewport/usePixelSize';
import { profileShapes } from '@/sketch/geometry';
import { sketchPlane } from '@/sketch/actions';
import type { Entity } from '@/sketch/model';
import { setAuto, setValue, useFeatureDialog } from './dialog';
import { autoExtrudeOp, materialAround, type MaterialAround } from './autoOperation';
import { dragStep, perFrame, snapTo } from '@/viewport/dragStep';
import styles from './Feature.module.css';

const COLORS = {
  dark: { add: '#5fcfa5', cut: '#ff5c5c', intersect: '#f5b546' },
  light: { add: '#1f9a73', cut: '#d93636', intersect: '#c98a12' },
};

const unquote = (v: string | undefined) => (v ?? '').trim().replace(/^["']|["']$/g, '');

/** The profile an extrude dialog points at: its closed regions and the plane they sit on. */
function profileOf(source: string | undefined, doc: ModelDoc | null) {
  const id = unquote(source).split('.')[0];
  const feature = doc?.features.find((f) => f.kind === 'sketch' && f.id === id);
  if (!doc || !feature?.document) return null;
  const plane = sketchPlane(feature, doc);
  if (!plane) return null;
  const shapes = profileShapes((feature.document.entities as unknown as Entity[]).filter((e) => !e.construction));
  if (!shapes.length) return null;
  const box = new THREE.Box2();
  for (const shape of shapes) for (const p of shape.getPoints()) box.expandByPoint(p);
  const center = box.getCenter(new THREE.Vector2());
  return { plane, shapes, center };
}

/**
 * Extrude dialogs show the solid they will add (green) or remove (red) right away, from the sketch,
 * with an arrow to drag the distance. It stays the preview while the dialog is open: the server builds the real result
 * to check it (errors show in the dialog) without showing it, and OK shows that build.
 */
export default function ExtrudePreview() {
  const open = useFeatureDialog((s) => s.open && s.kind === 'extrude');
  return open ? <Preview /> : null;
}

function Preview() {
  const values = useFeatureDialog((s) => s.values);
  const doc = useApp((s) => s.modeling);
  const theme = useApp((s) => s.theme);
  const invalidate = useThree((s) => s.invalidate);
  const [drag, setDrag] = useState<number | null>(null);
  const [hot, setHot] = useState(false);
  const profile = useMemo(() => profileOf(values.profile, doc), [values.profile, doc]);
  const typed = evaluate(values.distance ?? '', doc);
  const distance = drag ?? typed ?? 10;
  const extent = values.extent ?? 'distance';
  const op = unquote(values.op);
  // Left on Auto, the operation follows the direction: into the solid it's a cut, out of it a join. Material is measured
  // on the geometry from before this feature: for a new one the build Cancel returns to, for an edited one the part as
  // of the feature before it (the displayed model already holds the feature itself). A previewed cut would otherwise
  // empty the very spot it's measured at, and an edited feature's own solid would read as material to cut into.
  const measureBuild = useFeatureDialog((s) => s.measureBuildId);
  const measuring = useFeatureDialog((s) => s.measuring);
  const displayedId = useApp((s) => s.displayed?.id ?? null);
  const measured = useRef(new Map<object, MaterialAround | null>());
  const around = useMemo(() => {
    // Unknown while it's measured, and nothing to cut with no material before this feature (Auto then makes a new body).
    if (!profile || measuring || !measureBuild) return null;
    if (!measured.current.has(profile) || displayedId === measureBuild) measured.current.set(profile, materialAround(profile.plane, profile.shapes));
    return measured.current.get(profile) ?? null;
  }, [profile, displayedId, measureBuild, measuring]);
  const live = op ? null : autoExtrudeOp(around, extent, distance);  // Follows the arrow while it's dragged.
  const settled = op ? null : autoExtrudeOp(around, extent, typed ?? 10);  // What the code gets.
  useEffect(() => { if (!op) setAuto('op', settled === 'cut' ? '"cut"' : ''); }, [op, settled]);
  const resolved = op || live || 'join';
  const palette = COLORS[theme === 'light' ? 'light' : 'dark'];
  const color = resolved === 'cut' ? palette.cut : resolved === 'intersect' ? palette.intersect : palette.add;

  // Same extents as the runtime: symmetric about the sketch, reversed when negative, or through everything.
  const [start, depth] = useMemo(() => {
    if (extent === 'through') { const length = viewer.modelRadius() * 4 + 10; return [-length / 2, length]; }
    if (extent === 'both') return [-Math.abs(distance) / 2, Math.abs(distance)];
    return distance >= 0 ? [0, distance] : [distance, -distance];
  }, [extent, distance]);

  const basis = useMemo(() => profile && new THREE.Matrix4().makeBasis(profile.plane.x, profile.plane.y, profile.plane.normal).setPosition(profile.plane.origin), [profile]);
  // Built once per profile at unit depth, then stretched: dragging the arrow never re-triangulates.
  const geometry = useMemo(() => (profile ? new THREE.ExtrudeGeometry(profile.shapes, { depth: 1, bevelEnabled: false, curveSegments: 48 }) : null), [profile]);
  const edges = useMemo(() => geometry && new THREE.EdgesGeometry(geometry, 25), [geometry]);

  // Straight down the sketch normal the depth can't be seen or pulled: swing to a three-quarter view.
  const plane = profile?.plane;
  useEffect(() => {
    const controls = viewer.controls;
    if (!plane || !controls || !basis || !geometry) return;
    const eye = controls.getPosition(new THREE.Vector3()).sub(controls.getTarget(new THREE.Vector3())).normalize();
    if (Math.abs(eye.dot(plane.normal)) < 0.94) return;
    const iso = new THREE.Vector3(1, -1, 0.8).normalize();
    const side = iso.clone().addScaledVector(plane.normal, -iso.dot(plane.normal));
    if (side.lengthSq() < 1e-4) side.copy(plane.x).add(plane.y);
    const dir = plane.normal.clone().multiplyScalar(Math.sign(eye.dot(plane.normal)) || 1).add(side.normalize().multiplyScalar(0.9)).normalize();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, start).scale(new THREE.Vector3(1, 1, Math.max(depth, 1e-3)))).applyMatrix4(basis);
    if (viewer.model) box.union(viewer.model.bounds(false));
    viewer.frame(box, dir, true);
  }, [plane]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { geometry?.dispose(); edges?.dispose(); }, [geometry, edges]);
  useEffect(() => { invalidate(); }, [geometry, start, depth, color, hot, invalidate]);

  if (!profile || !basis || !geometry || !edges || depth <= 1e-6) return null;
  const tipZ = extent === 'both' ? start + depth : distance >= 0 ? start + depth : start;
  const sign = extent === 'both' || distance >= 0 ? 1 : -1;
  return (
    <group matrixAutoUpdate={false} matrix={basis}>
      <group position={[0, 0, start]} scale={[1, 1, depth]}>
        <mesh geometry={geometry} renderOrder={40}>
          <meshBasicMaterial color={color} transparent opacity={0.28} depthWrite={false} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments geometry={edges} renderOrder={41}>
          <lineBasicMaterial color={color} transparent opacity={0.95} depthTest={false} />
        </lineSegments>
      </group>
      {extent !== 'through' && (
        <Handle at={[profile.center.x, profile.center.y, tipZ]} sign={sign} color={color} hot={hot || drag !== null} setHot={setHot}
          label={`${Number((extent === 'both' ? Math.abs(distance) : distance).toFixed(2))} mm${live === 'cut' ? ' · Cut' : ''}`}
          onDrag={(z) => setDrag(extent === 'both' ? Math.abs(z) * 2 : z)}
          onEnd={(z) => { setDrag(null); setValue('distance', String(extent === 'both' ? Math.abs(z) * 2 : z)); }} />
      )}
    </group>
  );
}

/** A pull arrow along the sketch normal; dragging it sets the distance in steps a few pixels long (Shift: finer). */
function Handle({ at, sign, color, hot, setHot, label, onDrag, onEnd }: {
  at: [number, number, number]; sign: number; color: string; hot: boolean; setHot: (v: boolean) => void; label: string;
  onDrag: (z: number) => void; onEnd: (z: number) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const gl = useThree((s) => s.gl);
  const world = useMemo(() => new THREE.Vector3(), []);
  if (group.current) group.current.getWorldPosition(world);
  const pixel = usePixelSize(world);
  const size = pixel * 48;  // About 64 px long on screen, whatever the zoom.
  const onDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || !group.current?.parent) return;
    event.stopPropagation();
    const parent = group.current.parent;
    const origin = new THREE.Vector3(at[0], at[1], 0).applyMatrix4(parent.matrixWorld);
    const axis = new THREE.Vector3(0, 0, 1).transformDirection(parent.matrixWorld);
    const raycaster = new THREE.Raycaster();
    const element = gl.domElement;
    const along = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      if (!viewer.camera) return null;
      raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), viewer.camera);
      // Closest point on the normal through the profile to the pointer's ray.
      const { origin: a, direction: b } = raycaster.ray;
      const w = origin.clone().sub(a), d = axis.dot(b), e = axis.dot(w), f = b.dot(w);
      const denominator = 1 - d * d;
      if (denominator < 1e-6) return null;
      return (d * f - e) / denominator;
    };
    if (viewer.controls) viewer.controls.enabled = false;
    let last: number | null = null;
    const frames = perFrame(onDrag);
    // Keep the grab point under the pointer rather than jumping the tip to it.
    const grab = (along(event.clientX, event.clientY) ?? at[2]) - at[2];
    const move = (e: PointerEvent) => {
      const t = along(e.clientX, e.clientY);
      if (t === null) return;
      const z = snapTo(t - grab, dragStep(pixel, e.shiftKey));
      if (Math.abs(z) > 1e-6 && z !== last) { last = z; frames.push(z); }
    };
    const up = () => {
      frames.cancel();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (viewer.controls) viewer.controls.enabled = true;
      setHot(false);
      if (last !== null) onEnd(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const scale = hot ? 1.15 : 1;
  return (
    <group ref={group} position={at} rotation={[sign > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0]} scale={scale}
      onPointerOver={(event) => { event.stopPropagation(); setHot(true); if (viewer.controls) viewer.controls.enabled = false; gl.domElement.style.cursor = 'grab'; }}
      onPointerOut={() => { setHot(false); if (viewer.controls) viewer.controls.enabled = true; gl.domElement.style.cursor = ''; }}
      onPointerDown={onDown}>
      <mesh position={[0, size * 0.6, 0]} renderOrder={45}>
        <cylinderGeometry args={[size * 0.07, size * 0.07, size * 1.2, 12]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      <mesh position={[0, size * 1.45, 0]} renderOrder={45}>
        <coneGeometry args={[size * 0.26, size * 0.6, 24]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      {/* A larger invisible target, easier to grab. */}
      <mesh position={[0, size * 0.9, 0]} visible={false}>
        <cylinderGeometry args={[size * 0.4, size * 0.4, size * 1.9, 8]} />
      </mesh>
      <Html position={[size * 0.5, size * 1.9, 0]} zIndexRange={[50, 0]} style={{ pointerEvents: 'none' }}>
        <span className={styles.pullLabel} style={{ '--pull': color } as React.CSSProperties}>{label}</span>
      </Html>
    </group>
  );
}
