/**
 * Which of a ribbon's commands can be listed: a feature command (`model.<kind>`) only once its engine exists, which the
 * app knows by its feature spec (modeling/specs.ts). Other commands (analysis, inspect) are always the app's own.
 * Pure, for tests/surface_ribbon_test.mjs.
 */
export function readyCommands(ids: string[], hasSpec: (kind: string) => boolean): string[] {
  return ids.filter((id) => !id.startsWith('model.') || hasSpec(id.slice('model.'.length)));
}
