/**
 * Draws a video's frames: the viewer's scene rendered once per frame at the output size, over the viewport's backdrop
 * and under its vignette, with the axis triad and view cube when presentation view shows them. The picture is the
 * viewport's: the same camera (framed so everything the viewport shows stays in), lights, styles and grid, at the
 * output's pixel scale (edges and grid lines as thick, relative to the picture, as on screen).
 *
 * While frames are drawn the viewport's canvas renders at the output size, so it hides behind a still of the view
 * (the person sees no change) until `dispose` puts everything back.
 */
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import { useApp, viewportTheme } from '@/state/store';

export interface Overlays { triad: boolean; cube: boolean }

export interface FrameRenderer {
  width: number;
  height: number;
  /** The composed frame: valid until the next call. `turn` is the turntable's angle in degrees. */
  draw: (turn: number) => HTMLCanvasElement;
  dispose: () => void;
}

/** The largest frame this GPU renders, in pixels a side. */
export function maxFrameSide(): number {
  const gl = viewer.gl?.getContext();
  if (!gl) return 4096;
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, viewport[0], viewport[1]);
}

/** A CSS colour (custom properties and color-mix included) as the canvas takes it. */
function resolve(host: HTMLElement, value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  host.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** The viewport's backdrop (Viewport.module.css .backdrop): a soft light from above over a top-to-bottom gradient. */
function paintBackdrop(context: CanvasRenderingContext2D, width: number, height: number, host: HTMLElement) {
  const top = resolve(host, 'var(--vp-top)'), bottom = resolve(host, 'var(--vp-bottom)');
  const glow = resolve(host, 'color-mix(in srgb, var(--vp-top) 100%, white 3%)');
  const linear = context.createLinearGradient(0, 0, 0, height);
  linear.addColorStop(0, top);
  linear.addColorStop(1, bottom);
  context.fillStyle = linear;
  context.fillRect(0, 0, width, height);
  ellipse(context, width, height, { x: 0.5, y: 0.18, rx: 1.2, ry: 0.9 }, [[0, glow], [0.65, withAlpha(glow, 0)]]);
}

/** The vignette over the picture (Viewport.module.css .vignette). */
function paintVignette(context: CanvasRenderingContext2D, width: number, height: number, light: boolean) {
  const edge = light ? 'rgba(40,60,70,0.08)' : 'rgba(0,0,0,0.28)';
  ellipse(context, width, height, { x: 0.5, y: 0.45, rx: 1.4, ry: 1.1 }, [[light ? 0.6 : 0.55, withAlpha(edge, 0)], [1, edge]]);
}

/**
 * A CSS `radial-gradient(rx% ry% at x% y%, …)`: an ellipse whose radii are fractions of the box (CSS sizes it to the
 * box, not the corner, when both radii are given).
 */
function ellipse(context: CanvasRenderingContext2D, width: number, height: number, shape: { x: number; y: number; rx: number; ry: number }, stops: [number, string][]) {
  context.save();
  context.translate(shape.x * width, shape.y * height);
  context.scale(shape.rx * width, shape.ry * height);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [at, color] of stops) gradient.addColorStop(at, color);
  context.fillStyle = gradient;
  context.fillRect(-shape.x / shape.rx, -shape.y / shape.ry, 1 / shape.rx, 1 / shape.ry);
  context.restore();
}

/** The same colour at `alpha` (a gradient to transparent black would fade through grey; CSS's to `transparent` doesn't). */
function withAlpha(color: string, alpha: number): string {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return `rgba(0,0,0,${alpha})`;
  const [r, g, b] = match[1].split(/[\s,/]+/).filter(Boolean);
  return `rgba(${r},${g},${b},${alpha})`;
}

const AXES: { label: string; color: string; v: [number, number, number] }[] = [
  { label: 'X', color: 'var(--axis-x)', v: [1, 0, 0] }, { label: 'Y', color: 'var(--axis-y)', v: [0, 1, 0] }, { label: 'Z', color: 'var(--axis-z)', v: [0, 0, 1] },
];

/** The axis triad in the lower-left corner, as viewport/Triad.tsx draws it, `scale` output pixels per CSS pixel. */
function drawTriad(context: CanvasRenderingContext2D, camera: THREE.Camera, height: number, scale: number, colors: string[], dot: string) {
  const e = camera.matrixWorldInverse.elements;
  const C = 34, R = 24;
  const cx = (10 + C) * scale, cy = height - (10 + C) * scale;
  const axes = AXES.map((axis, i) => {
    const [x, y, z] = axis.v;
    return { i, vx: e[0] * x + e[4] * y + e[8] * z, vy: e[1] * x + e[5] * y + e[9] * z, vz: e[2] * x + e[6] * y + e[10] * z };
  }).sort((a, b) => a.vz - b.vz);
  context.save();
  context.lineCap = 'round';
  context.textAlign = 'center';
  context.font = `700 ${10 * scale}px Inter, system-ui, sans-serif`;
  context.shadowColor = 'rgba(0,0,0,0.4)';
  context.shadowOffsetY = scale;
  context.shadowBlur = scale;
  context.fillStyle = dot;
  context.beginPath(); context.arc(cx, cy, 2.5 * scale, 0, Math.PI * 2); context.fill();
  for (const { i, vx, vy, vz } of axes) {
    context.globalAlpha = 0.5 + 0.5 * (vz + 1) / 2;
    context.strokeStyle = context.fillStyle = colors[i];
    context.lineWidth = 2 * scale;
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(cx + vx * R * scale, cy - vy * R * scale); context.stroke();
    context.fillText(AXES[i].label, cx + vx * (R + 8) * scale, cy - vy * (R + 8) * scale + 3.5 * scale);
  }
  context.restore();
}

const FACES: { name: string; n: number[]; r: number[]; u: number[] }[] = [
  { name: 'TOP', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] }, { name: 'BOTTOM', n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
  { name: 'FRONT', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] }, { name: 'BACK', n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
  { name: 'RIGHT', n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] }, { name: 'LEFT', n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
];

/** The view cube in the upper-right corner (viewport/ViewCube.tsx, an orthographic cube), its faces toward the camera. */
function drawCube(context: CanvasRenderingContext2D, camera: THREE.Camera, width: number, scale: number, colors: { face: string; edge: string; label: string }) {
  const e = camera.matrixWorldInverse.elements;
  // World direction → screen (x right, y down) and depth toward the viewer.
  const screen = (v: number[]) => [e[0] * v[0] + e[4] * v[1] + e[8] * v[2], -(e[1] * v[0] + e[5] * v[1] + e[9] * v[2]), e[2] * v[0] + e[6] * v[1] + e[10] * v[2]];
  const H = 33 * scale;
  // .wrap at top 14, right 14; the 118 px stage, then the 22 px controls column and its 4 px gap, which the video leaves out.
  const cx = width - (14 + 22 + 4 + 59) * scale, cy = (14 + 59) * scale;
  context.save();
  context.font = `700 ${10 * scale}px Inter, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const face of FACES.map((f) => ({ ...f, depth: screen(f.n)[2] })).filter((f) => f.depth > 1e-3).sort((a, b) => a.depth - b.depth)) {
    const [nx, ny] = screen(face.n), [rx, ry] = screen(face.r), [ux, uy] = screen(face.u);
    // The face's plane: its centre at n·H, right along r and up along u (CSS's y down, so up is -u).
    context.setTransform(rx * H, ry * H, -ux * H, -uy * H, cx + nx * H, cy + ny * H);
    const radius = 7 / 33;
    context.beginPath();
    context.roundRect(-1, -1, 2, 2, radius);
    context.fillStyle = colors.face;
    context.globalAlpha = 0.96;
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = 1 / 33;
    context.strokeStyle = colors.edge;
    context.stroke();
    context.fillStyle = colors.label;
    context.font = `700 ${10 / 33}px Inter, system-ui, sans-serif`;
    context.fillText(face.name, 0, 0.02, 1.8);
  }
  context.restore();
}

/**
 * Takes over the viewer to draw `width` × `height` frames until `dispose`. Throws when the viewer isn't ready.
 */
export function frameRenderer(width: number, height: number, overlays: Overlays): FrameRenderer {
  const { gl, scene, camera, controls } = viewer;
  const host = document.getElementById('viewport');
  if (!gl || !scene || !camera || !controls || !host) throw new Error('The viewport isn’t ready.');
  const canvas = gl.domElement;
  const css = gl.getSize(new THREE.Vector2());
  const ratio = gl.getPixelRatio();
  const light = viewportTheme(useApp.getState()) === 'light';

  // A still of the view over the canvas while it renders frames at another size.
  gl.render(scene, camera);
  // A copy on a 2D canvas (no image encoding: that takes seconds at full size without a GPU).
  const still = document.createElement('canvas');
  still.width = canvas.width;
  still.height = canvas.height;
  still.getContext('2d')?.drawImage(canvas, 0, 0);
  still.setAttribute('aria-hidden', 'true');
  still.dataset.videoStill = '';
  still.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  canvas.insertAdjacentElement('afterend', still);
  // The canvas itself hides: the still is transparent around the model, where the frames would show through.
  const visibility = canvas.style.visibility;
  canvas.style.visibility = 'hidden';
  const wasEnabled = controls.enabled;
  controls.enabled = false;

  // Output pixels per viewport pixel, so lines keep their weight in the picture; the drawing buffer exactly the output.
  const scale = Math.min(width / css.x, height / css.y);
  /** The drawing buffer exactly the output. Again before each frame: a window resize in between gives it back to the viewport. */
  const size = () => {
    if (canvas.width === width && canvas.height === height) return;
    gl.setPixelRatio(scale);
    gl.setSize((width + 0.25) / scale, (height + 0.25) / scale, false);
    if (canvas.width !== width || canvas.height !== height) {
      gl.setPixelRatio(1);
      gl.setSize(width, height, false);
    }
  };
  size();

  // Frame like the viewport: everything it shows stays in, the rest of a wider or taller picture shows more around it.
  // Set before each frame too (the viewport sets its own on a resize).
  const viewAspect = css.x / css.y, outAspect = width / height;
  let project: () => void;
  if (camera instanceof THREE.OrthographicCamera) {
    const w = camera.right - camera.left, h = camera.top - camera.bottom;
    const [nw, nh] = outAspect >= viewAspect ? [h * outAspect, h] : [w, w / outAspect];
    const mx = (camera.right + camera.left) / 2, my = (camera.top + camera.bottom) / 2;
    project = () => Object.assign(camera, { left: mx - nw / 2, right: mx + nw / 2, top: my + nh / 2, bottom: my - nh / 2 });
  } else {
    const fov = camera.fov;
    const wider = outAspect < viewAspect ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * (viewAspect / outAspect))) : fov;
    project = () => Object.assign(camera, { fov: wider, aspect: outAspect });
  }
  const restore = () => {
    // The viewport's own projection, for its size now (it may have changed while recording), as the canvas sets it.
    const { width: w, height: h } = viewer.size;
    if (camera instanceof THREE.OrthographicCamera) Object.assign(camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    else Object.assign(camera, { aspect: w / h, fov: (saved as { fov: number }).fov });
    camera.updateProjectionMatrix();
  };
  const saved = camera instanceof THREE.OrthographicCamera ? {} : { fov: camera.fov };
  project();
  camera.updateProjectionMatrix();

  // The turntable: the camera turns about world Z through the view's target.
  const eye = controls.getPosition(new THREE.Vector3(), false), target = controls.getTarget(new THREE.Vector3(), false);
  const up = camera.up.clone();
  const Z = new THREE.Vector3(0, 0, 1);
  let turned = 0;
  const turn = (degrees: number) => {
    if (Math.abs(degrees - turned) < 1e-9) return;
    turned = degrees;
    const q = new THREE.Quaternion().setFromAxisAngle(Z, THREE.MathUtils.degToRad(degrees));
    const at = eye.clone().sub(target).applyQuaternion(q).add(target);
    camera.up.copy(up).applyQuaternion(q);
    controls.updateCameraUp();
    void controls.setLookAt(at.x, at.y, at.z, target.x, target.y, target.z, false);
    controls.update(0);
  };

  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  const context = frame.getContext('2d', { alpha: false })!;
  const backdrop = document.createElement('canvas');
  backdrop.width = width;
  backdrop.height = height;
  paintBackdrop(backdrop.getContext('2d')!, width, height, host);
  const vignette = document.createElement('canvas');
  vignette.width = width;
  vignette.height = height;
  paintVignette(vignette.getContext('2d')!, width, height, light);
  const axisColors = AXES.map((axis) => resolve(host, axis.color));
  const dot = resolve(host, 'var(--text-3)');
  const cubeColors = { face: resolve(host, light ? '#f3f5f7' : 'color-mix(in srgb, var(--bg-5) 92%, white 8%)'), edge: resolve(host, 'var(--line-4)'), label: resolve(host, 'var(--text-2)') };

  return {
    width, height,
    draw: (degrees) => {
      size();
      project();
      camera.updateProjectionMatrix();
      turn(degrees);
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      gl.render(scene, camera);
      context.drawImage(backdrop, 0, 0);
      // Same task as the render: the drawing buffer is still there to copy.
      context.drawImage(canvas, 0, 0, width, height);
      context.drawImage(vignette, 0, 0);
      if (overlays.triad) drawTriad(context, camera, height, scale, axisColors, dot);
      if (overlays.cube) drawCube(context, camera, width, scale, cubeColors);
      return frame;
    },
    dispose: () => {
      turn(0);
      restore();
      gl.setPixelRatio(ratio);
      gl.setSize(viewer.size.width, viewer.size.height, false);
      controls.enabled = wasEnabled;
      gl.render(scene, camera);
      canvas.style.visibility = visibility;
      still.remove();
      viewer.invalidate();
    },
  };
}
