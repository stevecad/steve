import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { House, RotateCcw, RotateCw } from 'lucide-react';
import { Tip } from '@/ui';
import { set, useApp } from '@/state/store';
import { viewer } from './viewer';
import styles from './ViewCube.module.css';

type V = [number, number, number];
const SIZE = 66;
const H = SIZE / 2;

const FACES: { name: string; n: V; r: V; u: V }[] = [
  { name: 'Top', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { name: 'Bottom', n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
  { name: 'Front', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { name: 'Back', n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
  { name: 'Right', n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] },
  { name: 'Left', n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
];

const faceMatrix = ({ n, r, u }: { n: V; r: V; u: V }) =>
  `matrix3d(${r[0]},${r[1]},${r[2]},0,${-u[0]},${-u[1]},${-u[2]},0,${n[0]},${n[1]},${n[2]},0,${n[0] * H},${n[1] * H},${n[2] * H},1)`;

const cellDirection = (face: (typeof FACES)[number], col: number, row: number): V => {
  const i = col - 1, j = 1 - row;
  return [0, 1, 2].map((k) => face.n[k] + i * face.r[k] + j * face.u[k]) as V;
};
const keyOf = (v: V) => v.map((c) => Math.sign(Math.round(c))).join(',');

const LABELS: Record<string, string> = {};
for (const face of FACES) LABELS[keyOf(face.n)] = face.name;

/** Orientation cube synchronized with the camera; click faces, edges or corners to reorient. */
export default function ViewCube() {
  const cube = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; id: number; active: boolean } | null>(null);

  // Dragging the cube orbits the camera, like dragging in the viewport; a plain click still picks a view.
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId, active: false };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    const controls = viewer.controls;
    if (!state || state.id !== event.pointerId || !controls) return;
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (!state.active) {
      if (Math.hypot(dx, dy) < 3) return;
      state.active = true;
      setDragging(true);
      setHover(null);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      viewer.autoFramed = false;
      set({ view: null });
    }
    const speed = Math.PI / 120;
    viewer.orbit(-dx * speed, -dy * speed);
    state.x = event.clientX;
    state.y = event.clientY;
    viewer.invalidate();
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (drag.current?.active) (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragging(false);
  };
  const view = useApp((state) => state.view);
  const hasModel = useApp((state) => !!state.displayed);

  useEffect(() => viewer.onCamera((camera) => {
    if (!cube.current) return;
    const e = camera.matrixWorldInverse.elements;
    // Three's view rotation, with Y flipped into CSS's downward axis.
    const m = [e[0], -e[1], e[2], 0, e[4], -e[5], e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1];
    cube.current.style.transform = `matrix3d(${m.join(',')})`;
  }), []);

  const activeKey = view && view !== 'iso' ? keyOf(FACES.find((face) => face.name.toLowerCase() === view)?.n ?? [9, 9, 9]) : null;

  return (
    <div className={styles.wrap} data-disabled={!hasModel || undefined} aria-label="View cube">
      <div className={styles.stage} data-dragging={dragging || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className={styles.shadow} />
        <div ref={cube} className={styles.cube}>
          {FACES.map((face) => (
            <div key={face.name} className={styles.face} style={{ transform: faceMatrix(face), width: SIZE, height: SIZE, left: -H, top: -H }} data-active={activeKey === keyOf(face.n) || undefined}>
              <span className={styles.label}>{face.name}</span>
              <div className={styles.grid}>
                {Array.from({ length: 9 }, (_, index) => {
                  const col = index % 3, row = Math.floor(index / 3);
                  const direction = cellDirection(face, col, row);
                  const key = keyOf(direction);
                  return (
                    <button
                      key={index}
                      type="button"
                      className={styles.cell}
                      data-kind={col === 1 && row === 1 ? 'face' : col === 1 || row === 1 ? 'edge' : 'corner'}
                      data-hover={hover === key || undefined}
                      aria-label={LABELS[key] ? `${LABELS[key]} view` : 'Rotate view'}
                      onPointerEnter={() => setHover(key)}
                      onPointerLeave={() => setHover((current) => (current === key ? null : current))}
                      onClick={() => viewer.lookFrom(new THREE.Vector3(...direction))}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.controls}>
        <Tip label="Home" description="Isometric view, fit to model." shortcut="0" side="left"><button type="button" className={styles.control} onClick={() => viewer.setView('iso')} aria-label="Home view"><House size={13} /></button></Tip>
        <Tip label="Orbit left 90°" side="left"><button type="button" className={styles.control} onClick={() => viewer.rotateBy(-90, 0)} aria-label="Orbit left"><RotateCcw size={13} /></button></Tip>
        <Tip label="Orbit right 90°" side="left"><button type="button" className={styles.control} onClick={() => viewer.rotateBy(90, 0)} aria-label="Orbit right"><RotateCw size={13} /></button></Tip>
      </div>
    </div>
  );
}
