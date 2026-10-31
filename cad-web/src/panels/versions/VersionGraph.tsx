import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Eye, GitMerge } from 'lucide-react';
import { ContextMenu } from '@/ui';
import type { GraphNode } from '@/lib/branches';
import { relativeTime } from '@/lib/format';
import { whoLabel } from '@/teams/attribution';
import styles from './Versions.module.css';

const ROW = 46;
const LANE = 16;
const PAD = 14;

export interface GraphProps {
  nodes: GraphNode[];
  lanes: string[];
  colorOf: (branch: string) => string;
  heads: Set<string>;
  current: string | null;
  selected: string | null;
  onSelect: (node: GraphNode) => void;
  /** Right-click menu items for a row. */
  menu?: (node: GraphNode) => ReactNode;
  /** The revision shown read-only in the viewport. */
  viewing?: string | null;
}

/** Commit graph: one lane per branch, curves for branch-offs and merges, newest at the top. */
export default function VersionGraph({ nodes, lanes, colorOf, heads, current, selected, onSelect, menu, viewing }: GraphProps) {
  const row = new Map(nodes.map((node, index) => [node.key, index]));
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const laneOf = (branch: string) => Math.max(0, lanes.indexOf(branch));
  const x = (branch: string) => PAD + laneOf(branch) * LANE;
  const y = (index: number) => index * ROW + ROW / 2;
  const width = PAD * 2 + Math.max(0, lanes.length - 1) * LANE;
  const height = nodes.length * ROW;

  const edges: { key: string; d: string; color: string; dashed: boolean }[] = [];
  nodes.forEach((node, index) => {
    node.parents.forEach((parentKey, parentIndex) => {
      const target = row.get(parentKey);
      const parent = byKey.get(parentKey);
      if (target === undefined || !parent) {
        // Parent beyond the loaded window: trail off downward.
        edges.push({ key: `${node.key}>${parentKey}`, d: `M ${x(node.branch)} ${y(index)} L ${x(node.branch)} ${height}`, color: colorOf(node.branch), dashed: true });
        return;
      }
      const x1 = x(node.branch), y1 = y(index), x2 = x(parent.branch), y2 = y(target);
      const color = colorOf(parentIndex === 0 ? node.branch : parent.branch);
      if (x1 === x2) edges.push({ key: `${node.key}>${parentKey}`, d: `M ${x1} ${y1} L ${x2} ${y2}`, color, dashed: false });
      else {
        // Leave the child's lane smoothly, then run down the parent's lane.
        const bend = Math.min(y1 + ROW * 0.9, y2);
        edges.push({ key: `${node.key}>${parentKey}`, d: `M ${x1} ${y1} C ${x1} ${bend - ROW * 0.2}, ${x2} ${y1 + ROW * 0.25}, ${x2} ${bend} L ${x2} ${y2}`, color: colorOf(node.branch === 'main' ? parent.branch : node.branch), dashed: false });
      }
    });
  });

  return (
    <div className={styles.graph} style={{ height }}>
      <svg className={styles.graphSvg} width={width} height={height} aria-hidden="true">
        {edges.map((edge, index) => (
          <motion.path key={edge.key} d={edge.d} stroke={edge.color} strokeWidth={2} fill="none" strokeLinecap="round" strokeDasharray={edge.dashed ? '3 4' : undefined}
            initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: edge.dashed ? 0.5 : 0.85 }} transition={{ duration: 0.5, delay: Math.min(index * 0.015, 0.4), ease: [0.16, 1, 0.3, 1] }} />
        ))}
        {nodes.map((node, index) => {
          const color = colorOf(node.branch);
          const head = heads.has(node.key);
          const isCurrent = node.key === current;
          return (
            <motion.g key={node.key} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 26, delay: Math.min(index * 0.015, 0.4) }} style={{ transformOrigin: `${x(node.branch)}px ${y(index)}px` }}>
              {isCurrent && <circle cx={x(node.branch)} cy={y(index)} r={10} fill="none" stroke={color} strokeOpacity={0.45} strokeWidth={2} className={styles.pulse} />}
              {node.kind === 'merge'
                ? <><circle cx={x(node.branch)} cy={y(index)} r={6.5} fill="var(--bg-1)" stroke={color} strokeWidth={2} /><circle cx={x(node.branch)} cy={y(index)} r={2.6} fill={color} /></>
                : <circle cx={x(node.branch)} cy={y(index)} r={head ? 5.5 : 4.5} fill={head ? color : 'var(--bg-1)'} stroke={color} strokeWidth={2} />}
            </motion.g>
          );
        })}
      </svg>
      {nodes.map((node, index) => {
        const row = (
          <button
            key={node.key}
            type="button"
            className={styles.node}
            style={{ top: index * ROW, height: ROW, paddingLeft: width + 4 }}
            data-selected={selected === node.key || undefined}
            data-current={current === node.key || undefined}
            data-viewing={viewing === node.key || undefined}
            onClick={() => onSelect(node)}
          >
            <span className={styles.nodeTitle}>
              {node.kind === 'merge' && <GitMerge size={12} />}
              <span className={styles.nodeMessage}>{node.message}</span>
              {viewing === node.key && <Eye size={12} className={styles.viewingIcon} aria-label="Shown in the viewport" />}
            </span>
            <span className={styles.nodeMeta}>
              <span className={styles.nodeBranch} style={{ color: colorOf(node.branch) }}>{node.branch}</span>
              <span>r{node.revision}</span>
              <span>{relativeTime(node.recorded_at)}</span>
              {node.by && <span className={styles.nodeBy} title={node.by.note}>{whoLabel(node.by)}</span>}
              {heads.has(node.key) && <span className={styles.headTag} style={{ borderColor: colorOf(node.branch), color: colorOf(node.branch) }}>head</span>}
            </span>
          </button>
        );
        return menu ? <ContextMenu key={node.key} trigger={row}>{menu(node)}</ContextMenu> : row;
            })}
    </div>
  );
}
