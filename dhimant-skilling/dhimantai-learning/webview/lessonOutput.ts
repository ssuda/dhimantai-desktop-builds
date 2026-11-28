import { cellLanguage, type CodeSnapshot } from '../src/roomCode';

/** Quote the call as written. An expression may read variables from earlier cells. */
function exampleCall(source: string) {
  const last = source.trimEnd().split('\n').at(-1) ?? '';
  return last.match(/^([\w.]+\(.*\))\s*;?\s*(?:#.*)?$/)?.[1] ?? '';
}

export function runInputs(snapshot: CodeSnapshot) {
  const parts = [exampleCall(snapshot.source)];
  if (snapshot.stdin) parts.push('stdin ' + JSON.stringify(snapshot.stdin));
  if (snapshot.argv?.length) parts.push('args ' + JSON.stringify(snapshot.argv));
  if (snapshot.files?.length) parts.push('files ' + snapshot.files.map(file => file.name).join(', '));
  return parts.filter(Boolean).map(text => text.length > 160 ? text.slice(0, 159) + '…' : text).join(' · ');
}

/** Older Instructor boards label an expected exception beside the runnable example. */
function expectedException(block: Element, code: Element) {
  const tag = code.getAttribute('data-expected-error');
  if (tag) return tag;
  const host = block.closest('.code-block-card') ?? block;
  const previous = host.previousElementSibling, next = host.nextElementSibling;
  const prose = (el: Element | null) => el?.matches('p,h3,h4') ? el.textContent?.trim() ?? '' : '';
  const before = prose(previous), after = prose(next);
  // A caption between two runnable cells introduces the next one if it ends in a colon.
  const intro = (previous?.previousElementSibling?.matches('pre, .code-block-card')) && !before.endsWith(':') ? '' : before;
  const caption = (next?.nextElementSibling?.matches('pre, .code-block-card')) && after.endsWith(':') ? '' : after;
  const predicts = /\b(?:[Ee]xpected (?:error|exception)(?: is)?\s*[:—-]?|(?:[Tt]his (?:code|example|cell|call|line|version)|[Ii]t) (?:intentionally |deliberately |will )?(?:raises?|throws?))\s+(?:an? )?([A-Z]\w*(?:Error|Exception))\b/;
  const expectedOutput = next?.querySelector('code.language-output') ??
    (/^(?:(?:predicted|expected|sample|example) )?(?:output|result)\b/i.test(after) ?
      next?.nextElementSibling?.querySelector('code.language-output, code.language-text') : null);
  return caption.match(predicts)?.[1] ?? intro.match(predicts)?.[1]
    ?? expectedOutput?.textContent?.trim().match(/(?:^|\n)([A-Z]\w*(?:Error|Exception)):/)?.[1];
}

/** Bind a printed example to the authored cell before it becomes editable. */
export function labelLessonOutputs(body: HTMLElement) {
  const calls = new Map<Element, string>();
  for (const block of body.querySelectorAll('pre,p,h1,h2,h3,h4,h5,h6')) {
    const host = block.closest('.code-block-card') ?? block;
    const parent = host.parentElement!;
    const code = block.matches('pre') ? block.querySelector('code') : null;
    const language = code?.className.match(/\blanguage-(\S+)/)?.[1] ?? '';
    if (code && cellLanguage(language)) {
      const expected = expectedException(block, code);
      if (expected) block.setAttribute('data-demo-error', expected);
      calls.set(parent, exampleCall(code.textContent ?? ''));
      continue;
    }
    const wording = block.textContent?.trim() ?? '';
    const heading = !code && /^(?:(?:predicted|expected|sample|example) (?:output|result)|output)(?:\s*$|\s*[:(—-]|\s+for\b)/i.test(wording);
    if (!heading && !(language === 'output' && !host.previousElementSibling?.classList.contains('lesson-output-heading'))) continue;
    const label = document.createElement('strong');
    label.className = 'lesson-output-label';
    const call = heading && /\bfor\b/i.test(wording) ? '' : calls.get(parent);
    label.textContent = 'Instructor example' + (call ? ' · ' + call.slice(0, 160) : '');
    host.before(label);
    block.classList.add('lesson-output-heading');
  }
}
