/**
 * Face & edge selection, prepared when it's first needed. Selecting faces, edges and corners needs a build's topology;
 * a build that ran out of time for it (a design of large imported meshes, say) records it as partial or missing
 * (metadata.topology). Then the first pick (a click on the model) or a tool that takes picks (a feature dialog,
 * sketching, measure, a construction plane, joints, motion, CAM, a tool from a part, a simulation boundary) asks the
 * server to complete it (a topology job, app/derivations.py); viewing the model, editing code and agents never do.
 * The viewport shows it's preparing, and the finished data is swapped in without moving the camera. A click on a part
 * still waiting for it is held and completed then, if the view hasn't moved. If the job fails, the pill says so and
 * offers to try again; if it ran out of time partway, what it described can be picked and the pill says the rest can't. A job already started keeps running; asking again joins it.
 */
import { create } from 'zustand';
import { api, type Build } from '@/lib/api';
import { useApp } from '@/state/store';
import { refreshSelectionData } from '@/state/actions';
import { useFeatureDialog } from '@/modeling/dialog';
import { useCam } from '@/workspaces/manufacture/cam/state';
import { useFromPart } from '@/workspaces/manufacture/fromPart';
import { useSimulation } from '@/workspaces/simulate/state';
import { viewer, type CameraPose } from './viewer';

type Phase = 'idle' | 'preparing' | 'partial' | 'failed';
interface Status { state: 'complete' | 'partial' | 'missing'; job: { status: string; error: string | null } | null }

/** `held`: a click is waiting for the selection data, and completes when it arrives. */
export const useSelectionPrep = create<{ buildId: string | null; phase: Phase; error: string; held: boolean }>(() => ({ buildId: null, phase: 'idle', error: '', held: false }));

let timer: number | undefined;
let watching: string | null = null;
/** A build the server queued no job for: there's nothing more to prepare. */
let settled: string | null = null;
let held: { buildId: string; event: PointerEvent; button: number; pose: CameraPose | null } | null = null;

/** Only CAD geometry (parts and designs) has faces and edges to pick. */
const CAD_KINDS = new Set<string>(['part', 'design']);

const needsPreparing = (build: Build | null) => {
  if (!build || build.status !== 'succeeded' || build.metadata?.empty || !CAD_KINDS.has(build.kind)) return false;
  const recorded = (build.metadata as { topology?: { state?: string } } | null | undefined)?.topology?.state;
  if (recorded) return recorded !== 'complete';
  return !viewer.model?.hasTopology;  // Builds from before the state was recorded: topology or none.
};

const samePose = (a: CameraPose | null, b: CameraPose | null) =>
  !!a && !!b && a.zoom === b.zoom && a.position.every((value, index) => Math.abs(value - b.position[index]) <= 1e-6 * Math.max(1, Math.abs(value)));

function release(buildId: string) {
  const click = held;
  held = null;
  useSelectionPrep.setState({ held: false });
  // Completed where it was clicked, unless the view has moved or another model is shown since.
  if (click && click.buildId === buildId && useApp.getState().displayed?.id === buildId && samePose(click.pose, viewer.capturePose())) viewer.clickAt(click.event, click.button);
}

async function poll(buildId: string, start: boolean, retry = false) {
  window.clearTimeout(timer);
  if (watching !== buildId || useApp.getState().displayed?.id !== buildId) return;
  let status: Status;
  try {
    status = await api<Status>(`/v1/builds/${buildId}/selection${start ? `/prepare${retry ? '?retry=true' : ''}` : ''}`, start ? { method: 'POST' } : {});
  } catch {
    timer = window.setTimeout(() => void poll(buildId, false), 8000);  // Server busy or restarting: ask again.
    return;
  }
  if (watching !== buildId) return;
  if (status.state === 'complete') {
    useSelectionPrep.setState({ buildId, phase: 'idle', error: '' });
    watching = null;
    await refreshSelectionData(buildId);
    release(buildId);
    return;
  }
  if (!status.job || status.job.status === 'none') {
    // Nothing is preparing it (the server queued no job): there's nothing to wait for, so no pill.
    useSelectionPrep.setState({ buildId: null, phase: 'idle', error: '' });
    watching = null;
    settled = buildId;  // Picks on it aren't asked again.
    release(buildId);  // What can be picked already is.
    return;
  }
  if (status.job.status === 'succeeded') {
    // It ran out of time partway (partial): what it described is shown and pickable; the pill says the rest isn't,
    // and only its Try again runs it once more.
    useSelectionPrep.setState({ buildId, phase: 'partial', error: '' });
    watching = null;
    settled = buildId;  // Picks on it go ahead with what's there.
    await refreshSelectionData(buildId);
    release(buildId);
    return;
  }
  if (status.job.status === 'failed') {
    useSelectionPrep.setState({ buildId, phase: 'failed', error: status.job.error || 'Face and edge selection couldn’t be prepared.' });
    release(buildId);
    return;
  }
  useSelectionPrep.setState({ buildId, phase: 'preparing', error: '' });
  timer = window.setTimeout(() => void poll(buildId, false), 4000);
}

/**
 * Selection is needed now (a pick, or a tool that takes picks): true when the displayed build's selection data is
 * complete; otherwise starts preparing it (or joins what's already preparing it) and returns false.
 */
export function prepareSelection(): boolean {
  const build = useApp.getState().displayed;
  if (!needsPreparing(build) || settled === build!.id) return true;
  if (watching !== build!.id) {
    watching = build!.id;
    useSelectionPrep.setState({ buildId: build!.id, phase: 'preparing', error: '', held: false });
    void poll(build!.id, true);
  }
  return false;
}

/** A click on a part whose selection data is still being prepared: held, and completed when it arrives (true). */
export function holdClick(event: PointerEvent, button: number): boolean {
  const { buildId, phase } = useSelectionPrep.getState();
  if (phase !== 'preparing' || !buildId || buildId !== useApp.getState().displayed?.id) return false;
  held = { buildId, event, button, pose: viewer.capturePose() };
  useSelectionPrep.setState({ held: true });
  return true;
}

/** Retry after a failure (the pill's button). */
export function retrySelectionPrep() {
  const build = useApp.getState().displayed;
  if (!build) return;
  watching = build.id;
  useSelectionPrep.setState({ buildId: build.id, phase: 'preparing', error: '' });
  void poll(build.id, true, true);  // The person asked: even a job that used its whole budget runs again.
}

/** Whether a tool that takes picks from the model is open. */
const picking = () => {
  const state = useApp.getState();
  return !!state.sketching || state.tool === 'measure' || state.tool === 'plane' || state.tool === 'joint' || state.tool === 'motion'
    || useFeatureDialog.getState().open || !!useCam.getState().editor || useFromPart.getState().open || !!useSimulation.getState().picking;
};

/** Follows the displayed build (another one shown stops following the last), and prepares selection when a tool that
 * takes picks opens. Showing a build never starts it by itself. */
export function installSelectionPrep(): () => void {
  const shown = () => {
    if (watching && watching === useApp.getState().displayed?.id) return;  // Its job is being followed: keep it.
    window.clearTimeout(timer);
    watching = null;
    held = null;
    useSelectionPrep.setState({ buildId: null, phase: 'idle', error: '', held: false });
  };
  let open = picking();
  const tools = () => {
    const now = picking();
    if (now && !open) prepareSelection();  // When the tool opens, not again for each preview shown while it's open.
    open = now;
  };
  const stops = [
    useApp.subscribe((state) => state.displayed?.id, shown),
    useApp.subscribe(tools), useFeatureDialog.subscribe(tools), useCam.subscribe(tools), useFromPart.subscribe(tools), useSimulation.subscribe(tools),
  ];
  return () => { for (const stop of stops) stop(); window.clearTimeout(timer); };
}
