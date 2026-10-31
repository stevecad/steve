/**
 * Tools in 3D, in cutter-tip (or holder-gauge) millimetres, Z up toward the spindle. Part-backed components show
 * the display mesh their pinned job produced (tinted cutting / non-cutting along Z); parametric components are
 * revolved from their profile, nothing invented. The checked envelope is drawn as a translucent revolved shell.
 *
 * "Spin" turns the rotating stack about +Z at about 1 rev/s: a display aid only (an off-axis frame visibly wobbles);
 * every check uses the revolved envelope.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { RotateCw } from 'lucide-react';
import { Spinner, Switch } from '@/ui';
import { useOrbitControlsButtons } from '@/viewport/mouseStyle';
import styles from './ToolPart.module.css';

export interface ViewMesh {
  key: string;
  geometry: THREE.BufferGeometry;
  /** Component → view frame. */
  matrix: THREE.Matrix4;
  /** Cutting interval along the component's own Z (cutters), coloured apart from the shank. */
  cutting?: [number, number] | null;
  role: 'cutter' | 'holder';
}
export interface ViewShell { key: string; points: [number, number][]; role: 'cutter' | 'shank' | 'holder'; solid?: boolean }
/** A labelled plane across the axis (the gauge line). */
export interface ViewPlane { key: string; z: number; color: string }

const STEEL = new THREE.Color('#aab4be');
const CUTTING = new THREE.Color('#f0a43a');
const HOLDER = new THREE.Color('#7f8fa3');
const SHELL: Record<ViewShell['role'], string> = { cutter: '#f0a43a', shank: '#c7d2dc', holder: '#5b8def' };
export const LEGEND: [string, string][] = [['Cutting', '#f0a43a'], ['Shank', '#aab4be'], ['Holder', '#7f8fa3'], ['Checked envelope', '#5b8def']];

/** Vertex colours: cutting length vs the rest, by component-local Z. */
function tinted(view: ViewMesh): THREE.BufferGeometry {
  const geometry = view.geometry.clone();
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    const color = view.role === 'holder' ? HOLDER : view.cutting && z >= view.cutting[0] - 1e-6 && z <= view.cutting[1] + 1e-6 ? CUTTING : STEEL;
    colors.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function PartMesh({ view }: { view: ViewMesh }) {
  const geometry = useMemo(() => tinted(view), [view]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} matrix={view.matrix} matrixAutoUpdate={false} userData={{ toolMesh: view.key }}>
      <meshStandardMaterial vertexColors metalness={0.2} roughness={0.45} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** A revolved profile: (r, z) points turned about Z. Solid for parametric components, a translucent shell for envelopes. */
export function Shell({ shell }: { shell: ViewShell }) {
  const geometry = useMemo(() => {
    const points = shell.points.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z));
    const lathe = new THREE.LatheGeometry(points, 72);
    lathe.rotateX(Math.PI / 2);
    return lathe;
  }, [shell.points]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const outline = useMemo(() => [shell.points.map(([r, z]) => new THREE.Vector3(r, 0, z)), shell.points.map(([r, z]) => new THREE.Vector3(-r, 0, z))], [shell.points]);
  // The profile lies in the plane through the axis facing the camera, so it traces the envelope's silhouette.
  const facing = useRef<THREE.Group>(null);
  useFrame(({ camera }) => { if (facing.current) facing.current.rotation.z = Math.atan2(camera.position.x, -camera.position.y); });
  return (
    <group userData={{ toolShell: shell.key, solid: !!shell.solid }}>
      <mesh geometry={geometry} renderOrder={shell.solid ? 0 : 5}>
        {shell.solid
          ? <meshStandardMaterial color={shell.role === 'holder' ? HOLDER : shell.role === 'cutter' ? CUTTING : STEEL} metalness={0.2} roughness={0.5} side={THREE.DoubleSide} />
          : <meshBasicMaterial color={SHELL[shell.role]} transparent opacity={0.08} depthWrite={false} side={THREE.DoubleSide} />}
      </mesh>
      {/* The checked profile, drawn over the part like a section line: it doesn't turn with the spin. */}
      {!shell.solid && <group ref={facing}>{outline.map((line, index) => line.length > 1 && <Line key={index} points={line} color={SHELL[shell.role]} lineWidth={1.6} transparent opacity={0.95} depthTest={false} renderOrder={30} />)}</group>}
    </group>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

function useHidden() {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return hidden;
}

/** One group rotation per frame: no rebuilds. */
function Spinner3D({ spinning, children }: { spinning: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (spinning && ref.current) ref.current.rotation.z = (ref.current.rotation.z + Math.min(delta, 0.1) * Math.PI * 2) % (Math.PI * 2);
  });
  return <group ref={ref}>{children}</group>;
}

function Rig({ box }: { box: THREE.Box3 }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  const center = useMemo(() => box.getCenter(new THREE.Vector3()), [box]);
  useEffect(() => {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    // Fit the bounding sphere in the narrower of the two fields of view.
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const distance = (radius * 1.08) / Math.sin(Math.min(vertical, horizontal) / 2);
    camera.up.set(0, 0, 1);
    camera.position.copy(sphere.center).add(new THREE.Vector3(1.15, -1, 0.38).normalize().multiplyScalar(distance));
    camera.near = distance / 100; camera.far = distance * 20;
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
  }, [box, camera, aspect]);
  const mouseButtons = useOrbitControlsButtons();
  return <OrbitControls makeDefault target={center} enableDamping dampingFactor={0.12} mouseButtons={mouseButtons} />;
}

function Planes({ planes, box }: { planes: ViewPlane[]; box: THREE.Box3 }) {
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.y) * 0.62 + 2;
  return <>{planes.map((plane) => <Line key={plane.key} points={Array.from({ length: 65 }, (_, i) => [r * Math.cos((i / 64) * Math.PI * 2), r * Math.sin((i / 64) * Math.PI * 2), plane.z] as [number, number, number])} color={plane.color} lineWidth={1.6} />)}</>;
}

/** Tip (or gauge) marker: the origin plane and the +Z axis. */
function Axes({ box }: { box: THREE.Box3 }) {
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.y) * 0.75 + 2;
  return (
    <group>
      <Line points={[[0, 0, box.min.z - r * 0.25], [0, 0, box.max.z + r * 0.25]]} color="#38bdf8" lineWidth={1} dashed dashSize={2} gapSize={1.5} transparent opacity={0.6} />
      <Line points={[[-r, 0, 0], [r, 0, 0]]} color="#ef4444" lineWidth={1} transparent opacity={0.6} />
      <Line points={[[0, -r, 0], [0, r, 0]]} color="#ef4444" lineWidth={1} transparent opacity={0.35} />
    </group>
  );
}

export default function ToolView({ meshes, shells, planes = [], loading, spinDefault, note, tall, id }: {
  meshes: ViewMesh[]; shells: ViewShell[]; planes?: ViewPlane[]; loading?: string | null; spinDefault: boolean; note?: ReactNode; tall?: boolean; id?: string;
}) {
  const reduced = useReducedMotion();
  const hidden = useHidden();
  const [spin, setSpin] = useState(spinDefault);
  const spinning = spin && !reduced && !hidden;
  const box = useMemo(() => {
    const out = new THREE.Box3();
    for (const view of meshes) {
      view.geometry.computeBoundingBox();
      out.union(view.geometry.boundingBox!.clone().applyMatrix4(view.matrix));
    }
    for (const shell of shells) for (const [r, z] of shell.points) out.expandByPoint(new THREE.Vector3(r, r, z)).expandByPoint(new THREE.Vector3(-r, -r, z));
    if (out.isEmpty()) out.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 10, 10));
    return out;
  }, [meshes, shells]);
  return (
    <div className={styles.view} data-tall={tall || undefined} id={id} data-tool-view data-placed-meshes={meshes.length} data-profile-components={shells.filter((s) => s.solid).length}
      data-envelope-shells={shells.filter((s) => !s.solid).length} data-spin={spinning ? 'on' : 'off'}>
      <Canvas frameloop={spinning ? 'always' : 'demand'} dpr={[1, 2]} camera={{ fov: 32, up: [0, 0, 1], position: [60, -60, 40] }} gl={{ antialias: true }}>
        <ambientLight intensity={0.55} />
        <hemisphereLight args={['#dfe9f3', '#1a2230', 0.65]} />
        <directionalLight position={[60, -80, 120]} intensity={1.6} />
        <directionalLight position={[-80, 60, 40]} intensity={0.6} />
        <Rig box={box} />
        <Axes box={box} />
        <Planes planes={planes} box={box} />
        <Spinner3D spinning={spinning}>
          {meshes.map((view) => <PartMesh key={view.key} view={view} />)}
          {shells.filter((shell) => shell.solid).map((shell) => <Shell key={shell.key} shell={shell} />)}
        </Spinner3D>
        {shells.filter((shell) => !shell.solid).map((shell) => <Shell key={shell.key} shell={shell} />)}
      </Canvas>
      <div className={styles.viewBar}>
        <label className={styles.spin} title="Display spin — checks use the revolved envelope">
          <Switch checked={spin} onCheckedChange={setSpin} label="Display spin" />
          <RotateCw size={12} />
          <span>Display spin{reduced ? ' (paused: reduced motion)' : ''} — checks use the revolved envelope</span>
        </label>
      </div>
      {loading && <div className={styles.loading}><span><Spinner size={12} /> {loading}</span></div>}
      {note && <div className={styles.viewNote}>{note}</div>}
    </div>
  );
}
