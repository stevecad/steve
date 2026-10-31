/**
 * Viewer edits back to code. tscircuit places a part at its parent's anchor plus `pcbX`/`pcbY`: the anchor is the
 * group's `anchor_position` for parts in a group or subcircuit (`pcb_component.positioned_relative_to_pcb_group_id`),
 * else the board centre. A drag moves the written position by the drag's delta; a part placed automatically (no
 * written position) gets one from its new absolute centre.
 */
import { moveBy, indexFor, setPosition } from './edits';
import { CircuitLookup } from './selectors';
import { EditError, type EditResult, type Element, type SourceIndex } from './types';

type Point = { x: number; y: number };

/** The written element for a source, PCB or schematic component in the circuit, or null if this file doesn't name it. */
export function elementForComponent(index: SourceIndex, lookup: CircuitLookup, componentId: string): Element | null {
  const source = lookup.sourceComponent(componentId);
  if (!source || typeof source.name !== 'string') return null;
  const candidates = index.elements.filter((element) => element.name === source.name);
  if (candidates.length <= 1) return candidates[0] ?? null;
  // The same name in different groups or subcircuits: match the named groups around it.
  const path = lookup.groupPath(source.source_group_id as string | undefined).join('/');
  const named = (element: Element) => {
    const names: string[] = [];
    for (let id = element.parent; id !== null; id = index.elements[id].parent) {
      const ancestor = index.elements[id];
      if ((ancestor.tag === 'group' || ancestor.tag === 'subcircuit') && ancestor.name) names.unshift(ancestor.name);
    }
    return names.join('/');
  };
  const matches = candidates.filter((element) => named(element) === path);
  return matches.length === 1 ? matches[0] : null;
}

/** Where a PCB component's `pcbX`/`pcbY` are measured from. */
export function pcbAnchor(lookup: CircuitLookup, pcbComponentId: string): Point {
  const component = lookup.get(pcbComponentId);
  // A written position names its group; a part placed automatically doesn't, so use the PCB group of its own group.
  const sourceGroup = lookup.sourceComponent(pcbComponentId)?.source_group_id;
  const group = lookup.get(component?.positioned_relative_to_pcb_group_id as string | undefined)
    ?? lookup.ofType('pcb_group').find((row) => row.source_group_id === sourceGroup);
  if (group?.anchor_position) return group.anchor_position as Point;
  const board = lookup.get(component?.positioned_relative_to_pcb_board_id as string | undefined) ?? lookup.ofType('pcb_board')[0];
  return (board?.center as Point | undefined) ?? { x: 0, y: 0 };
}

const round = (value: number) => Math.round(value * 100) / 100;

export interface ViewEditEvent {
  edit_event_type: string;
  in_progress?: boolean;
  pcb_component_id?: string;
  schematic_component_id?: string;
  pcb_group_id?: string;
  original_center: Point;
  new_center: Point;
}

function unchanged(code: string): EditResult { return { code, changed: false, notes: [] }; }

function nameOf(lookup: CircuitLookup, componentId: string) {
  return (lookup.sourceComponent(componentId)?.name as string | undefined) ?? 'That part';
}

/**
 * A `@tscircuit/pcb-viewer` manual edit (`edit_pcb_component_location`, or `edit_pcb_group_location` for a group) as
 * a code edit. Events still in progress are ignored: apply the one the drag ends with.
 */
export function applyPcbEditEvent(code: string, circuit: readonly unknown[], event: ViewEditEvent): EditResult {
  if (event.in_progress) return unchanged(code);
  const lookup = new CircuitLookup(circuit);
  const index = indexFor(code);
  const dx = round(event.new_center.x - event.original_center.x);
  const dy = round(event.new_center.y - event.original_center.y);
  if (!dx && !dy) return unchanged(code);
  if (event.edit_event_type === 'edit_pcb_group_location' && event.pcb_group_id) {
    const group = lookup.get(event.pcb_group_id);
    const source = lookup.get(group?.source_group_id as string | undefined);
    const element = index.elements.find((item) => (item.tag === 'group' || item.tag === 'subcircuit') && item.name && item.name === source?.name);
    if (!element) throw new EditError('not_found', 'That group isn’t named in this file, so it can’t be moved from the board.');
    const moved = moveBy(code, { start: element.span.start }, 'pcb', dx, dy);
    if (!moved.unplaced.length) return moved;
    const anchor = group!.anchor_position as Point;
    const parentGroup = lookup.get(group!.positioned_relative_to_pcb_group_id as string | undefined);
    const base = (parentGroup?.anchor_position as Point | undefined) ?? ((lookup.ofType('pcb_board')[0]?.center as Point | undefined) ?? { x: 0, y: 0 });
    const position: { pcbX?: number; pcbY?: number } = {};
    if (moved.unplaced.includes('x')) position.pcbX = anchor.x + dx - base.x;
    if (moved.unplaced.includes('y')) position.pcbY = anchor.y + dy - base.y;
    const placed = setPosition(moved.code, { start: element.span.start }, position);
    return { ...placed, changed: true, notes: [...moved.notes, ...placed.notes] };
  }
  if (event.edit_event_type !== 'edit_pcb_component_location' || !event.pcb_component_id) return unchanged(code);
  const element = elementForComponent(index, lookup, event.pcb_component_id);
  if (!element) throw new EditError('not_found', `${nameOf(lookup, event.pcb_component_id)} isn’t written with its own name in this file, so it can’t be moved from the board.`);
  const moved = moveBy(code, { start: element.span.start }, 'pcb', dx, dy);
  if (!moved.unplaced.length) return moved;
  const anchor = pcbAnchor(lookup, event.pcb_component_id);
  const position: { pcbX?: number; pcbY?: number } = {};
  if (moved.unplaced.includes('x')) position.pcbX = event.new_center.x - anchor.x;
  if (moved.unplaced.includes('y')) position.pcbY = event.new_center.y - anchor.y;
  const placed = setPosition(moved.code, { start: element.span.start }, position);
  return { ...placed, changed: true, notes: [...moved.notes, ...placed.notes] };
}

/** Where a schematic component's `schX`/`schY` are measured from: the written positions of the groups around it. */
function schematicAnchor(index: SourceIndex, element: Element): Point {
  const anchor = { x: 0, y: 0 };
  for (let id = element.parent; id !== null; id = index.elements[id].parent) {
    const ancestor = index.elements[id];
    for (const [prop, axis] of [['schX', 'x'], ['schY', 'y']] as const) {
      const attr = [...ancestor.attrs].reverse().find((item) => item.name === prop);
      if (attr?.static && typeof attr.value === 'number') anchor[axis] += attr.value;
    }
  }
  return anchor;
}

/** A schematic drag (`edit_schematic_component_location`) as a code edit. */
export function applySchematicEditEvent(code: string, circuit: readonly unknown[], event: ViewEditEvent): EditResult {
  if (event.in_progress || event.edit_event_type !== 'edit_schematic_component_location' || !event.schematic_component_id) return unchanged(code);
  const lookup = new CircuitLookup(circuit);
  const index = indexFor(code);
  const dx = round(event.new_center.x - event.original_center.x);
  const dy = round(event.new_center.y - event.original_center.y);
  if (!dx && !dy) return unchanged(code);
  const element = elementForComponent(index, lookup, event.schematic_component_id);
  if (!element) throw new EditError('not_found', `${nameOf(lookup, event.schematic_component_id)} isn’t written with its own name in this file, so it can’t be moved from the schematic.`);
  const moved = moveBy(code, { start: element.span.start }, 'sch', dx, dy);
  if (!moved.unplaced.length) return moved;
  const anchor = schematicAnchor(index, element);
  const position: { schX?: number; schY?: number } = {};
  if (moved.unplaced.includes('x')) position.schX = event.new_center.x - anchor.x;
  if (moved.unplaced.includes('y')) position.schY = event.new_center.y - anchor.y;
  const placed = setPosition(moved.code, { start: element.span.start }, position);
  return { ...placed, changed: true, notes: [...moved.notes, ...placed.notes] };
}
