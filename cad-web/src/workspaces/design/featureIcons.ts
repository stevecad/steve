import {
  Blend, Box, Circle, CircleDot, Combine, Copy, Cylinder, FlipHorizontal2, Grip, Layers2, Move3d, MousePointer2, PenLine,
  Puzzle, Rotate3d, Route, Spline, Square, SquareDashed, Type,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { OriginIcon, PocketIcon } from '@/icons/cad';

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

const BY_OPERATION: Record<string, Icon> = {
  plane: OriginIcon, Workplane: OriginIcon, workplane: SquareDashed, transformed: SquareDashed, copyWorkplane: SquareDashed,
  rectangle: Square, rect: Square, circle: Circle, ellipse: Circle, polygon: Square, polyline: PenLine, lineTo: PenLine, line: PenLine,
  hLine: PenLine, vLine: PenLine, moveTo: PenLine, close: PenLine, spline: Spline, threePointArc: Spline, radiusArc: Spline,
  sagittaArc: Spline, tangentArcPoint: Spline, slot2D: Square, offset2D: SquareDashed, sketch: PenLine, text: Type,
  extrusion: Layers2, extrude: Layers2, twistExtrude: Layers2, cutBlind: PocketIcon as Icon, cutThruAll: PocketIcon as Icon,
  revolve: Rotate3d, loft: Blend, sweep: Route, shell: SquareDashed, fillet: Blend, chamfer: Blend,
  holes: CircleDot, hole: CircleDot, cboreHole: CircleDot, cskHole: CircleDot,
  union: Combine, cut: Combine, intersect: Combine, combine: Combine, mirror: FlipHorizontal2, mirrorX: FlipHorizontal2, mirrorY: FlipHorizontal2,
  translate: Move3d, rotate: Rotate3d, rotateAboutCenter: Rotate3d,
  face: MousePointer2, faces: MousePointer2, edges: MousePointer2, vertices: MousePointer2, solids: MousePointer2, wires: MousePointer2,
  points: Grip, pushPoints: Grip, rarray: Grip, polarArray: Grip, box: Box, cylinder: Cylinder, sphere: Circle, wedge: Box,
  each: Copy, eachpoint: Copy,
};

export function featureIcon(operation: string, category: string): Icon {
  return BY_OPERATION[operation] ?? (category === 'opaque' ? Puzzle : category === 'sketch' ? PenLine : category === 'reference' ? MousePointer2 : Layers2);
}
