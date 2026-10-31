import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useCursor } from '@/state/store';
import SceneCore from './SceneCore';
import Interaction from './Interaction';
import SectionLayer from './SectionLayer';
import MeasureLayer from './MeasureLayer';
import CommentPins from './CommentPins';
import WorkspaceLayer from './WorkspaceLayer';
import SketchLayer from '@/sketch/SketchLayer';
import SketchesOverlay from '@/sketch/SketchesOverlay';
import PlaneChooser from '@/sketch/PlaneChooser';
import ExtrudePreview from '@/modeling/ExtrudePreview';
import MotionLayer from '@/motion/MotionLayer';
import SceneAnimationLayer from '@/motion/SceneAnimationLayer';
import PlacementGizmo from '@/placement/PlacementGizmo';
import MoveGizmo from '@/modeling/MoveGizmo';
import MaterialsLayer from '@/materials/MaterialsLayer';
import AnalysisLayer from '@/workspaces/surface/AnalysisLayer';
import { usePresent } from '@/present/state';

function PivotMarker() {
  const pivot = useCursor((state) => state.pivot);
  const invalidate = useThree((state) => state.invalidate);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 6;
    context.beginPath(); context.arc(32, 32, 22, 0, Math.PI * 2); context.stroke();
    context.fillStyle = '#ffffff';
    context.beginPath(); context.arc(32, 32, 6, 0, Math.PI * 2); context.fill();
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    return map;
  }, []);
  useEffect(() => { invalidate(); }, [pivot, invalidate]);
  if (!pivot) return null;
  return (
    <points position={pivot} renderOrder={50}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0]), 3]} /></bufferGeometry>
      <pointsMaterial map={texture} size={18} sizeAttenuation={false} transparent depthTest={false} color="#8fdcc0" opacity={0.9} />
    </points>
  );
}

/** The app's viewport: the viewer (SceneCore, shared with the share page) and the editing layers over it. Presentation
 * view keeps what the picture shows (materials, a section cut, results, sketches shown in the tree, the mechanism's
 * pose) and drops the editing aids: measurements, comment pins, surface analysis, previews, gizmos, the selected joint and the pivot. */
export default function Scene() {
  const presenting = usePresent((state) => state.active);
  return (
    <>
      <SceneCore />
      <MaterialsLayer />
      <SectionLayer />
      {!presenting && <><MeasureLayer /><CommentPins /><AnalysisLayer /></>}
      <WorkspaceLayer />
      <SketchLayer />
      <SketchesOverlay />
      {!presenting && <><PlaneChooser /><ExtrudePreview /></>}
      <MotionLayer bare={presenting} />
      <SceneAnimationLayer />
      {!presenting && <><PlacementGizmo /><MoveGizmo /></>}
      <Interaction />
      {!presenting && <PivotMarker />}
    </>
  );
}
