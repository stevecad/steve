import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { get, useApp, type Study } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { sectionPlane } from '@/viewport/SectionLayer';
import type { ModelRuntime } from '@/viewport/model';
import { simulationApi, terminal, visibleFields, type ResultManifest, type Run } from './api';
import { AMBER, FAIL, GREEN, INSIDE, MESH, NEUTRAL, paletteTexture, vertexColors, type Palette, type ScaleKind } from './colormap';
import { legendModel } from './legend';
import { startRecording, type Recording } from './record';
import { amplitude, animationKind, report, resultField, SAFETY_CAP, staleness, useSimulation, yieldOf, type ProbeReading } from './state';
import { useTreeMemory } from '@/state/treeOpen';
import { OVERVIEW_LIMIT, hiddenKey, scaleTitle, useOverview, type OverviewEntry, type OverviewScale } from './StudiesOverview';
import { show } from './units';
import sim from './Simulate.module.css';
import { selectedWorkspace } from '@/teams/current';

interface Decoded {
  positions: Float32Array; triangles: Uint32Array; values: Float32Array; displacement: Float32Array | null; min: number; max: number;
  /** Tetrahedra of solid results, `cellNodes` (4, or 10 with mid-side nodes) per element: the section cut slices these. */
  cells: Uint32Array | null; cellNodes: number;
  minIndex: number; maxIndex: number; minOnSurface: boolean; maxOnSurface: boolean;
}

// A section cuts the material: the plane tests each point's undeformed position (aBase), so the cut face
// moves with the deformed part instead of slicing the exaggerated shape where it happens to sit.
const vertexShader = /* glsl */ `
  attribute float aValue;
  attribute vec3 aBase;
  varying float vValue;
  varying vec3 vViewNormal;
  varying vec3 vBase;
  void main() {
    vValue = aValue;
    vBase = aBase;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Display colours come from the palette lookup (colormap, or the safety scale), not the vertex colours: those keep
// the classic full-range ramp for acceptance checks whatever the view shows.
const fragmentShader = /* glsl */ `
  uniform bool uClipOn;
  uniform vec4 uClip;
  uniform int uKind;        // 0 field, 1 safety factor, 2 mesh, 3 element edges
  uniform sampler2D uLut;
  uniform bool uBanded;
  uniform float uBands;
  uniform float uMin;
  uniform float uMax;
  uniform bool uOutOn;
  uniform vec3 uOut;
  uniform float uCap;
  uniform int uSafety;      // 0 gradient, 1 traffic light, 2 below target
  uniform float uT1;
  uniform float uT2;
  uniform float uTarget;
  uniform float uTargetMin;
  uniform vec3 uFail;
  uniform vec3 uAmber;
  uniform vec3 uGreen;
  uniform vec3 uFlat;
  uniform vec3 uEdge;
  uniform float uAlpha;
  uniform vec3 uInside;
  uniform bool uShowInside;
  varying float vValue;
  varying vec3 vViewNormal;
  varying vec3 vBase;
  vec3 lut(float t) {
    float level = uBanded ? (min(floor(t * uBands), uBands - 1.0) + 0.5) / uBands : t;
    return texture2D(uLut, vec2(level, 0.5)).rgb;
  }
  void main() {
    if (uClipOn && dot(uClip.xyz, vBase) + uClip.w < 0.0) discard;
    vec3 base;
    float alpha = 1.0;
    if (uKind == 3) { base = uEdge; alpha = uAlpha; }
    else if (uKind == 2) base = uFlat;
    else if (uKind == 1) {
      if (uSafety == 1) base = vValue < uT1 ? uFail : (vValue < uT2 ? uAmber : uGreen);
      else if (uSafety == 2) base = vValue >= uTarget ? uOut : lut(clamp((vValue - uTargetMin) / max(uTarget - uTargetMin, 1e-6), 0.0, 0.999));
      else base = vValue < 1.0 ? uFail : lut(clamp((vValue - 1.0) / max(uCap - 1.0, 1e-6), 0.0, 1.0));
    } else {
      float span = uMax - uMin;
      float slack = 1e-6 * max(abs(uMax), abs(uMin));
      if (uOutOn && (vValue > uMax + slack || vValue < uMin - slack)) base = uOut;
      else base = lut(span > 0.0 ? clamp((vValue - uMin) / span, 0.0, 1.0) : 0.5);
    }
    // A cut without interior values shows the shell's inside in neutral grey, never as field colours.
    if (uShowInside && !gl_FrontFacing && uKind != 3) base = uInside;
    float light = uKind == 3 ? 1.0 : 0.8 + 0.2 * abs(normalize(vViewNormal).z);
    gl_FragColor = vec4(base * light, alpha);
    #include <colorspace_fragment>
  }
`;

function contourMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader, vertexColors: true, side: THREE.DoubleSide,
    uniforms: {
      uClipOn: { value: false }, uClip: { value: new THREE.Vector4() },
      uKind: { value: 0 }, uLut: { value: null }, uBanded: { value: true }, uBands: { value: 10 }, uMin: { value: 0 }, uMax: { value: 1 },
      uOutOn: { value: false }, uOut: { value: NEUTRAL.clone() }, uCap: { value: SAFETY_CAP },
      uSafety: { value: 0 }, uT1: { value: 1 }, uT2: { value: 2 }, uTarget: { value: 2 }, uTargetMin: { value: 0 },
      uFail: { value: FAIL.clone() }, uAmber: { value: AMBER.clone() }, uGreen: { value: GREEN.clone() }, uFlat: { value: MESH.clone() },
      uEdge: { value: new THREE.Color('#0d0f12') }, uAlpha: { value: 0.32 },
      uInside: { value: INSIDE.clone() }, uShowInside: { value: false },
    },
  });
}

interface Look { kind: ScaleKind | 'mesh'; banded: boolean; bands: number; lut: THREE.Texture; min: number; max: number; outOn: boolean; safety: number; t1: number; t2: number; target: number; targetMin: number }

function configure(material: THREE.ShaderMaterial, look: Look, edges = false) {
  const u = material.uniforms;
  u.uKind.value = edges ? 3 : look.kind === 'mesh' ? 2 : look.kind === 'safety' ? 1 : 0;
  u.uLut.value = look.lut; u.uBanded.value = look.banded; u.uBands.value = look.bands;
  u.uMin.value = look.min; u.uMax.value = look.max; u.uOutOn.value = look.outOn;
  u.uSafety.value = look.safety; u.uT1.value = look.t1; u.uT2.value = look.t2; u.uTarget.value = look.target; u.uTargetMin.value = look.targetMin;
  material.wireframe = edges || look.kind === 'mesh';
}

/** Mid-side node of each tetrahedron edge in CalculiX C3D10 order (corners 0–3, then edges 0-1, 1-2, 2-0, 0-3, 1-3,
 *  2-3), keyed by the edge's corner bits: (1 << a) | (1 << b). */
const MID: Record<number, number> = { 3: 4, 6: 5, 5: 6, 9: 7, 10: 8, 12: 9 };

/**
 * The triangles where `plane` cuts the undeformed tetrahedra, drawn on the deformed shape. Values follow the
 * element's shape along each cut edge: quadratic through the mid-side node for 10-node elements, else linear.
 */
function sliceCells(cells: Uint32Array, stride: number, positions: ArrayLike<number>, base: ArrayLike<number>, values: Float32Array, plane: THREE.Plane) {
  const nodes = values.length;
  const distance = new Float32Array(nodes);
  const { x: nx, y: ny, z: nz } = plane.normal, c = plane.constant;
  for (let i = 0; i < nodes; i++) distance[i] = nx * base[3 * i] + ny * base[3 * i + 1] + nz * base[3 * i + 2] + c;
  let triangles = 0;
  for (let e = 0; e < cells.length; e += stride) {
    const above = +(distance[cells[e]] > 0) + +(distance[cells[e + 1]] > 0) + +(distance[cells[e + 2]] > 0) + +(distance[cells[e + 3]] > 0);
    triangles += above === 2 ? 2 : above === 1 || above === 3 ? 1 : 0;
  }
  if (!triangles) return null;
  const out = new Float32Array(triangles * 9), origin = new Float32Array(triangles * 9), outValues = new Float32Array(triangles * 3);
  let n = 0, e = 0;
  const point = (la: number, lb: number) => {
    const a = cells[e + la], b = cells[e + lb];
    const t = distance[a] / (distance[a] - distance[b]);
    for (let k = 0; k < 3; k++) {
      out[n * 3 + k] = positions[3 * a + k] + (positions[3 * b + k] - positions[3 * a + k]) * t;
      origin[n * 3 + k] = base[3 * a + k] + (base[3 * b + k] - base[3 * a + k]) * t;
    }
    if (stride === 10) {
      const m = cells[e + MID[(1 << la) | (1 << lb)]];
      outValues[n] = values[a] * (1 - t) * (1 - 2 * t) + values[b] * t * (2 * t - 1) + values[m] * 4 * t * (1 - t);
    } else outValues[n] = values[a] + (values[b] - values[a]) * t;
    n++;
  };
  const up = [0, 0, 0, 0], down = [0, 0, 0, 0];
  for (e = 0; e < cells.length; e += stride) {
    let u = 0, d = 0;
    for (let k = 0; k < 4; k++) { if (distance[cells[e + k]] > 0) up[u++] = k; else down[d++] = k; }
    if (u === 1) { point(up[0], down[0]); point(up[0], down[1]); point(up[0], down[2]); }
    else if (u === 3) { point(down[0], up[0]); point(down[0], up[1]); point(down[0], up[2]); }
    else if (u === 2) {
      point(up[0], down[0]); point(up[0], down[1]); point(up[1], down[1]);
      point(up[0], down[0]); point(up[1], down[1]); point(up[1], down[0]);
    }
  }
  return { positions: out, origin, values: outValues };
}

interface Display { unit: string | null | undefined; flow: boolean; kind: ScaleKind | 'mesh'; mode: boolean; animation: 'mode' | 'deform' | 'frames' | null }

const reading = (value: number, display: Display) => (display.kind === 'safety'
  ? { value: value >= SAFETY_CAP ? `≥ ${SAFETY_CAP}` : value.toPrecision(3), unit: '' }
  : show(value, display.unit, display.flow));

/** Seconds per animation cycle at 1× (a mode's swing, or deformation growing and settling). */
const PERIOD = 2;

/** The undeformed part behind a deformed result: a faint shell and its outline (feature edges). */
function Ghost({ base, triangles, plane }: { base: Float32Array; triangles: Uint32Array; plane: THREE.Plane | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geometry.setIndex(new THREE.BufferAttribute(triangles, 1));
    return geometry;
  }, [base, triangles]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 28), [geometry]);
  const shell = useMemo(() => new THREE.MeshBasicMaterial({ color: '#aeb6c1', transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }), []);
  const line = useMemo(() => new THREE.LineBasicMaterial({ color: '#c8ced6', transparent: true, opacity: 0.55, depthWrite: false }), []);
  useEffect(() => {
    shell.clippingPlanes = line.clippingPlanes = plane ? [plane] : [];
    shell.needsUpdate = line.needsUpdate = true;
    invalidate();
  }, [plane, shell, line, invalidate]);
  useEffect(() => () => { geometry.dispose(); edges.dispose(); }, [geometry, edges]);
  useEffect(() => () => { shell.dispose(); line.dispose(); }, [shell, line]);
  return <group name="simulation-undeformed-ghost">
    <mesh geometry={geometry} material={shell} renderOrder={-1} raycast={() => {}} />
    <lineSegments geometry={edges} material={line} raycast={() => {}} />
  </group>;
}

/**
 * The placed nodes a result of some of a design's components replaces, or null when there is no context to show
 * or it wouldn't line up with the result: another document or component, a moved pose or an exploded view (the
 * solved part's box, in world millimetres, must match where the viewer draws it).
 */
function analysedNodes(model: ModelRuntime, base: Float32Array): THREE.Object3D[] | null {
  const state = get(), pin = useSimulation.getState().result?.manifest.provenance?.design;
  if (model.build.kind === 'part' || !pin?.instances?.length || pin.document_id !== state.doc.saved?.id) return null;
  // The workspace dims what the active study doesn't analyse (modeling/sync.ts): the same components as the result.
  const study = state.studies.find((item) => item.id === state.activeStudy);
  if (study?.definition?.design.instances.join('|') !== pin.instances.join('|')) return null;
  const kept = new Set(pin.instances.map((name) => name.split('/')[0]));
  const ids = [...model.instances].filter(([, instance]) => kept.has(instance.name)).map(([id]) => id);
  if (ids.length !== kept.size || ids.length === model.instances.size) return null;
  const shown = ids.reduce((box, id) => box.union(model.bounds(false, id)), new THREE.Box3());
  return linesUp(base, shown) ? ids.flatMap((id) => model.objects.get(id) ?? []) : null;
}

/** Whether a solved shape (`base`, mm) sits where the viewer draws `shown`: the same box, within 2% of its size. */
function linesUp(base: Float32Array, shown: THREE.Box3): boolean {
  const solved = new THREE.Box3().setFromArray(base);
  const tolerance = Math.max(0.5, solved.getSize(new THREE.Vector3()).length() * 0.02);
  return !(solved.isEmpty() || shown.isEmpty() || solved.min.distanceTo(shown.min) > tolerance || solved.max.distanceTo(shown.max) > tolerance);
}

/**
 * The placed nodes a result replaces in the all-studies view: the components it analysed (every one for a whole
 * design, the model for a part), or null when it is of another document or wouldn't line up with the model shown.
 */
function placedNodes(model: ModelRuntime, base: Float32Array, pin: ResultManifest['provenance']['design'] | undefined): THREE.Object3D[] | null {
  if (!pin || pin.document_id !== get().doc.saved?.id) return null;
  if (model.build.kind === 'part') return linesUp(base, model.bounds(false)) ? [model.root] : null;
  const kept = pin.instances?.length ? new Set(pin.instances.map((name) => name.split('/')[0])) : null;
  const ids = [...model.instances].filter(([, instance]) => !kept || kept.has(instance.name)).map(([id]) => id);
  if (!ids.length || (kept && ids.length !== kept.size)) return null;
  const shown = ids.reduce((box, id) => box.union(model.bounds(false, id)), new THREE.Box3());
  return linesUp(base, shown) ? ids.flatMap((id) => model.objects.get(id) ?? []) : null;
}

function Surface({ data, display }: { data: Decoded; display: Display }) {
  const deformation = useSimulation((s) => s.deformation);
  const contours = useSimulation((s) => s.contours);
  const bands = useSimulation((s) => s.bands);
  const colormap = useSimulation((s) => s.colormap);
  const legendRange = useSimulation((s) => s.legendRange);
  const outOfRange = useSimulation((s) => s.outOfRange);
  const safetyMode = useSimulation((s) => s.safetyMode);
  const trafficRed = useSimulation((s) => s.trafficRed);
  const trafficAmber = useSimulation((s) => s.trafficAmber);
  const safetyTarget = useSimulation((s) => s.safetyTarget);
  const ghost = useSimulation((s) => s.ghost);
  const meshEdges = useSimulation((s) => s.meshEdges);
  const context = useSimulation((s) => s.context);
  const probes = useSimulation((s) => s.probes);
  const recording = useSimulation((s) => s.recording);
  const section = useApp((s) => s.section);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const surfaceRef = useRef<THREE.Mesh>(null);
  const capRef = useRef<THREE.Mesh>(null);
  const banded = contours === 'banded';
  const [version, setVersion] = useState(0);

  const base = useMemo(() => data.positions.map((value) => value * 1000), [data]);
  const material = useMemo(contourMaterial, []);
  const edgeMaterial = useMemo(() => { const edges = contourMaterial(); edges.transparent = true; edges.depthWrite = false; return edges; }, []);
  const capMaterial = useMemo(() => {
    const cap = contourMaterial();
    cap.polygonOffset = true; cap.polygonOffsetFactor = -1; cap.polygonOffsetUnits = -1;
    return cap;
  }, []);
  useEffect(() => () => { material.dispose(); capMaterial.dispose(); edgeMaterial.dispose(); }, [material, capMaterial, edgeMaterial]);

  const palette = useMemo<Palette>(() => ({ kind: display.kind === 'safety' ? 'safety' : 'field', colormap, safety: safetyMode, cap: SAFETY_CAP }),
    [display.kind, colormap, safetyMode]);
  const lut = useMemo(() => paletteTexture(palette), [palette]);
  useEffect(() => () => lut.dispose(), [lut]);

  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(data.positions.length);
    for (let i = 0; i < positions.length; i++) positions[i] = (data.positions[i] + (data.displacement?.[i] ?? 0) * deformation) * 1000;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // The classic full-range ramp (acceptance checks read it); the display colours come from the shader.
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors(data.values, display.kind === 'safety' ? 'safety' : 'field', data.min, data.max, SAFETY_CAP), 3));
    geometry.setAttribute('aValue', new THREE.BufferAttribute(data.values, 1));
    geometry.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }, [data, deformation, display.kind, base]);

  useEffect(() => {
    const range = legendRange ?? { min: data.min, max: data.max };
    const look: Look = {
      kind: display.kind, banded, bands, lut, min: range.min, max: range.max, outOn: !!legendRange && outOfRange === 'grey',
      safety: safetyMode === 'traffic' ? 1 : safetyMode === 'target' ? 2 : 0, t1: trafficRed, t2: trafficAmber,
      target: safetyTarget, targetMin: Math.min(data.min, safetyTarget),
    };
    configure(material, look); configure(capMaterial, look); configure(edgeMaterial, look, true);
    // Edges draw over the faces they bound: the surface steps back a hair.
    material.polygonOffset = meshEdges; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1;
    invalidate();
  }, [material, capMaterial, edgeMaterial, display.kind, banded, bands, lut, data, legendRange, outOfRange, safetyMode, trafficRed, trafficAmber, safetyTarget, meshEdges, invalidate]);

  // Section: cut the material with the section plane; cap solid results with the values inside. The plane comes
  // from the section state itself (the shared plane updates during the section layer's render, which may follow this one).
  const sectioned = section.enabled && !!viewer.model;
  const plane = useMemo(() => (sectioned && viewer.model ? sectionPlane(section, viewer.model.bounds(false)).plane : null),
    [sectioned, section]); // eslint-disable-line react-hooks/exhaustive-deps
  const planeRef = useRef(plane);
  planeRef.current = plane;
  useEffect(() => {
    for (const each of [material, edgeMaterial]) {
      each.uniforms.uClipOn.value = !!plane;
      each.uniforms.uShowInside.value = !!plane;
      if (plane) (each.uniforms.uClip.value as THREE.Vector4).set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    }
    invalidate();
  }, [material, edgeMaterial, plane, invalidate]);
  const cap = useMemo(() => {
    if (!plane || !data.cells || display.kind === 'mesh') return null;
    const sliced = sliceCells(data.cells, data.cellNodes, geometry.attributes.position.array, base, data.values, plane);
    if (!sliced) return null;
    const capGeometry = new THREE.BufferGeometry();
    capGeometry.setAttribute('position', new THREE.BufferAttribute(sliced.positions, 3));
    capGeometry.setAttribute('color', new THREE.BufferAttribute(vertexColors(sliced.values, display.kind === 'safety' ? 'safety' : 'field', data.min, data.max, SAFETY_CAP), 3));
    capGeometry.setAttribute('aValue', new THREE.BufferAttribute(sliced.values, 1));
    capGeometry.setAttribute('aBase', new THREE.BufferAttribute(sliced.origin, 3));
    capGeometry.computeVertexNormals();
    return { geometry: capGeometry, origin: sliced.origin, values: sliced.values };
  }, [plane, data, geometry, base, display.kind, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cap?.geometry.dispose(), [cap]);

  // Animation: the displacement scaled by the cycle's amplitude, applied when the phase or scale changes.
  const motion = display.animation === 'mode' || display.animation === 'deform' ? display.animation : null;
  const applied = useRef({ amplitude: 1, deformation, geometry });
  const shape = (scale: number) => {
    const positions = geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < positions.length; i++) positions[i] = (data.positions[i] + (data.displacement?.[i] ?? 0) * scale) * 1000;
    geometry.attributes.position.needsUpdate = true;
  };
  useEffect(() => useSimulation.subscribe((s, previous) => { if (s.phase !== previous.phase || s.playing !== previous.playing) invalidate(); }), [invalidate]);
  useFrame((_, delta) => {
    const s = useSimulation.getState();
    if (!motion || !data.displacement) return;
    let phase = s.phase;
    if (s.playing) {
      phase = (phase ?? 0) + (Math.min(delta, 0.1) * s.speed) / PERIOD;
      if (phase >= 1 && s.playback === 'once') useSimulation.setState({ playing: false, phase: phase = 1 });
      else useSimulation.setState({ phase: phase %= 1 });
      invalidate();
    }
    const amp = amplitude(motion, s.playback, phase);
    const last = applied.current;
    if (last.amplitude === amp && last.deformation === deformation && last.geometry === geometry) return;
    applied.current = { amplitude: amp, deformation, geometry };
    shape(deformation * amp);
    if (sectioned && data.cells) setVersion((v) => v + 1);
  });
  useEffect(() => { invalidate(); return () => geometry.dispose(); }, [geometry, invalidate]);
  useEffect(() => {
    if (geometry.boundingBox) viewer.frame(geometry.boundingBox, null, false);
    invalidate();
  }, [data, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps
  // The result replaces what it analysed; the rest of the design stays as dimmed context (the Simulate workspace
  // ghosts it), else the whole model is hidden. Tree visibility can re-show a node, so it stays hidden each frame.
  const replaced = useRef<THREE.Object3D[]>([]);
  useEffect(() => {
    const model = viewer.model;
    const root = model?.root;
    const visible = root?.visible;
    const nodes = context && model ? analysedNodes(model, base) : null;
    if (root && !nodes) root.visible = false;
    replaced.current = nodes ?? [];
    invalidate();
    return () => {
      replaced.current = [];
      if (root) root.visible = visible ?? true;
      if (nodes) model?.applyVisibility(get().tree);
      invalidate();
    };
  }, [data, base, context, invalidate]);
  useFrame(() => { for (const node of replaced.current) node.visible = false; });

  // Probe: the value under the pointer, interpolated within the triangle it hits (surface or cut).
  const capState = useRef(cap);
  capState.current = cap;
  useEffect(() => {
    if (display.kind === 'mesh') return;
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const triangle = new THREE.Triangle(), weights = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let frame = 0, down: { x: number; y: number } | null = null;
    const read = (event: PointerEvent): (ProbeReading & { point: [number, number, number] }) | null => {
      const surface = surfaceRef.current;
      if (!surface) return null;
      const rect = canvas.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits: THREE.Intersection[] = [];
      // The meshes opt out of the viewport's own picking; probe them directly.
      THREE.Mesh.prototype.raycast.call(surface, raycaster, hits);
      const cut = capState.current;
      if (cut && capRef.current) THREE.Mesh.prototype.raycast.call(capRef.current, raycaster, hits);
      hits.sort((x, y) => x.distance - y.distance);
      const cutPlane = planeRef.current;
      for (const hit of hits) {
        if (!hit.face) continue;
        const inside = hit.object === capRef.current;
        const positions = (hit.object as THREE.Mesh).geometry.attributes.position;
        const { a: ia, b: ib, c: ic } = hit.face;
        triangle.set(a.fromBufferAttribute(positions, ia), b.fromBufferAttribute(positions, ib), c.fromBufferAttribute(positions, ic)).getBarycoord(hit.point, weights);
        const values = inside ? cut!.values : data.values, origin = inside ? cut!.origin : base;
        const at = [0, 1, 2].map((k) => origin[3 * ia + k] * weights.x + origin[3 * ib + k] * weights.y + origin[3 * ic + k] * weights.z) as [number, number, number];
        if (!inside && cutPlane && cutPlane.distanceToPoint(new THREE.Vector3(...at)) < -1e-6) continue;
        const value = values[ia] * weights.x + values[ib] * weights.y + values[ic] * weights.z;
        return { value, at, inside, point: hit.point.toArray() as [number, number, number] };
      }
      return null;
    };
    const move = (event: PointerEvent) => {
      // Hovering the section plane still reads the cut; pressing on it drags the plane (it takes the press).
      if (event.buttons) { if (useSimulation.getState().probe) useSimulation.setState({ probe: null }); return; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = read(event);
        useSimulation.setState({ probe: found ? { value: found.value, at: found.at, inside: found.inside, clientX: event.clientX, clientY: event.clientY } : null });
      });
    };
    const leave = () => { cancelAnimationFrame(frame); useSimulation.setState({ probe: null }); };
    const press = (event: PointerEvent) => { down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const release = (event: PointerEvent) => {
      const start = down; down = null;
      if (!start || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      if (useSimulation.getState().picking) return;
      const found = read(event);
      if (!found) return;
      const { probes } = useSimulation.getState();
      useSimulation.setState({ probes: [...probes.slice(-11), { id: (probes.at(-1)?.id ?? 0) + 1, value: found.value, at: found.at, inside: found.inside, point: found.point }] });
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', press);
    canvas.addEventListener('pointerup', release);
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', press);
      canvas.removeEventListener('pointerup', release);
      useSimulation.setState({ probe: null });
    };
  }, [gl, camera, data, base, display.kind]);

  // Extremes: where the field peaks, labelled on the part; clicking one zooms to it.
  const positions = geometry.attributes.position.array as Float32Array;
  const node = (index: number): [number, number, number] => [positions[3 * index], positions[3 * index + 1], positions[3 * index + 2]];
  // Labels on material the section removed are hidden with it.
  const kept = (x: number, y: number, z: number) => !plane || plane.distanceToPoint(new THREE.Vector3(x, y, z)) >= -1e-6;
  const extremes = display.kind === 'mesh' || data.max <= data.min ? []
    : [
      ...(display.kind !== 'safety' ? [{ key: 'max', label: 'Max', index: data.maxIndex, surface: data.maxOnSurface, value: data.max }] : []),
      ...(!display.mode ? [{ key: 'min', label: display.kind === 'safety' ? 'Min safety factor' : 'Min', index: data.minIndex, surface: data.minOnSurface, value: data.min }] : []),
    ].filter((item) => kept(base[3 * item.index], base[3 * item.index + 1], base[3 * item.index + 2]));
  const focus = (point: [number, number, number]) => {
    const radius = Math.max(viewer.modelRadius() * 0.35, 1);
    viewer.frame(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...point), new THREE.Vector3(radius, radius, radius)), null, true);
  };

  return <>
    <mesh ref={surfaceRef} name="simulation-result-surface" geometry={geometry} material={material} frustumCulled={false} raycast={() => {}} />
    {meshEdges && display.kind !== 'mesh' && <mesh name="simulation-result-edges" geometry={geometry} material={edgeMaterial} frustumCulled={false} raycast={() => {}} />}
    {cap && <mesh ref={capRef} name="simulation-result-section" geometry={cap.geometry} material={capMaterial} frustumCulled={false} raycast={() => {}} />}
    {ghost && motion === 'deform' && deformation > 0 && <Ghost base={base} triangles={data.triangles} plane={plane} />}
    {recording && <Recorder />}
    {extremes.map((item) => {
      const shown = reading(item.value, display);
      return <Html key={item.key} position={node(item.index)} zIndexRange={[12, 10]} style={{ pointerEvents: 'none' }}>
        <button type="button" className={sim.marker} data-extreme={item.key} style={{ pointerEvents: 'auto' }} title="Zoom to this point"
          onClick={() => focus(node(item.index))}>
          <i />{item.label} <b>{shown.value}{shown.unit ? ` ${shown.unit}` : ''}</b>{item.surface ? '' : <small>inside</small>}
        </button>
      </Html>;
    })}
    {probes.filter((probe) => kept(...probe.at)).map((probe) => {
      const shown = reading(probe.value, display);
      return <Html key={probe.id} position={probe.point} zIndexRange={[11, 10]} style={{ pointerEvents: 'none' }}>
        <span className={sim.pin} data-probe={probe.id}><i />{shown.value}{shown.unit ? ` ${shown.unit}` : ''}</span>
      </Html>;
    })}
  </>;
}

/**
 * While recording, this renders each frame itself (render priority 1), so the frame can be copied to the video
 * canvas in the same task, with the background and legend painted around it.
 */
function Recorder() {
  const recording = useRef<Recording | null>(null);
  const { gl } = useThree();
  useEffect(() => {
    const study = get().studies.find((item) => item.id === get().activeStudy);
    const title = legendModel(study?.name)?.title ?? 'results';
    try { recording.current = startRecording(gl.domElement, `${study?.name ?? 'Simulation'} - ${title}`); }
    catch (error) { report(error); useSimulation.setState({ recording: false }); }
    return () => { recording.current?.stop(); recording.current = null; };
  }, [gl]);
  useFrame(({ gl, scene, camera, invalidate }) => {
    gl.render(scene, camera);
    const study = get().studies.find((item) => item.id === get().activeStudy);
    recording.current?.paint(legendModel(study?.name));
    invalidate();
  }, 1);
  return null;
}

/** One study's surface in the all-studies view: undeformed, on its shared scale, cut by the section like the model. */
function OverviewSurface({ id, data, base, min, max }: { id: string; data: Decoded; base: Float32Array; min: number; max: number }) {
  const contours = useSimulation((s) => s.contours);
  const bands = useSimulation((s) => s.bands);
  const colormap = useSimulation((s) => s.colormap);
  const section = useApp((s) => s.section);
  const invalidate = useThree((s) => s.invalidate);
  const material = useMemo(contourMaterial, []);
  useEffect(() => () => material.dispose(), [material]);
  const lut = useMemo(() => paletteTexture({ kind: 'field', colormap, safety: 'gradient', cap: SAFETY_CAP }), [colormap]);
  useEffect(() => () => lut.dispose(), [lut]);
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors(data.values, 'field', data.min, data.max, SAFETY_CAP), 3));
    geometry.setAttribute('aValue', new THREE.BufferAttribute(data.values, 1));
    geometry.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    geometry.computeVertexNormals();
    return geometry;
  }, [data, base]);
  useEffect(() => { invalidate(); return () => geometry.dispose(); }, [geometry, invalidate]);
  useEffect(() => {
    configure(material, { kind: 'field', banded: contours === 'banded', bands, lut, min, max, outOn: false, safety: 0, t1: 1, t2: 2, target: 2, targetMin: 0 });
    invalidate();
  }, [material, contours, bands, lut, min, max, invalidate]);
  const plane = useMemo(() => (section.enabled && viewer.model ? sectionPlane(section, viewer.model.bounds(false)).plane : null), [section]);
  useEffect(() => {
    material.uniforms.uClipOn.value = material.uniforms.uShowInside.value = !!plane;
    if (plane) (material.uniforms.uClip.value as THREE.Vector4).set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    invalidate();
  }, [material, plane, invalidate]);
  return <mesh name="simulation-overview-surface" userData={{ study: id }} geometry={geometry} material={material} frustumCulled={false} raycast={() => {}} />;
}

/** What a study brings to the all-studies view: its latest solved result decoded, or why there is none. */
interface Loaded { study: Study; loading?: boolean; off?: boolean; note?: string; manifest?: ResultManifest; field?: string; data?: Decoded }

async function loadStudy(study: Study, full: boolean, onWorker: (worker: Worker) => void): Promise<Loaded> {
  if (!study.revision) return { study, note: 'Not saved yet: open it to set it up.' };
  const runs = await simulationApi<Run[]>(`studies/${study.id}/runs?branch=${encodeURIComponent(study.branch ?? 'main')}`);
  const run = runs.find((item) => item.operation === 'solve' && item.status === 'succeeded');
  if (!run) return { study, note: runs[0] && !terminal(runs[0]) ? 'Running: open it to follow along.' : 'Not solved yet.' };
  if (full) return { study, note: `Not shown (up to ${OVERVIEW_LIMIT} at once): open it to see its results.` };
  const manifest = await simulationApi<ResultManifest>(`simulation/runs/${run.id}/results`);
  const field = resultField(run, manifest);
  const data = await new Promise<Decoded>((resolve, reject) => {
    const worker = new Worker(new URL('./results.worker.ts', import.meta.url), { type: 'module' });
    onWorker(worker);
    worker.onmessage = (event) => { worker.terminate(); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error)); };
    worker.onerror = () => { worker.terminate(); reject(new Error('Result decoding failed.')); };
    worker.postMessage({ manifest, field, frame: Math.max(0, (manifest.frames?.length ?? 1) - 1), region: '', surfaceOnly: true, workspace: selectedWorkspace() });
  });
  return { study, manifest, field, data };
}

/**
 * Each study's latest solved result, fetched and decoded one after another (the same requests opening each makes).
 * Studies hidden in the browser are skipped: nothing fetched, and they leave their place and components to the rest.
 */
function useStudyResults(): Loaded[] {
  const key = useApp((s) => `${s.doc.saved?.id}:${s.studies.map((study) => `${study.id}@${study.revision ?? ''}`).join(',')}`);
  const memory = useTreeMemory();
  const hidden = useApp((s) => s.studies.filter((study) => memory.isOpen(hiddenKey(study.id), false)).map((study) => study.id).join(','));
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  useEffect(() => {
    let cancelled = false, worker: Worker | null = null;
    const studies = get().studies;
    const off = new Set(hidden.split(','));
    const found: Loaded[] = studies.map((study) => (off.has(study.id) ? { study, off: true, note: 'Hidden: show it with its eye in the browser.' } : { study, loading: true }));
    setLoaded(found);
    void (async () => {
      let decoded = 0;
      for (let i = 0; i < studies.length; i++) {
        if (found[i].off) continue;
        let item: Loaded;
        try { item = await loadStudy(studies[i], decoded >= OVERVIEW_LIMIT, (started) => { worker = started; }); }
        catch (error) { item = { study: studies[i], note: error instanceof Error ? error.message : String(error) }; }
        if (cancelled) return;
        if (item.data) decoded++;
        found[i] = item;
        setLoaded([...found]);
      }
    })();
    return () => { cancelled = true; worker?.terminate(); };
  }, [key, hidden]);
  return loaded;
}

/**
 * All studies at once: the whole model, each solved study's result in place of what it analysed, on scales shared by
 * results of the same field and unit. Results that wouldn't line up, or land on what another study already shows,
 * are listed instead (StudiesOverview).
 */
function OverviewLayer() {
  const loaded = useStudyResults();
  const modelVersion = useApp((s) => s.modelVersion);
  const invalidate = useThree((s) => s.invalidate);
  const placed = useMemo(() => {
    const model = viewer.model;
    const claimed = new Map<THREE.Object3D, string>();
    const entries: OverviewEntry[] = [];
    const drawn: { id: string; data: Decoded; base: Float32Array; nodes: THREE.Object3D[]; scale: string }[] = [];
    const scales = new Map<string, OverviewScale>();
    for (const item of loaded) {
      const entry = { id: item.study.id, name: item.study.name, stale: null };
      if (item.loading) { entries.push({ ...entry, state: 'loading', note: '' }); continue; }
      if (item.off) { entries.push({ ...entry, state: 'hidden', note: item.note!, off: true }); continue; }
      if (!item.data || !item.manifest || !item.field) { entries.push({ ...entry, state: 'hidden', note: item.note ?? 'Not solved yet.' }); continue; }
      const base = item.data.positions.map((value) => value * 1000);
      const nodes = model ? placedNodes(model, base, item.manifest.provenance?.design) : null;
      if (!nodes?.length) { entries.push({ ...entry, state: 'hidden', note: 'Solved on another shape or pose: open it to see its results.' }); continue; }
      const other = nodes.map((node) => claimed.get(node)).find(Boolean);
      if (other) { entries.push({ ...entry, state: 'hidden', note: `Same component as ${other}: open it to see its results.` }); continue; }
      nodes.forEach((node) => claimed.set(node, item.study.name));
      const unit = visibleFields(item.manifest, '')[item.field]?.units, flow = !!item.manifest.engine.openfoam;
      // Gauge and absolute pressures never share a scale: the title is part of the key.
      const title = scaleTitle(item.field, item.manifest.analysis);
      const key = `${item.field}|${unit ?? ''}|${flow}|${title}`;
      const scale = scales.get(key);
      if (scale) { scale.min = Math.min(scale.min, item.data.min); scale.max = Math.max(scale.max, item.data.max); scale.studies.push(item.study.id); }
      else scales.set(key, { key, field: item.field, title, unit, flow, min: item.data.min, max: item.data.max, studies: [item.study.id] });
      drawn.push({ id: item.study.id, data: item.data, base, nodes, scale: key });
      entries.push({ ...entry, state: 'shown', note: '', stale: staleness(item.study, item.manifest) });
    }
    return { entries, drawn, scales };
  }, [loaded, modelVersion]);
  useEffect(() => { useOverview.setState({ entries: placed.entries, scales: [...placed.scales.values()] }); }, [placed]);
  useEffect(() => () => useOverview.setState({ entries: [], scales: [] }), []);
  // Each result replaces what it analysed; the rest of the model stays as it is. Tree visibility can re-show a node,
  // so they stay hidden each frame.
  const replaced = useRef<THREE.Object3D[]>([]);
  useEffect(() => {
    const model = viewer.model;
    const nodes = placed.drawn.flatMap((item) => item.nodes);
    const visible = model?.root.visible ?? true;
    replaced.current = nodes;
    invalidate();
    return () => {
      replaced.current = [];
      if (model && nodes.length) {
        if (nodes.includes(model.root)) model.root.visible = visible;
        model.applyVisibility(get().tree);
      }
      invalidate();
    };
  }, [placed, invalidate]);
  useFrame(() => { for (const node of replaced.current) node.visible = false; });
  return <>{placed.drawn.map((item) => {
    const scale = placed.scales.get(item.scale)!;
    return <OverviewSurface key={item.id} id={item.id} data={item.data} base={item.base} min={scale.min} max={scale.max} />;
  })}</>;
}

export default function ResultsLayer() {
  const overview = useApp((s) => s.studyOverview);
  return overview ? <OverviewLayer /> : <StudyResult />;
}

/** The active study's result. */
function StudyResult() {
  const result = useSimulation((s) => s.result);
  const frame = useSimulation((s) => s.frame);
  const field = useSimulation((s) => s.field);
  const region = useSimulation((s) => s.region);
  const playing = useSimulation((s) => s.playing);
  const speed = useSimulation((s) => s.speed);
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  useEffect(() => {
    setDecoded(null);
    useSimulation.setState({ range: null, probes: [], probe: null, interior: null });
    if (!result) return;
    const worker = new Worker(new URL('./results.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      if (event.data.ok) {
        setDecoded(event.data);
        useSimulation.setState({ range: { min: event.data.min, max: event.data.max }, interior: !!event.data.cells });
      } else report(new Error(event.data.error));
    };
    worker.onerror = () => report(new Error('Result decoding failed.'));
    worker.postMessage({ manifest: result.manifest, field, frame, region, yieldPa: yieldOf(result.manifest), safetyCap: SAFETY_CAP, workspace: selectedWorkspace() });
    return () => worker.terminate();
  }, [result, field, frame, region]);
  const animation = animationKind(result?.manifest, field);
  // Transient steps play one after another, each once it has loaded; mirrored playback turns at the ends.
  const direction = useRef(1);
  useEffect(() => {
    if (!playing || animation !== 'frames' || !decoded || !result) return;
    const count = result.manifest.frames!.length;
    const timer = setTimeout(() => {
      const s = useSimulation.getState();
      let next = s.frame + direction.current;
      if (next >= count || next < 0) {
        if (s.playback === 'once') { useSimulation.setState({ playing: false }); return; }
        if (s.playback === 'loop') next = direction.current > 0 ? 0 : count - 1;
        else { direction.current = -direction.current; next = s.frame + direction.current; }
      }
      useSimulation.setState({ frame: Math.min(count - 1, Math.max(0, next)) });
    }, 700 / speed);
    return () => clearTimeout(timer);
  }, [playing, animation, decoded, result, speed]);
  const display = useMemo<Display | null>(() => result && {
    unit: field === 'safety' ? '' : visibleFields(result.manifest, region)[field]?.units,
    flow: !!result.manifest.engine.openfoam,
    kind: field === 'mesh' ? 'mesh' : field === 'safety' ? 'safety' : 'field',
    mode: field.startsWith('mode_'),
    animation,
  }, [result, field, region, animation]);
  return decoded && display ? <Surface data={decoded} display={display} /> : null;
}
