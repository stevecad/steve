/**
 * Reasoning effort (app/assistant_effort.py): how hard STEVE thinks. "auto" leaves it to the model; the levels a model
 * offers come from the server (each model's `efforts`, from its Pydantic AI profile). Settings → STEVE holds the
 * account's choice; the chat can choose for its next messages, as it does the model.
 */
import type { AssistantConfig } from '@/lib/api';
import { modelInfo, type Choice } from './steve';

export type Effort = 'auto' | 'none' | 'max' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORT_KEY = 'steve-ai-effort';  // The chat's choice in this browser (per account, panels/steve.ts).

export const EFFORTS: Record<Effort, { label: string; hint: string }> = {
  auto: { label: 'Automatic', hint: 'The model’s own default.' },
  none: { label: 'None', hint: 'No additional reasoning.' },
  max: { label: 'Maximum', hint: 'The highest reasoning effort offered by this model.' },
  minimal: { label: 'Minimal', hint: 'Barely thinks: the fastest and cheapest, for quick, simple changes.' },
  low: { label: 'Low', hint: 'Thinks briefly: quick and inexpensive.' },
  medium: { label: 'Medium', hint: 'A balance of speed, cost and care.' },
  high: { label: 'High', hint: 'Thinks longer: slower and costs more, for tricky geometry.' },
  xhigh: { label: 'Extra high', hint: 'Thinks longest: the slowest and most expensive.' },
};

export const effortLabel = (effort: string | null | undefined) => EFFORTS[(effort as Effort) ?? 'auto']?.label ?? effort ?? 'Automatic';

/** The levels a model offers, lowest first (none: only Automatic). */
export function effortsOf(config: AssistantConfig | null, choice: Choice | null): Effort[] {
  return (modelInfo(config, choice)?.model.efforts ?? []) as Effort[];
}

/** What a run would use: the wanted level if the model offers it, else Automatic (`fallback` says it was dropped). */
export function effectiveEffort(wanted: string | null | undefined, offered: Effort[]): { effort: Effort; fallback: boolean } {
  if (!wanted || wanted === 'auto') return { effort: 'auto', fallback: false };
  return offered.includes(wanted as Effort) ? { effort: wanted as Effort, fallback: false } : { effort: 'auto', fallback: true };
}
