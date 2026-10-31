/**
 * The chat header's settings, next to the model: the reasoning effort of the next messages (chosen like the model, see
 * panels/effort.ts), how STEVE works in the open conversation (context, planning, the reviewer subagent) and what it
 * has cost, next to what STEVE has spent on the open design. Defaults live in Settings → STEVE.
 */
import { useEffect, useMemo, useState } from 'react';
import { Popover } from 'radix-ui';
import { ArrowUpRight, SlidersHorizontal } from 'lucide-react';
import { IconButton, Switch, ui } from '@/ui';
import { Api, type AssistantConfig, type AssistantSettings, type Conversation, type DesignUsage } from '@/lib/api';
import { tokens, usd } from '@/lib/format';
import { useApp } from '@/state/store';
import { openSettings } from '@/settings/registry';
import EffortChoices from './EffortChoices';
import { effortLabel, type Effort } from './effort';
import styles from './Assistant.module.css';
import own from './Steve.module.css';

const BEHAVIOUR = [
  ['auto_compact', 'Manage context automatically', 'Summarize older working context; keep your chat history.'],
  ['planning', 'Planning', 'A short task list for work with multiple steps.'],
  ['subagents', 'CAD reviewer subagent', 'Read-only review, up to two delegations per message. Uses additional model tokens.'],
] as const;

function Usage({ chat }: { chat: Conversation | null }) {
  const saved = useApp((state) => state.doc.saved);
  const [design, setDesign] = useState<DesignUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDesign(null);
    if (saved) Api.assistantUsage(saved.id).then((value) => { if (!cancelled) setDesign(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [saved?.id, saved?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const conversation = useMemo(() => (chat?.turns ?? []).reduce((sum, turn) => {
    const usage = turn.usage;
    if (!usage) return sum;
    return { runs: sum.runs + 1, input: sum.input + usage.input_tokens, output: sum.output + usage.output_tokens,
      cost: sum.cost + (usage.cost_usd ? Number(usage.cost_usd) : 0), unpriced: sum.unpriced + (usage.cost_usd === null ? 1 : 0) };
  }, { runs: 0, input: 0, output: 0, cost: 0, unpriced: 0 }), [chat]);
  const rows = (label: string, runs: number, input: number, output: number, cost: string | null, unpriced: number) => (
    <dl className={own.rows} data-usage={label}>
      <div><dt>Messages</dt><dd>{runs}</dd></div>
      <div><dt>Tokens</dt><dd>{tokens(input + output)} <small>({tokens(input)} in · {tokens(output)} out)</small></dd></div>
      <div><dt>Estimated cost</dt><dd>{cost ? `${cost}${unpriced ? ` + ${unpriced} unpriced` : ''}` : 'Unknown for this model'}</dd></div>
    </dl>
  );
  return (
    <div id="steve-usage">
      <h4 className={own.subhead}>Cost of this conversation</h4>
      {conversation.runs ? rows('conversation', conversation.runs, conversation.input, conversation.output, usd(String(conversation.cost)), conversation.unpriced)
        : <p className={own.hint}>Nothing yet.</p>}
      <h4 className={own.subhead}>Cost of this design</h4>
      {!saved ? <p className={own.hint}>Save the design to track what STEVE spends on it.</p>
        : design?.runs ? rows('design', design.runs, design.input_tokens, design.output_tokens, usd(design.cost_usd), design.unpriced_runs)
          : <p className={own.hint}>STEVE hasn’t worked on this design yet.</p>}
    </div>
  );
}

export interface EffortControl {
  /** What the next message uses. */
  value: Effort;
  offered: Effort[];
  /** The chosen level isn't offered by this model: it runs at Automatic. */
  fallback: boolean;
  wanted: string;
  account: string;
  /** The chat chose (else it follows the account's default). */
  chosen: boolean;
  model: string;
  onChoose: (effort: Effort) => void;
  onMakeDefault: (effort: Effort) => void;
}

function ReasoningEffort({ effort }: { effort: EffortControl }) {
  return (
    <div className={styles.chatEffort} id="chat-effort">
      <div className={styles.effortHead}><b>Reasoning effort</b><span title={effort.model}>{effort.model}</span></div>
      {effort.fallback && <p className={styles.effortNote} role="status">{effort.model} doesn’t offer {effortLabel(effort.wanted)}, so STEVE uses Automatic.</p>}
      <EffortChoices value={effort.value} offered={effort.offered} onChoose={effort.onChoose} />
      {effort.chosen && effort.value !== effort.account && (
        <button type="button" className={styles.effortDefault} id="chat-effort-default" onClick={() => effort.onMakeDefault(effort.value)}>
          Make {effortLabel(effort.value)} the default
        </button>
      )}
    </div>
  );
}

export default function ConversationSettings({ config, chat, locked, onSettings, effort }: {
  config: AssistantConfig | null;
  chat: Conversation | null;
  /** STEVE is answering, or the conversation is changing: settings wait. */
  locked: boolean;
  onSettings: (next: AssistantSettings) => Promise<void>;
  effort: EffortControl;
}) {
  const [open, setOpen] = useState(false);
  const current = chat?.settings ?? config?.defaults;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label="Effort and this conversation" description="How hard STEVE thinks, how it works in this chat, and what it has cost." id="chat-settings" active={open}>
          <SlidersHorizontal size={15} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`${ui.menu} ${styles.chatSettings}`} side="bottom" align="end" sideOffset={6} collisionPadding={12} id="steve-behaviour">
          <ReasoningEffort effort={effort} />
          <div className={styles.chatSettingsHead}>
            <b>This conversation</b>
            <span title={chat?.title}>{chat ? chat.title || 'New conversation' : 'Applies to your next conversation'}</span>
          </div>
          {!config?.local && current && BEHAVIOUR.map(([key, title, hint]) => (
            <div key={key} className={styles.chatSetting} data-setting={key}>
              <span>{title}<small>{hint}</small></span>
              <Switch checked={current[key]} disabled={locked} label={title} onCheckedChange={(on) => void onSettings({ ...current, [key]: on })} />
            </div>
          ))}
          {locked && chat?.busy && <p className={own.hint}>Changes wait until STEVE finishes its answer.</p>}
          {!config?.local && <Usage chat={chat} />}
          <button type="button" className={styles.chatSettingsLink} onClick={() => { setOpen(false); openSettings('steve'); }} id="chat-settings-defaults">
            Agent settings, skills and approvals<ArrowUpRight size={12} />
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
