import { showHelp } from '@/help/state';
/**
 * Studio-compatible documentation addresses. Steve resolves these inside
 * the offline reader, backed by the CAD manual bundled with this release.
 */

/** The documentation areas (docs/site/scripts/areas.mjs); a page lives at /docs/<area>/<page>/. */
export const DOCS_AREAS = [
  'start', 'design', 'assemblies', 'drawing', 'simulate', 'manufacture', 'electronics', 'collaborate', 'steve', 'integrations',
  'agents', 'developers', 'concepts', 'reference', 'local',
] as const;
export type DocsArea = (typeof DOCS_AREAS)[number];

export const DOCS_ROOT = '/docs/';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const ANCHOR = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

/**
 * The address of a docs page: docsUrl('design', 'fillet', 'options') -> '/docs/design/fillet/#options'. Without a page,
 * the area's landing page; without an area, the documentation's front page. Page names and anchors are the docs' own
 * slugs (lowercase words and hyphens); anything else is a programming error and throws.
 */
export function docsUrl(area?: DocsArea, page?: string, anchor?: string): string {
  if (area === undefined) return DOCS_ROOT;
  if (!DOCS_AREAS.includes(area)) throw new Error(`docsUrl: unknown area ${JSON.stringify(area)}`);
  if (page !== undefined && page !== '' && !SLUG.test(page)) throw new Error(`docsUrl: bad page ${JSON.stringify(page)}`);
  if (anchor !== undefined && !ANCHOR.test(anchor)) throw new Error(`docsUrl: bad anchor ${JSON.stringify(anchor)}`);
  const path = page ? `${DOCS_ROOT}${area}/${page}/` : `${DOCS_ROOT}${area}/`;
  return anchor ? `${path}#${anchor}` : path;
}

/** Opens the offline manual without navigating away from the CAD workspace. */
export function openDocs(url: string = DOCS_ROOT): void {
  if (!url.startsWith(DOCS_ROOT)) throw new Error(`openDocs: not a docs address: ${url}`);
  showHelp(url);
}

/** "What's new": the user-visible changes, newest first (docs/site/src/content/docs/start/whats-new.md). */
export function openWhatsNew(): void {
  openDocs(docsUrl('start', 'whats-new'));
}
