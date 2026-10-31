import { useEffect, useState } from 'react';
import { simulationApi, type ResourceLimits, type Run } from './api';
import { useSimulation } from './state';
import styles from '@/panels/Panels.module.css';

const limits = (value: ResourceLimits) => `${value.cpu_millis / 1000} CPU · ${value.memory_mb / 1024} GiB · ${value.solver_seconds} s solver limit · ${value.output_mb} MiB output`;

export default function ResourceSettings({ disabled, run }: { disabled: boolean; run?: Run }) {
  const selected = useSimulation((state) => state.resourceClass);
  const [profiles, setProfiles] = useState<Record<string, ResourceLimits>>({});
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(true);
  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const value = await simulationApi<{ admission: { policy: { profiles: Record<string, ResourceLimits>; accepting: boolean } } }>('simulation/capabilities');
        if (!current) return;
        setProfiles(value.admission.policy.profiles); setAccepting(value.admission.policy.accepting); setError(null);
        if (!value.admission.policy.profiles[useSimulation.getState().resourceClass]) useSimulation.setState({ resourceClass: 'standard' });
      } catch (problem) { if (current) setError(problem instanceof Error ? problem.message : String(problem)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  return <>
    <label>Compute profile <select aria-label="Simulation compute profile" value={selected} disabled={disabled || !Object.keys(profiles).length}
      onChange={(event) => useSimulation.setState({ resourceClass: event.target.value })}>
      {Object.keys(profiles).map((name) => <option key={name} value={name}>{name}</option>)}
    </select></label>
    {profiles[selected] && <span className={styles.muted} aria-label="Simulation resource limits">{limits(profiles[selected])}</span>}
    {!accepting && <span role="status">New simulation runs are temporarily paused.</span>}
    {run?.resources && <span className={styles.muted}>This run: {run.resource_class} · {limits(run.resources)}</span>}
    {run?.usage && <span className={styles.muted}>Solver elapsed: {run.usage.solver_wall_seconds.toFixed(1)} s</span>}
    {error && <span role="alert">{error}</span>}
  </>;
}
