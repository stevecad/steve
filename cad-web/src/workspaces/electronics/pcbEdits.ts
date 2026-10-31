/**
 * Moves made by hand in the PCB view, as tscircuit's PCB viewer reports them (`ManualEditEvent`s: a part dragged to a
 * new centre, a trace hint…). The code-rewrite engine (workspaces/electronics/code) listens and turns each finished
 * move into `pcbX` / `pcbY` in the TSX; after the rebuild the viewer starts from the new code with no pending events.
 *
 *   usePcbEdits((events) => { … })   // React: called with every new batch of finished events
 *   onPcbEdit((events) => { … })     // anywhere else; returns an unsubscribe
 *
 * An event is "finished" when the viewer stops reporting it as in progress (`in_progress: false`).
 *
 * Move parts (M, on by default) keeps the viewer in its edit mode, where dragging a part's body moves it. The PCB view
 * passes each move through `placePcbMoves` first: a part doesn't move until the pointer has gone a few pixels (a click
 * picks, it doesn't nudge), and then its centre lands on the board grid.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ManualEditEvent } from '@tscircuit/props';

export type PcbEditEvent = ManualEditEvent;

type Listener = (events: PcbEditEvent[]) => void;
const listeners = new Set<Listener>();
const delivered = new Set<string>();

const keyOf = (event: PcbEditEvent) => String((event as { edit_event_id?: string }).edit_event_id ?? JSON.stringify(event));
const finished = (event: PcbEditEvent) => !(event as { in_progress?: boolean }).in_progress;

/** The grid a moved part's centre snaps to on the board (mm). */
export const PCB_GRID = 0.1;

const MOVE_KEY = 'steve-pcb-move-parts';

/**
 * The viewer's controlled edit events (what it shows as moved until the code catches up), and whether dragging a part
 * moves it (Move parts).
 */
export const usePcbEditState = create<{ events: PcbEditEvent[]; moveParts: boolean }>(() => ({
  events: [],
  moveParts: (() => { try { return localStorage.getItem(MOVE_KEY) !== 'off'; } catch { return true; } })(),
}));

export function setMoveParts(on: boolean) {
  usePcbEditState.setState({ moveParts: on });
  try { localStorage.setItem(MOVE_KEY, on ? 'on' : 'off'); } catch { /* Optional. */ }
}

type Move = { edit_event_id?: string; edit_event_type?: string; in_progress?: boolean; original_center?: { x: number; y: number }; new_center?: { x: number; y: number } };
/** Moves that have left their dead zone: they follow the pointer (snapped) from then on. */
const started = new Set<string>();
const onGrid = (value: number) => Number((Math.round(value / PCB_GRID) * PCB_GRID).toFixed(3));

/**
 * Part moves as they land: still where they were until the pointer has gone `deadZone` mm from where it pressed, then
 * with the centre on the grid. Other edit events pass through.
 */
export function placePcbMoves(events: PcbEditEvent[], deadZone: number): PcbEditEvent[] {
  return events.map((event) => {
    const move = event as Move;
    if (move.edit_event_type !== 'edit_pcb_component_location' || !move.original_center || !move.new_center) return event;
    const id = keyOf(event);
    const from = move.original_center, to = move.new_center;
    if (!started.has(id) && move.in_progress && Math.hypot(to.x - from.x, to.y - from.y) < deadZone) return { ...event, new_center: from } as PcbEditEvent;
    if (!started.has(id) && !move.in_progress && to.x === from.x && to.y === from.y) return event;
    started.add(id);
    return { ...event, new_center: { x: onGrid(to.x), y: onGrid(to.y) } } as PcbEditEvent;
  });
}

/** Whether a (placed) move has taken its part anywhere yet. */
export const isMoving = (event: PcbEditEvent | undefined) => !!event && started.has(keyOf(event));

/** The PCB view calls this with the viewer's full list of edit events. */
export function reportPcbEdits(events: PcbEditEvent[]) {
  usePcbEditState.setState({ events });
  const fresh = events.filter((event) => finished(event) && !delivered.has(keyOf(event)));
  if (!fresh.length) return;
  for (const event of fresh) delivered.add(keyOf(event));
  if (import.meta.env.DEV) console.debug('[pcb edits]', fresh.map((event) => event.edit_event_type).join(', '));
  for (const listener of listeners) listener(fresh);
}

/** A new circuit (rebuilt from code): the viewer's pending moves are now in the code, or were undone. */
export function clearPcbEdits() {
  usePcbEditState.setState({ events: [] });
  delivered.clear();
  started.clear();
}

export function onPcbEdit(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePcbEdits(listener: Listener) {
  const current = useRef(listener);
  useEffect(() => { current.current = listener; });
  useEffect(() => onPcbEdit((events) => current.current(events)), []);
}
