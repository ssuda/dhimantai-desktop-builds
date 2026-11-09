// Build a static SVG image in a fresh XML document. Only geometry, text and
// local paint/marker references cross this boundary. No source node is adopted.
const ns = 'http://www.w3.org/2000/svg';
const tags = new Set('svg g defs marker linearGradient radialGradient stop rect circle ellipse path line polygon polyline text tspan title desc'.split(' '));
const attributes = new Set(('viewBox preserveAspectRatio width height x y x1 x2 y1 y2 cx cy r rx ry d points dx dy transform ' +
  'fill stroke color opacity fill-opacity stroke-opacity fill-rule stroke-width stroke-linecap stroke-linejoin stroke-dasharray ' +
  'text-anchor dominant-baseline alignment-baseline font-size font-family font-weight id refX refY markerWidth markerHeight ' +
  'markerUnits orient marker-start marker-mid marker-end gradientUnits gradientTransform offset stop-color stop-opacity').split(' '));

export function diagram(source: string): string {
  const unavailable = '<p>Diagram unavailable. Ask for a table or a text explanation.</p>';
  if (/<!DOCTYPE\b/i.test(source)) return unavailable;
  const xml = new DOMParser().parseFromString(source.trim(), 'image/svg+xml');
  const root = xml.documentElement;
  if (root.localName !== 'svg' || xml.getElementsByTagName('parsererror').length) {
    return unavailable;
  }
  const clean = document.implementation.createDocument(ns, 'svg', null);
  const labels: string[] = [];
  function copy(input: Element, output: Element, depth: number) {
    for (const attr of Array.from(input.attributes)) {
      if (attributes.has(attr.name) && !/[\\:]/.test(attr.value) &&
          (!/url\s*\(/i.test(attr.value) || /^url\(#[\w.-]+\)$/.test(attr.value))) {
        output.setAttribute(attr.name, attr.value);
      }
    }
    if (depth >= 32) return;
    for (const node of Array.from(input.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        output.append(clean.createTextNode(node.textContent ?? ''));
      } else if (node instanceof Element && tags.has(node.localName) && (!node.namespaceURI || node.namespaceURI === ns)) {
        const child = clean.createElementNS(ns, node.localName);
        output.append(child);
        copy(node, child, depth + 1);
        if (node.localName === 'text' && child.textContent?.trim()) labels.push(child.textContent.trim());
      }
    }
  }
  const svg = clean.documentElement;
  copy(root, svg, 0);
  if (!svg.querySelector('rect, circle, ellipse, path, line, polygon, polyline, text')) return unavailable;
  // Preserve the original coordinate system when scaling a width/height-only SVG.
  const width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'));
  if (!svg.hasAttribute('viewBox') && width > 0 && height > 0) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Generated diagrams normally use dark ink and pastel fills. Give that authored
  // palette its own light canvas; a transparent image must not inherit dark chrome.
  svg.setAttribute('style', 'background:#fff;color:#202124');
  if (!svg.hasAttribute('fill')) svg.setAttribute('fill', '#202124');
  const img = document.createElement('img');
  img.className = 'board-diagram';
  img.style.cssText = 'background:#fff;color:#202124;border:1px solid var(--vscode-panel-border,#ddd);border-radius:8px;padding:12px;max-width:100%;height:auto;box-sizing:border-box';
  img.alt = [svg.querySelector('title')?.textContent || 'Diagram', svg.querySelector('desc')?.textContent || labels.join(', ')]
    .filter(Boolean).join('. ');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clean));
  return img.outerHTML;
}
