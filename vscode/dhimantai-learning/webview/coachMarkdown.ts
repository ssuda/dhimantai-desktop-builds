import MarkdownIt from 'markdown-it';
import { learningMath } from './learningMath';
import 'katex/dist/katex.min.css';
import { diagram } from './diagram';

// Exercise content and AI replies are untrusted. Keep code literal and disable
// HTML, remote images and navigation (including command: links) in Instructor.
const markdown = new MarkdownIt({html: false, linkify: false, breaks: true});
learningMath(markdown);

// Only SVG blocks cross the static-image sanitizer. General HTML stays disabled.
markdown.block.ruler.before('html_block', 'coach_diagram', (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  if (!/^<svg\b/i.test(line(start))) return false;
  let next = start;
  while (next < end && !/<\/svg\s*>\s*$/i.test(line(next))) {
    if (next > start && !line(next).trim()) return false;
    next++;
  }
  if (next === end) return false;
  if (silent) return true;
  const token = state.push('coach_diagram', '', 0);
  token.content = state.getLines(start, next + 1, state.blkIndent, false);
  state.line = next + 1;
  return true;
}, {alt: ['paragraph', 'reference', 'blockquote', 'list']});
markdown.renderer.rules.coach_diagram = (tokens, i) => diagram(tokens[i].content);
const fence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, i, options, env, renderer) => {
  const token = tokens[i];
  return token.info.trim().toLowerCase() === 'svg' && /^\s*<svg\b/i.test(token.content)
    ? diagram(token.content) : fence(tokens, i, options, env, renderer);
};

markdown.renderer.rules.image = (tokens, i) => markdown.utils.escapeHtml(tokens[i].content);
markdown.renderer.rules.link_open = () => '<span>';
markdown.renderer.rules.link_close = () => '</span>';
const render = (text: string) => markdown.render(text);
(window as unknown as {CoachMarkdown: {render: typeof render}}).CoachMarkdown = {render};
