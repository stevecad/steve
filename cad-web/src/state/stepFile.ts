/**
 * A full build's STEP file, made only when something needs it: full builds no longer write one, and the first
 * export, download or send asks the server for it (POST /v1/builds/{id}/step) and waits. Every STEP export in the app
 * comes through here: the status bar says "Making STEP file…" with the stage and the time left while it's made, then
 * the export carries on by itself; a failure says why, with a Retry button. Nothing skips silently. Builds made before
 * this keep their STEP file and answer "ready" at once.
 */
import { ApiError, type Build, type StepStatus } from '@/lib/api';
import { MAKING_STEP, stepLabel, waitForStep } from '@/lib/stepFile';
import { toast } from './store';

export { MAKING_STEP, stepLabel, waitForStep };

/** Builds whose next STEP request is the person's Retry: it runs again even after using its whole budget. */
const retrying = new Set<string>();

/**
 * The STEP file of full build `build`, made now if it isn't yet, with the status bar showing it (`status`: the app's
 * export status, exportStatus). True once it exists. Otherwise the person is told why (a failure's reason with Retry,
 * which runs `again`, the export that asked) and it's false.
 */
export async function stepFileFor(build: Build, status: (label: string | null, failed?: boolean) => void, again: () => void): Promise<boolean> {
  if (build.step === 'ready') return true;
  const retry = retrying.delete(build.id);
  let answer: StepStatus;
  status(MAKING_STEP);
  try {
    answer = await waitForStep(build.id, { retry, onProgress: (progress) => status(stepLabel(progress)) });
  } catch (error) {
    status(null, true);
    const reason = error instanceof ApiError || error instanceof Error ? error.message : String(error);
    toast('danger', 'Couldn’t make the STEP file', reason, { action: { label: 'Retry', run: again } });
    return false;
  }
  if (answer.state === 'ready') {
    status(null);
    return true;
  }
  status(null, true);
  if (answer.state === 'failed') {
    toast('danger', 'Couldn’t make the STEP file', answer.error || answer.message || 'The STEP export failed.', {
      action: { label: 'Retry', run: () => { retrying.add(build.id); again(); } },
    });
  } else {
    toast('warning', 'No STEP file', answer.message || 'This build has no STEP file.');
  }
  return false;
}
