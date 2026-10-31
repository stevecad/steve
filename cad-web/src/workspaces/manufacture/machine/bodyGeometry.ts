/**
 * Collision bodies' geometry for the machine preview and the forms (docs/MANUFACTURING_MACHINE_SOLIDS.md,
 * docs/MANUFACTURING_MACHINE_MESHES.md):
 * - a CAD body: one solid of a saved STEVE part or design at an exact revision. Its display mesh is that revision's
 *   full-build body mesh (GET /v1/builds/{id}/body-mesh/{i}), in design coordinates like the pinned body; the
 *   backend's own capture and checks use the retained BRep, never this mesh.
 * - an STL body: the file's bytes, uploaded (content-addressed) to POST /v1/manufacturing/machine-meshes; the upload
 *   stores it, the first job that uses it validates it. The browser keeps the parsed mesh it uploaded this session
 *   (there's no read-back route), so a body from elsewhere is drawn as its bounds.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Api, withPrintMeshes, type Build, type BodyMesh } from '@/lib/api';
import { MfgError } from '../api';

export interface ArtifactRef { sha256: string; bytes: number; media_type: string }
export interface Bounds { minimum_mm: [number, number, number]; maximum_mm: [number, number, number] }
export interface BodySource { version?: 1; document_id: string; revision: number; branch?: string; overrides?: Record<string, number>; instances?: string[]; body: string }
export interface CollisionBody {
  id: string; node: string; representation: 'solid_box' | 'enclosing_box' | 'brep' | 'mesh';
  frame?: { origin_mm?: [number, number, number]; x?: [number, number, number]; y?: [number, number, number]; z?: [number, number, number] } | null;
  bounds?: Bounds | null; artifact?: ArtifactRef | null; geometry_source?: BodySource | null; error_bound_mm: number;
}

const loader = new STLLoader();

/** Bounds that enclose a geometry, rounded outward to a micrometre so they still enclose it. */
export function boundsOf(geometry: THREE.BufferGeometry): Bounds {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const down = (value: number) => Math.floor(value * 1e6) / 1e6, up = (value: number) => Math.ceil(value * 1e6) / 1e6;
  return { minimum_mm: [down(box.min.x), down(box.min.y), down(box.min.z)], maximum_mm: [up(box.max.x), up(box.max.y), up(box.max.z)] };
}

/* ── STL uploads ── */

const uploaded = new Map<string, THREE.BufferGeometry>();
export const uploadedMesh = (sha256: string | undefined) => (sha256 ? uploaded.get(sha256) ?? null : null);

/** Reads an STL file (binary or ASCII) in the browser: a plain error if it isn't one. */
export function parseStl(data: ArrayBuffer): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  try { geometry = loader.parse(data); } catch { throw new Error('This file can’t be read as an STL mesh.'); }
  const count = geometry.getAttribute('position')?.count ?? 0;
  if (count < 12) throw new Error('This STL has no closed surface in it (fewer than four triangles).');
  // Facet normals in a file are optional (often zero): light it by its triangles instead.
  geometry.computeVertexNormals();
  return geometry;
}

/** Uploads an STL (millimetres) and returns its stored identity, its parsed mesh and enclosing bounds. */
export async function uploadStl(file: File): Promise<{ artifact: ArtifactRef; geometry: THREE.BufferGeometry; bounds: Bounds; triangles: number }> {
  if (file.size > 64 * 1024 * 1024) throw new Error('That STL is over 64 MB, the most one machine body takes. Simplify it or split it into bodies.');
  const data = await file.arrayBuffer();
  const geometry = parseStl(data);
  let response: Response;
  try {
    response = await fetch('/v1/manufacturing/machine-meshes?units=mm', { method: 'POST', headers: { 'Content-Type': 'model/stl' }, body: data });
  } catch {
    throw new MfgError(0, 'network', 'The manufacturing service could not be reached.');
  }
  const payload = await response.json().catch(() => null) as { artifact?: ArtifactRef; detail?: { code?: string; message?: string } | string } | null;
  if (!response.ok || !payload?.artifact) {
    const detail = payload?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message ?? `The upload failed (${response.status}).`;
    throw new MfgError(response.status, typeof detail === 'object' && detail?.code ? detail.code : 'upload_failed', message);
  }
  uploaded.set(payload.artifact.sha256, geometry);
  return { artifact: payload.artifact, geometry, bounds: boundsOf(geometry), triangles: geometry.getAttribute('position').count / 3 };
}

/* ── CAD bodies ── */

export interface CadBody extends BodyMesh { index: number }
export interface CadRevision { documentId: string; revision: number; name: string; kind: string; build: Build; bodies: CadBody[] }

const revisions = new Map<string, Promise<CadRevision>>();

async function settle(build: Build): Promise<Build> {
  let current = build;
  for (let attempt = 0; current.status !== 'succeeded' && current.status !== 'failed' && attempt < 600; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await Api.build(current.id);
  }
  if (current.status !== 'succeeded') throw new Error(current.error?.trim().split('\n').pop() || 'The part didn’t build, so its bodies can’t be listed.');
  return current;
}

/**
 * A saved revision's bodies, each with its display mesh in design coordinates. Uses the revision's own full build
 * when it has one; otherwise builds that revision's saved code in full (nothing is saved).
 */
export function cadRevision(documentId: string, revision: number): Promise<CadRevision> {
  const key = `${documentId}:${revision}`;
  let pending = revisions.get(key);
  if (!pending) {
    pending = (async () => {
      const head = await Api.document(documentId);
      let snapshot: { name: string; kind: string; code: string; files?: Record<string, string>; links?: Record<string, unknown>; preview_build_id?: string | null } = head;
      if (head.revision !== revision) {
        const history = await fetch(`/v1/documents/${documentId}/history?limit=100`).then((response) => response.json()) as { revisions: { revision: number; commit_id: string }[] };
        const commit = history.revisions.find((item) => item.revision === revision)?.commit_id;
        if (!commit) throw new Error(`Revision ${revision} of “${head.name}” isn’t in its history.`);
        snapshot = (await fetch(`/v1/documents/${documentId}/history/${commit}`).then((response) => response.json()) as { document: typeof snapshot }).document;
      }
      let build = head.revision === revision && head.preview_build_id ? await Api.build(head.preview_build_id) : null;
      if (!build?.metadata?.body_meshes?.length) {
        if (build?.status !== 'succeeded' || build.mode === 'preview') {
          build = await settle(await Api.submit({ kind: snapshot.kind as Build['kind'], name: snapshot.name, code: snapshot.code, files: snapshot.files, links: snapshot.links as never, mode: 'full' }));
        }
        build = await withPrintMeshes(build);  // Made on demand for the full build, the first time anything asks.
      }
      const bodies = (build.metadata?.body_meshes ?? []).map((item, index) => ({ ...item, index }));
      if (!bodies.length) throw new Error(`“${head.name}” revision ${revision} has no solid bodies.`);
      return { documentId, revision, name: head.name, kind: head.kind, build, bodies };
    })();
    pending.catch(() => revisions.delete(key));
    revisions.set(key, pending);
  }
  return pending;
}

/** The instance path a body mesh names, as a body source's `instances` (a part's bodies have none). */
export const instancesOf = (body: BodyMesh): string[] => (body.instance === 'part' ? [] : body.instance.split(/[/.]/).filter(Boolean));
export const sameBody = (body: BodyMesh, source: BodySource) => body.body === source.body && instancesOf(body).join('/') === (source.instances ?? []).join('/');

const meshes = new Map<string, Promise<THREE.BufferGeometry>>();
export function cadMesh(build: string, index: number): Promise<THREE.BufferGeometry> {
  const key = `${build}:${index}`;
  let pending = meshes.get(key);
  if (!pending) {
    pending = fetch(`/v1/builds/${build}/body-mesh/${index}`).then(async (response) => {
      if (!response.ok) throw new Error(`The body’s mesh couldn’t be read (${response.status}).`);
      return parseStl(await response.arrayBuffer());
    });
    pending.catch(() => meshes.delete(key));
    meshes.set(key, pending);
  }
  return pending;
}
