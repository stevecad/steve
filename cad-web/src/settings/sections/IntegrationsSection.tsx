/**
 * Settings → All integrations: every integration STEVE has (settings/registry.ts sections with `integration`), each a
 * card with what it does and where it stands, opening its own page. The nav lists only the ones in use, so Settings
 * stays short however many integrations there are.
 */
import { useEffect } from 'react';
import { ArrowRight, CircleAlert, CircleCheck } from 'lucide-react';
import { Button } from '@/ui';
import { INTEGRATIONS, loadIntegrationStatus, settingsSections, useIntegrationStatus, useSettingsDialog } from '../registry';
import { SettingsPage } from '../ui';
import styles from '../Settings.module.css';

export default function IntegrationsSection() {
  const section = settingsSections().find((item) => item.id === INTEGRATIONS)!;
  const status = useIntegrationStatus();
  useEffect(() => { void loadIntegrationStatus(); }, []);
  const integrations = settingsSections().filter((item) => item.integration);
  return (
    <SettingsPage section={section} id="settings-integrations">
      <div className={styles.integrations}>
        {integrations.map((item) => {
          const Icon = item.icon;
          const now = status[item.id];
          return (
            <article key={item.id} className={styles.integration} data-integration={item.id} data-connected={now?.connected ? '' : undefined}
                     data-attention={now?.attention ? '' : undefined}>
              <div className={styles.integrationHead}>
                <span className={styles.groupIcon}><Icon size={16} /></span>
                <b>{item.integration!.title ?? item.label}</b>
              </div>
              <p>{item.integration!.summary}</p>
              <div className={styles.integrationFoot}>
                <span className={styles.integrationStatus}>
                  {now?.attention ? <CircleAlert size={13} /> : now?.connected ? <CircleCheck size={13} /> : null}
                  {now?.label ?? ' '}
                </span>
                <Button size="sm" variant={now?.connected ? 'ghost' : 'primary'} icon={<ArrowRight size={13} />}
                        onClick={() => useSettingsDialog.setState({ section: item.id })} id={`integration-open-${item.id}`}>
                  {now?.connected ? 'Open' : 'Connect'}</Button>
              </div>
            </article>
          );
        })}
      </div>
    </SettingsPage>
  );
}
