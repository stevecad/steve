/**
 * Dropping a part from the Place gallery (workspaces/electronics/palette) onto a view puts it in the code there:
 * at the drop point on the schematic (`schX` / `schY`, snapped to the grid); on the board, where tscircuit's layout
 * puts it. Moving it on the board afterwards is a drag (Move parts, PcbView.tsx).
 *
 * The gallery and the placement code are E3's (palette/Palette.tsx, parts/place.ts), loaded when first needed.
 */
import type { DragEvent } from 'react';
import { get, toast } from '@/state/store';
import { setCode } from '@/state/actions';
import { selectSoon } from './state';

/** Drag data a part from the gallery carries (its element tag). */
export const PART_DRAG_TYPE = 'application/x-steve-circuit-part';

export type PlaceAt = { schX: number; schY: number } | { pcbX: number; pcbY: number } | null;

type PaletteModule = { partFromDrop: (event: { dataTransfer: { getData: (type: string) => string } }) => unknown };
type PlaceModule = { placePart: (code: string, part: never, options: { at?: Record<string, number> }) => { code: string; changed: boolean; name: string | null; notes: string[] } };
const palettes = import.meta.glob<PaletteModule>('./palette/Palette.tsx');
const placers = import.meta.glob<PlaceModule>('./parts/place.ts');

/** Whether a drag carries a part from the gallery (and placing parts is available in this build). */
export const carriesPart = (event: DragEvent) => event.dataTransfer.types.includes(PART_DRAG_TYPE) && Object.keys(palettes).length > 0 && Object.keys(placers).length > 0;

/** Places the dropped part. `at` is read during the drop (the browser clears the drag data after it). */
export async function dropPart(event: DragEvent, at: PlaceAt): Promise<void> {
  const tag = event.dataTransfer.getData(PART_DRAG_TYPE);
  if (!tag) return;
  try {
    const [palette, place] = await Promise.all([Object.values(palettes)[0]?.(), Object.values(placers)[0]?.()]);
    if (!palette || !place) return;
    const part = palette.partFromDrop({ dataTransfer: { getData: (type: string) => (type === PART_DRAG_TYPE ? tag : '') } });
    if (!part) { toast('warning', 'That part can’t be placed', `“${tag}” isn’t in the gallery.`); return; }
    const result = place.placePart(get().doc.code, part as never, at ? { at } : {});
    if (!result.changed) return;
    setCode(result.code);
    if (result.name) selectSoon([result.name]);
    for (const note of result.notes) toast('info', 'Placed', note);
  } catch (error) {
    toast('warning', 'Couldn’t place the part', (error as Error).message);
  }
}
