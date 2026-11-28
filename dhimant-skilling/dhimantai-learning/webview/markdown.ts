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
markdown.renderer.rules.fence = (tokens, i, options, env, renderer) => {
  const token = tokens[i];
  const language = diagramLanguage(token.info, token.content);
  if (language) return diagramBlock(language, token.content);
  if(/\b(?:prediction-only|explanation-only)\b/.test(token.info)) {
    const kind=token.info.includes('prediction-only')?'Prediction only':'Explanation only';
    return '<div class="code-reading-only"><small>'+kind+' · not executable</small>'+fence(tokens,i,options,env,renderer)+'</div>';
  }
  const expected = token.info.trim().match(/^\S+\s+expected-error=([A-Z]\w{0,60})$/);
  if (expected) token.attrSet('data-expected-error', expected[1]);
  return svgFence(token) ? diagram(token.content) : fence(tokens, i, options, env, renderer);
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
