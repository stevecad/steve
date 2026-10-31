/**
 * One-click fixes for the fabrication-readiness verdict (build `metadata.readiness`, docs/ELECTRONICS.md "Readiness").
 * `fixFor` is the code-rewrite engine's fix for an issue: the workspace lists every issue once (CircuitInspector,
 * ReadinessPanel, the tree's Problems; readiness.ts loads this file by path) and shows it as a button. The board's
 * own section adds what's worth doing before any issue appears: fab-ready settings and power-net widths. Each fix is a
 * code edit from `../code/fixes`, checked on the lab to clear its rule (tests/electronics_code/fixes_lab.test.mjs).
 */
import type { ReactNode } from 'react';
import { AlertTriangle, Wand2 } from 'lucide-react';
import { Button } from '@/ui';
import {
  addCrystalLoadCaps, addDecoupling, addLedResistor, addRegulatorCaps, addUsbCcResistors, applyFabReadyBoard, FAB_READY_BOARD, isPowerNet, setNetTraceWidth,
} from '../code/fixes';
import { repairSupplierPartNumbers } from '../code/edits';
import type { EditResult, Element, SourceIndex } from '../code/types';
import styles from './Inspector.module.css';

export interface ReadinessIssue {
  rule: string;
  severity: 'blocking' | 'advisory' | 'info';
  message: string;
  fix?: string;
  component?: string | null;
  net?: string | null;
  source_line?: number | null;
  file?: string | null;
}
export interface Readiness { version: number; verdict: 'ready' | 'blocked'; blocking: ReadinessIssue[]; advisories: ReadinessIssue[] }

/** The verdict from a build's metadata, if it has one. */
export function readinessOf(metadata: unknown): Readiness | null {
  const value = (metadata as { readiness?: Readiness } | null | undefined)?.readiness;
  return value && Array.isArray(value.blocking) && Array.isArray(value.advisories) ? value : null;
}

export type Fix = { label: string; run: () => EditResult };

/** The one-click fix for an issue, when the code engine has one. */
export function fixFor(issue: ReadinessIssue, code: string, circuit: readonly unknown[] | null): Fix | null {
  const part = issue.component ?? '';
  const needsCircuit = <T,>(make: (json: readonly unknown[]) => T) => (circuit ? make(circuit) : null);
  switch (issue.rule) {
    case 'electrical.decoupling': return needsCircuit((json) => ({ label: `Add 100 nF next to ${part}`, run: () => addDecoupling(code, json, part, issue.net) }));
    case 'electrical.led_current': return needsCircuit((json) => ({ label: 'Add a resistor in series', run: () => addLedResistor(code, json, part) }));
    case 'electrical.crystal_load_caps': return needsCircuit((json) => ({ label: 'Add load capacitors', run: () => addCrystalLoadCaps(code, json, part) }));
    case 'electrical.usb_c_cc': return needsCircuit((json) => ({ label: 'Add 5.1 kΩ CC resistors', run: () => addUsbCcResistors(code, json, part) }));
    case 'electrical.regulator_caps': return needsCircuit((json) => ({ label: 'Add input and output capacitors', run: () => addRegulatorCaps(code, json, part) }));
    case 'electrical.power_trace_width': return issue.net ? { label: `Widen ${issue.net} to 0.4 mm`, run: () => setNetTraceWidth(code, issue.net!) } : null;
    case 'board.thickness':
    case 'fab.trace_spacing':
    case 'fab.via_size': return { label: 'Apply fab-ready board settings', run: () => applyFabReadyBoard(code) };
    case 'circuit.dropped_component': return /supplierPartNumbers/.test(issue.message + (issue.fix ?? '')) ? { label: 'Write the part numbers as lists', run: () => repairSupplierPartNumbers(code) } : null;
    default: return null;
  }
}

export interface BoardReadinessProps {
  element: Element;
  index: SourceIndex;
  code: string;
  readiness: Readiness | null;
  circuit: readonly unknown[] | null;
  onFix: (fix: Fix) => void;
  readOnly?: boolean;
}

/** The board: fab-ready settings in one click, and a trace width for every power net that doesn't have one. */
export function BoardReadiness({ element, index, code, readiness, circuit, onFix, readOnly }: BoardReadinessProps) {
  const attr = (name: string) => [...element.attrs].reverse().find((item) => item.name === name);
  const style = attr('pcbStyle')?.value as Record<string, unknown> | undefined;
  const fabReady = attr('thickness')?.value === FAB_READY_BOARD.thickness && attr('minTraceToPadEdgeClearance')?.value === FAB_READY_BOARD.minTraceToPadEdgeClearance
    && style?.viaHoleDiameter === FAB_READY_BOARD.pcbStyle.viaHoleDiameter && style?.viaPadDiameter === FAB_READY_BOARD.pcbStyle.viaPadDiameter;
  const widened = new Set(index.elements.filter((item) => item.tag === 'net' && item.attrs.some((a) => a.name === 'nominalTraceWidth')).map((item) => item.name));
  const powerNets = [...new Set((circuit ?? []).filter((row): row is { type: string; name: string } => (row as { type?: string }).type === 'source_net' && typeof (row as { name?: unknown }).name === 'string').map((row) => row.name))].filter(isPowerNet);
  const narrow = powerNets.filter((net) => !widened.has(net));
  const rows: ReactNode[] = [];
  if (!fabReady && !readOnly) {
    rows.push(
      <li key="fab" className={styles.issue} data-severity="advisory" data-rule="board.fab_ready">
        <Wand2 size={13} />
        <div>
          <p>Fab-ready board settings: 1.6 mm thick, 0.15 mm trace clearance, 0.3/0.6 mm vias (JLCPCB’s standard, no surcharge).</p>
          <div className={styles.issueActions}><Button size="sm" variant="primary" icon={<Wand2 />} id="circuit-fab-ready" onClick={() => onFix({ label: 'Apply fab-ready board settings', run: () => applyFabReadyBoard(code) })}>Apply fab-ready board settings</Button></div>
        </div>
      </li>,
    );
  }
  if (narrow.length && !readOnly) {
    rows.push(
      <li key="power" className={styles.issue} data-severity="advisory" data-rule="electrical.power_trace_width">
        <AlertTriangle size={13} />
        <div>
          <p>Power and ground traces need at least 0.3 mm; these nets use the 0.15 mm default.</p>
          <div className={styles.issueActions}>
            {narrow.map((net) => <Button key={net} size="sm" variant="secondary" data-net={net} onClick={() => onFix({ label: `Widen ${net}`, run: () => setNetTraceWidth(code, net) })}>{net} → 0.4 mm</Button>)}
            {narrow.length > 1 && <Button size="sm" variant="primary" icon={<Wand2 />} id="circuit-widen-all" onClick={() => onFix({ label: 'Widen every power net', run: () => narrow.reduce<EditResult>((done, net) => { const next = setNetTraceWidth(done.code, net); return { ...next, changed: done.changed || next.changed, notes: [] }; }, { code, changed: false, notes: [] }) })}>All of them</Button>}
          </div>
        </div>
      </li>,
    );
  }
  if (!rows.length) return null;
  return (
    <section className={styles.readiness} id="circuit-board-readiness" aria-label="Board readiness">
      <h4>{readiness?.verdict === 'ready' ? 'Ready to order' : 'Before ordering'}</h4>
      <ul>{rows}</ul>
    </section>
  );
}
