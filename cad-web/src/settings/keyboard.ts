/** Preset equivalents from Autodesk Fusion's shortcut reference and SOLIDWORKS Design Help.
 * Unsupported source-app actions are deliberately not assigned to unrelated Steve commands. */
export type KeyboardPreset = 'steve' | 'fusion' | 'solidworks';
export type Bindings = Record<string, string[]>;
export const PRESETS: Record<KeyboardPreset, Bindings> = {
  steve: {},
  fusion: {
    'app.palette': ['s', 'mod+k'], 'doc.new.part': ['mod+n'],
    'create.update': ['mod+b'], 'app.browser': ['mod+alt+b'],
    'model.extrude': ['e'], 'model.hole': ['h'], 'model.fillet': ['f'],
    'model.move': ['m'], 'model.appearance': ['a'], 'inspect.measure': ['i'], 'visibility.toggle': ['v'],
    'design.joint': ['j'], 'sketch.line': ['l'], 'sketch.rect': ['r'],
    'sketch.circle': ['c'], 'sketch.trim': ['t'], 'sketch.project': ['p'],
    'sketch.construction': ['x'], 'sketch.dimension': ['d'],
    'tab.next': ['mod+tab'], 'tab.previous': ['mod+shift+tab'],
  },
  solidworks: {
    'app.palette': ['s', 'mod+k'], 'create.update': ['mod+b'],
    'view.fit': ['f'], 'view.front': ['mod+1'], 'view.back': ['mod+2'],
    'view.left': ['mod+3'], 'view.right': ['mod+4'], 'view.top': ['mod+5'],
    'view.bottom': ['mod+6'], 'view.iso': ['mod+7'], 'doc.new.part': ['mod+n'],
    'tab.next': ['mod+tab'], 'tab.previous': ['mod+shift+tab'],
    'app.fullscreen': ['f11'],
  },
};
export const bindingLabel = (keys: string[]) => keys[0]?.split('+').map(k => k === 'mod' ? 'Mod' : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+');

/** Explicit preset/custom bindings displace inherited defaults, including sketch conflicts. */
export function resolveBindings(defaults: Bindings, preset: KeyboardPreset, overrides: Bindings): Bindings {
  const explicit = { ...(PRESETS[preset] ?? {}), ...overrides };
  const claimed = new Set(Object.values(explicit).flat());
  return Object.fromEntries(Object.entries(defaults).map(([id, keys]) => [id,
    explicit[id] ?? keys.filter(key => !claimed.has(key)),
  ]));
}
