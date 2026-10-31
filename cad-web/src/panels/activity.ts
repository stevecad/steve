/**
 * What STEVE is doing, in words: each tool it calls gets a present-tense label for the status line while
 * it runs and a past-tense one for the step list once it finishes. Labels name the action, never its
 * arguments.
 */
const TOOLS: Record<string, [running: string, done: string]> = {
  list_designs: ['Looking through your designs', 'Looked through your designs'],
  read_design: ['Reading the design', 'Read the design'],
  write_design: ['Writing the design', 'Wrote the design'],
  edit_design: ['Editing the code', 'Edited the code'],
  create_component: ['Adding a component', 'Added a component'],
  create_shop_item: ['Adding a shop item', 'Added a shop item'],
  link_design: ['Linking a design', 'Linked a design'],
  generate_model: ['Building the geometry', 'Built the geometry'],
  inspect_model: ['Inspecting the model', 'Inspected the model'],
  run_study: ['Running the simulation', 'Ran the simulation'],
  list_actions: ['Looking at your connectors', 'Looked at your connectors'],
  run_action: ['Asking your connector', 'Asked your connector'],
  manage_connectors: ['Setting up your connector', 'Set up your connector'],
  connectors: ['Working with your connectors', 'Worked with your connectors'],
  integrations: ['Working with your connected services', 'Worked with your connected services'],
  write_plan: ['Updating the plan', 'Updated the plan'],
  delegate_task: ['The reviewer is checking the design', 'The reviewer checked the design'],
};

/** `steve-sheet-metal` → `sheet metal`. */
export const skillTitle = (skill: string) => skill.replace(/^steve-/, '').replaceAll('-', ' ');

export interface Step { name: string; status: string; agent: string; skill?: string }

export function stepLabel(step: Step, tense: 'running' | 'done' = step.status === 'started' ? 'running' : 'done'): string {
  if (step.skill) return tense === 'running' ? `Loading the ${skillTitle(step.skill)} skill` : `Loaded the ${skillTitle(step.skill)} skill`;
  const known = TOOLS[step.name];
  const label = known ? known[tense === 'running' ? 0 : 1] : (tense === 'running' ? 'Working' : 'Used') + ` ${step.name.replaceAll('_', ' ')}`;
  return step.agent.endsWith('_reviewer') && step.name !== 'delegate_task' ? `Reviewer: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

/** The status line: the step in progress, else where STEVE is between steps. */
export function statusOf(steps: Step[], writing: boolean): string {
  const running = [...steps].reverse().find((step) => step.status === 'started');
  if (running) return stepLabel(running, 'running');
  if (writing) return 'Writing';
  return steps.length ? 'Reviewing the results' : 'Reading your request';
}
