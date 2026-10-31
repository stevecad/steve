/**
 * The one time STEVE asks about automatic mode: an AI agent tried to set a connector up while it was off
 * (app/connector_panels.py ask_for_automatic). Turn on, or don't ask again; the setting stays in Settings → Connectors.
 */
import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import { updateSettings } from '@/settings/store';
import { acknowledge } from '@/terms/terms';
import { refreshPanels, usePanels } from './panels';

const WHO: Record<string, string> = { agent: 'An AI agent', assistant: 'STEVE' };

export default function AutomaticPrompt() {
  const request = usePanels((state) => state.request);
  const [busy, setBusy] = useState(false);
  const decide = async (on: boolean | null) => {   // null: not now (the next agent asks again)
    setBusy(true);
    usePanels.setState({ request: null });
    try {
      if (on && !await acknowledge('automatic_mode')) return;   // asked once (app/terms.py)
      await updateSettings(on ? { 'connectors.automatic': true, 'connectors.automaticRequest': {} }
                              : on === false ? { 'connectors.automaticDeclined': true, 'connectors.automaticRequest': {} }
                              : { 'connectors.automaticRequest': {} });
    } finally { setBusy(false); refreshPanels(); }
  };
  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) void decide(null); }} icon={<Bot size={16} />} width={480}
      title="Let AI set up your connectors?"
      description={`${WHO[request?.by ?? 'agent'] ?? 'An AI agent'} wanted to set up a connector for you. With automatic mode on, the STEVE assistant and your AI agents pair connectors, allow their actions and publish their panels without asking you each time.`}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>Don’t ask again</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide(null)}>Not now</Button>
        <Button variant="primary" id="automatic-on" autoFocus disabled={busy} onClick={() => void decide(true)}>Turn on</Button>
      </>}>
      <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)', lineHeight: 1.5 }}>
        Actions a connector says need a person still wait for you on every run, and API keys and other apps still need your OK.
        Every change is listed in Settings → Connectors, where you can undo it or turn this off.
      </p>
    </Dialog>
  );
}
