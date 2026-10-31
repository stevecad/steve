/**
 * A program posted at six decimals (a milling setup saved before controller-resolution posts) for a controller that
 * rounds finer words: what the machine runs instead of the checked path, said wherever its check or G-code is shown
 * (app/manufacturing/posted_resolution.py). Nothing changes the posted file, its hashes or its download, and
 * nothing runs again by itself: running again (a new revision) posts at the controller's resolution.
 */
import type { PostedResolution } from '@/lib/api';

const AGAIN = 'run it again to post at the controller’s resolution (a new revision; this one stays as it was).';

/**
 * What to do, in the app's words. A CAM program (`cam`) freezes a new revision when it runs again, posted at the
 * controller's resolution unless its code names six decimals; a program edited as manufacturing.py (`program`) keeps
 * each saved setup's output_resolution, so its code says the new one.
 */
export function postedResolutionNextStep(found: PostedResolution, where: 'cam' | 'program'): string {
  if (where === 'program') return `Set output_resolution: 'controller' on setup ‘${found.setup}’ in the program’s code, then ${AGAIN}`;
  if (found.states_six_decimals) return `Setup ‘${found.setup}’ says output_resolution: 'six_decimals' in the program’s code: take that out, then ${AGAIN}`;
  return AGAIN[0].toUpperCase() + AGAIN.slice(1);
}

/** The whole notice: what the control does with the words, then what to do about it. */
export const postedResolutionText = (found: PostedResolution, where: 'cam' | 'program') =>
  `${found.message} ${postedResolutionNextStep(found, where)}`;
