/**
 * What a running build is doing, as the server reports it on GET /v1/builds/{id} and its event stream (metadata.progress,
 * app/build_progress.py), in the few words the status bar shows: "Animation check 'walk' · sample 120 of 285".
 */
export interface BuildProgress {
  stage: string;
  /** The item being worked on: an animation, drive, fit check or component. */
  name?: string;
  done?: number;
  of?: number;
  elapsed_s?: number;
  budget_s?: number;
}

/** Each stage's words and what its count counts (app/build_progress.py STAGES). */
const STAGES: Record<string, [string, string]> = {
  main: ['Running main.py', 'step'],
  links: ['Building linked documents', 'document'],
  components: ['Building components', 'component'],
  drives: ['Drive check', 'sample'],
  animation_check: ['Animation check', 'sample'],
  collision_study: ['Collision study', 'pose'],
  fit_check: ['Fit check', 'step'],
  cable_check: ['Cable check', 'pose'],
  fastener_check: ['Fastener check', 'fastener'],
  sheet_metal: ['Sheet metal export', 'step'],
  step_export: ['Exporting STEP', 'step'],
  drawings: ['Drawings', 'sheet'],
  meshes: ['Meshes and topology', 'step'],
  views: ['Views', 'view'],
  render: ['Rendering the animation', 'frame'],
};

/** 45 s, 14 min, 1 h 20 min, 4 h. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A running build's status line, or `fallback` until (or unless) the server says what it's doing. `time`: with the time
 *  used of its budget (the status bar has its own clock beside it, so leaves it out). */
export function progressLabel(progress: BuildProgress | null | undefined, fallback = 'Running', time = false): string {
  const stage = progress && STAGES[progress.stage];
  if (!progress || !stage) return fallback;
  const [words, noun] = stage;
  const parts = [progress.name ? `${words} '${progress.name}'` : words];
  if (progress.of && progress.done !== undefined) parts.push(`${noun} ${progress.done} of ${progress.of}`);
  if (time && progress.elapsed_s !== undefined) parts.push(progress.budget_s ? `${duration(progress.elapsed_s)} of ${duration(progress.budget_s)}` : duration(progress.elapsed_s));
  return parts.join(' · ');
}
