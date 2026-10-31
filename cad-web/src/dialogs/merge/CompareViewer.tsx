import { useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadGltf } from '@/viewport/model';
import { useOrbitControlsButtons } from '@/viewport/mouseStyle';
import { Spinner } from '@/ui';
import styles from './Merge.module.css';

export type CompareMode = 'overlay' | 'main' | 'branch';

interface Loaded { root: THREE.Group; materials: THREE.MeshStandardMaterial[]; edges: THREE.LineBasicMaterial[] }

/** Loads a build's preview as a Z-up group with its own materials so it can be ghosted or tinted. */
async function load(url: string): Promise<Loaded> {
  const gltf = await loadGltf(url);
  const root = new THREE.Group();
  root.rotation.x = Math.PI / 2;
  root.add(gltf.scene);
  const materials: THREE.MeshStandardMaterial[] = [];
  const edges: THREE.LineBasicMaterial[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    object.material = material;
    materials.push(material);
    const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
    object.add(new THREE.LineSegments(new THREE.EdgesGeometry(object.geometry, 24), edgeMaterial));
    edges.push(edgeMaterial);
  });
  return { root, materials, edges };
}

function style(model: Loaded | null, color: string, ghost: boolean, visible: boolean) {
  if (!model) return;
  model.root.visible = visible;
  for (const material of model.materials) {
    material.color.set(ghost ? '#9aa6ae' : color);
    material.transparent = ghost;
    material.opacity = ghost ? 0.22 : 1;
    material.depthWrite = !ghost;
    material.needsUpdate = true;
  }
  for (const edge of model.edges) { edge.color.set(ghost ? '#c3ccd2' : '#0d1114'); edge.opacity = ghost ? 0.5 : 0.85; }
}

function Rig({ box }: { box: THREE.Box3 | null }) {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = texture;
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    scene.environmentIntensity = 0.6;
    return () => { texture.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  useEffect(() => {
    if (!box || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    camera.up.set(0, 0, 1);
    camera.position.copy(sphere.center).add(new THREE.Vector3(1, -1, 0.85).normalize().multiplyScalar(sphere.radius * 3.2));
    camera.lookAt(sphere.center);
    (camera as THREE.PerspectiveCamera).near = sphere.radius / 100;
    (camera as THREE.PerspectiveCamera).far = sphere.radius * 100;
    camera.updateProjectionMatrix();
  }, [box, camera]);
  const mouseButtons = useOrbitControlsButtons();
  return <OrbitControls makeDefault target={box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : undefined} enableDamping dampingFactor={0.12} mouseButtons={mouseButtons} />;
}

/** Main and branch geometry in one view: main as a ghost, the branch solid in its branch color. */
export default function CompareViewer({ mainUrl, branchUrl, branchColor, mode }: { mainUrl: string | null; branchUrl: string | null; branchColor: string; mode: CompareMode }) {
  const [main, setMain] = useState<Loaded | null>(null);
  const [branch, setBranch] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([mainUrl ? load(mainUrl).catch(() => null) : null, branchUrl ? load(branchUrl).catch(() => null) : null]).then(([a, b]) => {
      if (cancelled) return;
      setMain(a); setBranch(b); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [mainUrl, branchUrl]);

  style(main, '#c3cbd1', mode === 'overlay', mode !== 'branch');
  style(branch, branchColor, false, mode !== 'main');

  const box = useMemo(() => {
    const result = new THREE.Box3();
    for (const model of [main, branch]) if (model) { model.root.updateWorldMatrix(true, true); result.union(new THREE.Box3().setFromObject(model.root)); }
    return result;
  }, [main, branch]);

  return (
    <div className={styles.viewer}>
      <Canvas camera={{ fov: 30, up: [0, 0, 1], position: [100, -100, 90] }} gl={{ antialias: true, alpha: true }} dpr={[1, 2]}
        onCreated={({ gl }) => { gl.toneMapping = THREE.NeutralToneMapping; }}>
        <directionalLight position={[-60, -80, 140]} intensity={1.6} />
        <hemisphereLight args={['#f2f6ff', '#1c2126', 0.4]} />
        {main && <primitive object={main.root} />}
        {branch && <primitive object={branch.root} />}
        <Rig box={box} />
      </Canvas>
      {loading && <div className={styles.viewerLoading}><Spinner /></div>}
      {!loading && !main && !branch && <div className={styles.viewerLoading}>No generated geometry to compare yet.</div>}
    </div>
  );
}
