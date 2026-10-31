/**
 * Settings → Account: download all your data, or delete the account (app/account_data.py; the parts are in
 * AccountData.tsx, shared with the "Before you start" page).
 */
import { useState } from 'react';
import { settingsSections } from '../registry';
import { Card, SettingsPage } from '../ui';
import { DeleteAccount, ExportData } from './AccountData';

export default function AccountSection() {
  const section = settingsSections().find((item) => item.id === 'account')!;
  const [days, setDays] = useState(7);
  const [deleting, setDeleting] = useState(false);
  return (
    <SettingsPage section={section}>
      <Card title="Download my data" id="account-export" description={`One zip with everything STEVE keeps for your account: your designs and their history, your uploads, conversations and settings. It's ready in a few minutes and can be downloaded for ${days} days.`}>
        <ExportData disabled={deleting} onDays={setDays} />
      </Card>

      <Card title="Delete my account" id="account-delete" description="Deletes your account and everything in it, for good: your designs and their history, uploads, simulations, CAM programs, conversations, keys, connected apps and connectors, and your bug reports. It can't be undone. Download your data first if you want a copy.">
        <DeleteAccount onDeleting={setDeleting} />
      </Card>
    </SettingsPage>
  );
}
