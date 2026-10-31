import { get, set, useApp } from '@/state/store';
import { parseModel, setSharedParameters } from '@/lib/modeling';
import { filesOf, isTable, PARAMS } from '@/state/design';
import { viewer } from '@/viewport/viewer';
import { bodyPicks, editedComponent, faceKeys } from './bodies';

let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Keeps `state.modeling` in step with the open code (parsed on the server, debounced). */
export function installModelingSync() {
  if (installed) return;
  installed = true;
  // A design's component files evaluate expressions with its shared parameters.
  setSharedParameters(() => (get().doc.kind === 'design' ? filesOf(get().doc)[PARAMS] ?? null : null));
  const refresh = (code: string) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      // A circuit is TSX (docs/ELECTRONICS.md), a shop lists machines and tools, a Blender document is bpy: there's no
      // CadQuery model to parse.
      // A design's table (.csv) is data, not code.
      if (!get().doc.open || get().doc.kind === 'circuit' || get().doc.kind === 'shop' || get().doc.kind === 'blender' || isTable(get().doc.activeFile)) { set({ modeling: null }); return; }
      if (!code.trim()) { set({ modeling: { version: 1, canonical: false, parameters: [], features: [], model: null, diagnostics: [] } }); return; }
      try {
        const doc = await parseModel(code);
        if (get().doc.code === code) set({ modeling: doc });
      } catch { /* Older servers have no parser: the modeling UI stays hidden. */ }
    }, 180);
  };
  // A new document opens with the same (empty) code as before, so watch opening too.
  useApp.subscribe((state) => [state.doc.code, state.doc.open, state.doc.activeFile] as const, ([code]) => refresh(code), { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] });
  refresh(get().doc.code);

  // Bodies hidden from the browser stay hidden in each regenerated model; another document starts with all shown.
  const applyBodies = () => {
    const model = viewer.model;
    if (!model) return;
    model.setHiddenFaces(faceKeys(bodyPicks(model, get().hiddenBodies)));
    viewer.invalidate();
  };
  useApp.subscribe((state) => state.hiddenBodies, applyBodies);
  viewer.onModelChange(applyBodies);
  useApp.subscribe((state) => state.activeTab, () => set({ hiddenBodies: [], sketchVisibility: {}, groupRestore: {} }));

  // Editing one of a design's components: the others (and linked parts) stay in view as faint context.
  // In Simulate, what the active study leaves out of its solve is faint the same way (not while all studies show).
  const applyFocus = () => {
    const model = viewer.model;
    if (!model) return;
    const { doc, workspace, studies, activeStudy, studyOverview } = get();
    const analysed = workspace === 'simulate' && !studyOverview ? studies.find((study) => study.id === activeStudy)?.definition?.design.instances ?? [] : [];
    if (analysed.length && model.build.kind !== 'part') {
      const kept = new Set(analysed.map((name) => name.split('/')[0]));
      model.setGhosted([...model.instances].filter(([, instance]) => !kept.has(instance.name)).map(([id]) => id));
      viewer.invalidate();
      return;
    }
    const component = doc.kind === 'design' && doc.activeFile.startsWith('components/') ? editedComponent(model.build) : null;
    model.setGhosted(component ? [...model.instances].filter(([, instance]) => instance.link || instance.component !== component).map(([id]) => id) : []);
    viewer.invalidate();
  };
  viewer.onModelChange(applyFocus);
  useApp.subscribe((state) => [state.workspace, state.activeStudy, state.studies, state.studyOverview] as const, applyFocus,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] });
  // Body ids belong to one component: another file starts with all of its bodies shown.
  useApp.subscribe((state) => state.doc.activeFile, () => { set({ hiddenBodies: [], groupRestore: {} }); applyFocus(); });
}
