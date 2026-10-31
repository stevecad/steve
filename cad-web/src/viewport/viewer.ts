import * as THREE from 'three';
import type CameraControls from 'camera-controls';
import type { ModelRuntime } from './model';
import { set, type Pick, type StandardView } from '@/state/store';

export const VIEW_DIRECTIONS: Record<StandardView, [number, number, number]> = {
  iso: [1, -1, 0.82],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

export const VIEW_LABELS: Record<StandardView, string> = {
  iso: 'Isometric', top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', right: 'Right', left: 'Left',
};

type CameraListener = (camera: THREE.Camera) => void;
export interface CameraPose { position: number[]; target: number[]; zoom: number | null; up?: number[]; focalOffset?: number[] }

const Z_UP = new THREE.Vector3(0, 0, 1);

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Imperative bridge between React UI and the three.js viewport. */
class Viewer {
  controls: CameraControls | null = null;
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  gl: THREE.WebGLRenderer | null = null;
  scene: THREE.Scene | null = null;
  model: ModelRuntime | null = null;
  outgoing: ModelRuntime | null = null;
  size = { width: 1, height: 1 };
  insets = { top: 24, right: 150, bottom: 84, left: 24 };
  /** Presentation view: nothing covers the canvas's corners, so framing needs room only for the player. */
  presenting = false;
  interacting = false;
  /** True while the camera is still moving. camera-controls' own `active` stays set after an
   *  instant jump (it only notices rest while moving), so this follows its wake/rest/sleep events. */
  moving = false;
  /** Performs the viewport's normal click action; set by the interaction layer. */
  clickAt: (event: PointerEvent, button: number) => void = () => {};
  /** Select other: lists everything under a point of the canvas to choose from (false: nothing there); set by the
   * interaction layer. */
  openPickList: (clientX: number, clientY: number, additive?: boolean) => boolean = () => false;
  /** Does what a click on `pick` would (a choice from that list): into the open tool or dialog, else selects it. */
  choosePick: (pick: Pick, additive: boolean, at: { x: number; y: number }) => void = () => {};
  /** View depth of the model point grabbed by a mouse pan, so it stays under the cursor; null pans at the target's depth. */
  panDepth: number | null = null;
  /** True while the pointer is over the draggable section plane. */
  sectionHot = false;
  /** The live section clipping plane, mutated in place while dragging. */
  readonly sectionPlane = new THREE.Plane();
  /** True while the camera still shows an automatic framing the user hasn't changed. */
  autoFramed = false;
  invalidate: () => void = () => {};
  private listeners = new Set<CameraListener>();
  private modelListeners = new Set<() => void>();
  private readonly box = new THREE.Box3();
  private pendingPose: CameraPose | null = null;

  onCamera(listener: CameraListener) {
    this.listeners.add(listener);
    if (this.camera) listener(this.camera);
    return () => { this.listeners.delete(listener); };
  }

  onModelChange(listener: () => void) {
    this.modelListeners.add(listener);
    return () => { this.modelListeners.delete(listener); };
  }

  notifyModel() {
    for (const listener of this.modelListeners) listener();
    this.invalidate();
  }

  emitCamera() {
    if (this.camera) for (const listener of this.listeners) listener(this.camera);
  }

  visibleBounds(): THREE.Box3 {
    return this.model ? this.model.bounds(true) : this.box.makeEmpty();
  }

  modelRadius(): number {
    const box = this.model?.bounds(false);
    if (!box || box.isEmpty()) return 100;
    return Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
  }

  /** Frames a box from a view direction, animating rotation, target and zoom together. */
  frame(box: THREE.Box3 | null = null, direction: THREE.Vector3 | null = null, animate = true) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    const bounds = box && !box.isEmpty() ? box : this.visibleBounds();
    if (bounds.isEmpty()) return;
    const smooth = animate && !reducedMotion();
    const target = controls.getTarget(new THREE.Vector3());
    const eye = controls.getPosition(new THREE.Vector3());
    const dir = (direction ?? eye.clone().sub(target)).clone().normalize();
    if (dir.lengthSq() < 0.5) dir.set(1, -1, 0.8).normalize();

    // Camera basis for the destination orientation: named views stand upright on Z, a plain
    // refit keeps whatever roll free orbiting left the camera in.
    const up = direction ? Z_UP.clone() : camera.up.clone();
    const basis = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), up);
    const xAxis = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    const yAxis = new THREE.Vector3().setFromMatrixColumn(basis, 1);
    const center = bounds.getCenter(new THREE.Vector3());
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z).sub(center);
      const x = corner.dot(xAxis), y = corner.dot(yAxis);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const halfWidth = Math.max((maxX - minX) / 2, 1e-3);
    const halfHeight = Math.max((maxY - minY) / 2, 1e-3);
    const { width, height } = this.size;
    const inset = this.insets;
    const usableW = Math.max(width - inset.left - inset.right, width * 0.35);
    const usableH = Math.max(height - inset.top - inset.bottom, height * 0.35);
    // Shift so the model centers in the usable area rather than behind overlays.
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const frameCenter = center.clone()
      .addScaledVector(xAxis, (maxX + minX) / 2)
      .addScaledVector(yAxis, (maxY + minY) / 2);
    this.setUp(up);
    // Drop the offset a click-to-pivot left behind, or the view lands off-centre.
    void controls.setFocalOffset(0, 0, 0, smooth);

    if (camera instanceof THREE.OrthographicCamera) {
      const zoom = Math.min(usableW / (2 * halfWidth), usableH / (2 * halfHeight)) * 0.9;
      const worldPerPixel = 1 / zoom;
      frameCenter.addScaledVector(xAxis, -((inset.left - inset.right) / 2) * worldPerPixel);
      frameCenter.addScaledVector(yAxis, ((inset.top - inset.bottom) / 2) * worldPerPixel);
      const distance = Math.max(radius * 8, 50);
      camera.near = -radius * 40;
      camera.far = distance + radius * 60 + 1e4;
      camera.updateProjectionMatrix();
      const position = frameCenter.clone().addScaledVector(dir, distance);
      void controls.setLookAt(position.x, position.y, position.z, frameCenter.x, frameCenter.y, frameCenter.z, smooth);
      void controls.zoomTo(zoom, smooth);
    } else {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const aspect = usableW / usableH;
      const distance = Math.max(halfHeight / Math.tan(fov / 2), halfWidth / (Math.tan(fov / 2) * aspect)) * 1.12 + radius;
      camera.near = Math.max(distance / 2000, 0.01);
      camera.far = distance * 50 + radius * 20;
      camera.updateProjectionMatrix();
      const position = frameCenter.clone().addScaledVector(dir, distance);
      void controls.setLookAt(position.x, position.y, position.z, frameCenter.x, frameCenter.y, frameCenter.z, smooth);
    }
    this.invalidate();
  }

  fit(animate = true) {
    this.frame(null, null, animate);
    this.autoFramed = true;
  }

  setView(view: StandardView, animate = true) {
    this.frame(null, new THREE.Vector3(...VIEW_DIRECTIONS[view]), animate);
    this.autoFramed = true;
    set({ view });
  }

  lookFrom(direction: THREE.Vector3, animate = true) {
    const dir = direction.clone().normalize();
    // Keep top/bottom views oriented with +Y up on screen.
    if (Math.abs(dir.z) > 0.9999) dir.set(0, -1e-4, Math.sign(dir.z));
    this.frame(null, dir, animate);
    const match = (Object.entries(VIEW_DIRECTIONS) as [StandardView, number[]][])
      .find(([, value]) => new THREE.Vector3(...value).normalize().distanceTo(dir) < 1e-3);
    set({ view: match ? match[0] : null });
  }

  zoomTo(box: THREE.Box3) {
    if (!box.isEmpty()) this.frame(box, null, true);
  }

  /** Orbit steps around the screen axes, as used by the view cube arrows. */
  rotateBy(azimuthDeg: number, polarDeg: number) {
    if (!this.controls) return;
    void this.controls.rotate(THREE.MathUtils.degToRad(azimuthDeg), THREE.MathUtils.degToRad(polarDeg), !reducedMotion());
    set({ view: null });
  }

  /**
   * Orbits about the target like `controls.rotate` (same signs, radians), but without its stop at
   * the top and bottom, so the view cube, SpaceMouse and mouse drags can tumble the model all the
   * way round. The view cube and SpaceMouse turn like a turntable (about world Z). Mouse drags
   * (`free`) turn freely about the screen's own axes, like desktop CAD: left/right always swings the
   * model left/right, even from the top view or for a part whose axis is Z, and they keep turning
   * about the point a click on the model chose. The SpaceMouse also passes `roll`, a turn about the
   * line of sight, and the view keeps that roll rather than standing back upright.
   */
  orbit(azimuth: number, elevation: number, free = false, roll?: number) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    const target = controls.getTarget(new THREE.Vector3(), false);
    const offset = controls.getPosition(new THREE.Vector3(), false).sub(target);
    // The camera's own basis, as camera.lookAt builds it from camera.up.
    const back = offset.clone().normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, back);
    if (right.lengthSq() < 1e-12) right.setFromMatrixColumn(camera.matrixWorld, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    // Clicking the model pivots about the point under the cursor, which camera-controls keeps as a
    // target plus a camera-space focal offset. Fold that offset into the target (the view doesn't
    // move) so the tumble turns about the middle of the screen, not a stale clicked point. A mouse
    // drag keeps it: the offset stays put on screen, so the turn is about the clicked point.
    const focal = controls.getFocalOffset(new THREE.Vector3(), false);
    if (!free && focal.lengthSq() > 0) {
      // The offset shifts the camera and its target alike: fold it into both (offset, eye - target, is unchanged).
      target.addScaledVector(right, focal.x).addScaledVector(up, -focal.y).addScaledVector(back, focal.z);
      void controls.setFocalOffset(0, 0, 0, false);
    }
    // Turntable: turn about world Z (reversed once over the top, so a drag keeps its on-screen
    // direction). Free: turn about the screen's vertical axis. Both tip about the screen's
    // horizontal axis with no limit.
    const spin = free ? up.clone() : up.z < 0 ? Z_UP.clone().negate() : Z_UP;
    const turn = new THREE.Quaternion().setFromAxisAngle(spin, azimuth)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, elevation))
      .multiply(new THREE.Quaternion().setFromAxisAngle(back, roll ?? 0));
    offset.applyQuaternion(turn);
    up.applyQuaternion(turn).normalize();
    // Turntable: keep camera.up on world Z (or -Z once upside down); only right at a pole does the
    // camera carry its own up vector. Free, or with a roll: the camera keeps the up it turned to (no
    // snap back). Unrolled, that up lies in the same vertical plane as Z, so the view is the same.
    const keep = free || roll !== undefined;
    camera.up.copy(keep || Math.abs(up.z) <= 1e-3 ? up : up.z > 0 ? Z_UP : Z_UP.clone().negate());
    controls.updateCameraUp();
    const eye = target.clone().add(offset);
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }

  /**
   * Mouse-drag rotation exactly as Open Inventor's examiner viewer does it (Coin's SbSphereSheetProjector, FreeCAD's
   * "Trackball" orbit style): each pointer position, in the canvas's own -1..1 coordinates (x right, y up), is
   * projected onto a virtual trackball of radius 0.8 centred on the screen, which beyond 45 degrees from its centre
   * continues as a hyperbolic sheet (height r^2/2 / distance); the model turns by the shortest arc that carries the
   * previous projected point to the new one, about the view's centre. A drag across the middle turns about the
   * screen's vertical axis; nearer the top, bottom or sides it twists about the line of sight as well. `from` and `to`
   * are the previous and current pointer positions; `speed` scales the angle (Settings → Navigation, 1 = Inventor's).
   */
  trackball(from: { x: number; y: number }, to: { x: number; y: number }, speed = 1) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    const a = sheetPoint(from.x, from.y), b = sheetPoint(to.x, to.y);
    if (a.distanceToSquared(b) < 1e-14) return;
    // The model's turn in camera space (SbRotation(p1, p2)); the camera turns the opposite way about the target.
    const turn = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
    if (speed !== 1) {
      const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
      const axis = new THREE.Vector3(turn.x, turn.y, turn.z);
      if (axis.lengthSq() > 1e-20) turn.setFromAxisAngle(axis.normalize().multiplyScalar(Math.sign(turn.w) || 1), angle * speed);
    }
    const target = controls.getTarget(new THREE.Vector3(), false);
    const position = controls.getPosition(new THREE.Vector3(), false);
    const view = position.clone().sub(target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, view);
    if (right.lengthSq() < 1e-12) right.setFromMatrixColumn(camera.matrixWorld, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(view, right);
    // Inventor turns about the focal point, the view's centre. A click on the model leaves camera-controls a focal
    // offset (the camera and its target both shifted in camera space): fold it into both, so the view doesn't move.
    const focal = controls.getFocalOffset(new THREE.Vector3(), false);
    if (focal.lengthSq() > 0) {
      const shift = new THREE.Vector3().addScaledVector(right, focal.x).addScaledVector(up, -focal.y).addScaledVector(view, focal.z);
      target.add(shift);
      position.add(shift);
      void controls.setFocalOffset(0, 0, 0, false);
    }
    const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, view));
    const world = basis.clone().multiply(turn.invert()).multiply(basis.clone().invert());
    const offset = position.sub(target).applyQuaternion(world);
    camera.up.copy(up.applyQuaternion(world).normalize());
    controls.updateCameraUp();
    const eye = target.clone().add(offset);
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }

  /** Changes camera.up without moving the camera, re-expressing camera-controls' state in the new frame. */
  private setUp(up: THREE.Vector3) {
    const { controls, camera } = this;
    if (!controls || !camera || camera.up.distanceToSquared(up) < 1e-12) return;
    const target = controls.getTarget(new THREE.Vector3(), false);
    const eye = controls.getPosition(new THREE.Vector3(), false);
    camera.up.copy(up).normalize();
    controls.updateCameraUp();
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }

  /** The current view, so a document tab can come back to exactly where it was. */
  capturePose(): CameraPose | null {
    if (!this.controls || !this.camera) return null;
    return {
      position: this.controls.getPosition(new THREE.Vector3()).toArray(),
      target: this.controls.getTarget(new THREE.Vector3()).toArray(),
      zoom: this.camera instanceof THREE.OrthographicCamera ? this.camera.zoom : null,
      up: this.camera.up.toArray(),
      focalOffset: this.controls.getFocalOffset(new THREE.Vector3()).toArray(),
    };
  }

  applyPose(pose: CameraPose) {
    const projection = pose.zoom === null ? 'perspective' : 'orthographic';
    if (!this.controls || !this.camera || (this.camera instanceof THREE.OrthographicCamera) !== (projection === 'orthographic')) {
      // React creates a new camera when the projection changes. Restore into
      // that camera when it registers, rather than applying to the outgoing one.
      this.pendingPose = pose;
      set({ projection });
      return;
    }
    this.pendingPose = null;
    this.setUp(pose.up ? new THREE.Vector3().fromArray(pose.up) : Z_UP);
    const [px, py, pz] = pose.position, [tx, ty, tz] = pose.target;
    const [fx, fy, fz] = pose.focalOffset ?? [0, 0, 0];
    void this.controls.setFocalOffset(fx, fy, fz, false);
    void this.controls.setLookAt(px, py, pz, tx, ty, tz, false);
    if (pose.zoom && this.camera instanceof THREE.OrthographicCamera) void this.controls.zoomTo(pose.zoom, false);
    this.autoFramed = false;
    set({ view: null });
    this.invalidate();
  }

  /** Called once a replacement camera and its controls are ready. */
  restorePendingPose() {
    if (this.pendingPose) this.applyPose(this.pendingPose);
  }

  screenshot(): string | null {
    if (!this.gl || !this.scene || !this.camera) return null;
    this.gl.render(this.scene, this.camera);
    return this.gl.domElement.toDataURL('image/png');
  }

  cameraDirection(): THREE.Vector3 {
    const target = this.controls?.getTarget(new THREE.Vector3()) ?? new THREE.Vector3();
    const eye = this.controls?.getPosition(new THREE.Vector3()) ?? new THREE.Vector3(1, -1, 1);
    return eye.sub(target).normalize();
  }
}

export const viewer = new Viewer();

/** Coin's SbSphereSheetProjector::project with Open Inventor's examiner settings (orthographic -1..1 view volume,
 * sphere radius 0.8 at the origin, oriented to the eye): the sphere within 45 degrees of its centre, else the
 * hyperbolic sheet z = (r^2 / 2) / d over the plane through the centre. */
const TRACKBALL_RADIUS = 0.8;
function sheetPoint(x: number, y: number): THREE.Vector3 {
  const d = Math.hypot(x, y), r = TRACKBALL_RADIUS;
  if (d < r * Math.cos(Math.PI / 4)) return new THREE.Vector3(x, y, Math.sqrt(r * r - d * d));
  return new THREE.Vector3(x, y, (r * r * 0.5) / d);
}

/** requestAnimationFrame tween that keeps the demand-driven canvas rendering while it runs. */
export function tween(duration: number, step: (t: number) => void, ease: (t: number) => number = easeOutCubic): Promise<void> {
  if (reducedMotion() || duration <= 0) { step(1); viewer.invalidate(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      step(ease(t));
      viewer.invalidate();
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
