/**
 * Over the viewport while a result shows: the probe reading under the pointer and the animation bar, and while the
 * inspector is closed a slim colour key. The legend, the study's state and the display settings are in the inspector
 * (ResultsLegend, StudyInspector), as is the all-studies view: nothing here covers the model or takes a
 * click meant for it, other than the key's own hide button and the animation bar.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Circle, EyeOff, Pause, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import { Segmented } from '@/ui';
import { useApp } from '@/state/store';
import { visibleFields } from './api';
import { css, legendGradient } from './colormap';
import { legendModel } from './legend';
import { legendKey, ZONE } from './ResultsLegend';
import { animationKind, SAFETY_CAP, useSimulation, type Playback } from './state';
import { useOverviewScales } from './StudiesOverview';
import { show } from './units';
import sim from './Simulate.module.css';

const mm = (value: number) => (Math.abs(value) < 0.05 ? '0' : value.toFixed(Math.abs(value) >= 100 ? 0 : 1));

interface KeyRow { key: string; title: string; background: string; low: string; high: string }

/**
 * The colours' meaning while the inspector (with the full legend) is closed, on a phone say: one thin bar per scale
 * with its ends, small, in the corner, letting every click through but its hide button (Display, in the inspector,
 * brings it back). Not drawn while the inspector shows the legend.
 */
function ColourKey({ overview }: { overview: boolean }) {
  const inspector = useApp((s) => s.dockOpen && s.dockTab === 'properties');
  const wanted = useSimulation((s) => s.colourKey);
  const studyName = useApp((s) => s.studies.find((item) => item.id === s.activeStudy)?.name);
  const scales = useOverviewScales();
  useSimulation(legendKey);
  if (inspector || !wanted) return null;
  let rows: KeyRow[] = [];
  if (overview) rows = scales.map((scale) => ({ key: scale.key, title: scale.title, background: scale.background, low: scale.low, high: scale.high }));
  else {
    const model = legendModel(studyName);
    if (model) {
      const zones = [...model.zones].reverse();
      const background = zones.length
        ? `linear-gradient(to right, ${zones.map((zone, i) => `${css(ZONE[zone.color])} ${(i / zones.length) * 100}% ${((i + 1) / zones.length) * 100}%`).join(', ')})`
        : legendGradient(model.palette, model.banded, 'to right', model.bands);
      const title = `${model.title}${model.subtitle && model.subtitle.length <= 12 ? ` (${model.subtitle})` : ''}`;
      rows = [{ key: 'result', title, background, low: zones.length ? zones[0].label.split('  ')[0] : model.labels.at(-1) ?? '', high: zones.length ? zones.at(-1)!.label.split('  ')[0] : model.labels[0] ?? '' }];
    }
  }
  if (!rows.length) return null;
  return (
    <div className={sim.colourKey} id="results-colour-key" aria-label="Colour key">
      {rows.map((row) => <div key={row.key} className={sim.keyRow}>
        <span className={sim.keyTitle}>{row.title}</span>
        <div className={sim.keyBar} style={{ background: row.background }} />
        <span className={sim.keyEnds}><span>{row.low}</span><span>{row.high}</span></span>
      </div>)}
      <button type="button" className={sim.keyHide} aria-label="Hide the colour key" title="Hide the colour key (the full legend is in the inspector)"
        onClick={() => useSimulation.setState({ colourKey: false })}><EyeOff size={12} /></button>
    </div>
  );
}

function Readout() {
  const root = useRef<HTMLDivElement>(null);
  const probe = useSimulation((s) => s.probe);
  const result = useSimulation((s) => s.result);
  const field = useSimulation((s) => s.field);
  const region = useSimulation((s) => s.region);
  if (!probe || !result) return <div ref={root} />;
  const rect = root.current?.parentElement?.getBoundingClientRect();
  const left = probe.clientX - (rect?.left ?? 0) + 16, top = probe.clientY - (rect?.top ?? 0) + 16;
  const unit = field === 'safety' ? '' : visibleFields(result.manifest, region)[field]?.units;
  const shown = field === 'safety' ? { value: probe.value >= SAFETY_CAP ? `≥ ${SAFETY_CAP}` : probe.value.toPrecision(3), unit: '' }
    : show(probe.value, unit, !!result.manifest.engine.openfoam);
  return (
    <div ref={root} className={sim.readout} style={{ left, top }} role="status" aria-label="Probe" data-inside={probe.inside || undefined}>
      <b>{shown.value}{shown.unit ? ` ${shown.unit}` : ''}</b>
      <span>{probe.inside ? 'Inside, on the section · ' : ''}x {mm(probe.at[0])} · y {mm(probe.at[1])} · z {mm(probe.at[2])} mm</span>
    </div>
  );
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** Seconds since `since`, ticking while set. */
function useSeconds(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** Plays the deformation, a mode shape or transient steps; records the viewport to WebM. */
function AnimationBar() {
  const s = useSimulation();
  const manifest = s.result?.manifest;
  const kind = animationKind(manifest, s.field);
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(s.recording ? Date.now() : null); }, [s.recording]);
  const seconds = useSeconds(since);
  if (!manifest || !kind || s.field === 'mesh' && kind !== 'frames') return null;
  const frames = manifest.frames?.length ?? 0;
  const step = (direction: number) => {
    if (kind === 'frames') useSimulation.setState({ playing: false, frame: Math.min(frames - 1, Math.max(0, s.frame + direction)) });
    else useSimulation.setState({ playing: false, phase: (((s.phase ?? (kind === 'mode' ? 0.25 : s.playback === 'mirror' ? 0.5 : 1)) + direction / 24) % 1 + 1) % 1 });
  };
  const toggle = () => {
    if (s.playing) { useSimulation.setState({ playing: false }); return; }
    // Once played to its end, play starts over.
    const done = kind === 'frames' ? s.playback === 'once' && s.frame >= frames - 1 : s.playback === 'once' && s.phase === 1;
    useSimulation.setState({ playing: true, ...(done ? (kind === 'frames' ? { frame: 0 } : { phase: 0 }) : {}) });
  };
  const progress = kind === 'frames' ? (frames > 1 ? s.frame / (frames - 1) : 1) : (s.phase ?? 1);
  const label = kind === 'frames' ? `Step ${s.frame + 1} of ${frames} · ${manifest.frames![s.frame]?.label ?? `${Number((manifest.frames![s.frame]?.time_s ?? 0).toPrecision(4))} s`}`
    : kind === 'mode' ? `Mode ${manifest.modes?.find((mode) => mode.field === s.field)?.number ?? ''} shape` : 'Deformation';
  const record = () => useSimulation.setState((state) => ({ recording: !state.recording, ...(!state.recording && !state.playing ? { playing: true, ...(kind === 'frames' ? {} : { phase: 0 }) } : {}) }));
  return (
    <motion.div className={sim.player} id="results-player" role="toolbar" aria-label="Results animation" data-kind={kind}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.2 }}>
      <button type="button" aria-label="Previous step" title="Step back" onClick={() => step(-1)}><SkipBack size={14} /></button>
      <button type="button" className={sim.playButton} aria-label={s.playing ? 'Pause animation' : 'Play animation'} data-playing={s.playing || undefined} onClick={toggle}>
        {s.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button type="button" aria-label="Next step" title="Step forward" onClick={() => step(1)}><SkipForward size={14} /></button>
      <span className={sim.playerLabel}>{label}<i className={sim.progress}><i style={{ width: `${Math.round(progress * 100)}%` }} /></i></span>
      <Segmented size="sm" value={s.playback} onChange={(playback) => useSimulation.setState({ playback: playback as Playback })}
        options={[{ value: 'mirror', label: 'Mirror' }, { value: 'loop', label: 'Loop' }, { value: 'once', label: 'Once' }]} />
      <select aria-label="Animation speed" value={s.speed} onChange={(event) => useSimulation.setState({ speed: Number(event.target.value) })}>
        {SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
      </select>
      <span className={sim.playerSep} />
      <button type="button" className={sim.recordButton} aria-label={s.recording ? 'Stop recording' : 'Record video'} data-recording={s.recording || undefined} onClick={record}
        title={s.recording ? 'Stop and save the video (WebM)' : 'Record the viewport to a WebM video'}>
        {s.recording ? <><Square size={11} fill="currentColor" />{`0:${String(seconds).padStart(2, '0')}`}</> : <><Circle size={11} fill="currentColor" />Record</>}
      </button>
    </motion.div>
  );
}

export default function ResultsOverlay() {
  const workspace = useApp((s) => s.workspace);
  const result = useSimulation((s) => !!s.result);
  const overview = useApp((s) => s.studyOverview);
  const showing = result && !overview;
  // Leaving results stops what plays and records.
  useEffect(() => { if (!showing || workspace !== 'simulate') useSimulation.setState({ playing: false, recording: false }); }, [showing, workspace]);
  if (workspace === 'simulate' && overview) return <div className={sim.overlay}><ColourKey overview /></div>;
  if (workspace !== 'simulate' || !showing) return null;
  return <div className={sim.overlay}>
    <ColourKey overview={false} />
    <Readout />
    <AnimatePresence><AnimationBar /></AnimatePresence>
  </div>;
}
