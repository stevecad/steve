/**
 * Placing parts the way EDA tools do it: pick a part (the Parts tab, the ribbon) and it rides on the pointer in the
 * schematic; each click puts one there (`schX` / `schY`, snapped to the grid), and the tool stays on for the next
 * (R2, R3 …) until Esc, a right-click or another tool. Parts arrive on the board by themselves, laid out by
 * tscircuit, and are arranged in the PCB view.
 *
 * The canvas reports clicks through schematicEdits.ts (`onSchematicPlace`); this writes them into the code.
 */
import { get, toast, useApp } from '@/state/store';
import { setCode } from '@/state/actions';
import { ensureParser } from '../code/parser';
import { parse } from '../code/source';
import { nextName, prefixFor } from '../code/naming';
import { EditError } from '../code/types';
import { partFor, type PartSpec } from '../parts/catalog';
import { allParts } from '../parts/schema';
import { placePart } from '../parts/place';
import { onSchematicPlace, startPlacing, stopPlacing, useSchematicTool } from '../schematicEdits';
import { selectSoon, setView, useCircuit } from '../state';

const specFor = (tag: string): PartSpec | null => partFor(tag) ?? allParts().find((part) => part.tag === tag) ?? null;

/** The name the next one placed gets (R3), or the default name of parts named by what they are (a GND label). */
function nameFor(code: string, part: PartSpec): string | null {
  const prefix = prefixFor(part.tag);
  try {
    return prefix ? nextName(parse(code), prefix) : typeof part.defaults.name === 'string' ? part.defaults.name : null;
  } catch {
    return null;  // The code doesn't parse right now: the ghost goes without a name.
  }
}

const VALUE_PROPS = ['resistance', 'capacitance', 'inductance', 'maxResistance', 'frequency', 'currentRating', 'voltage', 'color', 'net'];

/** What the part reads as on the schematic: its value (10k, 100nF) when it has one. */
function valueOf(part: PartSpec, props?: Record<string, unknown>): string | null {
  const all = { ...part.defaults, ...props };
  for (const key of VALUE_PROPS) if (typeof all[key] === 'string' || typeof all[key] === 'number') return String(all[key]);
  return null;
}

/** Puts `part` on the pointer in the schematic (with `props`, e.g. a JLCPCB part's value and footprint). */
export async function armPart(part: PartSpec, props?: Record<string, unknown>) {
  await ensureParser();
  // Parts go on the schematic: from the board or 3D, show both so the board shows each one arrive.
  const view = useCircuit.getState().view;
  if (view === 'pcb' || view === '3d') setView('split');
  startPlacing({ tag: part.tag, label: part.label, props, name: nameFor(get().doc.code, part), value: valueOf(part, props) });
}

/** Places a part without aiming (double-click, Enter): where tscircuit's layout puts it. */
export async function placeNow(part: PartSpec, props?: Record<string, unknown>): Promise<string | null> {
  await ensureParser();
  try {
    const result = placePart(get().doc.code, part, { props });
    if (!result.changed) return null;
    setCode(result.code);
    if (result.name) selectSoon([result.name]);
    for (const note of result.notes) toast('info', 'Placed', note);
    return result.name;
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    toast('warning', `Couldn’t place the ${part.label.toLowerCase()}`, error.message);
    return null;
  }
}

// A click on the schematic with the Place tool: the carried part goes there, and the next one gets the next name.
onSchematicPlace((at) => {
  void (async () => {
    const placing = useSchematicTool.getState().placing;
    if (!placing) return;
    const part = specFor(placing.tag);
    if (!part) { stopPlacing(); return; }
    await ensureParser();
    try {
      const result = placePart(get().doc.code, part, { at, props: placing.props });
      if (!result.changed) return;
      setCode(result.code);
      if (result.name) selectSoon([result.name]);
      for (const note of result.notes) toast('info', 'Placed', note);
      const now = useSchematicTool.getState();
      if (now.tool === 'place' && now.placing?.tag === placing.tag) useSchematicTool.setState({ placing: { ...now.placing, name: nameFor(result.code, part) } });
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      toast('warning', `Couldn’t place the ${part.label.toLowerCase()}`, error.message);
    }
  })();
});

// Placing ends with the schematic: another document, another workspace, or the board or 3D on its own.
useApp.subscribe((state) => `${state.workspace} ${state.activeTab ?? ''} ${state.doc.kind}`, () => stopPlacing());
useCircuit.subscribe((state) => state.view, (view) => { if (view === 'pcb' || view === '3d') stopPlacing(); });
