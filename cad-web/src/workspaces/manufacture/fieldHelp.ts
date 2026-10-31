/**
 * Plain words for the library's validation: what to change in a field, never the validator's pattern or type name
 * (the raw text stays available behind "Details"). Also the short IDs some fields take (a controller's dialect, a
 * station, an option): what a person types becomes the ID it should be.
 */
import type { FieldProblem } from './api';

/** A short ID from words: "Siemens SINUMERIK 808D" → siemens_sinumerik_808d. Null when nothing usable is left. */
export function slugify(text: string, maxLength = 64): string | null {
  const slug = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) return null;
  return (/^[a-z]/.test(slug) ? slug : `x_${slug}`).slice(0, maxLength).replace(/_+$/, '');
}

const IDENTIFIER_HINT = 'Use a short ID: letters, digits, _ or -, no spaces, starting with a letter';

/** Whether a field's pattern is an ID-like pattern that a slug of the typed text can satisfy. */
export function slugFor(pattern: string | undefined, value: unknown): string | null {
  if (!pattern || typeof value !== 'string' || !value.trim()) return null;
  let matcher: RegExp;
  try { matcher = new RegExp(pattern); } catch { return null; }
  if (matcher.test(value)) return null;
  const slug = slugify(value);
  return slug && matcher.test(slug) ? slug : null;
}

const NUMBER = /(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i;

/** One field's problem in plain words. `value`: what the field holds, for an ID suggestion. */
export function friendlyMessage(problem: FieldProblem, value?: unknown): string {
  const code = problem.code ?? '';
  const raw = problem.message.replace(/^Value error, /, '');
  const number = raw.match(NUMBER)?.[1];
  switch (code) {
    case 'missing':
      return 'Required.';
    case 'string_too_short':
    case 'too_short':
      return /at least 1 /.test(raw) || /least 1 (?:item|character)/.test(raw) ? 'Required.' : `Too short: ${raw.replace(/^(String|List|Tuple) should have /, 'needs ')}.`.replace('..', '.');
    case 'string_pattern_mismatch': {
      const pattern = raw.match(/pattern '(.+)'/)?.[1];
      const slug = slugFor(pattern, value);
      return /\^\[a-zA-Z\]/.test(pattern ?? '') ? `${IDENTIFIER_HINT}${slug ? ` (e.g. ${slug})` : ''}.` : 'Not in the expected format.';
    }
    case 'greater_than_equal': return number !== undefined ? `Must be at least ${number}.` : raw;
    case 'greater_than': return number !== undefined ? `Must be more than ${number}.` : raw;
    case 'less_than_equal': return number !== undefined ? `Must be at most ${number}.` : raw;
    case 'less_than': return number !== undefined ? `Must be less than ${number}.` : raw;
    case 'string_too_long': case 'too_long': return number !== undefined ? `Too long: at most ${number}.` : raw;
    case 'literal_error': case 'enum': return 'Choose one of the options.';
    case 'int_parsing': case 'int_type': case 'int_from_float': return 'Enter a whole number.';
    case 'float_parsing': case 'float_type': case 'finite_number': return 'Enter a number.';
    case 'bool_parsing': case 'bool_type': return 'Choose yes or no.';
    case 'extra_forbidden': return 'Not a field of this record.';
    case 'model_type': case 'dict_type': return 'Choose one.';
    default: return raw;
  }
}
