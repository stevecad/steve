/**
 * The Parts tab in the right dock: the parts library and JLCPCB's in-stock parts, full height beside the views.
 * Picking a part puts it on the pointer in the schematic (palette/placing.ts); parts arrive on the board by themselves
 * and are arranged in the PCB view. Opened by Place (Shift+A), Find JLCPCB part and an empty board's "Place a part".
 */
import { useEffect } from 'react';
import { MousePointerClick } from 'lucide-react';
import { Segmented } from '@/ui';
import { useApp } from '@/state/store';
import { setCode } from '@/state/actions';
import { selectSoon } from '../state';
import { stopPlacing, useSchematicTool } from '../schematicEdits';
import type { PartSpec } from '../parts/catalog';
import PartPalette from './Palette';
import JlcSearch from './JlcSearch';
import { armPart, placeNow } from './placing';
import { setPartsList, usePartsTab, type PartsList } from './partsTab';
import styles from './Palette.module.css';

export default function PartsPanel() {
  const list = usePartsTab((state) => state.list);
  const focus = usePartsTab((state) => state.focus);
  const jlcQuery = usePartsTab((state) => state.query);
  // Handed to the JLCPCB search once (it keeps its own query from there).
  useEffect(() => { if (jlcQuery) usePartsTab.setState({ query: '' }); }, [jlcQuery]);
  const code = useApp((state) => state.doc.code);
  const circuit = useApp((state) => state.doc.open && state.doc.kind === 'circuit');
  const placing = useSchematicTool((state) => state.placing);
  const arm = (part: PartSpec, props?: Record<string, unknown>) => { void armPart(part, props); };
  // Without aiming: placed where tscircuit's layout puts it (the double-click's first click had picked it up).
  const place = (part: PartSpec, props?: Record<string, unknown>) => { stopPlacing(); void placeNow(part, props); };
  if (!circuit) return <p className={styles.partsEmpty}>Open a circuit to place parts in it.</p>;
  return (
    // Esc with the search focused (after picking with Enter) still stops placing; the app's Esc skips text fields.
    <div className={styles.parts} id="circuit-parts" onKeyDown={(event) => { if (event.key === 'Escape' && placing) { event.stopPropagation(); stopPlacing(); } }}>
      <div className={styles.partsHead}>
        <Segmented<PartsList> size="sm" value={list} onChange={setPartsList} options={[{ value: 'library', label: 'Parts' }, { value: 'jlcpcb', label: 'JLCPCB' }]} />
      </div>
      <div className={styles.partsBody}>
        {list === 'library'
          ? <PartPalette onArm={(part) => arm(part)} onPlace={(part) => place(part)} armed={placing?.props ? null : placing?.tag ?? null} focusKey={focus} />
          : <JlcSearch code={code} onArm={(part, props) => arm(part, props)} focusKey={focus} initialQuery={jlcQuery}
              onChange={(next, edit) => { setCode(next); if (edit.name) selectSoon([edit.name]); }} />}
      </div>
      <p className={styles.partsHelp} id="parts-help" data-placing={placing ? true : undefined}>
        <MousePointerClick size={13} />
        {placing
          ? <span>Placing <b>{placing.name ?? placing.label}</b>: click in the schematic to put it there, again for the next one. Esc or a right-click stops.</span>
          : <span>Pick a part, then click in the schematic to place it (double-click adds it without aiming). Parts appear on the board by themselves; arrange them in the PCB view.</span>}
      </p>
    </div>
  );
}
