import MarkdownIt from 'markdown-it';
import { diagram } from './diagram';
import { learningMath } from './learningMath';
import { imageMarkup } from './visual';

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
markdown.renderer.rules.fence = (tokens, i, options, env, renderer) => {
  const token = tokens[i];
  return token.info.trim().toLowerCase() === 'svg' && /^\s*<svg\b/i.test(token.content)
    ? diagram(token.content) : fence(tokens, i, options, env, renderer);
};

export const renderBoard = (text: string) => markdown.render(text);
export const renderHeading = (text: string) => markdown.renderInline(text);
