/**
 * The Electronics place-and-edit tools (workspaces/electronics/slots.ts): placing parts, rotating, flipping and
 * deleting the selection, and writing what people do by hand in the views into the TSX: PCB moves (pcbEdits.ts),
 * schematic moves and wires (schematicEdits.ts). Every one is a code edit (`../code`) handed to `setCode`; the circuit
 * rebuilds on its own.
 *
 * '@/commands' is only imported for types here: its values aren't ready while this module loads (import cycle).
 */
import { createElement } from 'react';
import { FlipVertical2, PackagePlus, PanelsTopLeft, Plus, RotateCw, Search, Trash2, Zap } from 'lucide-react';
import { get, set, set as setApp, toast, type AppState } from '@/state/store';
import { setCode } from '@/state/actions';
import type { Command, IconType, RibbonGroup } from '@/commands';
import { HIGH, MID } from '@/ribbonPriority';
import { ensureParser } from '../code/parser';
import { removeElement, rotate, setLayer, addTrace } from '../code/edits';
import { CircuitLookup, portSelector } from '../code/selectors';
import { applyPcbEditEvent, applySchematicEditEvent, type ViewEditEvent } from '../code/viewEdits';
import { EditError, type EditResult } from '../code/types';
import { PARTS, type Category } from '../parts/catalog';
import { clearPcbEdits, onPcbEdit } from '../pcbEdits';
import { onSchematicDrag, onSchematicWire, useSchematicTool, type SchematicPin } from '../schematicEdits';
import { selectParts, useCircuit } from '../state';
import { selectorName } from '../circuit';
import { PartIcon } from './symbols';
import { openParts } from './partsTab';
import { armPart } from './placing';

const inCircuit = (state: AppState) => (state.workspace === 'electronics' && state.doc.open && state.doc.kind === 'circuit') || 'Open a circuit first.';
const hasSelection = () => useCircuit.getState().selection.length > 0 || 'Select a part first (click it in a view or the tree).';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

// The ribbon re-reads availability when the app store changes; selection lives in the circuit store, so nudge it.
useCircuit.subscribe((state) => state.selection, () => setApp({}));

/** A part glyph as a command icon. */
const iconOf = (tag: string): IconType => {
  const Icon = (props: { size?: number; strokeWidth?: number; className?: string }) => createElement(PartIcon, { tag, ...props });
  Icon.displayName = `${tag}Icon`;
  return Icon;
};

/** Runs a code edit on the open circuit and applies it; an EditError becomes a plain warning. */
async function edit(run: (code: string) => EditResult, failure = 'Couldn’t change the code'): Promise<EditResult | null> {
  await ensureParser();
  try {
    const result = run(get().doc.code);
    if (result.changed) setCode(result.code);
    for (const note of result.notes) toast('info', note);
    return result;
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    toast('warning', failure, error.message);
    return null;
  }
}


/** Rotate, flip and delete work on the parts the code names (not ones from a loop or another file). */
const selected = () => useCircuit.getState().selection;
const viewOf = () => (useCircuit.getState().view === 'schematic' ? 'sch' : 'pcb') as 'sch' | 'pcb';

function rotateSelection() {
  const view = viewOf();
  void edit((code) => selected().reduce<EditResult>((previous, name) => {
    const next = rotate(previous.code, name, view);
    return { ...next, changed: previous.changed || next.changed, notes: [...previous.notes, ...next.notes] };
  }, { code, changed: false, notes: [] }), 'Couldn’t rotate');
}

function flipSelection() {
  const model = useCircuit.getState().model;
  void edit((code) => selected().reduce<EditResult>((previous, name) => {
    const part = model?.parts.find((item) => item.name === name);
    const next = setLayer(previous.code, name, part?.layer === 'bottom' ? 'top' : 'bottom');
    return { ...next, changed: previous.changed || next.changed, notes: [...previous.notes, ...next.notes] };
  }, { code, changed: false, notes: [] }), 'Couldn’t flip');
}

async function deleteSelection() {
  const names = selected();
  const before = get().doc.code;
  let removed = 0;
  const result = await edit((code) => names.reduce<EditResult>((previous, name) => {
    const next = removeElement(previous.code, name);
    removed += next.removed.length;
    return { ...next, changed: previous.changed || next.changed, notes: [] };
  }, { code, changed: false, notes: [] }), 'Couldn’t delete');
  if (!result?.changed) return;
  selectParts([]);
  const after = result.code;
  const traces = removed - names.length;
  toast('success', `Deleted ${names.join(', ')}`, traces > 0 ? `And ${traces} trace${traces === 1 ? '' : 's'} connected to ${names.length === 1 ? 'it' : 'them'}.` : undefined, {
    action: { label: 'Undo', run: () => { if (get().doc.code === after) { setCode(before); selectParts(names); } else toast('warning', 'Can’t undo', 'The code has changed since.'); } },
  });
}

const QUICK = ['resistor', 'capacitor', 'led', 'chip', 'pinheader'];
const MENUS: { menu: string; label: string; icon: IconType; categories: Category[] }[] = [
  { menu: 'circuit.place.parts', label: 'Parts', icon: Plus, categories: ['Passives', 'Semiconductors', 'ICs', 'Connectors', 'Electromechanical'] },
  { menu: 'circuit.place.power', label: 'Power', icon: Zap, categories: ['Power'] },
  { menu: 'circuit.place.board', label: 'Board', icon: iconOf('platedhole'), categories: ['PCB features', 'Structure'] },
  { menu: 'circuit.place.notes', label: 'Notes', icon: iconOf('netlabel'), categories: ['Annotation'] },
];

const article = (label: string) => (/^[aeiou]/i.test(label) && !/^us/i.test(label) ? 'an' : 'a');

export const placeCommands: Command[] = [
  { id: 'circuit.place', label: 'Place part…', short: 'Place', icon: PackagePlus, category: 'Electronics', shortcut: 'Shift+A', keys: ['shift+a'],
    description: 'The Parts tab: pick a part, then click in the schematic to put it there. Parts appear on the board by themselves.',
    run: () => openParts('library'), enabled: inCircuit, active: (state) => state.dockOpen && state.dockTab === 'parts' },
  { id: 'circuit.place.jlcpcb', label: 'Find JLCPCB part…', short: 'JLCPCB', icon: Search, category: 'Electronics',
    description: 'Search JLCPCB’s in-stock parts and place one pinned to that exact part (footprint, BOM and assembly).',
    run: () => openParts('jlcpcb'), enabled: inCircuit },
  ...PARTS.map((part): Command => ({
    id: `circuit.place.${part.tag}`, label: part.label, icon: iconOf(part.tag), category: 'Electronics',
    description: `Place ${article(part.label)} ${part.label.toLowerCase()}: it follows the pointer in the schematic, click to put it there. ${part.description}`,
    run: () => { void armPart(part); }, enabled: inCircuit,
    active: (state) => state.circuitTool === 'place' && useSchematicTool.getState().placing?.tag === part.tag && !useSchematicTool.getState().placing?.props,
  })),
  { id: 'circuit.rotate', label: 'Rotate', icon: RotateCw, category: 'Electronics', shortcut: 'R', keys: ['r'],
    description: 'Turn the selected parts 90° on the board (in the schematic when that’s the view).',
    run: rotateSelection, enabled: all(inCircuit, hasSelection) },
  { id: 'circuit.flip', label: 'Flip side', short: 'Flip', icon: FlipVertical2, category: 'Electronics', shortcut: 'F', keys: ['f'],
    description: 'Move the selected parts to the other side of the board (top ↔ bottom).',
    run: flipSelection, enabled: all(inCircuit, hasSelection) },
  { id: 'circuit.delete', label: 'Delete', icon: Trash2, category: 'Electronics', shortcut: 'Delete', keys: ['delete', 'backspace'],
    description: 'Remove the selected parts and the traces connected to them. Undo is in the message that follows.',
    run: () => { void deleteSelection(); }, enabled: all(inCircuit, hasSelection) },
  { id: 'circuit.board', label: 'Board properties', short: 'Board', icon: PanelsTopLeft, category: 'Electronics',
    description: 'Size, layers and outline of the board itself.',
    run: () => { selectParts([]); set({ dockOpen: true, dockTab: 'properties' }); }, enabled: inCircuit },
];

export const placeRibbon: RibbonGroup[] = [
  {
    title: 'Place', priority: HIGH, visible: (state) => state.doc.kind === 'circuit',
    items: [
      'circuit.place',
      'circuit.place.jlcpcb',
      ...QUICK.map((tag) => `circuit.place.${tag}`),
      ...MENUS.map(({ menu, label, icon, categories }) => ({ menu, label, icon, items: PARTS.filter((part) => categories.includes(part.category) && !QUICK.includes(part.tag)).map((part) => `circuit.place.${part.tag}`) })),
    ],
  },
  { title: 'Edit', priority: MID, visible: (state) => state.doc.kind === 'circuit', items: ['circuit.rotate', 'circuit.flip', 'circuit.delete', 'circuit.board'] },
];

// ---- What people do by hand in the views, written into the code ----

/** The circuit on screen (the build the views show). */
const circuitJson = () => useCircuit.getState().json ?? [];

onPcbEdit((events) => {
  void (async () => {
    await ensureParser();
    let code = get().doc.code;
    const notes: string[] = [];
    for (const event of events) {
      try {
        const result = applyPcbEditEvent(code, circuitJson(), event as unknown as ViewEditEvent);
        code = result.code;
        notes.push(...result.notes);
      } catch (error) {
        if (!(error instanceof EditError)) throw error;
        toast('warning', 'Couldn’t move it', error.message);
        clearPcbEdits();  // The board shows the part back where the code puts it.
      }
    }
    if (code !== get().doc.code) setCode(code);
    for (const note of notes) toast('info', note);
  })();
});

onSchematicDrag((drag) => {
  void edit((code) => applySchematicEditEvent(code, circuitJson(), {
    edit_event_type: 'edit_schematic_component_location', schematic_component_id: drag.schematic_component_id,
    original_center: drag.original_center, new_center: drag.new_center,
  }), `Couldn’t move ${drag.part}`);
});

/**
 * A pin's selector from the board, through any named subcircuits, by its label: `.U1 > .VCC` rather than
 * `.U1 > .pin8` when the pin has one, `.D1 > .anode` on a diode, but `.R1 > .pin1` on a resistor (circuit.ts).
 */
function selectorOf(pin: SchematicPin): string {
  const readable = selectorName({ name: pin.port, label: pin.label });
  const lookup = new CircuitLookup(circuitJson());
  const port = lookup.get(pin.source_port_id);
  const component = lookup.get(port?.source_component_id as string | undefined);
  const path = lookup.subcircuitPath(component?.source_group_id as string | undefined);
  return portSelector(pin.part, readable, path);
}

onSchematicWire((wire) => {
  void edit((code) => addTrace(code, selectorOf(wire.from), selectorOf(wire.to)), 'Couldn’t add the wire');
});
