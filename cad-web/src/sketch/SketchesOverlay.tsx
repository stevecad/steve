import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { useApp } from '@/state/store';
import { profileShapes, sample } from './geometry';
import type { Entity } from './model';
import { useSketch } from './session';
import { sketchPlane } from './actions';
import { installSketchPicking, positionItems, shownSketches, sketchPoints, useSketchPicks } from './picking';
import { useFeatureDialog } from '@/modeling/dialog';
import { SPECS } from '@/modeling/specs';

/** The model's own hover colors (viewport/model.ts), so a hovered sketch reads like a hovered face or edge. */
const HOVER = { line: '#9fd7ff', fill: '#8fd0ff' };

/** The type of the dialog field waiting for a pick in the view, if any. */
const targetType = (s: { open: boolean; kind: string; target: string | null }) =>
  (s.open && s.target ? SPECS[s.kind]?.fields.find((f) => f.key === s.target)?.type ?? null : null);

/** Sketches shown in 3D between edits: ones no feature uses yet, the one selected in the tree and the ones picked in the view. */
export default function SketchesOverlay() {
  const doc = useApp((s) => s.modeling);
  const active = useApp((s) => s.activeFeature);
  const visibility = useApp((s) => s.sketchVisibility);
  const theme = useApp((s) => s.theme);
  const editing = useSketch((s) => s.active);
  const current = useSketch((s) => s.featureId);
  // With the Project tool, the other sketches are shown so their curves can be picked.
  const projecting = useSketch((s) => s.active && s.tool === 'project');
  const hot = useSketch((s) => s.projectHover);
  const picked = useSketchPicks((s) => s.picked);
  const hovered = useSketchPicks((s) => (s.hover && !s.hover.point && !s.hover.line ? s.hover.sketch : null));
  const hoveredPoint = useSketchPicks((s) => s.hover?.point ?? null);
  const hoveredLine = useSketchPicks((s) => s.hover?.line ?? null);
  // Hole positions being picked: every sketch point is a target, and the ones already in the list are marked.
  const holePositions = useFeatureDialog((s) => (targetType(s) === 'points' ? s.values[s.target!] ?? '' : null));
  const boundarySketches = useFeatureDialog((s) => !!(s.open && s.target && SPECS[s.kind]?.fields.find((f) => f.key === s.target)?.sketches));
  // An axis being picked: every sketch shows, and the line already chosen ("sketch_1.l3") is marked.
  const axisLine = useFeatureDialog((s) => {
    if (targetType(s) !== 'axis') return null;
    try { return String(JSON.parse((s.values[s.target!] ?? '').replace(/'/g, '"'))); } catch { return ''; }
  });
  const invalidate = useThree((s) => s.invalidate);
  useEffect(installSketchPicking, []);

  const objects = useMemo(() => {
    if (!doc?.canonical || (editing && !projecting)) return [];
    const out: THREE.Object3D[] = [];
    const wanted = holePositions !== null && !projecting;
    const chosen = new Set(wanted ? positionItems(holePositions).map((item) => { try { return String(JSON.parse(item.replace(/'/g, '"'))); } catch { return ''; } }) : []);
    const axis = axisLine !== null && !projecting;
    const shown = projecting ? doc.features.filter((f) => f.kind === 'sketch' && f.id && f.document && f.id !== current) : shownSketches(doc, active, visibility, picked, wanted || axis || boundarySketches);
    for (const feature of shown) {
      if (!feature.id || !feature.document) continue;
      const selected = !projecting && (active === feature.id || picked.includes(feature.id));
      const hover = !projecting && !selected && hovered === feature.id;
      const plane = sketchPlane(feature, doc);
      if (!plane) continue;
      const matrix = new THREE.Matrix4().makeBasis(plane.x, plane.y, plane.normal).setPosition(plane.origin);
      const positions: number[] = [];
      for (const entity of feature.document.entities as unknown as Entity[]) {
        if (entity.type === 'point' || entity.type === 'projection') continue;
        const pts = sample(entity, 48);
        for (let i = 1; i < pts.length; i++) positions.push(pts[i - 1][0], pts[i - 1][1], 0, pts[i][0], pts[i][1], 0);
      }
      const color = selected ? (theme === 'light' ? '#1d6fd6' : '#63b4ff') : hover ? HOVER.line : theme === 'light' ? '#56606a' : '#9aa6ae';
      // The sketch's points as dots (hole centres to be); while hole positions are picked, circle centres and line ends too.
      const marks = sketchPoints(feature.id, feature.document.entities as unknown as Entity[]).filter((p) => p.kind === 'point' || wanted);
      for (const [kind, size, tint] of [['rest', 5, color], ['chosen', 8, theme === 'light' ? '#1d6fd6' : '#63b4ff'], ['hover', 9, HOVER.line]] as const) {
        const group = marks.filter((p) => (p.ref === hoveredPoint ? 'hover' : chosen.has(p.ref) ? 'chosen' : 'rest') === kind);
        if (!group.length) continue;
        const dots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(group.flatMap((p) => [p.at[0], p.at[1], 0]), 3)),
          new THREE.PointsMaterial({ color: tint, size, sizeAttenuation: false, transparent: true, depthTest: kind === 'rest' && !selected && !hover }));
        dots.applyMatrix4(matrix);
        dots.renderOrder = 13;
        dots.frustumCulled = false;
        out.push(dots);
      }
      if (!positions.length) continue;
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), new LineMaterial({ color, linewidth: selected ? 2 : hover ? 3 : 1.3, transparent: true, opacity: selected || hover ? 1 : 0.8, depthTest: !selected && !hover, worldUnits: false }));
      line.applyMatrix4(matrix);
      line.renderOrder = 12;
      line.frustumCulled = false;
      out.push(line);
      const entities = feature.document.entities as unknown as Entity[];
      const glows: [Entity | undefined, string, number][] = [
        [hot?.sketch === feature.id ? entities.find((e) => e.id === hot.entity) : undefined, theme === 'light' ? '#14805e' : '#5fcfa5', 3.5],
        // While an axis is picked: the chosen sketch line marked, the one under the pointer lit as a hovered edge is.
        [axis ? entities.find((e) => e.type === 'line' && `${feature.id}.${e.id}` === axisLine) : undefined, theme === 'light' ? '#1d6fd6' : '#63b4ff', 3],
        [axis ? entities.find((e) => e.type === 'line' && `${feature.id}.${e.id}` === hoveredLine) : undefined, HOVER.line, 3.5],
      ];
      for (const [target, glowColor, width] of glows) {
        if (!target) continue;
        const pts = sample(target, 64), segs: number[] = [];
        for (let i = 1; i < pts.length; i++) segs.push(pts[i - 1][0], pts[i - 1][1], 0, pts[i][0], pts[i][1], 0);
        const glow = new LineSegments2(new LineSegmentsGeometry().setPositions(segs), new LineMaterial({ color: glowColor, linewidth: width, transparent: true, depthTest: false, worldUnits: false }));
        glow.applyMatrix4(matrix);
        glow.renderOrder = 14;
        glow.frustumCulled = false;
        out.push(glow);
      }
      // Closed regions filled in, so it's clear what the sketch will extrude.
      const shapes = profileShapes((feature.document.entities as unknown as Entity[]).filter((e) => !e.construction));
      if (shapes.length) {
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shapes, 32), new THREE.MeshBasicMaterial({ color: hover ? HOVER.fill : color, transparent: true, opacity: selected ? 0.28 : hover ? 0.2 : 0.07, side: THREE.DoubleSide, depthWrite: false, depthTest: !selected && !hover }));
        fill.applyMatrix4(matrix);
        fill.renderOrder = 11;
        fill.frustumCulled = false;
        out.push(fill);
      }
    }
    return out;
  }, [doc, active, visibility, theme, editing, projecting, current, hot, picked, hovered, hoveredPoint, holePositions, hoveredLine, axisLine, boundarySketches]);

  useEffect(() => { invalidate(); return () => objects.forEach((o) => { (o as THREE.Mesh).geometry.dispose(); ((o as THREE.Mesh).material as THREE.Material).dispose(); }); }, [objects, invalidate]);
  return <>{objects.map((o) => <primitive key={o.uuid} object={o} />)}</>;
}
