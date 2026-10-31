/**
 * The milling simulation in the viewport: toolpath, the real tool assembly at the playback position, stock
 * checkpoints, pinned fixtures and the job's verification events. Every artifact is in machine space; one group
 * moves it by −(work origin) so it sits on the design, whose own frame is the program's work frame. Nothing else is
 * transformed again (the GLBs are already in machine XYZ, scaled from metres by `scale_to_mm`).
 *
 * Drawing only: positions between moves are interpolated for display, stock is the display height field cut in a
 * worker (3-axis milling; HeightStock.tsx) or else the backend's voxel stock, and events mark where the backend's checks
 * spoke.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { viewer } from '@/viewport/viewer';
import { displayGeometry, frameMatrix, regionPoints, type AssemblySnapshot } from '../toolGeometry';
import { PartMesh, Shell, type ViewMesh, type ViewShell } from '../ToolView';
import { artifactBytes, type FixtureDisplay, type InspectionRegion, type StockCheckpoint, type StockDeltaStream, type StockInspection } from './api';
import { MOVE_KINDS, tipAt, type Motion } from './motion';
import { decodeDeltaChunk, DEFINITE, REMOVED, StockPlayback, UNCERTAIN, type StockNeeds } from './stock';
import { StockMesh } from './stockMesh';
import { toolAt, updateDraft, useCam, useGeometryVersion, usePlayer, useToolpath, type ContourMark, type HoleMark, type Player, type SurfaceMark, type TabMark } from './state';
import { bodyBounds, contourChain, cutterOf, followsOutline, patternSeed } from './program';
import { instancesOf, placePoint } from './pattern';
import styles from './Cam.module.css';
import { offsetPath, type XY } from './contour';
import { chamferOffset, engraveWidth } from './engrave';
import { horizontalSketches } from './sketchCurves';
import { usePreview } from './preview';
import HeightStock from './HeightStock';
import { fieldPlan, useStockView } from './stockView';

/** Toolpath colours by move kind (the deck's legend uses the same). */
export const KIND_COLORS: Record<(typeof MOVE_KINDS)[number], string> = {
  rapid: '#ffd23f', feed: '#3b9eff', plunge: '#ff7a45', lead: '#36cfc9', link: '#b37feb', retract: '#e6b422',
};
export const SEVERITY_COLORS = { failed: '#ef4444', uncertain: '#f59e0b', unassessed: '#94a3b8' } as const;

const STOCK_COLOR = '#b9c4cf';
const UNCERTAIN_COLOR = '#f0a43a';
const FIXTURE_COLOR = '#6b7785';

// ── Toolpath ───────────────────────────────────────────────────────────────

const VERTEX = /* glsl */ `
attribute float aMove;
attribute float aKind;
attribute float aDist;
uniform vec3 uColors[6];
varying vec3 vColor;
varying float vMove;
varying float vKind;
varying float vDist;
void main() {
  vColor = uColors[int(aKind + 0.5)];
  vMove = aMove; vKind = aKind; vDist = aDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform float uPosition;
uniform float uDash;
varying vec3 vColor;
varying float vMove;
varying float vKind;
varying float vDist;
void main() {
  // Rapids and retracts are dashed (the format has no simulated rapid speed; they are drawn, not timed).
  if ((vKind < 0.5 || vKind > 4.5) && mod(vDist, uDash * 2.0) > uDash) discard;
  float played = step(vMove, uPosition - 1e-4);
  gl_FragColor = vec4(vColor, mix(0.22, 0.95, played));
}`;

/** The decoded motion as lines: played moves strong, the rest faint (`full`: every move strong, a selected operation's path). */
function Toolpath({ motion, full }: { motion: Motion; full?: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const { geometry, material } = useMemo(() => {
    const count = motion.count;
    const positions = new Float32Array(count * 6), moves = new Float32Array(count * 2), kinds = new Float32Array(count * 2), dists = new Float32Array(count * 2);
    let px = motion.start[0], py = motion.start[1], pz = motion.start[2];
    for (let i = 0; i < count; i++) {
      // After a tool change the next move starts at the new tool's tip: nothing is drawn between the two tips.
      const restart = motion.restarts.get(i);
      if (restart) { px = restart[0]; py = restart[1]; pz = restart[2]; }
      const x = motion.end[i * 3], y = motion.end[i * 3 + 1], z = motion.end[i * 3 + 2];
      positions.set([px, py, pz, x, y, z], i * 6);
      moves[i * 2] = moves[i * 2 + 1] = i;
      kinds[i * 2] = kinds[i * 2 + 1] = motion.kind[i];
      dists[i * 2] = 0; dists[i * 2 + 1] = Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMove', new THREE.BufferAttribute(moves, 1));
    geometry.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    geometry.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
      uniforms: { uPosition: { value: 0 }, uDash: { value: 1.2 }, uColors: { value: MOVE_KINDS.map((kind) => new THREE.Color(KIND_COLORS[kind])) } },
    });
    return { geometry, material };
  }, [motion]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useEffect(() => (full ? undefined : usePlayer.subscribe((state) => {
    material.uniforms.uPosition.value = state.position;
    invalidate();
  })), [material, invalidate, full]);
  material.uniforms.uPosition.value = full ? motion.count + 1 : usePlayer.getState().position;
  return <lineSegments geometry={geometry} material={material} renderOrder={12} userData={{ camToolpath: motion.count }} />;
}

// ── GLBs ─────────────────────────────────────────────────────────────────

const glbs = new Map<string, Promise<THREE.Group>>();

/** A verified display GLB as a group in millimetres (glTF metres × scale_to_mm), machine axes. */
function displayGlb(jobId: string, file: { name: string; bytes: number; sha256: string }, scale: number): Promise<THREE.Group> {
  const key = `${jobId}:${file.sha256}`;
  let request = glbs.get(key);
  if (!request) {
    request = (async () => {
      const bytes = await artifactBytes(jobId, file);
      const gltf = await new GLTFLoader().parseAsync(bytes, '');
      const group = new THREE.Group();
      group.add(gltf.scene);
      group.scale.setScalar(scale);
      return group;
    })();
    glbs.set(key, request);
    request.catch(() => glbs.delete(key));
    while (glbs.size > 32) glbs.delete(glbs.keys().next().value!);
  }
  return request;
}

const stockMaterials = {
  definite: new THREE.MeshStandardMaterial({ color: STOCK_COLOR, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  translucent: new THREE.MeshStandardMaterial({ color: STOCK_COLOR, metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
  uncertain: new THREE.MeshBasicMaterial({ color: UNCERTAIN_COLOR, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
};

/**
 * The stock: for 3-axis milling the display height field (a fine Z-map cut by the swept cutters; HeightStock.tsx).
 * Otherwise, or when "Engine stock (checks)" is on, the engine's voxels: continuous when the job carries timed
 * transitions (material goes as the tool passes, from the backend's keyframes and per-move cell changes), else the
 * checkpoint meshes. A stream that can't be read falls back to the checkpoints and says why.
 */
function Stock({ player, mode }: { player: Player; mode: 'solid' | 'translucent' }) {
  const stream = player.preview?.stock_deltas;
  const failed = usePlayer((state) => state.stockError);
  // The display field for 3-axis milling, unless the engine's own stock is asked for (or the field can't show it).
  const engine = useStockView((state) => state.engine);
  const fieldError = useStockView((state) => state.error);
  const plan = useMemo(() => fieldPlan(player), [player]);
  if (plan.ok && !engine && fieldError?.job !== player.job.id) return <HeightStock player={player} plan={plan} mode={mode} />;
  const usable = !!stream && !failed && (player.preview?.stock_checkpoints ?? []).every((checkpoint) => !!checkpoint.state);
  return usable ? <ContinuousStock player={player} stream={stream} mode={mode} /> : <CheckpointStock player={player} mode={mode} />;
}

const stockLook = (mode: 'solid' | 'translucent') => ({
  materials: { definite: mode === 'solid' ? stockMaterials.definite : stockMaterials.translucent, uncertain: stockMaterials.uncertain },
  order: { definite: mode === 'solid' ? 1 : 8, uncertain: 9 },
});

function ContinuousStock({ player, stream, mode }: { player: Player; stream: StockDeltaStream; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const checkpoints = player.preview!.stock_checkpoints;
  const shown = useMemo(() => {
    const playback = new StockPlayback<StockCheckpoint>(checkpoints.map((checkpoint) => ({ afterMove: checkpoint.after_move, display: checkpoint, cells: null })),
      stream.grid, stream.chunks.map((chunk) => ({ first: chunk.first_move, last: chunk.last_move })), stream.moves);
    return { playback, mesh: new StockMesh(playback.cells!, stockLook('solid').materials) };
  }, [checkpoints, stream]);
  useEffect(() => {
    const { playback, mesh } = shown;
    const jobId = player.job.id;
    let live = true;
    const loading = new Set<string>();
    const fail = (error: unknown) => { if (live) usePlayer.setState({ stockError: error instanceof Error ? error.message : String(error) }); };
    // Keyframes and chunks load when a seek needs them (and the chunk after, ahead of playback).
    const fetchChunk = (index: number) => {
      if (index < 0 || index >= stream.chunks.length || playback.hasChunk(index) || loading.has(`c${index}`)) return;
      loading.add(`c${index}`);
      const chunk = stream.chunks[index];
      void artifactBytes(jobId, chunk.file).then((bytes) => {
        if (!live) return;
        playback.setChunk(index, decodeDeltaChunk(bytes, chunk.first_move, chunk.last_move));
        show();
        fetchChunk(index + 1);
      }).catch(fail);
    };
    const load = (needs: StockNeeds) => {
      const index = needs.keyframe;
      if (index !== undefined && !loading.has(`k${index}`)) {
        loading.add(`k${index}`);
        void artifactBytes(jobId, checkpoints[index].state!).then((bytes) => {
          if (!live) return;
          playback.setKeyframe(index, new Uint8Array(bytes));
          show();
        }).catch(fail);
      }
      if (needs.chunk !== undefined) fetchChunk(needs.chunk);
    };
    function show() {
      if (!live) return;
      try {
        const position = usePlayer.getState().position;
        const step = playback.seek(position);
        const changes = playback.takeChanges();
        if (changes.full) mesh.rebuild();
        else if (changes.cells.length) mesh.update(changes.cells);
        const cells = playback.cells!;
        mesh.group.userData.camStock = {
          continuous: true, position, restoredFrom: playback.restoredFrom, pending: !!step.needs,
          definite: cells.count(DEFINITE), uncertain: cells.count(UNCERTAIN), removed: cells.count(REMOVED),
        };
        if (step.needs) load(step.needs);
        invalidate();
      } catch (error) { fail(error); }
    }
    show();
    const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.position !== previous.position) show(); });
    return () => { live = false; unsubscribe(); };
  }, [shown, stream, checkpoints, player.job.id, invalidate]);
  useEffect(() => {
    const look = stockLook(mode);
    shown.mesh.setMaterials(look.materials, look.order);
    invalidate();
  }, [shown, mode, invalidate]);
  useEffect(() => () => shown.mesh.dispose(), [shown]);
  return <primitive object={shown.mesh.group} />;
}

/** A fixture collision's witness: a point the engine found inside both the cutter and the fixture solid (machine mm). */
function WitnessMarker({ at, size }: { at: number[]; size: number }) {
  const r = Math.max(0.4, size * 0.04);
  const [x, y, z] = at;
  return (
    <group userData={{ camWitness: at }}>
      <mesh position={[x, y, z]} renderOrder={40}>
        <sphereGeometry args={[r, 20, 14]} />
        <meshBasicMaterial color="#ef4444" depthTest={false} transparent opacity={0.95} />
      </mesh>
      <Line points={[[x - r * 3, y, z], [x + r * 3, y, z]]} color="#ef4444" lineWidth={1.5} depthTest={false} renderOrder={40} />
      <Line points={[[x, y - r * 3, z], [x, y + r * 3, z]]} color="#ef4444" lineWidth={1.5} depthTest={false} renderOrder={40} />
      <Line points={[[x, y, z - r * 3], [x, y, z + r * 3]]} color="#ef4444" lineWidth={1.5} depthTest={false} renderOrder={40} />
    </group>
  );
}

function CheckpointStock({ player, mode }: { player: Player; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const checkpoints = player.preview?.stock_checkpoints ?? [];
  const playback = useMemo(() => new StockPlayback<StockCheckpoint>(checkpoints.map((checkpoint) => ({ afterMove: checkpoint.after_move, display: checkpoint }))), [checkpoints]);
  const [index, setIndex] = useState(() => playback.seek(usePlayer.getState().position).keyframe);
  const [group, setGroup] = useState<THREE.Group | null>(null);
  useEffect(() => usePlayer.subscribe((state) => { const next = playback.seek(state.position); if (next.changed) setIndex(next.keyframe); }), [playback]);
  useEffect(() => {
    const checkpoint = checkpoints[index];
    if (!checkpoint) return;
    let live = true;
    void displayGlb(player.job.id, checkpoint.mesh, checkpoint.display.scale_to_mm).then((loaded) => {
      if (!live) return;
      // A fresh clone per show, so materials can follow the display mode without touching the cache.
      const shown = loaded.clone(true);
      shown.userData.camStock = checkpoint.after_move;
      setGroup(shown);
      invalidate();
      // Fetch the next checkpoint ahead of playback.
      const next = checkpoints[index + 1];
      if (next) void displayGlb(player.job.id, next.mesh, next.display.scale_to_mm).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, [index, checkpoints, player.job.id, invalidate]);
  useEffect(() => {
    group?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const uncertain = object.name.includes('uncertain') || object.parent?.name.includes('uncertain') || (object.material as THREE.Material).name?.includes('uncertain');
      object.material = uncertain ? stockMaterials.uncertain : mode === 'solid' ? stockMaterials.definite : stockMaterials.translucent;
      object.renderOrder = uncertain ? 9 : mode === 'solid' ? 1 : 8;
    });
    invalidate();
  }, [group, mode, invalidate]);
  return group ? <primitive object={group} /> : null;
}

function Fixtures({ player, focusFixture }: { player: Player; focusFixture: string | null }) {
  const invalidate = useThree((state) => state.invalidate);
  const [groups, setGroups] = useState<{ fixture: FixtureDisplay; group: THREE.Group }[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(player.fixtures.map(async (fixture) => ({
      fixture, group: (await displayGlb(player.job.id, { name: fixture.display_name, bytes: player.job.output?.files.find((file) => file.name === fixture.display_name)?.artifact.bytes ?? 0, sha256: fixture.display_sha256 }, fixture.display.scale_to_mm)).clone(true),
    }))).then((value) => { if (live) { setGroups(value); invalidate(); } }).catch(() => {});
    return () => { live = false; };
  }, [player, invalidate]);
  useEffect(() => {
    for (const { fixture, group } of groups) {
      const hit = focusFixture === fixture.collision.id;
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) object.material = new THREE.MeshStandardMaterial({ color: hit ? '#ef4444' : FIXTURE_COLOR, metalness: 0.45, roughness: 0.5, transparent: true, opacity: hit ? 0.9 : 0.78, emissive: hit ? '#7f1d1d' : '#000000' });
      });
      group.userData.camFixture = fixture.collision.id;
    }
    invalidate();
  }, [groups, focusFixture, invalidate]);
  return <>{groups.map(({ fixture, group }) => <primitive key={fixture.id} object={group} />)}</>;
}

// ── Tool ─────────────────────────────────────────────────────────────────

const ROLE: Record<string, ViewShell['role']> = { cutter: 'cutter', shank: 'shank', holder: 'holder' };

/** The assembled tool in its tip frame: placed part meshes, parametric components from their profiles. */
function Tool({ snapshot, motion, focusRegion }: { snapshot: AssemblySnapshot; motion: Motion | null; focusRegion: string | null }) {
  const invalidate = useThree((state) => state.invalidate);
  const geometry = snapshot.geometry;
  const [meshes, setMeshes] = useState<ViewMesh[]>([]);
  const parts = useMemo(() => geometry.placements.filter((placement) => placement.part && placement.geometry), [geometry]);
  useEffect(() => {
    let live = true;
    void Promise.all(parts.map(async (placement) => {
      const part = placement.part!;
      const loaded = await displayGeometry(placement.geometry!.job_id, part.display);
      const cutting = part.regions.find((region) => region.role === 'cutter');
      return { key: placement.id, geometry: loaded, matrix: frameMatrix(placement.frame), cutting: cutting ? [cutting.z_min_mm, cutting.z_max_mm] as [number, number] : null, role: placement.id === 'cutter' ? 'cutter' as const : 'holder' as const };
    })).then((value) => { if (live) { setMeshes(value); invalidate(); } }).catch(() => {});
    return () => { live = false; };
  }, [parts, invalidate]);
  const solids = useMemo(() => {
    const meshBacked = new Set(parts.map((placement) => placement.id));
    return geometry.regions.filter((region) => !meshBacked.has(region.component)).map((region) => ({ key: `solid:${region.id}`, points: regionPoints(region.segment), role: ROLE[region.role], solid: true }) as ViewShell);
  }, [geometry, parts]);
  const highlight = useMemo(() => {
    const region = geometry.regions.find((item) => item.id === focusRegion);
    if (!region) return null;
    const points = regionPoints(region.segment).map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4) + 0.15, z));
    const lathe = new THREE.LatheGeometry(points, 48);
    lathe.rotateX(Math.PI / 2);
    return lathe;
  }, [geometry, focusRegion]);
  useEffect(() => () => highlight?.dispose(), [highlight]);

  const holder = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const tip = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  useEffect(() => {
    const place = (position: number) => {
      if (!holder.current || !motion) return;
      tipAt(motion, position, tip);
      holder.current.position.set(tip[0], tip[1], tip[2]);
      invalidate();
    };
    place(usePlayer.getState().position);
    return usePlayer.subscribe((state) => place(state.position));
  }, [motion, tip, invalidate]);
  // Display spin while playing (a visual rate, not the programmed RPM).
  useFrame((_, delta) => {
    const playing = usePlayer.getState().playing;
    if (spinner.current && playing) { spinner.current.rotation.z = (spinner.current.rotation.z - Math.min(delta, 0.1) * Math.PI * 4) % (Math.PI * 2); invalidate(); }
  });
  return (
    <group ref={holder} userData={{ camTool: snapshot.snapshot_sha256 }}>
      <group ref={spinner}>
        {meshes.map((view) => <PartMesh key={view.key} view={view} />)}
        {solids.map((shell) => <Shell key={shell.key} shell={shell} />)}
      </group>
      {highlight && (
        <mesh geometry={highlight} renderOrder={30} userData={{ camRegion: focusRegion }}>
          <meshBasicMaterial color="#ef4444" transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/** The tool in the spindle at the playback position: a combined program swaps assemblies at each tool change. */
function PlayerTool({ player, focusRegion }: { player: Player; focusRegion: string | null }) {
  const [number, setNumber] = useState(() => toolAt(player, usePlayer.getState().position));
  useEffect(() => usePlayer.subscribe((state) => { const next = toolAt(player, state.position); setNumber((current) => (current === next ? current : next)); }), [player]);
  const snapshot = (number !== null ? player.tools[number] : null) ?? player.tool;
  if (!snapshot || !player.motion) return null;
  return <group userData={{ camToolNumber: number }}><Tool key={snapshot.snapshot_sha256} snapshot={snapshot} motion={player.motion} focusRegion={focusRegion} /></group>;
}

/** A drilling result's hole, shown when its row is clicked: the wall from the top down to the deepest tip (work frame). */
function HoleMarker({ mark }: { mark: HoleMark }) {
  const geometry = useMemo(() => {
    const height = Math.max(0.1, mark.top - mark.bottom);
    const cylinder = new THREE.CylinderGeometry(mark.radius, mark.radius, height, 40, 1, true);
    cylinder.rotateX(Math.PI / 2);
    cylinder.translate(mark.center[0], mark.center[1], (mark.top + mark.bottom) / 2);
    return { cylinder, edges: new THREE.EdgesGeometry(cylinder, 30) };
  }, [mark]);
  useEffect(() => () => { geometry.cylinder.dispose(); geometry.edges.dispose(); }, [geometry]);
  const ring = (z: number) => Array.from({ length: 41 }, (_, i) => [mark.center[0] + mark.radius * Math.cos((i / 40) * Math.PI * 2), mark.center[1] + mark.radius * Math.sin((i / 40) * Math.PI * 2), z] as [number, number, number]);
  return (
    <group userData={{ camHole: mark.id }}>
      <mesh geometry={geometry.cylinder} renderOrder={28}>
        <meshBasicMaterial color="#22c55e" transparent opacity={0.22} depthWrite={false} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={ring(mark.top)} color="#22c55e" lineWidth={2} depthTest={false} renderOrder={29} />
      <Line points={ring(mark.bottom)} color="#16a34a" lineWidth={2} depthTest={false} renderOrder={29} dashed dashSize={0.8} gapSize={0.5} />
    </group>
  );
}

/** A contour result's chain, shown when its row is clicked: at its plane (solid) and down at the floor (dashed). */
function ContourMarker({ mark }: { mark: ContourMark }) {
  const at = (z: number) => {
    const points = mark.points.map(([x, y]) => [x, y, z] as [number, number, number]);
    return mark.closed && points.length ? [...points, points[0]] : points;
  };
  return (
    <group userData={{ camContour: mark.id }}>
      <Line points={at(mark.z)} color="#22c55e" lineWidth={2.5} depthTest={false} renderOrder={29} />
      {mark.floor !== null && Math.abs(mark.floor - mark.z) > 1e-6 && <Line points={at(mark.floor)} color="#16a34a" lineWidth={1.5} depthTest={false} renderOrder={29} dashed dashSize={0.8} gapSize={0.5} />}
    </group>
  );
}

/** A slot (result or guide): its centreline and both walls (offset by half the width) at a height, round at the ends. */
function SlotOutline({ points, width, z, color, dashed, id }: { points: [number, number][]; width: number; z: number; color: string; dashed?: boolean; id?: string }) {
  if (points.length < 2) return null;
  const lift = (line: XY[]) => line.map(([x, y]) => [x, y, z] as [number, number, number]);
  const half = width / 2;
  const left = offsetPath(points as XY[], false, 'left', half);
  const right = offsetPath(points as XY[], false, 'right', half);
  const cap = (center: XY, from: XY, to: XY): XY[] => {
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    let a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
    if (a1 < a0) a1 += Math.PI * 2;
    return Array.from({ length: 13 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / 12; return [center[0] + half * Math.cos(a), center[1] + half * Math.sin(a)] as XY; });
  };
  const n = points.length;
  return (
    <group userData={{ camSlot: id ?? true }}>
      <Line points={lift(points as XY[])} color={color} lineWidth={2} depthTest={false} renderOrder={28} dashed={dashed} dashSize={1} gapSize={0.6} />
      {left && <Line points={lift(left)} color={color} lineWidth={1.5} depthTest={false} renderOrder={28} />}
      {right && <Line points={lift(right)} color={color} lineWidth={1.5} depthTest={false} renderOrder={28} />}
      {left && right && <Line points={lift(cap(points[n - 1] as XY, left[left.length - 1], right[right.length - 1]))} color={color} lineWidth={1.5} depthTest={false} renderOrder={28} />}
      {left && right && <Line points={lift(cap(points[0] as XY, right[0], left[0]))} color={color} lineWidth={1.5} depthTest={false} renderOrder={28} />}
    </group>
  );
}

/** A 3D finishing path (a result): its approved tool-tip points, lit over the model. */
function SurfaceMarker({ mark }: { mark: SurfaceMark }) {
  const points = mark.closed && mark.points.length ? [...mark.points, mark.points[0]] : mark.points;
  if (points.length < 2) return null;
  return <group userData={{ camSurface: mark.id }}><Line points={points} color="#22c55e" lineWidth={2.5} depthTest={false} renderOrder={29} /></group>;
}

/**
 * While editing 3D finishing: parallel's boundary (the rectangle, or the part's outline bounds) at the top height with
 * arrows for the row direction (alternating for zigzag); waterline's levels as the part's outline bounds at each
 * height. Display only: the engine plans the actual paths on the part.
 */
function SurfacePreview() {
  const op = useCam((state) => state.editor?.draft.op);
  const version = useGeometryVersion();
  const bounds = useMemo(() => (op?.target ? bodyBounds(op.target) : null), [op?.target, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!op || (op.kind !== 'parallel' && op.kind !== 'waterline') || !bounds) return null;
  const rect = op.kind === 'parallel' && op.surfaceBounds ? op.surfaceBounds : [bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y];
  const [x0, y0, x1, y1] = rect;
  if (!(x0 < x1 && y0 < y1)) return null;
  const outline = (z: number): [number, number, number][] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, z]];
  if (op.kind === 'waterline') {
    const step = Math.max(op.stepdown, 1e-3);
    const count = Math.min(200, Math.ceil(Math.max(0, op.top - op.bottom) / step));
    const every = Math.max(1, Math.ceil(count / 24));  // Many levels are drawn sparsely.
    const levels = Array.from({ length: count }, (_, i) => Math.max(op.bottom, op.top - step * (i + 1))).filter((_, i, all) => i % every === 0 || i === all.length - 1);
    return (
      <group userData={{ camSurfacePreview: 'waterline', levels: count }}>
        {levels.map((z) => <Line key={z} points={outline(z)} color="#2dd4bf" lineWidth={1} transparent opacity={0.6} dashed dashSize={1} gapSize={0.6} depthTest={false} renderOrder={26} />)}
      </group>
    );
  }
  // Parallel: a few arrows across the boundary along the rows' axis, every other one reversed for zigzag.
  const alongX = op.surfaceAxis === 'x';
  const span = alongX ? y1 - y0 : x1 - x0;
  const arrows = Math.max(2, Math.min(6, Math.round(span / Math.max(op.stepover * 8, 2))));
  const z = op.top;
  const arrowsAt = Array.from({ length: arrows }, (_, i) => (alongX ? y0 : x0) + (span * (i + 0.5)) / arrows);
  return (
    <group userData={{ camSurfacePreview: 'parallel' }}>
      <Line points={outline(z)} color="#2dd4bf" lineWidth={1.5} dashed dashSize={1.2} gapSize={0.6} depthTest={false} renderOrder={26} />
      {arrowsAt.map((at, i) => {
        const reverse = op.surfacePassMode === 'zigzag' && i % 2 === 1;
        const [a, b] = alongX ? [[x0, at], [x1, at]] : [[at, y0], [at, y1]];
        const [from, to] = reverse ? [b, a] : [a, b];
        const head = alongX ? [[to[0] - (reverse ? -1 : 1) * Math.min(2, (x1 - x0) / 6), to[1] + 1], to, [to[0] - (reverse ? -1 : 1) * Math.min(2, (x1 - x0) / 6), to[1] - 1]]
          : [[to[0] + 1, to[1] - (reverse ? -1 : 1) * Math.min(2, (y1 - y0) / 6)], to, [to[0] - 1, to[1] - (reverse ? -1 : 1) * Math.min(2, (y1 - y0) / 6)]];
        return (
          <group key={at}>
            <Line points={[[from[0], from[1], z], [to[0], to[1], z]]} color="#2dd4bf" lineWidth={1.2} transparent opacity={0.8} depthTest={false} renderOrder={26} />
            <Line points={head.map(([x, y]) => [x, y, z] as [number, number, number])} color="#2dd4bf" lineWidth={1.2} depthTest={false} renderOrder={26} />
          </group>
        );
      })}
    </group>
  );
}

/** Polylines (work mm) as one set of line segments; `closed` joins each back to its start. */
function polylineGeometry(lines: number[][][], closed: boolean) {
  const positions: number[] = [];
  for (const line of lines) {
    const points = closed && line.length > 2 ? [...line, line[0]] : line;
    for (let i = 1; i < points.length; i++) positions.push(...points[i - 1], ...points[i]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

const ENGINE_PREVIEW_COLOR = '#a78bfa';

/**
 * The engine's preview of the saved slot or finishing operation (its slot floors, rows with proposed contact, or
 * waterline loops), in violet over the draft's own sketch of it. Proposals, not verified paths.
 */
function EnginePreview() {
  const preview = usePreview((state) => state.preview);
  const editing = useCam((state) => state.editor?.draft.op.id);
  const result = preview?.status === 'ready' && preview.operation === editing ? preview.result : null;
  const geometry = useMemo(() => {
    if (!result) return null;
    const rows = { touching: result.rows.filter((row) => row.has_proposed_contact).map((row) => row.points_mm), air: result.rows.filter((row) => !row.has_proposed_contact).map((row) => row.points_mm) };
    return {
      touching: rows.touching.length ? polylineGeometry(rows.touching, false) : null, air: rows.air.length ? polylineGeometry(rows.air, false) : null,
      loops: result.levels.length ? polylineGeometry(result.levels.flatMap((level) => level.loops), true) : null,
    };
  }, [result]);
  useEffect(() => () => { geometry?.touching?.dispose(); geometry?.air?.dispose(); geometry?.loops?.dispose(); }, [geometry]);
  if (!result || !geometry) return null;
  const z = Number(result.request.strategy.bottom_mm ?? 0);
  return (
    <group userData={{ camEnginePreview: result.representation, slots: result.slots.length, rows: result.rows.length, levels: result.levels.length }}>
      {result.slots.map((slot) => <SlotOutline key={slot.id} id={`preview-${slot.id}`} points={slot.points_mm} width={slot.width_mm} z={z} color={ENGINE_PREVIEW_COLOR} dashed />)}
      {geometry.touching && <lineSegments geometry={geometry.touching} renderOrder={27}><lineBasicMaterial color={ENGINE_PREVIEW_COLOR} transparent opacity={0.85} depthTest={false} /></lineSegments>}
      {geometry.air && <lineSegments geometry={geometry.air} renderOrder={27}><lineBasicMaterial color={ENGINE_PREVIEW_COLOR} transparent opacity={0.22} depthTest={false} /></lineSegments>}
      {geometry.loops && <lineSegments geometry={geometry.loops} renderOrder={27}><lineBasicMaterial color={ENGINE_PREVIEW_COLOR} transparent opacity={0.8} depthTest={false} /></lineSegments>}
    </group>
  );
}

/** While editing a slot with centrelines: each guide and its walls at the bottom height. Display only. */
function SlotGuidesPreview() {
  const op = useCam((state) => state.editor?.draft.op);
  if (!op || op.kind !== 'slot' || op.slotMode !== 'guides') return null;
  return <>{op.slotGuides.map((guide) => <SlotOutline key={guide.id} id={guide.id} points={guide.points} width={guide.width} z={op.bottom + op.axialAllowance} color="#f0a43a" dashed />)}</>;
}

/**
 * While editing an engraving: each path's centreline and the groove's edges at the surface (as wide as the V-bit cuts at
 * the depth), and, while picking sketch curves, every pickable curve (picked ones bright, the hovered one lit).
 */
function EngravePreview() {
  const op = useCam((state) => state.editor?.draft.op);
  const tooling = useCam((state) => state.tooling);
  const picking = useCam((state) => state.picking);
  const hover = useCam((state) => state.engraveHover);
  if (!op || op.kind !== 'engrave') return null;
  const cutter = cutterOf(tooling, op.assignment);
  const width = cutter?.pointAngleDeg ? engraveWidth({ diameter: cutter.diameter, tipDiameter: cutter.tipDiameter ?? 0, angle: (cutter.pointAngleDeg * Math.PI) / 180 }, op.top - op.bottom) : 0.05;
  const picked = new Set(op.engraveCurves.map((ref) => `${ref.sketch}.${ref.entity}`));
  const candidates = picking === 'engrave-curves' ? horizontalSketches(op.engraveChord).flatMap((sketch) => sketch.curves) : [];
  return (
    <group userData={{ camEngravePreview: op.engravePaths.length }}>
      {candidates.map((curve) => {
        const key = `${curve.sketch}.${curve.entity}`;
        const lit = hover?.sketch === curve.sketch && hover.entity === curve.entity;
        return <Line key={key} points={curve.points.map(([x, y]) => [x, y, curve.z] as [number, number, number])} color={lit ? '#ffffff' : picked.has(key) ? '#f0a43a' : '#8a93a6'}
          lineWidth={lit ? 3 : 1.5} depthTest={false} renderOrder={26} dashed={!picked.has(key) && !lit} dashSize={0.8} gapSize={0.5} userData={{ camEngraveCurve: key }} />;
      })}
      {op.engravePaths.map((path) => (
        <SlotOutline key={path.id} id={path.id} points={path.closed ? [...path.points, path.points[0]] : path.points} width={width} z={op.top} color="#f0a43a" />
      ))}
    </group>
  );
}

/** A tab result's bridge, shown when its row is clicked: its footprint from its bottom up to its top (work frame). */
function TabMarker({ mark }: { mark: TabMark }) {
  const ring = (z: number) => [...mark.corners, mark.corners[0]].map(([x, y]) => [x, y, z] as [number, number, number]);
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(mark.corners.map(([x, y]) => new THREE.Vector2(x, y)));
    const prism = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.05, mark.top - mark.bottom), bevelEnabled: false });
    prism.translate(0, 0, mark.bottom);
    return prism;
  }, [mark]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group userData={{ camTab: mark.id }}>
      <mesh geometry={geometry} renderOrder={28}>
        <meshBasicMaterial color="#a855f7" transparent opacity={0.35} depthWrite={false} depthTest={false} />
      </mesh>
      <Line points={ring(mark.top)} color="#a855f7" lineWidth={2} depthTest={false} renderOrder={29} />
      <Line points={ring(mark.bottom)} color="#7e22ce" lineWidth={1.5} depthTest={false} renderOrder={29} dashed dashSize={0.6} gapSize={0.4} />
    </group>
  );
}

/**
 * While editing a contour with tabs: each bridge at its place on the outline, `width` along the edge (its direction when
 * known), from the bottom (plus floor allowance) up by `height`. Display only: the engine finds the boundary itself.
 */
function TabsPreview() {
  const op = useCam((state) => state.editor?.draft.op);
  if (!op || op.kind !== 'contour' || !op.tabs.length) return null;
  const floor = op.bottom + op.axialAllowance;
  return (
    <group userData={{ camTabsPreview: op.tabs.length }}>
      {op.tabs.map((tab) => {
        const angle = tab.angle ?? 0;
        const depth = Math.max(0.6, tab.width * 0.5);
        return (
          <mesh key={tab.id} position={[tab.center[0], tab.center[1], floor + tab.height / 2]} rotation={[0, 0, angle]} renderOrder={27} userData={{ camTab: tab.id }}>
            <boxGeometry args={[tab.width, depth, tab.height]} />
            <meshBasicMaterial color="#a855f7" transparent opacity={0.55} depthTest={false} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * While editing an edge-chain contour: the chain in the direction the engine runs it (an arrow at its end, a dot at
 * its start) and, once a side is chosen, a dashed approximation of the cutter centre on that side. Display only.
 */
function ContourChainPreview() {
  const op = useCam((state) => state.editor?.draft.op);
  const tooling = useCam((state) => state.tooling);
  const chain = op && followsOutline(op.kind) ? contourChain(op) : null;
  if (!op || !chain || typeof chain === 'string' || chain.points.length < 2) return null;
  const cutter = cutterOf(tooling, op.assignment);
  const z = chain.z;
  const lift = (points: XY[], closed: boolean) => {
    const out = points.map(([x, y]) => [x, y, z] as [number, number, number]);
    return closed ? [...out, out[0]] : out;
  };
  // The arrow at the end of the walk (for a closed loop, along its first segment, from the start dot).
  const n = chain.points.length;
  const [tipA, tipB] = chain.closed ? [chain.points[0], chain.points[1]] : [chain.points[n - 2], chain.points[n - 1]];
  const length = Math.hypot(tipB[0] - tipA[0], tipB[1] - tipA[1]) || 1;
  const ux = (tipB[0] - tipA[0]) / length, uy = (tipB[1] - tipA[1]) / length;
  const size = Math.max(1.2, Math.min(4, length * 0.35));
  const head: XY = chain.closed ? [tipA[0] + ux * Math.min(length * 0.6, size * 2.5), tipA[1] + uy * Math.min(length * 0.6, size * 2.5)] : tipB;
  const wing = (sign: number): [number, number, number] => [head[0] - ux * size - uy * size * 0.55 * sign, head[1] - uy * size + ux * size * 0.55 * sign, z];
  const side = op.side === 'left' || op.side === 'right' ? op.side : null;
  // A contour's cutter centre is a radius (plus allowance) off the edge; a chamfer's tip runs its tip radius plus the
  // flank's slope times the tip offset outside the lower edge (drawn at the selected edge's plane).
  const distance = !cutter ? null : op.kind === 'chamfer'
    ? chamferOffset(op.chamferTipOffset, { diameter: cutter.diameter, tipDiameter: cutter.tipDiameter ?? 0, angle: ((cutter.pointAngleDeg ?? 90) * Math.PI) / 180 })
    : cutter.diameter / 2 + op.radialAllowance;
  const offset = side && distance !== null && distance > 0 ? offsetPath(chain.points, chain.closed, side, distance) : null;
  return (
    <group userData={{ camChain: chain.order.join(','), camChainClosed: chain.closed, camChainSide: side }}>
      <Line points={lift(chain.points, chain.closed)} color="#f0a43a" lineWidth={3} depthTest={false} renderOrder={27} />
      <Line points={[wing(1), [head[0], head[1], z], wing(-1)]} color="#f0a43a" lineWidth={3} depthTest={false} renderOrder={27} />
      <mesh position={[chain.points[0][0], chain.points[0][1], z]} renderOrder={27}>
        <sphereGeometry args={[Math.max(0.4, size * 0.25), 16, 12]} />
        <meshBasicMaterial color="#f0a43a" depthTest={false} />
      </mesh>
      {offset && <Line points={lift(offset, chain.closed)} color="#3b9eff" lineWidth={1.5} dashed dashSize={1} gapSize={0.6} depthTest={false} renderOrder={27} />}
    </group>
  );
}

/** Segment pairs (a face outline) as one draw, solid or dashed. */
function SegmentLines({ points, color, dashed }: { points: [number, number, number][]; color: string; dashed: boolean }) {
  const geometry = useMemo(() => {
    const out = new THREE.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    return out;
  }, [points]);
  const ref = useRef<THREE.LineSegments>(null);
  useEffect(() => { if (dashed) ref.current?.computeLineDistances(); }, [dashed, geometry]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments ref={ref} geometry={geometry} renderOrder={27}>
      {dashed ? <lineDashedMaterial color={color} dashSize={0.8} gapSize={0.6} depthTest={false} /> : <lineBasicMaterial color={color} depthTest={false} />}
    </lineSegments>
  );
}

const circlePoints = (center: [number, number], radius: number, z: number): [number, number, number][] =>
  Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), z]; });

/**
 * While editing a patterned operation: the seed selection moved to every instance the pattern makes (the seed in
 * orange, other instances teal, left-out ones dashed grey), each with its name; clicking a name leaves the instance out
 * or brings it back. Drawing only: the engine finds each instance's feature on the actual part.
 */
function PatternPreview() {
  const op = useCam((state) => state.editor?.draft.op);
  const version = useGeometryVersion();
  const seed = useMemo(() => (op?.pattern ? patternSeed(op) : null),
    [op?.pattern ? 1 : 0, op?.floor, op?.holes, op?.contourFaces, op?.contourEdges, op?.engravePaths, op?.slotGuides, op?.contourMode, op?.top, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!op?.pattern || !seed) return null;
  const pattern = op.pattern;
  const instances = instancesOf(pattern);
  const zs = [...seed.segments.map((p) => p[2]), ...seed.lines.flat().map((p) => p[2]), ...seed.circles.map((c) => c.z)];
  const labelZ = (zs.length ? Math.max(...zs) : op.top) + 1;
  const toggle = (key: string) => updateDraft((d) => {
    const current = d.op.pattern;
    if (!current) return d;
    const suppress = current.suppress.includes(key) ? current.suppress.filter((item) => item !== key) : [...current.suppress, key];
    return { ...d, op: { ...d.op, pattern: { ...current, suppress } } };
  }, ['pattern']);
  return (
    <group userData={{ camPattern: instances.length }}>
      {instances.map((instance, index) => {
        const off = pattern.suppress.includes(instance.key);
        const color = off ? '#8a93a6' : index === 0 ? '#f0a43a' : '#36cfc9';
        const move = (p: [number, number, number]): [number, number, number] => { const [x, y] = placePoint(instance, [p[0], p[1]]); return [x, y, p[2]]; };
        const label = seed.anchor ? placePoint(instance, seed.anchor) : null;
        return (
          <group key={instance.key} userData={{ camPatternInstance: instance.key, camPatternOff: off }}>
            {seed.segments.length > 0 && <SegmentLines points={seed.segments.map(move)} color={color} dashed={off} />}
            {seed.lines.map((line, i) => <Line key={`l${i}`} points={line.map(move)} color={color} lineWidth={2} dashed={off} dashSize={0.8} gapSize={0.6} depthTest={false} renderOrder={27} />)}
            {seed.circles.map((circle, i) => <Line key={`c${i}`} points={circlePoints(circle.center, circle.radius, circle.z).map(move)} color={color} lineWidth={2} dashed={off} dashSize={0.8} gapSize={0.6} depthTest={false} renderOrder={27} />)}
            {label && (
              <Html position={[label[0], label[1], labelZ]} center zIndexRange={[20, 0]}>
                <button type="button" className={styles.instanceLabel} data-off={off || undefined} data-seed={index === 0 || undefined} data-pattern-label={instance.key}
                  title={off ? `${instance.key} is left out: click to include it` : `Click to leave ${instance.key} out`} onClick={() => toggle(instance.key)}>{instance.key}</button>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ── Events ───────────────────────────────────────────────────────────────

function EventMarks({ player, focus }: { player: Player; focus: number | null }) {
  const geometry = useMemo(() => {
    const positions: number[] = [], colors: number[] = [];
    const color = new THREE.Color();
    // Failed events are marked where they happen; uncertain contacts (often hundreds, from conservative envelopes)
    // stay on the timeline and in the list, and the focused one is marked below.
    for (const event of player.events) {
      if (!event.pose || event.severity !== 'failed') continue;
      positions.push(...event.pose.origin_mm);
      color.set(SEVERITY_COLORS[event.severity]);
      colors.push(color.r, color.g, color.b);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return out;
  }, [player.events]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const focused = focus !== null ? player.events[focus] : null;
  return (
    <>
      <points geometry={geometry} renderOrder={25} userData={{ camEvents: geometry.getAttribute('position').count }}>
        <pointsMaterial vertexColors size={5} sizeAttenuation={false} transparent opacity={0.75} depthTest={false} />
      </points>
      {focused?.pose && (
        <mesh position={focused.pose.origin_mm as [number, number, number]} renderOrder={31} userData={{ camFocus: focus }}>
          <sphereGeometry args={[0.9, 20, 14]} />
          <meshBasicMaterial color={SEVERITY_COLORS[focused.severity]} transparent opacity={0.85} depthTest={false} />
        </mesh>
      )}
    </>
  );
}

// ── Finished-stock inspection ──────────────────────────────────────────────

/** Excess material (left beyond the outer band) and missing material (cut past the inner band); the legend uses the same. */
export const INSPECTION_COLORS = { excess: '#f59e0b', missing: '#ef4444' } as const;

/** One kind's regions as boxes: translucent faces and their edges (failed solid, uncertain fainter). */
function boxesOf(regions: InspectionRegion[]) {
  const faces: number[] = [], edges: number[] = [];
  const corner = (min: number[], max: number[], i: number) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const QUADS = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const region of regions) {
    const { minimum_mm: min, maximum_mm: max } = region.bounds;
    const p = Array.from({ length: 8 }, (_, i) => corner(min, max, i));
    for (const [a, b, c, d] of QUADS) faces.push(...p[a], ...p[b], ...p[c], ...p[a], ...p[c], ...p[d]);
    for (const [a, b] of EDGES) edges.push(...p[a], ...p[b]);
  }
  const face = new THREE.BufferGeometry(), edge = new THREE.BufferGeometry();
  face.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
  edge.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  return { face, edge };
}

/**
 * The finished stock compared with the expected design bodies: excess (amber) and missing (red) regions, failed ones
 * strong and uncertain ones faint, each failed region's witness marked. Drawn over the stock; the verdicts are the
 * backend's boxes, not a mesh comparison made here.
 */
function InspectionOverlay({ inspection, focus, size }: { inspection: StockInspection; focus: number | null; size: number }) {
  const layers = useMemo(() => (['excess', 'missing'] as const).flatMap((kind) => (['failed', 'uncertain'] as const).map((status) => {
    const regions = inspection.regions.filter((region) => region.kind === kind && region.status === status);
    return regions.length ? { key: `${kind}-${status}`, kind, status, count: regions.length, ...boxesOf(regions) } : null;
  }).filter((layer): layer is NonNullable<typeof layer> => !!layer)), [inspection]);
  useEffect(() => () => { for (const layer of layers) { layer.face.dispose(); layer.edge.dispose(); } }, [layers]);
  const focused = focus !== null ? inspection.regions[focus] : null;
  const focusBox = useMemo(() => (focused ? boxesOf([focused]) : null), [focused]);
  useEffect(() => () => { focusBox?.face.dispose(); focusBox?.edge.dispose(); }, [focusBox]);
  return (
    <group userData={{ camInspection: inspection.regions.length }}>
      {layers.map((layer) => (
        <group key={layer.key} userData={{ camInspectionLayer: layer.key, count: layer.count }}>
          <mesh geometry={layer.face} renderOrder={27}>
            <meshBasicMaterial color={INSPECTION_COLORS[layer.kind]} transparent opacity={layer.status === 'failed' ? 0.38 : 0.12} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          <lineSegments geometry={layer.edge} renderOrder={28}>
            <lineBasicMaterial color={INSPECTION_COLORS[layer.kind]} transparent opacity={layer.status === 'failed' ? 0.95 : 0.4} />
          </lineSegments>
        </group>
      ))}
      {focusBox && focused && (
        <group userData={{ camInspectionFocus: focus }}>
          <lineSegments geometry={focusBox.edge} renderOrder={41}>
            <lineBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.95} />
          </lineSegments>
          {focused.witness_mm && <WitnessMarker at={focused.witness_mm} size={size} />}
        </group>
      )}
    </group>
  );
}

/** Work coordinate triad at program zero (the design origin). */
function WorkTriad({ size }: { size: number }) {
  return (
    <group userData={{ camWcs: true }}>
      <Line points={[[0, 0, 0], [size, 0, 0]]} color="#ef4444" lineWidth={2} depthTest={false} renderOrder={26} />
      <Line points={[[0, 0, 0], [0, size, 0]]} color="#22c55e" lineWidth={2} depthTest={false} renderOrder={26} />
      <Line points={[[0, 0, 0], [0, 0, size]]} color="#3b82f6" lineWidth={2} depthTest={false} renderOrder={26} />
    </group>
  );
}

/** While the editor is open: the stock box it describes and program zero, in the design (work) frame. */
function EditorPreview() {
  const stockMin = useCam((state) => state.editor?.draft.setup.stockMin);
  const stockMax = useCam((state) => state.editor?.draft.setup.stockMax);
  const floor = useCam((state) => state.editor?.draft.op);
  const stock = stockMin && stockMax ? [stockMin, stockMax] as const : null;
  const geometry = useMemo(() => {
    if (!stock) return null;
    const [min, max] = stock;
    const box = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    box.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return { edges: new THREE.EdgesGeometry(box), box };
  }, [stock?.[0].join(','), stock?.[1].join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { geometry?.edges.dispose(); geometry?.box.dispose(); }, [geometry]);
  if (!stock || !geometry) return null;
  const size = Math.max(6, Math.min(25, (stock[1][0] - stock[0][0]) * 0.25));
  const span = [stock[1][0] - stock[0][0], stock[1][1] - stock[0][1]];
  return (
    <group userData={{ camEditorPreview: true }}>
      <lineSegments geometry={geometry.edges} renderOrder={20}>
        <lineBasicMaterial color="#f0a43a" transparent opacity={0.9} depthTest={false} />
      </lineSegments>
      <mesh geometry={geometry.box} renderOrder={19}>
        <meshBasicMaterial color="#f0a43a" transparent opacity={0.06} depthWrite={false} />
      </mesh>
      {floor && <>
        {/* Clearance and bottom planes over the stock outline. */}
        {[{ z: floor.clearance, color: '#38bdf8' }, { z: floor.bottom, color: '#22c55e' }].map((plane) => (
          <Line key={plane.color} points={[[stock[0][0], stock[0][1], plane.z], [stock[0][0] + span[0], stock[0][1], plane.z], [stock[0][0] + span[0], stock[0][1] + span[1], plane.z], [stock[0][0], stock[0][1] + span[1], plane.z], [stock[0][0], stock[0][1], plane.z]]}
            color={plane.color} lineWidth={1} dashed dashSize={1.5} gapSize={1} transparent opacity={0.7} depthTest={false} renderOrder={21} />
        ))}
      </>}
      <WorkTriad size={size} />
      <ContourChainPreview />
      <TabsPreview />
      <SlotGuidesPreview />
      <EngravePreview />
      <SurfacePreview />
      <EnginePreview />
      <PatternPreview />
    </group>
  );
}

export default function CamLayer() {
  const player = usePlayer((state) => state.player);
  const show = usePlayer((state) => state.show);
  const focus = usePlayer((state) => state.focus);
  const inspectionFocus = usePlayer((state) => state.inspectionFocus);
  const highlight = useCam((state) => state.highlight);
  const contour = useCam((state) => state.contourHighlight);
  const tab = useCam((state) => state.tabHighlight);
  const slot = useCam((state) => state.slotHighlight);
  const surface = useCam((state) => state.surfaceHighlight);
  // The selected operation's path while nothing plays and no editor is open (the editor draws its own previews).
  const editing = useCam((state) => !!state.editor);
  const selected = useToolpath();
  const path = editing ? { jobId: null, motion: null, origin: null } : selected;
  const invalidate = useThree((state) => state.invalidate);
  const origin = player?.origin;
  // The design under the stock: hidden on request while the player shows.
  useEffect(() => {
    const root = viewer.model?.root;
    if (!root || !player) return;
    root.visible = show.part;
    invalidate();
    return () => { root.visible = true; invalidate(); };
  }, [player, show.part, invalidate]);
  if (!player || !origin) return <>{path.motion && path.origin && <group position={[-path.origin[0], -path.origin[1], -path.origin[2]]} userData={{ camSelectedToolpath: path.jobId }}><Toolpath motion={path.motion} full /></group>}{highlight && <HoleMarker mark={highlight} />}{contour && <ContourMarker mark={contour} />}{tab && <TabMarker mark={tab} />}{slot && <SlotOutline id={slot.id} points={slot.points} width={slot.width} z={slot.z} color="#22c55e" />}{surface && <SurfaceMarker mark={surface} />}<EditorPreview /></>;
  const event = focus !== null ? player.events[focus] : null;
  const size = player.preview?.stock_checkpoints[0] ? Math.max(6, Math.min(25, (player.setup!.initial_stock_bounds.maximum_mm[0] - player.setup!.initial_stock_bounds.minimum_mm[0]) * 0.25)) : 10;
  return (
    <group userData={{ camPlayer: player.job.id }}>
      <WorkTriad size={size} />
      {highlight && <HoleMarker mark={highlight} />}
      {contour && <ContourMarker mark={contour} />}
      {tab && <TabMarker mark={tab} />}
      {slot && <SlotOutline id={slot.id} points={slot.points} width={slot.width} z={slot.z} color="#22c55e" />}
      {surface && <SurfaceMarker mark={surface} />}
      {/* An operation or setup being edited shows its stock, heights and previews over the player too. */}
      {editing && <EditorPreview />}
      <group position={[-origin[0], -origin[1], -origin[2]]}>
        {player.motion && show.toolpath && <Toolpath motion={player.motion} />}
        {show.stock !== 'off' && player.preview && <Stock player={player} mode={show.stock} />}
        {show.fixtures && player.fixtures.length > 0 && <Fixtures player={player} focusFixture={event?.fixture ?? null} />}
        {show.tool && player.motion && <PlayerTool player={player} focusRegion={event?.region ?? null} />}
        {player.events.length > 0 && <EventMarks player={player} focus={focus} />}
        {event?.witness_mm && <WitnessMarker at={event.witness_mm} size={size} />}
        {player.inspection && show.inspection && <InspectionOverlay inspection={player.inspection} focus={inspectionFocus} size={size} />}
      </group>
    </group>
  );
}
