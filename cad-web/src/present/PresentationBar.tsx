/**
 * Presentation view's player, bottom centre over the canvas: play, the scrubber and time, which motion (when there are
 * several), speed, loop, Record, what the picture shows, and Exit. It and the cursor fade after two seconds without the
 * pointer moving and come back when it moves; faded, it takes no clicks, so the whole canvas is the model's.
 */
import { useEffect, useRef, useState } from 'react';
import { CircleDot, Grid3x3, Move3d, Pause, Play, Repeat, SlidersHorizontal, X } from 'lucide-react';
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select, Tip } from '@/ui';
import { FitIcon, ShadedEdgesIcon, ViewCubeIcon } from '@/icons/cad';
import { get as getApp, set as setApp, useApp } from '@/state/store';
import { num } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import { setSpeedScale, useMotion } from '@/motion/state';
import { chooseTake, exitPresentation, presentTake, presentTakes, seekTo, togglePlaying, usePresent } from './state';
import styles from './Present.module.css';

const IDLE_MS = 2000;
const SPEEDS = [{ value: '0.25', label: '¼×' }, { value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }];

/** The bar and cursor fade when the pointer rests, unless the pointer is on the bar or one of its menus is open. */
function useAwake(bar: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let timer = 0;
    const holding = () => !!bar.current?.matches(':hover') || !!document.querySelector('[role="menu"], [role="listbox"]') || !!getApp().dialog;
    const sleep = () => { if (holding()) timer = window.setTimeout(sleep, IDLE_MS); else usePresent.setState({ awake: false }); };
    const wake = () => {
      if (!usePresent.getState().awake) usePresent.setState({ awake: true });
      window.clearTimeout(timer);
      timer = window.setTimeout(sleep, IDLE_MS);
    };
    wake();
    const events = ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const;
    // Capturing, so the canvas's own handlers (the camera's drag) can't keep a touch or click from waking it.
    for (const event of events) window.addEventListener(event, wake, { passive: true, capture: true });
    return () => { window.clearTimeout(timer); for (const event of events) window.removeEventListener(event, wake, { capture: true }); };
  }, [bar]);
}

function Scrubber({ duration }: { duration: number }) {
  const t = usePresent((state) => state.t);
  const track = useRef<HTMLDivElement>(null);
  const at = (x: number) => {
    const rect = track.current!.getBoundingClientRect();
    return ((x - rect.left) / Math.max(1, rect.width)) * duration;
  };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    seekTo(at(event.clientX));
    const move = (e: PointerEvent) => seekTo(at(e.clientX));
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  };
  const key = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowLeft') seekTo(t - step);
    else if (event.key === 'ArrowRight') seekTo(t + step);
    else if (event.key === 'Home') seekTo(0);
    else if (event.key === 'End') seekTo(duration);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const fraction = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0;
  return (
    <div ref={track} className={styles.scrub} role="slider" tabIndex={0} aria-label="Time" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Number(t.toFixed(2))}
      aria-valuetext={`${num(t, 1)} of ${num(duration, 1)} seconds`} id="present-scrub" onPointerDown={down} onKeyDown={key}>
      <span className={styles.rail}><span className={styles.fill} style={{ width: `${fraction * 100}%` }} /></span>
      <span className={styles.thumb} style={{ left: `${fraction * 100}%` }} />
    </div>
  );
}

function PictureMenu() {
  const grid = useApp((state) => state.showGrid);
  const style = useApp((state) => state.style);
  const cube = usePresent((state) => state.cube);
  const triad = usePresent((state) => state.triad);
  const edges = style !== 'shaded';
  return (
    <Menu>
      <Tip label="Picture" description="What the view (and a video) shows.">
        <MenuTrigger asChild>
          <button type="button" className={styles.button} aria-label="Picture" id="present-picture"><SlidersHorizontal size={16} /></button>
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="end" sideOffset={10}>
        <MenuLabel>Show</MenuLabel>
        <MenuItem icon={<Grid3x3 size={15} />} checked={grid} onSelect={() => setApp({ showGrid: !grid })}>Ground grid</MenuItem>
        <MenuItem icon={<ShadedEdgesIcon size={15} />} checked={edges} onSelect={() => setApp({ style: edges ? 'shaded' : 'shaded-edges' })}>Edges</MenuItem>
        <MenuItem icon={<ViewCubeIcon size={15} />} checked={cube} onSelect={() => usePresent.setState({ cube: !cube })}>View cube</MenuItem>
        <MenuItem icon={<Move3d size={15} />} checked={triad} onSelect={() => usePresent.setState({ triad: !triad })}>Axis triad</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<FitIcon size={15} />} shortcut="F" onSelect={() => viewer.fit()}>Fit all</MenuItem>
      </MenuContent>
    </Menu>
  );
}

export default function PresentationBar() {
  const bar = useRef<HTMLDivElement>(null);
  useAwake(bar);
  const awake = usePresent((state) => state.awake);
  const playing = usePresent((state) => state.playing);
  const loop = usePresent((state) => state.loop);
  const key = usePresent((state) => state.take);
  const t = usePresent((state) => state.t);
  const kinematics = useMotion((state) => state.kinematics);
  const speed = useMotion((state) => state.speedScale);
  const [, refresh] = useState(0);
  useEffect(() => useMotion.subscribe((state, before) => { if (state.kinematics !== before.kinematics) refresh((n) => n + 1); }), []);
  const takes = kinematics ? presentTakes() : [];
  const take = takes.length ? presentTake() : null;
  return (
    <div ref={bar} className={styles.bar} data-awake={awake || undefined} role="toolbar" aria-label="Presentation" id="present-bar">
      {take && (
        <>
          <IconButton label={playing ? 'Pause' : 'Play'} shortcut="Space" onClick={togglePlaying} id="present-play">{playing ? <Pause size={16} /> : <Play size={16} />}</IconButton>
          <Scrubber duration={take.duration} />
          <span className={styles.time} id="present-time">{num(t, 1)} / {num(take.duration, 1)} s</span>
          {takes.length > 1 && (
            <div className={styles.take}>
              <Select ariaLabel="Motion" id="present-take" value={key ?? take.key} onChange={chooseTake}
                options={takes.map((item) => ({ value: item.key, label: item.name, hint: item.kind === 'motor' ? 'motor' : `${item.kind === 'explode' ? 'explode · ' : ''}${num(item.duration)} s` }))} />
            </div>
          )}
          <Menu>
            <Tip label="Speed"><MenuTrigger asChild><button type="button" className={styles.speed} aria-label="Speed" id="present-speed">{SPEEDS.find((item) => Number(item.value) === speed)?.label ?? `${speed}×`}</button></MenuTrigger></Tip>
            <MenuContent side="top" align="center" sideOffset={10}>
              <MenuLabel>Speed</MenuLabel>
              {SPEEDS.map((item) => <MenuItem key={item.value} checked={Number(item.value) === speed} onSelect={() => setSpeedScale(Number(item.value))}>{item.label}</MenuItem>)}
            </MenuContent>
          </Menu>
          <IconButton label={loop ? 'Looping' : 'Plays once'} description="Click to change" active={loop} onClick={() => usePresent.setState({ loop: !loop })} id="present-loop"><Repeat size={15} /></IconButton>
          <IconButton label="Record video…" description="An MP4 of this motion, framed like this view." onClick={() => setApp({ dialog: 'video' })} id="present-record" className={styles.record}><CircleDot size={16} /></IconButton>
          <span className={styles.sep} />
        </>
      )}
      <PictureMenu />
      <IconButton label="Exit presentation" shortcut="Esc" onClick={exitPresentation} id="present-exit"><X size={16} /></IconButton>
    </div>
  );
}
