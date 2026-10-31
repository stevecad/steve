/**
 * Video export, frame by frame: for each frame time the take's pose is set, the viewer renders once at the output
 * size, and the frame goes to the browser's encoder (WebCodecs VideoEncoder) and on into an MP4 (H.264) or WebM (VP9,
 * VP8) file (Mediabunny). Nothing runs in real time, so no frame is dropped however slow the GPU, and the tab may be in
 * the background (rendering and encoding don't wait for animation frames, and the loop yields through a message
 * channel, which background tabs don't throttle). Frames are encoded as they're drawn; at most a few wait in the
 * encoder at once, and the file's bytes collect in Blobs (sink.ts).
 */
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { get } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { applyPose } from '@/motion/PoseLayer';
import { useMotion } from '@/motion/state';
import { liveBase, type Take } from '@/motion/takes';
import { bitrate, candidates, chooseCodec, fileName, outputSize, timeline, type Candidate, type VideoOptions } from './plan';
import { frameRenderer, maxFrameSide, type Overlays } from './render';
import { BlobSink } from './sink';

export interface Progress { frame: number; frames: number; perSecond: number; preview: HTMLCanvasElement }

export interface Recorded {
  blob: Blob; name: string; codec: string; container: 'mp4' | 'webm'; fellBack: boolean;
  frames: number; seconds: number; width: number; height: number; elapsed: number;
}

/** The browser can't encode frame by frame (no WebCodecs): the caller records live instead. */
export class NoEncoder extends Error {}

const encoderConfig = (candidate: Candidate, width: number, height: number, fps: number, bits: number): VideoEncoderConfig => ({
  codec: candidate.string, width, height, bitrate: bits, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable',
  ...(candidate.codec === 'avc' ? { avc: { format: 'avc' } } : {}),
} as VideoEncoderConfig);

/** Lets the page handle input between frames, without the timer throttling of a background tab. */
const breathe = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(0);
});

/** The size this viewport makes for `options` (the dialog shows it). */
export function plannedSize(options: Pick<VideoOptions, 'size' | 'framing'>) {
  return outputSize(options, { ...viewer.size, dpr: window.devicePixelRatio || 1 });
}

export async function recordFrames(take: Take, options: VideoOptions, overlays: Overlays, onProgress: (progress: Progress) => void, signal: AbortSignal): Promise<Recorded> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new NoEncoder();
  const model = viewer.model;
  const { kinematics } = useMotion.getState();
  if (!model || !kinematics) throw new Error('The design has no geometry yet.');
  const { width, height } = plannedSize(options);
  const largest = maxFrameSide();
  if (width > largest || height > largest) throw new Error(`This GPU draws at most ${largest} pixels a side. Choose a smaller size.`);
  const plan = timeline(take.duration, options, !take.loop);
  const bits = bitrate(width, height, options.fps, options.quality);
  const chosen = await chooseCodec(options.format, candidates(options.format, width, height, options.fps, bits),
    async (candidate) => !!(await VideoEncoder.isConfigSupported(encoderConfig(candidate, width, height, options.fps, bits))).supported);
  if (!chosen) throw new Error(`This browser can’t encode a ${width} × ${height} video. Choose a smaller size.`);
  const { candidate, fellBack } = chosen;

  const sink = new BlobSink();
  const output = new Output({
    format: candidate.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'reserve' }) : new WebMOutputFormat(),
    target: new StreamTarget(sink.stream(), { chunked: true, chunkSize: 8 << 20 }),
  });
  const source = new EncodedVideoPacketSource(candidate.codec);
  output.addVideoTrack(source, { frameRate: options.fps, maximumPacketCount: plan.frames + 8 });
  await output.start();

  let failure: unknown = null;
  let muxing: Promise<void> = Promise.resolve();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      muxing = muxing.then(() => source.add(packet, meta)).catch((error) => { failure ??= error; });
    },
    error: (error) => { failure ??= error; },
  });
  encoder.configure(encoderConfig(candidate, width, height, options.fps, bits));

  const base = liveBase();
  const renderer = frameRenderer(width, height, overlays);
  const started = performance.now();
  let shown = 0;
  try {
    const step = Math.round(1e6 / options.fps);
    for (let index = 0; index < plan.frames; index++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failure) throw failure;
      applyPose(model, kinematics, take.pose(plan.at(index), base));
      const canvas = renderer.draw(options.turntable * (index / plan.frames));
      const frame = new VideoFrame(canvas, { timestamp: index * step, duration: step });
      encoder.encode(frame, { keyFrame: index % (options.fps * 2) === 0 });
      frame.close();
      // At most a few frames wait in the encoder; the muxer catches up now and then.
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
      if (index % 30 === 29) await muxing;
      const now = performance.now();
      if (now - shown > 120 || index === plan.frames - 1) {
        shown = now;
        // The rate once there's enough to go on (the first frames also compile the scene's shaders at the new size).
        const seconds = (now - started) / 1000;
        onProgress({ frame: index + 1, frames: plan.frames, perSecond: seconds > 1 ? (index + 1) / seconds : 0, preview: canvas });
      }
      await breathe();
    }
    await encoder.flush();
    await muxing;
    if (failure) throw failure;
    encoder.close();
    await output.finalize();
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close();
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw error;
  } finally {
    renderer.dispose();
    // Back to the pose the viewer shows.
    const state = useMotion.getState();
    if (viewer.model === model) applyPose(model, state.kinematics, state.pose);
    viewer.invalidate();
  }
  const elapsed = (performance.now() - started) / 1000;
  const blob = sink.blob(candidate.container === 'mp4' ? 'video/mp4' : 'video/webm');
  return {
    blob, name: fileName(get().doc.name || 'design', take.name, candidate.container), codec: candidate.label, container: candidate.container,
    fellBack, frames: plan.frames, seconds: plan.seconds, width, height, elapsed,
  };
}
