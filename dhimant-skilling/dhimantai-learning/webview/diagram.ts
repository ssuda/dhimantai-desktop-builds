import { visualStyle } from './visual';

// Build a static SVG image in a fresh XML document. Only geometry, text and
// local paint/marker references cross this boundary. No source node is adopted.
const ns = 'http://www.w3.org/2000/svg';
const tags = new Set('svg g defs use clipPath marker linearGradient radialGradient stop rect circle ellipse path line polygon polyline text tspan title desc'.split(' '));
const presentation = new Set(('fill stroke color opacity fill-opacity stroke-opacity fill-rule clip-rule clip-path stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset ' +
  'text-anchor dominant-baseline alignment-baseline font-size font-family font-weight font-style font-stretch letter-spacing word-spacing paint-order ' +
  'marker-start marker-mid marker-end stop-color stop-opacity').split(' '));
const attributes = new Set(('viewBox preserveAspectRatio width height x y x1 x2 y1 y2 cx cy r rx ry d points dx dy transform ' +
  'id refX refY markerWidth markerHeight markerUnits orient gradientUnits gradientTransform offset clipPathUnits').split(' '));
for (const name of presentation) attributes.add(name);

function safeValue(value: string) {
  return !/[\\:]/.test(value) && (!/url\s*\(/i.test(value) || /^url\(#[\w.-]+\)$/.test(value));
}

export function diagram(source: string): string {
  const unavailable = '<p class="diagram-unavailable">Diagram unavailable. Continue with the written explanation.</p>';
  // Accept the wrappers emitted by the plotting tool, but never entity declarations
  // or arbitrary DTDs. Parsing and copying below still applies to the entire SVG.
  source = source.trim().replace(/^```(?:svg|xml)\s*\n([\s\S]*?)\n```$/i, '$1')
    .replace(/<!DOCTYPE svg PUBLIC "-\/\/W3C\/\/DTD SVG 1\.1\/\/EN"\s+"http:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd"\s*>/i, '');
  if (/<!DOCTYPE\b/i.test(source)) return unavailable;
  const xml = new DOMParser().parseFromString(source.trim(), 'image/svg+xml');
  const root = xml.documentElement;
  if (root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== ns) || xml.getElementsByTagName('parsererror').length) {
    return unavailable;
  }
  const clean = document.implementation.createDocument(ns, 'svg', null);
  const labels: string[] = [];
  function copy(input: Element, output: Element, depth: number) {
    for (const attr of Array.from(input.attributes)) {
      if (attributes.has(attr.name) && safeValue(attr.value)) {
        output.setAttribute(attr.name, attr.value);
      }
    }
    // Matplotlib puts backgrounds, curves and typography in inline CSS. Convert
    // only static presentation properties to attributes; never copy CSS wholesale.
    const style = document.createElement('span').style;
    style.cssText = input.getAttribute('style') ?? '';
    // SVG-only properties such as paint-order are absent from some CSSOMs.
    // They still have to survive: losing stroke-before-fill hides small labels.
    for (const declaration of (input.getAttribute('style') ?? '').split(';')) {
      const match = declaration.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      const name = match[1].toLowerCase(), value = match[2].replace(/\s*!important\s*$/i, '');
      if (presentation.has(name) && value && safeValue(value)) output.setAttribute(name, value);
    }
    for (const name of presentation) {
      const value = style.getPropertyValue(name).trim();
      if (value && safeValue(value)) output.setAttribute(name, value);
    }
    if (input.localName === 'use') {
      const ref = input.getAttribute('href') ?? input.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (ref && /^#[\w.-]+$/.test(ref)) output.setAttribute('href', ref);
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
  // Give viewBox-only and percentage-sized SVGs their authored intrinsic ratio.
  // Otherwise an <img> can fall back to the browser's 300 × 150 default box.
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    const absolute = (name: string) => {
      const value = svg.getAttribute(name)?.trim().match(/^(\d*\.?\d+)(px|pt|pc|mm|cm|in)?$/i);
      return value && Number(value[1]) > 0 ? value : undefined;
    };
    const w = absolute('width'), h = absolute('height');
    // Retain deliberately small authored sizes, even with a large viewBox.
    if (!w) svg.setAttribute('width', h ? `${Number(h[1]) * box[2] / box[3]}${h[2] ?? ''}` : String(box[2]));
    if (!h) svg.setAttribute('height', w ? `${Number(w[1]) * box[3] / box[2]}${w[2] ?? ''}` : String(box[3]));
  }
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Generated diagrams normally use dark ink and pastel fills. Give that authored
  // palette its own light canvas; a transparent image must not inherit dark chrome.
  svg.setAttribute('style', 'background:#fff;color:#202124');
  if (!svg.hasAttribute('fill')) svg.setAttribute('fill', '#202124');
  const img = document.createElement('img');
  img.className = 'board-diagram';
  img.style.cssText = visualStyle + ';background:#fff;color:#202124;border:1px solid var(--vscode-panel-border,#ddd);border-radius:8px;padding:12px';
  img.alt = [svg.querySelector('title')?.textContent || 'Diagram', svg.querySelector('desc')?.textContent || labels.join(', ')]
    .filter(Boolean).join('. ');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clean));
  return img.outerHTML;
}
