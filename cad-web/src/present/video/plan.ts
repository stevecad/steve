/**
 * A video's plan, before any frame is drawn: its size, frame times (holds, speed and plays), bitrate, and which codec
 * and container to ask the browser for. Plain functions with no browser or app imports, so node tests run them
 * (tests/video_plan_test.mjs).
 */

export type SizePreset = 'view' | '720p' | '1080p' | '1440p' | '2160p';
export type Framing = 'view' | '16:9';
export type Quality = 'standard' | 'high' | 'max';
export type Container = 'mp4' | 'webm';

export interface VideoOptions {
  size: SizePreset;
  /** With a preset size: the viewport's shape, or 16:9 framed like the current camera. */
  framing: Framing;
  fps: 30 | 60;
  quality: Quality;
  format: Container;
  /** Seconds the first and last pose stand still. */
  holdStart: number;
  holdEnd: number;
  /** Playback speed: 0.25 to 4 (2 plays twice as fast). */
  speed: number;
  /** How many times the motion plays. */
  plays: number;
  /** Degrees the camera turns about the view's target over the whole video (0: it stays put). */
  turntable: number;
}

export const DEFAULT_OPTIONS: VideoOptions = {
  size: '1080p', framing: 'view', fps: 30, quality: 'high', format: 'mp4', holdStart: 0, holdEnd: 0, speed: 1, plays: 1, turntable: 0,
};

/** A backstop against a runaway export, far past any sane clip: ten minutes. */
export const MAX_SECONDS = 600;
export const MAX_PLAYS = 100;
export const MAX_HOLD = 60;
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export const PRESETS: Record<Exclude<SizePreset, 'view'>, { width: number; height: number; label: string }> = {
  '720p': { width: 1280, height: 720, label: '720p' },
  '1080p': { width: 1920, height: 1080, label: '1080p' },
  '1440p': { width: 2560, height: 1440, label: '1440p' },
  '2160p': { width: 3840, height: 2160, label: '4K' },
};

/** Even, as H.264 and VP9 need, and at least 2. */
const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/** Scales width × height down (never up) to fit a box, keeping its shape. */
function fit(width: number, height: number, box: { width: number; height: number }) {
  const scale = Math.min(1, box.width / width, box.height / height);
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * The output size in pixels. `view` is the viewport (CSS pixels and device pixel ratio). The viewport's own size keeps
 * its device pixels (at most 4K); a preset fits the viewport's shape inside its box (a tall view at 1080p is 1080 high),
 * or fills the box exactly when framed 16:9.
 */
export function outputSize(options: Pick<VideoOptions, 'size' | 'framing'>, view: { width: number; height: number; dpr: number }) {
  const width = Math.max(1, view.width), height = Math.max(1, view.height);
  if (options.size === 'view') return fit(width * view.dpr, height * view.dpr, PRESETS['2160p']);
  const box = PRESETS[options.size];
  if (options.framing === '16:9') return { width: box.width, height: box.height };
  // Up to the box: a small viewport still exports at the preset's size.
  const scale = Math.min(box.width / width, box.height / height);
  return { width: even(width * scale), height: even(height * scale) };
}

export interface Timeline {
  frames: number;
  /** The video's length, seconds. */
  seconds: number;
  /** Seconds into the take shown by frame `index`. */
  at: (index: number) => number;
  /** Seconds into the video at frame `index` (its timestamp). */
  time: (index: number) => number;
}

/**
 * Frame times: the first pose held `holdStart` seconds, the take played `plays` times at `speed`, the last pose held
 * `holdEnd` seconds. A take that doesn't loop and has no end hold gets one more frame, so the video ends on its last
 * pose exactly rather than a frame short of it. `duration` is the take's length in seconds.
 */
export function timeline(duration: number, options: Pick<VideoOptions, 'fps' | 'holdStart' | 'holdEnd' | 'speed' | 'plays'>, closeEnd = false): Timeline {
  const { fps, holdStart, holdEnd, speed } = options;
  const plays = Math.max(1, Math.round(options.plays));
  const length = Math.max(0, duration);
  const playing = (plays * length) / speed;
  const total = holdStart + playing + holdEnd;
  const closing = closeEnd && holdEnd <= 0 && length > 0 ? 1 : 0;
  const frames = Math.max(1, Math.round(total * fps)) + closing;
  const at = (index: number) => {
    if (length <= 0) return 0;
    const into = index / fps - holdStart;
    if (into <= 0) return 0;
    // Through the plays in take time; a play's start (within float error) is its first pose, not the previous one's last.
    const played = into * speed;
    if (played >= plays * length * (1 - 1e-12)) return length;
    const whole = Math.floor(played / length + 1e-9);
    const t = played - whole * length;
    return t < length * 1e-9 ? 0 : t;
  };
  return { frames, seconds: frames / fps, at, time: (index) => index / fps };
}

/** Bits per second: bits per pixel per frame by quality, times pixels and frame rate (clean CAD renders compress well). */
export function bitrate(width: number, height: number, fps: number, quality: Quality): number {
  const perPixel = quality === 'max' ? 0.3 : quality === 'high' ? 0.14 : 0.07;
  return Math.round(Math.min(120e6, Math.max(1e6, width * height * fps * perPixel)));
}

/** Whether the options make a video STEVE will export, or why not (shown as is). */
export function problem(options: VideoOptions, duration: number): string | null {
  if (options.fps !== 30 && options.fps !== 60) return 'Choose 30 or 60 frames a second.';
  if (!(options.speed >= 0.25 && options.speed <= 4)) return 'Choose a speed from ¼× to 4×.';
  if (!Number.isInteger(options.plays) || options.plays < 1 || options.plays > MAX_PLAYS) return `Play it 1 to ${MAX_PLAYS} times.`;
  for (const hold of [options.holdStart, options.holdEnd]) if (!(hold >= 0 && hold <= MAX_HOLD)) return `Holds are 0 to ${MAX_HOLD} seconds.`;
  if (!(Math.abs(options.turntable) <= 3600)) return 'Turn the camera at most 3600° (ten turns).';
  if (!(duration > 0)) return 'This motion has no length.';
  const seconds = timeline(duration, options).seconds;
  if (seconds > MAX_SECONDS) {
    return `That makes a ${Math.ceil(seconds / 60)} min video; the limit is ${MAX_SECONDS / 60} min. Play it fewer times, shorten the holds or raise the speed.`;
  }
  return null;
}

/* ───────── Codecs ───────── */

export interface Candidate {
  container: Container;
  /** What the muxer calls it. */
  codec: 'avc' | 'vp9' | 'vp8';
  /** The WebCodecs codec string. */
  string: string;
  label: string;
}

// H.264 levels (ITU-T H.264 table A-1): frame size in macroblocks, macroblocks per second, max bitrate (kbit/s, Main).
const AVC_LEVELS = [
  { level: 31, fs: 3600, mbps: 108000, br: 14000 },
  { level: 32, fs: 5120, mbps: 216000, br: 20000 },
  { level: 40, fs: 8192, mbps: 245760, br: 20000 },
  { level: 41, fs: 8192, mbps: 245760, br: 50000 },
  { level: 42, fs: 8704, mbps: 522240, br: 50000 },
  { level: 50, fs: 22080, mbps: 589824, br: 135000 },
  { level: 51, fs: 36864, mbps: 983040, br: 240000 },
  { level: 52, fs: 36864, mbps: 2073600, br: 240000 },
  { level: 60, fs: 139264, mbps: 4177920, br: 240000 },
  { level: 61, fs: 139264, mbps: 8355840, br: 480000 },
  { level: 62, fs: 139264, mbps: 16711680, br: 800000 },
];

/** The lowest H.264 level (as its level_idc, 40 for 4.0) that holds the size, rate and bitrate (High profile), or null. */
export function avcLevel(width: number, height: number, fps: number, bits = 0): number | null {
  const across = Math.ceil(width / 16), down = Math.ceil(height / 16);
  const size = across * down;
  for (const entry of AVC_LEVELS) {
    // No side longer than √(8 × frame size) macroblocks.
    const side = Math.sqrt(entry.fs * 8);
    if (size <= entry.fs && across <= side && down <= side && size * fps <= entry.mbps && bits <= entry.br * 1250) return entry.level;
  }
  return null;
}

// VP9 levels (the VP9 bitstream spec, Annex A): luma picture size and luma samples per second.
const VP9_LEVELS = [
  { level: 31, size: 983040, rate: 36864000 },
  { level: 40, size: 2228224, rate: 83558400 },
  { level: 41, size: 2228224, rate: 160432128 },
  { level: 50, size: 8912896, rate: 311951360 },
  { level: 51, size: 8912896, rate: 588251136 },
  { level: 52, size: 8912896, rate: 1176502272 },
  { level: 60, size: 35651584, rate: 1176502272 },
  { level: 61, size: 35651584, rate: 2353004544 },
];

export function vp9Level(width: number, height: number, fps: number): number {
  const size = width * height;
  return VP9_LEVELS.find((entry) => size <= entry.size && size * fps <= entry.rate)?.level ?? 62;
}

const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');

/**
 * What to ask the browser for, best first. MP4: H.264 High, then Main, then Constrained Baseline at the level the size
 * needs, then WebM (VP9, VP8) as the fallback. WebM: VP9, then VP8.
 */
export function candidates(container: Container, width: number, height: number, fps: number, bits = 0): Candidate[] {
  const webm: Candidate[] = [
    { container: 'webm', codec: 'vp9', string: `vp09.00.${vp9Level(width, height, fps)}.08`, label: 'VP9' },
    { container: 'webm', codec: 'vp8', string: 'vp8', label: 'VP8' },
  ];
  if (container === 'webm') return webm;
  const level = avcLevel(width, height, fps, bits) ?? avcLevel(width, height, fps) ?? 52;
  const avc: Candidate[] = [
    { container: 'mp4', codec: 'avc', string: `avc1.6400${hex(level)}`, label: 'H.264 High' },
    { container: 'mp4', codec: 'avc', string: `avc1.4D00${hex(level)}`, label: 'H.264 Main' },
    { container: 'mp4', codec: 'avc', string: `avc1.42E0${hex(level)}`, label: 'H.264 Baseline' },
  ];
  return [...avc, ...webm];
}

/** The first candidate the browser can encode (`supported` asks it), and whether that falls back from the format asked for. */
export async function chooseCodec(asked: Container, list: Candidate[], supported: (candidate: Candidate) => Promise<boolean>): Promise<{ candidate: Candidate; fellBack: boolean } | null> {
  for (const candidate of list) {
    let ok = false;
    try { ok = await supported(candidate); } catch { ok = false; }
    if (ok) return { candidate, fellBack: candidate.container !== asked };
  }
  return null;
}

/** `hinge-open_close.mp4`: the document's name and the take's, safe for any file system. */
export function fileName(document: string, take: string, container: Container): string {
  const clean = (text: string) => text.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase();
  return `${clean(document) || 'design'}${take ? `-${clean(take) || 'motion'}` : ''}.${container}`;
}
