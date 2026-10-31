/**
 * While a tool picks one kind of geometry (CAM contour edges, hole walls, a pocket floor…), hover lights only what it
 * can take, and the pointer says "not that" over the rest. One guard at a time; the tool that set it clears it.
 */
import type { Pick } from '@/state/store';

let guard: ((pick: Pick) => boolean) | null = null;

export function setPickGuard(next: ((pick: Pick) => boolean) | null) { guard = next; }

/** Whether hover may light this pick (always, with no guard). */
export const pickAllowed = (pick: Pick) => !guard || guard(pick);
