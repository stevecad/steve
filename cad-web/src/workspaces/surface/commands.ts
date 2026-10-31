/**
 * The Design workspace's Surface tab: surface modelling and the analysis that checks it. The ribbon shows only what
 * works today. Create: the surfacing features that exist (sweep and loft stay on the Solid tab too; fill and boundary
 * surface also sit in its Surface menu). Analyze: display-only viewer modes (zebra stripes, a curvature map, draft
 * against a pull direction) and the continuity check of a picked edge; their options are the Dock's tool panel.
 *
 * Groups: Create, Modify, Analyze. A feature command is listed only when its spec exists (`ready`), so a tool never
 * shows before its engine: thicken and solidify are listed already and appear when their specs land. When a new
 * surfacing tool ships (offset, ruled, trim, extend, stitch…), add its command id to the right group here, and to the
 * Solid ribbon (commands.ts RIBBONS.design) too where it belongs there; mark its feature spec `surface: true`
 * (modeling/specs.ts) so editing it shows this tab.
 */
import { Rows3, Spline } from 'lucide-react';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH } from '@/ribbonPriority';
import { SPECS } from '@/modeling/specs';
import { readyCommands } from './ready';
import type { AppState } from '@/state/store';
import { DraftIcon, TangentIcon } from '@/icons/cad';
import { toggleAnalysis, useSurfaceAnalysis, type AnalysisMode } from './state';

const needsModel = (state: AppState) => !!state.displayed || 'Generate the model first.';
const needsDesign = (state: AppState) => state.workspace === 'design' || 'Switch to the Design workspace first.';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const analysis = (mode: AnalysisMode, label: string, short: string, icon: Command['icon'], description: string): Command => ({
  id: `surface.${mode}`, label, short, icon, category: 'Surface', description,
  run: () => toggleAnalysis(mode), enabled: all(needsModel, needsDesign), active: () => useSurfaceAnalysis.getState().mode === mode,
});

export const surfaceCommands: Command[] = [
  analysis('zebra', 'Zebra stripes', 'Zebra', Rows3,
    'Reflect stripes on the model to judge how smoothly faces flow: stripes that kink at an edge show a crease, stripes that jump show a gap.'),
  analysis('curvature', 'Curvature map', 'Curvature', Spline,
    'Colour the model by how tightly it curves (mean or Gaussian): red bulges out, blue curves in. Estimated from the displayed mesh.'),
  analysis('draft', 'Draft analysis', 'Draft', DraftIcon,
    'Colour faces by their draft against a pull direction: enough draft, too little, or facing the other way, for moulded and cast parts.'),
  analysis('continuity', 'Continuity check', 'Continuity', TangentIcon,
    'Pick an edge between two faces to see how they meet: the gap (G0), the angle between them (G1) and the change in curvature (G2).'),
];

/** Feature commands still to come: listed once their engine exists in this build of the app (a spec in
 *  modeling/specs.ts), so the ribbon never shows a tool before it works. Thicken and solidify appear by themselves. */
const ready = (...ids: string[]) => readyCommands(ids, (kind) => !!SPECS[kind]);

export function surfaceGroups(): RibbonGroup[] {
  const groups: RibbonGroup[] = [
    { title: 'Create', priority: KEEP, items: ['model.sketch', 'model.sweep', 'model.loft', 'model.fill', 'model.boundary_surface'] },
    { title: 'Modify', priority: HIGH, items: ready('model.thicken', 'model.solidify') },
    { title: 'Analyze', priority: HIGH, items: ['surface.zebra', 'surface.curvature', 'surface.draft', 'surface.continuity', 'inspect.measure', 'inspect.section'] },
  ];
  return groups.filter((group) => group.items.length);
}

export const surfaceRibbon: RibbonGroup[] = surfaceGroups();
