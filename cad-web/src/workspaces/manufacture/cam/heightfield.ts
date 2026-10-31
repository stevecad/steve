/**
 * The display stock for 3-axis milling: a fine height field (one Z per XY cell, a "Z-map") cut by each move's swept
 * cutter, so the player shows what a real CAM simulator shows: smooth floors, true slot widths, ball scallops and drill
 * points. This is what you see, not what is checked: the engine's voxel stock, checks and events stay the authority for
 * every pass and fail (docs/MANUFACTURING_STOCK_DELTAS.md), and the player keeps showing them.
 *
 * The cutter is its rotary profile's lower envelope: for a radial distance ρ from the axis, the lowest point of the
 * cutter at or beyond ρ (flat, ball, bull nose, drill point and any other turned profile alike). A move from A to B
 * (tool-tip points; the decoded motion already linearises arcs and helices) lowers every cell to the lowest the cutter
 * reaches there along the move. A level move is exact: the cutter's lowest point over a cell is at the cell's closest
 * point on the move. A move that changes height is split into pieces that each change height by at most a small
 * fraction of a cell; a cell takes the lowest of the cutter at the piece boundaries and at its closest point.
 *
 * Walls: a cell's height says nothing about where, between two cell centres, a wall stands. So each cut cell near the
 * rim of the cutter that cut it also keeps a "rim record": the horizontal direction from that cutter's axis and how far
 * inside the rim the cell is. The rim is the wall (the cutter's side is vertical there), so the drawing puts walls where
 * the cutter's side actually was and shades them with its true normal, instead of stepping across the grid
 * (`wallShift`, mirrored in HeightStock.tsx's shader).
 *
 * Positions are move units like the player's (move i spans [i, i + 1)). The stock at a position is a pure function of
 * it: whole moves before it, and the played part of the current move (a level move to the exact point; a sloped one up
 * to its last whole piece). Restore points every so much cutting work let a seek restore and replay forward, and give
 * the same field as playing there. They keep, per 16 × 16 cell tile, only the tiles cut since the point before.
 *
 * No imports: this module is unit-tested under plain Node (tests/cam_heightfield_test.mjs) and runs in a worker.
 */

// ── Cutters ────────────────────────────────────────────────────────────────

/** A cutter's lower envelope: `table[k]` is its lowest point above the tip at radial distance k·radius/(n), n = table.length − 2. */
export interface CutterProfile {
  radius: number; table: Float64Array;
  /** Whether the envelope is convex (worked out when first cut with). */
  convex?: boolean;
}

const TABLE = 1024;

/** The lower envelope of a solid of revolution whose outer curves are (r, z) polylines in tip coordinates (z up). */
export function profileOf(lines: [number, number][][]): CutterProfile | null {
  let radius = 0;
  for (const line of lines) for (const [r] of line) radius = Math.max(radius, r);
  if (!(radius > 0)) return null;
  const table = new Float64Array(TABLE + 2);
  for (let k = 0; k <= TABLE; k++) {
    const rho = Math.min(radius, (k * radius) / TABLE);
    let best = Infinity;
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const [r0, z0] = line[i];
        if (r0 >= rho - 1e-12) best = Math.min(best, z0);
        if (i === 0) continue;
        const [r1, z1] = line[i - 1];
        // Where the curve crosses radius ρ, it is the lowest point at or beyond ρ on that piece.
        if ((r0 - rho) * (r1 - rho) < 0) best = Math.min(best, z0 + ((rho - r0) / (r1 - r0)) * (z1 - z0));
      }
    }
    table[k] = best;
  }
  // The envelope can only rise outwards (anything inside a radius is cut by the solid there).
  for (let k = TABLE - 1; k >= 0; k--) table[k] = Math.min(table[k], table[k + 1]);
  table[TABLE + 1] = table[TABLE];
  return { radius, table };
}

/** Flat end mill (corner 0), bull nose (0 < corner < radius) or ball (corner = radius), `length` its flute length. */
export function millProfile(diameter: number, corner = 0, length = diameter * 3): CutterProfile {
  const radius = diameter / 2, c = Math.min(Math.max(0, corner), radius);
  const line: [number, number][] = [];
  const steps = 64;
  if (c > 0) for (let i = 0; i <= steps; i++) { const a = (Math.PI / 2) * (i / steps); line.push([radius - c + c * Math.sin(a), c - c * Math.cos(a)]); }
  else line.push([0, 0], [radius, 0]);
  line.push([radius, Math.max(length, c)]);
  return profileOf([line])!;
}

/** A drill (or spot drill / V-bit with no tip flat): a point of `angle` degrees included, then the body. */
export function drillProfile(diameter: number, angleDeg = 118, length = diameter * 5): CutterProfile {
  const radius = diameter / 2, tip = radius / Math.tan((angleDeg * Math.PI) / 360);
  return profileOf([[[0, 0], [radius, tip], [radius, Math.max(length, tip)]]])!;
}

/** A tool assembly region's segment (toolGeometry's FrustumSegment | ProfileSegment), structurally. */
export interface RegionSegment {
  shape?: string; z_start_mm?: number; z_end_mm?: number; radius_start_mm?: number; radius_end_mm?: number; corner_radius_mm?: number | null;
  curve?: { kind: 'line' | 'arc'; z0_mm: number; z1_mm: number; r0_mm?: number | null; r1_mm?: number | null; center_z_mm?: number | null; center_r_mm?: number | null; radius_mm?: number | null; branch?: 1 | -1 };
  origin_z_mm?: number; outward_margin_mm?: number;
}

/** A region's outer curve in tip coordinates (as toolGeometry's regionPoints draws it). */
export function regionCurve(segment: RegionSegment): [number, number][] {
  const steps = 48;
  if (segment.shape === 'radial_profile' && segment.curve) {
    const c = segment.curve, shift = segment.origin_z_mm ?? 0, margin = segment.outward_margin_mm ?? 0;
    const n = c.kind === 'line' ? 1 : steps;
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const z = c.z0_mm + ((c.z1_mm - c.z0_mm) * i) / n;
      let r: number;
      if (c.kind === 'line') { const t = c.z1_mm === c.z0_mm ? 0 : (z - c.z0_mm) / (c.z1_mm - c.z0_mm); r = c.r0_mm! * (1 - t) + c.r1_mm! * t; }
      else { const u = z - c.center_z_mm!; r = c.center_r_mm! + (c.branch ?? 1) * Math.sqrt(Math.max(0, c.radius_mm! ** 2 - u * u)); }
      out.push([Math.max(0, r) + margin, z + shift]);
    }
    return out;
  }
  const z0 = segment.z_start_mm ?? 0, z1 = segment.z_end_mm ?? 0, r0 = segment.radius_start_mm ?? 0, r1 = segment.radius_end_mm ?? 0;
  if (segment.shape === 'round_corner' && segment.corner_radius_mm) {
    const r = segment.corner_radius_mm;
    return Array.from({ length: steps + 1 }, (_, i) => { const t = (r * i) / steps; return [r0 + Math.sqrt(Math.max(0, t * (2 * r - t))), z0 + t] as [number, number]; });
  }
  return [[r0, z0], [r1, z1]];
}

/** The cutting part of a tool assembly (its `cutter` regions), or null when it has none. */
export function assemblyProfile(regions: { role: string; segment: RegionSegment }[]): CutterProfile | null {
  const lines = regions.filter((region) => region.role === 'cutter').map((region) => regionCurve(region.segment));
  return lines.length ? profileOf(lines) : null;
}

// ── The field ──────────────────────────────────────────────────────────────

/** Cell size: about a hundredth of the smallest cutter, 0.05–0.1 mm, coarser only to stay within `maxCells` and `maxSide`. */
export function cellSizeFor(sizeX: number, sizeY: number, smallestDiameter: number, maxCells = 4_000_000, maxSide = 4096) {
  const wanted = Math.min(0.1, Math.max(0.05, (smallestDiameter || 5) / 100));
  return Math.max(wanted, Math.sqrt((sizeX * sizeY) / maxCells), sizeX / maxSide, sizeY / maxSide);
}

/** Tiles of TILE × TILE cells: cuts skip tiles already below the cutter, and restore points keep tiles. */
export const TILE_BITS = 4, TILE = 1 << TILE_BITS;

/** Inclusive cell rectangle [i0, j0, i1, j1]. */
export type Rect = [number, number, number, number];

// ── Rim records ────────────────────────────────────────────────────────────
//
// A Uint32 per cell: (s << 14) | direction. `s` is how far inside the rim of the cutter that cut the cell it is, in
// 1/RIM_SCALE cells (≥ 1); `direction` the horizontal direction from that cutter's axis to the cell, as 14 bits of a
// diamond angle (exact to about 0.02°). 0: no record (uncut, or the starting stock); RIM_DEEP: cut, but more than
// RIM_BAND cells inside the rim, so no wall can be next to it from that cut.

/** Rim distance units per cell, and how many cells from the rim records are kept. */
export const RIM_SCALE = 8192, RIM_BAND = 2;
const DIR_BITS = 14, DIR_STEPS = 1 << DIR_BITS;
export const RIM_DEEP = (2 ** 18 - 1) * DIR_STEPS;

/** The record for a cell `s` cells inside the rim, `(vx, vy)` from the cutter's axis towards the cell. */
export function rimCode(vx: number, vy: number, s: number): number {
  const a = Math.abs(vx) + Math.abs(vy);
  let d = 0;
  if (a > 0) { const p = vx / a; d = vy >= 0 ? 1 - p : 3 + p; }
  const q = Math.round(d * (DIR_STEPS / 4)) & (DIR_STEPS - 1);
  const sq = Math.min(2 ** 18 - 2, Math.max(1, Math.round(s * RIM_SCALE)));
  return sq * DIR_STEPS + q;
}

/** A record's unit direction (axis → cell) and its distance inside the rim in cells; null for none or deep. */
export function rimDecode(code: number): { ux: number; uy: number; s: number } | null {
  if (!code || code >= RIM_DEEP) return null;
  const q = code % DIR_STEPS, s = Math.floor(code / DIR_STEPS) / RIM_SCALE;
  const d = q / (DIR_STEPS / 4);
  let x: number, y: number;
  if (d <= 2) { x = 1 - d; y = 1 - Math.abs(x); } else { x = d - 3; y = -(1 - Math.abs(x)); }
  const n = Math.hypot(x, y);
  return { ux: x / n, uy: y / n, s };
}

/** True when a cutter's lower envelope is convex (then a sloped move's lowest point over a cell is found by descent). */
function convexOf(cutter: CutterProfile): boolean {
  if (cutter.convex === undefined) {
    const t = cutter.table, n = t.length - 2, tol = 1e-9 * Math.max(1, Math.abs(t[n] - t[0]));
    let convex = true;
    for (let k = 1; k < n && convex; k++) if (t[k - 1] - 2 * t[k] + t[k + 1] < -tol) convex = false;
    cutter.convex = convex;
  }
  return cutter.convex;
}

/** The x-interval a capsule (segment P→Q, radius r) covers on the row at y, into `out` (lo > hi when none). */
function capsuleRow(y: number, px: number, py: number, qx: number, qy: number, r: number, out: Float64Array) {
  const r2 = r * r;
  let lo = Infinity, hi = -Infinity;
  let e = y - py, w2 = r2 - e * e;
  if (w2 >= 0) { const w = Math.sqrt(w2); lo = px - w; hi = px + w; }
  e = y - qy; w2 = r2 - e * e;
  if (w2 >= 0) { const w = Math.sqrt(w2); if (qx - w < lo) lo = qx - w; if (qx + w > hi) hi = qx + w; }
  const lx = qx - px, ly = qy - py, plen = Math.sqrt(lx * lx + ly * ly);
  if (plen > 1e-12) {
    // |(p − P)·n| ≤ r with n = (−sy, sx), and 0 ≤ (p − P)·s ≤ plen, solved for x on this row.
    const sx = lx / plen, sy = ly / plen, ey = y - py;
    let blo = -Infinity, bhi = Infinity;
    if (Math.abs(sy) > 1e-12) {
      let l = (sx * ey - r) / sy, h = (sx * ey + r) / sy;
      if (l > h) { const t = l; l = h; h = t; }
      blo = px + l; bhi = px + h;
    } else if (Math.abs(sx * ey) > r) { blo = Infinity; bhi = -Infinity; }
    if (Math.abs(sx) > 1e-12) {
      let l = (0 - sy * ey) / sx, h = (plen - sy * ey) / sx;
      if (l > h) { const t = l; l = h; h = t; }
      if (px + l > blo) blo = px + l;
      if (px + h < bhi) bhi = px + h;
    } else if (sy * ey < 0 || sy * ey > plen) { blo = Infinity; bhi = -Infinity; }
    if (blo <= bhi) { if (blo < lo) lo = blo; if (bhi > hi) hi = bhi; }
  }
  out[0] = lo; out[1] = hi;
}

const ROW = new Float64Array(2), INNER = new Float64Array(2), LOWEST = new Float64Array(2);

export class HeightField {
  readonly nx: number; readonly ny: number;
  readonly x0: number; readonly y0: number; readonly dx: number; readonly dy: number;
  /** The smaller cell side (rim records' unit). */
  readonly cell: number;
  /** The stock's bottom: a column at or below it is cut through. */
  readonly bottom: number;
  /** Top of each column (machine mm), x-fastest. */
  readonly h: Float32Array;
  /** What last cut each column: 0 uncut, else a caller's tag (the operation's band + 1). */
  readonly op: Uint8Array;
  /** Each column's rim record (see rimCode). */
  readonly rim: Uint32Array;
  /** The highest the stock starts anywhere (nothing above it can cut). */
  readonly top: number;
  /** Cells changed since the last `takeDirty()`. */
  private dirty: Rect | null = null;
  /** The highest column in each TILE × TILE block (cuts skip blocks already below the cutter). */
  readonly tileMax: Float32Array;
  readonly tilesX: number;
  readonly tilesY: number;
  /** Tiles changed since the last `takeTouched()` (a flag per tile and their list). */
  private readonly touchedFlag: Uint8Array;
  private touchedList: number[] = [];

  constructor(min: number[], max: number[], cell: number, initial?: Float32Array) {
    this.nx = Math.max(1, Math.round((max[0] - min[0]) / cell));
    this.ny = Math.max(1, Math.round((max[1] - min[1]) / cell));
    this.x0 = min[0]; this.y0 = min[1];
    this.dx = (max[0] - min[0]) / this.nx; this.dy = (max[1] - min[1]) / this.ny;
    this.cell = Math.min(this.dx, this.dy);
    this.bottom = min[2];
    this.h = new Float32Array(this.nx * this.ny);
    if (initial) this.h.set(initial); else this.h.fill(max[2]);
    let top = -Infinity;
    for (let i = 0; i < this.h.length; i++) if (this.h[i] > top) top = this.h[i];
    this.top = top;
    this.op = new Uint8Array(this.nx * this.ny);
    this.rim = new Uint32Array(this.nx * this.ny);
    this.tilesX = Math.ceil(this.nx / TILE);
    this.tilesY = Math.ceil(this.ny / TILE);
    this.tileMax = new Float32Array(this.tilesX * this.tilesY);
    this.touchedFlag = new Uint8Array(this.tilesX * this.tilesY);
    this.refreshTiles(0, 0, this.nx - 1, this.ny - 1);
  }

  get size() { return this.h.length; }

  mark(i0: number, j0: number, i1: number, j1: number) {
    const d = this.dirty;
    if (!d) this.dirty = [i0, j0, i1, j1];
    else { if (i0 < d[0]) d[0] = i0; if (j0 < d[1]) d[1] = j0; if (i1 > d[2]) d[2] = i1; if (j1 > d[3]) d[3] = j1; }
  }

  takeDirty(): Rect | null { const out = this.dirty; this.dirty = null; return out; }

  /** The tiles changed since the last call (each once). */
  takeTouched(): number[] {
    const out = this.touchedList;
    for (const t of out) this.touchedFlag[t] = 0;
    this.touchedList = [];
    return out;
  }

  /** Tiles changed since the last `takeTouched()`, without clearing them. */
  get touched(): readonly number[] { return this.touchedList; }

  /** Height at a point (the cell it falls in), for tests and readouts. */
  at(x: number, y: number) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.dx)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.dy)));
    return this.h[j * this.nx + i];
  }

  /**
   * Lowers the field by the cutter swept along A→B. Returns the work done (cells visited and points evaluated).
   *
   * `pieces` 0: a level move (or one straight along the axis) over its parameter range [t0, t1]; the cutter's lowest
   * point over a cell is at the cell's closest point (along the axis: the lower end). Otherwise a sloped move in
   * `pieces` pieces, cut from boundary k0 to k1: a cell takes the lowest of the cutter at those boundaries and at its
   * closest point between them (the same for any split of the range into calls).
   *
   * Rim records follow the full move A→B, so they don't depend on how its range is split: a cell within RIM_BAND cells
   * of the move's rim records the cutter's direction and distance there (on an exact tie in height the record further
   * inside the rim wins, so the cut that reaches furthest past the cell sets the wall); a cell deeper inside records
   * RIM_DEEP.
   */
  cut(a: ArrayLike<number>, b: ArrayLike<number>, t0: number, t1: number, cutter: CutterProfile, tag: number, pieces = 0, k0 = 0, k1 = 0): number {
    const R = cutter.radius, R2 = R * R, table = cutter.table, scale = (table.length - 2) / R;
    const sloped = pieces > 0;
    if (sloped) { if (k1 <= k0) return 0; t0 = k0 / pieces; t1 = k1 / pieces; }
    const descend = sloped && convexOf(cutter);
    const ax = a[0], ay = a[1], az = a[2], ux = b[0] - ax, uy = b[1] - ay, uz = b[2] - az;
    const len2 = ux * ux + uy * uy, inv = len2 > 1e-18 ? 1 / len2 : 0;
    // A move straight along the axis reaches lowest at its lower end.
    const plunge = uz < 0 ? t1 : t0;
    // The range's ends, and the lowest the cutter gets anywhere on it (nothing below that can change).
    const px = ax + ux * t0, py = ay + uy * t0, qx = ax + ux * t1, qy = ay + uy * t1;
    const low = Math.min(az + uz * t0, az + uz * t1) + table[0];
    if (low >= this.top) return 0;
    const { nx, ny, x0, y0, dx, dy, h, op, rim, tileMax, tilesX, top, touchedFlag, touchedList } = this;
    const j0 = Math.max(0, Math.ceil((Math.min(py, qy) - R - y0) / dy - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(py, qy) + R - y0) / dy - 0.5));
    if (j0 > j1) return 0;
    // Cells further than RIM_BAND cells inside the full move's rim (its inner capsule) record RIM_DEEP.
    const cell = this.cell, inner = R - RIM_BAND * cell, invCell = 1 / cell;
    const reach = (t: number, rx: number, ry: number) => {
      const ex = rx - ux * t, ey = ry - uy * t, d2 = ex * ex + ey * ey;
      if (d2 > R2) return Infinity;
      const at = Math.sqrt(d2) * scale, k = at | 0;
      return az + uz * t + table[k] + (table[k + 1] - table[k]) * (at - k);
    };
    // The lowest a sloped range reaches over the cell (rx, ry) (relative to A), from its closest point `t` (where the
    // cutter rises `rise`); Infinity when it can't reach below `limit` (or to it, with `strict`). LOWEST[0] gets the
    // parameter of the lowest point, LOWEST[1] counts the points tried.
    const lowest = (rx: number, ry: number, t: number, rise: number, limit: number, strict: boolean): number => {
      // Nothing on this range reaches below its lowest point plus the cutter's rise at the closest distance.
      const bound = low - table[0] + rise;
      if (strict ? bound >= limit : bound > limit) return Infinity;
      let z = az + uz * t + rise, best = t, tried = 0;
      // Piece boundaries: descend from the nearest (the cutter's height along the move is convex in its parameter
      // then), or try every boundary within reach.
      if (descend) {
        let k = Math.min(k1, Math.max(k0, Math.round(t * pieces)));
        let zk = reach(k / pieces, rx, ry);
        tried++;
        if (zk !== Infinity) {
          // Lower along the move first, then the other way.
          let dir = uz < 0 ? 1 : -1;
          for (let turn = 0; turn < 2; turn++, dir = -dir) {
            let moved = false;
            for (let next = k + dir; next >= k0 && next <= k1; next += dir) {
              const zn = reach(next / pieces, rx, ry);
              tried++;
              if (!(zn < zk)) break;
              k = next; zk = zn; moved = true;
            }
            if (moved) break;
          }
          if (zk < z) { z = zk; best = k / pieces; }
        }
      } else {
        const tp = (rx * ux + ry * uy) * inv, fx = rx - ux * tp, fy = ry - uy * tp;
        const w = Math.sqrt(Math.max(0, R2 - fx * fx - fy * fy) * inv);
        const ka = Math.max(k0, Math.floor((tp - w) * pieces) - 1), kb = Math.min(k1, Math.ceil((tp + w) * pieces) + 1);
        for (let k = ka; k <= kb; k++) {
          const zk = reach(k / pieces, rx, ry);
          tried++;
          if (zk < z) { z = zk; best = k / pieces; }
        }
      }
      LOWEST[0] = best; LOWEST[1] += tried;
      return z;
    };
    LOWEST[1] = 0;
    let work = 0;
    // Changed cells (any record) and lowered ones (tile maxima to refresh).
    let ci0 = nx, ci1 = -1, cj0 = ny, cj1 = -1, li0 = nx, li1 = -1, lj0 = ny, lj1 = -1;
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * dy;
      capsuleRow(y, px, py, qx, qy, R, ROW);
      if (ROW[0] > ROW[1]) continue;
      const i0 = Math.max(0, Math.ceil((ROW[0] - x0) / dx - 0.5)), i1 = Math.min(nx - 1, Math.floor((ROW[1] - x0) / dx - 0.5));
      if (i0 > i1) continue;
      // The deep cells on this row: [ia, ib].
      let ia = i1 + 1, ib = i1;
      if (inner > 0) {
        capsuleRow(y, ax, ay, ax + ux, ay + uy, inner, INNER);
        if (INNER[0] <= INNER[1]) { ia = Math.max(i0, Math.ceil((INNER[0] - x0) / dx - 0.5)); ib = Math.min(i1, Math.floor((INNER[1] - x0) / dx - 0.5)); }
        if (ia > ib) { ia = i1 + 1; ib = i1; }
      }
      const ry = y - ay, tileRow = (j >> TILE_BITS) * tilesX;
      let ri0 = nx, ri1 = -1, lowered = false;
      // Near the rim (before and after the deep cells): every cell the cutter can reach, ties included (not at the
      // stock's top).
      for (let side = 0; side < 2; side++) {
        const from = side ? Math.max(i0, ib + 1) : i0, to = side ? i1 : Math.min(i1, ia - 1);
        let rx = x0 + (from + 0.5) * dx - ax;
        for (let i = from, c = j * nx + from; i <= to; i++, c++, rx += dx) {
          const hc = h[c];
          // Nothing reaches below `low`, and no tie there beats a deep record.
          if (hc < low || (hc === low && rim[c] >= RIM_DEEP)) continue;
          work++;
          let t = plunge;
          if (inv) { t = (rx * ux + ry * uy) * inv; if (t < t0) t = t0; else if (t > t1) t = t1; }
          const ex = rx - ux * t, ey = ry - uy * t, d2 = ex * ex + ey * ey;
          if (d2 > R2) continue;
          const at = Math.sqrt(d2) * scale, k = at | 0, rise = table[k] + (table[k + 1] - table[k]) * (at - k);
          let z: number;
          if (sloped) { z = lowest(rx, ry, t, rise, hc, false); t = LOWEST[0]; } else z = az + uz * t + rise;
          const zf = Math.fround(z);
          if (zf > hc || (zf === hc && hc >= top)) continue;
          const vx = rx - ux * t, vy = ry - uy * t, code = rimCode(vx, vy, (R - Math.sqrt(vx * vx + vy * vy)) * invCell);
          if (zf < hc) { h[c] = zf; op[c] = tag; rim[c] = code; lowered = true; if (i < li0) li0 = i; if (i > li1) li1 = i; }
          else if (code > rim[c]) rim[c] = code;
          else continue;
          const tile = tileRow + (i >> TILE_BITS);
          if (!touchedFlag[tile]) { touchedFlag[tile] = 1; touchedList.push(tile); }
          if (i < ri0) ri0 = i;
          if (i > ri1) ri1 = i;
        }
        if (side === 0 && ia <= ib) {
          // Deep inside: only what the cutter lowers, skipping whole tiles already at or below its lowest point.
          for (let i = ia; i <= ib;) {
            const tile = tileRow + (i >> TILE_BITS), tileEnd = Math.min(ib, ((i >> TILE_BITS) + 1) * TILE - 1);
            if (tileMax[tile] <= low) { i = tileEnd + 1; continue; }
            let rx = x0 + (i + 0.5) * dx - ax, hit = false;
            for (let c = j * nx + i; i <= tileEnd; i++, c++, rx += dx) {
              const hc = h[c];
              if (hc <= low) continue;
              work++;
              let t = plunge;
              if (inv) { t = (rx * ux + ry * uy) * inv; if (t < t0) t = t0; else if (t > t1) t = t1; }
              const ex = rx - ux * t, ey = ry - uy * t, d2 = ex * ex + ey * ey;
              if (d2 > R2) continue;
              const at = Math.sqrt(d2) * scale, k = at | 0, rise = table[k] + (table[k + 1] - table[k]) * (at - k);
              const zf = Math.fround(sloped ? lowest(rx, ry, t, rise, hc, true) : az + uz * t + rise);
              if (zf < hc) {
                h[c] = zf; op[c] = tag; rim[c] = RIM_DEEP; hit = true;
                if (i < ri0) ri0 = i;
                if (i > ri1) ri1 = i;
              }
            }
            if (hit) {
              lowered = true;
              if (!touchedFlag[tile]) { touchedFlag[tile] = 1; touchedList.push(tile); }
            }
          }
        }
      }
      if (ri1 >= 0) {
        if (ri0 < ci0) ci0 = ri0;
        if (ri1 > ci1) ci1 = ri1;
        if (j < cj0) cj0 = j;
        cj1 = j;
        if (lowered) {
          if (ri0 < li0) li0 = ri0;
          if (ri1 > li1) li1 = ri1;
          if (j < lj0) lj0 = j;
          lj1 = j;
        }
      }
    }
    if (ci1 >= 0) this.mark(ci0, cj0, ci1, cj1);
    if (lj1 >= 0) this.refreshTiles(li0, lj0, li1, lj1);
    return work + LOWEST[1];
  }

  /** Recomputes the tile maxima over a cell rectangle (after cutting or restoring it). */
  refreshTiles(i0: number, j0: number, i1: number, j1: number) {
    for (let tj = j0 >> TILE_BITS; tj <= j1 >> TILE_BITS; tj++) for (let ti = i0 >> TILE_BITS; ti <= i1 >> TILE_BITS; ti++) this.refreshTile(tj * this.tilesX + ti);
  }

  refreshTile(t: number) {
    const { nx, ny, h, tileMax, tilesX } = this;
    const ia = (t % tilesX) * TILE, ja = Math.floor(t / tilesX) * TILE, ib = Math.min(nx, ia + TILE), jb = Math.min(ny, ja + TILE);
    let max = -Infinity;
    for (let j = ja; j < jb; j++) for (let c = j * nx + ia, end = j * nx + ib; c < end; c++) if (h[c] > max) max = h[c];
    tileMax[t] = max;
  }
}

// ── Walls ──────────────────────────────────────────────────────────────────

/** A height step bigger than this many cells is a wall (steeper than about 76°); vertices move at most this far. */
export const WALL_STEP = 4, WALL_SHIFT = 0.33;

/**
 * Where the drawing puts a vertex (i, j) of the top grid sideways (mm), so walls stand where the cutter's side was: a
 * vertex on top of a wall moves onto the rim recorded by the cut cells below it; one at the foot of a wall onto its own
 * rim. At most WALL_SHIFT cells, which keeps every triangle the right way up (the shifts of two neighbours differ by
 * at most 2/3 of their spacing). Heights don't change, and vertices on the stock's border stay put. HeightStock.tsx's
 * vertex shader does the same sum in GLSL (`hfShift`).
 */
export function wallShift(field: Pick<HeightField, 'nx' | 'ny' | 'x0' | 'y0' | 'dx' | 'dy' | 'cell' | 'h' | 'rim'>, i: number, j: number): [number, number] {
  const { nx, ny, dx, dy, cell, h, rim } = field;
  if (i <= 0 || j <= 0 || i >= nx - 1 || j >= ny - 1) return [0, 0];
  const c = j * nx + i, hc = h[c], step = WALL_STEP * cell;
  let sx = 0, sy = 0, n = 0, foot = false;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    if (!a && !b) continue;
    const k = c + b * nx + a, hk = h[k];
    if (hk > hc + step) { foot = true; continue; }
    if (!(hk < hc - step)) continue;
    // On top of a wall: onto the line through the neighbour's rim point, across its direction.
    const r = rimDecode(rim[k]);
    if (!r) continue;
    const d = r.s * cell + (a * dx * r.ux + b * dy * r.uy);
    if (d < 0) { sx += d * r.ux; sy += d * r.uy; n++; }
  }
  if (foot) {
    const r = rimDecode(rim[c]);
    if (r) { sx += r.s * cell * r.ux; sy += r.s * cell * r.uy; n++; }
  }
  if (!n) return [0, 0];
  sx /= n; sy /= n;
  const len = Math.hypot(sx, sy), max = WALL_SHIFT * cell;
  return len > max ? [(sx * max) / len, (sy * max) / len] : [sx, sy];
}

/**
 * Initial tops from the engine's occupancy (StockGrid cells, x-fastest, z slowest; 3 definite, 2 uncertain, 0 removed),
 * resampled onto the field: each column's top is its highest material cell's top (an uncertain one counts half). Null
 * when some column has material above empty cells (an undercut a height field can't hold).
 */
export function topsFromOccupancy(grid: { origin_mm: number[]; cell_mm: number; shape: number[] }, states: Uint8Array, field: { nx: number; ny: number; x0: number; y0: number; dx: number; dy: number; bottom: number }): Float32Array | null {
  const [gx, gy, gz] = grid.shape, c = grid.cell_mm, [ox, oy, oz] = grid.origin_mm;
  const column = new Float32Array(gx * gy).fill(-Infinity);
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    let top = -Infinity, gap = false;
    for (let k = 0; k < gz; k++) {
      const s = states[(k * gy + j) * gx + i];
      if (s) { if (gap) return null; top = oz + (k + (s === 3 ? 1 : 0.5)) * c; }
      else gap = true;
    }
    column[j * gx + i] = top;
  }
  const out = new Float32Array(field.nx * field.ny);
  for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
    const gi = Math.min(gx - 1, Math.max(0, Math.floor((field.x0 + (i + 0.5) * field.dx - ox) / c)));
    const gj = Math.min(gy - 1, Math.max(0, Math.floor((field.y0 + (j + 0.5) * field.dy - oy) / c)));
    const top = column[gj * gx + gi];
    out[j * field.nx + i] = top === -Infinity ? field.bottom : top;
  }
  return out;
}

/**
 * The part's top surface over the field, from its triangles (machine mm, 9 floats each): each column's highest
 * surface point at the cell centre, −Infinity where the part isn't.
 */
export function partTops(field: { nx: number; ny: number; x0: number; y0: number; dx: number; dy: number }, triangles: Float32Array): Float32Array {
  const { nx, ny, x0, y0, dx, dy } = field;
  const out = new Float32Array(nx * ny).fill(-Infinity);
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
    const bx = triangles[t + 3], by = triangles[t + 4], bz = triangles[t + 5];
    const cx = triangles[t + 6], cy = triangles[t + 7], cz = triangles[t + 8];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) continue;  // Vertical: its edges are covered by the neighbours.
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / dx - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / dx - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / dy - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / dy - 0.5));
    const eps = -1e-9;
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * dy;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * dx;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < eps || l2 < eps || l3 < eps) continue;
        const z = l1 * az + l2 * bz + l3 * cz, c = j * nx + i;
        if (z > out[c]) out[c] = z;
      }
    }
  }
  return out;
}

// ── Playback ───────────────────────────────────────────────────────────────

/** The program's moves for the simulation: tip start and end per move, its cutter (an index, −1 none) and tag. */
export interface SimMoves { count: number; start: Float64Array; end: Float64Array; cutter: Int16Array; tag: Uint8Array }

/** A restore point: the field's state after the moves before `move`; `tiles` are the tiles cut since the point before. */
interface Point { move: number; tiles: Int32Array }
/** A tile's cells at a restore point (heights, rim records, then tags), `point` the point's index. */
interface Version { point: number; data: ArrayBuffer }
/** Bookkeeping per stored tile version, counted against the memory budget with its cells. */
const VERSION_OVERHEAD = 96;

export interface SimOptions {
  /** Cutting work (cells visited) between restore points, some 20–40 ms of it; doubled whenever they outgrow `memory`. */
  snapshotWork?: number;
  /** Bytes the restore points may take (each holds only the tiles cut since the one before). */
  memory?: number;
}

/**
 * The height field at any playback position, built forward by cutting and backward (or far forward) by restoring a
 * restore point and replaying. `seek` takes a work budget so a long jump can be done in slices (the caller shows each
 * slice's progress).
 */
export class HeightSim {
  readonly field: HeightField;
  readonly moves: SimMoves;
  readonly cutters: CutterProfile[];
  /** Pieces per move (1 for a level move). */
  readonly pieces: Int32Array;
  private readonly h0: Float32Array;
  private points: Point[] = [];
  /** Per tile, its stored versions in point order. */
  private versions: (Version[] | undefined)[];
  /** The field is restore point `base`'s state (−1: the starting stock) plus the tiles touched since. */
  private base = -1;
  private snapshotWork: number;
  private readonly memory: number;
  private bytes = 0;
  /** Moves before `move` are cut, and `move` up to `frac` (level) or its first `piece` pieces (sloped). */
  private move = 0;
  private frac = 0;
  private piece = 0;
  /** Work done since the sim was made (a performance readout). */
  work = 0;
  /** Work since the state of the last restore point, on the way forward from it. */
  private since = 0;

  constructor(field: HeightField, moves: SimMoves, cutters: CutterProfile[], options: SimOptions = {}) {
    this.field = field;
    this.moves = moves;
    this.cutters = cutters;
    this.h0 = field.h.slice();
    this.memory = options.memory ?? 128 * 1024 * 1024;
    this.versions = new Array(field.tilesX * field.tilesY);
    field.takeTouched();
    const cell = Math.min(field.dx, field.dy);
    this.pieces = new Int32Array(moves.count);
    const maxDz = Math.max(cell / 4, 0.002);
    for (let m = 0; m < moves.count; m++) {
      const s = m * 3, cutter = moves.cutter[m] >= 0 ? cutters[moves.cutter[m]] : null;
      const lx = moves.end[s] - moves.start[s], ly = moves.end[s + 1] - moves.start[s + 1], dz = Math.abs(moves.end[s + 2] - moves.start[s + 2]);
      const lxy = Math.hypot(lx, ly), R = cutter?.radius ?? 0;
      // Sloped moves in pieces of at most maxDz in height and the cutter's radius along the floor.
      // (A level move, or one straight along the axis, is exact in one piece.)
      this.pieces[m] = dz <= 1e-9 || lxy <= 1e-9 ? 1 : Math.max(1, Math.ceil(dz / maxDz), R > 0 ? Math.ceil(lxy / R) : 1);
    }
    this.snapshotWork = options.snapshotWork ?? 2_000_000;
  }

  /** The position the field holds (move units). */
  get position() { return this.move + (this.pieces[this.move] > 1 ? this.piece / this.pieces[this.move] : this.frac); }

  get snapshotCount() { return this.points.length; }
  get snapshotBytes() { return this.bytes; }

  /**
   * Moves the field to position `t`. With a `budget` (work), stops at a move boundary once it's spent and returns
   * false; call again to continue. Returns true when the field is at `t`.
   */
  seek(t: number, budget = Infinity): boolean {
    const count = this.moves.count;
    const target = Math.max(0, Math.min(count, t));
    let m = Math.floor(target), f = target - m;
    if (m >= count) { m = count; f = 0; }
    // Back, or forward past a restore point (restoring it beats replaying up to it).
    const ahead = this.latest(m);
    if (m < this.move || (m === this.move && this.before(m, f)) || (ahead >= 0 && this.points[ahead].move > this.move)) this.restore(ahead);
    const start = this.work;
    while (this.move < m) {
      if (this.work - start > budget) return false;
      this.finish(this.move);
      this.move++;
      this.frac = 0; this.piece = 0;
      this.passPoint();
    }
    if (m < count && f > 0) this.partial(m, f);
    return true;
  }

  /** True when position (m, f) is before what's already cut of move m. */
  private before(m: number, f: number) {
    const pieces = this.pieces[m];
    return pieces > 1 ? Math.floor(f * pieces + 1e-9) < this.piece : f < this.frac;
  }

  private cutter(m: number) {
    const index = this.moves.cutter[m];
    return index >= 0 ? this.cutters[index] ?? null : null;
  }

  private span(m: number) {
    const s = m * 3;
    return { a: this.moves.start.subarray(s, s + 3), b: this.moves.end.subarray(s, s + 3) };
  }

  /** Cuts the rest of move m. */
  private finish(m: number) {
    const cutter = this.cutter(m);
    if (!cutter) return;
    const { a, b } = this.span(m), pieces = this.pieces[m], tag = this.moves.tag[m];
    const work = pieces === 1 ? this.field.cut(a, b, this.frac, 1, cutter, tag) : this.field.cut(a, b, 0, 1, cutter, tag, pieces, this.piece, pieces);
    this.work += work; this.since += work;
  }

  /** Cuts move m up to fraction f (a sloped move: its whole pieces up to f). */
  private partial(m: number, f: number) {
    const cutter = this.cutter(m), pieces = this.pieces[m];
    let work = 0;
    if (pieces === 1) {
      if (f > this.frac && cutter) { const { a, b } = this.span(m); work = this.field.cut(a, b, this.frac, f, cutter, this.moves.tag[m]); }
      this.frac = Math.max(this.frac, f);
    } else {
      const upto = Math.min(pieces, Math.floor(f * pieces + 1e-9));
      if (cutter && upto > this.piece) { const { a, b } = this.span(m); work = this.field.cut(a, b, 0, 1, cutter, this.moves.tag[m], pieces, this.piece, upto); }
      this.piece = Math.max(this.piece, upto);
    }
    this.work += work; this.since += work;
  }

  /** The latest restore point at or before move m (−1: none). */
  private latest(m: number): number {
    let lo = 0, hi = this.points.length - 1, out = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].move <= m) { out = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return out;
  }

  /** At a move boundary: reaching the next restore point (replaying), or making a new one past the last. */
  private passPoint() {
    const next = this.points[this.base + 1];
    if (next) {
      // Replaying from an earlier point: the field is exactly that point's state when it gets there.
      if (next.move === this.move) { this.base++; this.field.takeTouched(); this.since = 0; }
      return;
    }
    if (this.since < this.snapshotWork) return;
    const tiles = this.field.takeTouched(), index = this.points.length;
    this.since = 0;
    if (!tiles.length) return;
    for (const t of tiles) {
      const version = { point: index, data: this.copyTile(t) };
      (this.versions[t] ??= []).push(version);
      this.bytes += version.data.byteLength + VERSION_OVERHEAD;
    }
    this.points.push({ move: this.move, tiles: Int32Array.from(tiles) });
    this.base = index;
    // Over the memory budget: fold every other point into the one after it and space new points twice as far apart.
    while (this.bytes > this.memory && this.points.length > 1) this.thin();
  }

  /** A tile's cell range [ia, ib) × [ja, jb). */
  private tileRange(t: number) {
    const { nx, ny, tilesX } = this.field;
    const ia = (t % tilesX) * TILE, ja = Math.floor(t / tilesX) * TILE;
    return { ia, ja, w: Math.min(nx, ia + TILE) - ia, rows: Math.min(ny, ja + TILE) - ja };
  }

  private copyTile(t: number): ArrayBuffer {
    const { ia, ja, w, rows } = this.tileRange(t), { nx, h, rim, op } = this.field, n = w * rows;
    const data = new ArrayBuffer(n * 9), hv = new Float32Array(data, 0, n), rv = new Uint32Array(data, n * 4, n), ov = new Uint8Array(data, n * 8, n);
    for (let r = 0; r < rows; r++) {
      const at = (ja + r) * nx + ia;
      hv.set(h.subarray(at, at + w), r * w);
      rv.set(rim.subarray(at, at + w), r * w);
      ov.set(op.subarray(at, at + w), r * w);
    }
    return data;
  }

  /** Writes a tile's version back (null: the starting stock). */
  private writeTile(t: number, data: ArrayBuffer | null) {
    const { ia, ja, w, rows } = this.tileRange(t), { nx, h, rim, op } = this.field, n = w * rows;
    for (let r = 0; r < rows; r++) {
      const at = (ja + r) * nx + ia;
      if (data) {
        h.set(new Float32Array(data, r * w * 4, w), at);
        rim.set(new Uint32Array(data, n * 4 + r * w * 4, w), at);
        op.set(new Uint8Array(data, n * 8 + r * w, w), at);
      } else {
        h.set(this.h0.subarray(at, at + w), at);
        rim.fill(0, at, at + w);
        op.fill(0, at, at + w);
      }
    }
    this.field.refreshTile(t);
    this.field.mark(ia, ja, ia + w - 1, ja + rows - 1);
  }

  /** A tile's latest version at or before point k. */
  private versionAt(t: number, k: number): ArrayBuffer | null {
    const list = this.versions[t];
    if (!list) return null;
    let lo = 0, hi = list.length - 1, out: Version | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].point <= k) { out = list[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return out?.data ?? null;
  }

  /**
   * To restore point k (−1: the starting stock): only the tiles that can differ between the field and that point are
   * written, those touched since the current point and those any point between the two changed.
   */
  private restore(k: number) {
    const touched = this.field.takeTouched();
    const seen = new Uint8Array(this.versions.length), tiles: number[] = [];
    const add = (t: number) => { if (!seen[t]) { seen[t] = 1; tiles.push(t); } };
    for (const t of touched) add(t);
    for (let p = Math.min(this.base, k) + 1; p <= Math.max(this.base, k); p++) for (const t of this.points[p].tiles) add(t);
    for (const t of tiles) this.writeTile(t, this.versionAt(t, k));
    this.base = k;
    this.move = k >= 0 ? this.points[k].move : 0;
    this.frac = 0; this.piece = 0;
    this.since = 0;
  }

  /** Halves the restore points: each pair becomes its later point, keeping each tile's later version. */
  private thin() {
    const old = this.points, kept: Point[] = [];
    for (let i = 0; i < old.length; i += 2) {
      const second = old[i + 1];
      if (!second) { kept.push(old[i]); break; }
      const tiles = new Set<number>([...old[i].tiles, ...second.tiles]);
      kept.push({ move: second.move, tiles: Int32Array.from(tiles) });
    }
    let bytes = 0;
    for (let t = 0; t < this.versions.length; t++) {
      const list = this.versions[t];
      if (!list) continue;
      const out: Version[] = [];
      for (const version of list) {
        const point = version.point >> 1;
        if (out.length && out[out.length - 1].point === point) out[out.length - 1] = { point, data: version.data };
        else out.push({ point, data: version.data });
      }
      for (const version of out) bytes += version.data.byteLength + VERSION_OVERHEAD;
      this.versions[t] = out;
    }
    this.points = kept;
    this.bytes = bytes;
    this.base = this.base >> 1;
    this.snapshotWork *= 2;
  }
}
