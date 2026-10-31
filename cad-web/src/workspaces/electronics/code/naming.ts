/** Reference designators: the name prefix each kind of part gets, and the next free name in a file. */
import type { SourceIndex } from './types';

/** IEEE 315 / IPC style prefixes for tscircuit elements. Elements not listed here aren't auto-named. */
export const NAME_PREFIX: Record<string, string> = {
  resistor: 'R', potentiometer: 'RV', capacitor: 'C', inductor: 'L', diode: 'D', led: 'D', fuse: 'F',
  chip: 'U', opamp: 'U', transistor: 'Q', mosfet: 'Q', crystal: 'Y', resonator: 'Y',
  pinheader: 'J', connector: 'J', jumper: 'JP', solderjumper: 'JP', pushbutton: 'SW', switch: 'SW',
  battery: 'BT', testpoint: 'TP', antenna: 'AE', fiducial: 'FID', hole: 'H', platedhole: 'H',
  voltagesource: 'V', powersource: 'PS', currentsource: 'I', ammeter: 'AM', voltageprobe: 'VP',
  group: 'G', subcircuit: 'S', interconnect: 'IC', mountedboard: 'MB', bug: 'U', pinout: 'U',
};

export const prefixFor = (tag: string): string | null => NAME_PREFIX[tag] ?? null;

/** The next free `<prefix><n>` (R1, R2, …) after the highest one already used. */
export function nextName(index: SourceIndex, prefix: string): string {
  const used = new Set(index.elements.map((element) => element.name).filter((name): name is string => !!name));
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  let highest = 0;
  for (const name of used) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  let number = highest + 1;
  while (used.has(`${prefix}${number}`)) number++;
  return `${prefix}${number}`;
}
