/**
 * The export format the top bar's split button repeats: the last one used, remembered per browser. Also the mesh
 * resolution the 3MF, STL and print set exports use (Export menu → Mesh resolution), and the print bed the print set's
 * plates are laid out on (Export menu → Print bed), remembered the same way.
 */
import { create } from 'zustand';
import type { MeshResolution } from '@/lib/api';

export type ExportFormat = 'step' | '3mf' | 'stl';

export const EXPORT_FORMATS: Record<ExportFormat, { command: string; label: string }> = {
  step: { command: 'export.step', label: 'STEP' },
  '3mf': { command: 'export.3mf', label: '3MF' },
  stl: { command: 'export.stl', label: 'STL' },
};

const KEY = 'steve-export-format';
const recalled = (): ExportFormat => {
  try {
    const value = localStorage.getItem(KEY);
    return value && value in EXPORT_FORMATS ? (value as ExportFormat) : 'step';
  } catch { return 'step'; }
};

export const useExportFormat = create<{ format: ExportFormat }>(() => ({ format: recalled() }));

export function rememberFormat(format: ExportFormat) {
  useExportFormat.setState({ format });
  try { localStorage.setItem(KEY, format); } catch { /* storage unavailable: remembered for this session */ }
}

/** Mesh resolutions, finest first: the server's linear and angular deflection (runtime/run.py MESH_RESOLUTIONS). */
export const MESH_RESOLUTIONS: Record<MeshResolution, { label: string; hint: string; linear_mm: number; angular_rad: number }> = {
  fine: { label: 'Fine', hint: 'Smoothest · largest file', linear_mm: 0.02, angular_rad: 0.1 },
  medium: { label: 'Medium', hint: 'Smaller file', linear_mm: 0.05, angular_rad: 0.2 },
  coarse: { label: 'Coarse', hint: 'Smallest file', linear_mm: 0.1, angular_rad: 0.35 },
};

const RESOLUTION_KEY = 'steve-mesh-resolution';
const recalledResolution = (): MeshResolution => {
  try {
    const value = localStorage.getItem(RESOLUTION_KEY);
    return value && value in MESH_RESOLUTIONS ? (value as MeshResolution) : 'fine';
  } catch { return 'fine'; }
};

export const useMeshResolution = create<{ resolution: MeshResolution }>(() => ({ resolution: recalledResolution() }));

export function rememberResolution(resolution: MeshResolution) {
  useMeshResolution.setState({ resolution });
  try { localStorage.setItem(RESOLUTION_KEY, resolution); } catch { /* storage unavailable: remembered for this session */ }
}

/** Print beds the print set lays its plates out on (Export menu → Print bed), width × depth in mm, smallest first. */
export const PRINT_BEDS: Record<string, { label: string; size_mm: [number, number] }> = {
  '180x180': { label: '180 × 180 mm', size_mm: [180, 180] },
  '220x220': { label: '220 × 220 mm', size_mm: [220, 220] },
  '250x210': { label: '250 × 210 mm', size_mm: [250, 210] },
  '256x256': { label: '256 × 256 mm', size_mm: [256, 256] },
  '350x350': { label: '350 × 350 mm', size_mm: [350, 350] },
};

const BED_KEY = 'steve-print-bed';
const recalledBed = (): string => {
  try {
    const value = localStorage.getItem(BED_KEY);
    return value && value in PRINT_BEDS ? value : '220x220';
  } catch { return '220x220'; }
};

export const usePrintBed = create<{ bed: string }>(() => ({ bed: recalledBed() }));

export function rememberBed(bed: string) {
  usePrintBed.setState({ bed });
  try { localStorage.setItem(BED_KEY, bed); } catch { /* storage unavailable: remembered for this session */ }
}
