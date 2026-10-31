/**
 * The Animation tab in the view (motion/sceneAnimation.ts): the model at the strip's time, also when a new build's model
 * replaces the last, and the Shot: the scene's camera view as an inset over the corner, drawn from a scene of its own
 * that holds only the model (no grid, gizmos or highlights) with the view's environment lighting.
 */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { animationShown } from '@/state/designTab';
import { applySceneTime, useSceneAnimation } from './sceneAnimation';

/** The inset's place in the view (CSS pixels from the right, and from the bottom clear of the view tools bar), shared
 *  with its frame (SceneAnimationStrip). */
export const SHOT_MARGIN = 16;
export const SHOT_BOTTOM = 72;
export const shotWidth = (viewWidth: number) => Math.min(viewWidth * 0.34, 440);

export default function SceneAnimationLayer() {
  const shown = useApp(animationShown);
  const version = useApp((state) => state.modelVersion);
  const shot = useSceneAnimation((state) => state.shot);
  const through = useSceneAnimation((state) => state.through);
  const hasCamera = !!viewer.model?.shotCamera;
  useEffect(() => { if (shown) applySceneTime(); }, [shown, version]);
  return shown && hasCamera && (shot || through) ? <ShotInset whole={through} /> : null;
}

/** The scene's camera view: an inset in the corner, or (`whole`) the whole view, letterboxed to the shot's frame. */
function ShotInset({ whole }: { whole: boolean }) {
  const { gl, scene, camera, size } = useThree();
  const inset = useMemo(() => {
    const own = new THREE.Scene();
    own.background = new THREE.Color(0x0b0d12);
    own.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1, 2);
    own.add(sun);
    return own;
  }, []);
  useEffect(() => () => { gl.setScissorTest(false); }, [gl]);
  // Priority 1: this draws the frame, the view first and the inset over it.
  useFrame(() => {
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    const model = viewer.model, shot = model?.shotCamera;
    if (!whole || !model || !shot) gl.render(scene, camera);
    if (!model || !shot) return;
    const aspect = shot.aspect || 16 / 9;
    let width = shotWidth(size.width), height = width / aspect, x = size.width - SHOT_MARGIN - width, y = SHOT_BOTTOM;
    if (whole) {   // the shot's frame, centred; the rest dark, as a camera's viewfinder
      width = Math.min(size.width, size.height * aspect); height = width / aspect;
      x = (size.width - width) / 2; y = (size.height - height) / 2;
      const color = gl.getClearColor(new THREE.Color()), alpha = gl.getClearAlpha();
      gl.setClearColor(0x05070a, 1); gl.clear(); gl.setClearColor(color, alpha);
    }
    const lights = inset.children.filter((child) => !(child === model.root));
    // The model keeps its own parent (the view's scene): the inset only draws it, with its own lights.
    inset.children = [...lights, model.root];
    inset.environment = scene.environment;
    model.root.updateMatrixWorld(true);
    gl.setViewport(x, y, width, height);
    gl.setScissor(x, y, width, height);
    gl.setScissorTest(true);
    gl.render(inset, shot);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    inset.children = lights;
  }, 1);
  return null;
}
