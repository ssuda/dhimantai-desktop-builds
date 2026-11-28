import type { Chapter, Course } from './api';
import { ERP_COURSE } from './browserCourseProgress';
import { accessLabel, resumeTopic, type LearnerCourse } from './catalogDiscovery';
import { categoryHue, escape, sectionOf } from './catalogLayout';
import { categoryCardStyles } from './catalogStyles';
import { courseCoverage, coverageLabel, nextChapter } from './courseProgress';
import { progressBar, UI_TOKENS } from './uiTheme';

export type LearnerPage = 'myCourses' | 'practicePage';
export const pageTitles = {myCourses:'My courses', practicePage:'Practice'};
export interface LearnerPageData {
  courses: LearnerCourse[];
  courseError?: string;
  progress: string;
  notebooks?: {id: string; title: string}[];
  certificates?: string[];
}

export function suggestedChapter(course: Course) {
  const accessible = (chapter: Chapter) => !chapter.locked && !chapter.expired;
  return nextChapter(course.chapters, accessible) ?? course.chapters.find(accessible);
}

const button = (action: string, label: string, chapter = '', primary = false) =>
  `<button type="button" data-action="${action}" data-chapter="${escape(chapter)}"${primary ? ' class="primary"' : ''}>${escape(label)}</button>`;

function courseCard(course: LearnerCourse, practice: boolean) {
  const chapters = course.chapters, next = suggestedChapter(course);
  const done = chapters.filter(ch => ch.progress?.status === 'covered').length;
  const coverage = courseCoverage(chapters);
  const category = course.catalog && sectionOf(course.catalog);
  const topic = resumeTopic(course, next?.id);
  const number = next ? chapters.indexOf(next) + 1 : 0;
  const nextTitle = (next?.lesson || next?.name || '').replace(new RegExp('^chapter\\s+' + number + '\\s*[:.·–—-]\\s*','i'),'');
  const verb = next?.progress?.status === 'content_changed' ? 'Start updated' : next?.progress?.status === 'covered' ? 'Review'
    : next?.progress?.status === 'in_progress' ? 'Resume' : 'Start';
  const outline = `<details><summary>${practice ? 'Chapters' : 'Outline'}</summary><ol>${chapters.map(ch =>
    `<li>${ch.expired || ch.locked ? escape(ch.lesson || ch.name) + ' · Locked' : button(practice ? 'exercise' : 'lesson', ch.lesson || ch.name, ch.id)}
    <small>${escape(coverageLabel(ch.progress))}</small></li>`).join('')}</ol></details>`;
  return `<article class="course-card" data-category-card data-hue="${category ? categoryHue(category) : 260}" data-course="${escape(course.name)}" data-complete="${chapters.length > 0 && done === chapters.length}">
    ${course.catalog ? `<div class="meta"><strong>${escape(category!)}</strong> ${escape(course.catalog.level)} · ${escape(accessLabel(course.catalog))}</div>` : ''}
    <h2>${escape(course.name)}</h2>
    ${next ? `<p><b>${practice ? 'Next practice' : 'Up next'}</b> · Chapter ${number} · ${escape(nextTitle)}</p>${topic ? `<small>Next topic · ${escape(topic)}</small>` : ''}` : course.outlineUnavailable ? '<p>The course syllabus is currently unavailable.</p>' : '<p>No accessible chapters.</p>'}
    ${coverage && coverage !== 'Progress unavailable' ? progressBar(done, chapters.length, coverage) + '<small>' + escape(coverage) + '</small>'
      : '<small>Chapter progress unavailable</small>'}
    <div class="actions">${next ? practice ? button('exercise','Open practice',next.id,true)
      : button(course.name === ERP_COURSE ? 'tour' : 'lesson', course.name === ERP_COURSE ? 'Open guided tour' : verb + ' chapter ' + number,next.id,true) + button('exercise','Practice',next.id)
      : button('catalog','Browse catalog')}${chapters.length ? outline : ''}</div></article>`;
}

export function learnerPageHtml(page: LearnerPage, nonce: string, revision: number, data?: LearnerPageData, notice = '', signedOut = false, scope = '') {
  const practice = page === 'practicePage', title = pageTitles[page];
  const courses = data?.courses ?? [];
  const first = courses.find(c => suggestedChapter(c));
  const complete = courses.filter(c => c.chapters.length && c.chapters.every(ch => ch.progress?.status === 'covered')).length;
  const cards = courses.map(c => courseCard(c, practice)).join('');
  const resourceList = (items: string[] | undefined, empty: string) => items === undefined ? '<p>Currently unavailable.</p>'
    : items.length ? '<ul>' + items.slice(0,3).map(item => '<li>' + item + '</li>').join('') + '</ul>' : `<p>${empty}</p>`;
  const resources = data ? `<aside><section><h2>Saved practice notebooks</h2>${resourceList(data.notebooks?.map(n =>
    `<button class="link" data-action="notebook" data-id="${escape(n.id)}">${escape(n.title)}</button>`), 'Your saved practice notebooks will appear here.')}
    ${button('history','Open notebooks')}</section><section><h2>My certificates</h2>${resourceList(data.certificates?.map(escape),'Your earned certificates will appear here.')}
    ${button('certificates','View certificates')}</section><section><h2>Course files</h2>${button('files','Open course tree')}</section></aside>` : '';
  const empty = data?.courseError ? '' : `<p>No courses yet.</p>${button('catalog','Browse catalog')}`;
  const hues = new Set(courses.map(c => c.catalog ? categoryHue(sectionOf(c.catalog)) : 260));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><title>${title}</title>
  <style nonce="${nonce}">${UI_TOKENS}
  *{box-sizing:border-box}body{--paper:var(--vscode-editorWidget-background,var(--vscode-editor-background));--line:var(--vscode-panel-border,var(--dh-border));color:var(--vscode-foreground);background:var(--vscode-editor-background);font: max(14px,var(--vscode-font-size,13px))/1.5 var(--vscode-font-family,system-ui);max-width:1200px;margin:auto;padding:clamp(16px,4vw,48px);overflow-wrap:anywhere}
  h1,h2,p,ol,ul{margin:0}h1{font-size:clamp(28px,4vw,42px);line-height:1.15;letter-spacing:-.035em}h2{font-size:1.2em}small{display:block}
  header,nav,.actions,.banner{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header,.banner{justify-content:space-between;margin-bottom:18px}nav{margin-bottom:16px}
  button,summary{font:inherit;cursor:pointer;color:inherit}button{padding:6px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper)}
  button.primary,button[aria-pressed=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--dh-button-border)}
  button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
  .cards,aside{display:grid;gap:12px;align-content:start}.course-card,aside section,.banner{min-width:0;padding:16px;border:1px solid var(--line);border-radius:12px}
  .course-card{display:flex;flex-direction:column;gap:6px}.course-card .actions{margin-top:auto;padding-top:6px}.meta{font-size:.85em}.meta strong{margin-right:6px}
  .dh-progress{margin-top:4px;--vscode-progressBar-background:var(--accent)}.practice-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,28%);gap:18px}
  .practice-layout .cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}.practice-layout h2.section-title{margin:0 0 10px}
  aside section,.banner{background:var(--paper)}aside section>*+*{margin-top:8px}ul,ol{padding-inline-start:20px}
  details[open]{flex:1 0 100%}details button,.link{background:transparent;color:var(--vscode-textLink-foreground);padding:3px 0;border:0;text-align:left}
  details li{padding:4px 0}[hidden]{display:none!important}@media(max-width:680px){.practice-layout{grid-template-columns:1fr}}
  ${categoryCardStyles}${[...hues].map(hue => `[data-hue="${hue}"]{--hue:${hue}}`).join('')}
  </style></head><body data-scope="${escape(scope)}"><header><h1>${title}</h1><div class="actions">${practice && data ? button('split','Open in split') : ''}${button('refresh','Refresh')}${practice ? '' : button('catalog','Browse catalog')}</div></header>
  ${notice ? `<p role="status">${escape(notice)}</p>` : ''}${signedOut ? button('signIn','Sign in') : ''}
  ${data?.courseError ? `<p role="alert">${escape(data.courseError)}</p>` : ''}
  ${data ? practice ? `<div class="banner"><div><strong>${escape(data.progress)}</strong>${first ? '<p>Practise the next chapter in ' + escape(first.name) + '.</p>' : ''}</div>
    ${first ? `<div data-course="${escape(first.name)}">${button('exercise',data.progress === 'No problems solved yet' ? 'Start first practice' : 'Continue practice',suggestedChapter(first)!.id,true)}</div>` : ''}</div>
    <div class="practice-layout"><section><h2 class="section-title">Practice by course</h2><div class="cards">${cards || empty}</div></section>${resources}</div>`
    : `<nav aria-label="Course progress"><button data-filter="false" aria-pressed="true">In progress · ${courses.length - complete}</button><button data-filter="true" aria-pressed="false">Completed · ${complete}</button>${button('certificates','Certificates')}</nav>
    <div class="cards">${cards || empty}</div>${courses.length ? '<p id="no-matches" hidden></p>' : ''}` : ''}
  <script nonce="${nonce}">const api=acquireVsCodeApi();const scope=document.body.dataset.scope;
  function filter(value){if(!document.querySelector('[data-filter]'))return;for(const item of document.querySelectorAll('[data-filter]'))item.setAttribute('aria-pressed',String(item.dataset.filter===value));
    for(const card of document.querySelectorAll('[data-complete]'))card.hidden=card.dataset.complete!==value;
    const empty=document.getElementById('no-matches');if(empty){empty.hidden=!!document.querySelector('[data-complete]:not([hidden])');empty.textContent=value==='true'?'No completed courses yet.':'No courses in progress.';}}
  const saved=api.getState();if(saved?.scope===scope && saved.filter==='true')filter('true');else filter('false');
  document.addEventListener('click',event=>{const el=event.target.closest('button');if(!el)return;
    if(el.dataset.filter){filter(el.dataset.filter);api.setState({scope,filter:el.dataset.filter});}
    else api.postMessage({action:el.dataset.action,course:el.closest('[data-course]')?.dataset.course,chapter:el.dataset.chapter,id:el.dataset.id,revision:${revision}});});
  </script></body></html>`;
}
