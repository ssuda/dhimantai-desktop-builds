import type { CourseCertificate, CourseGrade } from './courseworkProgress';
import type { Readiness, SkillingPathway } from './skilling';
import { activityProgress, attention, escape, gradingGuide, icon, type ActionButton } from './gradeComponents';
import { assessmentCards, assessmentForms, milestoneIcon, milestoneReason } from './gradeAssessments';
import { desktopProjectEnabled } from './desktopFeatures';

const tabs = ['Overview', 'Projects', 'Grades', 'Certificate', 'Help'];
type LessonCount = {open: number; total: number};

function ring(value: number | null) {
  const percent = value === null ? 0 : Math.round(Math.max(0, Math.min(100, value)));
  return `<span class="ring"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="track" cx="24" cy="24" r="20"/>
    <circle class="fill" cx="24" cy="24" r="20" pathLength="100" stroke-dasharray="${percent} 100"/></svg><b>${value === null ? '—' : percent+'%'}</b></span>`;
}

function journey(grade: CourseGrade | undefined, r: Readiness, accessReason: string | undefined, button: ActionButton) {
  const p = r.profile!;
  const milestones = r.milestones;
  const next = milestones.find(m => m.status !== 'passed');
  const current = grade?.eligible ? 'certificate' : accessReason ? 'learn' : next?.id ?? 'practice';
  const steps = [{id:'learn', title:'Learn', glyph:'book' as const}, {id:'practice', title:'Topic practice', glyph:'target' as const},
    ...milestones.map(m => ({id:m.id, title:m.title, glyph:milestoneIcon(m.id)})), {id:'certificate', title:'Certificate', glyph:'medal' as const}];
  const action = current === 'learn' ? button('View course lessons','nextCourse',p.course_id)
    : `<button data-goto="${current === 'certificate' ? 'Certificate' : current === 'practice' ? 'Grades' : 'Projects'}">${current === 'certificate' ? 'View certificate' : current === 'practice' ? 'View grades' : 'View assessments'} →</button>`;
  const lessons = r.lesson_access?.lessons ?? [];
  return `<section class="journey"><h2>Your journey</h2><ol>${steps.map((s,i) => `<li data-tone="${i % 8}" ${s.id === current ? 'aria-current="step"' : ''}>
    <span class="step-icon">${icon(s.glyph)}</span><span>${escape(s.title)}</span>${milestones.some(m=>m.id===s.id && m.status==='passed') ? '<small>Passed</small>' : ''}</li>`).join('')}</ol>
    <div class="next-step"><div><strong>You are here · ${escape(steps.find(s=>s.id===current)?.title)}</strong>
      <span>${escape(accessReason || next?.lock_reason || (grade?.eligible ? 'Your certificate requirements are complete.' : next?.status === 'awaiting_review' ? 'Your submission is awaiting review.' : 'Review your next course activity.'))}</span></div>${action}</div>
    ${lessons.length ? `<details><summary>View ${lessons.length} locked lesson${lessons.length===1?'':'s'}</summary><ul>${lessons.map(l=>`<li>${escape(l)}</li>`).join('')}</ul></details>` : ''}</section>`;
}

function gradeTables(g: CourseGrade, button: ActionButton) {
  const topics = g.topics.length ? `<p class="muted">Mastery uses your latest assessed work, its difficulty and reported help. Later independent attempts can improve it.</p>
    <table><thead><tr><th>Topic</th><th>Mastery</th><th>Independent exercises</th></tr></thead><tbody>${g.topics.map(t=>`<tr><td>${escape(t.topic)}</td><td>${escape(t.score)}% · ${t.ready ? 'Ready' : 'Keep practising'}</td><td>${escape(t.independent)} of ${escape(t.required_independent)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-state">Mastery appears after your first assessed exercises.</p>';
  const required = g.requirements.length ? `<details><summary>View ${g.requirements.length} required activities</summary><table><thead><tr><th>Activity</th><th>Best score</th><th>Action</th></tr></thead>
    <tbody>${g.requirements.map(r=>`<tr><td>${escape(r.title)}</td><td>${r.gradable ? r.score === null ? 'Pending' : escape(r.score)+'/100' : 'Assessment pending'}</td>
    <td>${r.kind === 'project' && !desktopProjectEnabled(r.id) ? 'Paused on desktop' : button('Open',r.kind,r.id)}</td></tr>`).join('')}</tbody></table></details>` : '<p class="empty-state">No required activities published yet.</p>';
  return `<section><h3>Topic mastery</h3>${topics}</section><section><h3>Required exercises and projects</h3>${required}</section>`;
}

function gradeTab(g: CourseGrade | undefined, r: Readiness | undefined, button: ActionButton) {
  const criteria = Object.values(r?.profile?.criteria ?? {});
  return `<div class="grade-columns"><div>${g ? `<section><h2>Practice grade</h2><div class="ring-stat">${ring(g.score)}
    <div><strong>${g.score === null ? 'Not set yet' : `Grade ${escape(g.grade || 'Not passed')} · ${escape(g.score)}/100`}</strong>
    <p>Exercises · ${escape(g.exercise_score ?? 'Pending')}${g.requirements.some(req=>req.kind==='project') ? ' · Projects · '+escape(g.project_score ?? 'Pending') : ''}</p></div></div>
    ${activityProgress(g)}${g.blockers.length ? attention(g.blockers) : ''}</section>${gradingGuide(g.policy)}${gradeTables(g,button)}` : '<p class="empty-state">Course grades are unavailable.</p>'}</div>
    ${criteria.length ? `<section><h2>Certification standard</h2><p>Earn at least 3 of 4 on every essential criterion in an independent assessment.</p>
    <ol class="criteria">${criteria.map(c=>`<li>${escape(c)}</li>`).join('')}</ol><p class="muted">${escape(r?.profile?.scope)}</p></section>` : ''}</div>`;
}

function certificateTab(g: CourseGrade | undefined, r: Readiness | undefined, issued: string, button: ActionButton) {
  const locked = !g?.eligible;
  const reason = r?.blockers[0] || 'Complete the role prerequisites and independent readiness assessments shown in your roadmap.';
  return `<h2>Your certificate</h2>${g && !g.certificate_id ? `<div class="grade-columns"><section class="credential-preview ${locked ? 'locked' : ''}">
    <div class="paper" aria-hidden="true"><span>dhimantAI</span><h3>Certificate of achievement</h3><strong>${escape(g.course_title)}</strong>${icon('medal')}</div>
    <div class="preview-status"><span class="seal">${icon(locked ? 'lock' : 'medal')}</span><h3>${locked ? 'Certificate locked' : 'Eligible to claim'}</h3>
      <p>${locked ? 'Complete the requirements to unlock your certificate.' : 'Your independent job-readiness assessments are complete.'}</p></div></section>
    <section><h3>What you need</h3><ul class="requirements">${(r?.profile?.prerequisites ?? []).map(id=>`<li>${icon('medal')}${button(id.replaceAll('-',' '),'nextCourse',id)}</li>`).join('')}
      ${r?.milestones.map((m,i)=>{
        const passed = m.status === 'passed';
        const status = passed ? 'Passed' : !m.unlocked ? 'Locked' : m.status === 'not_started' ? 'Ready to start' : m.status.replaceAll('_',' ');
        return `<li>${icon(passed ? 'check' : m.unlocked ? 'clock' : 'lock')}<div>${escape(m.title)}
          ${!m.unlocked && !passed ? `<span class="requirement-reason">${escape(milestoneReason(m,i,r))}</span>` : ''}</div><small>${escape(status)}</small></li>`;
      }).join('') ?? ''}</ul>
    ${locked ? `<p class="muted">${escape(reason)}</p>` : ''}${button(locked ? 'Claim certificate · Locked' : 'Claim certificate','claim','',locked)}
    <p class="muted">Your certificate uses your account name. Its verification link shows your name, role, assessed skills, ratings, dates and assessment conditions.</p></section></div>` : ''}
    ${issued ? `<div class="certificate-grid">${issued}</div>` : !g || g.certificate_id ? '<p class="empty-state">Certificate details are unavailable. Refresh to check again.</p>' : ''}`;
}

const helpSteps = [
  ['Learn','Start with the course outline and prerequisites. Open a lesson in Instructor to continue.'],
  ['Practise','Predict outputs and inspect failures. Ask for help when you need it and record the assistance you used.'],
  ['Build','Build your Micro, Minor and Major projects in the course container. Use Runtime for setup and the terminal.'],
  ['Submit','Choose public files and submit a snapshot for independent review. Contact course support if no assessor is assigned.'],
  ['Get assessed','Arrange an observed practical task and project defence. Use assessor feedback to revise and submit again.'],
  ['Claim','Open the Certificate tab when all requirements pass. The verification page lets you share or print your certificate.'],
];

export function courseGradeDetail(g: CourseGrade | undefined, data: SkillingPathway | undefined, records: CourseCertificate[],
    issued: string, button: ActionButton, lessons?: LessonCount) {
  const r = data?.pathway ?? g?.readiness, p = r?.profile;
  const back = button('My certificates','certificateLibrary');
  if (!g && !r && !records.length) return `<header><div>${back}<h1>Course grade &amp; certificate</h1></div>${button('Refresh','refresh')}</header>`;
  const passed = r?.milestones.filter(m=>m.status==='passed').length ?? 0;
  const total = r?.milestones.length ?? 0;
  const accessReason = r?.lesson_access?.reason ?? r?.blockers.find(b=>b==='Unlock the required course lessons before starting readiness assessments.');
  const blockers = [...new Set([...(g?.blockers ?? []), ...(r?.blockers ?? [])])].filter(b=>b !== accessReason);
  const forms = assessmentForms(data, button);
  const record = records.find(c=>g ? c.id===g.certificate_id : !c.revoked_at);
  const certStatus = record?.revoked_at ? 'Revoked' : record ? 'Issued' : !g ? 'Unavailable' : g.eligible ? 'Eligible to claim' : 'Locked';
  const title = g?.course_title ?? p?.title ?? records[0]?.course_title;
  const courseLinks = (ids: string[]) => ids.map(id=>button(data?.course_titles?.[id] ?? id.replaceAll('-',' '),'nextCourse',id)).join(' ');
  const overview = `${p && r ? journey(g,r,accessReason,button) : '<section><h2>Your journey</h2><p>A role-specific roadmap is unavailable for this course.</p></section>'}
    <div class="metrics">${lessons?.total ? `<section>${ring(100*lessons.open/lessons.total)}<div><small>Lessons unlocked</small><strong>${lessons.open} of ${lessons.total}</strong></div></section>` : g ? `<section>${ring(g.required_count ? 100*g.passed_count/g.required_count : null)}<div><small>Activities passed</small><strong>${g.required_count ? g.passed_count+' of '+g.required_count : 'Not set yet'}</strong></div></section>` : ''}
      <section>${icon('checklist')}<div><small>Practice grade</small><strong>${escape(g?.score == null ? 'Not set yet' : g.score+'/100')}</strong></div></section>
      <section>${icon('layers')}<div><small>Assessments passed</small><strong>${total ? passed+' of '+total : 'Not set yet'}</strong></div></section>
      <section>${icon(certStatus === 'Issued' || g?.eligible ? 'medal' : 'lock')}<div><small>Certificate</small><strong>${certStatus}</strong></div></section></div>
    <div class="overview-extras">${blockers.length ? attention(blockers) : ''}${p ? forms.weekly : ''}${p?.recommended_next.length ? `<section class="recommend"><h3>Recommended next</h3>${courseLinks(p.recommended_next)}</section>` : ''}</div>
    ${p?.prerequisites.length || p?.outcomes.length ? `<details class="outline"><summary>Course outcomes and prerequisites</summary>${p.outcomes.length ? `<ul>${p.outcomes.map(o=>`<li>${escape(o)}</li>`).join('')}</ul>` : ''}${courseLinks(p.prerequisites)}</details>` : ''}`;
  const panels = [overview, `<h2>Projects and assessments</h2>${assessmentCards(r,button)}${p ? `<div class="project-forms">${forms.evidence}${forms.custom}</div>${forms.practice}` : ''}`,
    gradeTab(g,r,button), certificateTab(g,r,issued,button),
    `<h2>How to learn, progress and get assessed</h2><ol class="help-grid">${helpSteps.map(([t,desc],i)=>`<li data-tone="${i}"><h3><span>${i+1}</span>${t}</h3><p>${desc}</p></li>`).join('')}</ol>
    <p class="help-note">${icon('info')}Changing prerequisite evidence may require later steps to be reassessed. Earlier certificates keep their original scope.</p>`];
  return `<header class="course-hero"><div class="crumb">${back} <span aria-hidden="true">/</span> <span>Course results</span></div>
    <div class="hero-content"><div class="course-mark">${icon('branch')}</div><div><h1>${escape(title)}</h1>
    ${p ? `<p>${escape([p.role,p.level].filter(Boolean).join(' · '))}</p><div class="stack">${p.technology_stack.map(t=>`<span>${escape(t)}</span>`).join('')}</div>` : ''}</div>
    <div class="readiness ring-stat">${ring(total ? 100*passed/total : null)}<div><b>Job readiness</b><small>${total ? passed+' of '+total+' assessments passed' : 'Assessment progress unavailable'}</small></div></div></div>
    <div class="tabbar"><div role="tablist" aria-label="Course results">${tabs.map((tab,i)=>`<button role="tab" id="tab-${tab}" data-tab="${tab}" aria-controls="panel-${tab}" aria-selected="${!i}" tabindex="${i ? -1 : 0}">${tab}</button>`).join('')}</div>${button('Refresh','refresh')}</div></header>
    <main>${tabs.map((tab,i)=>`<div role="tabpanel" id="panel-${tab}" aria-labelledby="tab-${tab}" tabindex="0" ${i ? 'hidden' : ''}>${panels[i]}</div>`).join('')}</main>`;
}

/** Inlined into the nonced webview script. Keyboard and pointer navigation share the same selection. */
export function gradeTabsClient(state: {tab?: string}, save: ()=>void) {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  if (!tabs.length) return;
  const select = (tab: HTMLButtonElement, focus = false) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')!)!.hidden = !selected;
    }
    state.tab = tab.dataset.tab;
    save();
    if (focus) tab.focus();
  };
  select(tabs.find(t => t.dataset.tab === state.tab) ?? tabs[0]);
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const target = {ArrowRight:(index+1)%tabs.length, ArrowLeft:(index+tabs.length-1)%tabs.length, Home:0, End:tabs.length-1}[event.key];
      if (target !== undefined) { event.preventDefault(); select(tabs[target],true); }
    });
  }
  for (const link of document.querySelectorAll<HTMLButtonElement>('[data-goto]')) link.addEventListener('click', () => {
    const tab = tabs.find(t => t.dataset.tab === link.dataset.goto);
    if (tab) select(tab,true);
  });
}
