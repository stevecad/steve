/**
 * Touch and hold on the model opens its context menu, as a right-click does on the desktop: the viewport's own click
 * handling (viewer.clickAt, button 2) selects what's under the finger and opens the menu there. Safari never sends
 * contextmenu for a long press, so the timer is ours. A second finger, a drag or lifting early cancels it.
 * Once the menu is open the press is over: the camera gets a pointercancel (ending its drag) and the finger's lift is
 * kept from the canvas, so it isn't also a tap that selects something else and closes the menu; a click the browser
 * may still make of the lift is dropped, so it can't land on the menu that just opened under the finger.
 */
import { viewer } from '@/viewport/viewer';

const HOLD_MS = 480;
const SLOP_PX = 9;

export function installLongPress(element: HTMLElement): () => void {
  let timer = 0;
  let start: { x: number; y: number; id: number } | null = null;
  let touches = 0;
  let swallow: number | null = null;
  let synthetic = false;
  let quietUntil = 0;
  const cancel = () => { window.clearTimeout(timer); timer = 0; start = null; };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    touches += 1;
    if (touches > 1 || !(event.target as HTMLElement | null)?.closest('canvas')) { cancel(); return; }
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    const { clientX, clientY } = event;
    timer = window.setTimeout(() => {
      timer = 0;
      if (!start) return;
      navigator.vibrate?.(8);
      const target = event.target as HTMLElement;
      synthetic = true;
      target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: event.pointerId, pointerType: 'touch', bubbles: true }));
      synthetic = false;
      swallow = event.pointerId;
      quietUntil = performance.now() + 700;
      viewer.clickAt({ clientX, clientY, button: 2, pointerId: event.pointerId, ctrlKey: false, metaKey: false, shiftKey: false } as unknown as PointerEvent, 2);
      start = null;
    }, HOLD_MS);
  };
  const onMove = (event: PointerEvent) => {
    if (swallow === event.pointerId) { event.stopPropagation(); return; }
    if (start && event.pointerId === start.id && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
  };
  const onUp = (event: PointerEvent) => {
    if (synthetic) return;
    if (event.pointerType === 'touch') touches = Math.max(0, touches - 1);
    if (swallow === event.pointerId && event.type === 'pointerup') { swallow = null; quietUntil = performance.now() + 400; event.stopPropagation(); return; }
    if (start && event.pointerId === start.id) cancel();
  };

  const onClick = (event: MouseEvent) => {
    if (performance.now() < quietUntil) { event.stopPropagation(); event.preventDefault(); }
  };

  element.addEventListener('pointerdown', onDown, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', onClick, true);
  element.addEventListener('pointermove', onMove, true);
  element.addEventListener('pointerup', onUp, true);
  element.addEventListener('pointercancel', onUp, true);
  return () => {
    cancel();
    element.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mousedown', onClick, true);
    element.removeEventListener('pointermove', onMove, true);
    element.removeEventListener('pointerup', onUp, true);
    element.removeEventListener('pointercancel', onUp, true);
  };
}
