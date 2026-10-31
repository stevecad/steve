/**
 * Stock playback from the backend's keyframes and timed cell transitions (docs/MANUFACTURING_STOCK_DELTAS.md,
 * `steve_stock_delta_le_v1`). Each checkpoint has raw occupancy bytes on the common grid; each decoded move has the
 * cells it changes and the fraction of the move at which each one changes. Playing forward applies the transitions as
 * the tool passes. A seek back restores the nearest keyframe at or before it and replays forward. The browser applies
 * the backend's bytes only: it computes no cutter intersection and no verdict. Jobs without the stream (older ones)
 * show the checkpoints alone.
 *
 * No imports: this module is unit-tested under plain Node (tests/cam_player_test.mjs).
 */

/** Occupancy as the stream encodes it: definite material, uncertain material, removed. */
export const REMOVED = 0;
export const UNCERTAIN = 2;
export const DEFINITE = 3;
export type CellState = typeof REMOVED | typeof UNCERTAIN | typeof DEFINITE;

/** The checkpoint grid (StockSnapshot.grid): origin and cell size in machine millimetres, x-fastest cell order. */
export interface StockGrid { origin_mm: number[]; cell_mm: number; shape: number[] }

/** A checkpoint as the player needs it: after which move (−1 = initial stock), how to show it and, once loaded, its cells. */
export interface Keyframe<Display = unknown> { afterMove: number; display: Display; cells?: Uint8Array | null }

export const DELTA_MAGIC = 'STVSDLT1';
export const DELTA_TICKS = 65535;
const HEADER_BYTES = 24;
const RECORD_BYTES = 8;

export class DeltaFormatError extends Error {}

/** One chunk of the stream: moves [first, last], each move's records [offsets[i], offsets[i + 1]), in (tick, cell) order. */
export interface DeltaChunk { first: number; last: number; offsets: Uint32Array; cell: Uint32Array; tick: Uint16Array; before: Uint8Array; after: Uint8Array }

/** Decodes a `STVSDLT1` chunk, checking its header against the index's move range and its own byte count. */
export function decodeDeltaChunk(buffer: ArrayBuffer, first?: number, last?: number): DeltaChunk {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES) throw new DeltaFormatError('A stock delta chunk is shorter than its header.');
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== DELTA_MAGIC) throw new DeltaFormatError(`Not a stock delta chunk (${JSON.stringify(magic)}).`);
  const from = view.getUint32(8, true), to = view.getUint32(12, true), records = view.getUint32(16, true), count = view.getUint32(20, true);
  if ((first !== undefined && from !== first) || (last !== undefined && to !== last)) throw new DeltaFormatError(`The chunk holds moves ${from}–${to}; the index says ${first}–${last}.`);
  if (to < from || count !== to - from + 2) throw new DeltaFormatError('The chunk\'s move offsets don\'t match its move range.');
  if (buffer.byteLength !== HEADER_BYTES + 4 * count + RECORD_BYTES * records) throw new DeltaFormatError('The chunk\'s length doesn\'t match its records.');
  const offsets = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = view.getUint32(HEADER_BYTES + 4 * i, true);
    if (i ? offsets[i] < offsets[i - 1] : offsets[i] !== 0) throw new DeltaFormatError('The chunk\'s move offsets must start at zero and never decrease.');
  }
  if (offsets[count - 1] !== records) throw new DeltaFormatError('The chunk\'s move offsets don\'t end at its record count.');
  const cell = new Uint32Array(records), tick = new Uint16Array(records), before = new Uint8Array(records), after = new Uint8Array(records);
  for (let i = 0, at = HEADER_BYTES + 4 * count; i < records; i++, at += RECORD_BYTES) {
    cell[i] = view.getUint32(at, true);
    tick[i] = view.getUint16(at + 4, true);
    before[i] = view.getUint8(at + 6);
    after[i] = view.getUint8(at + 7);
  }
  return { first: from, last: to, offsets, cell, tick, before, after };
}

export class CellStock {
  readonly grid: StockGrid;
  readonly states: Uint8Array;
  /** Cells per state (0, 2, 3), kept as transitions apply. */
  readonly counts = [0, 0, 0, 0];
  constructor(grid: StockGrid) {
    const [nx, ny, nz] = grid.shape;
    this.grid = grid;
    this.states = new Uint8Array(nx * ny * nz);
    this.counts[REMOVED] = this.states.length;
  }

  get size() { return this.states.length; }

  /** The stream's linear index: (z * ny + y) * nx + x. */
  index(i: number, j: number, k: number) {
    const [nx, ny] = this.grid.shape;
    return i + nx * (j + ny * k);
  }

  /** Back to a keyframe's exact cells (a seek, or the start). */
  reset(cells: Uint8Array) {
    if (cells.length !== this.states.length) throw new DeltaFormatError(`The keyframe has ${cells.length} cells; the grid has ${this.states.length}.`);
    this.states.set(cells);
    this.counts.fill(0);
    for (let i = 0; i < cells.length; i++) this.counts[cells[i]]++;
  }

  count(state: CellState) { return this.counts[state]; }
}

/** The keyframe showing at playback position `t`: the last whose `afterMove` move has finished (initial at −1). */
export function keyframeAt<D>(keyframes: Keyframe<D>[], t: number): number {
  let best = -1;
  for (let i = 0; i < keyframes.length; i++) {
    // A checkpoint after move m holds once move m has played, i.e. from position m + 1.
    if (keyframes[i].afterMove + 1 <= t + 1e-9) best = i;
  }
  return Math.max(0, best);
}

/** What a seek still needs before it can show the stock at its position: a keyframe's cells or a chunk. */
export interface StockNeeds { keyframe?: number; chunk?: number }

/**
 * Keyframes plus the optional transition stream give the stock at any playback position (move units: move m spans
 * [m, m + 1)). Without the stream (or before its cells load), a seek just names the checkpoint that shows. With it,
 * playback moves a cursor forward through the transitions and records which cells changed for the display. A seek
 * backwards, or past a later keyframe, restores a keyframe first. Data loads lazily: a seek reports what it lacks, and
 * the caller loads it and seeks again.
 */
export class StockPlayback<D = unknown> {
  readonly keyframes: Keyframe<D>[];
  readonly cells: CellStock | null;
  readonly moves: number;
  private readonly ranges: { first: number; last: number }[];
  private readonly chunks: (DeltaChunk | null)[];
  private shown = -1;
  /** Moves before `move` are applied, and the first `within` records of `move`. */
  private move = 0;
  private within = 0;
  private base = -1;
  private position = -Infinity;
  private full = true;
  private dirty: number[] = [];

  constructor(keyframes: Keyframe<D>[], grid: StockGrid | null = null, ranges: { first: number; last: number }[] = [], moves = 0) {
    this.keyframes = keyframes;
    this.ranges = ranges;
    this.chunks = ranges.map(() => null);
    this.moves = moves;
    this.cells = grid && ranges.length ? new CellStock(grid) : null;
  }

  /** True when the transition stream drives the stock (material changes inside moves); false shows checkpoints only. */
  get continuous() { return !!this.cells; }

  /** The keyframe the cells were last restored from (−1: none yet). */
  get restoredFrom() { return this.base; }

  setKeyframe(index: number, cells: Uint8Array) {
    if (this.cells && cells.length !== this.cells.size) throw new DeltaFormatError(`The keyframe has ${cells.length} cells; the grid has ${this.cells.size}.`);
    this.keyframes[index].cells = cells;
  }

  setChunk(index: number, chunk: DeltaChunk) {
    const range = this.ranges[index];
    if (chunk.first !== range.first || chunk.last !== range.last) throw new DeltaFormatError(`Chunk ${index} holds moves ${chunk.first}–${chunk.last}; the index says ${range.first}–${range.last}.`);
    this.chunks[index] = chunk;
  }

  hasChunk(index: number) { return !!this.chunks[index]; }

  /** The chunk holding a move (−1 past the end). */
  chunkOf(move: number) {
    let lo = 0, hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, range = this.ranges[mid];
      if (move < range.first) hi = mid - 1;
      else if (move > range.last) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /**
   * The cells changed since the last call: `full` after a keyframe restore (redraw everything), else the changed
   * cells (each may repeat).
   */
  takeChanges(): { full: boolean; cells: number[] } {
    const out = { full: this.full, cells: this.full ? [] : this.dirty };
    this.full = false;
    this.dirty = [];
    return out;
  }

  /** Moves playback to `t`: the keyframe showing, whether anything changed, and what's still needed (null: nothing). */
  seek(t: number): { keyframe: number; changed: boolean; needs: StockNeeds | null } {
    const keyframe = keyframeAt(this.keyframes, t);
    if (!this.cells) {
      const changed = keyframe !== this.shown;
      this.shown = keyframe;
      return { keyframe, changed, needs: null };
    }
    const needs: StockNeeds = {};
    const target = Math.max(0, Math.min(this.moves, t));
    const backwards = this.base < 0 || target < this.position;
    // Restoring a keyframe beyond the cursor is cheaper than replaying to it; behind the cursor it's required.
    const ahead = this.keyframes[keyframe].afterMove + 1 > this.move;
    let changed = false;
    if (backwards || ahead) {
      let from = keyframe;
      while (from >= 0 && !this.keyframes[from].cells) from--;
      if (from !== keyframe) needs.keyframe = keyframe;
      if (from >= 0 && (backwards || from !== this.base && this.keyframes[from].afterMove + 1 > this.move)) {
        this.cells.reset(this.keyframes[from].cells!);
        this.base = from;
        this.move = this.keyframes[from].afterMove + 1;
        this.within = 0;
        this.full = true;
        this.dirty = [];
        changed = true;
      } else if (backwards && from < 0) {
        this.shown = keyframe;
        return { keyframe, changed: false, needs };
      }
    }
    changed = this.replay(target, needs) || changed;
    this.position = target;
    this.shown = keyframe;
    return { keyframe, changed, needs: needs.keyframe !== undefined || needs.chunk !== undefined ? needs : null };
  }

  /** Applies transitions forward from the cursor up to `target`; stops at a chunk that isn't loaded. */
  private replay(target: number, needs: StockNeeds): boolean {
    const cells = this.cells!;
    const states = cells.states, counts = cells.counts;
    const last = Math.floor(target);
    const tick = last >= this.moves ? 0 : Math.floor((target - last) * DELTA_TICKS);
    let changed = false;
    while (this.move < this.moves && this.move <= last) {
      const index = this.chunkOf(this.move);
      const chunk = index >= 0 ? this.chunks[index] : null;
      if (!chunk) { needs.chunk = index; break; }
      const local = this.move - chunk.first;
      const start = chunk.offsets[local], end = chunk.offsets[local + 1];
      const whole = this.move < last;
      let record = start + this.within;
      for (; record < end && (whole || chunk.tick[record] <= tick); record++) {
        const cell = chunk.cell[record];
        if (states[cell] !== chunk.before[record]) {
          throw new DeltaFormatError(`Move ${this.move}: cell ${cell} is ${states[cell]}, but the stream changes it from ${chunk.before[record]}.`);
        }
        counts[states[cell]]--;
        states[cell] = chunk.after[record];
        counts[chunk.after[record]]++;
        this.dirty.push(cell);
        changed = true;
      }
      if (!whole) { this.within = record - start; break; }
      this.move++;
      this.within = 0;
    }
    return changed;
  }
}
