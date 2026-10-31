/**
 * The animation timeline under the viewport (Motion tab): the design's keyframed animations
 * (`design.animation`) and explodes (`design.explode`) on a time ruler. Scrub the playhead, play, loop; drag a key to
 * retime it, right-click it to change its pose or remove it, add a key at the playhead. Collisions found by the build's
 * check show as red spans. An explode shows its steps (click one to see where it leaves the parts) and can draw trails.
 * Edits rewrite the call in main.py and rebuild.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bookmark, Clapperboard, Pause, Pencil, Play, Plus, Radar, Repeat, Spline } from 'lucide-react';
import { ContextContent, ContextItem, ContextLabel, ContextRoot, ContextSeparator, ContextTrigger, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select, Tip } from '@/ui';
import { useApp } from '@/state/store';
import { updateModel } from '@/state/actions';
import { shownTab } from '@/state/designTab';
import { num } from '@/lib/format';
import { poseNames, setExplodeLoop, writeAnimation, type AnimationSpec } from './code';
import { animationCollisionsAt, stepAt, stepEnd, type MotionAnimation, type MotionExplode } from './kinematics';
import { openMotionTool } from './motionTool';
import { openExplodeTool } from './explodeTool';
import { clipOf, explodeOf, seek, selectClip, setTrails, toggleClip, useMotion } from './state';
import styles from './Motion.module.css';

const PAD = 14;  // px at each end of the ruler

/** The animation's code with its keys (and options) changed: what the strip writes. */
function specOf(clip: MotionAnimation, keys = clip.keys.map((key) => ({ pose: key.pose ?? key.values, time: key.time })), patch: Partial<AnimationSpec> = {}): AnimationSpec {
  return { name: clip.name, keys, loop: clip.loop, easing: clip.easing, check: !!clip.check, ...patch };
}

async function rewrite(spec: AnimationSpec) {
  writeAnimation(spec);
  await updateModel();
  selectClip(spec.name, useMotion.getState().clipTime);
}

function Ruler({ clip, width }: { clip: { duration: number }; width: number }) {
  const scale = (width - 2 * PAD) / clip.duration;
  const step = clip.duration > 20 ? 5 : clip.duration > 8 ? 2 : clip.duration > 3 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let t = 0; t <= clip.duration + 1e-9; t += step) ticks.push(Number(t.toFixed(3)));
  return (
    <div className={styles.ruler} aria-hidden>
      {ticks.map((t) => <span key={t} className={styles.tick} style={{ left: PAD + t * scale }}>{num(t)}s</span>)}
    </div>
  );
}

function Keys({ clip, width }: { clip: MotionAnimation; width: number }) {
  const scale = (width - 2 * PAD) / clip.duration;
  const [dragging, setDragging] = useState<{ index: number; time: number } | null>(null);
  const poses = poseNames();
  const start = (event: React.PointerEvent, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const x0 = event.clientX, t0 = clip.keys[index].time;
    const low = index ? clip.keys[index - 1].time : 0;
    const high = index < clip.keys.length - 1 ? clip.keys[index + 1].time : Infinity;
    let moved = false, time = t0;
    const move = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - x0) < 3) return;
      moved = true;
      const raw = t0 + (e.clientX - x0) / scale;
      time = Math.min(high, Math.max(low, e.shiftKey ? Math.round(raw * 100) / 100 : Math.round(raw * 10) / 10));
      setDragging({ index, time });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      setDragging(null);
      if (!moved) { seek(t0); return; }
      if (Math.abs(time - t0) > 1e-9) {
        const keys = clip.keys.map((key, i) => ({ pose: key.pose ?? key.values, time: i === index ? time : key.time }));
        void rewrite(specOf(clip, keys));
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const setPose = (index: number, pose: string) => void rewrite(specOf(clip, clip.keys.map((key, i) => ({ pose: i === index ? pose : key.pose ?? key.values, time: key.time }))));
  const remove = (index: number) => void rewrite(specOf(clip, clip.keys.filter((_, i) => i !== index).map((key) => ({ pose: key.pose ?? key.values, time: key.time }))));
  return (
    <>
      {clip.keys.map((key, index) => {
        const time = dragging?.index === index ? dragging.time : key.time;
        return (
          <ContextRoot key={index}>
            <Tip label={key.pose ?? 'Values'} description={`${num(time)} s · drag to retime, right-click for more`} side="top">
              <ContextTrigger asChild>
                <button type="button" className={styles.key} data-key={index} data-key-pose={key.pose} data-dragging={dragging?.index === index || undefined}
                  style={{ left: PAD + time * scale }} aria-label={`Key ${index + 1}: ${key.pose ?? 'values'} at ${num(time)} s`}
                  onPointerDown={(event) => start(event, index)} onDoubleClick={() => openMotionTool('animation', clip.name)}>
                  <span className={styles.keyDiamond} />
                  <span className={styles.keyLabel}>{key.pose ?? 'values'}</span>
                </button>
              </ContextTrigger>
            </Tip>
            <ContextContent>
              <ContextLabel>Key {index + 1} · {num(key.time)} s</ContextLabel>
              {poses.map((pose) => <ContextItem key={pose} icon={<Bookmark size={14} />} onSelect={() => setPose(index, pose)} hint={pose === key.pose ? 'current' : undefined}>{pose}</ContextItem>)}
              <ContextSeparator />
              <ContextItem icon={<Pencil size={14} />} onSelect={() => openMotionTool('animation', clip.name)}>Edit animation…</ContextItem>
              <ContextItem disabled={clip.keys.length <= 2} danger onSelect={() => remove(index)}>Remove key</ContextItem>
            </ContextContent>
          </ContextRoot>
        );
      })}
    </>
  );
}

function Clashes({ clip, width }: { clip: MotionAnimation; width: number }) {
  const check = clip.check;
  if (!check || check.clear) return null;
  const scale = (width - 2 * PAD) / clip.duration;
  const half = clip.duration / Math.max(check.of - 1, 1) / 2;
  return (
    <>
      {check.collisions.flatMap((hit) => hit.spans.map(([low, high], index) => (
        <span key={`${hit.a}:${hit.b}:${index}`} className={styles.clashSpan} data-clash={`${hit.a}:${hit.b}`} title={`${hit.a} hits ${hit.b}, ${num(low)}–${num(high)} s`}
          style={{ left: PAD + Math.max(0, low - half) * scale, width: Math.max(4, (Math.min(clip.duration, high + half) - Math.max(0, low - half)) * scale) }} />
      )))}
    </>
  );
}

/** An explode's steps on the ruler: each from its start over its move (its hold after it is the gap to the next). */
function Steps({ explode, width, time }: { explode: MotionExplode; width: number; time: number }) {
  const scale = (width - 2 * PAD) / explode.duration;
  const current = stepAt(explode, time);
  return (
    <>
      {explode.steps.map((step, index) => (
        <Tip key={index} label={step.name ?? `Step ${index + 1}`} description={`${num(step.start)}–${num(stepEnd(explode, index))} s · ${Object.keys(step.moves).join(', ')}`} side="top">
          <button type="button" className={styles.stepSpan} data-step={index} data-current={current === index || undefined}
            style={{ left: PAD + step.start * scale, width: Math.max(6, step.duration * scale) }}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => seek(stepEnd(explode, index))}
            aria-label={`Step ${index + 1}: ${step.name ?? Object.keys(step.moves).join(', ')}`}>{index + 1}</button>
        </Tip>
      ))}
    </>
  );
}

async function rewriteLoop(explode: MotionExplode) {
  setExplodeLoop(explode.name, !explode.loop);
  await updateModel();
  selectClip(explode.name, useMotion.getState().clipTime);
}

function AddKey({ clip }: { clip: MotionAnimation }) {
  const time = useMotion((state) => state.clipTime);
  const poses = poseNames();
  const add = (pose: string) => {
    const keys = clip.keys.map((key) => ({ pose: key.pose ?? key.values, time: key.time }));
    const at = Math.round(time * 100) / 100;
    keys.splice(keys.findIndex((key) => key.time > at) < 0 ? keys.length : keys.findIndex((key) => key.time > at), 0, { pose, time: at });
    void rewrite(specOf(clip, keys));
  };
  return (
    <Menu modal={false}>
      <Tip label="Add a key at the playhead" description="Choose the pose it reaches there.">
        <MenuTrigger asChild><IconButton small label="Add key" id="animation-key-add"><Plus size={14} /></IconButton></MenuTrigger>
      </Tip>
      <MenuContent>
        <MenuLabel>Key at {num(time)} s</MenuLabel>
        {poses.map((pose) => <MenuItem key={pose} icon={<Bookmark size={14} />} onSelect={() => add(pose)}>{pose}</MenuItem>)}
        <MenuSeparator />
        <MenuItem icon={<Bookmark size={14} />} onSelect={() => openMotionTool('pose')}>Save the current pose…</MenuItem>
      </MenuContent>
    </Menu>
  );
}

export default function AnimationStrip() {
  const show = useApp((state) => state.workspace === 'design' && state.doc.kind === 'design' && shownTab(state) === 'motion' && !state.sketching);
  const kinematics = useMotion((state) => state.kinematics);
  const clipName = useMotion((state) => state.clip);
  const time = useMotion((state) => state.clipTime);
  const playing = useMotion((state) => !!state.clipStart);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [show, !!kinematics]);
  const draft = useMotion((state) => state.draft);
  const trails = useMotion((state) => state.trails);
  const clip = clipOf(clipName);
  const explode = clip ? undefined : explodeOf(clipName);
  const shown = clip ?? explode;
  const animations = kinematics?.animations ?? [];
  const explodes = [...(kinematics?.explodes ?? []).filter((item) => item.name !== draft?.name), ...(draft ? [draft] : [])];
  const scale = shown ? (width - 2 * PAD) / shown.duration : 1;
  const hits = clip ? animationCollisionsAt(clip, time) : [];
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!shown || event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const at = (x: number) => (x - element.getBoundingClientRect().left - PAD) / scale;
    seek(at(event.clientX));
    const move = (e: PointerEvent) => seek(at(e.clientX));
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  return (
    <AnimatePresence initial={false}>
      {show && kinematics && (
        <motion.div className={styles.strip} id="animation-strip" initial={{ height: 0, opacity: 0 }} animate={{ height: 52, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
          <div className={styles.stripHead}>
            <Clapperboard size={13} /><span className="caps">Animation</span>
            {animations.length + explodes.length > 0 && (
              <>
                <div className={styles.stripSelect}>
                  <Select ariaLabel="Animation" value={clipName ?? ''} options={[
                    ...animations.map((item) => ({ value: item.name, label: item.name, hint: `${num(item.duration)} s` })),
                    ...explodes.map((item) => ({ value: item.name, label: item.name, hint: `explode · ${num(item.duration)} s` }))]}
                    onChange={(name) => selectClip(name)} />
                </div>
                <IconButton small label={playing ? 'Pause' : explode ? 'Play explode' : 'Play animation'} id="animation-play" active={playing} onClick={toggleClip}>
                  {playing ? <Pause size={13} /> : <Play size={13} />}
                </IconButton>
                <span className={styles.stripTime} id="animation-time">{num(time, 2)} / {num(shown?.duration ?? 0, 2)} s</span>
              </>
            )}
          </div>
          {explode ? (
            <div className={styles.stripTrack} ref={track} onPointerDown={scrub} data-explode={explode.name}>
              <Ruler clip={explode} width={width} />
              <Steps explode={explode} width={width} time={time} />
              <span className={styles.playhead} id="animation-playhead" style={{ left: PAD + time * scale }} />
            </div>
          ) : clip ? (
            <div className={styles.stripTrack} ref={track} onPointerDown={scrub} data-animation={clip.name}>
              <Ruler clip={clip} width={width} />
              <Clashes clip={clip} width={width} />
              <Keys clip={clip} width={width} />
              <span className={styles.playhead} id="animation-playhead" style={{ left: PAD + time * scale }} data-collision={hits.length ? hits.map((hit) => `${hit.a}:${hit.b}`).join(' ') : undefined} />
            </div>
          ) : (
            <div className={styles.stripEmpty} ref={track}>
              {!kinematics.joints.some((joint) => joint.type !== 'rigid')
                ? <span><button type="button" onClick={() => openExplodeTool()}>Create an exploded view</button> to show how this assembly comes apart.</span>
                : Object.keys(kinematics.poses).length < 2
                ? <span>Animations move between poses: set the mechanism, then <button type="button" onClick={() => openMotionTool('pose')}>save a pose</button> (and another).</span>
                : <span>No animation yet. <button type="button" id="animation-new" onClick={() => openMotionTool('animation')}>New animation</button> from your poses.</span>}
            </div>
          )}
          {explode && (
            <div className={styles.stripActions}>
              <IconButton small label={trails ? 'Trails shown' : 'Trails hidden'} description="Dashed lines from where each part sits to where the explode has it"
                active={trails} id="explode-trails" onClick={() => setTrails(!trails)}><Spline size={13} /></IconButton>
              {explode !== draft && (
                <>
                  <IconButton small label={explode.loop ? 'Looping' : 'Plays once'} description="Click to change" active={explode.loop} id="explode-loop"
                    onClick={() => void rewriteLoop(explode)}><Repeat size={13} /></IconButton>
                  <IconButton small label="Edit explode" id="explode-edit" onClick={() => openExplodeTool(explode.name)}><Pencil size={13} /></IconButton>
                </>
              )}
            </div>
          )}
          {clip && (
            <div className={styles.stripActions}>
              {hits.length > 0 && <span className={styles.stripHit} data-collision>{hits.map((hit) => `${hit.a} ↔ ${hit.b}`).join(', ')}</span>}
              <AddKey clip={clip} />
              <IconButton small label={clip.loop ? 'Looping' : 'Plays once'} description="Click to change" active={clip.loop} id="animation-loop"
                onClick={() => void rewrite(specOf(clip, undefined, { loop: !clip.loop }))}><Repeat size={13} /></IconButton>
              <IconButton small label={clip.check ? 'Collision check on' : 'Collision check off'} description="Sweeps the animation at each build" active={!!clip.check} id="animation-check"
                onClick={() => void rewrite(specOf(clip, undefined, { check: !clip.check }))}><Radar size={13} /></IconButton>
              <IconButton small label="Edit animation" id="animation-edit" onClick={() => openMotionTool('animation', clip.name)}><Pencil size={13} /></IconButton>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
