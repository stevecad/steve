import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Build, Topology, TopologyEdge, TopologyMesh, Vec3 } from '@/lib/api';
import { pretty } from '@/lib/format';
import { bodyOrder, componentBodyOrder, faceLooks } from '@/lib/bodyOrder';
import type { DesignResult, ModelingResult } from '@/lib/modeling';
import type { DisplayStyle, EntityPick, Pick, SelectionFilter, Theme, TreeNode } from '@/state/store';
import { instanceSources } from './instanceSource';

type Association = { nodes?: number; meshes?: number; primitives?: number };
type OverlayMode = 'hover' | 'select' | 'measure';

export interface FaceInfo { node: string; meshIndex: number; faceIndex: number }
interface EdgeSet { visible: LineSegments2; hidden: LineSegments2; node: string; meshIndex: number; segmentToEdge: Uint32Array | null; tangent?: boolean; /** Edges this set leaves to another (a surface's free edges). */ skip?: (edge: TopologyEdge) => boolean }

export interface PickResult { pick: Pick; point: THREE.Vector3; distance: number }

/**
 * Big models (an imported assembly of hundreds of bodies, a mesh imported as STEP with one face per triangle) draw each
 * body as one merged mesh instead of one THREE.Mesh (one draw call) per face; a face table maps its triangles and
 * vertices back to faces. A glTF mesh's faces are split into its bodies' face runs (the build's report, in export
 * order) and each body is merged on its own, so everything that works per body (materials, hiding, moving, decals,
 * bounds) is unchanged; single faces are made on demand (faceMesh) and face picks come from the triangle hit. Models of
 * at most MERGE_FACES faces in all stay one mesh per face: they draw quickly anyway. On by default; a browser can turn
 * it off while a problem is fixed: ?mergeHugeParts=0 (remembered; ?mergeHugeParts=1 turns it back on).
 */
export const MERGE_FACES = 2000;
/** A merged body's faces: `base` is its first face's index in the glTF mesh; starts are local (face - base). */
interface FaceTable { base: number; count: number; triStart: Uint32Array; vertStart: Uint32Array }

// Read once, as the page loads: the app rewrites the address (dropping unknown parameters) before any model is built.
const MERGE_SWITCH = (() => {
  try {
    const query = new URLSearchParams(location.search).get('mergeHugeParts');
    if (query === '1' || query === '0') localStorage.setItem('steve.viewer.mergeHugeParts', query);
    return query ? query === '1' : localStorage.getItem('steve.viewer.mergeHugeParts') !== '0';
  } catch {
    return true;
  }
})();

export const mergeHugeParts = (): boolean => MERGE_SWITCH;

const PART_COLOR = '#c3cbd1';
/** Surface bodies (no inside: model.fill, boundary_surface) draw in their own colour, two-sided, their open edges in
 *  FREE_EDGE_COLOR, so a sheet never reads as a solid. */
export const SURFACE_COLOR = '#d9b36a';
export const FREE_EDGE_COLOR = '#e8772e';
/** Designs: each component (or linked part) gets its own calm colour, in order of first placement. */
// No blues: the selection highlight is blue.
const COMPONENT_COLORS = ['#6fb8a8', '#d2b47e', '#c9917f', '#a596d0', '#98bb86', '#c890ab', '#b9a58c', '#8fb39d'];
const GHOST_COLOR = 0x8d9aa4;
/** The opacity of a component made see-through from the browser (X-ray draws everything fainter still). */
const SEE_THROUGH_OPACITY = 0.3;
/** A selected face's highlight where it can be seen, and where other geometry covers it. */
const FACE_OPACITY = 0.42;
const HIDDEN_FACE_OPACITY = 0.18;
/** Exploded view: offset per unit of distance from the assembly's center, and the share nested levels get. */
const EXPLODE_SPREAD = 1.5;
const EXPLODE_NESTED = 0.5;

/** A linked circuit's look, node by node (runtime/steve/circuit_board.py `appearance`). */
interface CircuitLook { color: string; metal: boolean }
interface CircuitLink { kind?: string; summary?: { appearance?: Record<string, CircuitLook> } | null }

/** A design's placed instance (runtime `metadata.modeling.design.instances`). */
export interface DesignInstance { name: string; component: string; link?: boolean }
const EDGE_DARK = { shaded: 0x0b0f12, line: 0xd3dade };
const EDGE_LIGHT = { shaded: 0x161d22, line: 0x1c2429 };

/** Recent GLB downloads, so switching between document tabs doesn't refetch geometry. */
const glbCache = new Map<string, Promise<ArrayBuffer>>();

/** A response's body, reporting the fraction downloaded so far (0–1) when its length is known (not when compressed in transit). */
async function readWithProgress(response: Response, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  const total = Number(response.headers.get('Content-Length'));
  if (!response.body || !total || response.headers.get('Content-Encoding')) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

export async function loadGltf(url: string, onProgress?: (fraction: number) => void): Promise<GLTF> {
  let download = glbCache.get(url);
  if (!download) {
    download = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Preview download failed (${response.status}).`);
      return onProgress ? readWithProgress(response, onProgress) : response.arrayBuffer();
    });
    glbCache.set(url, download);
    download.catch(() => glbCache.delete(url));
    while (glbCache.size > 12) glbCache.delete(glbCache.keys().next().value!);
  }
  // Each runtime mutates its scene, so parse a fresh copy every time.
  const buffer = await download;
  onProgress?.(1);
  return new GLTFLoader().parseAsync(buffer.slice(0), '');
}

/** Owns every three.js object for one displayed build: faces, B-rep edges, highlights. */
export class ModelRuntime {
  readonly root = new THREE.Group();
  readonly content: THREE.Object3D;
  readonly tree: Record<string, TreeNode> = {};
  readonly rootId = 'root';
  readonly objects = new Map<string, THREE.Object3D>();
  readonly faces: THREE.Mesh[] = [];
  readonly edgeSets: EdgeSet[] = [];
  /** Face meshes by `node:mesh:face`, and the first face of each `node:mesh`, so lookups don't scan every face. */
  private readonly faceIndex = new Map<string, THREE.Mesh>();
  private readonly frameIndex = new Map<string, THREE.Mesh>();
  /** Merged bodies (MERGE_FACES): each merged mesh's face table, the merged bodies of each `node:mesh` (by first face),
   * and the single faces made from them on demand. */
  private readonly faceTables = new Map<THREE.Mesh, FaceTable>();
  private readonly mergedBy = new Map<string, THREE.Mesh[]>();
  private readonly lazyFaces = new Map<string, THREE.Mesh>();
  private readonly lazyMaterial = new THREE.MeshBasicMaterial({ visible: false });
  /** Bounding sphere of each mesh's topology vertices, in mesh-local coordinates. */
  private readonly vertexSpheres = new Map<number, THREE.Sphere>();
  /** Designs: the instance each placed node (a child of the document) shows. */
  readonly instances = new Map<string, DesignInstance>();
  readonly hasTopology: boolean;
  private readonly materials = new Set<THREE.MeshStandardMaterial>();
  private readonly edgeMaterial: LineMaterial;
  private readonly tangentEdgeMaterial: LineMaterial;
  /** A surface body's open (free) edges: the boundary still to be closed or joined. */
  private readonly freeEdgeMaterial: LineMaterial;
  private readonly hiddenEdgeMaterial: LineMaterial;
  private readonly overlays: THREE.Object3D[] = [];
  private readonly faceOverlay: Record<OverlayMode, THREE.MeshBasicMaterial>;
  private readonly edgeOverlay: Record<OverlayMode, LineMaterial>;
  private readonly pointOverlay: Record<OverlayMode, THREE.PointsMaterial>;
  /** The same highlights where other geometry covers them: drawn only behind the depth buffer, fainter. */
  private readonly faceHidden: Record<OverlayMode, THREE.MeshBasicMaterial>;
  private readonly edgeHidden: Record<OverlayMode, LineMaterial>;
  private readonly pointHidden: Record<OverlayMode, THREE.PointsMaterial>;
  private clipping: THREE.Plane[] = [];
  private fade = 1;
  private edgeOpacity = 0.92;
  private style: DisplayStyle = 'shaded-edges';
  private appearance: (mesh: THREE.Mesh) => THREE.MeshStandardMaterial | null = () => null;
  private analysis: THREE.Material | null = null;
  private ghosted = new Set<string>();
  private readonly ghostMaterial = new THREE.MeshStandardMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  /** Nodes made see-through from the browser (TreeNode.seeThrough) and the faint copy of each material they use. */
  private seeThrough = new Set<string>();
  private seeThroughCopies = new WeakMap<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  /** A Blender scene's animation, as its preview carries it (blender/blender_run.py export_preview): every clip plays
   *  together and the Animation tab sets the time (motion/sceneAnimation.ts). Null without one. */
  readonly mixer: THREE.AnimationMixer | null = null;
  /** The clip's length (s), from its first key frame to its last: glTF key times are the scene's frame / fps, so the
   *  first frame of the range is the clip's start, not zero. */
  readonly animationDuration: number = 0;
  private animationStart = 0;
  /** The scene's camera (metadata.scene.camera), placed and moving as the shot has it: the Animation tab's Shot view. */
  readonly shotCamera: THREE.PerspectiveCamera | null = null;

  constructor(readonly gltf: GLTF, readonly build: Build, readonly topology: Topology | null, documentName: string) {
    this.content = gltf.scene;
    // CadQuery exports Z-up geometry rotated into glTF's Y-up frame; undo that so world space is CAD space.
    this.root.rotation.x = Math.PI / 2;
    this.root.add(this.content);
    this.root.name = 'model';
    this.hasTopology = !!topology;
    if (build.kind === 'blender') {
      if (gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(this.content);
        for (const clip of gltf.animations) this.mixer.clipAction(clip).play();
        this.animationStart = Math.min(...gltf.animations.flatMap((clip) => clip.tracks.map((track) => track.times[0] ?? 0)));
        this.animationDuration = Math.max(0, Math.max(...gltf.animations.map((clip) => clip.duration)) - this.animationStart);
        this.mixer.setTime(this.animationStart);
      }
      const named = (build.metadata as { scene?: { camera?: string } } | null | undefined)?.scene?.camera;
      const cameras = gltf.cameras.filter((camera): camera is THREE.PerspectiveCamera => camera instanceof THREE.PerspectiveCamera);
      this.shotCamera = cameras.find((camera) => camera.name === named || camera.parent?.name === named) ?? cameras[0] ?? null;
    }

    const associations = gltf.parser.associations as Map<THREE.Object3D, Association>;
    const nodeObjects = new Map<number, THREE.Object3D>();
    this.content.traverse((object) => {
      const association = associations.get(object);
      if (association?.nodes !== undefined) nodeObjects.set(association.nodes, object);
    });

    this.buildTree(nodeObjects, documentName);
    const design = (build.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design;
    if (build.kind !== 'part' && design) {
      const byName = new Map(design.instances.map((item) => [pretty(item.name), item as DesignInstance]));
      for (const id of this.tree[this.rootId].children) {
        const instance = byName.get(this.tree[id].name);
        if (instance) this.instances.set(id, instance);
      }
    }
    const sources = [...new Set([...this.instances.values()].map(sourceKey))];
    // Linked circuits keep the board's own look (solder mask, plastic, metal leads, LED colours): the runtime's appearance
    // map, by node path under the link (runtime/steve/circuit_board.py), instead of a component tint.
    const links = (design as { links?: Record<string, CircuitLink> } | undefined)?.links ?? {};
    const glbNames = (gltf.parser.json as { nodes: { name?: string }[] }).nodes;
    const circuitLook = (node: string): { path: string; look: CircuitLook | null } | null => {
      const instanceId = this.instanceNode(node);
      const instance = instanceId ? this.instances.get(instanceId) : undefined;
      const link = instance?.link ? links[instance.component] : undefined;
      if (link?.kind !== 'circuit') return null;
      const names: string[] = [];
      for (let id: string | null = node; id && id !== instanceId; id = this.tree[id]?.parent ?? null) names.unshift(glbNames[Number(id.slice(1))]?.name ?? '');
      const path = names.filter(Boolean).join('/');
      const map = link.summary?.appearance ?? {};
      // The exact path, else the longest entry the path ends with (an exporter may add a level).
      const key = path in map ? path : Object.keys(map).filter((entry) => path.endsWith(`/${entry}`) || path === entry).sort((a, b) => b.length - a.length)[0];
      return { path, look: key ? map[key] : null };
    };
    const tintOf = (node: string) => {
      const instance = this.instances.get(this.instanceNode(node) ?? '');
      return instance ? COMPONENT_COLORS[sources.indexOf(sourceKey(instance)) % COMPONENT_COLORS.length] : null;
    };
    const owner = (object: THREE.Object3D) => {
      for (let current: THREE.Object3D | null = object; current; current = current.parent) {
        const id = current.userData.treeId as string | undefined;
        if (id) return id;
      }
      return this.rootId;
    };

    this.edgeMaterial = new LineMaterial({ color: EDGE_DARK.shaded, linewidth: 1.35, transparent: true, opacity: 0.92, worldUnits: false });
    this.tangentEdgeMaterial = new LineMaterial({ color: EDGE_DARK.shaded, linewidth: 1, transparent: true, opacity: 0.3, worldUnits: false });
    this.freeEdgeMaterial = new LineMaterial({ color: FREE_EDGE_COLOR, linewidth: 2.2, transparent: true, opacity: 0.95, worldUnits: false });
    this.hiddenEdgeMaterial = new LineMaterial({ color: EDGE_DARK.line, linewidth: 1, transparent: true, opacity: 0.28, dashed: true, dashSize: 1.6, gapSize: 1.2, depthFunc: THREE.GreaterDepth, depthWrite: false });
    const overlayBase = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 };
    this.faceOverlay = {
      hover: new THREE.MeshBasicMaterial({ ...overlayBase, color: 0x8fd0ff, opacity: 0.22 }),
      select: new THREE.MeshBasicMaterial({ ...overlayBase, color: 0x3aa6ff, opacity: FACE_OPACITY }),
      measure: new THREE.MeshBasicMaterial({ ...overlayBase, color: 0xf5d58a, opacity: 0.45 }),
    };
    // Selections stay visible through the part: each highlight draws twice, full strength where it can be seen and
    // fainter (GreaterDepth, like hiddenEdgeMaterial) where other geometry covers it.
    const hiddenBase = { ...overlayBase, depthFunc: THREE.GreaterDepth };
    this.faceHidden = {
      hover: new THREE.MeshBasicMaterial({ ...hiddenBase, color: 0x8fd0ff, opacity: 0.1 }),
      select: new THREE.MeshBasicMaterial({ ...hiddenBase, color: 0x3aa6ff, opacity: HIDDEN_FACE_OPACITY }),
      measure: new THREE.MeshBasicMaterial({ ...hiddenBase, color: 0xf5d58a, opacity: 0.2 }),
    };
    this.edgeOverlay = {
      hover: new LineMaterial({ color: 0x9fd7ff, linewidth: 3, transparent: true, opacity: 0.95, depthWrite: false }),
      select: new LineMaterial({ color: 0x2f9dff, linewidth: 3.5, transparent: true, opacity: 1, depthWrite: false }),
      measure: new LineMaterial({ color: 0xf5d58a, linewidth: 3.5, transparent: true, opacity: 1, depthWrite: false }),
    };
    this.edgeHidden = {
      hover: new LineMaterial({ color: 0x9fd7ff, linewidth: 3, transparent: true, opacity: 0.35, depthWrite: false, depthFunc: THREE.GreaterDepth }),
      select: new LineMaterial({ color: 0x2f9dff, linewidth: 3.5, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth }),
      measure: new LineMaterial({ color: 0xf5d58a, linewidth: 3.5, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth }),
    };
    const dot = makeDotTexture();
    this.pointOverlay = {
      hover: new THREE.PointsMaterial({ color: 0x9fd7ff, size: 11, sizeAttenuation: false, map: dot, transparent: true, depthWrite: false, alphaTest: 0.1 }),
      select: new THREE.PointsMaterial({ color: 0x2f9dff, size: 13, sizeAttenuation: false, map: dot, transparent: true, depthWrite: false, alphaTest: 0.1 }),
      measure: new THREE.PointsMaterial({ color: 0xf5d58a, size: 13, sizeAttenuation: false, map: dot, transparent: true, depthWrite: false, alphaTest: 0.1 }),
    };
    this.pointHidden = {
      hover: new THREE.PointsMaterial({ color: 0x9fd7ff, size: 11, sizeAttenuation: false, map: dot, transparent: true, opacity: 0.35, depthWrite: false, depthFunc: THREE.GreaterDepth, alphaTest: 0.1 }),
      select: new THREE.PointsMaterial({ color: 0x2f9dff, size: 13, sizeAttenuation: false, map: dot, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth, alphaTest: 0.1 }),
      measure: new THREE.PointsMaterial({ color: 0xf5d58a, size: 13, sizeAttenuation: false, map: dot, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth, alphaTest: 0.1 }),
    };

    // Surface bodies (model.fill, model.boundary_surface) have no inside: their faces draw from both sides. Solids stay
    // front-sided. Each topology mesh (a part, or a design's component) names its surface bodies; a part's own report
    // covers a build whose topology predates that. Without topology to say which faces are a surface's, a part of
    // surfaces only draws two-sided.
    const reported = build.kind === 'part' ? (build.metadata as { modeling?: ModelingResult } | null | undefined)?.modeling?.bodies ?? {} : {};
    const partSurfaces = new Set(Object.entries(reported).filter(([, body]) => body.kind === 'surface').map(([id]) => id));
    const surfacesOnly = partSurfaces.size > 0 && partSurfaces.size === Object.keys(reported).length;
    const twoSided = (face: { meshIndex: number; faceIndex: number }) => {
      const mesh = topology?.meshes[String(face.meshIndex)];
      const surfaces = mesh?.surface_bodies?.length ? mesh.surface_bodies : partSurfaces.size ? [...partSurfaces] : null;
      if (!surfaces) return false;
      const bodies = mesh?.faces[face.faceIndex]?.bodies;
      return bodies ? bodies.some((id) => surfaces.includes(id)) : surfacesOnly;
    };
    // Face meshes: one glTF primitive per B-rep face.
    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    const originals = new Set<THREE.Material>();
    const meshGroups = new Map<THREE.Object3D, THREE.Mesh[]>();
    this.content.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const association = associations.get(object);
      const original = object.material as THREE.MeshStandardMaterial;
      originals.add(original);
      const node = owner(object);
      const circuit = circuitLook(node);
      const tint = circuit ? null : tintOf(node);
      const sides = twoSided({ meshIndex: association?.meshes ?? -1, faceIndex: association?.primitives ?? 0 });
      const materialKey = `${original.uuid}|${tint ?? ''}|${circuit ? `${circuit.look?.color ?? 'glb'}:${circuit.look?.metal ?? false}:${circuit.path === 'board'}` : ''}${sides ? '|surface' : ''}`;
      let material = materialCache.get(materialKey);
      if (!material) {
        material = original.clone();
        // Parts, and design components without an explicit color, use the studio default; a design's components their own
        // colour; a linked circuit its own look (no near-white rewrite: a white LED stays white).
        const { r, g, b } = material.color;
        if (circuit) {
          if (circuit.look) material.color.set(circuit.look.color);
          const metal = !!circuit.look?.metal;
          material.metalness = metal ? 0.85 : 0.05;
          material.roughness = metal ? 0.3 : circuit.path === 'board' ? 0.45 : 0.55;
        } else {
          if (sides) material.color.set(SURFACE_COLOR);
          else if (tint) material.color.set(tint);
          else if (build.kind === 'part' || (r > 0.95 && g > 0.95 && b > 0.95)) material.color.set(PART_COLOR);
          material.roughness = build.kind === 'part' ? 0.36 : 0.48;
          material.metalness = build.kind === 'part' ? 0.32 : 0.1;
        }
        material.envMapIntensity = 1;
        material.polygonOffset = true;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
        material.side = sides ? THREE.DoubleSide : THREE.FrontSide;
        materialCache.set(materialKey, material);
        this.materials.add(material);
      }
      object.material = material;
      const face: FaceInfo = { node, meshIndex: association?.meshes ?? -1, faceIndex: association?.primitives ?? 0 };
      object.userData.face = face;
      this.faces.push(object);
      const key = `${face.node}:${face.meshIndex}`;
      if (!this.frameIndex.has(key)) this.frameIndex.set(key, object);
      if (!this.faceIndex.has(`${key}:${face.faceIndex}`)) this.faceIndex.set(`${key}:${face.faceIndex}`, object);
      const parent = association?.primitives !== undefined && object.parent && associations.get(object.parent)?.meshes === association.meshes ? object.parent : object;
      const group = meshGroups.get(parent) ?? [];
      group.push(object);
      meshGroups.set(parent, group);
    });
    for (const material of originals) material.dispose();
    if (mergeHugeParts()) this.mergeHuge(meshGroups);
    const colorOf = (id: string) => {
      const object = this.objects.get(id);
      let color: string | undefined;
      object?.traverse((child) => { if (!color && child instanceof THREE.Mesh) color = `#${(child.material as THREE.MeshStandardMaterial).color.getHexString(THREE.SRGBColorSpace)}`; });
      return color;
    };
    for (const node of Object.values(this.tree)) if (node.type !== 'document') node.color = colorOf(node.id);

    // B-rep edges from topology, or feature edges derived from the mesh as a fallback.
    // Tangent edges (fillet boundaries) draw lighter than sharp feature edges.
    for (const [parent, faceMeshes] of meshGroups) {
      const meshIndex = (faceMeshes[0].userData.face as FaceInfo).meshIndex;
      const node = (faceMeshes[0].userData.face as FaceInfo).node;
      const entry = topology?.meshes[String(meshIndex)];
      const faceCount = faceMeshes.reduce((sum, mesh) => sum + (this.faceTables.get(mesh)?.count ?? 1), 0);
      // A surface body's free edges (one face, not a seam) draw on their own, highlighted.
      const free = (edge: TopologyEdge) => !!entry && freeSurfaceEdge(edge, (index) => twoSided({ meshIndex, faceIndex: index }));
      const sets = entry && entry.faces.length === faceCount
        ? [{ ...topologyEdges(entry, false, free), material: this.edgeMaterial, tangent: false, skip: free },
          { ...topologyEdges(entry, true), material: this.tangentEdgeMaterial, tangent: true, skip: undefined },
          { ...topologyEdges(entry, false, (edge) => !free(edge)), material: this.freeEdgeMaterial, tangent: false, skip: (edge: TopologyEdge) => !free(edge) }]
        : [{ positions: meshEdges(faceMeshes), segmentToEdge: null, material: this.edgeMaterial, tangent: undefined, skip: undefined }];
      for (const built of sets) {
        if (!built.positions.length) continue;
        const geometry = new LineSegmentsGeometry().setPositions(built.positions);
        const visible = new LineSegments2(geometry, built.material);
        const hidden = new LineSegments2(geometry, this.hiddenEdgeMaterial);
        hidden.computeLineDistances();
        hidden.visible = false;
        for (const line of [visible, hidden]) {
          line.userData.edges = { node, meshIndex };
          parent.add(line);
        }
        visible.renderOrder = 2;
        hidden.renderOrder = 1;
        this.edgeSets.push({ visible, hidden, node, meshIndex, segmentToEdge: built.segmentToEdge, tangent: built.tangent, skip: built.skip });
      }
    }
  }

  private buildTree(nodeObjects: Map<number, THREE.Object3D>, documentName: string) {
    const json = this.gltf.parser.json as { nodes: { name?: string; mesh?: number; children?: number[] }[]; scenes: { nodes?: number[] }[]; scene?: number };
    const documents = this.build.metadata?.component_documents ?? {};
    this.tree[this.rootId] = { id: this.rootId, name: documentName, type: 'document', parent: null, children: [], hidden: false, expanded: true };
    this.objects.set(this.rootId, this.root);
    this.root.userData.treeId = this.rootId;
    let roots = json.scenes[json.scene ?? 0].nodes ?? [];
    if (roots.length === 1 && json.nodes[roots[0]].mesh === undefined) roots = json.nodes[roots[0]].children ?? [];
    let bodyCount = 0;
    const create = (index: number, parent: string): string | null => {
      const source = json.nodes[index];
      const object = nodeObjects.get(index);
      if (!object) return null;
      const id = `n${index}`;
      const hasChildren = !!source.children?.length;
      const type: TreeNode['type'] = this.build.kind === 'part' ? 'body' : hasChildren ? 'assembly' : 'part';
      const name = this.build.kind === 'part' ? `Body ${++bodyCount}` : pretty(source.name || `Component ${index + 1}`);
      this.tree[id] = { id, name, type, parent, children: [], hidden: false, expanded: true, documentId: source.name ? documents[source.name] : undefined };
      this.objects.set(id, object);
      object.userData.treeId = id;
      this.tree[id].children = (source.children ?? []).map((child) => create(child, id)).filter((child): child is string => !!child);
      return id;
    };
    this.tree[this.rootId].children = roots.map((index) => create(index, this.rootId)).filter((child): child is string => !!child);
  }

  topologyFor(meshIndex: number): TopologyMesh | undefined {
    return this.topology?.meshes[String(meshIndex)];
  }

  faceMesh(node: string, meshIndex: number, faceIndex: number): THREE.Mesh | undefined {
    const key = `${node}:${meshIndex}:${faceIndex}`;
    const own = this.faceIndex.get(key);
    if (own) return own;
    const merged = this.mergedAt(node, meshIndex, faceIndex);
    return merged ? this.lazyFace(merged, faceIndex) : undefined;
  }

  /** The merged body of a `node:mesh` that holds a face, if that face was merged. */
  private mergedAt(node: string, meshIndex: number, faceIndex: number): THREE.Mesh | undefined {
    const bodies = this.mergedBy.get(`${node}:${meshIndex}`);
    if (!bodies) return undefined;
    let low = 0, high = bodies.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.faceTables.get(bodies[middle])!.base <= faceIndex) low = middle; else high = middle - 1;
    }
    const table = this.faceTables.get(bodies[low])!;
    return faceIndex >= table.base && faceIndex < table.base + table.count ? bodies[low] : undefined;
  }

  /** Whether a face mesh is a merged body (MERGE_FACES), standing for all of its faces. */
  isMerged(mesh: THREE.Mesh): boolean {
    return this.faceTables.has(mesh);
  }

  /** The faces a face mesh stands for: itself, or every face of a merged body. Use it to list faces as picks. */
  facesOf(mesh: THREE.Mesh): FaceInfo[] {
    const face = mesh.userData.face as FaceInfo;
    const table = this.faceTables.get(mesh);
    if (!table) return [face];
    return Array.from({ length: table.count }, (_, index) => ({ node: face.node, meshIndex: face.meshIndex, faceIndex: table.base + index }));
  }

  /** World box of face picks (other kinds are ignored): a face mesh's box as today, and for faces of a merged body
   * the box of just their vertices, without making each face on demand (a whole body can be thousands). */
  pickBox(picks: Pick[]): THREE.Box3 {
    const box = new THREE.Box3();
    const merged = new Map<THREE.Mesh, number[]>();
    for (const pick of picks) {
      if (pick.kind !== 'face') continue;
      const part = this.mergedAt(pick.node, pick.mesh, pick.index);
      if (part) { const faces = merged.get(part); if (faces) faces.push(pick.index); else merged.set(part, [pick.index]); continue; }
      const mesh = this.faceMesh(pick.node, pick.mesh, pick.index);
      if (mesh) box.expandByObject(mesh);
    }
    const point = new THREE.Vector3();
    for (const [part, faces] of merged) {
      const table = this.faceTables.get(part)!;
      const position = part.geometry.getAttribute('position');
      part.updateWorldMatrix(true, false);
      for (const face of new Set(faces.map((index) => index - table.base))) {
        if (face < 0 || face >= table.count) continue;
        for (let v = table.vertStart[face]; v < table.vertStart[face + 1]; v++) box.expandByPoint(point.fromBufferAttribute(position, v).applyMatrix4(part.matrixWorld));
      }
    }
    return box;
  }

  /** Every face of the model, merged bodies expanded (`facesOf`), in the order of `faces`. */
  allFaces(): FaceInfo[] {
    return this.faces.flatMap((mesh) => this.facesOf(mesh));
  }

  /**
   * Each body of a glTF mesh becomes one merged mesh (MERGE_FACES), when it can be done exactly: every face a primitive
   * in order at the part's own frame, the body's faces of one material, and the build's report (`bodyRanges`) adding up
   * to the mesh's faces. A body of one face stays as it is. Instances of the same mesh share the merged geometry.
   */
  private mergeHuge(meshGroups: Map<THREE.Object3D, THREE.Mesh[]>) {
    let total = 0;
    for (const faceMeshes of meshGroups.values()) total += faceMeshes.length;
    if (total <= MERGE_FACES) return;
    const sourceOf = instanceSources(this);
    const shared = new Map<string, { geometry: THREE.BufferGeometry; table: FaceTable }>();
    // Replaced face meshes: the merged body standing in for a body's first face, null for the rest.
    const replaced = new Map<THREE.Mesh, THREE.Mesh | null>();
    for (const [parent, faceMeshes] of [...meshGroups]) {
      if (faceMeshes.length < 2 || parent === faceMeshes[0]) continue;
      const first = faceMeshes[0].userData.face as FaceInfo;
      if (first.meshIndex < 0) continue;
      const ordered = faceMeshes.every((mesh, index) => (mesh.userData.face as FaceInfo).faceIndex === index
        && mesh.parent === parent && isIdentity(mesh.matrix) && !!mesh.geometry.index && !mesh.geometry.morphAttributes.position);
      const ranges = ordered ? this.bodyRanges(first, faceMeshes.length, sourceOf) : null;
      if (!ranges) continue;
      const group: THREE.Mesh[] = [];
      const bodies: THREE.Mesh[] = [];
      for (const [start, end] of ranges) {
        const slice = faceMeshes.slice(start, end);
        const keep = () => { for (const mesh of slice) group.push(mesh); };  // Not spread: a body can be 100k faces.
        if (slice.length < 2 || slice.some((mesh) => mesh.material !== slice[0].material)) { keep(); continue; }
        // GLTFLoader shares a glTF mesh's primitive geometries between the nodes that place it.
        const source = `${slice[0].geometry.uuid}:${start}:${end}`;
        let built = shared.get(source);
        if (!built) {
          const geometry = mergeGeometries(slice.map((mesh) => mesh.geometry), false);
          if (!geometry) { keep(); continue; }
          const table: FaceTable = { base: start, count: slice.length, triStart: new Uint32Array(slice.length + 1), vertStart: new Uint32Array(slice.length + 1) };
          slice.forEach((mesh, index) => {
            table.triStart[index + 1] = table.triStart[index] + mesh.geometry.index!.count / 3;
            table.vertStart[index + 1] = table.vertStart[index] + mesh.geometry.getAttribute('position').count;
          });
          built = { geometry, table };
          shared.set(source, built);
        }
        const merged = new THREE.Mesh(built.geometry, slice[0].material);
        merged.name = `${parent.name || 'part'} (merged)`;
        // A body's first face: what maps a face mesh to its body (bodies.ts, materials, hiding) keeps working.
        merged.userData.face = { node: first.node, meshIndex: first.meshIndex, faceIndex: start } satisfies FaceInfo;
        slice.forEach((mesh, index) => {
          replaced.set(mesh, index === 0 ? merged : null);
          mesh.removeFromParent();
          this.faceIndex.delete(`${first.node}:${first.meshIndex}:${start + index}`);
        });
        parent.add(merged);
        this.faceTables.set(merged, built.table);
        group.push(merged);
        bodies.push(merged);
      }
      if (!bodies.length) continue;
      const key = `${first.node}:${first.meshIndex}`;
      this.mergedBy.set(key, bodies);
      if (replaced.has(this.frameIndex.get(key)!)) this.frameIndex.set(key, bodies[0]);
      meshGroups.set(parent, group);
    }
    if (!replaced.size) return;
    const faces: THREE.Mesh[] = [];
    for (const mesh of this.faces) {
      const merged = replaced.get(mesh);
      if (merged || !replaced.has(mesh)) faces.push(merged ?? mesh);
    }
    this.faces.length = 0;
    for (const mesh of faces) this.faces.push(mesh);
    // The per-face geometries the merged bodies replaced, once no instance still shows them.
    const used = new Set<THREE.BufferGeometry>();
    this.content.traverse((object) => { if (object instanceof THREE.Mesh) used.add(object.geometry); });
    for (const mesh of replaced.keys()) if (!used.has(mesh.geometry)) mesh.geometry.dispose();
  }

  /**
   * The bodies of a glTF mesh as face runs `[start, end)`: from the build's report (a part's bodies in export order, or
   * the node's component's or linked part's), which must add up to the mesh's `count` faces (null: leave it unmerged).
   * A body with face looks (`model.appearance(faces=...)`) is split where the look changes, so each run draws in one.
   * Without a report (a plain CadQuery part is one solid) the topology's face owners split it, else it is one body.
   */
  private bodyRanges(face: FaceInfo, count: number, sourceOf: ReturnType<typeof instanceSources>): [number, number][] | null {
    const modeling = (this.build.metadata as { modeling?: ModelingResult & { design?: DesignResult } } | null | undefined)?.modeling;
    const report = this.build.kind === 'part' ? modeling : sourceOf(face.node)?.summary;
    const order = this.build.kind === 'part' ? bodyOrder(report) : componentBodyOrder(report);
    const ranges: [number, number][] = [];
    if (order.length) {
      const looks = faceLooks(report, order);
      let start = 0;
      for (const id of order) {
        const end = start + report!.bodies[id].faces;
        let from = start;
        for (let index = start + 1; index < end; index++) {
          if (looks.size && looks.get(index) !== looks.get(index - 1)) { ranges.push([from, index]); from = index; }
        }
        if (end > from) ranges.push([from, end]);
        start = end;
      }
      return start === count ? ranges : null;
    }
    const owners = this.topologyFor(face.meshIndex)?.faces;
    if (owners?.length !== count) return [[0, count]];
    let start = 0;
    for (let index = 1; index <= count; index++) {
      if (index < count && owners[index].bodies?.join() === owners[start].bodies?.join()) continue;
      ranges.push([start, index]);
      start = index;
    }
    return ranges;
  }

  /** A single face of a merged body, made once: its own small geometry (positions, normals) at the part's frame, drawn
   * by nothing itself (overlays added to it are), never picked, and marked `lazyFace` so traversals skip it. */
  private lazyFace(merged: THREE.Mesh, faceIndex: number): THREE.Mesh | undefined {
    const table = this.faceTables.get(merged)!;
    const local = faceIndex - table.base;
    if (local < 0 || local >= table.count) return undefined;
    const info = merged.userData.face as FaceInfo;
    const key = `${info.node}:${info.meshIndex}:${faceIndex}`;
    let mesh = this.lazyFaces.get(key);
    if (mesh) return mesh;
    const geometry = subsetGeometry(merged.geometry, table, [local]);
    mesh = new THREE.Mesh(geometry, this.lazyMaterial);
    mesh.raycast = () => {};
    mesh.userData.face = { node: info.node, meshIndex: info.meshIndex, faceIndex } satisfies FaceInfo;
    mesh.userData.lazyFace = true;
    merged.add(mesh);
    mesh.updateMatrixWorld();
    this.lazyFaces.set(key, mesh);
    return mesh;
  }

  /** The face of a merged body a triangle belongs to (binary search of its face table), as an index in its glTF mesh. */
  faceOfTriangle(mesh: THREE.Mesh, triangle: number): number {
    const { base, triStart: starts } = this.faceTables.get(mesh)!;
    let low = 0, high = starts.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= triangle) low = middle; else high = middle - 1;
    }
    return base + low;
  }

  /** Object that carries the mesh-local frame used by topology coordinates. */
  meshFrame(node: string, meshIndex: number): THREE.Object3D | undefined {
    return this.frameIndex.get(`${node}:${meshIndex}`);
  }

  private explodeBase: Map<string, { position: THREE.Vector3; offset: THREE.Vector3 }> | null = null;

  /**
   * Spreads components away from their assembly's center, in proportion to how far out they sit, so stacked parts
   * keep their order and separate evenly; parts at the center stay put. Placed instances move as a unit and their own
   * children spread less around the instance's center. 0 restores the true placement.
   */
  setExplode(factor: number) {
    if (this.build.kind !== 'design') return;
    if (!this.explodeBase) {
      const base = new Map<string, { position: THREE.Vector3; offset: THREE.Vector3 }>();
      this.explodeBase = base;
      const spread = (id: string, scale: number) => {
        const center = this.bounds(false, id).getCenter(new THREE.Vector3());
        for (const child of this.tree[id].children) {
          const object = this.objects.get(child);
          const box = this.bounds(false, child);
          if (!object?.parent || box.isEmpty()) continue;
          const world = box.getCenter(new THREE.Vector3()).sub(center).multiplyScalar(scale);
          // Express the world-space offset in the component's parent frame.
          const parentRotation = new THREE.Matrix3().setFromMatrix4(object.parent.matrixWorld).invert();
          base.set(child, { position: object.position.clone(), offset: world.applyMatrix3(parentRotation) });
          spread(child, scale * EXPLODE_NESTED);
        }
      };
      spread(this.rootId, EXPLODE_SPREAD);
    }
    for (const [id, base] of this.explodeBase) {
      this.objects.get(id)?.position.copy(base.position).addScaledVector(base.offset, factor);
    }
    this.fullBounds = null;
  }

  /** Designs: the placed node (a child of the document) a node belongs to. */
  instanceNode(node: string): string | undefined {
    let current = this.tree[node];
    while (current?.parent && current.parent !== this.rootId) current = this.tree[current.parent];
    return current && current.parent === this.rootId ? current.id : undefined;
  }

  /** Designs: the instance a node belongs to. */
  instanceOf(node: string): DesignInstance | undefined {
    const id = this.instanceNode(node);
    return id ? this.instances.get(id) : undefined;
  }

  /**
   * Placed nodes drawn as translucent context while another component is edited. They stay outlined and pickable:
   * sketching in context references their faces and edges.
   */
  setGhosted(nodes: Iterable<string>) {
    const next = new Set(nodes);
    if ([...next].sort().join() === [...this.ghosted].sort().join()) return;
    this.ghosted = next;
    this.applyAppearance();
  }

  private isGhost(node: string) {
    return this.ghosted.size > 0 && this.ghosted.has(this.instanceNode(node) ?? '');
  }

  /** Shows and hides nodes as the tree says, and draws the see-through ones (and everything under them) faint. */
  applyVisibility(tree: Record<string, TreeNode>) {
    for (const [id, object] of this.objects) if (id !== this.rootId) object.visible = !tree[id]?.hidden;
    const seeThrough = Object.values(tree).filter((node) => node.seeThrough && node.id !== this.rootId).map((node) => node.id);
    if (seeThrough.sort().join() === [...this.seeThrough].sort().join()) return;
    this.seeThrough = new Set(seeThrough);
    this.applyAppearance();
  }

  private isSeeThrough(node: string) {
    if (!this.seeThrough.size) return false;
    for (let current: TreeNode | undefined = this.tree[node]; current; current = current.parent ? this.tree[current.parent] : undefined) if (this.seeThrough.has(current.id)) return true;
    return false;
  }

  /** A see-through face keeps its own colour and finish at a low opacity (the edit-focus ghost is a neutral grey). */
  private seeThroughOf(material: THREE.MeshStandardMaterial) {
    let copy = this.seeThroughCopies.get(material);
    if (!copy) {
      copy = material.clone();
      copy.userData.opacity = Math.min((material.userData.opacity as number | undefined) ?? 1, SEE_THROUGH_OPACITY);
      this.seeThroughCopies.set(material, copy);
    }
    return copy;
  }

  isShown(object: THREE.Object3D) {
    if (object.userData.hiddenFace) return false;
    for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible && current !== object) return false;
    return true;
  }

  private fullBounds: THREE.Box3 | null = null;
  private hiddenVertices = new Map<number, Set<number>>();
  private hiddenFaces = '';

  /**
   * Hides single faces, keyed `mesh:face` (the bodies of a multi-body part): they aren't drawn, picked or framed,
   * and edges and vertices only they own go with them.
   */
  setHiddenFaces(keys: Set<string>) {
    const signature = [...keys].sort().join();
    if (signature === this.hiddenFaces) return;
    this.hiddenFaces = signature;
    for (const mesh of this.faces) {
      const face = mesh.userData.face as FaceInfo;
      // A merged body hides when all its faces do (bodies are hidden whole: modeling/sync.ts).
      let hidden = true;
      for (let index = 0; hidden && index < (this.faceTables.get(mesh)?.count ?? 1); index++) hidden = keys.has(`${face.meshIndex}:${face.faceIndex + index}`);
      if (!!mesh.userData.hiddenFace === hidden) continue;
      mesh.userData.hiddenFace = hidden || undefined;
      if (hidden) mesh.layers.disableAll(); else mesh.layers.set(0);
    }
    this.hiddenVertices.clear();
    for (const set of this.edgeSets) {
      const entry = this.topologyFor(set.meshIndex);
      if (set.tangent === undefined || !entry) continue;
      const gone = (edge: TopologyEdge) => !!edge.faces?.length && edge.faces.every((f) => keys.has(`${set.meshIndex}:${f}`));
      const built = topologyEdges(entry, set.tangent, (edge) => gone(edge) || !!set.skip?.(edge));
      const empty = !built.positions.length;
      for (const line of [set.visible, set.hidden]) if (empty) line.layers.disableAll(); else line.layers.set(0);
      if (!empty) {
        const geometry = new LineSegmentsGeometry().setPositions(built.positions);
        set.visible.geometry.dispose();
        set.visible.geometry = geometry;
        set.hidden.geometry = geometry;
        set.hidden.computeLineDistances();
        set.segmentToEdge = built.segmentToEdge;
      }
      const shown = new Set(entry.edges.filter((edge) => !gone(edge)).flatMap((edge) => edge.vertices ?? []));
      const hidden = new Set(entry.edges.filter(gone).flatMap((edge) => edge.vertices ?? []).filter((v) => !shown.has(v)));
      if (hidden.size) this.hiddenVertices.set(set.meshIndex, hidden);
    }
  }

  bounds(visibleOnly = true, node?: string): THREE.Box3 {
    // Geometry and placements never change after load, so the whole-model box is cached.
    if (!visibleOnly && !node && this.fullBounds) return this.fullBounds.clone();
    this.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const scope = node ? this.objects.get(node) : this.root;
    scope?.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.userData.face || object.userData.lazyFace || (visibleOnly && !this.isShown(object))) return;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      box.union(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld));
    });
    if (!visibleOnly && !node) this.fullBounds = box.clone();
    return box;
  }

  setStyle(style: DisplayStyle, theme: Theme) {
    this.style = style;
    const palette = theme === 'dark' ? EDGE_DARK : EDGE_LIGHT;
    const lineStyle = style === 'hidden-line' || style === 'wireframe' || style === 'xray';
    this.edgeMaterial.color.set(lineStyle ? palette.line : palette.shaded);
    this.tangentEdgeMaterial.color.set(lineStyle ? palette.line : palette.shaded);
    this.edgeOpacity = lineStyle ? 0.95 : theme === 'dark' ? 0.92 : 0.8;
    this.edgeMaterial.linewidth = lineStyle ? 1.2 : 1.35;
    this.hiddenEdgeMaterial.color.set(palette.line);
    this.hiddenEdgeMaterial.dashed = style === 'hidden-line';
    this.hiddenEdgeMaterial.opacity = style === 'xray' ? 0.22 : 0.3;
    this.hiddenEdgeMaterial.needsUpdate = true;
    for (const set of this.edgeSets) {
      set.visible.visible = style !== 'shaded';
      set.hidden.visible = style === 'hidden-line' || style === 'xray';
    }
    this.applyMaterialState();
  }

  setFade(value: number) {
    this.fade = value;
    this.applyMaterialState();
  }

  private applyMaterialState() {
    const style = this.style;
    const fading = this.fade < 1;
    for (const material of this.materials) {
      // See-through surfaces (glass, clear plastics: src/materials) carry their own base opacity.
      const base = (material.userData.opacity as number | undefined) ?? 1;
      // Decals (DecalLayer.tsx) blend their image's alpha over the face beneath and never write depth.
      const decal = !!material.userData.decal;
      material.colorWrite = style !== 'hidden-line' && style !== 'wireframe';
      material.depthWrite = style !== 'wireframe' && style !== 'xray' && base === 1 && !decal;
      material.transparent = fading || style === 'xray' || base < 1 || decal;
      material.opacity = (style === 'xray' ? 0.16 : base) * this.fade;
      material.needsUpdate = true;
    }
    this.edgeMaterial.opacity = this.edgeOpacity * this.fade;
    this.tangentEdgeMaterial.opacity = (this.style === 'shaded-edges' ? 0.28 : 0.45) * this.fade;
    this.freeEdgeMaterial.opacity = 0.95 * this.fade;
  }

  /** Per-face appearance (bodies' materials, src/materials); null keeps the studio look. Materials follow style, fade and clipping. */
  setAppearance(pick: (mesh: THREE.Mesh) => THREE.MeshStandardMaterial | null) {
    this.appearance = pick;
    this.applyAppearance();
  }

  /** A display-only analysis drawn on every face instead of its appearance (the Surface tab's zebra, curvature and draft
   *  modes, workspaces/surface/AnalysisLayer.tsx); null restores it. Ghosted faces stay ghosted. */
  setAnalysis(material: THREE.Material | null) {
    if (this.analysis === material) return;
    this.analysis = material;
    if (material) { material.clippingPlanes = this.clipping; material.needsUpdate = true; }
    this.applyAppearance();
  }

  private applyAppearance() {
    for (const mesh of this.faces) {
      const studio = (mesh.userData.studio ??= mesh.material) as THREE.MeshStandardMaterial;
      if (this.isGhost((mesh.userData.face as FaceInfo).node)) { mesh.material = this.ghostMaterial; continue; }
      if (this.analysis) { mesh.material = this.analysis; continue; }
      const own = this.appearance(mesh) ?? studio;
      const material = this.isSeeThrough((mesh.userData.face as FaceInfo).node) ? this.seeThroughOf(own) : own;
      if (mesh.material === material) continue;
      mesh.material = material;
      if (!this.materials.has(material)) { this.materials.add(material); material.clippingPlanes = this.clipping; }
    }
    this.applyMaterialState();
  }

  /** A surface drawn over the model's faces (decals, DecalLayer.tsx): it follows style, fade and clipping like the
   *  faces' materials and is disposed with them (its texture isn't: textures are shared across models). */
  adoptMaterial(material: THREE.MeshStandardMaterial) {
    if (this.materials.has(material)) return;
    this.materials.add(material);
    material.clippingPlanes = this.clipping;
    this.applyMaterialState();
  }

  setClipping(planes: THREE.Plane[]) {
    this.clipping = planes;
    const all: THREE.Material[] = [...this.materials, ...(this.analysis ? [this.analysis] : []), this.ghostMaterial, this.edgeMaterial, this.tangentEdgeMaterial, this.freeEdgeMaterial, this.hiddenEdgeMaterial, ...this.overlayMaterials()];
    for (const material of all) { material.clippingPlanes = planes; material.needsUpdate = true; }
  }

  isClipped(point: THREE.Vector3) {
    return this.clipping.some((plane) => plane.distanceToPoint(point) < 0);
  }

  /**
   * Picks test every shown face, edge and triangle the plain three.js way when set: the reference the culled picks
   * (below) are checked against (tests/picking_speed_browser.py). Off, picking costs what is under the pointer: bodies
   * front to back by their world boxes, stopping once the nearest hit is nearer than the next box, and the triangles of
   * a big body through its own index (triangleIndex), with the very same hits.
   */
  exhaustivePicking = false;

  /** `isShown` for one pick: each ancestor's visibility is looked at once, not once per face mesh under it. Built per
   * pick, so it never goes stale whoever hides what (the tree, a gizmo, the Drawing tab's `pickFrom`). */
  private shownTest(): (object: THREE.Object3D) => boolean {
    const known = new Map<THREE.Object3D, boolean>();
    const visible = (object: THREE.Object3D | null): boolean => {
      if (!object) return true;
      let answer = known.get(object);
      if (answer === undefined) { answer = object.visible && visible(object.parent); known.set(object, answer); }
      return answer;
    };
    return (object) => !object.userData.hiddenFace && visible(object.parent);
  }

  /** The nearest shown, unclipped face hit: as `intersectObjects(shown faces).find(unclipped)`, ties in `faces` order. */
  private nearestFace(raycaster: THREE.Raycaster, shown: (object: THREE.Object3D) => boolean): THREE.Intersection | undefined {
    if (this.exhaustivePicking) return raycaster.intersectObjects(this.faces.filter(shown), false).find((hit) => !this.isClipped(hit.point));
    const ray = raycaster.ray;
    const box = new THREE.Box3();
    const at = new THREE.Vector3();
    const candidates: { mesh: THREE.Mesh; order: number; entry: number }[] = [];
    this.faces.forEach((mesh, order) => {
      if (!mesh.layers.test(raycaster.layers) || !shown(mesh)) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      // A hit lies in the mesh's world box, so it is no nearer than where the ray enters it (padded for rounding).
      box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      if (box.isEmpty()) return;
      box.expandByScalar(box.getSize(at).length() * 1e-6 + 1e-9);
      if (!ray.intersectBox(box, at)) return;
      candidates.push({ mesh, order, entry: ray.origin.distanceTo(at) });
    });
    candidates.sort((a, b) => a.entry - b.entry);
    let best: THREE.Intersection | undefined;
    let bestOrder = 0;
    for (const { mesh, order, entry } of candidates) {
      if (best && entry > best.distance) break;
      const hit = meshHits(raycaster, mesh).find((candidate) => !this.isClipped(candidate.point));
      if (hit && (!best || hit.distance < best.distance || (hit.distance === best.distance && order < bestOrder))) { best = hit; bestOrder = order; }
    }
    return best;
  }

  /** Raycasts faces, edges and vertices and returns the entity the filter prefers. */
  /** `components`: the automatic filter prefers whole components (a design while its placement, not a component, is edited). */
  /** The nearest visible, unclipped model surface under the pointer, whatever the selection filter or tool: what an
   * orbit turns about (Interaction's pivot). */
  surfacePoint(raycaster: THREE.Raycaster, camera: THREE.Camera, ndc: THREE.Vector2): THREE.Vector3 | null {
    raycaster.setFromCamera(ndc, camera);
    return this.nearestFace(raycaster, this.shownTest())?.point ?? null;
  }

  pick(raycaster: THREE.Raycaster, camera: THREE.Camera, ndc: THREE.Vector2, viewport: { width: number; height: number }, filter: SelectionFilter, measure = false, components = false): PickResult | null {
    raycaster.setFromCamera(ndc, camera);
    const shown = this.shownTest();
    const faceHit = this.nearestFace(raycaster, shown);
    let faceInfo = faceHit?.object.userData.face as FaceInfo | undefined;
    if (faceHit && faceInfo && this.faceTables.has(faceHit.object as THREE.Mesh) && faceHit.faceIndex != null) {
      faceInfo = { ...faceInfo, faceIndex: this.faceOfTriangle(faceHit.object as THREE.Mesh, faceHit.faceIndex) };
    }
    const wantComponent = filter === 'component' || (filter === 'auto' && components && !measure);
    if (wantComponent) {
      if (!faceHit || !faceInfo) return null;
      return { pick: { kind: 'component', node: faceInfo.node }, point: faceHit.point, distance: faceHit.distance };
    }
    // Measuring picks vertices and edges too (whatever the filter), except with the Faces filter: then only faces, so
    // a narrow face (a fillet, a thin rounded edge) isn't lost to the edges around it.
    if (this.hasTopology && (filter === 'auto' || filter === 'vertex' || filter === 'edge' || (measure && filter !== 'face'))) {
      if (filter === 'auto' || filter === 'vertex' || (measure && filter !== 'edge')) {
        const vertex = this.pickVertex(raycaster.ray, camera, ndc, viewport, shown, faceHit?.distance);
        if (vertex) return vertex;
        if (filter === 'vertex') return null;
      }
      const edge = this.pickEdge(raycaster, camera, shown, faceHit?.distance);
      if (edge) return edge;
      if (filter === 'edge') return null;
    }
    if (!faceHit || !faceInfo) return null;
    if (filter === 'vertex' || filter === 'edge') return null;
    return { pick: { kind: 'face', node: faceInfo.node, mesh: faceInfo.meshIndex, index: faceInfo.faceIndex }, point: faceHit.point, distance: faceHit.distance };
  }

  /**
   * `pick` with a camera of the caller's own (the Drawing tab picks through a sheet's views): `viewport` is that
   * camera's size in pixels, which edges are picked within while it picks (they're drawn at the 3D view's), and
   * `only` keeps to one placed node's geometry (a component's sheet), as if the others were hidden.
   */
  pickFrom(raycaster: THREE.Raycaster, camera: THREE.Camera, ndc: THREE.Vector2, viewport: { width: number; height: number }, filter: SelectionFilter, only?: string): PickResult | null {
    const lines = [this.edgeMaterial, this.tangentEdgeMaterial, this.freeEdgeMaterial];
    const resolutions = lines.map((material) => material.resolution.clone());
    const others = only ? this.tree[this.rootId].children.filter((id) => id !== only).map((id) => this.objects.get(id)).filter((object): object is THREE.Object3D => !!object?.visible) : [];
    for (const material of lines) material.resolution.set(viewport.width, viewport.height);
    for (const object of others) object.visible = false;
    try {
      this.root.updateWorldMatrix(true, true);
      return this.pick(raycaster, camera, ndc, viewport, filter);
    } finally {
      lines.forEach((material, i) => material.resolution.copy(resolutions[i]));
      for (const object of others) object.visible = true;
    }
  }

  /**
   * Select other (deep selection): every shown, unclipped face, edge and corner under the pointer, front to back,
   * however deep (what `pick` leaves behind the nearest face). The filter keeps to its kind (Auto takes all three;
   * Components, each component once); hidden bodies and the cut-away side of a section stay out. The nearest `limit`,
   * so a dense assembly still gives a list one can read. A corner comes before the edges and faces it lies on.
   */
  pickAll(raycaster: THREE.Raycaster, camera: THREE.Camera, ndc: THREE.Vector2, viewport: { width: number; height: number }, filter: SelectionFilter, limit = 20): PickResult[] {
    raycaster.setFromCamera(ndc, camera);
    const ray = raycaster.ray;
    const shown = this.shownTest();
    const found = new Map<string, PickResult & { rank: number }>();
    const add = (pick: Pick, point: THREE.Vector3, distance: number, rank: number) => {
      const key = JSON.stringify(pick);
      const known = found.get(key);
      if (!known || distance < known.distance) found.set(key, { pick, point, distance, rank });
    };
    if (filter === 'auto' || filter === 'face' || filter === 'component') {
      for (const mesh of this.faces) {
        if (!mesh.layers.test(raycaster.layers) || !shown(mesh)) continue;
        const info = mesh.userData.face as FaceInfo | undefined;
        if (!info) continue;
        // A ray enters and leaves a solid: each face is listed once, where it's first met. Both sides, so the faces
        // turned away (the back of a box seen face-on) are hit too.
        for (const hit of meshHits(raycaster, mesh, true)) {
          if (this.isClipped(hit.point)) continue;
          if (filter === 'component') { add({ kind: 'component', node: info.node }, hit.point, hit.distance, 2); continue; }
          const index = this.faceTables.has(mesh) && hit.faceIndex != null ? this.faceOfTriangle(mesh, hit.faceIndex) : info.faceIndex;
          add({ kind: 'face', node: info.node, mesh: info.meshIndex, index }, hit.point, hit.distance, 2);
        }
      }
    }
    if (this.hasTopology && (filter === 'auto' || filter === 'edge')) {
      raycaster.camera = camera;
      for (const set of this.edgeSets) {
        if (!set.segmentToEdge || !shown(set.visible.parent!)) continue;
        raycaster.params.Line2 = { threshold: set.tangent ? 2 : 6 };  // As `pickEdge`.
        for (const hit of raycaster.intersectObject(set.visible, false)) {
          if (hit.faceIndex == null || this.isClipped(hit.point)) continue;
          add({ kind: 'edge', node: set.node, mesh: set.meshIndex, index: set.segmentToEdge[hit.faceIndex] }, hit.point, hit.distance, 1);
        }
      }
    }
    if (this.hasTopology && (filter === 'auto' || filter === 'vertex')) {
      const radius = 9;  // Pixels, as `pickVertex`.
      const world = new THREE.Vector3();
      const projected = new THREE.Vector3();
      const reach = new THREE.Sphere();
      const cameraPosition = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const pixelAt = (distance: number) => camera instanceof THREE.OrthographicCamera
        ? (camera.top - camera.bottom) / camera.zoom / viewport.height
        : 2 * distance * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2) / viewport.height;
      const visited = new Set<string>();
      for (const set of this.edgeSets) {
        const frame = set.visible.parent;
        if (!frame || visited.has(`${frame.uuid}:${set.meshIndex}`) || !shown(frame)) continue;
        visited.add(`${frame.uuid}:${set.meshIndex}`);
        const vertices = this.topologyFor(set.meshIndex)?.vertices ?? [];
        if (!vertices.length) continue;
        reach.copy(this.vertexSphere(set.meshIndex, vertices)).applyMatrix4(frame.matrixWorld);
        if (ray.distanceToPoint(reach.center) - reach.radius > 2 * radius * pixelAt(reach.center.distanceTo(cameraPosition) + reach.radius)) continue;
        const hidden = this.hiddenVertices.get(set.meshIndex);
        const corners = this.cornersOf(set.meshIndex);
        vertices.forEach((vertex, index) => {
          if (hidden?.has(index) || (corners && !corners.has(index))) return;
          world.set(vertex[0], vertex[1], vertex[2]).applyMatrix4(frame.matrixWorld);
          if (this.isClipped(world)) return;
          projected.copy(world).project(camera);
          if (Math.abs(projected.z) > 1) return;  // Behind the camera or past its far plane.
          if (Math.hypot((projected.x - ndc.x) * viewport.width / 2, (projected.y - ndc.y) * viewport.height / 2) >= radius) return;
          // Depth along the pick ray, as the face and edge hits are measured.
          add({ kind: 'vertex', node: set.node, mesh: set.meshIndex, index }, world.clone(), world.clone().sub(ray.origin).dot(ray.direction), 0);
        });
      }
    }
    // Front to back; within a hair of the same depth, a corner before its edges and an edge before its faces.
    const tolerance = this.depthTolerance();
    const depth = (result: { distance: number }) => Math.round(result.distance / tolerance);
    return [...found.values()]
      .sort((a, b) => depth(a) - depth(b) || a.rank - b.rank || a.distance - b.distance)
      .slice(0, limit)
      .map(({ pick, point, distance }) => ({ pick, point, distance }));
  }

  private pickEdge(raycaster: THREE.Raycaster, camera: THREE.Camera, shown: (object: THREE.Object3D) => boolean, faceDistance?: number): PickResult | null {
    raycaster.camera = camera;
    // How far off a line (in pixels, past half its width) a click still takes it. Tangent edges, the faint lines
    // between smooth faces (a fillet's sides), take only a near miss: they bound curved faces, often narrow ones, that a
    // click near them is as likely meant for.
    const thresholdOf = (tangent?: boolean) => (tangent ? 2 : 6);
    const sets = this.edgeSets.filter((set) => set.segmentToEdge && shown(set.visible.parent!));
    // The nearest unclipped edge hit, kept only if it isn't behind the face hit.
    const cut = faceDistance === undefined ? Infinity : faceDistance + this.depthTolerance();
    let found: { hit: THREE.Intersection; set: EdgeSet } | undefined;
    if (this.exhaustivePicking) {
      const hits = [true, false].flatMap((tangent) => {
        raycaster.params.Line2 = { threshold: thresholdOf(tangent) };
        return raycaster.intersectObjects(sets.filter((set) => !!set.tangent === tangent).map((set) => set.visible), false);
      }).sort((a, b) => a.distance - b.distance);
      const hit = hits.filter((candidate) => !this.isClipped(candidate.point)).find((candidate) => candidate.distance <= cut);
      if (hit) found = { hit, set: sets.find((candidate) => candidate.visible === hit.object)! };
    } else {
      // Edge sets front to back by their world boxes grown by the pick width: a hit is the point on the ray nearest a
      // segment, within half a line's width plus the threshold of it on screen (LineSegments2), so it lies inside the
      // grown box (grown well past that) and no nearer than where the ray enters it.
      const ray = raycaster.ray;
      const box = new THREE.Box3();
      const at = new THREE.Vector3();
      const center = new THREE.Vector3();
      const candidates: { set: EdgeSet; order: number; entry: number }[] = [];
      sets.forEach((set, order) => {
        const line = set.visible;
        if (!line.layers.test(raycaster.layers)) return;
        if (!line.geometry.boundingBox) line.geometry.computeBoundingBox();
        box.copy(line.geometry.boundingBox!).applyMatrix4(line.matrixWorld);
        if (box.isEmpty()) return;
        const material = line.material as LineMaterial;
        const far = box.getCenter(center).distanceTo(ray.origin) + box.getSize(at).length() / 2;
        // World size of a pixel there, the larger of across and up (the line's resolution needn't match the camera's aspect).
        const { x: across, y: up } = material.resolution;
        const pixel = camera instanceof THREE.OrthographicCamera
          ? Math.max((camera.right - camera.left) / across, (camera.top - camera.bottom) / up) / camera.zoom
          : 2 * far * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2) * Math.max((camera as THREE.PerspectiveCamera).aspect / across, 1 / up);
        const margin = 2 * (material.linewidth + thresholdOf(set.tangent)) * pixel;
        let entry = 0;
        if (Number.isFinite(margin) && !material.worldUnits) {
          box.expandByScalar(margin + box.getSize(at).length() * 1e-6 + 1e-9);
          if (!ray.intersectBox(box, at)) return;
          entry = ray.origin.distanceTo(at);
        }
        if (entry > cut) return;
        candidates.push({ set, order, entry });
      });
      candidates.sort((a, b) => a.entry - b.entry);
      let bestOrder = 0;
      for (const { set, order, entry } of candidates) {
        if (found && entry > found.hit.distance) break;
        raycaster.params.Line2 = { threshold: thresholdOf(set.tangent) };
        const hit = raycaster.intersectObject(set.visible, false).find((candidate) => !this.isClipped(candidate.point));
        if (!hit || hit.distance > cut) continue;
        if (!found || hit.distance < found.hit.distance || (hit.distance === found.hit.distance && order < bestOrder)) { found = { hit, set }; bestOrder = order; }
      }
    }
    if (!found || found.hit.faceIndex === undefined || found.hit.faceIndex === null) return null;
    const { hit, set } = found;
    const index = set.segmentToEdge![hit.faceIndex!];
    return { pick: { kind: 'edge', node: set.node, mesh: set.meshIndex, index }, point: hit.point, distance: hit.distance };
  }

  private pickVertex(ray: THREE.Ray, camera: THREE.Camera, ndc: THREE.Vector2, viewport: { width: number; height: number }, shown: (object: THREE.Object3D) => boolean, faceDistance?: number): PickResult | null {
    let best: PickResult | null = null;
    let bestPixels = 9;
    const world = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const reach = new THREE.Sphere();
    const cameraPosition = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const tolerance = this.depthTolerance();
    // World size of a pixel at a distance from the camera.
    const pixelAt = (distance: number) => camera instanceof THREE.OrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom / viewport.height
      : 2 * distance * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2) / viewport.height;
    const visited = new Set<string>();
    for (const set of this.edgeSets) {
      const frame = set.visible.parent;
      // Sharp and tangent edge sets share one body's vertices.
      if (!frame || visited.has(`${frame.uuid}:${set.meshIndex}`) || !shown(frame)) continue;
      visited.add(`${frame.uuid}:${set.meshIndex}`);
      const vertices = this.topologyFor(set.meshIndex)?.vertices ?? [];
      if (!vertices.length) continue;
      // Skip whole bodies that can't hold a vertex near the pointer, before projecting every vertex: too far off the
      // ray to come within the pick radius on screen (with room to spare off-axis), or entirely behind the face hit.
      reach.copy(this.vertexSphere(set.meshIndex, vertices)).applyMatrix4(frame.matrixWorld);
      const far = reach.center.distanceTo(cameraPosition) + reach.radius;
      if (ray.distanceToPoint(reach.center) - reach.radius > 2 * bestPixels * pixelAt(far)) continue;
      if (faceDistance !== undefined && camera instanceof THREE.PerspectiveCamera && far - 2 * reach.radius > faceDistance + tolerance) continue;
      const hidden = this.hiddenVertices.get(set.meshIndex);
      const corners = this.cornersOf(set.meshIndex);
      vertices.forEach((vertex, index) => {
        if (hidden?.has(index) || (corners && !corners.has(index))) return;
        world.set(vertex[0], vertex[1], vertex[2]).applyMatrix4(frame.matrixWorld);
        if (this.isClipped(world)) return;
        projected.copy(world).project(camera);
        const pixels = Math.hypot((projected.x - ndc.x) * viewport.width / 2, (projected.y - ndc.y) * viewport.height / 2);
        if (pixels >= bestPixels) return;
        const distance = camera instanceof THREE.OrthographicCamera ? Math.abs(projected.z) : world.distanceTo(cameraPosition);
        // Behind the face under the pointer: hidden. Depth along the pick ray, as the face hit's distance is measured
        // (so orthographic views hide back vertices too, as edges already are).
        if (faceDistance !== undefined && world.clone().sub(ray.origin).dot(ray.direction) > faceDistance + tolerance) return;
        bestPixels = pixels;
        best = { pick: { kind: 'vertex', node: set.node, mesh: set.meshIndex, index }, point: world.clone(), distance };
      });
    }
    return best;
  }

  private readonly corners = new Map<number, Set<number> | null>();

  /** A mesh's pickable vertices (null: every vertex is). A compactly described mesh's are those on its kept (crease)
   * edges, not every triangle corner of a mesh imported as STEP. Otherwise a vertex is pickable where a drawn edge
   * starts or ends: not a seam's ends or a closed edge's only vertex (a full circle's), nor a sphere's or cone's pole.
   * Those lie on smooth faces, drawn as nothing, and would take a click meant for the curved face around them. */
  private cornersOf(meshIndex: number): Set<number> | null {
    if (!this.corners.has(meshIndex)) {
      const entry = this.topologyFor(meshIndex);
      let corners: Set<number> | null = null;
      if (entry?.compact) corners = new Set(entry.edges.flatMap((edge) => edge.vertices ?? []));
      else if (entry && entry.edges.length && entry.edges.every((edge) => edge.vertices)) {
        corners = new Set(entry.edges.filter((edge) => !edge.seam && edge.vertices!.length === 2).flatMap((edge) => edge.vertices!));
      }
      this.corners.set(meshIndex, corners);
    }
    return this.corners.get(meshIndex)!;
  }

  private vertexSphere(meshIndex: number, vertices: Vec3[]): THREE.Sphere {
    let sphere = this.vertexSpheres.get(meshIndex);
    if (!sphere) {
      sphere = new THREE.Sphere().setFromPoints(vertices.map((vertex) => new THREE.Vector3(vertex[0], vertex[1], vertex[2])));
      this.vertexSpheres.set(meshIndex, sphere);
    }
    return sphere;
  }

  private depthTolerance() {
    const box = this.bounds(false);
    return Math.max(box.getSize(new THREE.Vector3()).length() * 0.004, 0.01);
  }

  /** World-space geometry for a pick, used by measurement and the properties panel. */
  worldEdgePoints(pick: EntityPick): THREE.Vector3[] {
    const edge = this.topologyFor(pick.mesh)?.edges[pick.index];
    const frame = this.frameFor(pick.node, pick.mesh);
    if (!edge || !frame) return [];
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < edge.points.length; i += 3) points.push(new THREE.Vector3(edge.points[i], edge.points[i + 1], edge.points[i + 2]).applyMatrix4(frame.matrixWorld));
    return points;
  }

  frameFor(node: string, meshIndex: number): THREE.Object3D | undefined {
    return this.edgeSets.find((set) => set.node === node && set.meshIndex === meshIndex)?.visible.parent ?? this.meshFrame(node, meshIndex);
  }

  setHighlights(selection: Pick[], hover: Pick | null, measured: Pick[] = [], hoverAlso: Pick[] = []) {
    for (const overlay of this.overlays) {
      overlay.removeFromParent();
      if (overlay instanceof LineSegments2 || overlay instanceof THREE.Points) overlay.geometry.dispose();
      else if (overlay.userData.ownGeometry) (overlay as THREE.Mesh).geometry.dispose();
    }
    this.overlays.length = 0;
    const entries: [Pick, OverlayMode][] = [...selection.map((pick): [Pick, OverlayMode] => [pick, 'select']), ...measured.map((pick): [Pick, OverlayMode] => [pick, 'measure'])];
    const keys = new Set(entries.map(([pick]) => JSON.stringify(pick)));
    for (const pick of hover ? [hover, ...hoverAlso] : hoverAlso) if (!keys.has(JSON.stringify(pick))) entries.push([pick, 'hover']);
    // Faces of merged bodies: one overlay per body and mode (a whole body can be thousands of faces).
    const mergedFaces = new Map<string, { merged: THREE.Mesh; mode: OverlayMode; faces: number[] }>();
    for (const [pick, mode] of entries) {
      const merged = pick.kind === 'face' ? this.mergedAt(pick.node, pick.mesh, pick.index) : undefined;
      if (!merged || pick.kind !== 'face') { this.addOverlay(pick, mode); continue; }
      const key = `${merged.uuid}:${mode}`;
      const group = mergedFaces.get(key) ?? { merged, mode, faces: [] };
      group.faces.push(pick.index);
      mergedFaces.set(key, group);
    }
    for (const { merged, mode, faces } of mergedFaces.values()) this.addMergedOverlay(merged, faces, mode);
  }

  private addMergedOverlay(merged: THREE.Mesh, faces: number[], mode: OverlayMode) {
    const table = this.faceTables.get(merged)!;
    const wanted = [...new Set(faces.map((face) => face - table.base))].filter((face) => face >= 0 && face < table.count).sort((a, b) => a - b);
    if (!wanted.length) return;
    const overlay = this.faceOverlayMesh(subsetGeometry(merged.geometry, table, wanted), mode);
    overlay.userData.ownGeometry = true;
    merged.add(overlay);
    this.overlays.push(overlay);
  }

  /** A face highlight, with its fainter twin (a child sharing the geometry) where other geometry covers it. */
  private faceOverlayMesh(geometry: THREE.BufferGeometry, mode: OverlayMode): THREE.Mesh {
    const overlay = new THREE.Mesh(geometry, this.faceOverlay[mode]);
    const hidden = new THREE.Mesh(geometry, this.faceHidden[mode]);
    for (const mesh of [overlay, hidden]) {
      mesh.renderOrder = 3;
      mesh.raycast = () => {};
    }
    overlay.add(hidden);
    return overlay;
  }

  private overlayMaterials(): THREE.Material[] {
    return [this.faceOverlay, this.faceHidden, this.edgeOverlay, this.edgeHidden, this.pointOverlay, this.pointHidden].flatMap((set) => Object.values(set));
  }

  private addOverlay(pick: Pick, mode: OverlayMode) {
    if (pick.kind === 'component') {
      const object = this.objects.get(pick.node);
      object?.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.face && !child.userData.lazyFace) this.addFaceOverlay(child, mode);
      });
      return;
    }
    if (pick.kind === 'face') {
      const mesh = this.faceMesh(pick.node, pick.mesh, pick.index);
      if (mesh) this.addFaceOverlay(mesh, mode);
      return;
    }
    const frame = this.frameFor(pick.node, pick.mesh);
    const topology = this.topologyFor(pick.mesh);
    if (!frame || !topology) return;
    if (pick.kind === 'edge') {
      const edge = topology.edges[pick.index];
      if (!edge) return;
      const geometry = new LineSegmentsGeometry().setPositions(polylineSegments(edge.points));
      const line = new LineSegments2(geometry, this.edgeOverlay[mode]);
      const hidden = new LineSegments2(geometry, this.edgeHidden[mode]);
      line.renderOrder = hidden.renderOrder = 10;
      line.add(hidden);
      frame.add(line);
      this.overlays.push(line);
    } else {
      const vertex = topology.vertices[pick.index];
      if (!vertex) return;
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertex, 3));
      const points = new THREE.Points(geometry, this.pointOverlay[mode]);
      const hidden = new THREE.Points(geometry, this.pointHidden[mode]);
      points.renderOrder = hidden.renderOrder = 11;
      points.add(hidden);
      frame.add(points);
      this.overlays.push(points);
    }
  }

  private addFaceOverlay(mesh: THREE.Mesh, mode: OverlayMode) {
    const overlay = this.faceOverlayMesh(mesh.geometry, mode);
    mesh.add(overlay);
    this.overlays.push(overlay);
  }

  /** Briefly brightens the selection overlay so a click feels acknowledged. */
  flashSelection(invalidate: () => void) {
    const face = this.faceOverlay.select, hiddenFace = this.faceHidden.select;
    const edges = [this.edgeOverlay.select, this.edgeHidden.select];
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / 260, 1);
      const k = 1 - (1 - t) ** 3;
      face.opacity = 0.72 + (FACE_OPACITY - 0.72) * k;
      hiddenFace.opacity = face.opacity * (HIDDEN_FACE_OPACITY / FACE_OPACITY);
      for (const edge of edges) edge.linewidth = 5.5 + (3.5 - 5.5) * k;
      invalidate();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  setSelectionColors(select: string, hover: string) {
    for (const set of [this.faceOverlay, this.faceHidden, this.edgeOverlay, this.edgeHidden, this.pointOverlay, this.pointHidden]) {
      set.select.color.set(select);
      set.hover.color.set(hover);
    }
  }

  /** The scene as its animation has it `seconds` in (clamped to the clip). */
  setAnimationTime(seconds: number) {
    if (!this.mixer) return;
    this.mixer.setTime(this.animationStart + Math.min(Math.max(seconds, 0), this.animationDuration));
    this.root.updateMatrixWorld(true);
  }

  dispose() {
    this.mixer?.stopAllAction();
    this.setHighlights([], null);
    this.root.removeFromParent();
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof LineSegments2) object.geometry.dispose();
    });
    for (const material of this.materials) material.dispose();
    this.lazyMaterial.dispose();
    for (const material of [this.edgeMaterial, this.tangentEdgeMaterial, this.freeEdgeMaterial, this.hiddenEdgeMaterial, ...this.overlayMaterials()]) material.dispose();
    this.pointOverlay.select.map?.dispose();
  }
}

/** A small geometry of just some faces of a merged body (local face numbers: their vertex ranges copied, indices
 * rebased), in the part's frame. */
function subsetGeometry(source: THREE.BufferGeometry, table: FaceTable, faces: number[]): THREE.BufferGeometry {
  let vertices = 0, indices = 0;
  for (const face of faces) {
    vertices += table.vertStart[face + 1] - table.vertStart[face];
    indices += (table.triStart[face + 1] - table.triStart[face]) * 3;
  }
  const geometry = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name) as THREE.BufferAttribute;
    const size = attribute.itemSize;
    const values = new (attribute.array.constructor as Float32ArrayConstructor)(vertices * size);
    let at = 0;
    for (const face of faces) {
      const from = table.vertStart[face] * size, to = table.vertStart[face + 1] * size;
      values.set((attribute.array as Float32Array).subarray(from, to), at);
      at += to - from;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, size, attribute.normalized));
  }
  const index = source.index!.array;
  const local = new Uint32Array(indices);
  let at = 0, base = 0;
  for (const face of faces) {
    const v0 = table.vertStart[face];
    for (let i = table.triStart[face] * 3; i < table.triStart[face + 1] * 3; i++) local[at++] = index[i] - v0 + base;
    base += table.vertStart[face + 1] - v0;
  }
  geometry.setIndex(new THREE.BufferAttribute(local, 1));
  return geometry;
}

function isIdentity(matrix: THREE.Matrix4) {
  return matrix.equals(new THREE.Matrix4());
}

/** Meshes of fewer triangles are raycast as three.js does, testing each one; bigger ones through a triangleIndex. */
const INDEX_TRIANGLES = 256;
const INDEX_LEAF = 8;

/**
 * A bounding volume tree over a geometry's triangles, in its own frame, made on its first pick and shared by every
 * mesh drawing that geometry (instances, merged bodies): node boxes (min xyz, max xyz) and per node either its two
 * children (`count` 0: children at `first` and `first + 1`) or a run of `triangles`.
 */
interface TriangleIndex { position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; positionVersion: number; indexVersion: number; boxes: Float64Array; nodes: Uint32Array; triangles: Uint32Array; pad: number }
const triangleIndexes = new WeakMap<THREE.BufferGeometry, TriangleIndex>();

/** Bumped by three.js whenever an attribute's values change (an interleaved one's through its buffer). */
function versionOf(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  return attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.version : attribute.version;
}

function buildTriangleIndex(geometry: THREE.BufferGeometry): TriangleIndex {
  const index = geometry.index!;
  const position = geometry.getAttribute('position');
  const count = Math.floor(index.count / 3);
  const triangles = new Uint32Array(count);
  const centers = new Float32Array(count * 3);
  const vertex = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    triangles[t] = t;
    for (let c = 0; c < 3; c++) {
      vertex.fromBufferAttribute(position, index.getX(3 * t + c));
      centers[3 * t] += vertex.x / 3; centers[3 * t + 1] += vertex.y / 3; centers[3 * t + 2] += vertex.z / 3;
    }
  }
  // Every split leaves both halves some triangles, so there are under 2 × count nodes; most leaves hold several.
  let boxes = new Float64Array(6 * Math.max(64, Math.ceil(count / 2)));
  let nodes = new Uint32Array(boxes.length / 3);
  let made = 1;
  const stack: [number, number, number][] = [[0, 0, count]];
  while (stack.length) {
    if (6 * (made + 2) > boxes.length) {
      const grown = new Float64Array(boxes.length * 2); grown.set(boxes); boxes = grown;
      const links = new Uint32Array(nodes.length * 2); links.set(nodes); nodes = links;
    }
    const [node, first, length] = stack.pop()!;
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    const centerLow = [Infinity, Infinity, Infinity], centerHigh = [-Infinity, -Infinity, -Infinity];
    for (let k = first; k < first + length; k++) {
      const t = triangles[k];
      for (let c = 0; c < 3; c++) {
        vertex.fromBufferAttribute(position, index.getX(3 * t + c));
        for (let axis = 0; axis < 3; axis++) {
          const value = vertex.getComponent(axis);
          if (value < low[axis]) low[axis] = value;
          if (value > high[axis]) high[axis] = value;
        }
      }
      for (let axis = 0; axis < 3; axis++) {
        const center = centers[3 * t + axis];
        if (center < centerLow[axis]) centerLow[axis] = center;
        if (center > centerHigh[axis]) centerHigh[axis] = center;
      }
    }
    boxes[6 * node] = low[0]; boxes[6 * node + 1] = low[1]; boxes[6 * node + 2] = low[2];
    boxes[6 * node + 3] = high[0]; boxes[6 * node + 4] = high[1]; boxes[6 * node + 5] = high[2];
    if (length <= INDEX_LEAF) { nodes[2 * node] = first; nodes[2 * node + 1] = length; continue; }
    // Split at the middle of the longest side of the triangles' centers; halves by count when that leaves one empty.
    const extents = [0, 1, 2].map((axis) => centerHigh[axis] - centerLow[axis]);
    const axis = extents.indexOf(Math.max(...extents));
    const middle = (centerLow[axis] + centerHigh[axis]) / 2;
    let split = first;
    for (let k = first; k < first + length; k++) {
      if (centers[3 * triangles[k] + axis] < middle) { const t = triangles[k]; triangles[k] = triangles[split]; triangles[split] = t; split++; }
    }
    if (split === first || split === first + length) split = first + (length >> 1);
    const left = made;
    made += 2;
    nodes[2 * node] = left; nodes[2 * node + 1] = 0;
    stack.push([left + 1, split, first + length - split], [left, first, split - first]);
  }
  const size = Math.hypot(boxes[3] - boxes[0], boxes[4] - boxes[1], boxes[5] - boxes[2]);
  return { position, positionVersion: versionOf(position), indexVersion: index.version, boxes: boxes.slice(0, 6 * made), nodes: nodes.slice(0, 2 * made), triangles, pad: size * 1e-6 + 1e-9 };
}

/** A big mesh's triangle index (made once per geometry), or null where three.js's own raycast must do: small meshes, and
 * what it handles that the index doesn't (several materials, morphs, skinning, unindexed or odd draw ranges). */
function triangleIndexOf(mesh: THREE.Mesh): TriangleIndex | null {
  const geometry = mesh.geometry;
  const index = geometry.index;
  if (!index || index.count < INDEX_TRIANGLES * 3 || index.count % 3 || geometry.drawRange.start % 3 || mesh.material === undefined || Array.isArray(mesh.material)
    || geometry.morphAttributes.position || (mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.raycast !== THREE.Mesh.prototype.raycast) return null;
  const position = geometry.getAttribute('position');
  let built = triangleIndexes.get(geometry);
  if (!built || built.position !== position || built.positionVersion !== versionOf(position) || built.indexVersion !== index.version) {
    built = buildTriangleIndex(geometry);
    triangleIndexes.set(geometry, built);
  }
  return built;
}

/**
 * One mesh's hits, nearest first: what `raycaster.intersectObject(mesh, false)` gives (three.js Mesh.raycast: the same
 * sphere and box checks, `Ray.intersectTriangle` with the material's side, world point and distance, `faceIndex`, ties
 * in triangle order), but testing only the triangles whose index boxes the ray passes through. `bothSides` tests
 * every triangle from both sides whatever the material draws (Select other: a solid's faces turned away from the
 * camera, its back and the faces inside it, are one-sided and a plain ray passes through them).
 */
function meshHits(raycaster: THREE.Raycaster, mesh: THREE.Mesh, bothSides = false): THREE.Intersection[] {
  const built = triangleIndexOf(mesh);
  if (!built) {
    if (!bothSides) return raycaster.intersectObject(mesh, false);
    // three.js culls by the material's side: draw-side swapped for the (synchronous) cast only, then put back.
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
    const sides = materials.map((material) => material.side);
    materials.forEach((material) => { material.side = THREE.DoubleSide; });
    try { return raycaster.intersectObject(mesh, false); }
    finally { materials.forEach((material, i) => { material.side = sides[i]; }); }
  }
  if (!mesh.layers.test(raycaster.layers)) return [];
  const geometry = mesh.geometry;
  const material = mesh.material as THREE.Material;
  const side = bothSides ? THREE.DoubleSide : material.side;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
  const ray = raycaster.ray.clone().recast(raycaster.near);
  const at = new THREE.Vector3();
  if (!sphere.containsPoint(ray.origin)) {
    if (ray.intersectSphere(sphere, at) === null) return [];
    if (ray.origin.distanceToSquared(at) > (raycaster.far - raycaster.near) ** 2) return [];
  }
  const local = raycaster.ray.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  if (geometry.boundingBox !== null && !local.intersectsBox(geometry.boundingBox)) return [];
  const index = geometry.index!;
  const position = built.position;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(index.count, geometry.drawRange.start + geometry.drawRange.count);
  const { boxes, nodes, triangles, pad } = built;
  const box = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const hits: THREE.Intersection[] = [];
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    box.min.set(boxes[6 * node] - pad, boxes[6 * node + 1] - pad, boxes[6 * node + 2] - pad);
    box.max.set(boxes[6 * node + 3] + pad, boxes[6 * node + 4] + pad, boxes[6 * node + 5] + pad);
    if (!local.intersectsBox(box)) continue;
    const first = nodes[2 * node], length = nodes[2 * node + 1];
    if (!length) { stack.push(first, first + 1); continue; }
    for (let k = first; k < first + length; k++) {
      const t = triangles[k];
      if (3 * t < start || 3 * t >= end) continue;
      a.fromBufferAttribute(position, index.getX(3 * t));
      b.fromBufferAttribute(position, index.getX(3 * t + 1));
      c.fromBufferAttribute(position, index.getX(3 * t + 2));
      const hit = side === THREE.BackSide ? local.intersectTriangle(c, b, a, true, at) : local.intersectTriangle(a, b, c, side === THREE.FrontSide, at);
      if (!hit) continue;
      const point = at.clone().applyMatrix4(mesh.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(point);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      hits.push({ distance, point, object: mesh, faceIndex: t });
    }
  }
  return hits.sort((x, y) => x.distance - y.distance || x.faceIndex! - y.faceIndex!);
}

function polylineSegments(points: number[]): number[] {
  const segments: number[] = [];
  for (let i = 0; i + 5 < points.length; i += 3) segments.push(points[i], points[i + 1], points[i + 2], points[i + 3], points[i + 4], points[i + 5]);
  return segments;
}

/** An open edge of a surface body: one face, not a seam, on a face drawn as a surface (`surfaceFace`). */
export function freeSurfaceEdge(edge: TopologyEdge, surfaceFace: (face: number) => boolean): boolean {
  return !edge.seam && edge.faces?.length === 1 && surfaceFace(edge.faces[0]);
}

function topologyEdges(entry: TopologyMesh, tangent: boolean, skip?: (edge: TopologyEdge) => boolean) {
  const positions: number[] = [];
  const segmentToEdge: number[] = [];
  entry.edges.forEach((edge, index) => {
    if (edge.seam || !!edge.smooth !== tangent || skip?.(edge)) return;
    const segments = polylineSegments(edge.points);
    positions.push(...segments);
    for (let i = 0; i < segments.length / 6; i++) segmentToEdge.push(index);
  });
  return { positions, segmentToEdge: Uint32Array.from(segmentToEdge) };
}

/** Sharp edges of a whole body; face boundaries along smooth transitions and seams are dropped. */
function meshEdges(faceMeshes: THREE.Mesh[]): number[] {
  const geometries = faceMeshes.map((mesh) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', mesh.geometry.getAttribute('position'));
    if (mesh.geometry.index) geometry.setIndex(mesh.geometry.index);
    return geometry;
  });
  const merged = mergeGeometries(geometries, false);
  if (!merged) return [];
  const edges = new THREE.EdgesGeometry(merged, 24);
  const positions = Array.from(edges.getAttribute('position').array as Float32Array);
  merged.dispose();
  edges.dispose();
  return positions;
}

function makeDotTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.beginPath();
  context.arc(32, 32, 24, 0, Math.PI * 2);
  context.fillStyle = '#ffffff';
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = 'rgba(10,14,18,0.9)';
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const sourceKey = (instance: DesignInstance) => `${instance.link ? 'link' : 'component'}:${instance.component}`;
