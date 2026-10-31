/** Export → Simulation model (MuJoCo): the design's full build as the zip simulationModel.ts makes, downloaded. */
import { zip } from '@/lib/zip';
import { ensurePrintMeshes } from '@/state/actions';
import { fetchMesh } from '@/state/meshExport';
import { get, hasSourceEdits, toast } from '@/state/store';
import { kinematicsOf } from './kinematics';
import { num, simulationModel } from './simulationModel';
import { useMotion } from './state';

let running = false;

/** Downloads the design as a MuJoCo simulation model (zip), from its full build. */
export async function exportSimulationModel() {
  if (running) return;
  running = true;
  const label = 'simulation model';
  try {
    let build = await ensurePrintMeshes(label);
    // Print meshes from before mass properties (an older runtime) have none: build it again once.
    if (build && !(build.metadata?.body_meshes ?? []).every((item) => item.mass_properties)) build = await ensurePrintMeshes(label, true);
    if (!build) return;
    const full = build;
    const kinematics = kinematicsOf(full.metadata) ?? useMotion.getState().kinematics;
    const items = full.metadata?.body_meshes ?? [];
    if (!kinematics?.joints.some((joint) => joint.type !== 'rigid')) { toast('warning', 'Nothing moves yet', 'Add a revolute, slider or cylindrical joint first.'); return; }
    if (!items.length) { toast('warning', 'Nothing to export', 'The design has no solid bodies, or errors to fix first.'); return; }
    const bodies = await Promise.all(items.map(async (item, index) => ({ item, stl: await fetchMesh(full.id, index) })));
    const state = get();
    const name = state.doc.name || full.name;
    const { files, report } = await simulationModel({
      name, kinematics, bodies,
      source: { document_id: state.doc.saved?.id ?? null, revision: state.doc.saved?.revision ?? null, branch: state.doc.saved ? state.doc.branch : null,
        build_id: full.id, unsaved_edits: hasSourceEdits(state) },
    });
    const blob = await zip(files);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'design'}-mjcf.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    const warnings = report.missing_material.length + report.pose_limits.length + report.unsupported.length + report.mass_override_errors.length
      + report.contacts.errors.length + report.inertia_floor.length;
    const mass = report.mass_kg ? `, ${report.mass_kg < 1 ? `${num(Number((report.mass_kg * 1000).toPrecision(4)))} g` : `${num(Number(report.mass_kg.toPrecision(4)))} kg`}` : '';
    toast(warnings ? 'warning' : 'success', 'Exported a simulation model',
      `${report.links} links, ${report.joints} joints${mass}. Open model.xml in MuJoCo; inventory.json has the same tree as plain data.`
      + (warnings ? ` report.json lists ${warnings} thing${warnings === 1 ? '' : 's'} to check${report.missing_material.length ? ' (bodies without a material)' : ''}.` : ''));
  } catch (error) {
    toast('danger', 'Couldn’t export the simulation model', (error as Error).message);
  } finally {
    running = false;
  }
}
