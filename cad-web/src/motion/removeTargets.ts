import { pythonLanguage } from '@codemirror/lang-python';

type Node = ReturnType<typeof pythonLanguage.parser.parse>['topNode'];
interface Argument { key?: string; value: Node; raw: string }
interface Call { method: string; name: string; node: Node; args: Argument[]; list: Node }

/** Top-level comma-separated expressions, using Python syntax rather than
 * splitting text inside nested tuples, strings, dictionaries or comments. */
function groups(node: Node): Node[][] {
  const result: Node[][] = [];
  let group: Node[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (['(', ')', '[', ']', '{', '}', 'Comment'].includes(child.name)) continue;
    if (child.name === ',') { if (group.length) result.push(group); group = []; }
    else group.push(child);
  }
  if (group.length) result.push(group);
  return result;
}

function literal(code: string, node?: Node): string | null {
  if (node?.name !== 'String') return null;
  const raw = code.slice(node.from, node.to);
  const match = /^(["'])([A-Za-z0-9_. -]+)\1$/.exec(raw);
  return match?.[2] ?? null;
}

function argumentsOf(code: string, list: Node): Argument[] {
  return groups(list).map(nodes => {
    const keyword = nodes[0].name === 'VariableName' && nodes[1]?.name === 'AssignOp';
    return { key: keyword ? code.slice(nodes[0].from, nodes[0].to) : undefined,
      value: keyword ? nodes[2] : nodes[0], raw: code.slice(nodes[0].from, nodes.at(-1)!.to) };
  });
}

function editCalls(code: string, methods: string[], edit: (call: Call) => string | null | undefined): string {
  const tree = pythonLanguage.parser.parse(code);
  const changes: { from: number; to: number; text: string }[] = [];
  for (let statement = tree.topNode.firstChild; statement; statement = statement.nextSibling) {
    const node = statement.name === 'ExpressionStatement' ? statement.firstChild : null;
    if (node?.name !== 'CallExpression') continue;
    const member = node.firstChild, list = node.getChild('ArgList');
    if (member?.name !== 'MemberExpression' || !list) continue;
    const property = member.getChild('PropertyName');
    if (!property) continue;
    const method = code.slice(property.from, property.to);
    if (!methods.includes(method)) continue;
    const args = argumentsOf(code, list);
    const name = literal(code, args[0]?.value);
    if (!name) continue;
    const replacement = edit({ method, name, node, args, list });
    if (replacement !== undefined) changes.push({ from: node.from, to: node.to, text: replacement ?? '' });
  }
  for (const change of changes.reverse()) code = code.slice(0, change.from) + change.text + code.slice(change.to);
  return code;
}

function render(code: string, call: Call, args: string[]): string {
  return code.slice(call.node.from, call.list.from + 1) + args.join(', ') + ')';
}

function dictionary(code: string, node: Node, targets: Set<string>): { source: string; empty: boolean; changed: boolean } | null {
  if (node.name !== 'DictionaryExpression') return null;
  const entries = groups(node);
  const kept = entries.filter(entry => {
    const key = literal(code, entry[0]);
    return !key || !targets.has(key.split('.')[0]);
  });
  return { source: '{' + kept.map(entry => code.slice(entry[0].from, entry.at(-1)!.to)).join(', ') + '}', empty: !kept.length, changed: kept.length !== entries.length };
}

function references(code: string, node: Node, names: Set<string>): boolean {
  const value = literal(code, node);
  if (value && (names.has(value) || names.has(value.split('.')[0]))) return true;
  for (let child = node.firstChild; child; child = child.nextSibling) if (references(code, child, names)) return true;
  return false;
}

/** Named-pose keys may use Python tuples or lists, with comments between values. */
function poseKeys(code: string, call: Call): { node: Node; name: string }[] {
  const keys = call.args.find(arg => arg.key === 'keys') ?? call.args[1];
  if (!keys || !['ArrayExpression', 'TupleExpression'].includes(keys.value.name)) return [];
  return groups(keys.value).flatMap(entry => {
    if (!['ArrayExpression', 'TupleExpression'].includes(entry[0].name)) return [];
    const pair = groups(entry[0]);
    const node = pair[0]?.[0], name = pair.length === 2 ? literal(code, node) : null;
    return node && name ? [{ node, name }] : [];
  });
}

export function animationsUsingPose(code: string, pose: string): string[] {
  const names = new Set<string>();
  editCalls(code, ['animation'], call => {
    if (poseKeys(code, call).some(key => key.name === pose)) names.add(call.name);
  });
  return [...names];
}

export function renameAnimationPoseReferences(code: string, from: string, to: string): string {
  return editCalls(code, ['animation'], call => {
    const keys = poseKeys(code, call).filter(key => key.name === from);
    if (!keys.length) return;
    let text = code.slice(call.node.from, call.node.to);
    for (const { node } of keys.reverse()) {
      const start = node.from - call.node.from, end = node.to - call.node.from;
      text = text.slice(0, start) + JSON.stringify(to) + text.slice(end);
    }
    return text;
  });
}

/** Delete a joint/coupling and prune literal motion definitions that refer to
 * it. Unrelated motions and all geometry stay in place. A study whose requested
 * motion no longer exists is removed rather than silently testing a new motion. */
export function removeMotionTarget(source: string, target: string): string {
  let code = source;
  const targets = new Set([target]), poses = new Set<string>(), modes = new Set<string>(), animations = new Set<string>();
  code = editCalls(code, ['rigid', 'revolute', 'slider', 'cylindrical', 'couple'], call => targets.has(call.name) ? null : undefined);
  code = editCalls(code, ['couple'], call => {
    const gears = call.args.find(arg => arg.key === 'gears') ?? call.args[1];
    if (!gears) return;
    const cleaned = dictionary(code, gears.value, targets);
    if (!cleaned?.changed) return;
    if (cleaned.empty) { targets.add(call.name); return null; }
    return render(code, call, call.args.map(arg => arg === gears ? `${arg.key ? arg.key + '=' : ''}${cleaned.source}` : arg.raw));
  });
  code = editCalls(code, ['mode'], call => {
    let changed = false, nonempty = false;
    const args = call.args.flatMap((arg, index) => {
      if (index === 0) return [arg.raw];
      const cleaned = dictionary(code, arg.value, targets);
      if (!cleaned) { nonempty = true; return [arg.raw]; }
      changed ||= cleaned.changed;
      if (cleaned.empty) return [];
      nonempty = true;
      return [`${arg.key ? arg.key + '=' : ''}${cleaned.source}`];
    });
    if (!changed) return;
    if (!nonempty) { modes.add(call.name); return null; }
    return render(code, call, args);
  });
  code = editCalls(code, ['pose'], call => {
    const kept = call.args.filter(arg => !targets.has(arg.key ?? '') && !(arg.key === 'mode' && modes.has(literal(code, arg.value) ?? '')));
    if (kept.length === call.args.length) return;
    if (!kept.some(arg => arg.key && arg.key !== 'mode')) { poses.add(call.name); return null; }
    return render(code, call, kept.map(arg => arg.raw));
  });
  code = editCalls(code, ['animation'], call => {
    const keys = call.args.find(arg => arg.key === 'keys') ?? call.args[1];
    if (!keys || !['ArrayExpression', 'TupleExpression'].includes(keys.value.name)) return;
    let changed = false;
    const kept: string[] = [];
    const times: number[] = [];
    for (const entry of groups(keys.value)) {
      const pair = groups(entry[0]);
      if (pair.length !== 2) { kept.push(code.slice(entry[0].from, entry.at(-1)!.to)); times.push(NaN); continue; }
      const value = pair[0][0];
      if (poses.has(literal(code, value) ?? '')) { changed = true; continue; }
      const cleaned = dictionary(code, value, targets);
      if (cleaned?.changed) {
        changed = true;
        if (cleaned.empty) continue;
        kept.push(`(${cleaned.source}, ${code.slice(pair[1][0].from, pair[1].at(-1)!.to)})`);
      } else kept.push(code.slice(entry[0].from, entry.at(-1)!.to));
      times.push(Number(code.slice(pair[1][0].from, pair[1].at(-1)!.to)));
    }
    const args = call.args.flatMap(arg => {
      if (arg.key === 'mode' && modes.has(literal(code, arg.value) ?? '')) { changed = true; return []; }
      return [arg === keys ? `${arg.key ? arg.key + '=' : ''}[${kept.join(', ')}]` : arg.raw];
    });
    if (!changed) return;
    if (kept.length < 2 || (Number.isFinite(times[0]) && Number.isFinite(times.at(-1)) && times.at(-1)! <= times[0])) { animations.add(call.name); return null; }
    return render(code, call, args);
  });
  code = editCalls(code, ['drive'], call => {
    if (targets.has(call.name)) return null;
    const kept = call.args.filter(arg => !(arg.key === 'mode' && modes.has(literal(code, arg.value) ?? '')));
    return kept.length !== call.args.length ? render(code, call, kept.map(arg => arg.raw)) : undefined;
  });
  const removed = new Set([...targets, ...poses, ...modes, ...animations]);
  code = editCalls(code, ['collision_study', 'fit_check'], call => {
    const motionArgs = call.method === 'fit_check' ? ['poses', 'mode'] : ['joints', 'steps', 'poses', 'hold', 'ranges', 'boundary', 'map', 'animation', 'mode'];
    return call.args.some((arg, index) => (motionArgs.includes(arg.key ?? '') || (call.method === 'collision_study' && index === 1 && !arg.key)) && references(code, arg.value, removed)) ? null : undefined;
  });
  return code;
}
