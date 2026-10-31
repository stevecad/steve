/**
 * Motion in Properties: the design's couplings and joints with live sliders, its drives (play,
 * pause, speed) and named poses. Moving a joint here is viewing the mechanism; the code keeps its pose.
 */
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ArrowLeftRight, Bookmark, ChevronLeft, ChevronRight, Clapperboard, Code2, Cog, Gauge, Layers, Link2, Pause, Pencil, Play, Plus, RotateCcw, RotateCw, Rows3 } from 'lucide-react';
import { Button, ContextItem, ContextMenu, ContextSeparator, IconButton, NumberField, Section, Segmented, Slider } from '@/ui';
import { toast, useApp } from '@/state/store';
import { updateModel } from '@/state/actions';
import { viewer } from '@/viewport/viewer';
import { num } from '@/lib/format';
import {
  cableValues, couplingUnit, cutShort, saturations, fitCutShort, fitValues, studyValues, turns, unitOf, type Cable, type CableWhen, type CollisionStudy, type StudyMap, type StudyPose, type FitCheck, type FitPair, type MotionCoupling, type MotionDrive, type MotionJoint,
} from './kinematics';
import { applyPose, applyValues, playClip, resetPose, selectClip, selectJoint, setCoupling, setJoint, setSpeedScale, togglePlay, play, stop, useMotion } from './state';
import { removePose, showCall, showJointCode } from './code';
import { openJointTool } from './jointTool';
import { openMotionTool } from './motionTool';
import { openExplodeTool } from './explodeTool';
import ModeSelect from './ModeSelect';
import styles from './Motion.module.css';

export const JOINT_ICONS = { rigid: Link2, revolute: RotateCw, slider: ArrowLeftRight, cylindrical: Rows3 } as const;
export const JOINT_LABELS = { rigid: 'Rigid', revolute: 'Revolute', slider: 'Slider', cylindrical: 'Cylindrical' } as const;

/** A slider's travel when the joint has no limits: the design's size either way. */
function freeTravel(): number {
  const box = viewer.model?.bounds(false);
  if (!box || box.isEmpty()) return 100;
  return Math.ceil(box.getSize(new THREE.Vector3()).length() / 10) * 10;
}

function JointControl({ joint, compact }: { joint: MotionJoint; compact?: boolean }) {
  const state = useMotion((s) => s.pose[joint.name]);
  const active = useMotion((s) => s.active === joint.name);
  const playing = useMotion((s) => s.playing === joint.name);
  const drive = useMotion((s) => s.kinematics?.drives.find((d) => d.joint === joint.name));
  const travel = useMemo(freeTravel, []);
  // Where its couplings push it past a limit, it stops there (as the build's checks place it).
  const held = useMotion((s) => (s.kinematics ? saturations(s.kinematics, joint, s.own, s.coupled) : [])
    .map((item) => `${item.part === 'travel' && joint.type === 'cylindrical' ? 'travel ' : ''}held at ${num(item.held)}${item.part === 'travel' ? ' mm' : '°'} limit`).join(' · '));
  const value = state?.value ?? joint.value;
  const range: [number, number] = joint.limits ?? (turns(joint) ? [-180, 180] : [-travel, travel]);
  const slideRange: [number, number] = joint.slide_limits ?? [-travel, travel];
  const Icon = JOINT_ICONS[joint.type];
  // A follower (follow=True) moves only through its couplings: its own sliders show where it is, read-only.
  const follows = !!joint.follows;
  return (
    <div className={styles.joint} data-joint={joint.name} data-active={active || undefined} data-follows={follows || undefined}>
      <button type="button" className={styles.jointHead} onClick={() => selectJoint(active ? null : joint.name)} aria-pressed={active}>
        <Icon size={14} className={styles.jointIcon} />
        <span className={styles.jointName}>{joint.name}</span>
        <span className={styles.jointMeta}>{JOINT_LABELS[joint.type]} · {joint.parent} → {joint.child}</span>
      </button>
      {!!joint.driven_by?.length && (
        <div className={styles.drivenBy} data-driven-by={joint.driven_by.join(' ')}
          title={follows ? `Moves only with ${joint.driven_by.join(', ')}: move ${joint.driven_by.length > 1 ? 'those' : 'that'} to move it.` : undefined}>
          <Cog size={11} />{follows ? 'Follows' : 'Driven by'} {joint.driven_by.join(', ')}{held && <span data-held={joint.name}> · {held}</span>}
        </div>
      )}
      {joint.type !== 'rigid' && (
        <div className={styles.jointRow}>
          <Slider label={`${joint.name} ${turns(joint) ? 'angle' : 'travel'}`} value={value} min={range[0]} max={range[1]} step={turns(joint) ? 0.5 : 0.1}
            disabled={follows} onChange={(next) => setJoint(joint.name, { value: next })} />
          <div className={styles.jointValue}><NumberField value={Number(value.toFixed(2))} unit={unitOf(joint)} step={turns(joint) ? 5 : 1} min={range[0]} max={range[1]}
            disabled={follows} live ariaLabel={`${joint.name} value`} onChange={(next) => setJoint(joint.name, { value: next })} /></div>
          {drive && !compact && (
            <IconButton small label={playing ? `Pause ${joint.name}` : `Drive ${joint.name}`} description={`${num(drive.speed)} ${unitOf(joint)}/s`} active={playing}
              onClick={() => (playing ? stop() : play(joint.name))} data-drive={joint.name}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </IconButton>
          )}
        </div>
      )}
      {joint.type === 'cylindrical' && (
        <div className={styles.jointRow}>
          <Slider label={`${joint.name} travel`} value={state?.slide ?? 0} min={slideRange[0]} max={slideRange[1]} step={0.1} disabled={follows}
            onChange={(next) => setJoint(joint.name, { slide: next })} />
          <div className={styles.jointValue}><NumberField value={Number((state?.slide ?? 0).toFixed(2))} unit="mm" min={slideRange[0]} max={slideRange[1]}
            disabled={follows} live ariaLabel={`${joint.name} travel`} onChange={(next) => setJoint(joint.name, { slide: next })} /></div>
        </div>
      )}
      {joint.limits && joint.type !== 'rigid' && <div className={styles.limits}><span>{num(joint.limits[0])}{unitOf(joint)}</span><span>{num(joint.limits[1])}{unitOf(joint)}</span></div>}
    </div>
  );
}

/** `sun ×1 · carrier ×0.25`: what a coupling moves, and by how much. */
const gearList = (coupling: MotionCoupling) => Object.entries(coupling.gears).map(([key, ratio]) => `${key} ×${num(ratio, 4)}`).join(' · ');

function CouplingControl({ coupling, compact }: { coupling: MotionCoupling; compact?: boolean }) {
  const kinematics = useMotion((s) => s.kinematics);
  const value = useMotion((s) => s.coupled[coupling.name] ?? coupling.value);
  const active = useMotion((s) => s.active === coupling.name);
  const playing = useMotion((s) => s.playing === coupling.name);
  const drive = useMotion((s) => s.kinematics?.drives.find((d) => d.joint === coupling.name));
  // An unbounded coupling turns on and on: its slider shows two turns around where it is, moving on when it leaves them.
  const span = useRef<[number, number]>([-360, 360]);
  if (value < span.current[0] || value > span.current[1]) {
    const centre = 360 * Math.round(value / 360);
    span.current = [centre - 360, centre + 360];
  }
  if (!kinematics) return null;
  const unit = couplingUnit(kinematics, coupling);
  const range: [number, number] = coupling.bounds ?? span.current;
  return (
    <div className={styles.joint} data-coupling={coupling.name} data-active={active || undefined}>
      <button type="button" className={styles.jointHead} onClick={() => selectJoint(active ? null : coupling.name)} aria-pressed={active}>
        <Cog size={14} className={styles.jointIcon} />
        <span className={styles.jointName}>{coupling.name}</span>
        <span className={styles.jointMeta}>Coupling · {gearList(coupling)}</span>
      </button>
      <div className={styles.jointRow}>
        <Slider label={`${coupling.name} position`} value={value} min={range[0]} max={range[1]} step={unit === '°' ? 0.5 : unit ? 0.1 : 0.01} onChange={(next) => setCoupling(coupling.name, next)} />
        <div className={styles.jointValue}><NumberField value={Number(value.toFixed(2))} unit={unit} step={unit === '°' ? 5 : 1} min={coupling.bounds?.[0]} max={coupling.bounds?.[1]}
          live ariaLabel={`${coupling.name} value`} onChange={(next) => setCoupling(coupling.name, next)} /></div>
        {drive && !compact && (
          <IconButton small label={playing ? `Pause ${coupling.name}` : `Drive ${coupling.name}`} description={`${num(drive.speed)}${unit}/s`} active={playing}
            onClick={() => (playing ? stop() : play(coupling.name))} data-drive={coupling.name}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </IconButton>
        )}
      </div>
      {coupling.bounds && <div className={styles.limits}><span>{num(coupling.bounds[0])}{unit}</span><span>{num(coupling.bounds[1])}{unit}</span></div>}
    </div>
  );
}

const SPEEDS = [{ value: '0.25', label: '¼×' }, { value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }];

/** Play/pause for the design's drives, their speed, and the named poses. */
export function MotionPlayer() {
  const kinematics = useMotion((s) => s.kinematics);
  const playing = useMotion((s) => s.playing);
  const speedScale = useMotion((s) => s.speedScale);
  if (!kinematics) return null;
  const poses = Object.keys(kinematics.poses);
  const movable = kinematics.joints.some((joint) => joint.type !== 'rigid');
  return (
    <div className={styles.player}>
      <div className={styles.playerRow}>
        {kinematics.drives.length > 0 && (
          <Button size="sm" variant={playing ? 'secondary' : 'primary'} id="motion-play" icon={playing ? <Pause /> : <Play />} onClick={() => togglePlay()}>
            {playing ? 'Pause' : kinematics.drives.length > 1 ? `Play ${kinematics.drives[0].joint}` : 'Play'}
          </Button>
        )}
        <Button size="sm" variant="ghost" id="motion-reset" icon={<RotateCcw />} onClick={resetPose}>Rest pose</Button>
        {kinematics.drives.length > 0 && (
          <Segmented size="sm" value={String(speedScale)} onChange={(value) => setSpeedScale(Number(value))} options={SPEEDS} className={styles.speed} />
        )}
      </div>
      <div className={styles.poses}>
        {poses.map((name) => (
          <ContextMenu key={name} trigger={<button type="button" className={styles.pose} data-pose={name} title="Click to move there; right-click for more" onClick={() => applyPose(name)}>{name}</button>}>
            <ContextItem icon={<Bookmark size={14} />} onSelect={() => applyPose(name)}>Move to {name}</ContextItem>
            <ContextItem icon={<Pencil size={14} />} onSelect={() => openMotionTool('pose', name)}>Update or rename…</ContextItem>
            <ContextItem icon={<Code2 size={14} />} onSelect={() => showCall('pose', name)}>Show code</ContextItem>
            <ContextSeparator />
            <ContextItem danger onSelect={() => { void deletePose(name); }}>Delete pose</ContextItem>
          </ContextMenu>
        ))}
        {movable && <button type="button" className={styles.pose} data-save-pose onClick={() => openMotionTool('pose')} title="Save where the mechanism is now as a named pose"><Plus size={11} /> Save pose</button>}
      </div>
      {kinematics.drives.filter((drive) => drive.check).map((drive) => <CollisionReport key={drive.joint} drive={drive} />)}
      {kinematics.studies?.map((study) => <StudyReport key={study.name} study={study} />)}
      {kinematics.fits?.map((fit) => <FitReport key={fit.name} fit={fit} />)}
      {kinematics.cables?.cables.map((cable) => <CableCheck key={cable.name} cable={cable} />)}
      {kinematics.cables?.note && <p className={styles.hint}>{kinematics.cables.note}</p>}
      {movable && kinematics.drives.length === 0 && !kinematics.animations?.length && <p className={styles.hint}>In the Motion tab, Motor drives a joint; Save pose and New animation make a timeline.</p>}
    </div>
  );
}

async function deletePose(name: string) {
  const problem = removePose(name);
  if (problem) { toast('warning', `${name} is in use`, problem); return; }
  await updateModel();
}

/** The design's keyframed animations and explodes: choose one for the timeline, play it, edit it. */
function Animations() {
  const animations = useMotion((s) => s.kinematics?.animations ?? NONE);
  const explodes = useMotion((s) => s.kinematics?.explodes ?? NONE);
  const clip = useMotion((s) => s.clip);
  const playing = useMotion((s) => !!s.clipStart);
  if (!animations.length && !explodes.length) return null;
  return (
    <div className={styles.animations} id="motion-animations">
      {animations.map((animation) => {
        const active = clip === animation.name;
        const clashes = animation.check && !animation.check.clear ? animation.check.collisions.length : 0;
        const incomplete = animation.check && cutShort(animation.check);
        return (
          <div key={animation.name} className={styles.animationRow} data-animation={animation.name} data-active={active || undefined}>
            <Clapperboard size={13} />
            <span title={animation.check?.reused ? `Collision check ${REUSED.charAt(0).toLowerCase()}${REUSED.slice(1)}` : undefined}><b>{animation.name}</b> · {animation.keys.length} keys · {num(animation.duration)} s{animation.loop ? ' · loops' : ''}
              {clashes ? ` · ${clashes} clash${clashes === 1 ? '' : 'es'}` : ''}
              {incomplete ? <span data-animation-incomplete title={animation.check!.note}> · check incomplete ({animation.check!.samples} of {animation.check!.of} poses)</span> : null}</span>
            <IconButton small label={active && playing ? `Pause ${animation.name}` : `Play ${animation.name}`} active={active && playing}
              onClick={() => (active && playing ? useMotion.setState({ clipStart: null }) : playClip(animation.name))}>
              {active && playing ? <Pause size={13} /> : <Play size={13} />}
            </IconButton>
            <IconButton small label={`Edit ${animation.name}`} onClick={() => { selectClip(animation.name); openMotionTool('animation', animation.name); }}><Pencil size={13} /></IconButton>
          </div>
        );
      })}
      {explodes.map((explode) => {
        const active = clip === explode.name;
        return (
          <div key={explode.name} className={styles.animationRow} data-explode={explode.name} data-active={active || undefined}>
            <Layers size={13} />
            <span><b>{explode.name}</b> · explode · {explode.steps.length} step{explode.steps.length === 1 ? '' : 's'} · {num(explode.duration)} s{explode.loop ? ' · loops' : ''}</span>
            <IconButton small label={active && playing ? `Pause ${explode.name}` : `Play ${explode.name}`} active={active && playing}
              onClick={() => (active && playing ? useMotion.setState({ clipStart: null }) : playClip(explode.name))}>
              {active && playing ? <Pause size={13} /> : <Play size={13} />}
            </IconButton>
            <IconButton small label={`Edit ${explode.name}`} onClick={() => { selectClip(explode.name); openExplodeTool(explode.name); }}><Pencil size={13} /></IconButton>
          </div>
        );
      })}
    </div>
  );
}

const NONE: never[] = [];

/** A check an earlier build made, shown again because nothing it depends on changed (only the look did, say). */
const REUSED = 'From an earlier build: nothing it depends on changed since.';

/** What the build's sweep of a drive found: clear, or which instances collide over which part of the range. */
function CollisionReport({ drive }: { drive: MotionDrive }) {
  const kinematics = useMotion((s) => s.kinematics);
  const joint = kinematics?.joints.find((j) => j.name === drive.joint);
  const coupling = kinematics?.couplings?.find((c) => c.name === drive.joint);
  const check = drive.check!;
  if (!kinematics || (!joint && !coupling)) return null;
  const unit = joint ? unitOf(joint) : couplingUnit(kinematics, coupling!);
  const show = (value: number) => (coupling ? setCoupling(drive.joint, value) : setJoint(drive.joint, { value }));
  const span = ([low, high]: [number, number]) => (low === high ? `${num(low)}${unit}` : `${num(low)}…${num(high)}${unit}`);
  const incomplete = cutShort(check);
  const across = drive.range ? span(drive.range) : 'its range';
  return (
    <div className={styles.check} data-check={drive.joint} data-clear={(check.clear && !incomplete) || undefined}
      data-incomplete={(incomplete && !check.collisions.length) || undefined}>
      {incomplete && <span data-check-incomplete><b>{drive.joint}</b>: Incomplete, {check.samples} of {check.of} poses across {across} checked{check.collisions.length ? '' : ', no collisions in those'}</span>}
      {check.clear && !incomplete
        ? <span><b>{drive.joint}</b>: no collisions across {across} ({check.samples} poses checked)</span>
        : check.collisions.map((hit) => (
          <span key={`${hit.a}:${hit.b}`}><b>{hit.a}</b> hits <b>{hit.b}</b> at {hit.spans.map(span).join(', ')}
            <button type="button" className={styles.checkJump} onClick={() => show((hit.spans[0][0] + hit.spans[0][1]) / 2)}>show</button></span>
        ))}
      {check.at_rest.length > 0 && <span className={styles.muted}>Already overlapping at rest (not counted): {check.at_rest.map((pair) => `${pair.a} / ${pair.b}`).join(', ')}</span>}
      {check.note && <span className={styles.muted}>{check.note}</span>}
      {check.reused && <span className={styles.muted} data-check-reused>{REUSED}</span>}
    </div>
  );
}

const percent = (fraction: number) => `${num(fraction * 100, 1)} %`;

/** The study's results as JSON, with the document and revision they come from. */
function downloadStudy(study: CollisionStudy) {
  const { doc } = useApp.getState();
  const blob = new Blob([JSON.stringify({ document: doc.name, branch: doc.branch, revision: doc.saved?.revision ?? null, study }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(doc.name || 'design').replace(/[^\w.-]+/g, '_')}-${study.name}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/**
 * What a collision study found across joint space: the share of poses that collide, the pairs ranked by how much
 * of it they block, and a stepper that moves the mechanism to each colliding pose (its pair turns red).
 */
function StudyReport({ study }: { study: CollisionStudy }) {
  const [step, setStep] = useState(-1);
  const listed = study.poses.length;
  const show = (next: number) => { setStep(next); applyValues(studyValues(study, study.poses[next])); };
  const current = study.poses[step];
  const contact = (value: number | null | undefined) => (value === null || value === undefined ? 'clear' : num(value));
  const depth = (pose: StudyPose, index: number) => (pose.depth_mm ? ` (${num(pose.depth_mm[index], 2)} mm deep)` : '');
  const incomplete = cutShort(study);
  const found = study.colliding > 0;
  return (
    <div className={styles.check} data-study={study.name} data-clear={(study.clear && !incomplete) || undefined} data-incomplete={(incomplete && !found) || undefined}>
      <span><b>{study.name}</b>: {incomplete && !found ? `Incomplete, no collisions in ${study.samples} of ${study.of} poses checked`
        : study.clear && !incomplete ? `no collisions in ${study.samples} poses` : `${study.colliding} of ${study.samples} poses collide (${percent(study.fraction)}`
        + `${study.interval ? `, 95 % ${percent(study.interval[0])}–${percent(study.interval[1])}` : ''})`}{' '}
        {study.animation ? `through ${study.animation}${study.at === 'keys' ? ' at its keys' : ''}${study.between ? ` from ${num(study.between[0])} to ${num(study.between[1])} s` : ''}`
          : `across ${study.joints.join(', ')}`}{incomplete && found ? `; incomplete, ${study.samples} of ${study.of} poses checked` : ''}</span>
      {study.pairs.map((pair) => {
        const deepest = study.poses.findIndex((pose) => pose.index === (pair.deepest ?? pair.first));
        return (
          <span key={`${pair.a}:${pair.b}`} data-study-pair={`${pair.a} ${pair.b}`}><b>{pair.a}</b> hits <b>{pair.b}</b> in {percent(pair.fraction)} of poses
            {pair.depth_mm && `, up to ${num(pair.depth_mm.max, 2)} mm deep (median ${num(pair.depth_mm.median, 2)}, p95 ${num(pair.depth_mm.p95, 2)})`}
            {deepest >= 0 && <button type="button" className={styles.checkJump} onClick={() => show(deepest)} title="Move to the pose where this pair overlaps deepest">show</button>}</span>
        );
      })}
      {listed > 0 && (
        <span className={styles.studyStep}>
          <IconButton small label="Previous colliding pose" onClick={() => show(step <= 0 ? listed - 1 : step - 1)}><ChevronLeft size={13} /></IconButton>
          <span>{current ? `${current.time !== undefined ? `At ${num(current.time)} s` : `Pose ${step + 1} of ${listed}`}: ${current.pairs.map(([a, b], index) => `${a} / ${b}${depth(current, index)}`).join(', ')}` : `Step through ${listed} colliding pose${listed === 1 ? '' : 's'}`}</span>
          <IconButton small label="Next colliding pose" onClick={() => show((step + 1) % listed)}><ChevronRight size={13} /></IconButton>
        </span>
      )}
      {study.map && <StudyMapView study={study} map={study.map} />}
      {!!study.shapes?.length && (
        <span className={styles.muted}>Collision shapes against the exact solids: {study.shapes.map((score) => `${score.a} / ${score.b}: detect `
          + `${score.detection_rate === null ? '–' : percent(score.detection_rate)}, false alarms ${score.false_positive_rate === null ? '–' : percent(score.false_positive_rate)}`
          + `${score.missed !== undefined ? `, misses up to ${num(score.missed_depth_mm, 2)} mm` : ''}`).join(' · ')}</span>
      )}
      {study.boundary && (
        <span className={styles.muted}>First contact of {study.boundary.moving} (below / above {num(study.boundary.from)}) as {study.boundary.joint} moves:{' '}
          {study.boundary.rows.map((row) => `${num(row.at)} → ${row.start ? 'colliding' : `${contact(row.below)} / ${contact(row.above)}`}`).join(' · ')}</span>
      )}
      {!!study.near?.length && <span className={styles.muted}>Closer than {num(study.clearance_mm ?? 0)} mm: {study.near.map((pair) => `${pair.a} / ${pair.b} (${num(pair.min_distance_mm ?? 0)} mm`
        + `${pair.time !== undefined ? ` at ${num(pair.time)} s` : ''})`).join(', ')}</span>}
      {!!study.clearances?.length && (
        <span data-study-clearances>Closest approach: {study.clearances.map((gap) => `${gap.a} / ${gap.b} ${gap.min_distance_mm === null ? 'not measured (out of time)'
          : gap.colliding ? `collides in ${gap.colliding} pose${gap.colliding === 1 ? '' : 's'}` : `${num(gap.min_distance_mm, 2)} mm`}`
          + `${gap.time !== undefined && !gap.colliding ? ` at ${num(gap.time)} s` : ''}`).join(' · ')}</span>
      )}
      {study.at_rest.length > 0 && <span className={styles.muted}>Already overlapping at rest (not counted): {study.at_rest.map((pair) => `${pair.a} / ${pair.b}`).join(', ')}</span>}
      {study.note && <span className={styles.muted}>{study.note}</span>}
      {study.reused && <span className={styles.muted} data-check-reused>{REUSED}</span>}
      <span><button type="button" className={styles.checkJump} onClick={() => downloadStudy(study)} title="The full results as JSON: pairs, depths, witness points, colliding poses, map, marginals and boundary">Download results</button></span>
    </div>
  );
}

const MAP_COLORS = ['#ff4d4f', '#ff9f1a', '#b56cff', '#2f9bff', '#e8590c', '#d6336c'];

/** A study's map over two joints: each cell coloured by the pair that collides most there (fainter where only some poses collide); click to move there. */
function StudyMapView({ study, map }: { study: CollisionStudy; map: StudyMap }) {
  const color = (pair: number) => MAP_COLORS[pair % MAP_COLORS.length];
  const rows = map.cells.map((row, y) => ({ row, y })).reverse(); // Higher values of y on top.
  const used = [...new Set(map.cells.flat().filter(([, , pair]) => pair >= 0).map(([, , pair]) => pair))].sort((a, b) => a - b);
  return (
    <span className={styles.studyMapBlock} data-study-map={`${map.x} ${map.y}`}>
      <span className={styles.muted}>{map.y} (up) against {map.x} (across){map.binned ? ', binned over the random poses' : ''}:
        {used.map((pair) => <span key={pair}><span className={styles.studyMapKey} style={{ background: color(pair) }} />{study.pairs[pair]?.a} / {study.pairs[pair]?.b}</span>)}</span>
      <span className={styles.studyMap} style={{ gridTemplateColumns: `repeat(${map.xs.length}, 1fr)` }}>
        {rows.flatMap(({ row, y }) => row.map(([count, hits, pair], x) => (
          <button key={`${x}:${y}`} type="button" className={styles.studyMapCell} data-cell={`${x} ${y}`}
            style={pair >= 0 ? { background: color(pair), opacity: 0.35 + 0.65 * (hits / Math.max(count, 1)) } : undefined}
            title={`${map.x} ${num(map.xs[x])}, ${map.y} ${num(map.ys[y])}: ${count ? `${hits} of ${count} pose${count === 1 ? '' : 's'} collide` : 'not checked'}`
              + `${pair >= 0 ? ` (${study.pairs[pair]?.a} / ${study.pairs[pair]?.b})` : ''}`}
            onClick={() => applyValues({ ...study.hold, [map.x]: map.xs[x], [map.y]: map.ys[y] })} />
        )))}
      </span>
      <span className={styles.studyMapAxis}><span>{num(map.xs[0])}</span><span>{map.x}</span><span>{num(map.xs[map.xs.length - 1])}</span></span>
    </span>
  );
}

/** Where a fit pair is worst, in words: as modelled, a named pose, or joint values. */
function fitWhen(pair: Pick<FitPair, 'when'>): string {
  if ('pose' in pair.when) return pair.when.pose === 'rest' ? 'as modelled' : `at ${pair.when.pose}`;
  return `at ${Object.entries(pair.when.values).map(([target, value]) => `${target} ${num(value)}`).join(', ')}`;
}

/** What a pair's numbers say: its overlap (exact common volume), or its gap against the clearance it needs. */
function fitAmount(pair: FitPair): string {
  if (pair.unverified) return 'the exact check failed (not known to be clear)';
  if (pair.overlap_mm3) return `overlap ${num(pair.overlap_mm3, 3)} mm³${pair.contact ? ` (${pair.contact}, allows ${pair.allowance_mm3 ?? 'any'} mm³)` : ''}`;
  return pair.contact ? `touch (${pair.contact})` : `gap ${num(pair.min_distance_mm, 3)} mm, needs ${num(pair.clearance_mm)} mm`;
}

/**
 * What a fit check found: pairs that overlap or come closer than their clearance, worst first, each with a button that
 * moves the mechanism to where it's worst (the pair turns red), then declared contacts, and those that don't touch with
 * their gap and where it's smallest. inspect_model compares them with
 * an earlier revision.
 */
function FitReport({ fit }: { fit: FitCheck }) {
  const kinematics = useMotion((s) => s.kinematics);
  if (!kinematics) return null;
  const row = (pair: FitPair) => (
    <span key={`${pair.a}:${pair.b}`} data-fit-pair={`${pair.a} ${pair.b}`}><b>{pair.a}</b> / <b>{pair.b}</b>: {fitAmount(pair)} {fitWhen(pair)}{pair.approximate ? ' (approximate)' : ''}
      <button type="button" className={styles.checkJump} onClick={() => applyValues(fitValues(kinematics, pair))}>show</button></span>
  );
  const incomplete = fitCutShort(fit);
  const found = fit.issues.length > 0;
  const skipped = [...(fit.unchecked?.poses ?? []).map((pose) => (pose === 'rest' ? 'as modelled' : pose)), ...(fit.unchecked?.sweeps ?? []).map((target) => `${target} swept`)];
  const swept = (sweep: FitCheck['sweeps'][number]) => `${sweep.target} swept${sweep.complete === false && sweep.of ? ` (${sweep.samples} of ${sweep.of} steps)` : ''}`;
  return (
    <div className={styles.check} data-fit={fit.name} data-clear={(fit.clear && !incomplete) || undefined} data-incomplete={(incomplete && !found) || undefined}>
      <span><b>{fit.name}</b>: {found ? `${fit.issues.length} pair${fit.issues.length === 1 ? '' : 's'} overlap or are too close`
        : incomplete ? `Incomplete, no overlaps or tight gaps so far in ${fit.pairs_checked} pairs` : fit.clear ? `fits: no overlaps or tight gaps in ${fit.pairs_checked} pairs`
        : `${fit.issues.length} pairs overlap or are too close`}
        {' '}({[...fit.poses.map((pose) => (pose === 'rest' ? 'as modelled' : pose)), ...fit.sweeps.map(swept)].join(', ') || 'nothing checked'})</span>
      {incomplete && <span data-fit-unchecked>{found ? 'Incomplete: ' : ''}{skipped.length ? `not checked: ${skipped.join(', ')}` : 'not every pose and sweep was checked'}</span>}
      {fit.issues.map(row)}
      {fit.intended.length > 0 && <span className={styles.muted}>Declared contacts: {fit.intended.map((pair) => `${pair.a} / ${pair.b}`).join(', ')}</span>}
      {(fit.touching ?? []).length > 0 && (
        <span className={styles.muted} data-fit-touching>
          Touching ({fit.touching_count ?? fit.touching!.length}): {fit.touching!.map((pair) => `${pair.a} / ${pair.b}${'pose' in pair.when && pair.when.pose === 'rest' ? '' : ` ${fitWhen(pair)}`}`).join(', ')}
          {(fit.touching_count ?? 0) > fit.touching!.length ? ', …' : ''}
        </span>
      )}
      {(fit.contacts ?? []).filter((contact) => contact.touching === false && contact.closest).map((contact) => {
        const near = contact.closest!;
        return (
          <span key={`contact:${contact.a}:${contact.b}`} data-fit-unseated={`${near.a} ${near.b}`}>
            <b>{near.a}</b> / <b>{near.b}</b>: declared {contact.kind} but not touching, gap {near.at_least ? 'at least ' : ''}{num(near.min_distance_mm, 3)} mm {fitWhen(near)}
            <button type="button" className={styles.checkJump} onClick={() => applyValues(fitValues(kinematics, near))}>show</button></span>
        );
      })}
      {fit.note && <span className={styles.muted}>{fit.note}</span>}
      {fit.reused && <span className={styles.muted} data-check-reused>{REUSED}</span>}
    </div>
  );
}

/** Where a cable was checked, in words: as modelled, a named pose, a drive value, an animation time or a study pose. */
function cableWhen(when: CableWhen): string {
  if (when.pose) return when.pose === 'rest' ? 'as modelled' : `at ${when.pose}`;
  if (when.drive) return `at ${when.drive} ${num(when.values[when.drive] ?? 0)}`;
  if (when.animation) return `at ${num(when.time ?? 0)} s of ${when.animation}`;
  if (when.study) return `in study ${when.study}, pose ${(when.index ?? 0) + 1}`;
  return '';
}

/**
 * What the build found for a cable through the mechanism's motion: its worst contact, clearance, cable-to-cable gap,
 * connector, bend and length problems, each with a button that moves the mechanism there, and a stepper through the
 * failing poses; or, when it passes, its closest part, tightest bend and length range.
 */
function CableCheck({ cable }: { cable: Cable }) {
  const kinematics = useMotion((s) => s.kinematics);
  const [step, setStep] = useState(-1);
  if (!kinematics) return null;
  const failing = cable.failing ?? [];
  const show = (when: CableWhen) => applyValues(cableValues(kinematics, when));
  const move = (next: number) => { setStep(next); show(failing[next].when); };
  const bend = cable.bend?.min_radius_mm;
  const facts = [
    cable.closest && `closest ${cable.closest.part} ${num(cable.closest.gap_mm)} mm`,
    bend != null && `tightest bend ${num(bend)} mm`,
    cable.lengths && `path ${num(cable.lengths.min_mm, 0)}–${num(cable.lengths.max_mm, 0)} mm`,
    cable.cut_length_mm != null && `cut ${cable.cut_length_mm} mm`,
  ].filter(Boolean).join(', ');
  return (
    <div className={styles.check} data-cable={cable.name} data-clear={cable.status === 'pass' || undefined}>
      <span><b>{cable.name}</b>{cable.harness ? ` (${cable.harness})` : ''}: {cable.status === 'pass' ? `clear in ${cable.poses ?? 0} poses` : cable.status === 'unchecked'
        ? 'not checked (out of time)' : `fails in ${cable.failing_poses ?? 0} of ${cable.poses ?? 0} poses`}{facts ? ` · ${facts}` : ''}</span>
      {cable.findings.map((finding) => (
        <span key={`${finding.check}:${finding.part ?? finding.other ?? finding.end ?? ''}`} data-cable-finding={finding.check}>{finding.message}{finding.when ? ` ${cableWhen(finding.when)}` : ''}
          {finding.when && <button type="button" className={styles.checkJump} onClick={() => show(finding.when!)}>show</button>}</span>
      ))}
      {failing.length > 1 && (
        <span className={styles.studyStep}>
          <IconButton small label="Previous failing pose" onClick={() => move(step <= 0 ? failing.length - 1 : step - 1)}><ChevronLeft size={13} /></IconButton>
          <span>{failing[step] ? `Pose ${step + 1} of ${failing.length}: ${failing[step].checks.join(', ')} ${cableWhen(failing[step].when)}` : `Step through ${failing.length} failing poses`}</span>
          <IconButton small label="Next failing pose" onClick={() => move((step + 1) % failing.length)}><ChevronRight size={13} /></IconButton>
        </span>
      )}
      {!!cable.studies?.length && <span className={styles.muted}>{cable.studies.map((study) => `${study.name}: fails in ${percent(study.fraction)} of poses`).join(' · ')}</span>}
    </div>
  );
}

/** Properties → Motion, for a design with joints. */
export function MotionSection() {
  const kinematics = useMotion((s) => s.kinematics);
  if (!kinematics) return null;
  return (
    <Section title="Motion" id="motion">
      <MotionPlayer />
      <Animations />
      <ModeSelect />
      {!!kinematics.couplings?.length && (
        <div className={styles.joints} id="motion-couplings">
          {kinematics.couplings.map((coupling) => <CouplingControl key={coupling.name} coupling={coupling} />)}
        </div>
      )}
      <div className={styles.joints}>
        {kinematics.joints.map((joint) => <JointControl key={joint.name} joint={joint} />)}
      </div>
      {kinematics.ground.length > 0 && <p className={styles.hint}>Grounded: {kinematics.ground.join(', ')}</p>}
    </Section>
  );
}

/** Properties for the selected joint. */
export function JointInspector({ name }: { name: string }) {
  const joint = useMotion((s) => s.kinematics?.joints.find((j) => j.name === name));
  const coupling = useMotion((s) => s.kinematics?.couplings?.find((c) => c.name === name));
  const drive = useMotion((s) => s.kinematics?.drives.find((d) => d.joint === name));
  if (coupling) return <CouplingInspector coupling={coupling} />;
  if (!joint) return null;
  const Icon = JOINT_ICONS[joint.type];
  return (
    <>
      <button type="button" className={styles.back} onClick={() => selectJoint(null)} id="joint-back"><ChevronLeft size={13} />Design</button>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Icon size={19} /></div>
        <div>
          <div className={styles.heroTitle} id="selection-name">{joint.name}</div>
          <div className={styles.heroSub}><span id="selection-type">{JOINT_LABELS[joint.type]} joint</span> · {joint.parent} → {joint.child}</div>
        </div>
      </div>
      <Section title="Position">
        <JointControl joint={joint} />
        <MotionPlayer />
      </Section>
      <Section title="Definition">
        <dl className={styles.rows}>
          <div><dt>Parent</dt><dd>{joint.parent}</dd></div>
          <div><dt>Child</dt><dd>{joint.child}</dd></div>
          {joint.type !== 'rigid' && <div><dt>Axis</dt><dd>({joint.axis.map((v) => num(v, 3)).join(', ')})</dd></div>}
          {joint.type !== 'rigid' && <div><dt>Through</dt><dd>({joint.origin.map((v) => num(v)).join(', ')}) mm</dd></div>}
          {joint.limits && <div><dt>Limits</dt><dd>{num(joint.limits[0])} … {num(joint.limits[1])} {unitOf(joint)}</dd></div>}
          {joint.slide_limits && <div><dt>Travel</dt><dd>{num(joint.slide_limits[0])} … {num(joint.slide_limits[1])} mm</dd></div>}
          {!!joint.driven_by?.length && <div><dt>{joint.follows ? 'Follows' : 'Driven by'}</dt><dd>{joint.driven_by.join(', ')}</dd></div>}
        </dl>
        <div className={styles.inspectorActions}>
          <Button size="sm" icon={<Pencil />} onClick={() => openJointTool(joint.name)} id="joint-edit">Edit joint</Button>
          {joint.type !== 'rigid' && (!joint.follows || !!drive) && <Button size="sm" icon={<Gauge />} onClick={() => openMotionTool('motor', drive ? joint.name : undefined)} id="joint-motor">{drive ? 'Edit motor' : 'Add motor'}</Button>}
          <Button size="sm" variant="ghost" icon={<Code2 />} onClick={() => showJointCode(joint.name)}>Show code</Button>
        </div>
      </Section>
    </>
  );
}

/** Properties for a selected coupling: its value, what it gears and by how much. */
function CouplingInspector({ coupling }: { coupling: MotionCoupling }) {
  const kinematics = useMotion((s) => s.kinematics);
  const drive = useMotion((s) => s.kinematics?.drives.find((d) => d.joint === coupling.name));
  const unit = kinematics ? couplingUnit(kinematics, coupling) : '';
  return (
    <>
      <button type="button" className={styles.back} onClick={() => selectJoint(null)} id="joint-back"><ChevronLeft size={13} />Design</button>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Cog size={19} /></div>
        <div>
          <div className={styles.heroTitle} id="selection-name">{coupling.name}</div>
          <div className={styles.heroSub}><span id="selection-type">Coupling</span> · {Object.keys(coupling.gears).length} joints in fixed ratios</div>
        </div>
      </div>
      <Section title="Position">
        <CouplingControl coupling={coupling} />
        <MotionPlayer />
      </Section>
      <Section title="Gears">
        <dl className={styles.rows} id="coupling-gears">
          {Object.entries(coupling.gears).map(([key, ratio]) => <div key={key}><dt>{key}</dt><dd>× {num(ratio, 4)}</dd></div>)}
          {coupling.limits && <div><dt>Limits</dt><dd>{num(coupling.limits[0])} … {num(coupling.limits[1])}{unit}</dd></div>}
          {coupling.bounds && <div><dt>Range</dt><dd>{num(coupling.bounds[0])} … {num(coupling.bounds[1])}{unit}</dd></div>}
        </dl>
        <p className={styles.hint}>Each joint moves by the coupling’s value × its ratio, on top of its own position. Drag any geared joint to turn the whole train.</p>
        <div className={styles.inspectorActions}>
          <Button size="sm" icon={<Pencil />} onClick={() => openMotionTool('couple', coupling.name)} id="coupling-edit">Edit gears</Button>
          <Button size="sm" icon={<Gauge />} onClick={() => openMotionTool('motor', drive ? coupling.name : undefined)} id="coupling-motor">{drive ? 'Edit motor' : 'Add motor'}</Button>
          <Button size="sm" variant="ghost" icon={<Code2 />} onClick={() => showJointCode(coupling.name)}>Show code</Button>
        </div>
      </Section>
    </>
  );
}
