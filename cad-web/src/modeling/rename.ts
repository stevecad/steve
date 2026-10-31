import { get, set } from '@/state/store';
import { setCode, updateModel } from '@/state/actions';
import { api, ApiError } from '@/lib/api';
import { evaluate, evaluateLength, lengthParameter, lengthSource, parseModel, removeParameter, renameParameterCode, setParameter, validParameterName, writeBodyName, writeName, type ModelDoc, type ModelParameter } from '@/lib/modeling';
import { ANGLE_UNITS, hasLengthUnit } from '@/lib/lengths';
import { builtFrom } from '@/state/design';

/**
 * Renames are code edits (docs/MODELING.md): a feature's `name=`, a body's `model.body_name(...)`,
 * a parameter's identifier everywhere it is used. Ids never change, so references hold. Each
 * resolves to null, or the reason it couldn't be done.
 */

/** A code edit that doesn't change the shape still regenerates, so the shown build matches the code. */
export async function regenerate() {
  if (!get().displayed) return;
  while (get().busy) await new Promise((resolve) => setTimeout(resolve, 150));
  const { displayed, doc } = get();
  if (displayed && !builtFrom(displayed, doc)) void updateModel();
}

/** Writes new code and its parse together, so the tree shows the new name at once. */
async function apply(code: string, next: string) {
  const doc = await parseModel(next);
  if (get().doc.code !== code) throw new Error('The code changed meanwhile. Try again.');
  setCode(next);
  set({ modeling: doc });
  void regenerate();
}

async function edit(change: (code: string, doc: ModelDoc) => string): Promise<string | null> {
  const code = get().doc.code;
  try {
    const next = change(code, await parseModel(code));
    if (next !== code) await apply(code, next);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function checkName(text: string): string | null {
  if (!text.trim()) return 'Type a name.';
  if (text.length > 120) return 'Keep names under 120 characters.';
  return null;
}

export const renameFeature = (id: string, name: string) => edit((code, doc) => {
  const feature = doc.features.find((f) => f.id === id);
  if (!feature) throw new Error(`${id} is no longer in the code.`);
  return feature.name === name && feature.kwargs?.name ? code : writeName(code, feature, name);
});

export const renameBody = (body: string, name: string) => edit((code, doc) => {
  if (!doc.canonical) throw new Error('Bodies get names in the modeling format.');
  return writeBodyName(code, doc, body, name);
});

export function checkParameterName(text: string, doc: ModelDoc | null, except: string): string | null {
  const result = validParameterName(text, doc, except);
  return result === true ? null : result;
}

/** Renamed on the server, which knows Python's scopes: only the uses of this parameter change. */
export async function renameParameter(old: string, name: string): Promise<string | null> {
  const code = get().doc.code;
  try {
    await apply(code, await renameParameterCode(code, old, name));
    if (get().parameterFocus === old) set({ parameterFocus: name });
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return 'This server can’t rename parameters yet.';
    return (error as Error).message;
  }
}

export async function renamePlane(old: string, name: string): Promise<string | null> {
  const code = get().doc.code;
  try {
    const response = await api<{ code: string }>('/v1/modeling/rename-plane', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, old, new: name }) });
    await apply(code, response.code);
    set({ hiddenPlanes: get().hiddenPlanes.map((id) => id === old ? name : id) });
    return null;
  } catch (error) { return (error as Error).message; }
}

/** The parameters a parameter may use (those before it). */
const earlierThan = (doc: ModelDoc | null, parameter: ModelParameter | undefined) =>
  doc && parameter ? { ...doc, parameters: doc.parameters.filter((p) => p.line < parameter.line) } : doc;

export function checkExpression(text: string, name: string, doc: ModelDoc | null): string | null {
  const parameter = doc?.parameters.find((p) => p.name === name);
  const length = lengthParameter(parameter?.unit), earlier = earlierThan(doc, parameter);
  if ((length ? evaluateLength(text, 'mm', earlier) : evaluate(text, earlier)) !== null) return null;
  if (parameter?.unit === 'deg' && hasLengthUnit(text)) return ANGLE_UNITS;
  return length ? 'Type a number (mm), a length like 1in, or an expression of earlier parameters.' : 'Type a number or an expression of earlier parameters.';
}

/** A length parameter (mm, or no unit given) takes units, written in millimetres: `1in` as `25.4`. */
export const setParameterValue = (name: string, expression: string) => edit((code, doc) => {
  const parameter = doc.parameters.find((p) => p.name === name);
  if (!parameter) throw new Error(`${name} is no longer a parameter.`);
  const written = lengthParameter(parameter.unit) ? lengthSource(expression, 'mm', earlierThan(doc, parameter)) : expression;
  return parameter.expression === written ? code : setParameter(code, parameter, written);
});

export const deleteParameter = (name: string) => edit((code, doc) => {
  const parameter = doc.parameters.find((p) => p.name === name);
  return parameter ? removeParameter(code, parameter) : code;
});
