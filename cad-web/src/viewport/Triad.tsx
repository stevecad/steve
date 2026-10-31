import { useEffect, useRef } from 'react';
import styles from './Viewport.module.css';
import { viewer } from './viewer';

const AXES = [
  { label: 'X', color: 'var(--axis-x)', v: [1, 0, 0] },
  { label: 'Y', color: 'var(--axis-y)', v: [0, 1, 0] },
  { label: 'Z', color: 'var(--axis-z)', v: [0, 0, 1] },
] as const;
const R = 24;
const C = 34;

/** World axis indicator in the lower-left corner, updated each rendered frame. */
export default function Triad() {
  const svg = useRef<SVGSVGElement>(null);
  const groups = useRef<(SVGGElement | null)[]>([]);
  const lines = useRef<(SVGLineElement | null)[]>([]);
  const texts = useRef<(SVGTextElement | null)[]>([]);

  useEffect(() => viewer.onCamera((camera) => {
    const e = camera.matrixWorldInverse.elements;
    const order = AXES.map((axis, i) => {
      const [x, y, z] = axis.v;
      const vx = e[0] * x + e[4] * y + e[8] * z;
      const vy = e[1] * x + e[5] * y + e[9] * z;
      const vz = e[2] * x + e[6] * y + e[10] * z;
      lines.current[i]?.setAttribute('x2', String(C + vx * R));
      lines.current[i]?.setAttribute('y2', String(C - vy * R));
      texts.current[i]?.setAttribute('x', String(C + vx * (R + 8)));
      texts.current[i]?.setAttribute('y', String(C - vy * (R + 8) + 3.5));
      groups.current[i]?.setAttribute('opacity', String(0.5 + 0.5 * (vz + 1) / 2));
      return { i, vz };
    });
    // Paint axes pointing away from the viewer first.
    for (const { i } of order.sort((a, b) => a.vz - b.vz)) {
      const group = groups.current[i];
      if (group && svg.current) svg.current.appendChild(group);
    }
  }), []);

  return (
    <svg ref={svg} className={styles.triad} width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`} aria-hidden="true">
      <circle cx={C} cy={C} r={2.5} fill="var(--text-3)" />
      {AXES.map((axis, i) => (
        <g key={axis.label} ref={(el) => { groups.current[i] = el; }}>
          <line ref={(el) => { lines.current[i] = el; }} x1={C} y1={C} x2={C} y2={C} stroke={axis.color} strokeWidth={2} strokeLinecap="round" />
          <text ref={(el) => { texts.current[i] = el; }} fill={axis.color} fontSize={10} fontWeight={700} textAnchor="middle">{axis.label}</text>
        </g>
      ))}
    </svg>
  );
}
