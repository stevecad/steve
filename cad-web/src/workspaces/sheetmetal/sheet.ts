/**
 * The displayed build's sheet-metal report (`sheet-metal.json`, docs/SHEET_METAL.md): per sheet body
 * its rules, panels, bends and the flat pattern (outline curves, bend lines, size). The flat view, the
 * bend table and exports all read it; nothing here is the source of truth (the code is).
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { get, set, toast, useApp, type Pick } from '@/state/store';
import type { Build } from '@/lib/api';
import { fullBuildFor } from '@/state/actions';
import { viewer } from '@/viewport/viewer';
import type { FaceInfo } from '@/viewport/model';
import { refFor } from '@/modeling/dialog';
import { withWorkspace } from '@/teams/current';

export type XY = [number, number];

export interface Segment {
  type: 'line' | 'arc' | 'circle' | 'polyline';
  start?: XY; end?: XY; midpoint?: XY; center?: XY; radius_mm?: number; points?: XY[];
}

export interface FlatBend { id: string; kind?: 'bend' | 'roll'; segment?: number; start: XY; end: XY; direction: 'up' | 'down'; angle_deg: number; radius_mm: number; allowance_mm: number }

/** A placed form in the flat: its center and process marks (forming drawing only, never cut lines). */
export interface FlatForm { id: string; kind: string; center: XY; direction: 'up' | 'down'; flat_treatment: string; marks: Segment[] }

export interface Flat {
  bounds_mm: [number, number, number, number];
  area_mm2: number;
  perimeter_mm: number;
  outlines: { hole: boolean; segments: Segment[] }[];
  bends: FlatBend[];
  forms?: FlatForm[];
}

/** A `sheet_form` placement with its tool, as the sheet-metal report records it. */
export interface SheetForm {
  id: string; panel: string; at: XY; angle_deg: number; direction: 'up' | 'down'; clearance_mm: number; flat_treatment: string; thickness_model?: string;
  tool: { kind: string; name: string | null; source: string | null; parameters: Record<string, number | null> };
  resolved?: Record<string, number | boolean | string>;
}

/** A `sheet_rip`: a planar slit, a separated bend (`pieces` are the sheets it leaves) or an opened tube seam. */
export interface SheetRip {
  id: string; kind: 'planar' | 'bend' | 'cylinder'; gap_mm: number; gap_reference?: string;
  bend?: string; panel?: string; pieces?: string[]; developed_gap_mm?: number; seam_angle_deg?: number;
}

export interface Bend {
  id: string; parent: string; child: string; angle_deg: number; radius_mm: number; k_factor: number | null;
  allowance_method: string; allowance_mm: number; straight_length_mm: number; width_mm: number;
}

export interface SheetBody {
  id: string;
  instance: string;
  component: string | null;
  body: string;
  status: 'ready' | 'invalid';
  error?: string;
  rules: {
    thickness: number; radius: number; k_factor: number | null;
    /** A named rule's provenance (docs/SHEET_METAL.md): rule name, gauge label, material, source note, bend table. */
    name?: string | null; gauge?: string | null; material?: string | null; source?: string | null;
    bend_table?: { name?: string | null; source?: string | null; rows: unknown[]; interpolate?: boolean } | null;
  };
  /** Coded findings: SM_FLANGE_TOO_SHORT, SM_FEATURE_NEAR_BEND, SM_FLAT_OVERLAP, … */
  diagnostics?: Diagnostic[];
  material?: { material: string; finish?: string | null } | null;
  panels: { id: string }[];
  bends: Bend[];
  state: 'folded' | 'unfolded';
  fixed: string;
  flat?: Flat;
  forms?: SheetForm[];
  rips?: SheetRip[];
  /** File names in the flat-pattern ZIP; the forming DXF and form table exist only for bodies with forms. */
  dxf?: string; form_dxf?: string; form_table?: string; bend_table?: string;
  source?: { document_id: string; revision: number } | null;
}

export interface Diagnostic {
  code: string; severity: 'error' | 'warning' | 'info'; message: string;
  feature?: string | null; entity?: string | null; measured?: number | null; limit?: number | null; units?: string | null;
}

export interface SheetReport {
  status: 'ready' | 'invalid'; units: 'mm'; bodies: SheetBody[];
  /** Geometry and development are checked; shop tooling and material limits are not (yet). */
  manufacturing_validation?: { status: string; reason?: string };
}

/** Which sheet body the views show and the bend under the pointer (the flat view's toggle is app state). */
export const useSheetView = create<{ body: string | null; hover: string | null }>(() => ({ body: null, hover: null }));

export const toggleFlat = () => set((state) => ({ flatView: !state.flatView }));

const reports = new Map<string, Promise<SheetReport>>();

export function sheetReport(build: Build): Promise<SheetReport> | null {
  const url = build.artifacts.sheet_metal;
  if (!url) return null;
  let pending = reports.get(build.id);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`The sheet-metal report failed to load (${response.status}).`);
      return response.json() as Promise<SheetReport>;
    });
    pending.catch(() => reports.delete(build.id));
    reports.set(build.id, pending);
    if (reports.size > 12) reports.delete(reports.keys().next().value!);
  }
  return pending;
}

/** The displayed build's sheet report; null while loading or when the build has no sheet metal. */
export function useSheetReport(): SheetReport | null {
  const build = useApp((state) => state.displayed);
  const [report, setReport] = useState<{ id: string; value: SheetReport } | null>(null);
  useEffect(() => {
    if (!build) return;
    let cancelled = false;
    sheetReport(build)?.then((value) => { if (!cancelled) setReport({ id: build.id, value }); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [build]);
  // A newer build without sheet metal (or still loading) must not show the previous report.
  if (!build?.artifacts.sheet_metal) return null;
  return report?.id === build.id ? report.value : report?.value ?? null;
}

/** The body the views show: the chosen one when it still exists, otherwise the first. */
export function chosenBody(report: SheetReport | null, chosen: string | null): SheetBody | null {
  if (!report?.bodies.length) return null;
  return report.bodies.find((body) => body.id === chosen) ?? report.bodies[0];
}

export const bodyLabel = (body: SheetBody) => (body.instance === 'part' ? body.body : `${body.instance} · ${body.body}`);

/** The bend's cylindrical faces in the viewport, to show which bend a table row is. */
export function bendPicks(bend: string): Pick[] {
  const model = viewer.model;
  if (!model) return [];
  const names = new Set([`${bend}.bend.inner`, `${bend}.bend.outer`]);
  return model.allFaces().flatMap((face: FaceInfo) => {
    const pick: Pick = { kind: 'face', node: face.node, mesh: face.meshIndex, index: face.faceIndex };
    const ref = refFor(pick);
    return ref && names.has(ref) ? [pick] : [];
  });
}

export const selectBend = (bend: string) => set({ selection: bendPicks(bend) });

/** Hovering a bend (table row or flat line) lights it in the views; null clears. */
export function hoverBend(bend: string | null) {
  useSheetView.setState({ hover: bend });
  set({ hover: bend ? bendPicks(bend).at(-1) ?? null : null });
}

const fileName = (suffix: string) => `${(get().doc.name || 'sheet').replace(/[^\w.-]+/g, '_')}-${suffix}`;

function download(href: string, name: string) {
  const link = document.createElement('a');
  link.href = withWorkspace(href);
  link.download = name;
  link.click();
}

/** The flat patterns as layered DXFs (one per sheet body, with the manifest) in a ZIP; needs a full build. */
export async function exportFlat() {
  const displayed = get().displayed;
  const pending = displayed && sheetReport(displayed);
  if (!displayed || !pending) return;
  const report = await pending.catch(() => null);
  const invalid = report?.bodies.find((body) => body.status !== 'ready');
  if (invalid) { toast('danger', 'The flat pattern can’t be exported yet', invalid.error ?? 'A sheet-metal feature failed.'); return; }
  let build = displayed;
  if (!build.artifacts.sheet_metal_export) {
    set({ busy: true, phase: 'running', phaseLabel: 'Preparing DXF', phaseStarted: Date.now() });
    try { build = await fullBuildFor(displayed); } catch (error) {
      set({ busy: false, phase: 'failed', phaseLabel: 'Export failed' });
      toast('danger', 'Couldn’t export the flat pattern', (error as Error).message);
      return;
    }
    set({ busy: false, phase: 'succeeded', phaseLabel: 'Model ready' });
  }
  if (!build.artifacts.sheet_metal_export) { toast('danger', 'Couldn’t export the flat pattern', 'The full build has no flat-pattern archive; check the sheet features for errors.'); return; }
  // Saved under the part's name (the artifact URL's own header names it after the build).
  const response = await fetch(build.artifacts.sheet_metal_export);
  if (!response.ok) { toast('danger', 'Couldn’t export the flat pattern', `The download failed (${response.status}).`); return; }
  const url = URL.createObjectURL(await response.blob());
  download(url, fileName('flat.zip'));
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const forming = report?.bodies.some((body) => body.form_dxf);
  toast('success', 'Exporting flat patterns', `For each sheet body: a cutting DXF in millimetres (CUT, BEND_UP, BEND_DOWN, ROLL layers), its bend table and an SVG illustration.${
    forming ? ' Bodies with forms add a forming DXF and form table for the press shop; the cutting DXF has no form marks.' : ''}`);
}

/** The bend table as CSV, for the brake operator or a quote. */
export function exportBends(body: SheetBody) {
  const flat = new Map((body.flat?.bends ?? []).map((bend) => [bend.id, bend]));
  const rows = [['bend', 'direction', 'angle_deg', 'inside_radius_mm', 'k_factor', 'bend_allowance_mm', 'bend_length_mm', 'flange_length_mm']];
  for (const bend of body.bends) {
    rows.push([bend.id, flat.get(bend.id)?.direction ?? (bend.angle_deg > 0 ? 'up' : 'down'), String(Math.abs(bend.angle_deg)), String(bend.radius_mm),
      bend.k_factor === null ? '' : String(bend.k_factor), bend.allowance_mm.toFixed(3), bend.width_mm.toFixed(3), bend.straight_length_mm.toFixed(3)]);
  }
  const url = URL.createObjectURL(new Blob([rows.map((row) => row.join(',')).join('\n') + '\n'], { type: 'text/csv' }));
  download(url, fileName(`${body.body}-bends.csv`));
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
