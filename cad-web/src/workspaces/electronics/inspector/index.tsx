/**
 * The Properties slot of the Electronics workspace (workspaces/electronics/slots.ts): the selected part's properties
 * (the board's with nothing selected), edited as code. Several selected parts show as a list to narrow down.
 */
import { set, useApp } from '@/state/store';
import { setCode } from '@/state/actions';
import type { PartInspectorProps } from '../slots';
import { selectParts, useCircuit } from '../state';
import type { Span, Target } from '../code/types';
import { PartIcon } from '../palette/symbols';
import ElementInspector from './Inspector';
import { readinessOf } from './Readiness';
import styles from './Inspector.module.css';

export { default as ElementInspector } from './Inspector';
export type { ElementInspectorProps, ResolvedPlacement } from './Inspector';
export { BoardReadiness, fixFor, readinessOf } from './Readiness';
export type { Fix, Readiness, ReadinessIssue } from './Readiness';
export { useCircuitEngine } from './useEngine';

/** tscircuit's element for a Circuit JSON ftype (`simple_pin_header` → `pinheader`). */
export const tagOfFtype = (ftype: string) => ftype.replace(/^simple_/, '').replace(/_/g, '');

/** Shows a span of the circuit code in the Source pane. */
export function revealInSource(span: Span) {
  set({ dockOpen: true, dockTab: 'source', sourceReveal: { from: span.start, to: span.end, nonce: Date.now() } });
}

export default function PartInspector({ parts }: PartInspectorProps) {
  const code = useApp((state) => state.doc.code);
  const metadata = useApp((state) => state.displayed?.metadata);
  const circuit = useCircuit((state) => state.json);
  if (parts.length > 1) {
    return (
      <div className={styles.multi} id="circuit-properties" data-multi={parts.length}>
        <span className={styles.multiTitle}>{parts.length} parts selected</span>
        <div className={styles.multiList}>
          {parts.map((part) => (
            <button key={part.id} type="button" onClick={() => selectParts([part.name])} title={`Edit ${part.name} only`}>
              <PartIcon tag={tagOfFtype(part.ftype)} size={14} />{part.name}
            </button>
          ))}
        </div>
        <p className={styles.hint}>Rotate (R), flip to the other side (F) or delete them all from the ribbon; pick one to edit its properties.</p>
      </div>
    );
  }
  const part = parts[0];
  const target: Target = part ? part.name : { tag: 'board' };
  return (
    <ElementInspector
      code={code}
      target={target}
      resolved={part?.pcb ? { pcb: { ...part.pcb, layer: part.layer ?? undefined } } : null}
      onReveal={revealInSource}
      compact={!!part}
      circuit={circuit}
      readiness={readinessOf(metadata)}
      onChange={(next, _edit, { target: kept }) => {
        setCode(next);
        if (part && typeof kept === 'string' && kept !== part.name) selectParts([kept]);
      }}
    />
  );
}
