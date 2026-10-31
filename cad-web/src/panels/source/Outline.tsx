/**
 * The open file at a glance: its parameters, definitions (sheet rules and form tools) and features in order, or,
 * for a design's main.py, its placements, joints and motion. Click to go there; the feature at the cursor is marked.
 */
import { useEffect, useRef } from 'react';
import { AlertCircle, Box, Cog, Link2, Move3d, Play, SlidersHorizontal, Waypoints, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ModelDoc, ModelingResult } from '@/lib/modeling';
import { featureIcon } from '@/workspaces/design/featureIcons';
import { BoardIcon, CapacitorIcon, CircuitIcon, ConnectorIcon, DiodeIcon, InductorIcon, LedIcon, NetIcon, ResistorIcon, SchematicIcon } from '@/icons/cad';
import styles from '../SourcePanel.module.css';

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;
export interface OutlineItem { key: string; label: string; detail?: string; icon: Icon; from: number; to: number; feature?: string; error?: string; suppressed?: boolean }

const DESIGN_CALLS: Record<string, [string, LucideIcon]> = {
  add: ['placed', Box], pattern: ['pattern', Box], link: ['link', Link2],
  revolute: ['revolute joint', Waypoints], slider: ['slider joint', Waypoints], cylindrical: ['cylindrical joint', Waypoints], rigid: ['fixed joint', Waypoints],
  couple: ['coupling', Cog], drive: ['motor', Play], pose: ['pose', Move3d], animation: ['animation', Play],
};

/** A design's main.py: its top-level `design.<call>(...)` statements (placements, joints, motion). */
function designOutline(code: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /^(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_]\w*)\.(\w+)\(/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const kind = DESIGN_CALLS[m[2]];
    if (!kind || m[1] === 'cq') continue;
    const end = code.indexOf('\n', m.index);
    const line = code.slice(m.index, end < 0 ? code.length : end);
    const call = line.slice(line.indexOf('(') + 1);
    const quoted = /^\s*["']([^"']+)["']/.exec(call)?.[1];
    const named = /\bname\s*=\s*["']([^"']+)["']/.exec(call)?.[1];
    const first = /^\s*([A-Za-z_]\w*)/.exec(call)?.[1];
    // Placements name their component variable (or name=); joints and motion are named by their first string.
    const label = m[2] === 'add' || m[2] === 'pattern' || m[2] === 'link' ? named ?? first ?? quoted : quoted ?? named ?? first;
    out.push({ key: `design:${m.index}`, label: label ?? m[2], detail: kind[0], icon: kind[1], from: m.index, to: end < 0 ? code.length : end });
  }
  return out;
}

/** Outline items for the open file. */
const CIRCUIT_ICONS: Record<string, Icon> = {
  board: BoardIcon, resistor: ResistorIcon, capacitor: CapacitorIcon, inductor: InductorIcon, diode: DiodeIcon, led: LedIcon,
  pinheader: ConnectorIcon, connector: ConnectorIcon, trace: NetIcon, net: NetIcon, netlabel: NetIcon, schematicsheet: SchematicIcon,
};

/**
 * A circuit's TSX (docs/ELECTRONICS.md): the board, then every named element in order (parts, traces, nets). An
 * item's `feature` is the part's name, so the code and the circuit views follow each other.
 */
/** Where a JSX tag that starts at `start` (its `<`) ends: past its `>`, skipping strings and `{…}` (`from=".R1 > .pin1"`). */
function tagEnd(code: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
  }
  return code.length;
}

export function circuitOutline(code: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /<([a-z][\w]*)\b/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const tag = m[1];
    const to = tagEnd(code, m.index);
    const attributes = code.slice(m.index + m[0].length, to);
    re.lastIndex = to;
    if (tag === 'board') {
      const size = /\bwidth\s*=\s*["{]?\s*["']?([\w.]+)/.exec(attributes)?.[1];
      out.push({ key: `board:${m.index}`, label: 'Board', detail: size ? `${size} wide` : undefined, icon: BoardIcon, from: m.index, to });
      continue;
    }
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/.exec(attributes);
    const label = name?.[1] ?? name?.[2] ?? name?.[3];
    if (!label) continue;
    out.push({ key: `${tag}:${label}:${m.index}`, label, detail: tag, icon: CIRCUIT_ICONS[tag] ?? CircuitIcon, from: m.index, to,
      feature: tag === 'trace' || tag === 'net' || tag === 'netlabel' ? undefined : label });
  }
  return out;
}

export function outlineOf(code: string, doc: ModelDoc | null, report: ModelingResult | null, designMain: boolean): OutlineItem[] {
  if (designMain) return designOutline(code);
  if (!doc) return [];
  const items: OutlineItem[] = [];
  if (doc.parameters.length) {
    const first = doc.parameters[0], last = doc.parameters.at(-1)!;
    items.push({ key: 'parameters', label: 'Parameters', detail: String(doc.parameters.length), icon: SlidersHorizontal, from: first.span[0], to: last.span[1] });
  }
  for (const rule of [...(doc.sheet_rules ?? []), ...(doc.sheet_forms ?? [])]) {
    items.push({ key: `rule:${rule.variable}`, label: rule.variable, detail: rule.constructor, icon: Cog, from: rule.span[0], to: rule.span[1] });
  }
  const results = new Map((report?.features ?? []).map((f) => [f.id, f]));
  for (const feature of doc.features) {
    const result = feature.id ? results.get(feature.id) : undefined;
    items.push({
      key: `feature:${feature.id ?? feature.span[0]}`, label: feature.name || feature.id || feature.kind, detail: feature.id && feature.name && feature.name !== feature.id ? feature.id : feature.kind,
      icon: featureIcon(feature.kind, feature.kind === 'sketch' ? 'sketch' : 'feature'), from: feature.span[0], to: feature.span[1], feature: feature.id ?? undefined,
      error: result?.status === 'error' ? result.error ?? 'Failed' : undefined, suppressed: feature.suppressed || result?.status === 'suppressed',
    });
  }
  return items.sort((a, b) => a.from - b.from);
}

/** The item the cursor is in (the innermost, latest-starting one). */
export function itemAt(items: OutlineItem[], offset: number | null): OutlineItem | null {
  if (offset === null) return null;
  let found: OutlineItem | null = null;
  for (const item of items) if (offset >= item.from && offset <= item.to && (!found || item.from >= found.from)) found = item;
  return found;
}

export default function Outline({ items, current, onJump }: { items: OutlineItem[]; current: string | null; onJump: (item: OutlineItem) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <nav className={styles.outline} aria-label="Outline" id="source-outline">
      <div className={styles.outlineTitle}>Outline</div>
      <div className={styles.outlineList} ref={list}>
        {!items.length && <p className={styles.outlineEmpty}>Nothing to outline yet.</p>}
        {items.map((item) => {
          const ItemIcon = item.icon;
          return (
            <button key={item.key} type="button" className={styles.outlineItem} data-outline={item.feature ?? item.key} data-current={item.key === current || undefined}
              data-suppressed={item.suppressed || undefined} title={item.error ?? `${item.label}${item.detail ? ` · ${item.detail}` : ''}`} onClick={() => onJump(item)}>
              <ItemIcon size={12} /><span className={styles.outlineLabel}>{item.label}</span>
              {item.error ? <AlertCircle size={12} className={styles.outlineError} /> : item.detail && <span className={styles.outlineDetail}>{item.detail}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
