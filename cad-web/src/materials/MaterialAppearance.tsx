import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { get, useApp } from '@/state/store';
import {
  assignmentOf, assignmentsFromReport, currentAssignments, currentLooks, loadLibrary, lookOf, looksFromReport, useMaterialLibrary, type Assignment, type Assignments, type Looks,
} from '@/lib/materials';
import { bodyOrder, componentBodyOrder, faceLooks } from '@/lib/bodyOrder';
import type { Look, ModelingResult } from '@/lib/modeling';
import type { FaceInfo } from '@/viewport/model';
import { bodyFaces, modelingOf } from '@/modeling/bodies';
import { viewer } from '@/viewport/viewer';
import { instanceSources, type InstanceSource } from '@/viewport/instanceSource';
import type { ModelRuntime } from '@/viewport/model';
import { bodySurface, createSurface, onTexturesLoaded, studioEnvironment, surfaceKey, updateSurfaceLighting } from './render';

/** Shared surfaces per displayed model; the model disposes them with its other materials. */
const surfaces = new WeakMap<ModelRuntime, Map<string, THREE.MeshPhysicalMaterial>>();

/**
 * Renders each body of the displayed part (or each instance of a design) with its material from the code
 * (`model.material`) and its appearance (`model.appearance`, which wins for the look), as the build reported it or
 * as the open code says. Part of the viewer itself (SceneCore): the
 * app's viewport and the share page both draw materials through this.
 */
export default function MaterialAppearance() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    let environment: THREE.Texture | null = null;
    const apply = () => {
      const model = viewer.model;
      if (!model) return;
      const state = get();
      if (model.build.kind === 'design') { applyDesign(model); return; }
      const report = modelingOf(model.build);
      const source = state.pastVersion ? null : state.modeling;
      const assignments = currentAssignments(source, report);
      const looks = currentLooks(source, report);
      const library = useMaterialLibrary.getState().library;
      // Face looks (model.appearance(faces=...)) come from the build: references need the geometry to resolve.
      const faceLook = faceLooks(report, bodyOrder(report));
      const used = !!assignments.part || Object.keys(assignments.bodies).length > 0 || !!looks.part || Object.keys(looks.bodies).length > 0 || faceLook.size > 0;
      if (used && !library) { loadLibrary().catch(() => undefined); return; }
      if (used && !environment) environment = studioEnvironment(gl, (texture) => { environment = texture; apply(); });
      const cache = surfaces.get(model) ?? new Map<string, THREE.MeshPhysicalMaterial>();
      surfaces.set(model, cache);
      const byMesh = new Map<THREE.Mesh, THREE.MeshPhysicalMaterial>();
      const materialOf = (assignment: Assignment | null, look: Look | null) => {
        const surface = library ? bodySurface(library, assignment, look) : null;
        if (!surface) return null;
        const key = surfaceKey(surface);
        let material = cache.get(key);
        if (!material) cache.set(key, material = createSurface(surface, environment, state.theme));
        return material;
      };
      const faces = report && Object.keys(report.bodies).length ? bodyFaces(model) : new Map([['', model.faces]]);
      for (const [body, meshes] of faces) {
        const assignment = assignmentOf(assignments, body || null);
        const material = materialOf(assignment, lookOf(looks, body || null));
        for (const mesh of meshes) {
          // A merged run of faces (viewport/model.ts) shares one look: its first face's.
          const own = faceLook.get((mesh.userData.face as FaceInfo).faceIndex);
          const chosen = own ? materialOf(assignment, own) : material;
          if (chosen) byMesh.set(mesh, chosen);
        }
      }
      for (const material of cache.values()) updateSurfaceLighting(material, environment, state.theme);
      model.setAppearance((mesh) => byMesh.get(mesh) ?? null);
      invalidate();
    };
    /** Designs: each instance shows its component's materials (or its linked part's, or a linked design's components'), body by body. */
    const applyDesign = (model: ModelRuntime) => {
      const state = get();
      if (!(model.build.metadata as { modeling?: { design?: unknown } } | null)?.modeling?.design) { model.setAppearance(() => null); invalidate(); return; }
      const sources = new Map<string, { assignments: Assignments; looks: Looks; faces: Map<number, Look>; table: [string, number, number][] }>();
      const source = (found: InstanceSource) => {
        if (!sources.has(found.key)) {
          const assignments = assignmentsFromReport(found.summary) ?? { part: null, bodies: {} };
          const looks = looksFromReport(found.summary) ?? { part: null, bodies: {} };
          sources.set(found.key, { assignments, looks, faces: faceLooks(found.summary, componentBodyOrder(found.summary)), table: faceTable(found.summary) });
        }
        return sources.get(found.key)!;
      };
      const sourceOf = instanceSources(model);
      const faces = model.faces.map((mesh) => {
        const found = sourceOf((mesh.userData.face as FaceInfo).node);
        return { mesh, from: found ? source(found) : null };
      });
      const library = useMaterialLibrary.getState().library;
      const wanted = [...sources.values()].some((s) => s.assignments.part || Object.keys(s.assignments.bodies).length || s.looks.part || Object.keys(s.looks.bodies).length || s.faces.size);
      if (wanted && !library) { loadLibrary().catch(() => undefined); return; }
      if (wanted && !environment) environment = studioEnvironment(gl, (texture) => { environment = texture; apply(); });
      let cache = surfaces.get(model);
      if (!cache) surfaces.set(model, cache = new Map());
      const byMesh = new Map<THREE.Mesh, THREE.MeshPhysicalMaterial>();
      for (const { mesh, from } of faces) {
        const face = mesh.userData.face as FaceInfo;
        if (!from || !library) continue;
        const { assignments, looks, faces: own, table } = from;
        const body = table.find(([, from, to]) => face.faceIndex >= from && face.faceIndex < to)?.[0] ?? null;
        const surface = bodySurface(library, assignmentOf(assignments, body), own.get(face.faceIndex) ?? lookOf(looks, body));
        if (!surface) continue;
        const key = surfaceKey(surface);
        let material = cache.get(key);
        if (!material) cache.set(key, material = createSurface(surface, environment, state.theme));
        byMesh.set(mesh, material);
      }
      for (const material of cache.values()) updateSurfaceLighting(material, environment, state.theme);
      model.setAppearance((mesh) => byMesh.get(mesh) ?? null);
      invalidate();
    };
    apply();
    const unsubscribe = [
      viewer.onModelChange(apply),
      useApp.subscribe((state) => state.modeling, apply),
      useApp.subscribe((state) => state.pastVersion, apply),
      useApp.subscribe((state) => state.theme, apply),
      useMaterialLibrary.subscribe(apply),
      onTexturesLoaded(invalidate),
    ];
    return () => unsubscribe.forEach((stop) => stop());
  }, [gl, invalidate]);
  return null;
}

/** A component's body face ranges in its exported mesh (bodies in export order, faces in order). */
function faceTable(summary: ModelingResult | null | undefined): [string, number, number][] {
  const bodies = Object.entries(summary?.bodies ?? {}).sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0));
  const out: [string, number, number][] = [];
  let start = 0;
  for (const [id, body] of bodies) { out.push([id, start, start + body.faces]); start += body.faces; }
  return out;
}
