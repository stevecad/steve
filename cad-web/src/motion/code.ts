/**
 * Joints are code in main.py (`design.revolute("hinge", "frame", "arm", axis=…)`). These helpers
 * find, write and remove those calls; the Joint tool and the tree's menus use them.
 */
import { get, set } from '@/state/store';
import { openFile, setCode } from '@/state/actions';
import { MAIN, filesOf } from '@/state/design';
import { withImport } from '@/state/designRefs';
import type { JointType } from './kinematics';
import { explodeSource, type ExplodeSpec } from './explodeCode';
import { removeMotionTarget, animationsUsingPose, renameAnimationPoseReferences } from './removeTargets';

const lineOffset = (code: string, line: number) => code.split('\n').slice(0, Math.max(0, line - 1)).reduce((sum, text) => sum + text.length + 1, 0);

function reveal(from: number, to: number) {
  const length = get().doc.code.length;
  set({ sourceReveal: { from: Math.min(from, length), to: Math.min(to, length), nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a call that starts at `start` ends (its closing parenthesis), skipping strings. */
function callEnd(code: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = code.indexOf('(', start); i < code.length; i++) {
    const c = code[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return code.length;
}

/** Statements in main.py about a joint or coupling: its definition, its drives, and pose lines naming it. */
function statements(code: string, name: string): { from: number; to: number; kind: 'joint' | 'drive' }[] {
  const out: { from: number; to: number; kind: 'joint' | 'drive' }[] = [];
  const patterns: [RegExp, 'joint' | 'drive'][] = [
    [new RegExp(`^[ \\t]*\\w+\\.(?:rigid|revolute|slider|cylindrical|couple)\\(\\s*["']${escape(name)}["']`, 'gm'), 'joint'],
    [new RegExp(`^[ \\t]*\\w+\\.drive\\(\\s*["']${escape(name)}["']`, 'gm'), 'drive'],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of code.matchAll(pattern)) {
      const end = callEnd(code, match.index!);
      const lineEnd = code.indexOf('\n', end);
      out.push({ from: match.index!, to: lineEnd < 0 ? code.length : lineEnd + 1, kind });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function mainCode(): string {
  const { doc } = get();
  return doc.activeFile === MAIN ? doc.code : filesOf(doc)[MAIN] ?? '';
}

function writeMain(code: string) {
  openFile(MAIN);
  setCode(code);
}

/** Opens main.py at the joint's definition. */
export function showJointCode(name: string) {
  const code = mainCode();
  const found = statements(code, name).find((item) => item.kind === 'joint');
  openFile(MAIN);
  if (!found) return;
  const line = code.slice(0, found.from).split('\n').length;
  const lastLine = code.slice(0, found.to - 1).split('\n').length;
  reveal(lineOffset(code, line), lineOffset(code, lastLine + 1) - 1);
}

/** Rewrites each `design.couple(...)` call's text with `edit` (last first, so earlier offsets hold). */
function editCouples(code: string, edit: (call: string) => string): string {
  const calls = [...code.matchAll(/\.couple\(/g)].map((match) => [match.index!, callEnd(code, match.index!)] as const);
  for (const [from, to] of calls.reverse()) code = code.slice(0, from) + edit(code.slice(from, to)) + code.slice(to);
  return code;
}

/** A joint's keys in a coupling's gears: `"hinge"`, `"hinge.turn"`, `"hinge.travel"`. */
const gearKey = (name: string) => `(["'])${escape(name)}((?:\\.(?:turn|travel))?)\\1`;

/** Removes the joint, its drives, its values in named poses and its gears in couplings (a coupling left with none goes too). */
export function removeJoint(name: string) {
  writeMain(removeMotionTarget(mainCode(), name));
}

/** Renames a joint everywhere main.py names it (its definition, drives and poses). */
export function renameJoint(from: string, to: string): string | true {
  const problem = jointNameProblem(to, from);
  if (problem) return problem;
  if (from === to) return true;
  const code = mainCode();
  writeMain(renameJointReferences(code, from, to));
  return true;
}

export function jointNameProblem(name: string, replacing?: string | null): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return 'Joint names are lowercase letters, digits and underscores, starting with a letter.';
  if (name !== replacing && statements(mainCode(), name).length) return `There is already a joint or coupling named ${name}.`;
  return null;
}

function renameJointReferences(code: string, from: string, to: string): string {
  let next = code;
  for (const item of statements(code, from).reverse()) {
    const text = next.slice(item.from, item.to).replace(new RegExp(`(["'])${escape(from)}\\1`), `$1${to}$1`);
    next = next.slice(0, item.from) + text + next.slice(item.to);
  }
  next = next.replace(new RegExp(`(\\.pose\\([^)]*?\\b)${escape(from)}(\\s*=)`, 'g'), `$1${to}$2`);
  next = editCouples(next, (call) => call.replace(new RegExp(`${gearKey(from)}(\\s*:)`, 'g'), `$1${to}$2$1$3`));
  for (const method of ['mode', 'animation']) {
    for (const item of calls(next, method).reverse()) {
      const text = item.text.replace(new RegExp(`${gearKey(from)}(\\s*:)`, 'g'), `$1${to}$2$1$3`);
      next = next.slice(0, item.from) + text + next.slice(item.to);
    }
  }
  return next;
}

export interface JointSpec {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** Python for the axis: `frame.face("bore.side(c1)")`, `"Z"`, or `((x, y, z), (dx, dy, dz))`. */
  axis: string | null;
  /** The component the axis names, imported into main.py when needed. */
  axisComponent?: string | null;
  limits: [number, number] | null;
  slideLimits?: [number, number] | null;
  /** Animated by `design.drive(...)`: its speed, or null for the default. */
  drive?: { speed: number | null; check?: boolean } | null;
  /** `follow=True`: it moves only through its couplings. Kept as written when the Joint tool rewrites the joint. */
  follow?: boolean;
}

const number = (value: number) => String(Number(value.toFixed(4)));

export function jointSource(spec: JointSpec): string {
  const args = [JSON.stringify(spec.name), JSON.stringify(spec.parent), JSON.stringify(spec.child)];
  if (spec.type !== 'rigid' && spec.axis) args.push(`axis=${spec.axis}`);
  if (spec.type !== 'rigid' && spec.limits) args.push(`limits=(${number(spec.limits[0])}, ${number(spec.limits[1])})`);
  if (spec.type === 'cylindrical' && spec.slideLimits) args.push(`slide_limits=(${number(spec.slideLimits[0])}, ${number(spec.slideLimits[1])})`);
  if (spec.type !== 'rigid' && spec.follow) args.push('follow=True');
  const lines = [`design.${spec.type}(${args.join(', ')})`];
  if (spec.drive && spec.type !== 'rigid') lines.push(`design.drive(${JSON.stringify(spec.name)}${spec.drive.speed ? `, speed=${number(spec.drive.speed)}` : ''}${spec.drive.check ? ', check=True' : ''})`);
  return lines.join('\n');
}

/** Adds (or replaces) a joint in main.py, before `result = design.result()`. */
export function writeJoint(spec: JointSpec, replacing?: string) {
  let code = mainCode();
  if (replacing) {
    const old = statements(code, replacing);
    const definition = old.find(item => item.kind === 'joint');
    if (definition) {
      const original = code.slice(definition.from, definition.to);
      const oldType = /\.(rigid|revolute|slider|cylindrical)\(/.exec(original)?.[1];
      const parameters = oldType === 'cylindrical'
        ? ['name', 'parent', 'child', 'axis', 'limits', 'slide_limits', 'value', 'slide', 'follow']
        : ['name', 'parent', 'child', 'axis', 'limits', 'value', 'follow'];
      const retained = callArguments(original, parameters);
      const extras: string[] = [];
      if (spec.type !== 'rigid') {
        // Initial values and following behavior are not editable in this panel.
        // Keep their Python expressions, including precision, without evaluating them.
        if (retained.value && (oldType === spec.type || (oldType !== 'slider' && spec.type !== 'slider'))) extras.push(`value=${retained.value}`);
        if (spec.type === 'cylindrical' && retained.slide) extras.push(`slide=${retained.slide}`);
        if (spec.follow === undefined && retained.follow) extras.push(`follow=${retained.follow}`);
      }
      const receiver = /^[ \t]*(\w+)\./.exec(original)?.[1] ?? 'design';
      let source = jointSource({ ...spec, drive: null }).replace(/^design\./, `${receiver}.`);
      if (extras.length) source = source.slice(0, -1) + `, ${extras.join(', ')})`;
      const drives = old.filter(item => item.kind === 'drive');
      // Keep existing drives in place: a drive may refer to a mode declared
      // after the joint. Preserve range, samples and mode outside this panel.
      for (const item of [...old].reverse()) {
        let replacement = source;
        if (item.kind === 'drive') {
          if (!spec.drive || spec.type === 'rigid') replacement = '';
          else {
            const text = code.slice(item.from, item.to);
            const args = callArguments(text, ['joint', 'speed', 'range', 'check', 'samples', 'mode']);
            const extra = ['range', 'samples', 'mode'].filter(key => args[key]).map(key => `${key}=${args[key]}`);
            const previousSpeed = args.speed !== undefined && Number.isFinite(Number(args.speed)) ? Number(args.speed) : null;
            const speed = spec.drive.speed === previousSpeed ? args.speed : spec.drive.speed == null ? null : String(spec.drive.speed);
            const check = !!spec.drive.check === (args.check === 'True') ? args.check : spec.drive.check ? 'True' : 'False';
            const changed = [JSON.stringify(spec.name), ...(speed ? [`speed=${speed}`] : []), ...(check ? [`check=${check}`] : []), ...extra];
            replacement = `${receiver}.drive(${changed.join(', ')})`;
          }
        } else if (!drives.length && spec.drive && spec.type !== 'rigid') {
          replacement += '\n' + jointSource(spec).split('\n')[1].replace(/^design\./, `${receiver}.`);
        }
        code = code.slice(0, item.from) + (replacement ? `${replacement}\n` : '') + code.slice(item.to);
      }
      if (spec.name !== replacing) code = renameJointReferences(code, replacing, spec.name);
      writeMain(spec.axisComponent ? withImport(code, spec.axisComponent) : code);
      return;
    }
  }
  const lines = code.replace(/\n$/, '').split('\n');
  const result = lines.findIndex((line) => /^\s*result\s*=/.test(line));
  lines.splice(result >= 0 ? result : lines.length, 0, ...jointSource(spec).split('\n'));
  code = `${lines.join('\n')}\n`;
  writeMain(spec.axisComponent ? withImport(code, spec.axisComponent) : code);
}

/** Writes `follow=True` into each joint's call (or takes it out), leaving the rest of the call as written. */
export function setJointsFollow(names: string[], follow: boolean) {
  let code = mainCode();
  for (const name of names) {
    const found = statements(code, name).find((item) => item.kind === 'joint');
    if (!found || !/^[ \t]*\w+\.(?:revolute|slider|cylindrical)\(/.test(code.slice(found.from, found.to))) continue;
    const close = callEnd(code, found.from) - 1;
    let head = code.slice(found.from, close).replace(/,\s*follow\s*=\s*(?:True|False)\b/, '');
    if (follow) head = `${head.replace(/[\s,]*$/, '')}, follow=True`;
    code = code.slice(0, found.from) + head + code.slice(close);
  }
  writeMain(code);
}

/** Names not used by any joint yet: hinge, hinge_2, … */
export function freeJointName(base: string): string {
  const code = mainCode();
  if (!statements(code, base).length) return base;
  for (let n = 2; ; n++) if (!statements(code, `${base}_${n}`).length) return `${base}_${n}`;
}

/* ───────── Couplings, drives, poses and animations ───────── */

/** `design.<method>("name", …)` statements in main.py (whole lines), in source order. */
function calls(code: string, method: string, name?: string): { from: number; to: number; name: string; text: string }[] {
  const pattern = new RegExp(`^[ \\t]*\\w+\\.${method}\\(\\s*(["'])(${name ? escape(name) : '[^"\']+'})\\1`, 'gm');
  return [...code.matchAll(pattern)].map((match) => {
    const end = callEnd(code, match.index!);
    const lineEnd = code.indexOf('\n', end);
    const to = lineEnd < 0 ? code.length : lineEnd + 1;
    return { from: match.index!, to, name: match[2], text: code.slice(match.index!, to) };
  });
}

/** Inserts statements before `result = design.result()`, or replaces `[from, to)` with them. */
function place(code: string, source: string, at?: { from: number; to: number }): string {
  if (at) return code.slice(0, at.from) + `${source}\n` + code.slice(at.to);
  const lines = code.replace(/\n$/, '').split('\n');
  const result = lines.findIndex((line) => /^\s*result\s*=/.test(line));
  lines.splice(result >= 0 ? result : lines.length, 0, ...source.split('\n'));
  return `${lines.join('\n')}\n`;
}

/** Numbers as people write them: 0.5, 120, -0.333333 (six significant digits at most). */
export const pyNumber = (value: number) => String(Number(Number(value).toPrecision(6)));

export function couplingSource(name: string, gears: Record<string, number>, comment?: string, limits?: [number, number] | null): string {
  const entries = Object.entries(gears).map(([key, ratio]) => `${JSON.stringify(key)}: ${ratio}`).join(', ');
  return `design.couple(${JSON.stringify(name)}, {${entries}}${limits ? `, limits=(${pyNumber(limits[0])}, ${pyNumber(limits[1])})` : ''})${comment ? `  # ${comment}` : ''}`;
}

/** Adds a coupling, or rewrites one (`replacing`); a renamed coupling's drives and poses follow. */
export function writeCoupling(name: string, gears: Record<string, number>, options: { comment?: string; limits?: [number, number] | null; replacing?: string } = {}) {
  let code = mainCode();
  const old = options.replacing ? calls(code, 'couple', options.replacing)[0] : undefined;
  let source = couplingSource(name, gears, options.comment, options.limits);
  if (old) {
    const args = callArguments(old.text, ['name', 'gears', 'limits', 'value']);
    const retained = [options.limits === undefined && args.limits ? `limits=${args.limits}` : '', args.value ? `value=${args.value}` : ''].filter(Boolean);
    const close = callEnd(source, 0) - 1;
    if (retained.length) source = source.slice(0, close) + `, ${retained.join(', ')}` + source.slice(close);
    const receiver = /^[ \t]*(\w+)\./.exec(old.text)?.[1] ?? 'design';
    source = source.replace(/^design\./, `${receiver}.`);
  }
  code = place(code, source, old);
  // Rename references before publishing the complete edit. Calling renameJoint
  // after inserting the new name rejects that very definition as a duplicate.
  if (old && options.replacing && options.replacing !== name) code = renameJointReferences(code, options.replacing, name);
  writeMain(code);
}

export interface DriveSpec { target: string; speed: number | null; range?: [number, number] | null; check?: boolean; samples?: number | null }

export function driveSource(spec: DriveSpec): string {
  const args = [JSON.stringify(spec.target)];
  if (spec.speed) args.push(`speed=${spec.speed}`);
  if (spec.range) args.push(`range=(${spec.range[0]}, ${spec.range[1]})`);
  if (spec.check) args.push('check=True');
  if (spec.check && spec.samples && spec.samples !== 24) args.push(`samples=${Math.round(spec.samples)}`);
  return `design.drive(${args.join(', ')})`;
}

/** A joint or coupling's drive as written (speed, range, check), or null. */
export function driveCall(target: string): DriveSpec | null {
  const found = calls(mainCode(), 'drive', target)[0];
  if (!found) return null;
  const args = callArguments(found.text, ['joint', 'speed', 'range', 'check', 'samples', 'mode']);
  const speed = args.speed !== undefined && Number.isFinite(Number(args.speed)) ? Number(args.speed) : null;
  return { target, speed, range: pair(args.range), check: args.check === 'True', samples: args.samples && Number.isFinite(Number(args.samples)) ? Number(args.samples) : null };
}

/** Adds or replaces the drive of `spec.target` (a joint or coupling has one drive). */
export function writeDrive(spec: DriveSpec) {
  const code = mainCode();
  const old = calls(code, 'drive', spec.target)[0];
  let source = driveSource(spec);
  if (old) {
    const args = callArguments(old.text, ['joint', 'speed', 'range', 'check', 'samples', 'mode']);
    const retained = [spec.samples === undefined && args.samples ? `samples=${args.samples}` : '', args.mode ? `mode=${args.mode}` : ''].filter(Boolean);
    if (retained.length) source = source.slice(0, -1) + `, ${retained.join(', ')})`;
    const receiver = /^[ \t]*(\w+)\./.exec(old.text)?.[1] ?? 'design';
    source = source.replace(/^design\./, `${receiver}.`);
  }
  writeMain(place(code, source, old));
}

export function removeDrive(target: string) {
  let code = mainCode();
  for (const item of calls(code, 'drive', target).reverse()) code = code.slice(0, item.from) + code.slice(item.to);
  writeMain(code);
}

/** `design.pose("open", hinge=80, input=40)`, with `mode="limited"` when it is saved in a design.mode. */
export function poseSource(name: string, values: Record<string, number>, mode: string | null = null): string {
  return `design.pose(${[JSON.stringify(name), ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    ...(mode ? [`mode=${JSON.stringify(mode)}`] : [])].join(', ')})`;
}

export function writePose(name: string, values: Record<string, number>, replacing?: string, mode?: string | null) {
  const code = mainCode();
  const old = calls(code, 'pose', replacing ?? name)[0];
  let source = poseSource(name, values, mode ?? null);
  if (old) {
    const args = callArguments(old.text, ['name', 'mode']);
    if (mode === undefined && args.mode) source = source.slice(0, -1) + `, mode=${args.mode})`;
    const receiver = /^[ \t]*(\w+)\./.exec(old.text)?.[1] ?? 'design';
    source = source.replace(/^design\./, `${receiver}.`);
  }
  let next = place(code, source, old);
  if (replacing && replacing !== name) next = renamePoseInAnimations(next, replacing, name);
  writeMain(next);
}

export function animationNamesInCode(): string[] {
  return calls(mainCode(), 'animation').map((item) => item.name);
}

export function poseNames(): string[] {
  return calls(mainCode(), 'pose').map((item) => item.name);
}

/** Animation keys name poses as ("open", 2): renames those, inside animation calls only. */
function renamePoseInAnimations(code: string, from: string, to: string): string {
  return renameAnimationPoseReferences(code, from, to);
}

export function renamePose(from: string, to: string): string | true {
  if (!/^[A-Za-z0-9_][\w -]*$/.test(to)) return 'Pose names are letters, digits, spaces, hyphens and underscores.';
  if (from === to) return true;
  const code = mainCode();
  if (calls(code, 'pose', to).length) return `There is already a pose named ${to}.`;
  const old = calls(code, 'pose', from)[0];
  if (!old) return `There is no pose named ${from}.`;
  const next = code.slice(0, old.from) + old.text.replace(new RegExp(`(["'])${escape(from)}\\1`), `$1${to}$1`) + code.slice(old.to);
  writeMain(renamePoseInAnimations(next, from, to));
  return true;
}

/** Refuse to remove a pose still used by animations, regardless of the UI entry point. */
export function removePose(name: string): string | null {
  const users = animationsUsing(name);
  if (users.length) return `Used by ${users.length === 1 ? 'animation' : 'animations'} ${users.join(', ')}. Edit or remove ${users.length === 1 ? 'that animation' : 'those animations'} before deleting this pose.`;
  let code = mainCode();
  for (const item of calls(code, 'pose', name).reverse()) code = code.slice(0, item.from) + code.slice(item.to);
  writeMain(code);
  return null;
}

/** Animations that name a pose in their keys. */
export function animationsUsing(pose: string): string[] {
  return animationsUsingPose(mainCode(), pose);
}

export interface AnimationSpec {
  name: string;
  /** A pose name, or a dict of joint/coupling values, at a time in seconds. */
  keys: { pose: string | Record<string, number>; time: number }[];
  loop: boolean;
  easing: 'linear' | 'ease';
  check: boolean;
  samples?: number | null;
}

export function animationSource(spec: AnimationSpec): string {
  const keys = spec.keys.map((key) => `(${typeof key.pose === 'string' ? JSON.stringify(key.pose)
    : `{${Object.entries(key.pose).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')}}`}, ${key.time})`);
  const options = [spec.loop ? 'loop=True' : '', spec.easing !== 'ease' ? `easing=${JSON.stringify(spec.easing)}` : '', spec.check ? 'check=True' : '',
    spec.check && spec.samples && spec.samples !== 48 ? `samples=${Math.round(spec.samples)}` : ''].filter(Boolean);
  const head = `design.animation(${JSON.stringify(spec.name)}, `;
  const tail = `${options.length ? `, ${options.join(', ')}` : ''})`;
  const flat = `${head}[${keys.join(', ')}]${tail}`;
  if (flat.length <= 110) return flat;
  // Long animations: four keys a line.
  const rows: string[] = [];
  for (let i = 0; i < keys.length; i += 4) rows.push(`    ${keys.slice(i, i + 4).join(', ')},`);
  return `${head}[\n${rows.join('\n')}\n]${tail}`;
}

export function writeAnimation(spec: AnimationSpec, replacing?: string) {
  const code = mainCode();
  const old = calls(code, 'animation', replacing ?? spec.name)[0];
  let source = animationSource(spec);
  if (old) {
    const args = callArguments(old.text, ['name', 'keys', 'loop', 'easing', 'check', 'samples', 'mode']);
    const retained = [spec.samples === undefined && args.samples ? `samples=${args.samples}` : '', args.mode ? `mode=${args.mode}` : ''].filter(Boolean);
    const close = callEnd(source, 0) - 1;
    if (retained.length) source = source.slice(0, close) + `, ${retained.join(', ')}` + source.slice(close);
    const receiver = /^[ \t]*(\w+)\./.exec(old.text)?.[1] ?? 'design';
    source = source.replace(/^design\./, `${receiver}.`);
  }
  writeMain(place(code, source, old));
}

export function removeAnimation(name: string) {
  let code = mainCode();
  for (const item of calls(code, 'animation', name).reverse()) code = code.slice(0, item.from) + code.slice(item.to);
  writeMain(code);
}

/* ───────── Explodes (design.explode) ───────── */

export { EXPLODE_DURATION, EXPLODE_HOLD, explodeSource, type ExplodeSpec, type ExplodeStepSpec } from './explodeCode';

export function explodeNamesInCode(): string[] {
  return calls(mainCode(), 'explode').map((item) => item.name);
}

/** Adds an explode, or rewrites one (`replacing`, by its old name when renamed). */
export function writeExplode(spec: ExplodeSpec, replacing?: string) {
  writeMain(codeWithExplode(mainCode(), spec, replacing));
}

/** Source for a saved explode or an isolated automatic preview build. */
export function codeWithExplode(code: string, spec: ExplodeSpec, replacing?: string): string {
  const old = calls(code, 'explode', replacing ?? spec.name)[0];
  let source = explodeSource(spec);
  if (old) {
    const args = callArguments(old.text, ['name', 'steps', 'auto', 'duration', 'hold', 'easing', 'loop', 'gap']);
    if (spec.preserveSteps && args.steps) source = explodeSource(spec, args.steps);
    const retained = ['duration', 'hold', 'easing', ...(spec.auto ? ['gap'] : [])]
      .filter((key) => spec[key as keyof ExplodeSpec] == null && args[key])
      .map((key) => `${key}=${args[key]}`);
    const close = callEnd(source, 0) - 1;
    if (retained.length) source = source.slice(0, close) + `, ${retained.join(', ')}` + source.slice(close);
    source = source.replace(/^design\./, `${/^[ \t]*(\w+)\./.exec(old.text)?.[1] ?? 'design'}.`);
  }
  return place(code, source, old);
}

export function removeExplode(name: string) {
  let code = mainCode();
  for (const item of calls(code, 'explode', name).reverse()) code = code.slice(0, item.from) + code.slice(item.to);
  writeMain(code);
}

/** Turns an explode's `loop=True` on or off where it's written, leaving the rest of the call as it is. */
export function setExplodeLoop(name: string, loop: boolean) {
  const code = mainCode();
  const found = calls(code, 'explode', name)[0];
  if (!found) return;
  const close = found.text.lastIndexOf(')');
  let text = found.text.slice(0, close).replace(/,\s*loop\s*=\s*(True|False)/, '');
  if (loop) text += ', loop=True';
  writeMain(code.slice(0, found.from) + text + found.text.slice(close) + code.slice(found.to));
}

/** Names free for a new explode: explode_1, explode_2, … (animations and explodes share the timeline's names). */
export function freeExplodeName(): string {
  const code = mainCode();
  const taken = (name: string) => calls(code, 'explode', name).length > 0 || calls(code, 'animation', name).length > 0;
  for (let n = 1; ; n++) if (!taken(`explode_${n}`)) return `explode_${n}`;
}

/** Opens main.py at an animation, pose or drive. */
export function showCall(method: 'animation' | 'pose' | 'drive' | 'couple' | 'explode', name: string) {
  const code = mainCode();
  const found = calls(code, method, name)[0];
  openFile(MAIN);
  if (found) reveal(found.from, found.to - 1);
}

/** Names not used by any call of `method` yet: base_1, base_2, … */
export function freeName(method: 'animation' | 'pose' | 'couple', base: string): string {
  const code = mainCode();
  const taken = (name: string) => calls(code, method, name).length > 0 || statements(code, name).length > 0;
  for (let n = 1; ; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
}

/** Splits a call's arguments at top-level commas: `"a", b(c, d), axis=(1, 2)` → three. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (text.slice(start).trim()) out.push(text.slice(start).trim());
  return out;
}

/** Read raw arguments so fields outside a tool's UI survive edits unchanged. */
function callArguments(text: string, parameters: string[]): Record<string, string> {
  const args = splitArgs(text.slice(text.indexOf('(') + 1, callEnd(text, 0) - 1));
  const result: Record<string, string> = {};
  let position = 0;
  for (const arg of args) {
    const keyword = /^(\w+)\s*=\s*([\s\S]*)$/.exec(arg);
    if (keyword) result[keyword[1]] = keyword[2];
    else if (parameters[position]) result[parameters[position++]] = arg;
  }
  return result;
}

const unquote = (text: string | undefined) => (text && /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text ?? '');
const pair = (text: string | undefined): [number, number] | null => {
  const match = text && /^\(\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

/** A joint as written in main.py, for editing it with the Joint tool. */
export function jointCall(name: string): (JointSpec & { line: number }) | null {
  const code = mainCode();
  const found = statements(code, name);
  const definition = found.find((item) => item.kind === 'joint');
  if (!definition) return null;
  const text = code.slice(definition.from, definition.to);
  const type = /\.(rigid|revolute|slider|cylindrical)\(/.exec(text)?.[1] as JointType | undefined;
  if (!type) return null;
  const keyword = callArguments(text, ['name', 'parent', 'child', 'axis', 'limits', ...(type === 'cylindrical' ? ['slide_limits'] : []), 'value', ...(type === 'cylindrical' ? ['slide'] : []), 'follow']);
  const axis = keyword.axis ?? null;
  const drive = found.find((item) => item.kind === 'drive');
  const driveArgs = drive ? callArguments(code.slice(drive.from, drive.to), ['joint', 'speed', 'range', 'check', 'samples', 'mode']) : {};
  const speed = driveArgs.speed !== undefined && Number.isFinite(Number(driveArgs.speed)) ? Number(driveArgs.speed) : null;
  const component = axis ? /^([a-z][a-z0-9_]*)\.(?:face|edge|vertex|ref)\(/.exec(axis)?.[1] ?? null : null;
  return {
    name, type, parent: unquote(keyword.parent), child: unquote(keyword.child),
    axis, axisComponent: component, limits: pair(keyword.limits), slideLimits: pair(keyword.slide_limits),
    drive: drive ? { speed, check: driveArgs.check === 'True' } : null, line: code.slice(0, definition.from).split('\n').length,
  };
}
