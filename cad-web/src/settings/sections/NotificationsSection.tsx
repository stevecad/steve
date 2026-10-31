/**
 * Settings → Notifications: what STEVE tells you about while you work.
 */
import { Switch } from '@/ui';
import { settingsSections } from '../registry';
import { updateSetting, useSetting } from '../store';
import { Card, Row, SettingsPage } from '../ui';

export default function NotificationsSection() {
  const section = settingsSections().find((item) => item.id === 'notifications')!;
  const reports = useSetting('notifications.reports');
  return (
    <SettingsPage section={section}>
      <Card title="Your reports" id="notify-reports">
        <Row label="Report updates" hint="A note when a bug you reported is fixed, or a feature you asked for is added or answered. Off: check My reports (account menu) yourself." setting="notifications.reports">
          <Switch checked={reports} onCheckedChange={(on) => void updateSetting('notifications.reports', on)} label="Report updates" />
        </Row>
      </Card>
    </SettingsPage>
  );
}
