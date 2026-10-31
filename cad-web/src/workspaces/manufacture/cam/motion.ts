/**
 * Decoded machine motion for the CAM player (docs/MANUFACTURING_NATIVE_JOBS.md, "Binary motion for the player").
 * `steve_linear_motion_le_v1`: 36 little-endian bytes per move, in machine space and millimetres. Drawing data only:
 * every check ran on the backend's full-precision decoded moves, so nothing here decides anything.
 *
 * No imports: this module is unit-tested under plain Node (tests/cam_player_test.mjs).
 */

export const RECORD_BYTES = 36;
export const MOTION_FORMAT = 'steve_linear_motion_le_v1';
/** A combined program (docs/MANUFACTURING_PROGRAM_POSTS.md): the same 36-byte moves, several tools, chunks split at M6. */
export const PROGRAM_MOTION_FORMAT = 'steve_program_motion_le_v1';
export const MOTION_FORMATS = [MOTION_FORMAT, PROGRAM_MOTION_FORMAT];
/** `operation` on a transition move (tool change routes) or when operation attribution is unavailable. */
export const UNASSIGNED = 4294967295;

/** Move kinds as the format numbers them (simulation.json repeats them in `move_kinds`). */
export const MOVE_KINDS = ['rapid', 'feed', 'plunge', 'lead', 'link', 'retract'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** One chunk's moves, column by column (cheap to draw and to scrub). */
export interface MotionChunk {
  first: number;
  count: number;
  /** Tool-tip endpoints: x, y, z per move. */
  end: Float32Array;
  kind: Uint8Array;
  operation: Uint32Array;
  tool: Uint32Array;
  rpm: Float32Array;
  /** mm/min; 0 on rapids (not a simulated rapid speed). */
  feed: Float32Array;
  /** One-based physical line in the posted program. */
  line: Uint32Array;
}

export class MotionFormatError extends Error {}

/** Decodes one chunk file. `first` is the chunk's `first_move`; `expected` its move count from the index. */
export function decodeChunk(buffer: ArrayBuffer, first: number, expected?: number): MotionChunk {
  if (buffer.byteLength % RECORD_BYTES) throw new MotionFormatError(`Motion data has ${buffer.byteLength} bytes, not a whole number of ${RECORD_BYTES}-byte moves.`);
  const count = buffer.byteLength / RECORD_BYTES;
  if (expected !== undefined && count !== expected) throw new MotionFormatError(`Motion chunk holds ${count} moves; its index says ${expected}.`);
  const view = new DataView(buffer);
  const chunk: MotionChunk = {
    first, count,
    end: new Float32Array(count * 3), kind: new Uint8Array(count), operation: new Uint32Array(count), tool: new Uint32Array(count),
    rpm: new Float32Array(count), feed: new Float32Array(count), line: new Uint32Array(count),
  };
  for (let i = 0, at = 0; i < count; i++, at += RECORD_BYTES) {
    chunk.end[i * 3] = view.getFloat32(at, true);
    chunk.end[i * 3 + 1] = view.getFloat32(at + 4, true);
    chunk.end[i * 3 + 2] = view.getFloat32(at + 8, true);
    const kind = view.getUint8(at + 12);
    if (kind >= MOVE_KINDS.length) throw new MotionFormatError(`Move ${first + i} has an unknown kind (${kind}).`);
    chunk.kind[i] = kind;
    chunk.operation[i] = view.getUint32(at + 16, true);
    chunk.tool[i] = view.getUint32(at + 20, true);
    chunk.rpm[i] = view.getFloat32(at + 24, true);
    chunk.feed[i] = view.getFloat32(at + 28, true);
    chunk.line[i] = view.getUint32(at + 32, true);
  }
  return chunk;
}

/**
 * The whole decoded program as one set of columns, plus where it starts. Chunks must be contiguous and in order
 * (the index says so; this checks).
 */
export interface Motion extends MotionChunk {
  start: [number, number, number];
  /**
   * Moves that start somewhere other than the previous endpoint: a combined program's chunk after a tool change starts
   * at the replacement tool's tip (the physical gauge didn't move; the tip did). Nothing is drawn between the two tips.
   */
  restarts: Map<number, [number, number, number]>;
}

/** `starts`: each chunk's index entry (`first_move`, `initial_position_mm`); a chunk whose start isn't the previous end restarts there. */
export function joinChunks(chunks: MotionChunk[], start: [number, number, number], starts: { first: number; at: [number, number, number] }[] = []): Motion {
  const count = chunks.reduce((sum, chunk) => sum + chunk.count, 0);
  const out: Motion = {
    first: 0, count, start, restarts: new Map(),
    end: new Float32Array(count * 3), kind: new Uint8Array(count), operation: new Uint32Array(count), tool: new Uint32Array(count),
    rpm: new Float32Array(count), feed: new Float32Array(count), line: new Uint32Array(count),
  };
  let next = 0;
  for (const chunk of chunks) {
    if (chunk.first !== next) throw new MotionFormatError(`Motion chunk starts at move ${chunk.first}; expected ${next}.`);
    out.end.set(chunk.end, next * 3);
    out.kind.set(chunk.kind, next);
    out.operation.set(chunk.operation, next);
    out.tool.set(chunk.tool, next);
    out.rpm.set(chunk.rpm, next);
    out.feed.set(chunk.feed, next);
    out.line.set(chunk.line, next);
    next += chunk.count;
  }
  for (const entry of starts) {
    if (entry.first <= 0 || entry.first >= count) continue;
    const at = (entry.first - 1) * 3;
    // Endpoints are stored as float32: a chunk that continues from the previous move starts at exactly that stored
    // point once its start is rounded the same way; anything else is a restart.
    const continues = [0, 1, 2].every((axis) => Math.fround(entry.at[axis]) === out.end[at + axis]);
    if (!continues) out.restarts.set(entry.first, [entry.at[0], entry.at[1], entry.at[2]]);
  }
  return out;
}

/** Where move `index` starts: the previous endpoint, or the program's initial tool-tip position. */
export function moveStart(motion: Motion, index: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (index <= 0) { out[0] = motion.start[0]; out[1] = motion.start[1]; out[2] = motion.start[2]; return out; }
  const restart = motion.restarts?.get(index);
  if (restart && index < motion.count) { out[0] = restart[0]; out[1] = restart[1]; out[2] = restart[2]; return out; }
  const at = (index - 1) * 3;
  out[0] = motion.end[at]; out[1] = motion.end[at + 1]; out[2] = motion.end[at + 2];
  return out;
}

/**
 * The tool tip at playback position `t`, where move i spans [i, i + 1): straight-line interpolation along the move,
 * for drawing only. t ≤ 0 is the start pose; t ≥ count is the last endpoint.
 */
export function tipAt(motion: Motion, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!motion.count || t <= 0) return moveStart(motion, 0, out);
  if (t >= motion.count) return moveStart(motion, motion.count, out);
  const index = Math.floor(t), f = t - index;
  moveStart(motion, index, out);
  const at = index * 3;
  out[0] += (motion.end[at] - out[0]) * f;
  out[1] += (motion.end[at + 1] - out[1]) * f;
  out[2] += (motion.end[at + 2] - out[2]) * f;
  return out;
}

/** The move playing at position t (clamped to the program), or -1 when there are no moves. */
export const moveAt = (motion: Motion, t: number) => (motion.count ? Math.min(motion.count - 1, Math.max(0, Math.floor(t))) : -1);

export const moveLength = (motion: Motion, index: number) => {
  const a = moveStart(motion, index), at = index * 3;
  return Math.hypot(motion.end[at] - a[0], motion.end[at + 1] - a[1], motion.end[at + 2] - a[2]);
};

/** The first move whose posted line is `line` (or the nearest following one), for click-a-line → seek. */
export function moveForLine(motion: Motion, line: number): number {
  let best = -1;
  for (let i = 0; i < motion.count; i++) {
    if (motion.line[i] === line) return i;
    if (motion.line[i] > line && (best < 0 || motion.line[i] < motion.line[best])) best = i;
  }
  return best;
}

/**
 * Seconds each move takes at its programmed feed (rapids at `rapidMmMin`, a display pace since the format carries no
 * simulated rapid speed). Cumulative, so playback can run in "machine time" rather than one move per tick.
 */
export function cumulativeTime(motion: Motion, rapidMmMin: number): Float64Array {
  const out = new Float64Array(motion.count + 1);
  for (let i = 0; i < motion.count; i++) {
    const rate = motion.kind[i] === 0 || motion.feed[i] <= 0 ? rapidMmMin : motion.feed[i];
    out[i + 1] = out[i] + (moveLength(motion, i) / rate) * 60;
  }
  return out;
}

/** Playback position (move units) at time `seconds` along a cumulative time table. */
export function positionAtTime(times: Float64Array, seconds: number): number {
  const count = times.length - 1;
  if (count <= 0 || seconds <= 0) return 0;
  if (seconds >= times[count]) return count;
  let lo = 0, hi = count;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= seconds) lo = mid; else hi = mid; }
  const span = times[lo + 1] - times[lo];
  return lo + (span > 0 ? (seconds - times[lo]) / span : 1);
}

export const timeAtPosition = (times: Float64Array, t: number) => {
  const count = times.length - 1;
  if (count <= 0 || t <= 0) return 0;
  if (t >= count) return times[count];
  const index = Math.floor(t);
  return times[index] + (times[index + 1] - times[index]) * (t - index);
};
