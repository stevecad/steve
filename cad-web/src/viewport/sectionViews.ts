/**
 * Saved section views are code: `section_view("bore_cut", axis="x", at=12.5)` in a part's file or a design's main.py
 * (runtime/steve/sections.py; read and written by lib/sectionViews.ts), so they follow revisions, branches and undo.
 * The Section analysis tool saves them, the model tree lists them (Sections) and shows one as a fixed cut: the clip
 * and its hatched caps, no plane to drag and no panel.
 */
import * as THREE from 'three';
import { create } from 'zustand';
import { get, set, toast, type Axis } from '@/state/store';
import { openFile, setCode, updateModel } from '@/state/actions';
import { MAIN, filesOf } from '@/state/design';
import { insertSectionView, parseSectionViews, removeSectionViewLine, sectionMm, sectionNameProblem, type SectionView } from '@/lib/sectionViews';
import { viewer } from './viewer';

export type { SectionView } from '@/lib/sectionViews';
export { nextSectionName, parseSectionViews, sectionNameProblem } from '@/lib/sectionViews';

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

/** The section being edited in the Section analysis tool (Edit from the tree), so Save rewrites its line. */
export const useSectionEdit = create<{ editing: string | null }>(() => ({ editing: null }));

/** Whether the open document keeps section views: parts (their one file) and designs (main.py). */
export const holdsSections = () => { const kind = get().doc.kind; return kind === 'part' || kind === 'design'; };

function sectionCode(): string {
  const { doc } = get();
  return doc.kind !== 'design' || doc.activeFile === MAIN ? doc.code : filesOf(doc)[MAIN] ?? '';
}

export const sectionViews = () => parseSectionViews(sectionCode());

function writeCode(code: string) {
  if (get().doc.kind === 'design') openFile(MAIN);
  setCode(code);
  void updateModel({ quiet: true });
}

/** The model's extent along an axis, in mm (null without a model). */
export function extent(axis: Axis): [number, number] | null {
  const box = viewer.model?.bounds(false) ?? new THREE.Box3();
  return box.isEmpty() ? null : [box.min.getComponent(AXIS_INDEX[axis]), box.max.getComponent(AXIS_INDEX[axis])];
}

/** Saves the Section analysis tool's cut as a section view, then shows it fixed (the tool closes). */
export function saveSectionView(name: string, position: number) {
  const { section } = get();
  const editing = useSectionEdit.getState().editing;
  const problem = sectionNameProblem(name, editing, sectionViews());
  if (problem) { toast('warning', 'Can’t save the section', problem); return; }
  const view = { name, axis: section.axis, at: sectionMm(position), flip: section.flip };
  writeCode(insertSectionView(sectionCode(), view, editing));
  useSectionEdit.setState({ editing: null });
  set({ section: { ...section, enabled: true, saved: name, at: view.at } });
  toast('success', `Saved ${name}`, 'It’s under Sections in the Browser: click it to see this cut again.');
}

/** Shows a saved section view as a fixed cut, or clears it when it's the one shown. */
export function toggleSectionView(view: SectionView) {
  const { section } = get();
  if (section.enabled && section.saved === view.name) { set({ section: { ...section, enabled: false } }); return; }
  set({ section: { ...section, enabled: true, axis: view.axis, flip: view.flip, saved: view.name, at: view.at } });
}

/** Opens the Section analysis tool at a saved view's cut; Update there rewrites it. */
export function editSectionView(view: SectionView) {
  const range = extent(view.axis);
  const offset = range ? THREE.MathUtils.clamp((view.at - range[0]) / Math.max(range[1] - range[0], 1e-9), 0, 1) : 0.5;
  useSectionEdit.setState({ editing: view.name });
  set((state) => ({ section: { ...state.section, enabled: true, axis: view.axis, flip: view.flip, offset, saved: null, at: null } }));
}

export function removeSectionView(name: string) {
  const { section } = get();
  if (section.saved === name) set({ section: { ...section, enabled: false, saved: null, at: null } });
  writeCode(removeSectionViewLine(sectionCode(), name));
}

/** Opens the code at a section view's line. */
export function showSectionViewCode(view: SectionView) {
  if (get().doc.kind === 'design') openFile(MAIN);
  const lines = get().doc.code.split('\n');
  const from = lines.slice(0, view.line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  set({ sourceReveal: { from, to: from + (lines[view.line - 1]?.length ?? 0), nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}
