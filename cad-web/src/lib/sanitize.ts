/**
 * SVG markup built from data (circuit-to-svg's schematics, drawn from a build's Circuit JSON) before it enters the page.
 *
 * circuit-to-svg serializes through svgson, whose CDATA escaping replaces only the first `]]>` of a text: a part name or
 * label holding two can close the CDATA section and put markup of its own into the drawing. So the markup is never
 * trusted: DOMPurify (SVG profile) parses it into a detached document and keeps only drawing elements and attributes.
 * Scripts, `foreignObject`, event handlers and links out are dropped; the only references kept are fragment links
 * (`#id`, for masks, clip paths and patterns) and embedded images (`data:image/...`, circuit-to-svg's schematic
 * graphics), which never run scripts. The result is a DOM node, so nothing is parsed a second time.
 */
import DOMPurify, { type Config } from 'dompurify';

const REFERENCES = new Set(['href', 'xlink:href']);
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i;
/** `url(...)` in a style, other than a reference into the drawing itself (`url(#mask)`) or embedded data (fonts). */
const EXTERNAL_URL = /url\(\s*(?!['"]?(?:#|data:))/i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

function svgPurifier() {
  if (purifier) return purifier;
  // An instance of its own: the hooks below never apply to other sanitization in the app.
  purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue.trim();
    if (REFERENCES.has(name)) {
      const image = node.nodeName.toLowerCase() === 'image';
      data.keepAttr = value.startsWith('#') || (image && EMBEDDED_IMAGE.test(value));
      if (data.keepAttr) data.forceKeepAttr = true;  // DOMPurify's own URI check still applies to everything else.
    } else if (EXTERNAL_URL.test(value)) {
      data.keepAttr = false;
    }
  });
  purifier.addHook('uponSanitizeElement', (node, data) => {
    // A <style> may only style the drawing: no imports or fetched resources.
    if (data.tagName === 'style' && (/@import/i.test(node.textContent ?? '') || EXTERNAL_URL.test(node.textContent ?? ''))) node.textContent = '';
  });
  return purifier;
}

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['image'],
  FORBID_TAGS: ['foreignObject', 'foreignobject', 'script', 'iframe', 'object', 'embed', 'a', 'animate', 'set', 'animateMotion', 'animateTransform', 'use'],
  FORBID_ATTR: ['xml:base'],
  ALLOW_DATA_ATTR: true,
  RETURN_DOM_FRAGMENT: true,
};

/** The first `<svg>` of the markup, sanitized; null when there is none. */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  const fragment = svgPurifier().sanitize(markup, CONFIG);
  const svg = fragment.querySelector('svg');
  return svg instanceof SVGSVGElement ? svg : null;
}
