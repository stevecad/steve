/**
 * The Design workspace's Sheet Metal tab (docs/SHEET_METAL.md). Like the Solid tab, every tool
 * writes one Python call into the part; the base flange sets the sheet's rules (thickness, inside
 * radius, K-factor) that later features follow. Flat size, bend table and DXF come from the build's
 * sheet-metal report.
 */
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID, LOW } from '@/ribbonPriority';
import type { AppState } from '@/state/store';
import { openFeature } from '@/modeling/dialog';
import { set } from '@/state/store';
import { DxfIcon, FlatPatternIcon, FormLibraryIcon, SheetRulesIcon } from '@/icons/cad';
import { SHEET_SPECS } from './specs';
import { exportFlat, toggleFlat } from './sheet';


const needsDocument = (state: AppState) => state.doc.open || 'Open or create a design first.';
const needsIdle = (state: AppState) => !state.busy || 'Wait for the current operation to finish.';
const notPlacement = (state: AppState) => (state.doc.kind !== 'design' || state.doc.activeFile.startsWith('components/') ? true : 'Open a component file: sheet metal is modeled in components.');
const hasPanel = (state: AppState) => state.modeling?.features.some((feature) => !feature.suppressed
  && (feature.kind === 'sheet_base' || feature.kind === 'sheet_convert')) || 'Create a base flange or convert a flat plate first.';
const hasSheet = (state: AppState) => state.modeling?.features.some((feature) => !feature.suppressed
  && ['sheet_base', 'sheet_convert', 'sheet_roll', 'sheet_rip'].includes(feature.kind)) || 'Create or convert a sheet-metal body first.';
const hasReport = (state: AppState) => !!state.displayed?.artifacts.sheet_metal || 'Generate a sheet-metal part first.';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const feature = (id: string, kind: string, short?: string, needs: (state: AppState) => true | string = hasPanel): Command => {
  const spec = SHEET_SPECS[kind];
  return { id: `sheet.${id}`, label: spec.label, short, icon: spec.icon, category: 'Sheet metal', description: spec.description,
    run: () => { void openFeature(kind); }, enabled: all(needsDocument, needsIdle, notPlacement, needs) };
};


export const sheetMetalCommands: Command[] = [
  { id: 'sheet.rules', label: 'Sheet metal rules', short: 'Rules', icon: SheetRulesIcon, category: 'Sheet metal',
    description: 'Named rules sheets can share: thickness, inside bend radius and K-factor (or a gauge or bend table), with where the numbers come from.',
    run: () => set({ dialog: 'sheetRules' }), enabled: all(needsDocument, needsIdle, notPlacement) },
  feature('base', 'sheet_base', 'Base', () => true),
  feature('flange', 'sheet_flange', 'Flange'),
  feature('contour', 'sheet_contour', 'Contour'),
  feature('hem', 'sheet_hem'),
  feature('jog', 'sheet_jog'),
  feature('tab', 'sheet_tab'),
  feature('roll', 'sheet_roll', 'Roll', () => true),
  feature('cut', 'sheet_cut', 'Cut', hasSheet),
  feature('relief', 'sheet_relief'),
  feature('bend', 'sheet_bend', 'Bend'),
  feature('corner', 'sheet_corner'),
  feature('rip', 'sheet_rip', 'Rip', () => true),
  feature('unfold', 'sheet_unfold', undefined, hasSheet),
  feature('refold', 'sheet_refold', undefined, hasSheet),
  feature('convert', 'sheet_convert', 'Convert', () => true),
  feature('form', 'sheet_form', 'Form'),
  { id: 'sheet.formTools', label: 'Form tools', short: 'Tools', icon: FormLibraryIcon, category: 'Sheet metal',
    description: 'Reusable lances, louvers, embosses and dimples: define a tool once, then place it with Form as often as you need.',
    run: () => set({ dialog: 'sheetForms' }), enabled: all(needsDocument, needsIdle, notPlacement) },
  { id: 'sheet.flat', label: 'Flat pattern', short: 'Flat', icon: FlatPatternIcon, category: 'Sheet metal',
    description: 'Show the flat pattern beside the folded part: bend lines up and down, bend zones and developed size. It updates with every change.',
    run: toggleFlat, enabled: hasReport, active: (state) => state.flatView },
  { id: 'sheet.dxf', label: 'Export flat pattern (DXF)', short: 'DXF', icon: DxfIcon, category: 'Sheet metal',
    description: 'A ZIP per build: a layered DXF for each sheet body (CUT, BEND_UP, BEND_DOWN, ROLL; millimetres; exact arcs), its bend table (CSV), an SVG illustration and a manifest. Bodies with forms add a forming DXF and a form table.',
    run: () => { void exportFlat(); }, enabled: all(hasReport, needsIdle) },
];

export const sheetMetalRibbon: RibbonGroup[] = [
  { title: 'Rules', priority: MID, items: ['sheet.rules'] },
  { title: 'Sketch', priority: KEEP, items: ['model.sketch'] },
  { title: 'Create', priority: KEEP, items: ['sheet.base', 'sheet.flange', 'sheet.contour', 'sheet.hem', 'sheet.jog', 'sheet.tab', 'sheet.roll'] },
  { title: 'Modify', priority: HIGH, items: ['sheet.cut', 'sheet.relief', 'sheet.bend', 'sheet.corner', 'sheet.rip'] },
  { title: 'Unfold', priority: HIGH, items: ['sheet.unfold', 'sheet.refold'] },
  { title: 'Form', priority: LOW, items: ['sheet.form', 'sheet.formTools'] },
  { title: 'Convert', items: ['sheet.convert'] },
  { title: 'Flat pattern', priority: MID, items: ['sheet.flat', 'sheet.dxf'] },
  { title: 'Inspect', priority: MID, items: ['inspect.measure', 'inspect.section'] },
];
