/**
 * Motion → Export → Video, and Record in presentation view: the video's options, then its progress (a preview of the
 * frame being encoded, Cancel), then what was saved. A dialog because recording takes over the view until it's done.
 * The options are remembered in this browser.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Video } from 'lucide-react';
import { Button, Dialog, NumberField, Segmented, Select } from '@/ui';
import { set, toast } from '@/state/store';
import { num } from '@/lib/format';
import { useMotion } from '@/motion/state';
import { allTakes, currentTake, type Take } from '@/motion/takes';
import { download, recordLive } from '@/motion/exportMotion';
import { bitrate, DEFAULT_OPTIONS, MAX_HOLD, MAX_PLAYS, PRESETS, problem, timeline, type VideoOptions } from './video/plan';
import { presentTake, setRecording, usePresent } from './state';
import dialogs from '@/dialogs/Dialogs.module.css';
import styles from './VideoDialog.module.css';

const KEY = 'steve-video-options';

function remembered(): VideoOptions {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<VideoOptions> | null;
    const options = { ...DEFAULT_OPTIONS, ...(kept ?? {}) };
    return problem(options, 1) ? DEFAULT_OPTIONS : options;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function remember(options: VideoOptions) {
  try { localStorage.setItem(KEY, JSON.stringify(options)); } catch { /* Private window: not kept. */ }
}

type Phase = { kind: 'options' } | { kind: 'recording'; frame: number; frames: number; perSecond: number }
  | { kind: 'done'; name: string; detail: string; note?: string } | { kind: 'failed'; message: string };

const megabytes = (bytes: number) => `${num(bytes / 1e6, bytes < 1e7 ? 1 : 0)} MB`;

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}{hint && <span className={styles.hint}>{hint}</span>}</div>
    </div>
  );
}

export default function VideoDialog({ open }: { open: boolean }) {
  const kinematics = useMotion((state) => state.kinematics);
  const takes = useMemo(() => allTakes(kinematics), [kinematics]);
  const [options, setOptions] = useState<VideoOptions>(remembered);
  const [takeKey, setTakeKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const [size, setSize] = useState({ width: 1920, height: 1080 });
  const preview = useRef<HTMLCanvasElement>(null);
  const abort = useRef<AbortController | null>(null);

  // Each time it opens: the motion on show (presentation view's player, or the Motion tab's), at the speed it plays.
  useEffect(() => {
    if (!open) return;
    const shown: Take | null = usePresent.getState().active ? presentTake() : currentTake(useMotion.getState().kinematics);
    setTakeKey(shown?.key ?? null);
    setOptions((current) => ({ ...current, speed: useMotion.getState().speedScale }));
    setPhase({ kind: 'options' });
  }, [open]);

  const take = takes.find((item) => item.key === takeKey) ?? takes[0] ?? null;
  const update = (patch: Partial<VideoOptions>) => setOptions((current) => ({ ...current, ...patch }));
  useEffect(() => {
    if (!open) return;
    void import('./video/encode').then(({ plannedSize }) => setSize(plannedSize(options)));
  }, [open, options.size, options.framing]);  // eslint-disable-line react-hooks/exhaustive-deps

  const issue = take ? problem(options, take.duration) : 'Add a motor or an animation first.';
  const plan = take ? timeline(take.duration, options, !take.loop) : null;
  const estimate = plan ? (bitrate(size.width, size.height, options.fps, options.quality) * plan.seconds) / 8 : 0;
  const recording = phase.kind === 'recording';

  const close = () => { if (!recording) set({ dialog: null }); };

  const record = async () => {
    if (!take || issue) return;
    remember(options);
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'recording', frame: 0, frames: plan?.frames ?? 0, perSecond: 0 });
    setRecording(true);
    const { recordFrames, NoEncoder } = await import('./video/encode');
    const overlays = { cube: usePresent.getState().cube, triad: usePresent.getState().triad };
    try {
      const result = await recordFrames(take, options, overlays, (progress) => {
        setPhase({ kind: 'recording', frame: progress.frame, frames: progress.frames, perSecond: progress.perSecond });
        const target = preview.current;
        if (target) {
          // As wide as fits, at most 240 px high, in the video's shape.
          const shape = progress.preview.width / progress.preview.height;
          target.style.width = `min(100%, ${Math.round(240 * shape)}px)`;
          target.style.aspectRatio = String(shape);
          target.width = Math.round(target.clientWidth * (window.devicePixelRatio || 1)) || 320;
          target.height = Math.round(target.width / shape);
          target.getContext('2d')?.drawImage(progress.preview, 0, 0, target.width, target.height);
        }
      }, controller.signal);
      download(result.blob, result.name);
      setPhase({
        kind: 'done', name: result.name,
        detail: `${result.codec} · ${result.width} × ${result.height} · ${num(result.seconds, 1)} s at ${options.fps} fps · ${megabytes(result.blob.size)}`,
        note: result.fellBack ? `This browser can’t encode H.264 at this size, so it’s a WebM (${result.codec}) instead. Chrome, Edge and Safari make MP4.` : undefined,
      });
    } catch (error) {
      if (error instanceof NoEncoder) {
        set({ dialog: null });
        toast('info', 'Recording live', 'This browser can’t encode video frame by frame: the view is recorded as WebM while the motion plays. Keep this tab in front.');
        void recordLive(take);
        return;
      }
      if ((error as DOMException)?.name === 'AbortError') { setPhase({ kind: 'options' }); return; }
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      abort.current = null;
      setRecording(false);
    }
  };

  const sizes = [
    { value: 'view' as const, label: 'Viewport', hint: `${size.width} × ${size.height}` },
    ...(['720p', '1080p', '1440p', '2160p'] as const).map((value) => ({ value, label: PRESETS[value].label })),
  ];
  const what = take ? `${take.name} · ${take.kind === 'motor' ? 'one motor cycle' : take.kind}, ${num(take.duration, 1)} s` : 'Nothing moves yet.';

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={500}
      icon={<div className={dialogs.itemIcon} style={{ color: 'var(--ws)' }}><Video size={17} /></div>}
      title="Video" description={phase.kind === 'options' ? 'The motion as the view shows it, frame by frame.' : what}
      footer={phase.kind === 'recording'
        ? <Button onClick={() => abort.current?.abort()} id="video-cancel">Cancel</Button>
        : phase.kind === 'done'
          ? <Button variant="primary" onClick={close} id="video-done">Done</Button>
          : phase.kind === 'failed'
            ? <><Button onClick={close}>Close</Button><Button variant="primary" onClick={() => setPhase({ kind: 'options' })}>Back to the options</Button></>
          : <><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!!issue} onClick={() => { void record(); }} id="video-record">Record</Button></>}>
      {phase.kind === 'options' && (
        <div className={styles.form} id="video-options">
          {takes.length > 1
            ? <Row label="Motion"><Select ariaLabel="Motion" id="video-take" value={take?.key ?? ''} onChange={setTakeKey} options={takes.map((item) => ({ value: item.key, label: item.name, hint: `${item.kind === 'explode' ? 'explode · ' : ''}${num(item.duration, 1)} s` }))} /></Row>
            : <Row label="Motion"><span className={styles.value}>{what}</span></Row>}
          <Row label="Size" hint={options.size === 'view' ? undefined : `${size.width} × ${size.height}`}>
            <Select ariaLabel="Size" id="video-size" value={options.size} onChange={(value) => update({ size: value })} options={sizes} />
          </Row>
          {options.size !== 'view' && (
            <Row label="Frame">
              <Segmented size="sm" value={options.framing} onChange={(value) => update({ framing: value })}
                options={[{ value: 'view', label: 'Like the view' }, { value: '16:9', label: '16:9' }]} />
            </Row>
          )}
          <Row label="Frame rate"><Segmented size="sm" value={String(options.fps) as '30' | '60'} onChange={(value) => update({ fps: Number(value) as 30 | 60 })} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} /></Row>
          <Row label="Quality" hint={`${num(bitrate(size.width, size.height, options.fps, options.quality) / 1e6, 1)} Mbit/s`}>
            <Segmented size="sm" value={options.quality} onChange={(value) => update({ quality: value })} options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Maximum' }]} />
          </Row>
          <Row label="Format"><Segmented size="sm" value={options.format} onChange={(value) => update({ format: value })} options={[{ value: 'mp4', label: 'MP4' }, { value: 'webm', label: 'WebM' }]} /></Row>
          <Row label="Speed">
            <Segmented size="sm" value={String(options.speed)} onChange={(value) => update({ speed: Number(value) })}
              options={[{ value: '0.25', label: '¼×' }, { value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
          </Row>
          <Row label="Plays"><NumberField ariaLabel="Plays" value={options.plays} unit="×" step={1} min={1} max={MAX_PLAYS} onChange={(value) => update({ plays: Math.round(value) })} /></Row>
          <Row label="Hold at start"><NumberField ariaLabel="Hold at start" value={options.holdStart} unit="s" step={0.5} min={0} max={MAX_HOLD} onChange={(value) => update({ holdStart: value })} /></Row>
          <Row label="Hold at end"><NumberField ariaLabel="Hold at end" value={options.holdEnd} unit="s" step={0.5} min={0} max={MAX_HOLD} onChange={(value) => update({ holdEnd: value })} /></Row>
          <Row label="Turntable" hint="The camera turns about the view's centre over the whole video; 0 keeps it still.">
            <NumberField ariaLabel="Turntable" value={options.turntable} unit="°" step={45} min={-3600} max={3600} onChange={(value) => update({ turntable: value })} />
          </Row>
          <p className={styles.summary} id="video-summary" data-problem={issue ? '' : undefined}>
            {issue ?? (plan && `${size.width} × ${size.height} · ${num(plan.seconds, 1)} s · ${plan.frames} frames · about ${megabytes(estimate)}`)}
          </p>
        </div>
      )}
      {phase.kind === 'recording' && (
        <div className={styles.progress} id="video-progress">
          <canvas ref={preview} className={styles.preview} aria-label="The frame being encoded" />
          <div className={styles.meter}><span style={{ width: `${phase.frames ? (100 * phase.frame) / phase.frames : 0}%` }} /></div>
          <p className={styles.summary}>
            Frame {phase.frame} of {phase.frames}{phase.perSecond > 0 && ` · ${num(phase.perSecond, 0)} frames/s · about ${num(Math.max(0, (phase.frames - phase.frame) / phase.perSecond), 0)} s left`}
          </p>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className={styles.result} id="video-result">
          <p><strong>{phase.name}</strong> is in your downloads.</p>
          <p className={styles.summary}>{phase.detail}</p>
          {phase.note && <p className={styles.note} id="video-fallback">{phase.note}</p>}
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className={styles.result}>
          <p className={styles.note} data-tone="danger" id="video-error">{phase.message}</p>
        </div>
      )}
    </Dialog>
  );
}
