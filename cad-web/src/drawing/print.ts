/**
 * Prints every sheet of a drawing at once (Export → Drawing, then Save as PDF): one page a sheet, each at its own
 * paper size and orientation, from the SVGs the full build drew (sheets.ts), sanitized as the Drawing tab shows them.
 * Nothing new is served or generated: the sheets go on a print-only layer of this page, sized with CSS named pages
 * (`@page <name> { size }` and the `page` property), and leave once the print dialog closes.
 */
import { sanitizeSvg } from '@/lib/sanitize';

const LAYER = 'drawing-print';

/** Opens the print dialog with every sheet; false when there's none to print. */
export function printSheets(markup: string[]): boolean {
  const sheets = markup.map(sanitizeSvg).filter((svg): svg is SVGSVGElement => !!svg);
  if (!sheets.length) return false;
  document.getElementById(LAYER)?.remove();
  const layer = document.createElement('div');
  layer.id = LAYER;
  const rules = [
    `@media screen { #${LAYER} { display: none; } }`,
    `@media print {
      html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #ffffff !important; }
      body > :not(#${LAYER}) { display: none !important; }
      #${LAYER} > div { break-after: page; break-inside: avoid; overflow: hidden; }
      #${LAYER} > div:last-child { break-after: auto; }
      #${LAYER} svg { display: block; width: 100%; height: 100%; }
    }`,
  ];
  sheets.forEach((svg, index) => {
    const box = svg.viewBox.baseVal;
    const [width, height] = box && box.width && box.height ? [box.width, box.height] : [420, 297];
    const name = `steve-sheet-${index + 1}`;
    rules.push(`@page ${name} { size: ${width}mm ${height}mm; margin: 0; }`);
    const page = document.createElement('div');
    page.style.setProperty('page', name);
    page.style.width = `${width}mm`;
    page.style.height = `${height}mm`;
    page.append(svg);
    layer.append(page);
  });
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  layer.prepend(style);
  document.body.append(layer);
  const done = () => { window.removeEventListener('afterprint', done); layer.remove(); };
  window.addEventListener('afterprint', done);
  window.print();
  return true;
}
