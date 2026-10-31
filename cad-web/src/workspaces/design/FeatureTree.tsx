import { useEffect } from 'react';
import { get, set, useApp } from '@/state/store';
import { fetchFeatures, utf8RangeToOffsets, type Feature } from '@/lib/features';

/* The feature history is shown by the timeline under the viewport; the model browser lists structure only. */

export function revealSource(feature: Feature) {
  const source = feature.source;
  if (!source) return;
  const { from, to } = utf8RangeToOffsets(get().doc.code, source);
  set({ sourceReveal: { from, to, nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}

/** Loads the parametric feature history whenever the saved revision or its geometry changes. */
export function useFeatureSync() {
  const id = useApp((state) => state.doc.saved?.id);
  const revision = useApp((state) => state.doc.saved?.revision);
  const build = useApp((state) => state.displayed?.id);
  const kind = useApp((state) => state.doc.kind);
  useEffect(() => {
    // Unsaved modeling documents have their own local feature tree. A preview
    // changing the displayed build must not clear its Inspector selection.
    // Opening/closing a document already resets selection in clearWorkspace.
    if (!id) { set({ features: null }); return; }
    // The captured feature history is for parts; a design's components each have their own file.
    if (kind !== 'part') { set({ features: { state: 'unavailable' } }); return; }
    let cancelled = false;
    void fetchFeatures(id).then((result) => { if (!cancelled) set({ features: result }); });
    return () => { cancelled = true; };
  }, [id, revision, build, kind]);
}
