/**
 * Footprint strings people pick from: tscircuit's footprinter names (`0402`, `soic8`, `sot23`, `qfn32`, `pinrow4`, …).
 * Any footprinter string works in the code (`soic8_w5.3mm_p1.27mm`); these are the common starting points.
 */

/** Footprinter families (from `@tscircuit/footprinter`'s getFootprintNames). */
export const FOOTPRINT_FAMILIES = [
  '0201', '0402', '0603', '0805', '1206', '1210', '2010', '2512', 'axial', 'radial', 'electrolytic',
  'sod123', 'sod123f', 'sod323', 'sod523', 'sod923', 'sma', 'smb', 'smc', 'melf', 'minimelf',
  'sot23', 'sot23_5', 'sot23_6', 'sot223', 'sot323', 'sot363', 'sot89', 'to92', 'to220', 'to252', 'to263', 'dpak', 'd2pak',
  'soic8', 'soic14', 'soic16', 'tssop8', 'tssop14', 'tssop20', 'ssop16', 'msop8', 'sop8', 'dfn8', 'son8', 'wson8',
  'qfn16', 'qfn20', 'qfn24', 'qfn32', 'qfn48', 'qfp32', 'qfp44', 'qfp64', 'lqfp48', 'lqfp64', 'tqfp32', 'tqfp44', 'bga64',
  'dip8', 'dip14', 'dip16', 'hc49', 'pinrow2', 'pinrow3', 'pinrow4', 'pinrow6', 'pinrow8', 'jst2_ph', 'jst4_sh', 'usbcmidmount',
  'pushbutton', 'smdpushbutton', 'smdslideswitch', 'led2835', 'led5050', 'stampboard', 'rj45',
] as const;

const PASSIVE = ['0201', '0402', '0603', '0805', '1206', '1210'];

const BY_TAG: Record<string, string[]> = {
  resistor: [...PASSIVE, '2512', 'axial'],
  capacitor: [...PASSIVE, 'electrolytic', 'radial'],
  inductor: ['0402', '0603', '0805', '1206', '1210'],
  fuse: ['0603', '0805', '1206', '1210'],
  diode: ['sod123', 'sod323', 'sod523', 'sma', 'smb', 'minimelf', '0603', 'axial'],
  led: ['0402', '0603', '0805', '1206', 'led2835', 'led5050'],
  transistor: ['sot23', 'sot323', 'sot89', 'to92', 'sot223'],
  mosfet: ['sot23', 'sot223', 'dpak', 'd2pak', 'to220', 'to252', 'dfn8'],
  chip: ['soic8', 'soic14', 'soic16', 'tssop8', 'tssop14', 'tssop20', 'msop8', 'sot23_5', 'sot23_6', 'dfn8', 'qfn16', 'qfn20', 'qfn24', 'qfn32', 'qfn48', 'lqfp48', 'lqfp64', 'tqfp32', 'tqfp44', 'dip8', 'dip14', 'dip16', 'bga64'],
  opamp: ['soic8', 'msop8', 'sot23_5', 'dip8', 'tssop14', 'soic14'],
  crystal: ['hc49'],
  pushbutton: ['pushbutton', 'smdpushbutton'],
  switch: ['smdslideswitch'],
};

/** Suggestions for an element, most common first. */
export const footprintsFor = (tag: string): string[] => BY_TAG[tag] ?? [];

/** The family a footprint string starts with (`soic8_w5.3mm` → `soic8`), for showing a short name. */
export const footprintFamily = (footprint: string) => footprint.split('_')[0];
