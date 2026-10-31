/**
 * The simulation player over the viewport: transport and machine-time clock, a timeline coloured by move kind with
 * stock checkpoints and verification events, the current move's readout, display toggles, and a side panel with
 * the job's events (click one to go to it) or the posted program (the current line follows playback; click a line
 * to go to its move). Verdicts are the backend's; this only draws and seeks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion as animated } from 'motion/react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileCode, Info, ListChecks, Pause, Play, SkipBack, X } from 'lucide-react';
import { IconButton, Segmented, Spinner } from '@/ui';
import { useApp } from '@/state/store';
import CopyMessage from '@/shell/CopyMessage';
import { INSPECTION_COLORS, KIND_COLORS, SEVERITY_COLORS } from './CamLayer';
import { MOVE_KINDS, moveAt, moveForLine, positionAtTime, tipAt, timeAtPosition, type Motion } from './motion';
import { keyframeAt } from './stock';
import { compareRange, DEVIATION_COLORS, fieldPlan, OP_COLORS, useStockView, type FieldPlan } from './stockView';
import { closePlayer, seekEvent, toolAt, usePlayer, type Player } from './state';
import type { FixtureDisplay, VerificationEvent } from './api';
import { checkWords } from './checkSummary';
import styles from './Cam.module.css';

const SPEEDS = [1, 5, 20, 100, 500];
/** One colour per operation along the timeline (display attribution, not a verdict), as on the surfaces it cut. */
const BAND_COLORS = OP_COLORS;

export const KIND_LABEL: Record<VerificationEvent['kind'], string> = {
  holder_contact: 'Holder contact', shank_contact: 'Shank contact', cutter_contact: 'Cutter contact', machine_contact: 'Machine contact', rapid_in_stock: 'Rapid into stock',
  initial_occupancy: 'Tool starts in material', gouge: 'Gouge', rpm_limit: 'Spindle speed limit', feed_limit: 'Feed limit', engagement_limit: 'Material removal rate',
  travel_limit: 'Travel limit', uncertain: 'Uncertain', unassessed: 'Not assessed',
};
const SEVERITY_RANK = { failed: 0, uncertain: 1, unassessed: 2 } as const;

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();

/** Advances playback in machine time while playing. */
function usePlayback(player: Player | null) {
  useEffect(() => {
    if (!player?.times) return;
    const times = player.times;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const state = usePlayer.getState();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (state.playing) {
        const total = times[times.length - 1];
        const next = timeAtPosition(times, state.position) + dt * state.speed;
        if (next >= total) usePlayer.setState({ position: times.length - 1, playing: false });
        else usePlayer.setState({ position: positionAtTime(times, next) });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player?.times]);
}

function Timeline({ player }: { player: Player }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const position = usePlayer((state) => state.position);
  const motion = player.motion!, times = player.times!;
  const total = times[times.length - 1] || 1;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !width) return;
    const ratio = window.devicePixelRatio || 1, height = 34;
    element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
    const ctx = element.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Moves by kind, in machine time (a rapid of a few millimetres is a sliver; a long finishing pass is wide).
    for (let x = 0; x < width; x++) {
      const t = positionAtTime(times, ((x + 0.5) / width) * total);
      const kind = MOVE_KINDS[motion.kind[moveAt(motion, t)]];
      ctx.fillStyle = KIND_COLORS[kind];
      ctx.globalAlpha = kind === 'rapid' || kind === 'retract' ? 0.5 : 0.85;
      ctx.fillRect(x, 9, 1, 12);
    }
    ctx.globalAlpha = 1;
    // Operation bands: each operation's stretch (display attribution); tool-change routes between them stay grey.
    if (player.bands.length > 1) {
      ctx.fillStyle = '#475569';
      ctx.fillRect(0, 2, width, 4);
      player.bands.forEach((band, index) => {
        const a = (timeAtPosition(times, band.first) / total) * width, b = (timeAtPosition(times, band.last + 1) / total) * width;
        ctx.fillStyle = BAND_COLORS[index % BAND_COLORS.length];
        ctx.fillRect(a, 2, Math.max(1, b - a), 4);
      });
    }
    // Stock checkpoints.
    ctx.fillStyle = '#cbd5e1';
    for (const checkpoint of player.preview?.stock_checkpoints ?? []) {
      const x = (timeAtPosition(times, checkpoint.after_move + 1) / total) * width;
      ctx.fillRect(Math.min(width - 2, Math.max(0, x - 1)), 2, 2, 5);
    }
    // Events: the worst severity per pixel.
    const worst = new Int8Array(Math.ceil(width)).fill(9);
    for (const event of player.events) {
      if (!event.move_range) continue;
      const a = Math.floor((timeAtPosition(times, event.move_range[0]) / total) * width);
      const b = Math.max(a, Math.floor((timeAtPosition(times, event.move_range[1] + 1) / total) * width) - 1);
      for (let x = Math.max(0, a); x <= Math.min(width - 1, b); x++) worst[x] = Math.min(worst[x], SEVERITY_RANK[event.severity]);
    }
    for (let x = 0; x < width; x++) {
      if (worst[x] === 9) continue;
      ctx.fillStyle = SEVERITY_COLORS[(['failed', 'uncertain', 'unassessed'] as const)[worst[x]]];
      ctx.fillRect(x, 24, 1, 7);
    }
  }, [width, player, motion, times, total]);
  const seekTo = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    usePlayer.setState({ position: positionAtTime(times, fraction * total), focus: null });
  };
  const left = `${(timeAtPosition(times, position) / total) * 100}%`;
  const bands = player.bands.length > 1 ? player.bands : [];
  return (
    <div className={styles.timelineWrap}>
      {bands.length > 0 && (
        <div className={styles.bands} id="cam-bands">
          {bands.map((band, index) => {
            const a = timeAtPosition(times, band.first) / total, b = timeAtPosition(times, band.last + 1) / total;
            return (
              <button key={band.operation} type="button" className={styles.band} data-band={band.operation} style={{ left: `${a * 100}%`, width: `${Math.max(0, b - a) * 100}%`, borderColor: BAND_COLORS[index % BAND_COLORS.length] }}
                title={`${band.name}: moves ${band.first + 1}–${band.last + 1}. Go to its start.`} onClick={() => usePlayer.setState({ position: band.first, playing: false, focus: null })}>
                {band.name}
              </button>
            );
          })}
        </div>
      )}
      <div ref={box} className={styles.timeline} id="cam-timeline" role="slider" aria-label="Playback position" aria-valuemin={0} aria-valuemax={motion.count} aria-valuenow={Math.round(position)} tabIndex={0}
        onPointerDown={(event) => { (event.target as HTMLElement).setPointerCapture?.(event.pointerId); usePlayer.setState({ playing: false }); seekTo(event.clientX); }}
        onPointerMove={(event) => { if (event.buttons & 1) seekTo(event.clientX); }}>
        <canvas ref={canvas} />
        <span className={styles.playhead} style={{ left }} />
      </div>
    </div>
  );
}

function Deck({ player }: { player: Player }) {
  const position = usePlayer((state) => state.position);
  const playing = usePlayer((state) => state.playing);
  const speed = usePlayer((state) => state.speed);
  const show = usePlayer((state) => state.show);
  const panel = usePlayer((state) => state.panel);
  const motion = player.motion!, times = player.times!;
  const index = moveAt(motion, position);
  const origin = player.setup?.controller.work_origin_mm ?? [0, 0, 0];
  const tip = tipAt(motion, position);
  const kind = MOVE_KINDS[motion.kind[index]];
  const tool = toolAt(player, position);
  const band = player.bands.find((item) => index >= item.first && index <= item.last) ?? null;
  const step = (delta: number) => usePlayer.setState({ playing: false, position: Math.min(motion.count, Math.max(0, Math.floor(position) + delta)) });
  const toggle = () => usePlayer.setState((state) => ({ playing: !state.playing, position: !state.playing && state.position >= motion.count ? 0 : state.position }));
  const setShow = (patch: Partial<typeof show>) => usePlayer.setState({ show: { ...show, ...patch } });
  const checkpoints = player.preview?.stock_checkpoints ?? [];
  const keyframe = checkpoints[keyframeAt(checkpoints.map((c) => ({ afterMove: c.after_move, display: c })), position)];
  const stockError = usePlayer((state) => state.stockError);
  const continuous = !!player.preview?.stock_deltas && !stockError && checkpoints.every((checkpoint) => !!checkpoint.state);
  const view = useStockView();
  const plan = useMemo(() => fieldPlan(player), [player]);
  const field = plan.ok && !view.engine && view.error?.job !== player.job.id ? plan : null;
  const engineCell = keyframe?.snapshot.grid.cell_mm ?? 1;
  const counts = useMemo(() => {
    const out = { failed: 0, uncertain: 0, unassessed: 0 };
    for (const event of player.events) out[event.severity]++;
    return out;
  }, [player.events]);
  return (
    <animated.div className={styles.deck} id="cam-player" role="toolbar" aria-label="Toolpath simulation" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2 }}
      data-moves={motion.count} data-position={position.toFixed(3)} data-line={motion.line[index]}>
      <div className={styles.deckTop} data-deck="top">
        <button type="button" aria-label="Back to the start" title="Back to the start" onClick={() => usePlayer.setState({ position: 0, playing: false })}><SkipBack size={14} /></button>
        <button type="button" aria-label="Previous move" title="Previous move (←)" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className={styles.play} id="cam-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (space)' : 'Play (space)'} onClick={toggle}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button type="button" aria-label="Next move" title="Next move (→)" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <span className={styles.clock} id="cam-clock"><b>{clock(timeAtPosition(times, position))}</b> / {clock(times[times.length - 1])}</span>
        <select aria-label="Playback speed" value={speed} onChange={(event) => usePlayer.setState({ speed: Number(event.target.value) })}>
          {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
        <span className={styles.readout} id="cam-readout">
          {player.bands.length > 1 && <span className={styles.opName} id="cam-current-op">{band ? band.name : 'Tool change'}</span>}
          {tool !== null && <span id="cam-current-tool">T<b>{tool}</b></span>}
          <span>Move <b>{index + 1}</b> / {motion.count}</span>
          <span className={styles.kind}><i style={{ background: KIND_COLORS[kind] }} />{kind}</span>
          <span>Line <b>{motion.line[index]}</b></span>
          <span>X <b>{num(tip[0] - origin[0])}</b> Y <b>{num(tip[1] - origin[1])}</b> Z <b>{num(tip[2] - origin[2])}</b></span>
          {motion.feed[index] > 0 && <span>F <b>{num(motion.feed[index], 0)}</b></span>}
          <span>S <b>{num(motion.rpm[index], 0)}</b></span>
        </span>
        <span className={styles.counts} title="Events the backend reported" id="cam-event-counts">
          {counts.failed > 0 && <span data-s="failed"><i className={styles.legendDot} style={{ background: SEVERITY_COLORS.failed }} />{counts.failed}</span>}
          {counts.uncertain > 0 && <span data-s="uncertain"><i className={styles.legendDot} style={{ background: SEVERITY_COLORS.uncertain }} />{counts.uncertain}</span>}
        </span>
        <IconButton small label="Events" active={panel === 'checks'} onClick={() => usePlayer.setState({ panel: panel === 'checks' ? null : 'checks' })}><ListChecks /></IconButton>
        <IconButton small label="Posted program" active={panel === 'program'} onClick={() => usePlayer.setState({ panel: panel === 'program' ? null : 'program' })}><FileCode /></IconButton>
        <IconButton small label="Close the simulation" onClick={closePlayer}><X /></IconButton>
      </div>
      <Timeline player={player} />
      <div className={styles.deckFoot} data-deck="foot">
        <span className={styles.kinds} aria-label="Toolpath colours">
          {(['feed', 'plunge', 'rapid', 'retract'] as const).map((item) => <span key={item} className={styles.kind}><i style={{ background: KIND_COLORS[item] }} />{item}</span>)}
        </span>
        {field && view.status
          ? <span id="cam-stock-note" data-stock="field" data-cell={view.status.cell.toFixed(4)} className={styles.stockNote}
              title={`What you see: the stock as a ${num(view.status.cell)} mm height field (${view.status.nx} × ${view.status.ny}), cut by each tool's real profile swept along the decoded moves${view.status.initial === 'engine cells' ? ', starting from the engine’s carried stock cells' : ''}; walls are drawn where the cutter's side was. Surfaces are tinted by the operation that cut them. It is a display only: the engine's checks ran on its own ${engineCell} mm voxel stock and decide every pass and fail; their events are marked where the engine found them. "Engine stock (checks)" shows that stock. Rapids are timed at the machine's ${num(player.rapidMmMin, 0)} mm/min axis limit.`}>
              Stock: <b>{view.status.cutting !== null ? 'cutting…' : 'as cut'}</b> ({num(view.status.cell)} mm display; checks use the engine’s {engineCell} mm stock)
            </span>
          : continuous
          ? <span id="cam-stock-note" data-stock="continuous" className={styles.stockNote} title={`Stock is the backend's voxel grid (${keyframe?.snapshot.grid.cell_mm ?? 1} mm cells), changed cell by cell as the tool passes, at the point in each move where the engine found the cutter reaching it. Seeking restores the nearest checkpoint and replays the cells. Amber is uncertain material (partly cut cells). Rapids are timed at the machine's ${num(player.rapidMmMin, 0)} mm/min axis limit.`}>
              Stock: <b>removed as the tool passes</b> ({keyframe?.snapshot.grid.cell_mm ?? 1} mm cells) · <i className={styles.legendDot} style={{ background: '#f0a43a', margin: '0 3px 0 0' }} />uncertain
            </span>
          : <span id="cam-stock-note" data-stock="checkpoints" className={styles.stockNote} title={`Stock shows the backend's voxel checkpoints (${keyframe?.snapshot.grid.cell_mm ?? 1} mm cells): initial, every 256 moves${player.program ? ', each operation’s end' : ''} and the end. ${stockError ? `The cell-by-cell stream couldn't be shown (${stockError}), so material` : 'This output has no cell-by-cell stream (an older job), so material'} between checkpoints isn't drawn as it's cut. Amber is uncertain material (partly cut cells). Rapids are timed at the machine's ${num(player.rapidMmMin, 0)} mm/min axis limit.`}>
              Stock: checkpoint after move {keyframe ? Math.max(0, keyframe.after_move + 1) : 0} · <b>updates at checkpoints</b> · <i className={styles.legendDot} style={{ background: '#f0a43a', margin: '0 3px 0 0' }} />uncertain
            </span>}
        <button type="button" className={styles.toggle} data-on={show.toolpath || undefined} onClick={() => setShow({ toolpath: !show.toolpath })}>Toolpath</button>
        <Segmented size="sm" value={show.stock} onChange={(stock) => setShow({ stock })}
          options={[{ value: 'solid', label: 'Stock' }, { value: 'translucent', label: 'Clear' }, { value: 'off', label: 'Off' }]} />
        <button type="button" className={styles.toggle} data-on={show.tool || undefined} onClick={() => setShow({ tool: !show.tool })}>Tool</button>
        {player.fixtures.length > 0 && <button type="button" className={styles.toggle} data-on={show.fixtures || undefined} onClick={() => setShow({ fixtures: !show.fixtures })}>Fixtures</button>}
        <button type="button" className={styles.toggle} data-on={show.part || undefined} onClick={() => setShow({ part: !show.part })}>Part</button>
        {plan.ok && <>
          {field && <button type="button" className={styles.toggle} id="cam-compare" data-on={view.compare || undefined} title="Colour the stock by its height above the part's surface: on size, stock left, or cut into the part (a display comparison; the engine's inspection and checks decide)."
            onClick={() => useStockView.setState({ compare: !view.compare })}>Compare to part</button>}
          <button type="button" className={styles.toggle} id="cam-engine-stock" data-on={view.engine || undefined} data-quiet title="Show the engine's voxel stock: the grid every check ran on, instead of the display stock."
            onClick={() => useStockView.setState({ engine: !view.engine })}>Engine stock (checks)</button>
        </>}
        {player.inspection && <InspectionLegend player={player} on={show.inspection} onToggle={() => setShow({ inspection: !show.inspection })} />}
      </div>
      {field && view.compare && <CompareLegend plan={field} part={view.status?.part ?? null} />}
    </animated.div>
  );
}

/** Compare to part: the diverging scale, the on-size band (the setup's inspection tolerances) and where it saturates. */
function CompareLegend({ plan, part }: { plan: Extract<FieldPlan, { ok: true }>; part: boolean | null }) {
  const { missing, excess } = plan.tolerance;
  const range = compareRange(plan);
  const c = DEVIATION_COLORS;
  return (
    <div className={styles.compareLegend} id="cam-compare-legend" data-missing={missing} data-excess={excess} data-range={range}
      title="Each column's top against the part's top surface straight below it (vertical distance), on the display stock. Walls show as a thin band where they meet. The engine's stock inspection and checks are the authority.">
      {part === false
        ? <span>No part is open to compare with.</span>
        : <>
          <span>Cut into part ≤ −{num(range, 2)} mm</span>
          <i className={styles.compareScale} style={{ background: `linear-gradient(90deg, ${c.gougeFar}, ${c.gougeNear} 42%, ${c.onSize} 46%, ${c.onSize} 54%, ${c.leftNear} 58%, ${c.leftFar})` }} />
          <span>Stock left ≥ {num(range, 2)} mm</span>
          <span className={styles.compareBand}><i className={styles.legendDot} style={{ background: c.onSize }} />on size −{num(missing)} … +{num(excess)} mm{part === null ? ' · loading the part…' : ''}</span>
        </>}
    </div>
  );
}

/** The finished-stock inspection toggle and its legend: what the amber and red boxes mean, with their counts. */
function InspectionLegend({ player, on, onToggle }: { player: Player; on: boolean; onToggle: () => void }) {
  const inspection = player.inspection!;
  const count = (kind: 'excess' | 'missing') => inspection.regions.filter((region) => region.kind === kind).length;
  const more = inspection.total_regions - inspection.regions.length;
  return (
    <span className={styles.inspectionLegend} id="cam-inspection-legend" data-regions={inspection.regions.length}
      title={`The finished stock compared with the design: amber boxes hold material left beyond the allowed excess; red boxes are where material was cut past the allowed undercut. Solid boxes are proven (a point was found); faint ones are unresolved.${more > 0 ? ` ${more} more regions weren't kept.` : ''}`}>
      <button type="button" className={styles.toggle} data-on={on || undefined} onClick={onToggle}>Inspection</button>
      <span><i className={styles.legendDot} style={{ background: INSPECTION_COLORS.excess }} />excess {count('excess')}</span>
      <span><i className={styles.legendDot} style={{ background: INSPECTION_COLORS.missing }} />missing {count('missing')}</span>
    </span>
  );
}

interface Group { key: string; severity: VerificationEvent['severity']; kind: VerificationEvent['kind']; check: string | null; indices: number[]; runs: Run[] }
/** Consecutive events of one kind on the same tool region and fixture, merged into one span of moves. */
interface Run { first: number; count: number; from: number; to: number; region: string | null; fixture: string | null; machine: string | null }

function runsOf(events: VerificationEvent[], indices: number[]): Run[] {
  const sorted = [...indices].sort((a, b) => (events[a].move_range?.[0] ?? -1) - (events[b].move_range?.[0] ?? -1));
  const runs: Run[] = [];
  for (const index of sorted) {
    const event = events[index];
    const last = runs.at(-1);
    const from = event.move_range?.[0] ?? -1, to = event.move_range?.[1] ?? -1;
    const machine = event.machine_bodies?.join('|') ?? event.machine_body ?? null;
    if (last && from >= 0 && last.region === event.region && last.fixture === event.fixture && last.machine === machine && from <= last.to + 1) { last.to = Math.max(last.to, to); last.count++; continue; }
    runs.push({ first: index, count: 1, from, to, region: event.region, fixture: event.fixture, machine });
  }
  return runs;
}

/** A fixture as the setup declares it, with the body it is, not its collision box's id (`fixture_0`). */
const fixtureName = (fixtures: FixtureDisplay[], id: string) => {
  const fixture = fixtures.find((item) => item.collision.id === id);
  return fixture ? `${fixture.id} (body ${fixture.reference.body})` : id;
};

/** What a span of events touched, in a few words: machine bodies, tool region, fixture, finished-part body. */
const describeRun = (event: VerificationEvent, run: Run, fixtures: FixtureDisplay[]) => [
  event.machine_bodies && `machine ${event.machine_bodies.map((body) => body.replace(/_/g, ' ')).join(' & ')}`,
  event.machine_body && `machine ${event.machine_body.replace(/_/g, ' ')}`,
  run.region && `tool ${run.region.replace(/_/g, ' ')}`, run.fixture && `fixture ${fixtureName(fixtures, run.fixture)}`, event.target && `part ${event.target}`,
  run.count > 1 && `${run.count} events`,
].filter(Boolean).join(' · ');

const spanLabel = (run: Run) => (run.from < 0 ? 'Whole program' : run.from === run.to ? `Move ${run.from + 1}` : `Moves ${run.from + 1}–${run.to + 1}`);

function Checks({ player }: { player: Player }) {
  const focus = usePlayer((state) => state.focus);
  const [open, setOpen] = useState<Record<string, number>>({});
  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    player.events.forEach((event, index) => {
      const key = `${event.severity}|${event.kind}|${event.check ?? ''}`;
      const group = map.get(key) ?? { key, severity: event.severity, kind: event.kind, check: event.check, indices: [], runs: [] };
      group.indices.push(index);
      map.set(key, group);
    });
    for (const group of map.values()) group.runs = runsOf(player.events, group.indices);
    return [...map.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.indices.length - a.indices.length);
  }, [player.events]);
  const assessment = player.assessment;
  const fixtureSolids = player.fixtures.some((fixture) => !!fixture.collision.solid);
  const failedChecks = assessment?.checks.filter((check) => check.status === 'failed') ?? [];
  const focusRun = (run: Run) => focus !== null && run.from >= 0 && player.events[focus]?.move_range && player.events[focus].kind === player.events[run.first].kind
    && player.events[focus].region === run.region && player.events[focus].fixture === run.fixture && player.events[focus].move_range![0] >= run.from && player.events[focus].move_range![0] <= run.to;
  return (
    <>
      <div className={styles.sideNote} id="cam-assessment">
        {assessment?.download_status === 'blocked_failed_checks'
          ? <><b>Machine file blocked.</b> {failedChecks.length} check{failedChecks.length === 1 ? '' : 's'} failed{failedChecks.length ? `: ${failedChecks.map((check) => checkWords(check.id).toLowerCase()).join(', ')}` : ''}. Fix the program and generate again.</>
          : <><b>Unverified output.</b> Generated and checked where the engine can; not machine-qualified.{fixtureSolids ? '' : ' Uncertain contacts use conservative envelopes and need refinement.'}</>}
        {fixtureSolids && <> Fixture contacts were checked against the fixtures’ own solids: a collision has a point inside both the cutter and the fixture (marked red when you pick it); uncertain ones are unresolved, with no depth inferred.</>}
      </div>
      {!groups.length && <div className={styles.sideNote}>No events: nothing contacted, gouged or went past a limit in the checks that ran.</div>}
      {groups.map((group) => {
        const shown = open[group.key] ?? 0;
        const first = player.events[group.indices[0]];
        return (
          <div key={group.key} className={styles.group} data-severity={group.severity} data-kind={group.kind}>
            <button type="button" className={styles.groupHead} aria-expanded={shown > 0} onClick={() => setOpen({ ...open, [group.key]: shown ? 0 : 50 })}>
              <i className={styles.sev} data-s={group.severity} />
              <span>{KIND_LABEL[group.kind]}{group.check ? <small> · {checkWords(group.check).toLowerCase()}</small> : null}</span>
              <small>{group.indices.length} · {group.runs.length} span{group.runs.length === 1 ? '' : 's'}</small>
            </button>
            {shown > 0 && <>
              {!first.move_range && <div className={styles.more}>{first.message}</div>}
              {group.runs.slice(0, shown).map((run) => (
                <button key={run.first} type="button" className={styles.event} data-on={focusRun(run) || undefined} data-event={run.first} data-count={run.count} disabled={run.from < 0}
                  onClick={() => seekEvent(run.first)} title={player.events[run.first].message}>
                  <b>{spanLabel(run)}</b>
                  <span>{describeRun(player.events[run.first], run, player.fixtures) || player.events[run.first].message}</span>
                </button>
              ))}
              {group.runs.length > shown && <div className={styles.more}>{group.runs.length - shown} more spans · <button type="button" onClick={() => setOpen({ ...open, [group.key]: shown + 200 })}>Show more</button></div>}
            </>}
          </div>
        );
      })}
    </>
  );
}

const ROW = 18;

/** The posted program, virtualised; the current move's line follows playback; a click goes to that line's move. */
function Program({ player }: { player: Player }) {
  const position = usePlayer((state) => state.position);
  const playing = usePlayer((state) => state.playing);
  const body = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const motion: Motion | null = player.motion;
  const lines = player.code ?? [];
  const current = motion ? motion.line[moveAt(motion, position)] ?? 0 : 0;
  useEffect(() => {
    const element = body.current?.parentElement;
    if (!element) return;
    const update = () => setScroll({ top: element.scrollTop, height: element.clientHeight });
    update();
    element.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { element.removeEventListener('scroll', update); observer.disconnect(); };
  }, []);
  // Keep the current line in view while it plays or after a seek.
  useEffect(() => {
    const element = body.current?.parentElement;
    if (!element || !current) return;
    const y = (current - 1) * ROW;
    if (y < element.scrollTop + ROW || y > element.scrollTop + element.clientHeight - 2 * ROW) element.scrollTop = Math.max(0, y - element.clientHeight / 3);
  }, [current, playing]);
  if (!player.code) return <div className={styles.sideNote} id="cam-program-note">{player.codeNote ?? 'This job has no machine program.'}</div>;
  const first = Math.max(0, Math.floor(scroll.top / ROW) - 10), last = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / ROW) + 10);
  return (
    <div ref={body} className={styles.code} id="cam-program" style={{ height: lines.length * ROW }} data-current-line={current}>
      {lines.slice(first, last).map((text, offset) => {
        const line = first + offset + 1;
        return (
          <div key={line} className={styles.line} style={{ top: (line - 1) * ROW }} data-line={line} data-on={line === current || undefined}
            onClick={() => { const index = motion ? moveForLine(motion, line) : -1; if (index >= 0) usePlayer.setState({ position: index, playing: false, focus: null }); }}>
            <i>{line}</i>{text}
          </div>
        );
      })}
    </div>
  );
}

function Side({ player }: { player: Player }) {
  const panel = usePlayer((state) => state.panel);
  if (!panel) return null;
  return (
    <animated.aside className={styles.side} id="cam-side" data-panel={panel} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.18 }}>
      <div className={styles.sideHead}>
        <div><Segmented size="sm" value={panel} onChange={(next) => usePlayer.setState({ panel: next })} options={[{ value: 'checks', label: `Events (${player.events.length})` }, { value: 'program', label: player.motion ? 'Posted program' : 'Generated output' }]} /></div>
        <IconButton small label="Hide panel" onClick={() => usePlayer.setState({ panel: null })}><X /></IconButton>
      </div>
      <div className={styles.sideBody}>{panel === 'checks' ? <Checks player={player} /> : <Program player={player} />}</div>
    </animated.aside>
  );
}

export default function PlayerOverlay() {
  const workspace = useApp((state) => state.workspace);
  const player = usePlayer((state) => state.player);
  usePlayback(player);
  // Space plays and pauses; arrows step a move (not while typing).
  useEffect(() => {
    if (!player?.motion) return;
    const count = player.motion.count;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], .cm-editor') || target.isContentEditable)) return;
      if (event.key === ' ') { event.preventDefault(); usePlayer.setState((state) => ({ playing: !state.playing })); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        usePlayer.setState((state) => ({ playing: false, position: Math.min(count, Math.max(0, Math.floor(state.position) + (event.key === 'ArrowRight' ? 1 : -1))) }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player?.motion]);
  useEffect(() => { if (workspace !== 'manufacture') usePlayer.setState({ playing: false }); }, [workspace]);
  if (workspace !== 'manufacture' || !player) return null;
  return (
    <div className={styles.player}>
      <AnimatePresence>
        {player.status === 'loading' && <animated.div key="loading" className={styles.loading} role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><Spinner /><span>Loading the simulation: motion, stock checkpoints, events…</span></animated.div>}
        {(player.status === 'error' || player.status === 'unavailable') && (
          <animated.div key="problem" className={styles.loading} data-tone={player.status === 'error' ? 'danger' : undefined} role="alert" id="cam-player-problem" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <AlertTriangle size={16} color={player.status === 'error' ? 'var(--danger)' : 'var(--warning)'} />
            <span>{player.status === 'unavailable' ? <><b>No simulation for this output.</b> {player.message} The machine file is kept as generated (unverified); nothing is guessed from it.</> : <>Couldn’t load the simulation: {player.message}</>}</span>
            <CopyMessage text={player.message ?? ''} />
            <IconButton small label="Close" onClick={closePlayer}><X /></IconButton>
          </animated.div>
        )}
        {player.status === 'ready' && player.motion && player.times && <Deck key="deck" player={player} />}
        {player.status === 'empty' && (
          <animated.div key="empty" className={styles.loading} role="status" id="cam-player-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Info size={16} color="var(--accent)" />
            <span><b>Nothing to cut.</b> {player.message}</span>
          </animated.div>
        )}
        {(player.status === 'ready' && player.motion || player.status === 'unavailable' || player.status === 'empty') && <Side key="side" player={player} />}
      </AnimatePresence>
    </div>
  );
}
