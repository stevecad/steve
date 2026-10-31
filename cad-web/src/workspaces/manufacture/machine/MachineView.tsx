/**
 * A machine model in 3D: its collision bodies placed by kinematics (each on its node, at the pose given), the tool and
 * workpiece attachment points, and the machine origin. CAD bodies draw their saved revision's mesh, STL bodies the
 * mesh uploaded from this browser, boxes their bounds; a body whose geometry isn't here is drawn as its bounds,
 * outlined. A display only: the backend checks collisions with the pinned solids.
 */
import { useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Edges, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Spinner } from '@/ui';
import { useOrbitControlsButtons } from '@/viewport/mouseStyle';
import { cadMesh, cadRevision, sameBody, uploadedMesh, type Bounds, type CollisionBody } from './bodyGeometry';
import { compose, frameOf, toMatrix4, type Frame } from './kinematics';
import styles from './Machine.module.css';

export const PALETTE = ['#5b8def', '#f0a43a', '#4fd1a5', '#e46b8a', '#a78bfa', '#38bdf8', '#facc15', '#94a3b8'];

export type BodyLook = 'mesh' | 'box' | 'bounds' | 'loading' | 'missing';
export interface BodyState { geometry: THREE.BufferGeometry | null; look: BodyLook; note: string | null }

/** A body's display geometry: its CAD revision's mesh, its uploaded STL, or its bounds. */
export function useBodyGeometry(body: CollisionBody): BodyState {
  const source = body.geometry_source;
  const [state, setState] = useState<BodyState>({ geometry: null, look: 'loading', note: null });
  const sha = body.artifact?.sha256;
  useEffect(() => {
    let live = true;
    const bounds = body.bounds ? 'bounds' as const : 'missing' as const;
    if (body.representation === 'solid_box' || body.representation === 'enclosing_box') { setState({ geometry: null, look: body.bounds ? 'box' : 'missing', note: null }); return; }
    if (body.representation === 'mesh') {
      const mesh = uploadedMesh(sha);
      setState(mesh ? { geometry: mesh, look: 'mesh', note: null } : { geometry: null, look: bounds, note: 'The STL isn’t in this browser: drawn as its bounds.' });
      return;
    }
    if (!source?.document_id) { setState({ geometry: null, look: bounds, note: body.artifact ? 'A BRep file: drawn as its bounds.' : null }); return; }
    setState({ geometry: null, look: 'loading', note: null });
    cadRevision(source.document_id, source.revision)
      .then(async (revision) => {
        const match = revision.bodies.find((item) => sameBody(item, source));
        if (!match) throw new Error(`“${revision.name}” revision ${source.revision} has no body “${source.body}”.`);
        const geometry = await cadMesh(revision.build.id, match.index);
        if (live) setState({ geometry, look: 'mesh', note: source.overrides && Object.keys(source.overrides).length ? 'Drawn without its parameter overrides.' : null });
      })
      .catch((error) => { if (live) setState({ geometry: null, look: bounds, note: (error as Error).message }); });
    return () => { live = false; };
  }, [body.representation, sha, source?.document_id, source?.revision, source?.body, (source?.instances ?? []).join('/'), !!body.bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const boxOf = (bounds: Bounds) => new THREE.Box3(new THREE.Vector3(...bounds.minimum_mm), new THREE.Vector3(...bounds.maximum_mm));

function BodyMesh({ body, matrix, color, selected, onSelect, onExtent }: {
  body: CollisionBody; matrix: THREE.Matrix4; color: string; selected: boolean; onSelect: () => void; onExtent: (id: string, box: THREE.Box3 | null) => void;
}) {
  const { geometry, look } = useBodyGeometry(body);
  const box = useMemo(() => (body.bounds ? boxOf(body.bounds) : null), [body.bounds]);
  useEffect(() => {
    if (geometry) { geometry.computeBoundingBox(); onExtent(body.id, geometry.boundingBox!.clone()); } else onExtent(body.id, box);
  }, [geometry, box, body.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tint = selected ? '#ffffff' : color;
  const click = (event: { stopPropagation: () => void }) => { event.stopPropagation(); onSelect(); };
  if (geometry) {
    return (
      <mesh geometry={geometry} matrix={matrix} matrixAutoUpdate={false} onClick={click} userData={{ machineBody: body.id, look }}>
        <meshStandardMaterial color={tint} metalness={0.15} roughness={0.55} side={THREE.DoubleSide} emissive={selected ? color : '#000000'} emissiveIntensity={selected ? 0.35 : 0} />
      </mesh>
    );
  }
  if (!box) return null;
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const solid = look === 'box' && body.representation === 'solid_box';
  return (
    <group matrix={matrix} matrixAutoUpdate={false} userData={{ machineBody: body.id, look }}>
      <mesh position={center} onClick={click}>
        <boxGeometry args={[Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3)]} />
        <meshStandardMaterial color={tint} transparent={!solid} opacity={solid ? 1 : 0.16} depthWrite={solid} metalness={0.1} roughness={0.6}
          emissive={selected ? color : '#000000'} emissiveIntensity={selected ? 0.3 : 0} />
        <Edges color={selected ? '#ffffff' : color} />
      </mesh>
    </group>
  );
}

function Rig({ box }: { box: THREE.Box3 }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  const center = useMemo(() => box.getCenter(new THREE.Vector3()), [box]);
  useEffect(() => {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const distance = (radius * 1.1) / Math.sin(Math.min(vertical, horizontal) / 2);
    camera.up.set(0, 0, 1);
    camera.position.copy(sphere.center).add(new THREE.Vector3(1.2, -1.5, 0.9).normalize().multiplyScalar(distance));
    camera.near = distance / 200; camera.far = distance * 20;
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
  }, [box, camera, aspect]);
  const mouseButtons = useOrbitControlsButtons();
  return <OrbitControls makeDefault target={center} enableDamping dampingFactor={0.12} mouseButtons={mouseButtons} />;
}

/** The tool attachment (a cone along −Z, toward the work) and the workpiece attachment (a square), in their frames. */
function Attachment({ frame, role, size }: { frame: Frame; role: string; size: number }) {
  const matrix = useMemo(() => toMatrix4(frame), [frame]);
  const r = size * 0.06;
  if (role === 'tool') {
    return (
      <group matrix={matrix} matrixAutoUpdate={false} userData={{ attachment: role }}>
        <mesh position={[0, 0, -r]} rotation={[-Math.PI / 2, 0, 0]}><coneGeometry args={[r * 0.5, r * 2, 24]} /><meshStandardMaterial color="#f0a43a" /></mesh>
      </group>
    );
  }
  const s = r * 2.5;
  return (
    <group matrix={matrix} matrixAutoUpdate={false} userData={{ attachment: role }}>
      <Line points={[[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0], [-s, -s, 0]]} color="#4fd1a5" lineWidth={1.5} />
      <Line points={[[0, 0, 0], [0, 0, r * 1.5]]} color="#4fd1a5" lineWidth={1.5} />
    </group>
  );
}

export default function MachineView({ bodies, frames, rest, attachments, nodeColors, selected, onSelect, loading, id }: {
  bodies: CollisionBody[];
  /** Node frames at the pose shown. */
  frames: Record<string, Frame>;
  /** Node frames at rest (the view fits these, so moving a joint doesn't move the camera). */
  rest: Record<string, Frame>;
  attachments: { id: string; node: string; role: string; frame?: Partial<Frame> | null }[];
  nodeColors: Record<string, string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  loading?: string | null;
  id?: string;
}) {
  const [extents, setExtents] = useState<Record<string, THREE.Box3 | null>>({});
  const onExtent = (key: string, box: THREE.Box3 | null) => setExtents((current) => (current[key]?.equals(box ?? new THREE.Box3()) ? current : { ...current, [key]: box }));
  const fit = useMemo(() => {
    const out = new THREE.Box3();
    for (const body of bodies) {
      const local = extents[body.id];
      if (!local || local.isEmpty()) continue;
      out.union(local.clone().applyMatrix4(toMatrix4(compose(rest[body.node] ?? frameOf(null), frameOf(body.frame)))));
    }
    for (const attachment of attachments) out.expandByPoint(new THREE.Vector3(...compose(rest[attachment.node] ?? frameOf(null), frameOf(attachment.frame)).origin_mm));
    if (out.isEmpty()) out.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(200, 200, 200));
    return out;
  }, [bodies, extents, rest, attachments]);
  const size = fit.getSize(new THREE.Vector3()).length();
  const ground = fit.min.z;
  const center = fit.getCenter(new THREE.Vector3());
  return (
    <div className={styles.view} id={id} data-machine-view data-bodies={bodies.length} data-drawn={Object.values(extents).filter(Boolean).length}>
      <Canvas frameloop="demand" dpr={[1, 2]} camera={{ fov: 32, up: [0, 0, 1], position: [400, -500, 300] }} gl={{ antialias: true }} onPointerMissed={() => onSelect(null)}>
        <ambientLight intensity={0.55} />
        <hemisphereLight args={['#dfe9f3', '#1a2230', 0.6]} />
        <directionalLight position={[400, -600, 900]} intensity={1.5} />
        <directionalLight position={[-600, 400, 300]} intensity={0.5} />
        <Rig box={fit} />
        <gridHelper args={[Math.max(size * 1.4, 100), 24, '#3a4656', '#262f3b']} rotation={[Math.PI / 2, 0, 0]} position={[center.x, center.y, ground - size * 0.002]} />
        <group userData={{ origin: true }}>
          <Line points={[[0, 0, 0], [size * 0.06, 0, 0]]} color="#ef4444" lineWidth={2} />
          <Line points={[[0, 0, 0], [0, size * 0.06, 0]]} color="#22c55e" lineWidth={2} />
          <Line points={[[0, 0, 0], [0, 0, size * 0.06]]} color="#3b82f6" lineWidth={2} />
        </group>
        {bodies.map((body) => (
          <BodyMesh key={body.id} body={body} color={nodeColors[body.node] ?? PALETTE[7]} selected={selected === body.id} onSelect={() => onSelect(body.id)} onExtent={onExtent}
            matrix={toMatrix4(compose(frames[body.node] ?? frameOf(null), frameOf(body.frame)))} />
        ))}
        {attachments.map((attachment) => (
          <Attachment key={attachment.id} role={attachment.role} size={size} frame={compose(frames[attachment.node] ?? frameOf(null), frameOf(attachment.frame))} />
        ))}
      </Canvas>
      {loading && <div className={styles.loading}><span><Spinner size={12} /> {loading}</span></div>}
    </div>
  );
}
