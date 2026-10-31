/**
 * Links and pictures whose address comes from data (catalogues, search results, the server, the address bar): only
 * what they're meant to be gets into an href, a src or window.open.
 */

/** An absolute http(s) URL for an href, or undefined: javascript:, data:, relative and malformed addresses never pass. */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return undefined;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch { return undefined; }
}

/** Where step.parts keeps its catalogue pictures (app/standard_parts.py `thumbnail`); no other host is loaded. */
export const STANDARD_PARTS_IMAGES = 'https://8ljrorjug0ps5al0.public.blob.vercel-storage.com';

/** A standard part's picture, when it is an https address on the catalogue's image host; else undefined. */
export function standardPartImage(url: unknown): string | undefined {
  if (typeof url === 'string' && /^\/v1\/standard-parts\/images\/[a-f0-9]{64}$/.test(url)) return url;
  const href = safeHref(url);
  return href && new URL(href).origin === STANDARD_PARTS_IMAGES ? href : undefined;
}

/** McMaster-Carr's site: the only place the McMaster window (state/mcmaster.ts) opens. */
export const MCMASTER = 'https://www.mcmaster.com/';

/** A McMaster-Carr page: the address when it is on https://www.mcmaster.com/, else the catalogue's front page. */
export function mcmasterUrl(url: unknown): string {
  const href = safeHref(url);
  return href && new URL(href).origin === new URL(MCMASTER).origin ? href : MCMASTER;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a UUID: every document, build, study, run, program and job id is one. */
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Address-bar parameters that name a document, build, study, run, program or job (state/deepLink.ts): API path parts. */
const ID_PARAMS = ['document', 'model', 'build', 'study', 'run', 'program', 'job'];

/** A deep link's parameters without any id that isn't a UUID: a crafted link opens nothing rather than another path. */
export function linkParams(search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const name of ID_PARAMS) if (params.has(name) && !isUuid(params.get(name))) params.delete(name);
  return params;
}

/** Makes every link under `root` open in a new tab without access to this window or a referrer. */
export function openLinksOutside(root: ParentNode | null | undefined) {
  root?.querySelectorAll('a').forEach((link) => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
}
