import { renderBoard } from './markdown';

export function showStudyResponse(root: HTMLElement, content: string, summary: boolean, question = false) {
  root.innerHTML = renderBoard(content);
  const prompts = Array.from(root.querySelectorAll<HTMLElement>(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'))
    .filter(heading => /^(Your turn|Practice)\b/i.test(heading.textContent?.trim() ?? ''));
  const wholeCard = question && !prompts.length;
  if (wholeCard) {
    const heading = document.createElement('h2'); heading.textContent = 'Your turn';
    root.prepend(heading); prompts.push(heading);
  }
  for (const heading of prompts) {
    const section = document.createElement('section'); section.className = 'study-your-turn';
    section.setAttribute('aria-label', 'Your turn');
    // Keep the complete task (including code/options), without swallowing the
    // next teaching section. This marker is authored content, never a transcript.
    const level = Number(heading.tagName.slice(1));
    heading.before(section); section.append(heading);
    if (!/^Your turn\b/i.test(heading.textContent?.trim() ?? '')) heading.textContent = heading.textContent!.trim().replace(/^Practice\b/i, 'Your turn');
    heading.classList.add('study-turn-marker');
    while (section.nextSibling) {
      const next = section.nextSibling;
      if (!wholeCard && next instanceof HTMLElement && /^H[1-6]$/.test(next.tagName) && Number(next.tagName.slice(1)) <= level) break;
      section.append(next);
    }
  }
  if (!summary) return;
  // Leave an overview visible and let readers fold the remaining sections.
  const headings = root.querySelectorAll(':scope > h2, :scope > h3');
  if (headings.length < 2) return;
  const level = Math.min(...Array.from(headings, heading => Number(heading.tagName.slice(1))));
  let section: HTMLDetailsElement | undefined;
  for (const node of Array.from(root.childNodes)) {
    if (node instanceof HTMLElement && node.tagName === `H${level}`) {
      section = document.createElement('details'); section.className = 'summary-section'; section.open = true;
      const title = document.createElement('summary'); title.innerHTML = node.innerHTML;
      node.replaceWith(section); section.append(title);
    } else if (section) section.append(node);
  }
}
