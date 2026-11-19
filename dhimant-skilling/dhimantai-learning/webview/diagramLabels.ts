type LabelRow = {text: SVGTextElement; bounds: DOMRect; scaleY: number};

/** Fit a centered, multiline flowchart label that straddles its node's border.
 * Measure only the sanitized display copy, in the same default font context
 * as a standalone SVG image. Saved notebook text keeps its authored geometry.
 */
export function fitDiagramLabels(svg: SVGSVGElement) {
  const rectangles = Array.from(svg.querySelectorAll('rect'));
  const texts = Array.from(svg.querySelectorAll('text'));
  if (!rectangles.length || !texts.length || typeof svg.getScreenCTM !== 'function') return;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;visibility:hidden;pointer-events:none';
  host.setAttribute('aria-hidden', 'true');
  const imageDocument = svg.ownerDocument;
  host.attachShadow({mode:'closed'}).append(svg);
  document.body.append(host);
  try {
    const cards: {bounds: DOMRect; rows: LabelRow[]}[] = [];
    for (const rect of rectangles) {
      if (rect.closest('defs,marker,clipPath') || getComputedStyle(rect).stroke === 'none') continue;
      const matrix = rect.getScreenCTM();
      if (!matrix || matrix.b || matrix.c) continue;
      const bounds = rect.getBoundingClientRect();
      if (bounds.height > 0) cards.push({bounds, rows: []});
    }

    for (const text of texts) {
      if (text.closest('defs,marker,clipPath')) continue;
      const bounds = text.getBoundingClientRect();
      const matrix = text.getScreenCTM();
      if (!bounds.height || !matrix || matrix.b || matrix.c || matrix.d <= 0) continue;
      const owners = cards.filter(({bounds: box}) => {
        // A subtitle on the border can have its descent outside the box.
        const overlap = Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top);
        const centerDistance = Math.abs((box.left + box.right - bounds.left - bounds.right) / 2);
        return bounds.left >= box.left && bounds.right <= box.right
          && centerDistance <= box.width * 0.025 && overlap >= bounds.height * 0.4;
      });
      // A caption between nodes or over nested cards has no clear owner.
      if (owners.length === 1) owners[0].rows.push({text, bounds, scaleY: matrix.d});
    }

    for (const {bounds: box, rows} of cards) {
      if (!rows.length) continue;
      if (rows.length === 1) {
        const line = rows[0].text.querySelector('tspan[x][dy],tspan[x][y]');
        if (!line || rows[0].bounds.height <= line.getBoundingClientRect().height * 1.4) continue;
      }
      rows.sort((a, b) => a.bounds.top - b.bounds.top);
      const top = rows[0].bounds.top;
      const bottom = Math.max(...rows.map(row => row.bounds.bottom));
      const padding = box.height * 0.05;
      if (top >= box.top + padding && bottom <= box.bottom - padding) continue;
      // Keep a title and subtitle together. Widely separated annotations and
      // blocks too tall to fit need an authored layout of their own.
      if (bottom - top > box.height - 2 * padding || rows.some((row, i) =>
        i > 0 && row.bounds.top - rows[i - 1].bounds.bottom > row.bounds.height)) continue;
      const shift = (box.top + box.bottom - top - bottom) / 2;
      for (const {text, scaleY} of rows) {
        // A transform moves absolute and relative tspan lines as one block.
        const existing = text.getAttribute('transform') ?? '';
        text.setAttribute('transform', (existing + ' translate(0 ' + shift / scaleY + ')').trim());
      }
    }
  } finally {
    imageDocument.appendChild(svg);
    host.remove();
  }
}
