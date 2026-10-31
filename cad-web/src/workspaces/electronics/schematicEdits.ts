/**
 * What people do by hand on the schematic canvas (SchematicView), for the code-rewrite engine to write into the TSX
 * (workspaces/electronics/code). Same pattern as pcbEdits.ts:
 *
 *   onSchematicDrag((move) => …)        a part dragged to a new place: write `schX` / `schY`
 *   onSchematicPortClick((pin) => …)     a pin clicked with the Wire tool on
 *   onSchematicWire((wire) => …)         two pins picked in turn with the Wire tool: insert `<trace from to />`
 *   startWiring() / stopWiring()         the Wire tool (W; Esc stops it, or drops a half-drawn wire first)
 *   startPlacing(part) / stopPlacing()   the Place tool: a part rides on the pointer; each click reports
 *   onSchematicPlace((at) => …)          a click where it should go: write the part with `schX` / `schY`
 *
 * Coordinates are schematic units (Circuit JSON `schematic_component.center`), not screen pixels, snapped to the
 * schematic grid (SCHEMATIC_GRID). Each `on…` returns an unsubscribe; `use…` hooks are the React form.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { set as setApp } from '@/state/store';

/** The schematic grid moves snap to (schematic units; tscircuit draws pins 0.1 apart). */
export const SCHEMATIC_GRID = 0.1;

export interface Point { x: number; y: number }

export interface SchematicDrag {
  schematic_component_id: string;
  /** The part's name (R1). */
  part: string;
  original_center: Point;
  new_center: Point;
}

export interface SchematicPin {
  /** The pin as Circuit JSON's schematic_port (null when the schematic has no port record for it). */
  schematic_port_id: string | null;
  source_port_id: string;
  /** The part's name (U1). */
  part: string;
  /** The port's name (pin8) and every name it answers to (VCC, 8, …): `.U1 > .VCC` selects it. */
  port: string;
  aliases: string[];
  /** Its label from the circuit model (VCC, anode on a diode; the name on a resistor): what a wire's selector writes. */
  label: string;
  center: Point;
}

export interface SchematicWire { from: SchematicPin; to: SchematicPin }

export type SchematicTool = 'select' | 'wire' | 'place';

/** The part the Place tool carries: its element, any props it's placed with, and the name the next one will get. */
export interface PlacingPart { tag: string; label: string; props?: Record<string, unknown>; name: string | null; value?: string | null }

/** Where a click with the Place tool puts the part, in schematic units, snapped to the grid. */
export interface SchematicPlace { schX: number; schY: number }

/** The canvas tool, a wire's first pin while it's being drawn, and the part being placed. */
export const useSchematicTool = create<{ tool: SchematicTool; from: SchematicPin | null; placing: PlacingPart | null }>(() => ({ tool: 'select', from: null, placing: null }));

// The ribbon follows the tool through the app store.
useSchematicTool.subscribe((state, previous) => { if (state.tool !== previous.tool) setApp({ circuitTool: state.tool }); });

export const startWiring = () => useSchematicTool.setState({ tool: 'wire', from: null, placing: null });
export const stopWiring = () => useSchematicTool.setState({ tool: 'select', from: null });
/** The Place tool: `part` follows the pointer on the schematic until Esc, a right-click or another tool. */
export const startPlacing = (part: PlacingPart) => useSchematicTool.setState({ tool: 'place', from: null, placing: part });
export const stopPlacing = () => { if (useSchematicTool.getState().tool === 'place') useSchematicTool.setState({ tool: 'select', placing: null }); };
/** Esc: placing stops; a half-drawn wire goes first, then the Wire tool. True when there was something to stop. */
export function escapeWiring(): boolean {
  const { tool, from } = useSchematicTool.getState();
  if (tool === 'place') { stopPlacing(); return true; }
  if (tool !== 'wire') return false;
  if (from) useSchematicTool.setState({ from: null }); else stopWiring();
  return true;
}

function stream<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value: T) => { for (const listener of listeners) listener(value); },
    on: (listener: (value: T) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    count: () => listeners.size,
  };
}

const drags = stream<SchematicDrag>();
const pins = stream<SchematicPin>();
const wires = stream<SchematicWire>();
const places = stream<SchematicPlace>();

export const onSchematicDrag = drags.on;
export const onSchematicPortClick = pins.on;
export const onSchematicWire = wires.on;
export const onSchematicPlace = places.on;
/** Whether anything writes moves into the code (else the canvas puts a dragged part back). */
export const hasDragListeners = () => drags.count() > 0;

/** The canvas reports a finished drag. */
export const reportSchematicDrag = (drag: SchematicDrag) => drags.emit(drag);

/** The canvas reports a click with the Place tool: put the carried part there (the tool stays on for the next one). */
export const reportSchematicPlace = (at: SchematicPlace) => places.emit(at);

/** The canvas reports a pin clicked with the Wire tool: the first starts a wire, the second finishes it. */
export function reportSchematicPin(pin: SchematicPin) {
  pins.emit(pin);
  const { from } = useSchematicTool.getState();
  if (!from) { useSchematicTool.setState({ from: pin }); return; }
  if (from.source_port_id === pin.source_port_id) return;
  useSchematicTool.setState({ from: null });  // Stay in the Wire tool for the next wire.
  wires.emit({ from, to: pin });
}

function useStream<T>(on: (listener: (value: T) => void) => () => void, listener: (value: T) => void) {
  const current = useRef(listener);
  useEffect(() => { current.current = listener; });
  useEffect(() => on((value) => current.current(value)), [on]);
}

export const useSchematicDrag = (listener: (drag: SchematicDrag) => void) => useStream(onSchematicDrag, listener);
export const useSchematicPortClick = (listener: (pin: SchematicPin) => void) => useStream(onSchematicPortClick, listener);
export const useSchematicWire = (listener: (wire: SchematicWire) => void) => useStream(onSchematicWire, listener);
