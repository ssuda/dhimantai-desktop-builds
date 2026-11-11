import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function render(text: string) {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts: 'outside-only'});
  dom.window.eval(readFileSync(join(__dirname, '../../media/coachMarkdown.js'), 'utf8'));
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = (dom.window as any).CoachMarkdown.render(text);
  return {dom, main};
}

test('Instructor renders headings and Flutter inline/display LaTeX delimiters', () => {
  const {dom, main} = render(String.raw`### Question

Find **x** using $x^2$ and \(\frac{1}{2}\).

\[
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]

$$\sum_{i=1}^{n} i$$

1. Read the formula
2. Explain the result`);
  try {
    assert.equal(main.querySelector('h3')?.textContent, 'Question');
    assert.equal(main.querySelectorAll('.katex').length, 4);
    assert.equal(main.querySelectorAll('.katex-display').length, 2);
    assert.equal(main.querySelectorAll('ol li').length, 2);
    assert.equal(main.querySelector('.katex-error, .math-fallback'), null);
  } finally { dom.window.close(); }
});

test('Instructor keeps code/currency literal and rejects active Markdown and TeX', () => {
  const {dom, main} = render(String.raw`Use \$5 and \$10. Code: \`\(x^2\)\`.

\`\`\`python
print("$x$ and \\[x^2\\]")
\`\`\`

\(\htmlClass{injected}{x}\) \(\href{javascript:alert(1)}{click}\)

<script>alert(1)</script> ![remote](https://example.test/a.png) [run](command:evil)` .replace(/\\`/g, '`'));
  try {
    assert.match(main.textContent!, /\$5 and \$10/);
    assert.equal(main.querySelector('code')?.textContent, String.raw`\(x^2\)`);
    assert.match(main.querySelector('pre code')?.textContent ?? '', /\$x\$/);
    assert.equal(main.querySelector('code .katex, a, script, img, iframe, .injected'), null);
  } finally { dom.window.close(); }
});

test('unsupported TeX remains readable without parser errors or red error markup', () => {
  const {dom, main} = render(String.raw`Before \(\notARealCommand{x}\) after.`);
  try {
    assert.equal(main.querySelector('.math-fallback')?.textContent, String.raw`\notARealCommand{x}`);
    assert.equal(main.querySelector('.katex-error'), null);
    assert.doesNotMatch(main.textContent!, /ParseError/);
  } finally { dom.window.close(); }
});

test('Instructor renders the reported manual trace as a table and raw/fenced SVG as static images', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="100"><rect x="1" y="1" width="338" height="98" fill="#eef"/><text x="20" y="50">Argument → parameter</text></svg>';
  const {dom, main} = render('**Manual trace** (in execution order):\n\n| Step | What runs | Name | Value |\n|---|---|---|---|\n| 1 | `print_twice("Dennis Moore")` | `string` | Dennis Moore |\n| 2 | `print(string)` | `string` | Dennis Moore |\n\n' + svg + '\n\n```svg\n' + svg + '\n```');
  try {
    assert.equal(main.querySelectorAll('thead th').length, 4);
    assert.equal(main.querySelectorAll('tbody tr').length, 2);
    assert.equal(main.querySelector('td code')?.textContent, 'print_twice("Dennis Moore")');
    const images = main.querySelectorAll('img.board-diagram');
    assert.equal(images.length, 2);
    for (const image of images) {
      assert.match(image.getAttribute('src')!, /^data:image\/svg\+xml/);
      assert.match(image.getAttribute('alt')!, /Argument → parameter/);
      assert.match(decodeURIComponent(image.getAttribute('src')!), /viewBox="0 0 340 100"/);
      assert.match(decodeURIComponent(image.getAttribute('src')!), /preserveAspectRatio="xMidYMid meet"/);
      assert.equal((image as HTMLElement).style.background, 'rgb(255, 255, 255)');
    }
    assert.doesNotMatch(main.textContent!, /<svg|<rect/);
  } finally { dom.window.close(); }
});

test('Instructor sanitizes active SVG and keeps XML examples and malformed diagrams literal', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><foreignObject><iframe src="https://evil.test"/></foreignObject><image href="https://evil.test/a.png"/><rect width="100" height="50" fill="url(https://evil.test/paint)"/><text x="2" y="20">Safe</text></svg>';
  const {dom, main} = render(svg + '\n\n```xml\n<svg><text>Literal code</text></svg>\n```\n\n`<svg>inline</svg>`\n\n<svg>\n<text>Unclosed\n\nKeep this explanation.');
  try {
    assert.equal(main.querySelectorAll('img').length, 1);
    const clean = decodeURIComponent(main.querySelector('img')!.getAttribute('src')!);
    assert.doesNotMatch(clean, /script|foreignObject|iframe|onload|href|https:\/\/evil/);
    assert.equal(main.querySelector('pre code')?.textContent, '<svg><text>Literal code</text></svg>\n');
    assert.match(main.textContent!, /Keep this explanation/);
    assert.equal(main.querySelector('svg, script, iframe'), null);
  } finally { dom.window.close(); }
});

test('Instructor preserves Git branch card positions and default left alignment', () => {
  const source = readFileSync(join(__dirname, '../../../../test/fixtures/git_branch_cards.svg'), 'utf8');
  const {dom, main} = render(source);
  try {
    const image = main.querySelector('img')!;
    assert.ok(image);
    const parser = new dom.window.DOMParser();
    const original = parser.parseFromString(source, 'image/svg+xml');
    const clean = parser.parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')), 'image/svg+xml');
    assert.equal(clean.documentElement.getAttribute('viewBox'), '0 0 640 420');
    for (const node of original.querySelectorAll('text, rect, path')) {
      const actual = clean.getElementById(node.id)!;
      assert.ok(actual, node.id);
      for (const attr of Array.from(node.attributes)) {
        assert.equal(actual.getAttribute(attr.name), attr.value, `${node.id}: ${attr.name}`);
      }
      if (node.localName === 'text') {
        assert.equal(actual.textContent, node.textContent);
        assert.equal(actual.getAttribute('text-anchor') ?? 'start', 'start');
      }
    }
    assert.match(image.alt, /main and increase-timeout/);
  } finally { dom.window.close(); }
});

test('Matplotlib cross-product charts preserve background, curves, labels, halos and local markers', () => {
  const svg = readFileSync(join(__dirname, '../../test/fixtures/vector-cross-product.svg'), 'utf8');
  const {dom, main} = render(svg);
  try {
    const image = main.querySelector('img')!;
    assert.ok(image);
    const clean = new dom.window.DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')), 'image/svg+xml');
    assert.equal(clean.querySelector('#patch_1 path')?.getAttribute('fill'), '#ffffff');
    const curve = clean.querySelector('path[stroke="#2563eb"]')!;
    assert.ok(curve, 'the authored curve must retain its stroke');
    assert.equal(curve.getAttribute('fill'), 'none');
    assert.ok(clean.querySelector('clipPath rect'));
    assert.ok(clean.querySelector('use[href^="#"]'), 'axis ticks and data markers survive');
    for (const text of clean.querySelectorAll('text')) {
      assert.ok(text.getAttribute('font-size'), 'font metrics cannot fall back to a different size');
      assert.equal(text.getAttribute('paint-order'), 'stroke fill', 'white halos stay behind the text');
      assert.ok(text.getAttribute('text-anchor'));
    }
    assert.match(image.alt, /Cross-product magnitude/);
    assert.equal(clean.querySelector('[style]:not(svg), script, foreignObject'), null);
  } finally { dom.window.close(); }
});

test('SVG styles and use references retain only safe local presentation', () => {
  const {dom, main} = render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 60">
    <defs><path id="tick" d="M0 0L0 4"/></defs>
    <use xlink:href="#tick" x="20" y="30" style="stroke:#123456"/>
    <use href="https://evil.test/remote.svg#tick"/><use xlink:href="javascript:evil()"/>
    <text x="5" y="20" style="font:italic 12px serif;fill:#123456;paint-order:stroke fill;stroke:#fff;stroke-width:2px;filter:url(https://evil.test/filter);cursor:url(https://evil.test/cursor),auto">A × B</text>
    <path d="M0 0L20 30" style="stroke:url(https://evil.test/paint);fill:url(data:image/svg+xml,evil)"/>
    <style>@import url(https://evil.test/style); text {fill:red}</style>
  </svg>`);
  try {
    const source = decodeURIComponent(main.querySelector('img')!.getAttribute('src')!);
    assert.match(source, /href="#tick"/);
    assert.match(source, /font-size="12px"/);
    assert.match(source, /font-style="italic"/);
    assert.match(source, /paint-order="stroke fill"/);
    assert.doesNotMatch(source, /evil|javascript|xlink:href|filter=|cursor=|<style/);
  } finally { dom.window.close(); }
});
