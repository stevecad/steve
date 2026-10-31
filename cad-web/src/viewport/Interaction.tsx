import { useSketch } from '@/sketch/session';
import { chooseFace, choosePlane } from '@/sketch/actions';
import { pickPlane } from '@/sketch/PlaneChooser';
import { clearSketchHover, clickSketch, hoverSketch } from '@/sketch/picking';
import { pickIntoDialog } from '@/modeling/dialog';
import { pickIntoFrames } from '@/workspaces/manufacture/fromPart';
import { clickEngraveCurve, hoverEngraveCurve } from '@/workspaces/manufacture/cam/state';
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { get, samePick, set, useCursor, type Pick } from '@/state/store';
import { viewer } from './viewer';
import { mouseDragAction } from './mouseStyle';
import { addMeasurePick } from './measure';
import { jointPick, jointPicking } from '@/motion/jointTool';
import { explodeToolPick } from '@/motion/explodeTool';
import { instanceOfNode, openPlacement } from '@/placement/placement';
import { pickAllowed } from './pickGuard';
import { holdClick, prepareSelection } from './selectionPrep';
import { presenting } from '@/present/state';

const CLICK_SLOP = 4;
/** Pressing and holding still this long lists everything under the pointer (Select other). */
const HOLD_MS = 500;

interface Modifiers { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** Pointer handling on the canvas: pre-highlight, selection, orbit pivot and context menu. */
export default function Interaction() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let pending: PointerEvent | null = null;
    let frame = 0;
    let down: { x: number; y: number; button: number; id: number } | null = null;
    let holdTimer = 0;
    const cancelHold = () => { window.clearTimeout(holdTimer); holdTimer = 0; };

    const pickAt = (event: { clientX: number; clientY: number }) => {
      const model = viewer.model;
      const camera = viewer.camera;
      if (!model || !camera) return null;
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const state = get();
      const joint = jointPicking();
      // Clicks pick what's under the pointer (sketches, vertices, edges, faces), in designs too; a double-click picks the
      // whole component. Only the placement tools pick whole components: Place, and the Joint tool choosing a component.
      const placement = joint === 'component' || state.tool === 'place' || state.tool === 'explodeSteps';
      return model.pick(raycaster, camera, ndc, { width: rect.width, height: rect.height }, state.filter, state.tool === 'measure', placement);
    };

    /** What an orbit started here turns about: the model surface under the pointer, else the point under the pointer
     * at the depth of `target` (the current pivot), on the plane facing the camera. */
    const pivotAt = (event: { clientX: number; clientY: number }, target: THREE.Vector3): THREE.Vector3 => {
      const camera = viewer.camera!;
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const surface = viewer.model?.surfacePoint(raycaster, camera, ndc);
      if (surface) return surface.clone();
      raycaster.setFromCamera(ndc, camera);
      const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), target);
      return raycaster.ray.intersectPlane(facing, new THREE.Vector3()) ?? target.clone();
    };

    /** While choosing a sketch plane: the origin plane under the pointer, unless a model face is nearer. */
    const planeAt = (event: { clientX: number; clientY: number }, hit: ReturnType<typeof pickAt>) => {
      if (!useSketch.getState().choosing || !viewer.camera) return null;
      const rect = element.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), viewer.camera);
      const plane = pickPlane(raycaster);
      if (!plane) return null;
      if (hit && raycaster.ray.origin.distanceTo(hit.point) < raycaster.ray.origin.distanceTo(plane.point) - 1e-6) return null;
      return plane.name;
    };

    const updateHover = () => {
      frame = 0;
      const event = pending;
      if (!event) return;
      if (down || viewer.interacting) return;
      // Presentation view only looks: nothing lights up under the pointer.
      if (presenting()) { if (get().hover) set({ hover: null, hoverAlso: [] }); element.style.cursor = ''; return; }
      // While drawing, the model isn't a target; the Project tool picks from it.
      if (useSketch.getState().active && useSketch.getState().tool !== 'project') { if (get().hover) set({ hover: null, hoverAlso: [] }); return; }
      const modelHit = pickAt(event);
      const plane = planeAt(event, modelHit);
      if (useSketch.getState().planeHover !== plane) useSketch.setState({ planeHover: plane });
      const hit = plane ? null : modelHit;
      // While the engrave editor picks sketch curves, a curve under the pointer comes first.
      const onCurve = !plane && hoverEngraveCurve(event, element);
      const onSketch = !plane && !onCurve && hoverSketch(event, element, modelHit);  // A sketch under the pointer comes before faces and edges.
      const rect = element.getBoundingClientRect();
      useCursor.setState({ point: hit ? [hit.point.x, hit.point.y, hit.point.z] : null, screen: [event.clientX - rect.left, event.clientY - rect.top] });
      const candidate = onSketch || onCurve ? null : hit?.pick ?? null;
      // A tool picking one kind of geometry lights only what it can take (pickGuard).
      const refused = !!candidate && !pickAllowed(candidate);
      const next = refused ? null : candidate;
      if (!samePick(next, get().hover) || get().hoverAlso.length) set({ hover: next, hoverAlso: [] });
      if (!viewer.sectionHot) element.style.cursor = refused ? 'not-allowed' : next || plane || onSketch || onCurve ? 'pointer' : '';
    };

    const onMove = (event: PointerEvent) => {
      if (holdTimer && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP) cancelHold();
      pending = event;
      if (!frame) frame = requestAnimationFrame(updateHover);
    };

    const onLeave = () => {
      pending = null;
      useCursor.setState({ point: null, screen: null });
      if (get().hover) set({ hover: null, hoverAlso: [] });
      clearSketchHover();
    };

    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY, button: event.button, id: event.pointerId };
      if (get().contextMenu) set({ contextMenu: null });
      if (get().pickList) set({ pickList: null });
      // Press and hold still with the mouse or pen: Select other, the list of everything under the pointer. On touch a
      // hold is the context menu (phone/longPress), which offers Select other too.
      cancelHold();
      if (event.button === 0 && event.pointerType !== 'touch' && !useSketch.getState().active && !presenting()) {
        const start = down;
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        holdTimer = window.setTimeout(() => {
          holdTimer = 0;
          if (down !== start || !viewer.openPickList(start.x, start.y, additive)) return;
          // The press is over: its release isn't also a click, and the camera stops following the button.
          down = null;
          element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: start.id, pointerType: event.pointerType, bubbles: true }));
          // And whether or not the controls take that cancel as the drag's end, they ignore the pointer until the
          // button is really let go (moving to the list mustn't orbit).
          const controls = viewer.controls;
          if (controls?.enabled) {
            controls.enabled = false;
            const release = (up: PointerEvent) => {
              if (up.pointerId !== start.id) return;
              window.removeEventListener('pointerup', release, true);
              window.removeEventListener('pointercancel', release, true);
              controls.enabled = true;
            };
            window.addEventListener('pointerup', release, true);
            window.addEventListener('pointercancel', release, true);
          }
        }, HOLD_MS);
      }
      // Orbit about the point under the cursor, like desktop CAD: the model surface there (whatever the selection
      // filter), else the point under the cursor at the current pivot's depth (pressing beside the model or in an
      // empty document). A zoom or view change still settling is stopped where it is first: re-pivoting
      // mid-transition would make camera-controls jump. Sketching keeps left clicks for drawing. Which button and keys
      // orbit or pan follows Settings → Navigation's mouse style.
      const drag = event.pointerType !== 'touch' ? mouseDragAction(event) : event.button === 0 ? 'orbit' : null;
      if (drag === 'orbit' && viewer.controls && viewer.camera && !useSketch.getState().active) {
        const controls = viewer.controls;
        if (viewer.moving) controls.stop();
        const point = pivotAt(event, controls.getTarget(new THREE.Vector3(), false));
        controls.setOrbitPoint(point.x, point.y, point.z);
        useCursor.setState({ pivot: [point.x, point.y, point.z] });
      }
      // Panning holds the grabbed point under the cursor (Scene's truck), so note how deep it is.
      viewer.panDepth = null;
      if (drag === 'pan' && viewer.camera) {
        const hit = pickAt(event);
        if (hit) viewer.panDepth = hit.point.clone().sub(viewer.camera.position).dot(viewer.camera.getWorldDirection(new THREE.Vector3()));
      }
      if (get().hover) set({ hover: null, hoverAlso: [] });
      clearSketchHover();
    };

    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      cancelHold();
      viewer.panDepth = null;
      useCursor.setState({ pivot: null });
      if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
      click(event, start.button);
      pending = event;
    };

    /** Selection, measurement or context menu for a click that wasn't a drag. */
    const click = (event: PointerEvent, button: number) => {
      if (useSketch.getState().active) return;  // The sketch layer handles its own input.
      if (presenting()) return;  // Presentation view: the camera only, no selection or menu.
      const modelHit = pickAt(event);
      const plane = button === 0 ? planeAt(event, modelHit) : null;
      if (plane) { choosePlane(plane); return; }
      if (button === 0 && clickEngraveCurve(event, element)) return;
      if (button === 0 && clickSketch(event, element, modelHit)) return;
      const hit = modelHit;
      const pick = hit?.pick ?? null;
      // Face & edge selection is prepared on the first pick (selectionPrep); a click on a part still waiting for it
      // completes when it arrives.
      if (pick && pick.kind !== 'component' && (button === 0 || button === 2) && !prepareSelection()
        && !viewer.model?.topologyFor(pick.mesh) && holdClick(event, button)) return;
      applyPick(pick, button, event);
    };
    viewer.clickAt = click;

    /** What a click on `pick` does (null: on nothing): a tool or dialog taking it, measuring, the context menu, or selecting. */
    const applyPick = (pick: Pick | null, button: number, event: Modifiers) => {
      const state = get();
      if (button === 0 && pick && chooseFace(pick)) return;
      if (button === 0 && pick && pickIntoDialog(pick)) return;
      if (button === 0 && pick && pickIntoFrames(pick)) return;
      if (button === 2) {
        if (pick && !state.selection.some((item) => samePick(item, pick))) set({ selection: [pick] });
        set({ contextMenu: { x: event.clientX, y: event.clientY, pick, onModel: true } });
        return;
      }
      if (button !== 0) return;
      if (state.tool === 'measure') {
        if (pick) addMeasurePick(pick);
        return;
      }
      if ((state.tool === 'joint' || state.tool === 'motion') && jointPick(pick)) return;
      if (state.tool === 'explodeSteps' && explodeToolPick(pick, event.altKey)) return;
      if (state.tool === 'place') { const instance = pick && instanceOfNode(pick.node); if (instance) openPlacement(instance); return; }
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      if (!pick) { if (!additive) set({ selection: [] }); return; }
      if (additive) {
        const exists = state.selection.some((item) => samePick(item, pick));
        set({ selection: exists ? state.selection.filter((item) => !samePick(item, pick)) : [...state.selection, pick] });
      } else set({ selection: [pick] });
    };

    /** Select other: everything under a point, front to back, that the open tool can take. */
    const picksAt = (clientX: number, clientY: number): Pick[] => {
      const model = viewer.model;
      const camera = viewer.camera;
      if (!model || !camera) return [];
      prepareSelection();  // Faces are listed at once; edges and corners once selection is prepared.
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const state = get();
      const placement = jointPicking() === 'component' || state.tool === 'place' || state.tool === 'explodeSteps';
      const filter = placement && state.filter === 'auto' ? 'component' : state.filter;
      return model.pickAll(raycaster, camera, ndc, { width: rect.width, height: rect.height }, filter).map((hit) => hit.pick).filter(pickAllowed);
    };

    viewer.openPickList = (clientX, clientY, additive = false) => {
      if (useSketch.getState().active || presenting()) return false;
      const picks = picksAt(clientX, clientY);
      if (!picks.length) return false;
      set({ contextMenu: null, hover: null, hoverAlso: [], pickList: { x: clientX, y: clientY, picks, additive } });
      return true;
    };
    viewer.choosePick = (pick, additive, at) => applyPick(pick, 0, { clientX: at.x, clientY: at.y, ctrlKey: additive, metaKey: false, shiftKey: false, altKey: false });

    const onDoubleClick = (event: MouseEvent) => {
      if (presenting()) return;
      const hit = pickAt(event);
      if (!hit || hit.pick.kind === 'component') return;
      const owner: Pick = { kind: 'component', node: hit.pick.node };
      set({ selection: [owner] });
    };

    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('dblclick', onDoubleClick);
    element.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelAnimationFrame(frame);
      cancelHold();
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('dblclick', onDoubleClick);
      element.removeEventListener('contextmenu', onContextMenu);
    };
  }, [gl]);

  return null;
}
