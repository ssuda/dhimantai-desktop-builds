import type MarkdownIt from 'markdown-it';
import math from '@vscode/markdown-it-katex';
import katex from 'katex';

/** Shared math delimiters and safe fallback for reading and every learning mode. */
export function learningMath(markdown: MarkdownIt) {
  markdown.use(math, {trust: false, maxExpand: 500});
  // Match Flutter's markdown.dart delimiters without replacing text inside code.
  // These parser rules run only where Markdown permits content, before its escape
  // rule can consume the backslash in \(...\) or \[...\].
  markdown.inline.ruler.before('escape', 'learning_math', (state, silent) => {
    const open = state.src.slice(state.pos, state.pos + 2);
    if (open !== '\\(' && open !== '\\[') return false;
    const close = open === '\\(' ? '\\)' : '\\]';
    const end = state.src.indexOf(close, state.pos + 2);
    if (end < 0) return false;
    const body = state.src.slice(state.pos + 2, end);
    if (!body.trim() || body.includes('\n\n')) return false;
    if (!silent) {
      const token = state.push(open === '\\(' ? 'math_inline' : 'math_inline_block', 'math', 0);
      token.content = body;
    }
    state.pos = end + 2;
    return true;
  });
  markdown.block.ruler.before('fence', 'learning_display_math', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
    if (!line(start).startsWith('\\[')) return false;
    let next = start;
    while (next < end && !line(next).includes('\\]')) next++;
    if (next === end || !line(next).trimEnd().endsWith('\\]')) return false;
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = state.getLines(start, next + 1, state.blkIndent, false).trim().slice(2, -2);
    token.map = [start, next + 1];
    state.line = next + 1;
    return true;
  }, {alt: ['paragraph', 'reference', 'blockquote', 'list']});

  // As in Flutter, preserve an unsupported expression as neutral body text.
  // Never expose parser errors or let TeX create links, images or trusted HTML.
  for (const type of ['math_inline', 'math_inline_block', 'math_block']) {
    markdown.renderer.rules[type] = (tokens, i) => {
      const text = tokens[i].content;
      try {
        return katex.renderToString(text, {displayMode: type !== 'math_inline',
          throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500});
      } catch {
        return `<span class="math-fallback">${markdown.utils.escapeHtml(text)}</span>`;
      }
    };
  }
}
