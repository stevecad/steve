import { useEffect } from 'react';
import { get, set, useApp } from '@/state/store';
import { loadLinkedStudies, pinnedSelection, picksFor, report, resumeStudy, stopPicking, stopWatching, togglePickedFace, useSimulation } from './state';

/** Mounted with the simulation workspace; durable jobs survive unmount and reconnect. */
export default function StudySync() {
  const documentId = useApp((s) => s.doc.saved?.id);
  const active = useApp((s) => s.activeStudy);
  const modelVersion = useApp((s) => s.modelVersion);
  const revision = useApp((s) => s.studies.find((study) => study.id === s.activeStudy)?.revision);
  // A study made active before the design's studies arrive (a ?study= link) resumes once it's loaded.
  const loaded = !!revision;
  const designRevision = useApp((s) => s.doc.saved?.revision);
  useEffect(() => {
    if (!documentId) return;
    void loadLinkedStudies(documentId).catch(report);
    // Studies an outside agent (MCP) made appear when the person comes back to this tab: one fetch, no polling.
    const onVisible = () => { if (document.visibilityState === 'visible') void loadLinkedStudies(documentId).catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [documentId]);
  // A boundary picking faces: each face the user clicks goes to it (a second click removes it). Esc ends.
  useEffect(() => {
    const unsubscribe = useApp.subscribe((state) => state.selection, (selection) => {
      if (!useSimulation.getState().picking) return;
      const faces = selection.filter((pick) => pick.kind === 'face');
      if (!faces.length) return;
      faces.forEach(togglePickedFace);
      set({ selection: [] });
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && useSimulation.getState().picking) { event.preventDefault(); stopPicking(); } };
    window.addEventListener('keydown', onKey);
    return () => { unsubscribe(); window.removeEventListener('keydown', onKey); stopPicking(); };
  }, []);
  useEffect(() => {
    const picking = useSimulation.getState().picking;
    if (picking && picking.studyId !== active) stopPicking();
  }, [active]);
  // Another study chosen (the ribbon, STEVE, a link), or Simulate opened again: back to that one study.
  useEffect(() => { set({ studyOverview: false }); }, [active, documentId]);
  useEffect(() => {
    useSimulation.setState({ result: null, error: null });
    const study = get().studies.find((s) => s.id === active);
    if (study?.revision) void resumeStudy(study).catch(report);
    return stopWatching;
  }, [active, documentId, loaded]);
  useEffect(() => {
    const state = get();
    set({ studies: state.studies.map((study) => {
      if (!study.definition) return study;
      const same = pinnedSelection(study);
      return { ...study, loads: study.loads.map((load) => ({ ...load, picks: same ? picksFor(load.refs ?? []) : [] })) };
    }) });
  }, [active, documentId, modelVersion, revision, designRevision]);
  return null;
}
