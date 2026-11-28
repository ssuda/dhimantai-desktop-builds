import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { diagram } from './diagram';
import { learningMath } from './learningMath';
import { imageMarkup } from './visual';
import { diagramBlock, diagramLanguage } from './diagramBlocks';

const markdown = new MarkdownIt({html: false, linkify: false, breaks: true});
learningMath(markdown);
markdown.renderer.rules.image = (tokens, i) => imageMarkup(tokens[i].attrGet('src'), markdown.utils.unescapeAll(tokens[i].content));
markdown.renderer.rules.link_open = () => '<span>';
markdown.renderer.rules.link_close = () => '</span>';

// Recognize board markup at Markdown block boundaries. Fenced/indented code
// and inline code examples remain literal, and general HTML stays disabled.
markdown.block.ruler.before('html_block', 'board_markup', (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = line(start);
  if (!/^<(?:svg\b|\/?details\b|summary\b)/i.test(first)) return false;
  if (silent) return true;
  let next = start + 1;
  const token = state.push('board_markup', '', 0);
  if (/^<svg\b/i.test(first)) {
    // Keep a malformed, unclosed diagram from swallowing the next explanation.
    while (next < end && !/<\/svg\s*>/i.test(line(next - 1))) {
      const following = line(next).trim();
      if (following && !following.startsWith('<') && !line(next - 1).trim()) break;
      next++;
    }
    token.content = state.getLines(start, next, state.blkIndent, false);
    token.meta = 'svg';
  } else {
    // A producer may put the opening details and summary on the same line,
    // or wrap the summary over several lines. Never copy tag attributes.
    let source = first;
    if (/<summary\b/i.test(first)) {
      while (!/<\/summary\s*>/i.test(source) && next < end && line(next).trim() && next - start < 8) {
        source += '\n' + line(next++);
      }
    }
    token.content = source;
  }
  state.line = next;
  return true;
}, {alt: ['paragraph', 'reference', 'blockquote']});

markdown.renderer.rules.board_markup = (tokens, i) => {
  const token = tokens[i];
  if (token.meta === 'svg') return diagram(token.content);
  const parts = token.content.split(/(<\/?(?:details|summary)\b[^>]*>)/ig);
  return parts.map(part => {
    if (/^<details\b/i.test(part)) return /^<details\s+open(?:\s|=|>)/i.test(part) ? '<details open>' : '<details>';
    if (/^<summary\b/i.test(part)) return '<summary>';
    if (/^<\/details\b/i.test(part)) return '</details>';
    if (/^<\/summary\b/i.test(part)) return '</summary>';
    return markdown.renderInline(part.replace(/<\/?(?:b|strong)>/gi, ''));
  }).join('') + '\n';
};
const fence = markdown.renderer.rules.fence!;
const svgFence = (token: Token) => ['', 'svg', 'xml'].includes(token.info.trim().toLowerCase())
  && /^\s*(?:<\?xml\b[^?]*\?>\s*)?<svg\b/i.test(token.content);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightCodeLine(line: string, lang: string): string {
  const escaped = escapeHtml(line);
  if (!['python', 'py', 'python3', 'javascript', 'js', 'typescript', 'ts', 'sql', 'bash', 'sh'].includes(lang)) {
    return escaped;
  }
  const pyKeywords = new Set([
    'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is',
    'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'with', 'pass', 'break',
    'continue', 'yield', 'lambda', 'True', 'False', 'None', 'raise', 'assert', 'async', 'await',
    'function', 'const', 'let', 'var', 'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE',
  ]);
  const pyBuiltins = new Set([
    'print', 'len', 'range', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple', 'input',
    'enumerate', 'zip', 'sum', 'min', 'max', 'sorted', 'type', 'isinstance', 'open', 'abs',
  ]);
  // Tokenize comments, strings, numbers, and identifiers in one pass to avoid nested spans.
  const tokenRe = /(#.*$|\/\/.*$|&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;|'(?:\\.|[^'])*?'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  return escaped.replace(tokenRe, (tok) => {
    if (tok.startsWith('#') || tok.startsWith('//')) return `<span class="tok-comment">${tok}</span>`;
    if (tok.startsWith('&quot;') || tok.startsWith("'")) return `<span class="tok-string">${tok}</span>`;
    if (/^\d/.test(tok)) return `<span class="tok-number">${tok}</span>`;
    if (pyKeywords.has(tok)) return `<span class="tok-keyword">${tok}</span>`;
    if (pyBuiltins.has(tok)) return `<span class="tok-builtin">${tok}</span>`;
    return tok;
  });
}

function renderStyledCodeBlock(code: string, info: string, expectedError?: string): string {
  const rawLang = info.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const langLabel = rawLang === 'py' || rawLang === 'python3' ? 'python' : rawLang;
  const displayLang = langLabel ? langLabel.charAt(0).toUpperCase() + langLabel.slice(1) : 'Code';
  const isPrediction = /\bprediction-only\b/.test(info);
  const isExplanation = /\bexplanation-only\b/.test(info);
  const readOnlyBadge = isPrediction ? 'Prediction only · not executable'
    : isExplanation ? 'Explanation only · not executable' : '';
  const hasTrailingNewline = /\r?\n$/.test(code);
  const trimmed = code.replace(/\r?\n$/, '');
  const lines = trimmed.split('\n');
  const lineNumsHtml = lines.map((_, idx) => `<span>${idx + 1}</span>`).join('');
  const codeHtml = lines.map(line => highlightCodeLine(line, langLabel)).join('\n') + (hasTrailingNewline ? '\n' : '');
  const errAttr = expectedError ? ` data-expected-error="${escapeHtml(expectedError)}"` : '';
  const classAttr = langLabel ? ` class="language-${escapeHtml(langLabel)}"` : '';
  const cardClass = readOnlyBadge ? 'code-block-card code-reading-only' : 'code-block-card';
  return `<div class="${cardClass}" data-code-lang="${escapeHtml(langLabel || 'text')}">`
    + `<div class="code-block-header"><span class="code-block-lang">${escapeHtml(displayLang)}</span>`
    + (readOnlyBadge ? `<small class="code-block-badge">${readOnlyBadge}</small>` : '')
    + `<button type="button" class="quiet code-copy-btn" data-copy-code aria-label="Copy code">Copy</button></div>`
    + `<div class="code-block-body"><div class="code-line-nums" aria-hidden="true">${lineNumsHtml}</div>`
    + `<pre><code${classAttr}${errAttr}>${codeHtml}</code></pre></div></div>\n`;
}

markdown.renderer.rules.fence = (tokens, i, options, env, renderer) => {
  const token = tokens[i];
  const language = diagramLanguage(token.info, token.content);
  if (language) return diagramBlock(language, token.content);
  if (svgFence(token)) return diagram(token.content);
  const expected = token.info.trim().match(/^\S+\s+expected-error=([A-Z]\w{0,60})$/);
  return renderStyledCodeBlock(token.content, token.info, expected?.[1]);
};
const codeBlock = markdown.renderer.rules.code_block!;
markdown.renderer.rules.code_block = (tokens, i, options, env, renderer) => {
  const language = diagramLanguage('', tokens[i].content);
  return language ? diagramBlock(language, tokens[i].content) : codeBlock(tokens, i, options, env, renderer);
};
// Some Instructor replies omit the code fence. Stop at a blank line so the
// following explanation stays ordinary Markdown. Programming-language fences stay literal.
markdown.block.ruler.before('paragraph', 'text_diagram', (state, start, end, silent) => {
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  const language = diagramLanguage('', first);
  if (!language) return false;
  if (silent) return true;
  let next = start + 1;
  while (next < end && !state.isEmpty(next)) next++;
  const token = state.push('text_diagram', '', 0);
  token.content = state.getLines(start, next, state.blkIndent, false); token.meta = language;
  state.line = next;
  return true;
}, {alt:['paragraph', 'reference', 'blockquote']});
markdown.renderer.rules.text_diagram = (tokens, i) => diagramBlock(tokens[i].meta, tokens[i].content);

export const renderBoard = (text: string) => markdown.render(text);
export const renderHeading = (text: string) => markdown.renderInline(text);

/** Keep older unfurled examples usable alongside the concise answer. Editors mount inside these disclosures. */
export function foldDoubtCode(body: HTMLElement) {
  if (!body.querySelector(':scope > p, :scope > ul, :scope > ol')) return;
  for (const pre of body.querySelectorAll<HTMLElement>(':scope > pre, :scope > .code-block-card')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = code.className.startsWith('language-') ? 'Code example' : 'Code or output';
    pre.replaceWith(details); details.append(summary, pre);
  }
}

/** Compact previews use parsed text so code and literal punctuation stay intact. */
export function markdownPlainText(text: string): string {
  const plain = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === 'text_diagram' || (['fence', 'code_block'].includes(token.type) && diagramLanguage(token.info, token.content))) return 'Diagram ';
    if (token.type === 'board_markup') return token.meta === 'svg' ? 'Diagram ' : ' ';
    if (token.type === 'fence' && svgFence(token)) return 'Diagram ';
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    const content = token.children ? plain(token.children) : token.content;
    return content + (token.block ? ' ' : '');
  }).join('');
  return plain(markdown.parse(text, {}))
    // Inline/escaped SVG and literal code may also reach a compact reply preview.
    // Keep ordinary code intact, but never put a diagram's source in the message bar.
    .replace(/(?:<\?xml\b[^?]*\?>\s*)?<svg\b[\s\S]*?(?:<\/svg\s*>|$)/gi, 'Diagram ')
    .replace(/\s+/g, ' ').trim();
}
