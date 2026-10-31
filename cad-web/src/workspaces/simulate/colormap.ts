/**
 * Result colours, shared by the 3D contours and the legends.
 *
 * The display colours come from a lookup texture the contour shader samples: a field colormap (Rainbow, as CAE
 * tools draw by default; Viridis; Cividis, safe for colour-blind readers) or the safety-factor scale (red below 1,
 * where the material yields, then amber → green → blue up to the display cap). The vertex `color` attribute keeps
 * the classic full-range ramp (blue → teal → yellow) whatever the display settings: acceptance checks read it.
 * Colours are linear RGB (THREE.Color); `css()` gives sRGB hex.
 */
import * as THREE from 'three';

/** Contour bands, as most CAE tools draw them by default. */
export const BANDS = 10;
export const MIN_BANDS = 4;
export const MAX_BANDS = 24;

export type ColormapId = 'rainbow' | 'viridis' | 'cividis';
export const COLORMAPS: { id: ColormapId; label: string; hint: string; stops: string[] }[] = [
  { id: 'rainbow', label: 'Rainbow', hint: 'Blue to red, as most CAE tools show results',
    stops: ['#1f3fd0', '#1aa3e6', '#26c9a0', '#8ad13a', '#f2d636', '#f58c2a', '#df3a2f'] },
  { id: 'viridis', label: 'Viridis', hint: 'Perceptually uniform; prints in greyscale',
    stops: ['#440154', '#46327e', '#365c8d', '#277f8e', '#1fa187', '#4ac16d', '#a0da39', '#fde725'] },
  { id: 'cividis', label: 'Cividis', hint: 'Readable with colour-vision deficiency',
    stops: ['#00224e', '#233e6c', '#4b5a6c', '#707173', '#958f78', '#bfae6d', '#e8cf55', '#fee838'] },
];

const LOW = new THREE.Color('#2944a3'), MIDDLE = new THREE.Color('#21bfa4'), HIGH = new THREE.Color('#f5da4b');
export const FAIL = new THREE.Color('#e5484d');
export const AMBER = new THREE.Color('#f5a524');
export const GREEN = new THREE.Color('#30a46c');
const BLUE = new THREE.Color('#2944a3');
/** Below-target safety factors run from deep red (lowest) to a light red at the target. */
const DEEP = new THREE.Color('#9b111e'), LIGHT = new THREE.Color('#f6a7a1');
/** Material the current view doesn't colour: above a safety target, or outside a custom legend range. */
export const NEUTRAL = new THREE.Color('#8d939b');
/** The single colour of the mesh view. */
export const MESH = MIDDLE;
/** Inside faces of a cut surface result, where no interior values exist. */
export const INSIDE = new THREE.Color('#3a3f47');

export type ScaleKind = 'field' | 'safety';
export type SafetyMode = 'gradient' | 'traffic' | 'target';

/** The classic ramp at a normalised level t ∈ [0, 1] (the vertex colour attribute). */
export function fieldColor(t: number, target = new THREE.Color()): THREE.Color {
  return target.copy(t < 0.5 ? LOW : MIDDLE).lerp(t < 0.5 ? MIDDLE : HIGH, t < 0.5 ? t * 2 : (t - 0.5) * 2);
}

const stopCache = new Map<ColormapId, THREE.Color[]>();
const stopsOf = (id: ColormapId) => {
  if (!stopCache.has(id)) stopCache.set(id, (COLORMAPS.find((map) => map.id === id) ?? COLORMAPS[0]).stops.map((hex) => new THREE.Color(hex)));
  return stopCache.get(id)!;
};

/** A colormap's colour at t ∈ [0, 1]. */
export function mapColor(id: ColormapId, t: number, target = new THREE.Color()): THREE.Color {
  const stops = stopsOf(id), x = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
  return target.copy(stops[i]).lerp(stops[i + 1], x - i);
}

/** The colour of a safety factor; `cap` is the top of the scale. */
export function safetyColor(value: number, cap: number, target = new THREE.Color()): THREE.Color {
  if (value < 1) return target.copy(FAIL);
  const t = Math.min(1, (value - 1) / (cap - 1));
  return target.copy(t < 0.25 ? AMBER : GREEN).lerp(t < 0.25 ? GREEN : BLUE, t < 0.25 ? t * 4 : (t - 0.25) / 0.75);
}

/** A below-target safety factor's colour, `t` from 0 (the lowest shown) to 1 (the target). */
export const targetColor = (t: number, target = new THREE.Color()) => target.copy(DEEP).lerp(LIGHT, Math.min(1, Math.max(0, t)));

/** The classic ramp for every value over the full range, as the vertex colour array. */
export function vertexColors(values: Float32Array, kind: ScaleKind, min: number, max: number, cap: number): Float32Array {
  const colors = new Float32Array(values.length * 3);
  const color = new THREE.Color();
  for (let i = 0; i < values.length; i++) {
    if (kind === 'safety') safetyColor(values[i], cap, color);
    else fieldColor(max > min ? (values[i] - min) / (max - min) : 0.5, color);
    color.toArray(colors, i * 3);
  }
  return colors;
}

/** What the legend and the shader colour by. */
export interface Palette { kind: ScaleKind; colormap: ColormapId; safety: SafetyMode; cap: number }

/** The display colour at a legend level t ∈ [0, 1]: a colormap for fields; 1 → cap for gradient safety factors. */
export function paletteColor(palette: Palette, t: number, target = new THREE.Color()): THREE.Color {
  if (palette.kind === 'safety') return palette.safety === 'target' ? targetColor(t, target) : safetyColor(1 + t * (palette.cap - 1), palette.cap, target);
  return mapColor(palette.colormap, t, target);
}

/** The palette as a 256 × 1 lookup texture (sRGB bytes; the shader linearises them). */
export function paletteTexture(palette: Palette): THREE.DataTexture {
  const size = 256, data = new Uint8Array(size * 4), color = new THREE.Color(), srgb = new THREE.Color();
  for (let i = 0; i < size; i++) {
    paletteColor(palette, i / (size - 1), color);
    srgb.copy(color).convertLinearToSRGB();
    data.set([Math.round(srgb.r * 255), Math.round(srgb.g * 255), Math.round(srgb.b * 255), 255], i * 4);
  }
  const texture = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The colour of each band at its centre, lowest band first. */
export function bandColors(palette: Palette, bands = BANDS): THREE.Color[] {
  return Array.from({ length: bands }, (_, i) => paletteColor(palette, (i + 0.5) / bands));
}

export const css = (color: THREE.Color) => `#${color.getHexString()}`;

/** A CSS gradient for a legend bar, `direction` towards the high end: hard stops when banded. */
export function legendGradient(palette: Palette, banded: boolean, direction = 'to top', bands = BANDS): string {
  if (palette.kind === 'safety' && palette.safety === 'traffic') return `linear-gradient(${direction}, ${css(FAIL)} 0 33.3%, ${css(AMBER)} 33.3% 66.6%, ${css(GREEN)} 66.6% 100%)`;
  if (banded) {
    const colors = bandColors(palette, bands).map(css);
    return `linear-gradient(${direction}, ${colors.map((color, i) => `${color} ${(i / bands) * 100}% ${((i + 1) / bands) * 100}%`).join(', ')})`;
  }
  const stops = Array.from({ length: 21 }, (_, i) => i / 20), color = new THREE.Color();
  return `linear-gradient(${direction}, ${stops.map((t) => `${css(paletteColor(palette, t, color))} ${t * 100}%`).join(', ')})`;
}
