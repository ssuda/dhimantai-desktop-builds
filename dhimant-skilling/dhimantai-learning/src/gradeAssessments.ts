import type { Readiness, SkillingPathway, WeeklyAttempt } from './skilling';
import { escape as esc, icon, type ActionButton } from './gradeComponents';

export const projectKinds = ['micro', 'minor', 'major'];
type Milestone = Readiness['milestones'][number];
export function milestoneReason(m: Milestone, index: number, readiness: Readiness) {
  return m.lock_reason || (index ? `Pass the ${readiness.milestones[index-1].title} assessment first.`
    : readiness.lesson_access?.reason || readiness.blockers[0] || 'Complete the course prerequisites to unlock this assessment.');
}

export function assessmentCards(r: Readiness | undefined, button: ActionButton) {
  if (!r?.milestones.length) return '<p class="empty-state">No assessments are available for this course yet.</p>';
  const p = r.profile;
  return `<ol class="milestone-grid">${r.milestones.map((m,i) => {
    const status = m.status.replaceAll('_', ' ');
    const reason = !m.unlocked ? milestoneReason(m, i, r) : '';
    const project = projectKinds.includes(m.id);
    return `<li data-tone="${i%5}"><div class="milestone-top"><span>Level ${i+1}</span>${icon(milestoneIcon(m.id))}</div>
      <div class="milestone-body"><h3>${esc(m.title)}</h3>${reason && !['locked','not_started'].includes(m.status) ? `<small>${esc(status)}</small>` : ''}<p>${esc(reason || (m.status === 'not_started' ? 'Ready to start' : status))}</p>
      ${project ? button(m.unlocked ? 'Start project' : 'Locked','skillingProject',m.id,!m.unlocked)
        : !m.unlocked ? `<span class="lock-label">${icon('lock')} Locked</span>` : ''}
      ${m.review ? `<p>${esc(m.review.next_step)}</p><details><summary>Assessment feedback · ${esc(m.review.score)}/100</summary><ul>${Object.entries(m.review.ratings).map(([k,v]) => `<li>${esc(p?.criteria[k] ?? k)} · ${esc(v.rating)}/4 — ${esc(v.evidence)}</li>`).join('')}</ul></details>` : ''}</div></li>`;
  }).join('')}</ol>`;
}

export function milestoneIcon(id: string) {
  const icons = {micro:'code', minor:'layers', major:'briefcase', practical:'observe', defence:'mic'} as const;
  return icons[id as keyof typeof icons] ?? 'checklist';
}

export function assessmentForms(data: SkillingPathway | undefined, button: ActionButton) {
  const r = data?.pathway;
  const unlocked = r?.milestones.filter(m => m.unlocked) ?? [];
  const assistance = `<label>Assistance used <select data-field="assistance"><option value="">Choose…</option><option value="independent">Independent</option><option value="ai_assisted">AI assistance</option><option value="human_assisted">Human assistance</option><option value="mixed">AI and human assistance</option></select></label>`;
  const active = data?.weekly.find(w => w.week_start === data.current_week);
  const authored=data?.topics.flatMap(t=>t.challenges.filter(c=>!['apply','debug','transfer'].includes(c.id)).map(c=>({topic:t,key:t.key,challenge:c})))??[];
  const accessReason = r?.lesson_access?.reason || r?.blockers.find(b=>b === 'Unlock the required course lessons before starting readiness assessments.');
  const weeklyForm=(w:WeeklyAttempt)=>accessReason ? `<p>Locked · ${esc(accessReason)}</p>` : !w.questions.length ? '<p>No questions were assigned to this attempt.</p>' : `<div><h3>Week of ${esc(w.week_start)}</h3>${w.questions.map(q=>`<label>${esc(q.topic)} — ${esc(q.prompt)}<textarea data-field="answer:${esc(w.id)}:${esc(q.id)}" maxlength="8000" rows="5"></textarea></label>`).join('')}<label>Assistance used for this mock<select data-field="weeklyAssistance:${esc(w.id)}"><option value="">Choose…</option><option value="independent">Independent</option><option value="ai_assisted">AI assistance</option><option value="human_assisted">Human assistance</option><option value="mixed">AI and human assistance</option></select></label>${button('Submit weekly answers','weeklySubmit',w.id)}</div>`;

  const custom = unlocked.some(m => projectKinds.includes(m.id)) ? `<details><summary>Custom project requirements</summary><label>Describe the problem, users, constraints and acceptance criteria<textarea data-field="customRequirements" maxlength="4000" rows="5"></textarea></label><p>Start an unlocked project above to use these requirements. Coach guides the same requirements, design, implementation, test and handoff milestones.</p></details>` : '<article><h3>Custom project requirements</h3><p>Unlock a project to describe its requirements and acceptance criteria.</p></article>';
  const evidence = unlocked.length ? `<details><summary>Submit evidence for independent review</summary>
      <p>Choose public project files after completing this form. The selected files and explanation will be stored as an immutable submission for your assigned assessor. Keep credentials and private data out of your selection.</p>
      <label>Milestone <select data-field="kind">${unlocked.map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('')}</select></label>
      <label>Title<input data-field="title" maxlength="160"></label>
      <label>Requirements and acceptance criteria<textarea data-field="requirements" maxlength="4000" rows="4"></textarea></label>
      <label>Implementation, test evidence and handoff explanation<textarea data-field="explanation" maxlength="8000" rows="6"></textarea></label>${assistance}
      <p>For the practical task and defence, arrange an observed session with your assigned assessor. The assessor verifies identity, assigns an unfamiliar task or change, observes execution and records the assessment conditions.</p>
      ${button('Choose files & submit for review','skillingSubmit')}</details>` : '<article><h3>Submit evidence for review</h3><p>The evidence form opens when an assessment is unlocked.</p></article>';
  const practice = `<section><h2>Extra practice & interviews</h2>${!data?'<p>Learning activities could not be loaded. Refresh to retry.</p>':!data.topics.length?'<p>Published topic exercises are needed before topic activities can appear.</p>':`<label>Topic<select data-field="topic">${data.topics.map(t=>`<option value="${esc(t.key)}">${esc(t.topic)}</option>`).join('')}</select></label>${authored.length?`<label>Additional authored exercise<select data-field="challenge">${authored.map(({topic:t,challenge:c})=>`<option value="${esc(t.key)}|${esc(c.id)}">${esc(t.topic)} · ${esc(c.title)} · ${esc(c.difficulty)}</option>`).join('')}</select></label>${button('Open authored exercise','authoredChallenge')}`:''}<div class="actions">${button('Apply','challenge','apply')}${button('Debug','challenge','debug')}${button('Stretch challenge','challenge','transfer')}${button('Interview practice','interview')}</div><p>Challenges open in the existing learning notebook. Interview practice includes a 20-minute implementation task and explanation prompts.</p>`}</section>`;
  const weeklyReason = !data ? 'Refresh to load weekly mock availability.' : active?.submission_id ? 'Answers submitted for this week.'
    : accessReason || (!active && !data.topics.some(t => t.ready) ? 'Complete an assessed topic to unlock your weekly mock.' : '');
  const weekly = `<section class="weekly"><h3>Weekly mock</h3><p>One practice mock a week with assessor feedback.</p>
    ${weeklyReason ? `<p>${esc(weeklyReason)}</p>` : ''}
    ${active && !active.submission_id ? '' : button(active?.submission_id ? 'Submitted' : weeklyReason ? 'Locked' : 'Start this week’s mock','weeklyStart','',!!weeklyReason)}
    ${active && !active.submission_id ? `<details><summary>Continue this week’s mock</summary>${weeklyForm(active)}</details>` : ''}
      ${data?.weekly.filter(w=>w.submission_id||w.id!==active?.id).map(w=>`<details><summary>${esc(w.week_start)} · ${w.review?`${w.review.score}/100`:w.submission_id?'Awaiting assessment':'In progress · Resume'}</summary>${w.review?`<p>${esc(w.review.next_step)}</p><ul>${w.questions.map(q=>`<li>${esc(q.topic)}: ${w.review!.ratings[q.id]?.rating??'Pending'}/4 — ${esc(w.review!.ratings[q.id]?.evidence??'')}</li>`).join('')}</ul>`:w.submission_id?'<p>Your answers are submitted and awaiting assessor feedback.</p>':weeklyForm(w)}</details>`).join('')??''}</section>`;
  const unavailable = '<p class="empty-state">Refresh to load your project forms.</p>';
  return {custom:data ? custom : '', evidence:data ? evidence : unavailable, practice, weekly};
}
