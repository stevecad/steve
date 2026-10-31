/**
 * Properties for a circuit: the selected part (what it is, its value and footprint, where it sits, each pin and the net
 * it's on, its problems) or, with nothing selected, the board. The editable properties come from the code-rewrite
 * tools (slots.ts → inspector/), below these facts.
 */
import { Suspense, useMemo } from 'react';
import { AlertCircle, AlertTriangle, Sparkles, Wand2 } from 'lucide-react';
import { Spinner } from '@/ui';
import { BoardIcon, CircuitIcon } from '@/icons/cad';
import { iconFor } from './CircuitTree';
import { plainMessage, type CircuitModel, type CircuitPart } from './circuit';
import { useCircuit } from './state';
import { PartInspector } from './slots';
import PickInspector from './PickInspector';
import { directFix, fixWithSteve, mergeProblems, useReadinessView } from './readiness';
import { useApp } from '@/state/store';
import type { CircuitProblem } from './circuit';
import styles from './Electronics.module.css';

const ftypeLabel = (ftype: string) => ftype.replace(/^simple_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A problem's one-click fix (the code-rewrite engine's), when it has one. */
function IssueFix({ problem }: { problem: CircuitProblem }) {
  const json = useCircuit((state) => state.json);
  const code = useApp((state) => state.doc.code);
  const quick = problem.issue ? directFix(problem.issue, code, json) : null;
  return quick ? <button type="button" className={styles.issueQuick} data-fix onClick={quick.apply}><Wand2 size={12} />{quick.label}</button> : null;
}

function PartFacts({ part, model }: { part: CircuitPart; model: CircuitModel }) {
  const netOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const net of model.nets) for (const port of net.ports) map.set(port.id, net.name);
    return map;
  }, [model]);
  const readiness = useReadinessView();
  const problems = mergeProblems(model, readiness).filter((problem) => problem.parts.includes(part.name));
  const PartGlyph = iconFor(part.group);
  return (
    <>
      <div className={styles.inspectorHead}>
        <div className={styles.inspectorGlyph}><PartGlyph size={18} /></div>
        <div><h3 id="inspector-part">{part.name}</h3><p>{ftypeLabel(part.ftype)}{part.value ? ` · ${part.value}` : ''}</p></div>
      </div>
      <dl className={styles.facts2}>
        {part.value && <><dt>Value</dt><dd>{part.value}</dd></>}
        <dt>Footprint</dt><dd>{part.footprint ?? 'From its supplier part'}</dd>
        {part.layer && <><dt>Side</dt><dd>{part.layer === 'bottom' ? 'Bottom' : 'Top'}</dd></>}
      </dl>
      {part.ports.length > 0 && (
        <div>
          <p className={styles.sectionTitle}>Pins</p>
          <div className={styles.pins} style={{ marginTop: 6 }}>
            {part.ports.map((port) => (
              <span key={port.id} className={styles.pin} title={netOf.get(port.id) ? `On ${netOf.get(port.id)}` : 'Not connected'}>
                <b>{port.label}</b>{netOf.get(port.id) ? `→ ${netOf.get(port.id)}` : '· open'}
              </span>
            ))}
          </div>
        </div>
      )}
      {problems.map((problem) => (
        <div key={problem.id} className={styles.inspectorProblem} data-severity={problem.severity}>
          {problem.severity === 'error' ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
          <span className={styles.inspectorProblemText}>
            {plainMessage(problem.message)}
            {problem.fix && <small><b>Fix</b> {problem.fix}</small>}
            <span className={styles.issueActions}>
              <IssueFix problem={problem} />
              {problem.issue && problem.severity !== 'info' && <button type="button" className={styles.issueSteve} onClick={() => { void fixWithSteve([problem.issue!]); }}><Sparkles size={12} />Fix with STEVE</button>}
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

function BoardFacts({ model }: { model: CircuitModel }) {
  const { board, parts, nets, problems } = model;
  const mm = (value: number | null) => (value === null ? '–' : `${Number(value.toFixed(2))} mm`);
  return (
    <>
      <div className={styles.inspectorHead}>
        <div className={styles.inspectorGlyph}><BoardIcon size={18} /></div>
        <div><h3>Board</h3><p>{parts.length} parts · {nets.length} nets</p></div>
      </div>
      {board && (
        <dl className={styles.facts2}>
          <dt>Size</dt><dd>{mm(board.width)} × {mm(board.height)}</dd>
          <dt>Layers</dt><dd>{board.layers ?? '–'}</dd>
          <dt>Problems</dt><dd>{problems.length ? `${problems.filter((p) => p.severity === 'error').length} errors, ${problems.filter((p) => p.severity === 'warning').length} warnings` : 'None'}</dd>
        </dl>
      )}
      <p className={styles.inspectorNote}>Select a part in the schematic, on the board or in the browser to see its pins and nets. Everything here is the TSX in Source: edit it there, ask STEVE, or use the tools.</p>
    </>
  );
}

export default function CircuitInspector() {
  const model = useCircuit((state) => state.model);
  const selection = useCircuit((state) => state.selection);
  const picks = useCircuit((state) => state.picks);
  const json = useCircuit((state) => state.json);
  const loading = useCircuit((state) => state.loading);
  if (!model) return <div className={styles.inspector}>{loading ? <Spinner /> : <p className={styles.inspectorNote}>Build the circuit to see its parts here.</p>}</div>;
  const parts = model.parts.filter((part) => selection.includes(part.name));
  // A pin, trace, via, hole, net or the board picked (and no part): its own facts. The board keeps its editable properties.
  const pick = !parts.length && picks.length && json ? picks[picks.length - 1] : null;
  if (pick && json) {
    return (
      <div className={styles.inspector} id="circuit-inspector" data-pick={pick.kind}>
        <PickInspector pick={pick} model={model} json={json} />
        {picks.length > 1 && <p className={styles.inspectorNote}>{picks.length} items picked: {picks.map((item) => item.label).join(' · ')}</p>}
        {pick.kind === 'board' && PartInspector && <Suspense fallback={<Spinner />}><PartInspector parts={[]} model={model} /></Suspense>}
      </div>
    );
  }
  return (
    <div className={styles.inspector} id="circuit-inspector">
      {parts.length === 1 ? <PartFacts part={parts[0]} model={model} />
        : parts.length > 1 ? (
          <div className={styles.inspectorHead}>
            <div className={styles.inspectorGlyph}><CircuitIcon size={18} /></div>
            <div><h3>{parts.length} parts</h3><p>{parts.map((part) => part.name).join(', ')}</p></div>
          </div>
        ) : <BoardFacts model={model} />}
      {PartInspector && <Suspense fallback={<Spinner />}><PartInspector parts={parts} model={model} /></Suspense>}
    </div>
  );
}
