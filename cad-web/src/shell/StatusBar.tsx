import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { HardDrive, MousePointer2, Square } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from '@/ui';
import { set, useApp, useCursor, type SelectionFilter } from '@/state/store';
import { stopBuild } from '@/state/actions';
import { lengthNum } from '@/lib/format';
import { updateSetting, useSetting } from '@/settings/store';
import { viewer } from '@/viewport/viewer';
import { describe } from '@/viewport/measure';
import { useSketchPicks } from '@/sketch/picking';
import { useCircuit } from '@/workspaces/electronics/state';
import { useDocumentWatch } from '@/state/documentWatch';
import { RoutingStatus } from '@/workspaces/electronics/RoutingView';
import { cadquerySourceHref } from '@/settings/registry';
import styles from './StatusBar.module.css';

const FILTERS: { value: SelectionFilter; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Sketches, vertices, edges and faces, whichever is under the pointer; double-click selects the whole component' },
  { value: 'component', label: 'Components', hint: 'Whole bodies and components' },
  { value: 'face', label: 'Faces', hint: 'B-rep faces' },
  { value: 'edge', label: 'Edges', hint: 'B-rep edges' },
  { value: 'vertex', label: 'Vertices', hint: 'B-rep vertices' },
];

/** The open-source engine behind the workspace: named with its version, crediting its authors, linked to its repository. */
export function EngineCredit({ name, version, href, credit }: { name: string; version?: string; href: string; credit: string }) {
  const label = version ? `${name} ${version}` : name;
  return (
    <Tip label={label} description={`${credit} Opens the repository on GitHub.`}>
      <a className={styles.credit} href={href} target="_blank" rel="noreferrer" id="engine-credit">{label}</a>
    </Tip>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  return <span className="tnum">{((now - since) / 1000).toFixed(1)} s</span>;
}

function JobStatus() {
  const phase = useApp((state) => state.phase);
  const label = useApp((state) => state.phaseLabel);
  const started = useApp((state) => state.phaseStarted);
  const busy = useApp((state) => state.busy);
  const runtime = useApp((state) => state.runtimeInfo);
  const inFlight = useApp((state) => state.buildInFlight);
  const tone = phase === 'failed' ? 'danger' : busy ? 'busy' : phase === 'succeeded' || phase === 'idle' ? 'ok' : 'busy';
  const text = label || (phase === 'idle' ? 'Ready' : phase);
  return (
    <span className={styles.job} data-tone={tone} id="status" role="status">
      <span className={styles.dot} />
      {/* One line that rolls: the old words leave upward as the new ones arrive from below, clipped, never on top of each other. */}
      <span className={styles.jobLabel}>
        <AnimatePresence initial={false}>
          <motion.span key={text} initial={{ opacity: 0, y: '100%' }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: '-100%' }} transition={{ duration: 0.18 }}>{text}</motion.span>
        </AnimatePresence>
      </span>
      {busy && started && <span className={styles.muted}><Elapsed since={started} /></span>}
      {busy && inFlight && (
        <Tip label="Stop build" description="Your source and saved revision stay as they are; the last model stays shown.">
          <button type="button" className={styles.stop} aria-label="Stop build" onClick={() => { void stopBuild(); }}><Square size={10} /></button>
        </Tip>
      )}
      {!busy && runtime && <span className={styles.muted}>{runtime}</span>}
    </span>
  );
}

/** A circuit's selection: the part (with its value and footprint), a pick (a pin, trace, via, the board…), several, or the net. */
function CircuitSelection() {
  const model = useCircuit((state) => state.model);
  const selection = useCircuit((state) => state.selection);
  const picks = useCircuit((state) => state.picks);
  const net = useCircuit((state) => state.net);
  const picked = net ? model?.nets.find((item) => item.key === net) : null;
  if (picks.length === 1 && !selection.length && picks[0].kind !== 'net') {
    const pickNet = picks[0].net ? model?.nets.find((item) => item.key === picks[0].net) : null;
    return <span id="selection-status" data-kind={picks[0].kind}><span className={styles.strong}>{picks[0].label}</span>{pickNet && <span className={styles.muted}> · net {pickNet.name}</span>}</span>;
  }
  // A net from the tree selects its parts too: it's the net that's named.
  if (picked && picks.every((pick) => pick.kind === 'net' || pick.kind === 'label')) return <span id="selection-status" data-kind="net"><span className={styles.strong}>{picked.name}</span><span className={styles.muted}> · net · {picked.ports.length} pins</span></span>;
  if (picks.length && selection.length + picks.length > 1) return <span id="selection-status">{selection.length + picks.length} items selected</span>;
  if (!selection.length) return <span className={styles.muted} id="selection-status">Nothing selected</span>;
  if (selection.length > 1) return <span id="selection-status">{selection.length} parts selected</span>;
  const part = model?.parts.find((item) => item.name === selection[0]);
  return (
    <span id="selection-status" data-kind="part">
      <span className={styles.strong}>{selection[0]}</span>
      {part && <span className={styles.muted}>{[part.value, part.footprint?.split('_')[0]].filter(Boolean).map((text) => ` · ${text}`).join('')}</span>}
    </span>
  );
}

function SelectionSummary() {
  const circuit = useApp((state) => state.doc.kind === 'circuit');
  if (circuit) return <CircuitSelection />;
  return <ModelSelection />;
}

function ModelSelection() {
  const selection = useApp((state) => state.selection);
  const tree = useApp((state) => state.tree);
  const version = useApp((state) => state.modelVersion);
  const sketches = useSketchPicks((state) => state.picked);
  const modeling = useApp((state) => state.modeling);
  const units = useSetting('display.units');  // describe() reads it: show the selection in the units just chosen.
  void version; void units;
  if (!selection.length && sketches.length) {
    const name = sketches.length === 1 ? modeling?.features.find((f) => f.id === sketches[0])?.name ?? sketches[0] : `${sketches.length} sketches`;
    return <span id="selection-status" data-kind="sketch"><span className={styles.strong}>{name}</span> selected</span>;
  }
  if (!selection.length || !viewer.model) return <span className={styles.muted} id="selection-status">Nothing selected</span>;
  if (selection.length > 1) {
    const kinds = new Set(selection.map((pick) => pick.kind));
    return <span id="selection-status">{selection.length} {kinds.size === 1 ? `${[...kinds][0]}s` : 'items'} selected</span>;
  }
  const pick = selection[0];
  const info = describe(viewer.model, pick);
  const primary = info.rows.find((row) => row.emphasis);
  return (
    <span id="selection-status">
      <span className={styles.strong}>{pick.kind === 'component' ? tree[pick.node]?.name : info.title}</span>
      {primary && <span className={styles.muted}> · {primary.label} {primary.value}</span>}
    </span>
  );
}

/** A revision of the open design saved elsewhere (STEVE, an agent over MCP, another window) whose model is still building. */
function OutsideBuild() {
  const building = useDocumentWatch((state) => state.building);
  const revision = useApp((state) => state.doc.saved?.revision);
  if (building === null || building !== revision) return null;
  return (
    <Tip label="Building elsewhere" description="Saved by STEVE, your agent or another window. The model here updates when its build finishes.">
      <span className={styles.job} data-tone="busy" id="outside-build-status"><span className={styles.dot} />Revision {building} saved elsewhere · building…</span>
    </Tip>
  );
}

function Cursor() {
  const point = useCursor((state) => state.point);
  const units = useSetting('display.units');
  return (
    <span className={styles.coords} aria-label="Cursor position">
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <span key={axis}><b data-axis={axis}>{axis}</b><span className="tnum">{point ? lengthNum(point[i], units) : '—'}</span></span>
      ))}
    </span>
  );
}

/** The display units (Settings → Display › Units): one click flips millimetres and inches. Models stay mm. */
function UnitsToggle() {
  const units = useSetting('display.units');
  const other = units === 'mm' ? 'in' : 'mm';
  return (
    <Tip label={`Units: ${units === 'mm' ? 'millimetres' : 'inches'}`}
      description={`Click to show ${other === 'in' ? 'inches' : 'millimetres'}. Sets the lengths, areas and volumes shown in the 3D view, Measure, Properties and sketches; the model and its code stay in mm.`}>
      <button type="button" className={styles.units} id="units-toggle" aria-label={`Units: ${units}. Switch to ${other}`}
        onClick={() => { void updateSetting('display.units', other); }}>{units}</button>
    </Tip>
  );
}

export default function StatusBar() {
  const filter = useApp((state) => state.filter);
  const workspace = useApp((state) => state.workspace);
  const version = useApp((state) => state.displayed?.metadata?.cadquery_version);
  const source = useApp((state) => state.displayed?.metadata?.cadquery_source);
  const tscircuit = useApp((state) => (state.displayed?.kind === 'circuit' ? state.displayed.metadata?.tscircuit_version : undefined));
  const electronics = useApp((state) => state.workspace === 'electronics');
  const flat = useCircuit((state) => state.view !== '3d');
  const current = FILTERS.find((item) => item.value === filter)!;
  return (
    <footer className={styles.bar}>
      <JobStatus />
      <span className={styles.sep} />
      <SelectionSummary />
      <div className={styles.right}>
        <OutsideBuild />
        {electronics && <RoutingStatus />}
        {workspace === 'manufacture' && (
          <Tip label="Stored in this browser" description="Setups and materials are kept locally until the server stores workspace data.">
            <span className={styles.local}><HardDrive size={11} />Local</span>
          </Tip>
        )}
        {!electronics && <Menu>
          <Tip label="Selection filter" description="What clicking in the viewport selects.">
            <MenuTrigger asChild>
              <button type="button" className={styles.filter}><MousePointer2 size={11} />{current.label}</button>
            </MenuTrigger>
          </Tip>
          <MenuContent side="top" align="end">
            <MenuLabel>Select</MenuLabel>
            {FILTERS.map((item) => (
              <MenuItem key={item.value} checked={item.value === filter} hint={undefined} onSelect={() => set({ filter: item.value, selection: [] })}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span>{item.label}</span><span style={{ fontSize: 10, color: 'var(--text-3)' }}>{item.hint}</span></span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>}
        {!(electronics && flat) && <><span className={styles.sep} /><Cursor /></>}
        <span className={styles.sep} />
        {/* Circuits keep their own units (mm and mil); everywhere else the chip switches the display units. */}
        {electronics ? <span className={styles.units}>mm</span> : <UnitsToggle />}
        {/* Electronics always credits tscircuit (its version once a circuit has built), never the open CAD model's engine. */}
        {(tscircuit || electronics) && <EngineCredit name="tscircuit" version={tscircuit} href="https://github.com/tscircuit/tscircuit" credit="tscircuit, the open-source TypeScript and React electronics toolkit by Seve Ibarluzea and contributors." />}
        {version && !tscircuit && !electronics && <EngineCredit name="CadQuery" version={version} href={cadquerySourceHref(source)} credit="STEVE’s fork of CadQuery, the open-source parametric CAD library by the CadQuery contributors (upstream: CadQuery/cadquery)." />}
      </div>
    </footer>
  );
}
