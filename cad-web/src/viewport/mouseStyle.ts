/**
 * Settings → Navigation › Mouse style: which mouse buttons and keys orbit, pan and zoom, the way other CAD programs do
 * (each preset follows its maker's help: SOLIDWORKS "Middle Mouse Button Functions", Autodesk Fusion's default "Pan, Zoom,
 * Orbit Shortcuts", Onshape "View navigation"). The wheel always zooms. While sketching the left button is always free
 * for drawing. The main viewport's camera-controls (SceneCore), its pointer handling (Interaction) and the small
 * preview viewers (drei OrbitControls) all read it from here.
 */
import CameraControls from 'camera-controls';
import * as THREE from 'three';
import { setting, useSetting, type Settings } from '@/settings/store';

export type MouseStyle = Settings['viewport.mouseStyle'];
export type DragAction = 'orbit' | 'pan' | 'zoom' | null;
interface Keys { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

const NO_KEYS: Keys = { ctrlKey: false, metaKey: false, shiftKey: false };

export const MOUSE_STYLES: { value: MouseStyle; label: string; summary: string; mouse: [string, string][] }[] = [
  {
    value: 'steve', label: 'STEVE', summary: 'Left-drag orbits, middle or right-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Left drag'], ['Pan', 'Right or middle drag'], ['Zoom to cursor', 'Scroll']],
  },
  {
    value: 'solidworks', label: 'SOLIDWORKS', summary: 'Middle-drag orbits, Ctrl+middle-drag pans, Shift+middle-drag or the wheel zooms.',
    mouse: [['Orbit', 'Middle drag'], ['Pan', 'Ctrl + middle drag'], ['Zoom to cursor', 'Scroll or Shift + middle drag']],
  },
  {
    value: 'fusion', label: 'Fusion', summary: 'Shift+middle-drag orbits, middle-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Shift + middle drag'], ['Pan', 'Middle drag'], ['Zoom to cursor', 'Scroll']],
  },
  {
    value: 'onshape', label: 'Onshape', summary: 'Right-drag orbits, middle or Ctrl+right-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Right drag'], ['Pan', 'Middle or Ctrl + right drag'], ['Zoom to cursor', 'Scroll']],
  },
];

export const mouseStyleInfo = (style: MouseStyle) => MOUSE_STYLES.find((item) => item.value === style) ?? MOUSE_STYLES[0];

/** What dragging with `button` (0 left, 1 middle, 2 right) and these keys does in `style`; null: nothing (it selects or draws). */
export function dragAction(style: MouseStyle, button: number, keys: Keys, sketching: boolean): DragAction {
  const ctrl = keys.ctrlKey || keys.metaKey;  // ⌘ on macOS, as for selection.
  switch (style) {
    case 'solidworks': return button === 1 ? (ctrl ? 'pan' : keys.shiftKey ? 'zoom' : 'orbit') : null;
    case 'fusion': return button === 1 ? (keys.shiftKey ? 'orbit' : 'pan') : null;
    case 'onshape': return button === 1 ? 'pan' : button === 2 ? (ctrl ? 'pan' : 'orbit') : null;
    default:
      if (button === 0) return sketching ? null : 'orbit';
      if (button === 1) return 'pan';
      if (button === 2) return sketching ? 'orbit' : 'pan';
      return null;
  }
}

let sketching = false;

/** What a drag starting with this pointer event does in the main viewport, now. */
export const mouseDragAction = (event: Keys & { button: number }) => dragAction(setting('viewport.mouseStyle'), event.button, event, sketching);

/** Sets camera-controls' buttons for the chosen style, with the keys held as a drag starts (none: the plain mapping). */
export function applyMouseStyle(controls: CameraControls, keys: Keys = NO_KEYS) {
  const A = CameraControls.ACTION;
  const ortho = controls.camera instanceof THREE.OrthographicCamera;
  const style = setting('viewport.mouseStyle');
  const action = (button: number) => {
    const drag = dragAction(style, button, keys, sketching);
    return drag === 'orbit' ? A.ROTATE : drag === 'pan' ? A.TRUCK : drag === 'zoom' ? (ortho ? A.ZOOM : A.DOLLY) : A.NONE;
  };
  controls.mouseButtons.left = action(0);
  controls.mouseButtons.middle = action(1);
  controls.mouseButtons.right = action(2);
  controls.mouseButtons.wheel = ortho ? A.ZOOM : A.DOLLY;
}

/** Entering or leaving a sketch: the left button draws there. */
export function setSketchNavigation(controls: CameraControls | null, on: boolean) {
  sketching = on;
  if (controls) applyMouseStyle(controls);
}

/**
 * The style's plain buttons for three's OrbitControls (the preview viewers); STEVE's keeps the previews' own mapping.
 * OrbitControls turns a pan into an orbit (and an orbit into a pan) while Ctrl, ⌘ or Shift is held, which gives Fusion's
 * Shift+middle orbit, SOLIDWORKS' Ctrl+middle pan and Onshape's Ctrl+right pan.
 */
const NONE = -1 as number as THREE.MOUSE;
const ORBIT_CONTROLS_BUTTONS: Record<MouseStyle, { LEFT: THREE.MOUSE; MIDDLE: THREE.MOUSE; RIGHT: THREE.MOUSE }> = {
  steve: { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN },
  solidworks: { LEFT: NONE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: NONE },
  fusion: { LEFT: NONE, MIDDLE: THREE.MOUSE.PAN, RIGHT: NONE },
  onshape: { LEFT: NONE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE },
};

/** The preview viewers' OrbitControls buttons, following the setting. */
export const useOrbitControlsButtons = () => ORBIT_CONTROLS_BUTTONS[useSetting('viewport.mouseStyle')] ?? ORBIT_CONTROLS_BUTTONS.steve;
