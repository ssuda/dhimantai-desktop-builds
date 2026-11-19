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

/** Bind a printed example to the authored cell before it becomes editable. */
export function labelLessonOutputs(body: HTMLElement) {
  const calls = new Map<Element, string>();
  for (const block of body.querySelectorAll('pre,p,h1,h2,h3,h4,h5,h6')) {
    const parent = block.parentElement!;
    const code = block.matches('pre') ? block.querySelector('code') : null;
    const language = code?.className.match(/\blanguage-(\S+)/)?.[1] ?? '';
    if (code && cellLanguage(language)) {
      calls.set(parent, exampleCall(code.textContent ?? ''));
      continue;
    }
    const wording = block.textContent?.trim() ?? '';
    const heading = !code && /^(?:(?:predicted|expected|sample|example) (?:output|result)|output)(?:\s*$|\s*[:(—-]|\s+for\b)/i.test(wording);
    if (!heading && !(language === 'output' && !block.previousElementSibling?.classList.contains('lesson-output-heading'))) continue;
    const label = document.createElement('strong');
    label.className = 'lesson-output-label';
    const call = heading && /\bfor\b/i.test(wording) ? '' : calls.get(parent);
    label.textContent = 'Instructor example' + (call ? ' · ' + call.slice(0, 160) : '');
    block.before(label);
    block.classList.add('lesson-output-heading');
  }
}
