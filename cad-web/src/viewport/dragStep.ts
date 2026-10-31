/**
 * Snapping while dragging on the canvas: a step a few pixels long at the current zoom (1, 2 or
 * 5 × 10ⁿ mm), so a drag follows the pointer smoothly whether the part is 5 mm or 5 m. Shift is
 * ten times finer.
 */
export function dragStep(mmPerPixel: number, fine = false, pixels = 3): number {
  const target = Math.max((mmPerPixel * pixels) / (fine ? 10 : 1), 1e-4);
  const power = 10 ** Math.floor(Math.log10(target));
  for (const multiple of [1, 2, 5]) if (multiple * power >= target - 1e-12) return multiple * power;
  return 10 * power;
}

export const snapTo = (value: number, step: number) => Number((Math.round(value / step) * step).toFixed(6));

/** Runs `apply` at most once per animation frame with the latest value; `flush` runs a pending one now. */
export function perFrame<T>(apply: (value: T) => void) {
  let frame = 0;
  let pending: { value: T } | null = null;
  const run = () => { frame = 0; const next = pending; pending = null; if (next) apply(next.value); };
  return {
    push(value: T) { pending = { value }; if (!frame) frame = requestAnimationFrame(run); },
    flush() { if (frame) { cancelAnimationFrame(frame); run(); } },
    cancel() { if (frame) cancelAnimationFrame(frame); frame = 0; pending = null; },
  };
}
