import * as THREE from 'three';
import { create } from 'zustand';
import { get as getApp, set as setApp } from '@/state/store';
import { viewer } from './viewer';

/*
 * 3Dconnexion SpaceMouse support.
 * WebHID (Chrome, Edge) reads the device directly; the Gamepad API is a fallback where a
 * platform exposes it as a joystick. Both require a secure context (https or localhost).
 */

interface HIDInputReportEvent extends Event { reportId: number; data: DataView; device: HIDDevice }
interface HIDDevice extends EventTarget { opened: boolean; productName: string; vendorId: number; productId: number; open(): Promise<void>; close(): Promise<void> }
interface HID extends EventTarget { getDevices(): Promise<HIDDevice[]>; requestDevice(options: { filters: { vendorId?: number; usagePage?: number; usage?: number }[] }): Promise<HIDDevice[]> }

const hid = (): HID | undefined => (navigator as Navigator & { hid?: HID }).hid;

// Multi-axis controllers (Generic Desktop / 0x08) from 3Dconnexion and its former Logitech IDs.
const FILTERS = [0x256f, 0x046d].map((vendorId) => ({ vendorId, usagePage: 0x01, usage: 0x08 }));
const FULL_SCALE = 350;
const SETTINGS_KEY = 'steve-spacemouse';
// Input smoothing time constant (seconds): hides sensor noise without feeling floaty.
const SMOOTHING = 0.05;
// Last resort for a device that never sends its final centered report.
const STUCK_TIMEOUT = 5000;

export type SpaceMouseStatus = 'unsupported' | 'insecure' | 'disconnected' | 'connected';

export interface SpaceMouseSettings {
  sensitivity: number;
  invertPan: boolean;
  invertZoom: boolean;
  invertRotate: boolean;
  lockRotation: boolean;
  lockPan: boolean;
  dominant: boolean;
}

const DEFAULTS: SpaceMouseSettings = { sensitivity: 1, invertPan: false, invertZoom: false, invertRotate: false, lockRotation: false, lockPan: false, dominant: false };

function loadSettings(): SpaceMouseSettings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<SpaceMouseSettings>) }; } catch { return DEFAULTS; }
}

export const useSpaceMouse = create<{ status: SpaceMouseStatus; device: string | null; source: 'hid' | 'gamepad' | null; active: boolean; settings: SpaceMouseSettings; error: string | null }>(() => ({
  status: 'disconnected', device: null, source: null, active: false, settings: loadSettings(), error: null,
}));

export function updateSpaceMouseSettings(patch: Partial<SpaceMouseSettings>) {
  const settings = { ...useSpaceMouse.getState().settings, ...patch };
  useSpaceMouse.setState({ settings });
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Optional. */ }
}

/** Latest 6-DoF reading, normalized to [-1, 1]: translation x/y/z, rotation rx/ry/rz. */
const axes = new Float32Array(6);
/** `axes` after low-pass filtering; this is what drives the camera. */
const smoothed = new Float32Array(6);
let lastReport = 0;
let buttons = 0;
let frame = 0;
let lastFrame = 0;
let device: HIDDevice | null = null;

function onReport(event: Event) {
  const { reportId, data } = event as HIDInputReportEvent;
  const read = (offset: number) => (data.byteLength >= offset + 2 ? Math.max(-1, Math.min(1, data.getInt16(offset, true) / FULL_SCALE)) : 0);
  if (reportId === 1) {
    axes[0] = read(0); axes[1] = read(2); axes[2] = read(4);
    // Newer devices report rotation in the same 12-byte report.
    if (data.byteLength >= 12) { axes[3] = read(6); axes[4] = read(8); axes[5] = read(10); }
  } else if (reportId === 2) {
    axes[3] = read(0); axes[4] = read(2); axes[5] = read(4);
  } else if (reportId === 3) {
    let next = 0;
    for (let i = 0; i < Math.min(data.byteLength, 4); i++) next |= data.getUint8(i) << (8 * i);
    onButtons(next);
    return;
  }
  lastReport = performance.now();
  start();
}

function onButtons(next: number) {
  const pressed = next & ~buttons;
  buttons = next;
  // Two-button devices: left (menu) returns to the home view, right fits the model.
  if (pressed & 1) viewer.setView('iso');
  if (pressed & 2) viewer.fit();
}

async function attach(candidate: HIDDevice) {
  // Another tab may have opened it already (InvalidStateError): that's still usable.
  if (!candidate.opened) await candidate.open().catch((error: unknown) => { if (!candidate.opened) throw error; });
  device?.removeEventListener('inputreport', onReport);
  device = candidate;
  device.addEventListener('inputreport', onReport);
  useSpaceMouse.setState({ status: 'connected', device: candidate.productName || 'SpaceMouse', source: 'hid', error: null });
}

const platform = () => ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '').toLowerCase();

/** Why a granted device wouldn't open, in terms the user can act on. */
function openFailure(): string {
  const os = platform();
  if (/mac|win/.test(os)) {
    const helper = os.includes('mac') ? '3DxWare (3DconnexionHelper)' : '3DxWare';
    return `The SpaceMouse couldn’t be opened: the 3Dconnexion driver is using it. Quit ${helper}, then click Connect again. Until you restart the driver, the SpaceMouse won’t work in other apps.`;
  }
  return 'The SpaceMouse couldn’t be opened. On Linux, its hidraw node must be readable by your user; fix that, then click Connect again.';
}

/** Opens the first of a device's collections that will open; one physical device can expose several. */
async function attachAny(candidates: HIDDevice[]) {
  for (const candidate of candidates) {
    try { await attach(candidate); return; } catch { /* Try the next collection. */ }
  }
  throw new Error(openFailure());
}

/** Asks the browser for device access; must run from a click. */
export async function connectSpaceMouse(): Promise<string | null> {
  const api = hid();
  if (!api) return window.isSecureContext ? 'This browser has no WebHID. Use Chrome or Edge.' : 'SpaceMouse access needs a secure connection (https or localhost).';
  let chosen: HIDDevice[];
  try {
    chosen = await api.requestDevice({ filters: FILTERS });
  } catch (error) {
    return (error as Error).message || 'The device could not be opened.';
  }
  if (!chosen.length) return 'No device was chosen.';
  try {
    await attachAny(chosen);
    return null;
  } catch (error) {
    useSpaceMouse.setState({ error: null });
    return (error as Error).message;
  }
}

export async function disconnectSpaceMouse() {
  if (!device) return;
  device.removeEventListener('inputreport', onReport);
  try { await device.close(); } catch { /* Already closed. */ }
  device = null;
  release();
  useSpaceMouse.setState({ status: 'disconnected', device: null, source: null });
}

/** Treats the cap as centered, e.g. when the window loses focus and reports may be missed. */
function release() {
  axes.fill(0);
  smoothed.fill(0);
}

/** Reconnects devices the user already granted, and follows plug/unplug events. */
export function initSpaceMouse() {
  if (!window.isSecureContext) { useSpaceMouse.setState({ status: 'insecure' }); return; }
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  const api = hid();
  if (api) {
    // Granted earlier: reconnect quietly, but keep the reason if it won't open.
    const reattach = (candidates: HIDDevice[]) => {
      const known = candidates.filter((candidate) => FILTERS.some((filter) => filter.vendorId === candidate.vendorId));
      if (known.length) void attachAny(known).catch((error: Error) => useSpaceMouse.setState({ error: error.message }));
    };
    void api.getDevices().then(reattach);
    api.addEventListener('connect', (event) => reattach([(event as Event & { device: HIDDevice }).device]));
    api.addEventListener('disconnect', (event) => { if ((event as Event & { device: HIDDevice }).device === device) { device = null; release(); useSpaceMouse.setState({ status: 'disconnected', device: null, source: null }); } });
  } else {
    // Without WebHID (Safari, Firefox) the device only works if the platform exposes it as a
    // gamepad, which most don't: say so up front until one actually connects.
    useSpaceMouse.setState({ status: 'unsupported' });
    if (!('getGamepads' in navigator)) return;
  }
  window.addEventListener('gamepadconnected', (event) => {
    const pad = (event as GamepadEvent).gamepad;
    if (!device && /3dconnexion|space\s*(mouse|navigator|pilot|explorer)|256f|046d.*c6/i.test(pad.id)) {
      useSpaceMouse.setState({ status: 'connected', device: pad.id.replace(/\(.*\)/, '').trim() || 'SpaceMouse', source: 'gamepad' });
      start();
    }
  });
}

function pollGamepad() {
  if (useSpaceMouse.getState().source !== 'gamepad') return;
  const pad = navigator.getGamepads().find((candidate) => candidate && /3dconnexion|space\s*(mouse|navigator|pilot|explorer)|256f|046d.*c6/i.test(candidate.id));
  if (!pad) return;
  for (let i = 0; i < 6; i++) axes[i] = pad.axes[i] ?? 0;
  let next = 0;
  pad.buttons.forEach((button, index) => { if (button.pressed) next |= 1 << index; });
  if (next !== buttons) onButtons(next);
  lastReport = performance.now();
}

function start() {
  if (!frame) { lastFrame = performance.now(); frame = requestAnimationFrame(tick); }
}

const shape = (value: number, sensitivity: number) => {
  const dead = 0.06;
  const magnitude = Math.abs(value);
  if (magnitude < dead) return 0;
  // Gentle curve: precise near center, fast at full deflection.
  return Math.sign(value) * ((magnitude - dead) / (1 - dead)) ** 1.6 * sensitivity;
};

function tick(now: number) {
  frame = 0;
  pollGamepad();
  // The rAF timestamp can precede the performance.now() taken in start().
  const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.05));
  lastFrame = now;
  // Devices only report when the reading changes, so a steady hold is silent: keep the last
  // reading until the device reports the centered cap, and only give up on a stuck device.
  if (now - lastReport > STUCK_TIMEOUT) axes.fill(0);
  const blend = 1 - Math.exp(-dt / SMOOTHING);
  for (let i = 0; i < 6; i++) {
    smoothed[i] += (axes[i] - smoothed[i]) * blend;
    if (!axes[i] && Math.abs(smoothed[i]) < 1e-3) smoothed[i] = 0;
  }
  const controls = viewer.controls, camera = viewer.camera;
  const { settings } = useSpaceMouse.getState();
  const values = Array.from(smoothed, (value) => shape(value, settings.sensitivity));
  if (settings.dominant) {
    const strongest = values.reduce((best, value, index) => (Math.abs(value) > Math.abs(values[best]) ? index : best), 0);
    values.forEach((_, index) => { if (index !== strongest) values[index] = 0; });
  }
  const moving = values.some((value) => value !== 0);
  const wasMoving = useSpaceMouse.getState().active;
  if (wasMoving !== moving) useSpaceMouse.setState({ active: moving });
  // Take over from any eased camera move still in flight, so the two don't fight.
  if (moving && !wasMoving) controls?.stop();
  if (moving && controls && camera) {
    const [tx, ty, tz, rx, ry, rz] = values;
    const pan = settings.invertPan ? -1 : 1, zoom = settings.invertZoom ? -1 : 1, rotate = settings.invertRotate ? -1 : 1;
    const target = controls.getTarget(new THREE.Vector3());
    const visible = camera instanceof THREE.OrthographicCamera
      ? viewer.size.height / camera.zoom
      : 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2);
    // Object mode: the model follows the cap. truck() moves the camera down for a positive y and the
    // device's Z axis points down, so both terms need a negative sign for the model to follow the cap.
    if (!settings.lockPan) void controls.truck(-tx * pan * visible * 0.9 * dt, -tz * pan * visible * 0.9 * dt, false);
    if (!settings.lockPan && ty) {
      const factor = Math.exp(ty * zoom * 1.6 * dt);
      if (camera instanceof THREE.OrthographicCamera) void controls.zoomTo(camera.zoom / factor, false);
      else void controls.dollyTo(controls.distance * factor, false);
    }
    // The device's Z axis points down, so a twist and a tilt need opposite signs to both follow the cap.
    // Its Y axis points at the user, and turning the camera's up one way turns the model the other, so
    // a roll (cap tipped left or right) is negated too.
    if (!settings.lockRotation) viewer.orbit(rz * rotate * 2.2 * dt, -rx * rotate * 2.2 * dt, false, -ry * rotate * 2.2 * dt);
    viewer.autoFramed = false;
    if (getApp().view) setApp({ view: null });
    viewer.invalidate();
  }
  const held = smoothed.some((value) => value !== 0);
  if (held || useSpaceMouse.getState().source === 'gamepad') start();
}
