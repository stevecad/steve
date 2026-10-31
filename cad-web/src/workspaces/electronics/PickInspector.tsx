/**
 * Properties for a pick that isn't a whole part (picks.ts): a pin or pad (its part, net and the pins it joins), a trace
 * (its ends, net, width, layers and length on the board), a via or hole (where, how big, which net), the board, a net
 * or net label. "Reveal in source" goes to the code that makes it, where there is such a line.
 */
import { Code2, Crosshair } from 'lucide-react';
import { useApp } from '@/state/store';
import { CircuitIcon } from '@/icons/cad';
import { netByKey, pickContext, traceCopper, circuitIndex, mm, type CircuitPick } from './picks';
import { selectParts } from './state';
import { revealLine } from './reveal';
import { routingOf, routingSummary } from './routing';
import type { CircuitElement, CircuitModel } from './circuit';
import styles from './Electronics.module.css';

const TITLES: Record<CircuitPick['kind'], string> = { pin: 'Pin', pad: 'Pad', trace: 'Trace', net: 'Net', via: 'Via', hole: 'Hole', board: 'Board', label: 'Net label' };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineWhere = (code: string, test: (line: string) => boolean) => { const index = code.split('\n').findIndex(test); return index >= 0 ? index + 1 : null; };

/** The line of the code that makes a pick: the part of a pin, the `<trace>` of a connection, the board, the net. */
function sourceLine(pick: CircuitPick, code: string, json: CircuitElement[]): number | null {
  if ((pick.kind === 'pin' || pick.kind === 'pad') && pick.part) {
    const pattern = new RegExp(`name=["'{]+${escape(pick.part)}["'}]`);
    return lineWhere(code, (line) => pattern.test(line));
  }
  if (pick.kind === 'trace' && pick.ids.source_trace_id) {
    const trace = circuitIndex(json).sourceTraces.get(pick.ids.source_trace_id);
    const [from, to] = String(trace?.display_name ?? '').split(' to ').map((selector) => selector.replace(/\s+/g, ''));
    if (!from) return null;
    return lineWhere(code, (line) => line.includes('<trace') && line.replace(/\s+/g, '').includes(from) && (!to || line.replace(/\s+/g, '').includes(to)));
  }
  if (pick.kind === 'board') return lineWhere(code, (line) => /<board\b/.test(line));
  if (pick.kind === 'net' || pick.kind === 'label') {
    const name = pick.label.replace(/^net (label )?/, '');
    return lineWhere(code, (line) => new RegExp(`<net\\s+name=["']${escape(name)}["']`).test(line)) ?? lineWhere(code, (line) => line.includes(`net.${name}`));
  }
  return null;
}

export default function PickInspector({ pick, model, json }: { pick: CircuitPick; model: CircuitModel; json: CircuitElement[] }) {
  const code = useApp((state) => state.doc.code);
  const routing = routingOf(useApp((state) => state.displayed));
  const context = pickContext(pick, model, json, routing);
  const geometry = context.geometry ?? {};
  const net = netByKey(model, pick.net);
  const index = circuitIndex(json);
  const copper = pick.kind === 'trace' ? traceCopper(index, pick) : null;
  const line = sourceLine(pick, code, json);
  const title = pick.kind === 'pin' || pick.kind === 'pad' ? pick.label.replace(/^(pin|pad) /, '') : pick.kind === 'net' || pick.kind === 'label' ? `${TITLES[pick.kind]} ${net?.name ?? ''}` : TITLES[pick.kind];
  const pinCount = `${net?.ports.length ?? 0} pin${net?.ports.length === 1 ? '' : 's'}`;
  const subtitle = pick.kind === 'trace' ? pick.label.replace(/^trace /, '') : pick.kind === 'pin' || pick.kind === 'pad' ? `${TITLES[pick.kind]} of ${pick.part}`
    : pick.kind === 'board' ? `${model.parts.length} parts · ${model.nets.length} nets` : pick.kind === 'label' ? `Names the net · ${pinCount}` : pick.kind === 'net' ? pinCount : pick.label;
  const pins = net ? net.ports.filter((port) => port.id !== pick.ids.source_port_id) : [];
  const at = pick.at ? `(${mm(pick.at.x)}, ${mm(pick.at.y)}) mm` : null;
  const board = index.board;
  return (
    <>
      <div className={styles.inspectorHead}>
        <div className={styles.inspectorGlyph}><CircuitIcon size={18} /></div>
        <div><h3 id="inspector-pick" data-kind={pick.kind}>{title}</h3><p>{subtitle}</p></div>
      </div>
      <dl className={styles.facts2} id="pick-facts">
        {(pick.kind === 'pin' || pick.kind === 'pad') && pick.part && <><dt>Part</dt><dd><button type="button" className={styles.linkButton} onClick={() => selectParts([pick.part!])}>{pick.part}</button></dd></>}
        {pick.kind !== 'board' && pick.kind !== 'hole' && pick.kind !== 'net' && <><dt>Net</dt><dd>{net?.name ?? 'Not connected'}</dd></>}
        {copper && <><dt>Width</dt><dd>{copper.widths.length ? copper.widths.map(mm).join(' / ') + ' mm' : '–'}</dd>
          <dt>Layers</dt><dd>{copper.layers.join(' + ') || '–'}</dd><dt>Length</dt><dd>{mm(copper.length)} mm{copper.vias ? ` · ${copper.vias} via${copper.vias === 1 ? '' : 's'}` : ''}</dd></>}
        {pick.kind === 'trace' && !copper && <><dt>Board</dt><dd>Not routed yet</dd></>}
        {pick.kind === 'via' && <><dt>Drill / pad</dt><dd>{mm(Number(geometry.hole_diameter_mm ?? 0))} / {mm(Number(geometry.outer_diameter_mm ?? 0))} mm</dd></>}
        {pick.kind === 'pad' && Array.isArray(geometry.pad_mm) && <><dt>Pad</dt><dd>{(geometry.pad_mm as (number | null)[]).filter((v): v is number => v !== null).map(mm).join(' × ')} mm{pick.layer ? ` · ${pick.layer}` : ''}</dd></>}
        {pick.kind === 'board' && board && <><dt>Size</dt><dd>{mm(Number(board.width))} × {mm(Number(board.height))} mm</dd>
          <dt>Thickness</dt><dd>{board.thickness != null ? `${mm(Number(board.thickness))} mm` : '1.4 mm (tscircuit’s default)'}</dd><dt>Layers</dt><dd>{String(board.num_layers ?? 2)}</dd>
          {routing?.status && routing.status !== 'none' && <><dt>Routing</dt><dd id="pick-routing">{routingSummary(routing)}</dd></>}</>}
        {at && pick.kind !== 'board' && <><dt>At</dt><dd>{at}</dd></>}
      </dl>
      {pins.length > 0 && (
        <div>
          <p className={styles.sectionTitle}>{pick.kind === 'pin' || pick.kind === 'pad' ? 'Connected to' : 'Pins'}</p>
          <div className={styles.pins} style={{ marginTop: 6 }}>
            {pins.map((port) => <button key={port.id} type="button" className={styles.pin} onClick={() => selectParts([port.part])}><span><b>{port.part}</b>.{port.label}</span></button>)}
          </div>
        </div>
      )}
      <div className={styles.issueActions}>
        {line && <button type="button" className={styles.issueQuick} id="pick-reveal" onClick={() => revealLine(line)}><Code2 size={12} />Reveal in source</button>}
        {pick.part && <button type="button" className={styles.issueQuick} onClick={() => selectParts([pick.part!])}><Crosshair size={12} />Select {pick.part}</button>}
      </div>
      <p className={styles.inspectorNote} id="pick-steve">STEVE is told: {context.description}</p>
    </>
  );
}
