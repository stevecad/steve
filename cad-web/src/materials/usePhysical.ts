import { useMemo } from 'react';
import { useApp } from '@/state/store';
import { assignmentOf, currentAssignments, massOf, useLibrary, type Assignment, type Assignments, type Library, type Material } from '@/lib/materials';
import { bodyIds, bodyLabel, modelingOf } from '@/modeling/bodies';

export interface BodyPhysical { id: string; label: string; volume: number; assignment: Assignment | null; material: Material | null; mass: number | null }

export interface Physical {
  library: Library | null;
  assignments: Assignments;
  bodies: BodyPhysical[];
  volume: number | null;
  /** Grams, when every body has a material with a density. */
  mass: number | null;
  /** The material every body has, if they share one. */
  uniform: Material | null;
  part: Material | null;
}

/** Materials and masses of the displayed part: the code's assignments over the build's body volumes. */
export function usePhysical(): Physical {
  const library = useLibrary();
  const doc = useApp((state) => state.pastVersion ? null : state.modeling);
  const displayed = useApp((state) => state.displayed);
  return useMemo(() => {
    const report = modelingOf(displayed);
    const assignments = currentAssignments(doc, report);
    const lookup = (a: Assignment | null) => (a && library?.byId.get(a.material)) || null;
    const entries = report && Object.keys(report.bodies).length
      // Surface bodies have no volume or mass: left out.
      ? bodyIds(displayed).filter((id) => report.bodies[id]?.kind !== 'surface').map((id) => ({ id, label: bodyLabel(id, doc, report), volume: report.bodies[id].volume ?? 0 }))
      : displayed?.metadata?.volume_mm3 !== undefined ? [{ id: '', label: 'Part', volume: displayed.metadata.volume_mm3 }] : [];
    const bodies = entries.map((entry) => {
      const assignment = assignmentOf(assignments, entry.id || null);
      const material = lookup(assignment);
      return { ...entry, assignment, material, mass: massOf(entry.volume, material) };
    });
    const volume = bodies.length ? bodies.reduce((sum, body) => sum + body.volume, 0) : null;
    const mass = bodies.length && bodies.every((body) => body.mass !== null) ? bodies.reduce((sum, body) => sum + body.mass!, 0) : null;
    const first = bodies[0]?.material ?? null;
    const uniform = first && bodies.every((body) => body.material?.id === first.id) ? first : null;
    return { library, assignments, bodies, volume, mass, uniform, part: lookup(assignments.part) };
  }, [library, doc, displayed]);
}

/** The material a study uses: the one every body shares, else the part's. */
export function useStudyMaterial(): Material | null {
  const physical = usePhysical();
  return physical.uniform ?? physical.part;
}
