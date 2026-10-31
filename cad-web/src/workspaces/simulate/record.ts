/**
 * Recording the results view to a WebM video: each rendered frame is copied onto a 2D canvas with the
 * viewport's background and the legend painted over it (the on-screen legend is HTML, outside the 3D canvas),
 * and that canvas streams into a MediaRecorder. The file is named after the study and the field shown.
 */
import { toast } from '@/state/store';
import { AMBER, bandColors, css, FAIL, GREEN, NEUTRAL, paletteColor } from './colormap';
import type { LegendModel } from './legend';
import { useSimulation } from './state';

export interface Recording { paint(model: LegendModel | null): void; stop(): void }

/** Recordings stop on their own after this long. */
const LIMIT_MS = 60_000;
const MAX_WIDTH = 1920;

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'results';

export function startRecording(source: HTMLCanvasElement, name: string): Recording {
  if (typeof MediaRecorder === 'undefined' || !('captureStream' in HTMLCanvasElement.prototype)) throw new Error('This browser can’t record video of the viewport.');
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This browser can’t record WebM video.');
  const scale = Math.min(1, MAX_WIDTH / Math.max(1, source.width));
  const canvas = document.createElement('canvas');
  // Even dimensions keep video encoders happy.
  canvas.width = Math.max(2, Math.round((source.width * scale) / 2) * 2);
  canvas.height = Math.max(2, Math.round((source.height * scale) / 2) * 2);
  // Attached (but invisible): a detached canvas's stream can deliver no frames.
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The recording canvas is unavailable.');
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue('--bg-1').trim() || '#14161a';
  const pixel = canvas.width / Math.max(1, source.clientWidth || source.width);
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    canvas.remove();
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (!blob.size) { toast('warning', 'Nothing was recorded', 'The video encoder delivered no frames. Record for a little longer, with this tab in front.'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${safeName(name)}.webm`; link.id = 'results-recording';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast('success', 'Recording saved', link.download);
  };
  recorder.start(250);
  const limit = setTimeout(() => useSimulation.setState({ recording: false }), LIMIT_MS);
  let stopped = false;
  return {
    paint(model) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      if (model) drawLegend(context, model, pixel);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}

/** The legend panel, as the viewport shows it: title, unit, state block, banded bar with ticks, notes. */
function drawLegend(context: CanvasRenderingContext2D, model: LegendModel, pixel: number) {
  const px = (value: number) => value * pixel;
  const font = (size: number, weight = 400) => `${weight} ${px(size)}px Inter, system-ui, sans-serif`;
  const lines: { text: string; size: number; weight: number; color: string }[] = [
    { text: `${model.title.toUpperCase()}${model.edited ? ' *' : ''}`, size: 12, weight: 650, color: '#eef1f5' },
    ...(model.subtitle ? [{ text: model.subtitle, size: 11, weight: 400, color: '#9aa3ad' }] : []),
    ...model.details.map((text) => ({ text, size: 10.5, weight: 400, color: '#8b949e' })),
  ];
  const barHeight = model.zones.length ? 0 : px(200), barWidth = px(14), gap = px(8);
  context.save();
  context.textBaseline = 'middle';
  let width = 0;
  for (const line of lines) { context.font = font(line.size, line.weight); width = Math.max(width, context.measureText(line.text).width); }
  context.font = font(10.5);
  const labelWidth = Math.max(0, ...model.labels.map((label) => context.measureText(label).width), ...model.zones.map((zone) => context.measureText(zone.label).width + px(22)));
  const notes = [...(model.yieldLabel ? [`${model.yieldLabel} (white line)`] : []), ...model.outside];
  for (const note of notes) width = Math.max(width, context.measureText(note).width);
  width = Math.max(width, barWidth + gap + labelWidth) + px(26);
  const lineHeight = px(16);
  const height = px(14) + lines.length * lineHeight + px(10) + (barHeight || model.zones.length * px(18)) + px(10) + notes.length * px(15) + px(8);
  const x = px(16), y = px(16);
  context.fillStyle = 'rgba(16,18,22,0.84)';
  context.strokeStyle = 'rgba(255,255,255,0.12)';
  context.lineWidth = Math.max(1, px(1));
  context.beginPath(); context.roundRect(x, y, width, height, px(10)); context.fill(); context.stroke();
  let cursor = y + px(14) + lineHeight / 2;
  for (const line of lines) {
    context.font = font(line.size, line.weight); context.fillStyle = line.color;
    context.fillText(line.text, x + px(13), cursor);
    cursor += lineHeight;
  }
  cursor += px(4);
  const left = x + px(13);
  context.font = font(10.5);
  if (model.zones.length) {
    const colors = { fail: FAIL, amber: AMBER, green: GREEN, neutral: NEUTRAL };
    for (const zone of model.zones) {
      context.fillStyle = css(colors[zone.color]);
      context.fillRect(left, cursor, px(14), px(11));
      context.fillStyle = '#c9d1d9';
      context.fillText(zone.label, left + px(22), cursor + px(5.5));
      cursor += px(18);
    }
  } else {
    const top = cursor, bands = model.bands;
    if (model.banded) {
      bandColors(model.palette, bands).forEach((color, i) => {
        context.fillStyle = css(color);
        context.fillRect(left, top + barHeight - ((i + 1) * barHeight) / bands, barWidth, barHeight / bands + 0.5);
      });
    } else {
      const gradient = context.createLinearGradient(0, top + barHeight, 0, top);
      for (let i = 0; i <= 20; i++) gradient.addColorStop(i / 20, css(paletteColor(model.palette, i / 20)));
      context.fillStyle = gradient;
      context.fillRect(left, top, barWidth, barHeight);
    }
    context.strokeStyle = 'rgba(0,0,0,0.35)';
    context.strokeRect(left, top, barWidth, barHeight);
    context.fillStyle = '#c9d1d9';
    model.labels.forEach((label, i) => context.fillText(label, left + barWidth + gap, top + (i * barHeight) / Math.max(1, model.labels.length - 1)));
    if (model.yieldAt !== null) {
      const at = top + barHeight * (1 - model.yieldAt);
      context.strokeStyle = '#ffffff'; context.lineWidth = Math.max(1.5, px(2));
      context.beginPath(); context.moveTo(left - px(4), at); context.lineTo(left + barWidth + px(4), at); context.stroke();
    }
    cursor = top + barHeight;
  }
  cursor += px(14);
  context.fillStyle = '#8b949e';
  for (const note of notes) { context.fillText(note, left, cursor); cursor += px(15); }
  context.restore();
}
