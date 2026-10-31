/**
 * tscircuit's PCB viewer keeps its camera and its modes to itself. The transform it draws with (board millimetres →
 * pixels in the viewer's root element) is passed to its renderer as a prop, so it's read from the renderer's live React
 * fiber: the one React has on screen (its alternate holds the props from the render before). Picks are hit-tested with
 * it and highlights drawn to match (PcbView.tsx); tests use `pcbToScreen` to click a pad or a trace.
 *
 * Its edit mode (dragging parts) has no button of its own; Move parts switches it through the viewer's store, the
 * value its store context provides to the same fiber tree.
 */
import { CanvasElementsRenderer } from '@tscircuit/pcb-viewer';
import { applyToPoint, type Matrix } from 'transformation-matrix';

type ViewerStore = { getState: () => {
  setEditMode?: (mode: 'off' | 'move_footprint') => void; in_move_footprint_mode?: boolean;
  setIsShowingRatsNest?: (on: boolean) => void; is_showing_rats_nest?: boolean;
} };
type Fiber = { type: unknown; tag: number; return: Fiber | null; alternate: Fiber | null; memoizedProps?: { transform?: Matrix; value?: ViewerStore }; stateNode?: { current?: Fiber } };

/** Whether a fiber belongs to the tree React has on screen (its alternate holds the props from the render before). */
const onScreen = (fiber: Fiber) => { let root = fiber; while (root.return) root = root.return; return root.tag === 3 && root.stateNode?.current === root; };

/** The transform tscircuit's viewer draws with (board mm → pixels in its root element), read from its renderer's props. */
export function viewerTransform(host: HTMLElement): { transform: Matrix; root: HTMLElement } | null {
  for (const canvas of host.querySelectorAll('canvas')) {
    const key = Object.keys(canvas).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? (canvas as unknown as Record<string, Fiber>)[key] : null;
    while (fiber) {
      if (fiber.type === CanvasElementsRenderer) {
        const live = onScreen(fiber) ? fiber : fiber.alternate && onScreen(fiber.alternate) ? fiber.alternate : fiber;
        const transform = live.memoizedProps?.transform;
        // The viewer's root (where its mouse coordinates start): the host's child holding the canvas.
        let root: HTMLElement | null = canvas;
        while (root && root.parentElement !== host) root = root.parentElement;
        return transform && Number.isFinite(transform.a) && root ? { transform, root } : null;
      }
      fiber = fiber.return;
    }
  }
  return null;
}

/** The layer the viewer shows on top (its toolbar reads "layer: top"). */
export function shownLayer(host: HTMLElement): string | null {
  for (const element of host.querySelectorAll<HTMLElement>('[data-toolbar-overlay] *')) {
    const match = /^layer:\s*([a-z0-9_]+)$/i.exec(element.textContent?.trim() ?? '');
    if (match && !element.children.length) return match[1];
  }
  return null;
}

/** Where a board point (mm) is on screen (client coordinates), in the PCB view on screen; null without one. */
export function pcbToScreen(x: number, y: number): { x: number; y: number } | null {
  const host = document.querySelector<HTMLElement>('#pcb-view');
  const found = host ? viewerTransform(host) : null;
  if (!found) return null;
  const rect = found.root.getBoundingClientRect();
  const point = applyToPoint(found.transform, { x, y });
  return { x: point.x + rect.left, y: point.y + rect.top };
}

/** The viewer's own store (its state and actions), from the context that provides it; null before it has drawn. */
function viewerStore(host: HTMLElement): ViewerStore | null {
  const canvas = host.querySelector('canvas');
  const key = canvas && Object.keys(canvas).find((name) => name.startsWith('__reactFiber$'));
  for (let fiber = key ? (canvas as unknown as Record<string, Fiber>)[key] : null; fiber; fiber = fiber.return) {
    const store = fiber.memoizedProps?.value;
    if (store && typeof store.getState === 'function' && typeof store.getState().setEditMode === 'function') return store;
  }
  return null;
}

/** Turns the viewer's part dragging (its edit mode) on or off; false when the viewer isn't there yet. */
export function setViewerEditMode(host: HTMLElement, on: boolean): boolean {
  const store = viewerStore(host);
  if (!store) return false;
  if (!!store.getState().in_move_footprint_mode !== on) store.getState().setEditMode?.(on ? 'move_footprint' : 'off');
  return true;
}

/** Shows or hides the viewer's ratsnest (its "Rats Nest" toggle); false when the viewer isn't there yet. */
export function setViewerRatsNest(host: HTMLElement, on: boolean): boolean {
  const store = viewerStore(host);
  if (!store) return false;
  if (!!store.getState().is_showing_rats_nest !== on) store.getState().setIsShowingRatsNest?.(on);
  return true;
}
