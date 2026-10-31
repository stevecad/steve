/**
 * The display height field's cutting, off the main thread (heightfield.ts). The player sends playback positions; the
 * worker cuts (or restores a snapshot and replays) in slices so a long jump shows its progress and a newer position
 * takes over, and sends back the rows that changed. When it has nothing to do it cuts ahead to the end once, so later
 * seeks anywhere restore from a nearby snapshot.
 */
import { HeightField, HeightSim, partTops, type CutterProfile, type SimMoves } from './heightfield';

export type SimRequest =
  | { type: 'init'; min: number[]; max: number[]; cell: number; initial: Float32Array | null; moves: SimMoves; cutters: CutterProfile[]; memory: number }
  | { type: 'seek'; t: number }
  | { type: 'part'; triangles: Float32Array };

/** Rows j0..j1 (full width) of heights, operation tags and rim records, after cutting towards `target` (at `at`). */
export type SimReply =
  | { type: 'rows'; j0: number; j1: number; h: Float32Array; op: Uint8Array; rim: Uint32Array; at: number; target: number; done: boolean; ms: number; work: number }
  | { type: 'part'; top: Float32Array }
  | { type: 'error'; message: string };

const SLICE = 1_500_000;
let sim: HeightSim | null = null;
let target: number | null = null;
/** The position the player was last sent, complete. */
let shown = 0;
let ahead = false;
let scheduled = false;

const post = (message: SimReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

function sendRows(at: number, wanted: number, done: boolean, ms: number, work: number) {
  const dirty = sim!.field.takeDirty();
  if (!dirty) { if (done) post({ type: 'rows', j0: 0, j1: -1, h: new Float32Array(0), op: new Uint8Array(0), rim: new Uint32Array(0), at, target: wanted, done, ms, work }); return; }
  const { nx, h, op, rim } = sim!.field;
  const from = dirty[1] * nx, to = (dirty[3] + 1) * nx;
  const rows = h.slice(from, to), tags = op.slice(from, to), records = rim.slice(from, to);
  post({ type: 'rows', j0: dirty[1], j1: dirty[3], h: rows, op: tags, rim: records, at, target: wanted, done, ms, work }, [rows.buffer, tags.buffer, records.buffer]);
}

function pump() {
  scheduled = false;
  if (!sim) return;
  try {
    if (target !== null) {
      const wanted = target, started = performance.now(), work = sim.work;
      const done = sim.seek(wanted, SLICE);
      sendRows(sim.position, wanted, done, performance.now() - started, sim.work - work);
      if (done && target === wanted) { shown = wanted; target = null; }
      schedule();
      return;
    }
    if (!ahead) {
      // Idle: cut ahead to the end (building snapshots), then go back to what's shown without sending anything.
      if (sim.seek(sim.moves.count, SLICE)) {
        ahead = true;
        sim.seek(shown);
        sim.field.takeDirty();
      }
      schedule();
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(pump, 0);
}

self.onmessage = (event: MessageEvent<SimRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    const field = new HeightField(message.min, message.max, message.cell, message.initial ?? undefined);
    sim = new HeightSim(field, message.moves, message.cutters, { memory: message.memory });
    field.takeDirty();
    target = null; shown = 0; ahead = false;
    schedule();
  } else if (message.type === 'seek') {
    // While cutting ahead the field isn't at `shown`; any seek simply goes where it's asked.
    target = message.t;
    schedule();
  } else if (message.type === 'part' && sim) {
    const top = partTops(sim.field, message.triangles);
    post({ type: 'part', top }, [top.buffer]);
  }
};
