/**
 * Drag to move (Motion tab): grab a moving part and it turns or slides only the way its joint allows, within
 * its limits; a geared part back-drives its coupling, so the whole train follows. Grabbing a grounded part
 * orbits as usual. A press without a drag selects the part and its joint. Alt on a cylindrical joint slides it.
 * The same on a share page whose owner let visitors move the mechanism.
 */
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { get, set, toast } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { followerHeld, instanceMotions, jointOfInstance, turns, type MotionJoint } from './kinematics';
import { instanceOfNode } from './instances';
import { selectJoint, setJoint, useMotion } from './state';

const SLOP = 3;

interface Drag {
  pointer: number; x: number; y: number; moved: boolean; node: string;
  joint: MotionJoint; origin: THREE.Vector3; axis: THREE.Vector3; turning: boolean; start: number;
  u: THREE.Vector3; v: THREE.Vector3; prev: number | null; turned: number; anchor: number | null; perPixel: number;
  /** A follower this drag can't move: the couplings to move instead (null: it moves). */
  held: string[] | null;
}

/** "a", "a or b", "a, b or c". */
const either = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '');

/**
 * `allowed`: whether a press may move the mechanism now (the editor: its Motion tab, MotionLayer). `shared`: on a share
 * page (web/src/share), where there is no Dock to open.
 */
export function useMotionDrag(allowed: () => boolean, shared = false) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const enabled = () => allowed() && !!useMotion.getState().kinematics;
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let drag: Drag | null = null;

    const rayAt = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, viewer.camera!);
      return { ray: raycaster.ray.clone(), ndc, rect };
    };

    /** The pointer's angle about the joint axis, on the plane through its origin; null when the plane is edge-on. */
    const angleAt = (ray: THREE.Ray, d: Drag) => {
      if (Math.abs(ray.direction.dot(d.axis)) < 0.1) return null;
      const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(d.axis, d.origin), new THREE.Vector3());
      if (!hit) return null;
      hit.sub(d.origin);
      return Math.atan2(hit.dot(d.v), hit.dot(d.u));
    };

    /** Where along the joint axis the pointer's ray passes closest; null when looking straight down the axis. */
    const travelAt = (ray: THREE.Ray, d: Drag) => {
      const w0 = d.origin.clone().sub(ray.origin);
      const b = d.axis.dot(ray.direction);
      const denominator = 1 - b * b;
      if (denominator < 1e-3) return null;
      return (b * ray.direction.dot(w0) - d.axis.dot(w0)) / denominator;
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== element || !enabled() || !viewer.model || !viewer.camera) return;
      const { ndc, rect } = rayAt(event);
      const hit = viewer.model.pick(raycaster, viewer.camera, ndc, { width: rect.width, height: rect.height }, 'component', false, true);
      const instance = hit ? instanceOfNode(hit.pick.node) : null;
      const { kinematics, pose } = useMotion.getState();
      const joint = instance && kinematics ? jointOfInstance(kinematics, instance) : undefined;
      if (!hit || !joint || !kinematics) return;  // A grounded part: orbit as usual.
      event.stopPropagation();
      event.preventDefault();
      // Explode and the pose both place the parts: the share page collapses the explode before the mechanism moves.
      if (shared && get().explode > 0) set({ explode: 0 });
      // The axis where the joint is now: it rides on its parent.
      const parent = instanceMotions(kinematics, pose).get(joint.parent) ?? new THREE.Matrix4();
      const origin = new THREE.Vector3().fromArray(joint.origin).applyMatrix4(parent);
      const axis = new THREE.Vector3().fromArray(joint.axis).transformDirection(parent).normalize();
      const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
      const v = new THREE.Vector3().crossVectors(axis, u);
      const live = pose[joint.name] ?? { value: joint.value, slide: joint.slide ?? 0 };
      const turning = turns(joint) && !(joint.type === 'cylindrical' && event.altKey);
      // mm per pixel at the grabbed point, for sliding when the axis points at the camera.
      const camera = viewer.camera;
      const distance = camera instanceof THREE.PerspectiveCamera ? camera.position.distanceTo(hit.point) : 1;
      const perPixel = camera instanceof THREE.PerspectiveCamera
        ? (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / rect.height
        : (camera.top - camera.bottom) / camera.zoom / rect.height;
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, node: hit.pick.node, joint, origin, axis, turning,
        start: turning ? live.value : joint.type === 'cylindrical' ? live.slide : live.value, u, v, prev: null, turned: 0, anchor: null, perPixel,
        held: followerHeld(kinematics, joint, turning || joint.type !== 'cylindrical' ? 'turn' : 'travel') };
      const ray = rayAt(event).ray;
      drag.prev = turning ? angleAt(ray, drag) : null;
      drag.anchor = turning ? null : travelAt(ray, drag);
      if (get().hover) set({ hover: null, hoverAlso: [] });
      window.addEventListener('pointermove', onMove, { capture: true });
      window.addEventListener('pointerup', onUp, { capture: true });
    };

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      event.stopPropagation();
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < SLOP) return;
      if (drag.held) {
        // A follower of several couplings moves only through them: say which, once per drag.
        if (!drag.moved) {
          toast('info', `${drag.joint.name} follows ${drag.held.join(', ') || 'its couplings'}`,
            drag.held.length ? `Move ${either(drag.held)} to move it.` : 'Gear it with a coupling to move it.');
        }
        drag.moved = true;
        return;
      }
      drag.moved = true;
      element.style.cursor = 'grabbing';
      const ray = rayAt(event).ray;
      let value: number;
      if (drag.turning) {
        const angle = angleAt(ray, drag);
        if (angle === null || drag.prev === null) drag.turned = THREE.MathUtils.degToRad((event.clientX - drag.x) * 0.6);
        else {
          drag.turned += Math.atan2(Math.sin(angle - drag.prev), Math.cos(angle - drag.prev));
          drag.prev = angle;
        }
        // Shift snaps to whole degrees.
        value = drag.start + THREE.MathUtils.radToDeg(drag.turned);
        value = event.shiftKey ? Math.round(value) : Math.round(value * 10) / 10;
      } else {
        const t = travelAt(ray, drag);
        const delta = t !== null && drag.anchor !== null ? t - drag.anchor : (drag.y - event.clientY) * drag.perPixel;
        value = Math.round((drag.start + delta) * 100) / 100;
      }
      setJoint(drag.joint.name, drag.turning || drag.joint.type !== 'cylindrical' ? { value } : { slide: value });
    };

    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      if (element.style.cursor === 'grabbing') element.style.cursor = '';
      if (!drag.moved) {
        // A click: select the part and show its joint.
        if (shared) set({ selection: [{ kind: 'component', node: viewer.model?.instanceNode(drag.node) ?? drag.node }] });   // The placed part, as the page picks.
        else set({ selection: [{ kind: 'component', node: drag.node }], dockOpen: true, dockTab: 'properties' });
        selectJoint(drag.joint.name);
      }
      drag = null;
    };

    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
    };
  }, [gl, allowed, shared]);
}
