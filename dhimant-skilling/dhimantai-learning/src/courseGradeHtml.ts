import type { SkillingPathway } from './skilling';
import type { CourseCertificate, CourseGrade } from './courseworkProgress';
import { CertificateCourse, CertificateStatus, certificateStatus } from './certificateDashboard';
import { activityProgress, attention, escape, gradingGuide, icon, type ActionButton } from './gradeComponents';
import { courseGradeDetail, gradeTabsClient } from './courseGradeDetail';
import { GRADE_DETAIL_STYLES } from './courseGradeStyles';
import { UI_TOKENS } from './uiTheme';
import { courseHue, courseHueStyles } from './courseColors';
import { CERTIFICATE_STYLES } from './certificateStyles';

function courseCard(course: CertificateCourse, status: CertificateStatus, button: ActionButton) {
  const grade = course.grade;
  const issues = grade ? [...grade.blockers] : [course.error || 'Requirements could not be loaded. Refresh to try again.'];
  const readiness = grade?.readiness;
  if (readiness && !readiness.milestones.length) issues.push(...readiness.blockers);
  if (grade && course.expired) issues.push('Course access has ended. Renew access to continue.');
  if (grade && !grade.required_count && !issues.length) issues.push('Required activities are awaiting publication.');
  const label = status === 'eligible' ? 'Eligible to claim' : status === 'progress' ? 'In progress' : 'Status unavailable';
  return `<section class="certificate-course" data-course-hue="${courseHue(course.id)}" data-certificate-status="${status}" data-needs-attention="${issues.length > 0}">
    <span class="dh-chip">${label}</span><h2>${escape(course.title)}</h2>
    ${grade ? activityProgress(grade) : ''}
    ${issues.length ? attention(issues) : ''}
    ${grade?.eligible ? '<p><strong>Next step</strong> · Review your results and claim your certificate.</p>'
      : !issues.length ? '<p><strong>Next step</strong> · Review your roadmap for the remaining independent assessments.</p>' : ''}
    <div class="actions">${button('View requirements','courseRequirements',course.id)}${course.expired ? button('Renew course access','catalog') : ''}</div></section>`;
}

function issuedCard(c: CourseCertificate, button: ActionButton, library: boolean) {
  const status = c.revoked_at ? 'Revoked' : 'Completed · Certificate issued';
  const mark = `Grade ${escape(c.grade)} · ${escape(c.score)}/100`;
  const date = escape(c.issued_at.slice(0,10));
  const summary = library || c.revoked_at
    ? `<span class="dh-chip">${status}</span><h2>${escape(c.course_title)} · ${mark}</h2>
      <p>${escape(c.recipient_name)} · Issued ${date}</p><small>${escape(c.id)}</small>`
    : `<div class="earned-paper"><span>dhimantAI</span>${icon('medal')}<h3>Certificate of achievement</h3>
      <strong>${escape(c.recipient_name)}</strong><p>${escape(c.course_title)}</p><b>${mark}</b><small>Issued ${date} · ${escape(c.id)}</small></div>`;
  return `<section ${library ? `class="certificate-course" data-course-hue="${courseHue(c.course_id)}"` : ''} data-certificate-status="${c.revoked_at ? 'unavailable' : 'completed'}" data-needs-attention="${!!c.revoked_at}">
    ${summary}
    ${c.revoked_at ? attention(['Certificate revoked. Contact course support.'])
      : `<div class="actions">${button('View / save as PDF','certificate',c.id)}${button('Copy verification link','copy',c.id)}</div><p class="muted">The verification page previews your certificate. Use your browser’s Print → Save as PDF to download it. Share the link to let others verify the current record.</p>`}</section>`;
}

function certificateLibrary(courses: CertificateCourse[], certificates: CourseCertificate[], button: ActionButton) {
  const completed = certificates.filter(c => !c.revoked_at).length;
  const active = courses.map(course => ({course, status: certificateStatus(course, certificates)})).filter(item => item.status !== 'completed');
  const eligible = active.filter(item => item.status === 'eligible').length;
  const inProgress = active.filter(item => item.status === 'progress').length;
  return `<div class="certificate-filters" role="group" aria-label="Filter certificates">
    <button data-filter="all" aria-pressed="true">All</button>
    <button data-filter="completed" aria-pressed="false">Completed <strong>${completed}</strong></button>
    <button data-filter="eligible" aria-pressed="false">Eligible to claim <strong>${eligible}</strong></button>
    <button data-filter="progress" aria-pressed="false">In progress <strong>${inProgress}</strong></button>
    <button data-filter="unavailable" aria-pressed="false">${icon('warning')}Needs attention</button></div>
    ${eligible ? `<p class="eligibility-notice" role="status">${eligible} course${eligible === 1 ? ' is' : 's are'} ready for a certificate. Open the requirements to review and claim.</p>` : ''}
    <div class="certificate-intro">${!certificates.length ? `<section class="certificate-guidance">
      <h2>${icon('medal')}Your first certificate starts with your coursework</h2>
      <ol role="list"><li><strong>Learn</strong><span>Join a course and follow its guided lessons.</span></li>
        <li><strong>Pass the required work</strong><span>Complete the exercises, projects and independent assessments in your roadmap.</span></li>
        <li><strong>Claim it</strong><span>Open your course requirements and claim your certificate when eligible.</span></li></ol>
      <div class="guidance-actions">${button('Browse courses','catalog')}<p>Your course results show what you have passed and what remains.</p></div></section>` : ''}
    ${gradingGuide(courses.find(c => c.grade)?.grade?.policy)}</div>
    <div class="certificate-grid">${active.map(({course,status}) => courseCard(course,status,button)).join('')}
      ${certificates.map(c => issuedCard(c,button,true)).join('')}</div>
    <p id="certificate-empty" hidden>No items in this section yet. Choose All to see your courses and next steps.</p>`;
}

export function courseGradeHtml(nonce: string, grade: CourseGrade | undefined, certificates: CourseCertificate[], notice: string, pending: number, busy = false, library = false, learning?:SkillingPathway, scope='', courses: CertificateCourse[] = [], lessons?: {open:number; total:number}, syncReady = true) {
  const button: ActionButton = (text, action, id = '', disabled = false) => `<button data-action="${action}" data-id="${escape(id)}" ${busy || disabled ? 'disabled' : ''}>${disabled && text.includes('Locked') ? icon('lock') : action === 'refresh' && library ? icon('refresh') : ''}${escape(text)}${action === 'courseRequirements' ? ' <span aria-hidden="true">→</span>' : ''}</button>`;
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
    .certificate-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}.certificate-grid section{margin:0}[hidden]{display:none!important}small{overflow-wrap:anywhere}
    @media(max-width:480px){body{padding:14px}th,td{padding:8px 3px;font-size:.9em}.actions button{flex:1 1 auto}}
    ${library ? courseHueStyles([...courses.map(c => c.id), ...certificates.map(c => c.course_id)]) + CERTIFICATE_STYLES : GRADE_DETAIL_STYLES}
    </style></head><body class="${library ? 'certificate-library' : 'grade-detail'}">
    ${library ? `<header><div><h1>My certificates</h1><p class="muted">Your earned credentials and the next steps for each course.</p></div>${button('Refresh','refresh')}</header>` : ''}
    <p id="notice" role="status">${escape(notice)}</p>
    ${pending ? `<p>${pending} assessment result${pending === 1 ? '' : 's'} waiting to sync. ${button('Sync pending results','sync','',!syncReady)}</p>` : ''}
    ${library ? certificateLibrary(courses, certificates, button)
      : courseGradeDetail(grade, learning, certificates, certificates.map(c => issuedCard(c,button,false)).join(''), button, lessons)}
    <script nonce="${nonce}">const vscode=acquireVsCodeApi();const scope=${JSON.stringify(scope).replaceAll('<','\\u003c')};let state=vscode.getState();if(!state||state.scope!==scope)state={scope,fields:{},requests:{}};
    (${gradeTabsClient.toString()})(state,()=>vscode.setState(state));
    for(const el of document.querySelectorAll('[data-field]'))if(state.fields[el.dataset.field]!==undefined)el.value=state.fields[el.dataset.field];
    const filterCertificates = value => {
      let count = 0;
      for (const card of document.querySelectorAll('[data-certificate-status]')) {
        card.hidden = value === 'unavailable'
          ? card.dataset.needsAttention !== 'true'
          : value !== 'all' && card.dataset.certificateStatus !== value;
        if (!card.hidden) count++;
      }
      for (const filter of document.querySelectorAll('[data-filter]')) {
        filter.setAttribute('aria-pressed', String(filter.dataset.filter === value));
      }
      const empty = document.getElementById('certificate-empty');
      if (empty) empty.hidden = count > 0 || value === 'all';
      state.filter = value;
      vscode.setState(state);
    };
    for(const b of document.querySelectorAll('[data-filter]'))b.addEventListener('click',()=>filterCertificates(b.dataset.filter));
    filterCertificates(['all','completed','eligible','progress','unavailable'].includes(state.filter)?state.filter:'all');
    const collect=()=>Object.fromEntries([...document.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value]));
    document.addEventListener('input',()=>{state.fields=collect();state.requests={};vscode.setState(state);});
    document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b||b.disabled)return;state.fields=collect();const key=b.dataset.action+':'+b.dataset.id;if(!state.requests[key])state.requests[key]=crypto.randomUUID();vscode.setState(state);vscode.postMessage({type:b.dataset.action,id:b.dataset.id,fields:state.fields,requestId:state.requests[key]});});</script>
    </body></html>`;
}
