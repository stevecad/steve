/**
 * A full build's STEP file, made only when something needs it: what the app says while it's made and how it
 * waits for it (POST /v1/builds/{id}/step, then GET until it's made). The app's exports go through
 * state/stepFile.ts stepFileFor, which shows this in the status bar.
 */
import type { StepStatus } from './api';
import { progressLabel } from './buildProgress';

/** What the status bar says while the STEP file is made. */
export const MAKING_STEP = 'Making STEP file…';

/** The server's answer (Api.step), loaded when first used: this module stays free of the API client for its tests. */
const askServer = (id: string, start = false, retry = false) => import('./api').then(({ Api }) => Api.step(id, start, retry));

const wait = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** "about 40 s", "about 3 min": the time the server expects the STEP file to take still. */
export function etaWords(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  return seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s` : `about ${Math.round(seconds / 60)} min`;
}

/** The status bar's words for a STEP file being made: the stage it's in and the time left, when the server says. */
export function stepLabel(status: StepStatus | null): string {
  const parts = [MAKING_STEP];
  const stage = status?.progress ? progressLabel(status.progress, '') : '';
  if (stage) parts.push(stage);
  else if (status?.job === 'queued') parts.push('waiting for a geometry worker');
  const eta = etaWords(status?.eta_s);
  if (eta) parts.push(eta);
  return parts.join(' · ');
}

/**
 * Asks for build `id`'s STEP file and waits until it's made, failed or can't be (none). `onProgress` gets every
 * answer while it's being made. Checks again after the server's retry_after (1–5 s here, so the status bar keeps up).
 * `ask` and `pause` are for tests.
 */
export async function waitForStep(id: string, { onProgress, retry = false, pause = wait, ask = askServer }: {
  onProgress?: (status: StepStatus) => void; retry?: boolean; pause?: (seconds: number) => Promise<void>;
  ask?: (id: string, start?: boolean, retry?: boolean) => Promise<StepStatus>;
} = {}): Promise<StepStatus> {
  let status = await ask(id, true, retry);
  while (status.state === 'making') {
    onProgress?.(status);
    await pause(Math.min(5, Math.max(1, status.retry_after ?? 2)));
    status = await ask(id);
  }
  return status;
}
