import { get, set, type CamSetup, type CamTool, type Study } from './store';

/**
 * CAM setups, material choices, and simulation drafts not saved yet (and legacy studies)
 * live in this browser, keyed by document. Saved studies are on the server
 * (simulate/state.ts, loadLinkedStudies); this cache only bridges until they load.
 */
interface WorkspaceData { version: 1; materials: Record<string, string>; studies: Study[]; setups: CamSetup[] }

const key = (documentId: string) => `steve-workspace:${documentId}`;
const TOOLS_KEY = 'steve-tool-library';
let currentDocument: string | null = null;

export function loadWorkspaceData(documentId: string | null) {
  currentDocument = documentId;
  let data: WorkspaceData | null = null;
  try { data = documentId ? JSON.parse(localStorage.getItem(key(documentId)) || 'null') as WorkspaceData | null : null; } catch { data = null; }
  set({
    materials: data?.materials ?? {},
    studies: data?.studies ?? [],
    setups: data?.setups ?? [],
    activeStudy: data?.studies?.[0]?.id ?? null,
    studyOverview: false,
    activeSetup: data?.setups?.[0]?.id ?? null,
  });
}

/** Associates the in-memory workspace data with a document that was just saved for the first time. */
export function bindWorkspaceData(documentId: string) {
  if (currentDocument === documentId) return;
  currentDocument = documentId;
  persistWorkspaceData();
}

export function persistWorkspaceData() {
  const documentId = currentDocument ?? get().doc.saved?.id ?? null;
  if (!documentId) return;
  const { materials, studies, setups } = get();
  try { localStorage.setItem(key(documentId), JSON.stringify({ version: 1, materials, studies, setups } satisfies WorkspaceData)); } catch { /* Storage is optional. */ }
}

export function loadToolLibrary(defaults: CamTool[]) {
  try {
    const stored = JSON.parse(localStorage.getItem(TOOLS_KEY) || 'null') as CamTool[] | null;
    set({ camTools: stored?.length ? stored : defaults });
  } catch { set({ camTools: defaults }); }
}

export function persistToolLibrary() {
  try { localStorage.setItem(TOOLS_KEY, JSON.stringify(get().camTools)); } catch { /* Storage is optional. */ }
}

