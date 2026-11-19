import { skillingHtml, SkillingPathway } from './skilling';
import type { CourseCertificate, CourseGrade } from './courseworkProgress';
import { CertificateCourse, certificateStatus } from './certificateDashboard';
import { progressBar, UI_TOKENS } from './uiTheme';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function courseGradeHtml(nonce: string, grade: CourseGrade | undefined, certificates: CourseCertificate[], notice: string, pending: number, busy = false, library = false, learning?:SkillingPathway, scope='', courses: CertificateCourse[] = []) {
  const button = (text: string, action: string, id = '', disabled = false) => `<button data-action="${action}" data-id="${escape(id)}" ${busy || disabled ? 'disabled' : ''}>${escape(text)}</button>`;
  const completed = certificates.filter(c => !c.revoked_at).length;
  const eligible = courses.filter(c => certificateStatus(c, certificates) === 'eligible').length;
  const inProgress = courses.filter(c => certificateStatus(c, certificates) === 'progress').length;
  const dashboard = library ? `<p class="muted">Your earned credentials and the next steps for each course.</p>
    <div class="certificate-filters" role="group" aria-label="Filter certificates"><button data-filter="all" aria-pressed="true">All</button><button data-filter="completed" aria-pressed="false">Completed (${completed})</button><button data-filter="eligible" aria-pressed="false">Eligible (${eligible})</button><button data-filter="progress" aria-pressed="false">In progress (${inProgress})</button><button data-filter="unavailable" aria-pressed="false">Needs attention</button></div>
    ${eligible ? `<p class="eligibility-notice" role="status">${eligible} course${eligible === 1 ? ' is' : 's are'} ready for a certificate. Open the requirements to review and claim.</p>` : ''}
    ${!certificates.length ? `<section class="certificate-guidance"><h2>Your first certificate starts with your coursework</h2><ol><li>Join a course and continue its guided lessons.</li><li>Complete the required exercises, projects and independent assessments in your course roadmap.</li><li>Review the remaining requirements, then claim your certificate when eligible.</li></ol><p>Lesson coverage alone does not establish eligibility. Your course results determine what remains.</p>${button('Browse courses','catalog')}</section>` : ''}
    <div class="certificate-grid">${courses.filter(course => certificateStatus(course, certificates) !== 'completed').map(course => {
      const status = certificateStatus(course, certificates), result = course.grade;
      const remaining = result?.blockers ?? [];
      return `<section class="certificate-course" data-certificate-status="${status}"><span class="dh-chip">${status === 'eligible' ? 'Eligible to claim' : status === 'progress' ? 'In progress' : 'Status unavailable'}</span><h2>${escape(course.title)}</h2>
        ${result ? `${progressBar(result.passed_count, result.required_count, `${result.passed_count} of ${result.required_count} required activities passed`)}<p>${result.passed_count}/${result.required_count} required activities passed</p><p>${escape(result.policy.description)}</p>${remaining.length ? `<ul>${remaining.slice(0,3).map(item=>`<li>${escape(item)}</li>`).join('')}</ul>${remaining.length > 3 ? '<p>Open requirements for all remaining steps.</p>' : ''}` : `<p>${result.eligible ? 'Your course requirements are complete. Review and claim your certificate.' : 'Review your roadmap for the remaining independent assessments.'}</p>`}` : `<p role="status">${escape(course.error || 'Requirements are not available yet.')}</p>`}
        <div class="actions">${button('View requirements','courseRequirements',course.id)}${course.expired ? button('Renew course access','catalog') : ''}</div></section>`;
    }).join('')}</div><p id="certificate-empty" hidden>No items in this section yet. Choose All to see your courses and next steps.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
    <title>Course grade & certificate</title><style nonce="${nonce}">${UI_TOKENS}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:none;margin:0;padding:clamp(18px,3vw,48px);font-size:max(15px,var(--vscode-font-size,13px));line-height:1.6}
    h1{font-size:25px}h2{font-size:18px;margin-top:24px}.muted{color:var(--vscode-descriptionForeground)}
    header,.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}header{justify-content:space-between}
    section{border:1px solid var(--vscode-panel-border);padding:16px;border-radius:8px;margin:16px 0}
    label{display:block;margin:12px 0}input,textarea,select{display:block;box-sizing:border-box;width:100%;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:8px;margin-top:6px}details{margin:16px 0}li{margin:8px 0}
    table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}
    button{font:inherit;white-space:normal;min-height:38px;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
    button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}summary{cursor:pointer}#notice{white-space:pre-wrap}small{display:block}
    .certificate-filters{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0}.certificate-filters button[aria-pressed=false]{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.certificate-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}.certificate-grid section{margin:0}.certificate-course{display:flex;flex-direction:column}.certificate-course .actions{margin-top:auto;padding-top:16px}.certificate-course h2{margin-top:12px}.certificate-guidance{background:var(--dh-surface)}.eligibility-notice{padding:16px;border-left:4px solid var(--dh-success)}[hidden]{display:none!important}small{overflow-wrap:anywhere}
    @media(max-width:480px){body{padding:14px}th,td{padding:8px 3px;font-size:.9em}.actions button{flex:1 1 auto}}
    </style></head><body><header><h1>${escape(grade?.course_title ?? (library ? 'My certificates' : 'Course grade & certificate'))}</h1>${button('Refresh','refresh')}</header>
    <p id="notice" role="status">${escape(notice)}</p>
    ${!library ? `<div class="actions">${button('My certificates','certificateLibrary')}</div>` : dashboard}
    ${pending ? `<p>${pending} assessment result${pending === 1 ? '' : 's'} waiting to sync. ${button('Sync pending results','sync')}</p>` : ''}
    ${skillingHtml(learning,grade?.readiness,busy)}
    ${grade ? `<section><h2>${grade.score === null ? 'Practice grade pending' : `Practice grade ${escape(grade.grade ?? 'Not passed')} · ${escape(grade.score)}/100`}</h2>
      <p>${grade.passed_count}/${grade.required_count} required activities passed</p>
      <p>Exercises: ${escape(grade.exercise_score ?? 'Pending')}${grade.requirements.some(r => r.kind === 'project') ? ` · Projects: ${escape(grade.project_score ?? 'Pending')}` : ''}</p>
      <p>${escape(grade.policy.description)}</p>${grade.blockers.map(b => `<p>${escape(b)}</p>`).join('')}</section>
      <h2>Topic mastery</h2><p class="muted">An estimate from your latest assessed work, difficulty and reported help. Later independent attempts can improve it. Repeating the same assisted solution does not erase its help history.</p>
      <table><thead><tr><th>Topic</th><th>Mastery</th><th>Independent exercises</th></tr></thead><tbody>${grade.topics.map(t => `<tr><td>${escape(t.topic)}</td><td>${t.score}% · ${t.ready ? 'Ready' : 'Keep practising'}</td><td>${t.independent}/${t.required_independent} needed</td></tr>`).join('')}</tbody></table>
      <details><summary>Required exercises and projects</summary><table><thead><tr><th>Activity</th><th>Best score</th><th></th></tr></thead><tbody>${grade.requirements.map(r => `<tr><td>${escape(r.title)}</td><td>${r.gradable ? r.score === null ? 'Pending' : escape(r.score) + '/100' : 'Assessment pending'}</td><td>${button('Open',r.kind,r.id)}</td></tr>`).join('')}</tbody></table></details>
      <h2>Course certificate</h2>${!grade.certificate_id ? `<p>${grade.eligible ? 'Your independent job-readiness assessments are complete.' : 'Complete the role prerequisites and independent readiness assessments shown in the roadmap to unlock your certificate.'}</p>
      <p class="muted">The certificate uses your account name. Anyone with its verification link can see your name, role, assessed skills, ratings, dates and assessment conditions.</p>
      ${button('Claim certificate','claim','',!grade.eligible)}` : ''}
      <p class="muted">${escape(grade.readiness?.profile?.scope??grade.policy.scope)}</p>` : ''}
    <div class="certificate-grid">${certificates.map(c => `<section data-certificate-status="${c.revoked_at ? 'unavailable' : 'completed'}"><span class="dh-chip">${c.revoked_at ? 'Revoked' : 'Completed · Certificate issued'}</span><h2>${escape(c.course_title)} · Grade ${escape(c.grade)} · ${escape(c.score)}/100</h2>
      <p>${escape(c.recipient_name)} · Issued ${escape(c.issued_at.slice(0,10))}</p><small>${escape(c.id)}</small>
      ${c.revoked_at ? '<p>Certificate revoked. Contact course support.</p>' : `<div class="actions">${button('View / save as PDF','certificate',c.id)}${button('Copy verification link','copy',c.id)}</div><p class="muted">The verification page previews your certificate. Use your browser’s Print → Save as PDF to download it. Share the link to let others verify the current record.</p>`}</section>`).join('')}</div>
    <script nonce="${nonce}">const vscode=acquireVsCodeApi();const scope=${JSON.stringify(scope).replaceAll('<','\\u003c')};let state=vscode.getState();if(!state||state.scope!==scope)state={scope,fields:{},requests:{}};
    for(const el of document.querySelectorAll('[data-field]'))if(state.fields[el.dataset.field]!==undefined)el.value=state.fields[el.dataset.field];
    const filterCertificates=value=>{let count=0;for(const el of document.querySelectorAll('[data-certificate-status]')){el.hidden=value!=='all'&&el.dataset.certificateStatus!==value;if(!el.hidden)count++;}for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter===value));const empty=document.getElementById('certificate-empty');if(empty)empty.hidden=count>0||value==='all';state.filter=value;vscode.setState(state);};
    for(const b of document.querySelectorAll('[data-filter]'))b.addEventListener('click',()=>filterCertificates(b.dataset.filter));
    filterCertificates(['all','completed','eligible','progress','unavailable'].includes(state.filter)?state.filter:'all');
    const collect=()=>Object.fromEntries([...document.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value]));
    document.addEventListener('input',()=>{state.fields=collect();state.requests={};vscode.setState(state);});
    document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b||b.disabled)return;state.fields=collect();const key=b.dataset.action+':'+b.dataset.id;if(!state.requests[key])state.requests[key]=crypto.randomUUID();vscode.setState(state);vscode.postMessage({type:b.dataset.action,id:b.dataset.id,fields:state.fields,requestId:state.requests[key]});});</script>
    </body></html>`;
}
