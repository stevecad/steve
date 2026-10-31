/**
 * The stock grid drawn as its exposed cells: an instanced box per definite cell that touches anything other than
 * definite material (or the grid's edge), and per uncertain cell that touches removed material (or the edge). Updated
 * cell by cell as transitions apply, so a long program plays without rebuilding the whole stock each frame; a
 * keyframe restore rebuilds it once. Boxes sit in machine millimetres, like the checkpoint meshes.
 */
import * as THREE from 'three';
import { DEFINITE, REMOVED, UNCERTAIN, type CellStock } from './stock';

const box = new THREE.BoxGeometry(1, 1, 1);
const scratch = new THREE.Matrix4();

/** One instanced mesh of boxes with a cell ↔ instance map; removal swaps the last instance into the gap. */
class Boxes {
  mesh: THREE.InstancedMesh;
  cellOf: Int32Array;
  constructor(capacity: number, material: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(box, material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cellOf = new Int32Array(capacity);
  }
  get full() { return this.mesh.count >= this.cellOf.length; }
}

export class StockMesh {
  readonly group = new THREE.Group();
  private readonly stock: CellStock;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly cell: number;
  private readonly origin: number[];
  /** Per cell: its instance index, or −1; `drawn` says which mesh (DEFINITE or UNCERTAIN, REMOVED for none). */
  private readonly slot: Int32Array;
  private readonly drawn: Uint8Array;
  private definite!: Boxes;
  private uncertain!: Boxes;
  private materials: { definite: THREE.Material; uncertain: THREE.Material };

  constructor(stock: CellStock, materials: { definite: THREE.Material; uncertain: THREE.Material }) {
    this.stock = stock;
    [this.nx, this.ny, this.nz] = stock.grid.shape;
    this.cell = stock.grid.cell_mm;
    this.origin = stock.grid.origin_mm;
    this.slot = new Int32Array(stock.size).fill(-1);
    this.drawn = new Uint8Array(stock.size);
    this.materials = materials;
    this.allocate(1024, 256);
  }

  /** Instances drawn per state (for the display's readout and tests). */
  get counts() { return { definite: this.definite.mesh.count, uncertain: this.uncertain.mesh.count }; }

  setMaterials(materials: { definite: THREE.Material; uncertain: THREE.Material }, order: { definite: number; uncertain: number }) {
    this.materials = materials;
    this.definite.mesh.material = materials.definite;
    this.uncertain.mesh.material = materials.uncertain;
    this.definite.mesh.renderOrder = order.definite;
    this.uncertain.mesh.renderOrder = order.uncertain;
  }

  /** Redraws every cell (after a keyframe restore). */
  rebuild() {
    const states = this.stock.states;
    let definite = 0, uncertain = 0;
    for (let c = 0; c < states.length; c++) {
      const want = this.wanted(c);
      if (want === DEFINITE) definite++;
      else if (want === UNCERTAIN) uncertain++;
    }
    if (this.definite.cellOf.length < definite || this.uncertain.cellOf.length < uncertain) {
      this.allocate(Math.max(1024, Math.ceil(definite * 1.25)), Math.max(256, Math.ceil(uncertain * 1.25)));
    }
    this.definite.mesh.count = 0;
    this.uncertain.mesh.count = 0;
    this.slot.fill(-1);
    this.drawn.fill(REMOVED);
    for (let c = 0; c < states.length; c++) {
      const want = this.wanted(c);
      if (want !== REMOVED) this.add(c, want);
    }
    this.flush();
  }

  /** Redraws the changed cells and their neighbours (whose exposure may have changed). */
  update(cells: number[]) {
    if (cells.length > this.stock.size / 8) { this.rebuild(); return; }
    const plane = this.nx * this.ny;
    for (const c of cells) {
      this.refresh(c);
      const x = c % this.nx, y = Math.floor(c / this.nx) % this.ny, z = Math.floor(c / plane);
      if (x > 0) this.refresh(c - 1);
      if (x < this.nx - 1) this.refresh(c + 1);
      if (y > 0) this.refresh(c - this.nx);
      if (y < this.ny - 1) this.refresh(c + this.nx);
      if (z > 0) this.refresh(c - plane);
      if (z < this.nz - 1) this.refresh(c + plane);
    }
    this.flush();
  }

  dispose() {
    this.definite.mesh.dispose();
    this.uncertain.mesh.dispose();
  }

  private allocate(definite: number, uncertain: number) {
    if (this.definite) { this.group.remove(this.definite.mesh, this.uncertain.mesh); this.dispose(); }
    this.definite = new Boxes(Math.min(this.stock.size, definite), this.materials.definite);
    this.uncertain = new Boxes(Math.min(this.stock.size, uncertain), this.materials.uncertain);
    this.definite.mesh.userData.camStockCells = 'definite';
    this.uncertain.mesh.userData.camStockCells = 'uncertain';
    this.group.add(this.definite.mesh, this.uncertain.mesh);
  }

  /** What a cell should show as: definite and touching anything else, uncertain and touching removed, else nothing. */
  private wanted(c: number): number {
    const states = this.stock.states;
    const state = states[c];
    if (state === REMOVED) return REMOVED;
    const x = c % this.nx, y = Math.floor(c / this.nx) % this.ny, z = Math.floor(c / (this.nx * this.ny));
    if (x === 0 || y === 0 || z === 0 || x === this.nx - 1 || y === this.ny - 1 || z === this.nz - 1) return state;
    const plane = this.nx * this.ny;
    const near = [states[c - 1], states[c + 1], states[c - this.nx], states[c + this.nx], states[c - plane], states[c + plane]];
    return near.some((value) => (state === DEFINITE ? value !== DEFINITE : value === REMOVED)) ? state : REMOVED;
  }

  private refresh(c: number) {
    const want = this.wanted(c);
    if (this.drawn[c] === want) return;
    if (this.drawn[c] !== REMOVED) this.remove(c);
    if (want !== REMOVED) this.add(c, want);
  }

  private add(c: number, state: number) {
    let boxes = state === DEFINITE ? this.definite : this.uncertain;
    if (boxes.full) {
      // Out of instances: grow both and redraw (rare; a rebuild sizes them with headroom).
      this.rebuild();
      boxes = state === DEFINITE ? this.definite : this.uncertain;
      if (this.drawn[c] === state) return;
    }
    const x = c % this.nx, y = Math.floor(c / this.nx) % this.ny, z = Math.floor(c / (this.nx * this.ny));
    const size = this.cell;
    scratch.makeScale(size, size, size).setPosition(this.origin[0] + (x + 0.5) * size, this.origin[1] + (y + 0.5) * size, this.origin[2] + (z + 0.5) * size);
    const index = boxes.mesh.count++;
    boxes.mesh.setMatrixAt(index, scratch);
    boxes.cellOf[index] = c;
    this.slot[c] = index;
    this.drawn[c] = state;
  }

  private remove(c: number) {
    const boxes = this.drawn[c] === DEFINITE ? this.definite : this.uncertain;
    const index = this.slot[c], last = boxes.mesh.count - 1;
    if (index !== last) {
      boxes.mesh.getMatrixAt(last, scratch);
      boxes.mesh.setMatrixAt(index, scratch);
      const moved = boxes.cellOf[last];
      boxes.cellOf[index] = moved;
      this.slot[moved] = index;
    }
    boxes.mesh.count = last;
    this.slot[c] = -1;
    this.drawn[c] = REMOVED;
  }

  private flush() {
    this.definite.mesh.instanceMatrix.needsUpdate = true;
    this.uncertain.mesh.instanceMatrix.needsUpdate = true;
  }
}
