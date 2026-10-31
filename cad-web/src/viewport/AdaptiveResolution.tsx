import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { viewer } from './viewer';
import { useSpaceMouse } from './spacemouse';

/** Frames slower than this while the camera moves lower the resolution. */
const SLOW_FRAME = 1 / 45;
/** The lowest pixel ratio a moving view drops to, and the step it drops by. */
const FLOOR = 0.6;
const STEP = 0.75;
/** Frames measured before deciding, so one hitch doesn't blur the view. */
const SAMPLES = 6;

/**
 * Heavy models: while the camera moves and frames come too slowly, render at a lower pixel ratio, then return to
 * full sharpness as soon as it rests. Light models never drop. The ratio a model needed is kept for its next move,
 * so each drag doesn't start out slow again.
 */
export default function AdaptiveResolution() {
  const setDpr = useThree((state) => state.setDpr);
  const invalidate = useThree((state) => state.invalidate);
  const state = useRef({ model: viewer.model, learned: Infinity, last: 0, average: 0, samples: 0 });

  // The space mouse moves the camera without waking camera-controls; draw once more when it lets go.
  useEffect(() => useSpaceMouse.subscribe((now, before) => { if (before.active && !now.active) invalidate(); }), [invalidate]);

  useFrame(({ viewport }) => {
    const s = state.current;
    const full = viewport.initialDpr || viewport.dpr;
    if (s.model !== viewer.model) { s.model = viewer.model; s.learned = full; }
    if (!(viewer.moving || useSpaceMouse.getState().active)) {
      s.last = 0;
      s.samples = 0;
      if (viewport.dpr !== full) setDpr(full);
      return;
    }
    const target = Math.min(full, s.learned);
    if (viewport.dpr !== target) { setDpr(target); s.samples = 0; }
    const now = performance.now();
    const delta = s.last ? (now - s.last) / 1000 : 0;
    s.last = now;
    // A pause mid-gesture isn't a slow frame.
    if (!delta || delta > 0.25) return;
    s.average = s.samples ? s.average * 0.75 + delta * 0.25 : delta;
    if (++s.samples < SAMPLES || s.average < SLOW_FRAME || target <= FLOOR) return;
    s.learned = Math.max(FLOOR, target * STEP);
    s.samples = 0;
    setDpr(s.learned);
  });

  return null;
}
