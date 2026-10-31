/** Over the viewport while a study meshes or solves: what it's doing, for how long, and Cancel. */
import { useEffect, useState } from 'react';
import { useApp } from '@/state/store';
import { terminal } from './api';
import { stageLabel } from './physics';
import { cancelRun, useSimulation } from './state';
import sim from './Simulate.module.css';

export function useRunPill(): React.ReactNode {
  const study = useApp((state) => state.studies.find((item) => item.id === state.activeStudy));
  const run = useSimulation((state) => (study ? state.runs[study.id] : undefined));
  const since = useSimulation((state) => (run ? state.startedAt[run.id] : undefined));
  const [now, setNow] = useState(Date.now());
  const active = !!run && !terminal(run);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!study || !run || !active) return null;
  const seconds = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  return (
    <span className={sim.pill} id="run-pill" title={run.waiting?.message}>
      <b>{study.name}</b>
      <i />{run.cancel_requested ? 'Stopping' : stageLabel(run.stage, run.status, run.waiting)}… {seconds} s
      {!run.cancel_requested && <button type="button" onClick={() => { void cancelRun(run); }}>Cancel</button>}
    </span>
  );
}
