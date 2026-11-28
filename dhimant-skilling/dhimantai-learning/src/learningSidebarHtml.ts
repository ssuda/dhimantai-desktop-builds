import type { Chapter, Course } from './api';
import { ERP_COURSE } from './browserCourseProgress';
import { nextChapter, compareCourseActivity } from './courseProgress';
import { escape, icon } from './gradeComponents';
import { progressBar, UI_TOKENS } from './uiTheme';

export const destinations = [
  {group:'Learn', key:'courses', label:'Courses', glyph:'book', command:'dhimantai.courseCatalog'},
  {group:'Learn', key:'mine', label:'My courses', glyph:'layers', command:'dhimantai.myCourses'},
  {group:'Learn', key:'certificates', label:'My certificates', glyph:'medal', command:'dhimantai.courseGrade'},
  {group:'Learn', key:'practice', label:'Practice', glyph:'target', command:'dhimantai.practicePage'},
  {group:'Learn', key:'instructor', label:'Instructor', glyph:'book', command:'dhimantai.openLearningRoom'},
  {group:'Learn', key:'studio', label:'Project Mentor', glyph:'layers', command:'dhimantai.openProjectMentor'},
  {group:'Learn', key:'doubt', label:'Doubt Solver', glyph:'help', command:'dhimantai.openDoubtSolver'},
  {group:'Tools', key:'git', label:'Git & GitHub', glyph:'branch', command:'dhimantai.gitHub'},
] as const;

export interface SidebarLesson {course?: string; lesson?: string}
export function sidebarResume(courses: Course[], active: SidebarLesson) {
  const accessible = (ch: Chapter) => !ch.locked && !ch.expired;
  const available = courses.filter(c => c.chapters.some(accessible)).sort(compareCourseActivity);
  const course = available.find(c => c.name === active.course) ?? available[0];
  if (!course) return;
  const chapter = course.chapters.find(ch => ch.id === active.lesson && course.name === active.course && accessible(ch))
    ?? nextChapter(course.chapters,accessible) ?? course.chapters.find(accessible)!;
  const known = course.chapters.every(ch => ch.progress && ch.progress.status !== 'unavailable');
  return {course:course.name, chapter:chapter.id, title:chapter.lesson || chapter.name,
    number:course.chapters.indexOf(chapter)+1, total:course.chapters.length,
    covered:known ? course.chapters.filter(ch => ch.progress?.status === 'covered').length : undefined};
}

export function resumeCard(resume: ReturnType<typeof sidebarResume>, revision: number, fallback: string, action?: 'courses' | 'retry') {
  return `<article class="resume"><h2>Continue learning</h2>${resume
    ? `<strong>${escape(resume.course)}</strong><p>${resume.course === ERP_COURSE ? 'Continue your guided ERPNext tasks' : `Chapter ${resume.number} · ${escape(resume.title)}`}</p>
      ${resume.covered === undefined ? '' : progressBar(resume.covered,resume.total,`${resume.covered} of ${resume.total} chapters taught`)}
      <div class="resume-actions"><small>${resume.covered === undefined ? 'Coverage unavailable' : `${resume.covered} of ${resume.total} chapters taught`}</small>
      <button data-key="resume" data-revision="${revision}">▷ &nbsp;Resume</button></div>`
    : `<p>${escape(fallback)}</p>${action ? `<button data-key="${action}">${action === 'retry' ? 'Try again' : 'Browse courses'}</button>` : ''}`}</article>`;
}

export function sidebarHtml(nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <title>Learning navigation</title><style nonce="${nonce}">${UI_TOKENS}
  *{box-sizing:border-box}body{--surface:var(--vscode-sideBar-background,var(--vscode-editor-background));--ink:var(--vscode-sideBar-foreground,var(--vscode-foreground));--line:var(--vscode-contrastBorder,color-mix(in srgb,var(--ink) 18%,var(--surface)));--card:var(--vscode-editor-background);--nav-accent:var(--vscode-textLink-foreground,#175d91);--lit:40%;
    color:var(--ink);background:var(--surface);margin:0;padding:0;font:var(--vscode-font-size,13px)/1.4 var(--vscode-font-family,sans-serif);display:flex;flex-direction:column;min-height:100vh;overflow-wrap:anywhere}
  body:is(.vscode-dark,.vscode-high-contrast){--nav-accent:var(--vscode-textLink-foreground,#7bc9fa);--lit:76%}
  footer,.resume-actions,.nav-row,.file-row{display:flex;align-items:center;gap:8px}
  #environment,.count{font-size:.83em;border:1px solid var(--line);border-radius:20px;padding:1px 7px;margin-left:auto}
  main{padding:0 8px;display:flex;flex-direction:column;flex:1}button{font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;text-align:left}
  button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
  p,h2{margin:0}h2,.project>summary{font-size:.81em;letter-spacing:.075em;text-transform:uppercase;font-weight:600;color:var(--dh-muted)}
  .resume{border:1px solid var(--line);border-left:4px solid var(--nav-accent);background:var(--card);border-radius:10px;padding:11px 12px;margin:0 1px 12px}
  .resume h2{color:var(--nav-accent);margin-bottom:4px}.resume strong{display:block;font-size:1.1em}.resume p,.resume small,footer small{color:var(--dh-muted)}.resume p{margin:2px 0 6px}
  .resume-actions{margin-top:8px;justify-content:space-between;flex-wrap:wrap}.resume button{background:var(--nav-accent);color:var(--card);border-radius:5px;padding:4px 10px}
  .resume progress{--vscode-progressBar-background:var(--nav-accent);height:4px}
  nav section{margin-bottom:9px}nav h2{padding:5px 8px}
  .nav-row,.file-row{width:100%;padding:4px 7px;border-radius:7px}.nav-row:hover,.file-row:hover{background:var(--vscode-list-hoverBackground)}
  .nav-row[aria-current=page]{background:color-mix(in srgb,var(--nav-accent) 12%,var(--surface));box-shadow:inset 3px 0 var(--nav-accent);font-weight:600}
  .nav-icon{--color:oklch(var(--lit) .13 var(--hue));color:var(--color);background:color-mix(in srgb,var(--color) 12%,var(--surface));width:26px;height:26px;display:grid;place-items:center;border-radius:7px;flex:none}
  .certificate-icon{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
  [data-key=courses]{--hue:285}[data-key=mine]{--hue:150}[data-key=certificates]{--hue:68}[data-key=instructor]{--hue:255}[data-key=doubt]{--hue:345}[data-key=practice]{--hue:195}[data-key=studio]{--hue:34}[data-key=git]{--hue:240}
  #workspace{margin-top:auto}.project{border-top:1px solid var(--line);padding:9px 0}.project>summary{cursor:pointer;padding:4px}
  .project-box{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:9px}.project-box h3{font-size:1em;margin:0 0 4px}
  .files{max-height:24vh;min-height:28px;overflow:auto}.file-row{font-size:.94em}.file-row svg{color:var(--dh-muted)}[hidden]{display:none!important}
  footer{margin-top:3px;padding:9px 10px;border-top:1px solid var(--line);background:var(--surface)}footer button{display:flex;align-items:center;gap:9px;width:100%;padding:0}footer small{display:block}.avatar{border-radius:50%;width:29px;height:29px;display:grid;place-items:center;background:var(--nav-accent);color:var(--card);flex:none;font-weight:600}
  main { padding-top:6px; }
  .resume { border-radius:12px; border-inline-start:0; padding:14px; }
  body.vscode-light .resume, body.vscode-dark .resume {background:#172a42;color:#f8fafc;border-color:#263c55}
  body:is(.vscode-light,.vscode-dark) .resume h2 {color:#ffc091}
  body:is(.vscode-light,.vscode-dark) .resume :is(p,small) {color:#d5dde8}
  body:is(.vscode-light,.vscode-dark) .resume button {background:#ff914d;color:#201007;border-radius:20px;padding:5px 11px;font-weight:650}
  body:is(.vscode-light,.vscode-dark) .resume progress {--vscode-progressBar-background:#ff914d}
  .nav-row {min-height:36px;gap:10px}
  nav section {margin-bottom:12px}
  nav h2 {letter-spacing:.1em}
  </style></head><body>
  <main><div id="continue"></div><nav aria-label="Learning destinations">${['Learn','Tools'].map(group=>`<section><h2>${group}</h2>
  ${destinations.filter(item=>item.group===group).map(item=>`<button class="nav-row" data-key="${item.key}"${item.key==='mine' || item.key==='certificates' ? ' data-account-only hidden' : ''}><span class="nav-icon">${icon(item.glyph)}</span>${item.label}${item.key==='mine' ? '<span class="count" hidden></span>' : ''}</button>`).join('')}</section>`).join('')}</nav>
  <div id="workspace"></div></main><footer><div id="account"></div><small id="environment" hidden></small></footer>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();let state=vscode.getState()||{};
    function selected(key){for(const b of document.querySelectorAll('.nav-row')){if(b.dataset.key===key)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}}
    window.addEventListener('message',({data})=>{
      if(data.type==='learner'){
        const environment=document.getElementById('environment');environment.textContent=data.environment;environment.hidden=data.environment==='production';
        document.getElementById('account').innerHTML=data.account;
        for(const item of document.querySelectorAll('[data-account-only]'))item.hidden=!data.signedIn;
        document.getElementById('continue').innerHTML=data.resume;
        const badge=document.querySelector('.count');badge.hidden=data.count===undefined;badge.textContent=data.count??'';
      } else if(data.type==='workspace'){
        const el=document.getElementById('workspace');el.innerHTML=data.html;
        const project=el.querySelector('details');if(project){project.open=state.projectOpen!==false;project.addEventListener('toggle',()=>{state.projectOpen=project.open;vscode.setState(state);});}
      } else if(data.type==='selected')selected(data.key);
    });
    document.addEventListener('click',e=>{const b=e.target.closest('button[data-key]');if(b)vscode.postMessage({key:b.dataset.key,id:b.dataset.id,revision:Number(b.dataset.revision)});});
    vscode.postMessage({key:'ready'});</script></body></html>`;
}
