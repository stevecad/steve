import { get, set, toast } from '@/state/store';
import { applyDocumentRevision } from '@/state/actions';
import { editFeatures, type FeatureChange } from '@/lib/features';

/**
 * Sends parameter edits to the server, which rewrites the source, regenerates and verifies
 * before saving. Returns an error message, or null once the verified revision is shown.
 */
export async function applyFeatureEdit(changes: FeatureChange[], label: string, keepActive: string | null): Promise<string | null> {
  const saved = get().doc.saved;
  if (!saved || !changes.length) return 'Save the design first.';
  set({ busy: true, phase: 'running', phaseLabel: 'Applying parameter edit', phaseStarted: Date.now() });
  try {
    const result = await editFeatures(saved.id, saved.revision, changes);
    set({ busy: false, features: { state: 'ready', tree: result.features } });
    // The document, feature tree and geometry come back mutually consistent; show them together.
    await applyDocumentRevision(result.document, result.model);
    set({ activeFeature: keepActive });
    toast('success', `${label} updated`, `Verified and saved as revision ${result.document.revision}.`);
    return null;
  } catch (caught) {
    set({ busy: false, phase: 'failed', phaseLabel: 'Edit rejected' });
    return (caught as Error).message;
  }
}

/** Pseudo-feature id that opens the design-parameter table in the Inspector. */
export const PARAMETERS_ID = '__parameters';
