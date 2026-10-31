import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, ChoiceCards, Row, SettingsPage } from '../ui';
import { settingsSections } from '../registry';
import styles from './LocalPerformance.module.css';

type Status = { cpu_percent: number; logical_cpus: number; memory_gib: number; capacity: number;
  ready: number; warming: number; active: number; queued: number; completed: number;
  cpu_usage_percent: number | null; enforcement: 'windows_job' | 'concurrency' };

export default function LocalPerformance() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await api<Status>('/v1/local/performance'); if (live) setData(value); }
      catch (e) { if (live) setError((e as Error).message); }
      finally { if (live) timer = setTimeout(() => void poll(), 1000); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  const save = async (cpu_percent: number) => {
    setSaving(true); setError('');
    try { setData(await api<Status>('/v1/local/performance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({cpu_percent}) })); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <SettingsPage section={settingsSections().find(s => s.id === 'local-performance')!}>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!data ? <p>Reading local worker status…</p> : <>
      <Card title="CPU budget" description={`${data.logical_cpus} logical processors · ${data.memory_gib} GB system memory`}>
        <ChoiceCards label="CPU budget" value={data.cpu_percent} disabled={saving} options={[
          { value: 50, label: 'Balanced', description: '50% CPU budget' },
          { value: 80, label: 'Performance', description: '80% CPU budget' },
          { value: 100, label: 'Maximum', description: '100% CPU budget' },
        ]} onChange={value => void save(value)} />
        <p className={styles.note} role="status">{saving ? 'Saving CPU budget…' : `Current budget: ${data.cpu_percent}% · Changes save automatically.`}</p>
        <p className={styles.note}>{data.enforcement === 'windows_job'
          ? 'Windows enforces this combined CPU limit across CAD workers and their child processes. The interface stays outside that limit.'
          : 'This budget controls CAD concurrency on this platform. It is not an operating-system CPU cap.'}
          {' '}Actual usage depends on the work available; one dependent operation may use fewer cores.</p>
      </Card>
      <Card title="Workers" description={`Up to ${data.capacity} simultaneous jobs within the CPU and memory scheduling budget.`}>
        <div className={styles.metrics}>
          {[[data.active, 'Active'], [data.ready, 'Ready'], [data.warming, 'Starting'], [data.queued, 'Queued']].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
        </div>
        <Row label="Clean process for each job" hint="Preloaded workers accept one job, then exit with their child processes. Replacement workers start automatically."><span className={styles.badge}>Enabled</span></Row>
        <Row label="CAD CPU usage" hint="Measured across worker processes; unused capacity stays available to other applications."><strong>{data.cpu_usage_percent === null ? 'Measuring…' : `${data.cpu_usage_percent}%`}</strong></Row>
        <p className={styles.note}>Independent jobs run together. Dependencies within an assembly still determine which operations can run in parallel. Lowering the budget preserves running jobs and applies the new concurrency limit as they finish.</p>
      </Card>
    </>}
  </SettingsPage>;
}
