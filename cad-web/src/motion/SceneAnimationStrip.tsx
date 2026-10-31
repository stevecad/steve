/**
 * The Animation tab of an animated Blender scene: under the view, the strip that plays, scrubs and loops the scene's own
 * animation from its preview (seconds after a save), shows the shot through the scene's camera, and switches to the
 * rendered video once a full build has made it. Over the view, the Shot's frame and the rendered video.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, Clapperboard, Film, Pause, Play, Repeat } from 'lucide-react';
import { IconButton } from '@/ui';
import { useApp } from '@/state/store';
import { animationShown } from '@/state/designTab';
import { withWorkspace } from '@/teams/current';
import { num } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import { pauseScene, sceneDuration, seekScene, setSceneLoop, setSceneRendered, setSceneShot, toggleScene, useSceneAnimation } from './sceneAnimation';
import { SHOT_BOTTOM, SHOT_MARGIN, shotWidth } from './SceneAnimationLayer';
import styles from './Motion.module.css';

const PAD = 14;  // px at each end of the ruler

interface SceneFacts { fps?: number; frame_start?: number; frame_end?: number; camera?: string | null }

function useScene() {
  const shown = useApp(animationShown);
  const build = useApp((state) => state.displayed);
  useApp((state) => state.modelVersion);   // the model (and its animation) changes with each build shown
  const facts = ((build?.metadata as { scene?: SceneFacts } | null | undefined)?.scene ?? {}) as SceneFacts;
  const render = useSceneAnimation((state) => state.render);
  const video = (build?.mode === 'full' ? build.artifacts?.animation : null) ?? render?.video ?? null;
  return { shown, facts, video, render, duration: sceneDuration(), camera: !!viewer.model?.shotCamera };
}

export default function SceneAnimationStrip() {
  const { shown, facts, video, render, duration, camera } = useScene();
  const time = useSceneAnimation((state) => state.time);
  const playing = useSceneAnimation((state) => !!state.playing);
  const loop = useSceneAnimation((state) => state.loop);
  const shot = useSceneAnimation((state) => state.shot);
  const rendered = useSceneAnimation((state) => state.rendered);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [shown]);
  useEffect(() => { if (!shown) { pauseScene(); setSceneRendered(false); } }, [shown]);
  useEffect(() => { if (!video) setSceneRendered(false); }, [video]);
  const fps = facts.fps || 24;
  const first = facts.frame_start ?? 1, last = facts.frame_end ?? first + Math.round(duration * fps);
  const frame = Math.min(last, first + Math.round(time * fps));
  const scale = duration > 0 ? (width - 2 * PAD) / duration : 1;
  const step = duration > 20 ? 5 : duration > 8 ? 1 : duration > 3 ? 0.5 : 0.25;
  const ticks: number[] = [];
  for (let t = 0; duration > 0 && t <= duration + 1e-9; t += step) ticks.push(Number(t.toFixed(3)));
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0 || event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    setSceneRendered(false);
    const at = (x: number) => (x - element.getBoundingClientRect().left - PAD) / scale;
    seekScene(at(event.clientX));
    const move = (e: PointerEvent) => seekScene(at(e.clientX));
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div className={styles.strip} id="scene-animation-strip" initial={{ height: 0, opacity: 0 }} animate={{ height: 52, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
          <div className={styles.stripHead}>
            <Clapperboard size={13} /><span className="caps">Animation</span>
            <IconButton small label={playing ? 'Pause' : 'Play'} id="scene-animation-play" active={playing} disabled={duration <= 0} onClick={toggleScene}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </IconButton>
            <span className={styles.stripTime} id="scene-animation-time">{num(time, 2)} / {num(duration, 2)} s · frame {frame} / {last}</span>
            {render && (render.status === 'queued' || render.status === 'running') && (
              <span className={styles.stripTime} id="scene-animation-rendering">
                {render.status === 'queued' ? 'Render queued' : render.progress?.of ? `Rendering · frame ${render.progress.done ?? 0} of ${render.progress.of}` : 'Rendering…'}
              </span>
            )}
          </div>
          {duration > 0 ? (
            <div className={styles.stripTrack} ref={track} onPointerDown={scrub} data-scene-animation>
              <div className={styles.ruler} aria-hidden>
                {ticks.map((t) => <span key={t} className={styles.tick} style={{ left: PAD + t * scale }}>{num(t)}s</span>)}
              </div>
              <span className={styles.playhead} id="scene-animation-playhead" style={{ left: PAD + time * scale }} />
            </div>
          ) : (
            <div className={styles.stripEmpty} ref={track}><span>This build's preview carries no motion: save the scene again to see it play here.</span></div>
          )}
          <div className={styles.stripActions}>
            <IconButton small label={loop ? 'Looping' : 'Plays once'} description="Click to change" active={loop} id="scene-animation-loop" onClick={() => setSceneLoop(!loop)}>
              <Repeat size={13} />
            </IconButton>
            <IconButton small label={shot ? 'Shot shown' : 'Shot hidden'} description={camera ? `The view through the scene's camera${facts.camera ? ` (${facts.camera})` : ''}, in the corner` : 'The scene has no camera (scene.camera)'}
              active={shot && camera} disabled={!camera} id="scene-animation-shot" onClick={() => setSceneShot(!shot)}>
              <Camera size={13} />
            </IconButton>
            <IconButton small label={rendered ? 'Rendered video' : 'Live view'} id="scene-animation-rendered" active={rendered} disabled={!video}
              description={video ? 'Switch between the live view and the rendered video' : 'The rendered video comes with a full build'}
              onClick={() => setSceneRendered(!rendered)}>
              <Film size={13} />
            </IconButton>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Over the view: the Shot's frame and label (the inset itself is drawn by SceneAnimationLayer), and the rendered video. */
export function SceneAnimationOverlay() {
  const { shown, facts, video } = useScene();
  const shot = useSceneAnimation((state) => state.shot);
  const through = useSceneAnimation((state) => state.through);
  const rendered = useSceneAnimation((state) => state.rendered);
  const camera = viewer.model?.shotCamera;
  const box = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const element = box.current?.parentElement;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [shown]);
  if (!shown) return null;
  const width = shotWidth(viewWidth), height = width / (camera?.aspect || 16 / 9);
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
      {through && camera && !rendered && (
        <span className="caps" id="scene-animation-camera-view" style={{ position: 'absolute', left: '50%', top: 12, transform: 'translateX(-50%)',
          fontSize: 10, color: 'var(--text-2)', textShadow: '0 1px 2px rgb(0 0 0 / 60%)' }}>Camera view{facts.camera ? ` · ${facts.camera}` : ''}</span>
      )}
      {shot && !through && camera && !rendered && (
        <div id="scene-animation-shot-frame" style={{ position: 'absolute', right: SHOT_MARGIN, bottom: SHOT_BOTTOM, width, height,
          border: '1px solid var(--line-3)', borderRadius: 4, boxShadow: '0 4px 18px rgb(0 0 0 / 35%)' }}>
          <span className="caps" style={{ position: 'absolute', left: 8, top: 6, fontSize: 10, color: 'var(--text-2)',
            textShadow: '0 1px 2px rgb(0 0 0 / 60%)' }}>Shot{facts.camera ? ` · ${facts.camera}` : ''}</span>
        </div>
      )}
      {rendered && video && (
        <div id="scene-animation-video" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          background: 'var(--bg-0)', pointerEvents: 'auto', padding: 24 }}>
          <video src={withWorkspace(video)} controls autoPlay loop muted playsInline aria-label="The scene's rendered animation"
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6, boxShadow: '0 8px 32px rgb(0 0 0 / 40%)' }} />
        </div>
      )}
    </div>
  );
}
