import { renderBoard } from './markdown';

export function showStudyResponse(root: HTMLElement, content: string, summary: boolean) {
  root.innerHTML = renderBoard(content);
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
