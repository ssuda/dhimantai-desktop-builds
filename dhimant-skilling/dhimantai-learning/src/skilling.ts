import { createHash } from 'node:crypto';

/** UUIDv5: retries reuse an id, but edited files or prerequisite evidence start a new submission. */
export function evidenceRequestId(namespace:string,evidence:object):string {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace))throw new Error('Refresh the evidence form before submitting.');
  const bytes=createHash('sha1').update(Buffer.from(namespace.replaceAll('-',''),'hex')).update(JSON.stringify(evidence)).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export interface SkillingProfile {
  course_id: string; title: string; role: string; level: string; certifiable: boolean; fingerprint: string;
  technology_stack: string[]; prerequisites: string[]; recommended_next: string[]; outcomes: string[];
  criteria: Record<string,string>; rubrics?:Record<string,Record<string,string>>; scope: string; project_theme: string;
}
export interface SkillingReview {
  ratings: Record<string,{rating:number;evidence:string}>; conditions:string; task:string; next_step:string;
  observed:boolean; identity_checked:boolean; unfamiliar_task:boolean; passed:boolean; score:number;
}
export interface Readiness {
  profile: SkillingProfile | null; eligible:boolean; score:number|null; blockers:string[];
  milestones:{id:string;title:string;status:string;unlocked:boolean;basis:unknown;submission_id:string|null;review:SkillingReview|null}[];
}
export interface WeeklyAttempt {
  id:string;week_start:string;submission_id:string|null;
  questions:{id:string;topic:string;topic_key:string;prompt:string}[];review?:SkillingReview|null;
}
export interface SkillingPathway {
  pathway:Readiness;current_week:string;course_titles?:Record<string,string>;
  topics:{key:string;topic:string;ready:boolean;challenges:{id:string;title:string;difficulty:string;prompt:string}[];interview:string[]}[];
  weekly:WeeklyAttempt[];
}
export interface SkillingBrief {
  course_id:string;course_title:string;kind:string;profile_hash:string;language:string;
  brief:{title:string;requirements:string;milestones:{id:string;title:string;task:string}[]};
}
export const PREVIEW_PORTS = [8000, 8080, 3000, 5173, 8501] as const;
export const previewPublishArgs = PREVIEW_PORTS.flatMap(port => ['--publish', `127.0.0.1::${port}/tcp`]);
/** Never open a public bind, remote host, wildcard address or arbitrary URI from container metadata. */
export function previewUrl(mapping:string):string {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(mapping.trim());
  if (!match || +match[1]<1 || +match[1]>65535) throw new Error('This preview port is not bound to localhost. Rebuild the course runtime.');
  return `http://127.0.0.1:${+match[1]}/`;
}

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function skillingHtml(data:SkillingPathway|undefined, readiness:Readiness|undefined, busy:boolean) {
  const r=data?.pathway??readiness,p=r?.profile;
  if(!r) return '';
  if(!p) return '<section><h2>Job readiness</h2><p>A role-specific standard has not been published for this course.</p></section>';
  const button=(label:string,action:string,id='',disabled=false)=>`<button data-action="${action}" data-id="${esc(id)}" ${busy||disabled?'disabled':''}>${esc(label)}</button>`;
  const assistance=`<label>Assistance used <select data-field="assistance"><option value="">Choose…</option><option value="independent">Independent</option><option value="ai_assisted">AI assistance</option><option value="human_assisted">Human assistance</option><option value="mixed">AI and human assistance</option></select></label>`;
  const active=data?.weekly.find(w=>w.week_start===data.current_week);
  const courseTitle=(id:string)=>data?.course_titles?.[id]??id.replaceAll('-',' ');
  const authored=data?.topics.flatMap(t=>t.challenges.filter(c=>!['apply','debug','transfer'].includes(c.id)).map(c=>({topic:t,key:t.key,challenge:c})))??[];
  const weeklyForm=(w:WeeklyAttempt)=>`<div><h3>Week of ${esc(w.week_start)}</h3>${w.questions.map(q=>`<label>${esc(q.topic)} — ${esc(q.prompt)}<textarea data-field="answer:${esc(w.id)}:${esc(q.id)}" maxlength="8000" rows="5"></textarea></label>`).join('')}<label>Assistance used for this mock<select data-field="weeklyAssistance:${esc(w.id)}"><option value="">Choose…</option><option value="independent">Independent</option><option value="ai_assisted">AI assistance</option><option value="human_assisted">Human assistance</option><option value="mixed">AI and human assistance</option></select></label>${button('Submit weekly answers','weeklySubmit',w.id)}</div>`;
  return `<section><h2>Roadmap & job readiness</h2><p><strong>${esc(p.role||'Foundation pathway')} · ${esc(p.level)}</strong></p>
    <p>${esc(p.technology_stack.join(' · '))}</p><ul>${p.outcomes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
    ${p.prerequisites.length?`<p>Prerequisites: ${p.prerequisites.map(id=>button(courseTitle(id),'nextCourse',id)).join(' ')}</p>`:''}
    <p>Learn → Topic practice → Micro → Minor → Major → Observed practical → Project defence → Certificate</p>
    <ol>${r.milestones.map(m=>`<li><strong>${esc(m.title)}</strong> · ${esc(m.status.replaceAll('_',' '))}
      ${['micro','minor','major'].includes(m.id)?button('Start project','skillingProject',m.id,!m.unlocked):''}
      ${m.review?`<p>${esc(m.review.next_step)}</p><details><summary>Assessment feedback · ${m.review.score}/100</summary><ul>${Object.entries(m.review.ratings).map(([k,v])=>`<li>${esc(p.criteria[k]??k)}: ${v.rating}/4 — ${esc(v.evidence)}</li>`).join('')}</ul></details>`:''}</li>`).join('')}</ol>
    ${r.blockers.map(b=>`<p>${esc(b)}</p>`).join('')}
    <details><summary>Custom project requirements</summary><label>Describe the problem, users, constraints and acceptance criteria<textarea data-field="customRequirements" maxlength="4000" rows="5"></textarea></label><p>Start an unlocked project above to use these requirements. Coach guides the same requirements, design, implementation, test and handoff milestones.</p></details>
    <details><summary>Submit evidence for independent review</summary>
      <p>Choose public project files after completing this form. The selected files and explanation will be stored as an immutable submission for your assigned assessor. Keep credentials and private data out of your selection.</p>
      <label>Milestone <select data-field="kind">${r.milestones.filter(m=>m.unlocked).map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('')}</select></label>
      <label>Title<input data-field="title" maxlength="160"></label>
      <label>Requirements and acceptance criteria<textarea data-field="requirements" maxlength="4000" rows="4"></textarea></label>
      <label>Implementation, test evidence and handoff explanation<textarea data-field="explanation" maxlength="8000" rows="6"></textarea></label>${assistance}
      <p>For the practical task and defence, arrange an observed session with your assigned assessor. The assessor verifies identity, assigns an unfamiliar task or change, observes execution and records the assessment conditions.</p>
      ${button('Choose files & submit for review','skillingSubmit','',!r.milestones.some(m=>m.unlocked))}</details>
    <details><summary>Certification standard</summary><p>Every essential criterion must reach 3/4: demonstrated, with minor gaps that do not prevent safe independent delivery. A failed criterion cannot be hidden by an average.</p><ul>${Object.values(p.criteria).map(c=>`<li>${esc(c)}</li>`).join('')}</ul><p>${esc(p.scope)}</p></details>
    ${p.recommended_next.length?`<p>Recommended next: ${p.recommended_next.map(id=>button(courseTitle(id),'nextCourse',id)).join(' ')}</p>`:''}</section>
    <section><h2>Extra practice & interviews</h2>${!data?'<p>Learning activities could not be loaded. Refresh to retry.</p>':!data.topics.length?'<p>Published topic exercises are needed before topic activities can appear.</p>':`<label>Topic<select data-field="topic">${data.topics.map(t=>`<option value="${esc(t.key)}">${esc(t.topic)}</option>`).join('')}</select></label>${authored.length?`<label>Additional authored exercise<select data-field="challenge">${authored.map(({topic:t,challenge:c})=>`<option value="${esc(t.key)}|${esc(c.id)}">${esc(t.topic)} · ${esc(c.title)} · ${esc(c.difficulty)}</option>`).join('')}</select></label>${button('Open authored exercise','authoredChallenge')}`:''}<div class="actions">${button('Apply','challenge','apply')}${button('Debug','challenge','debug')}${button('Stretch challenge','challenge','transfer')}${button('Interview practice','interview')}</div><p>Challenges open in the existing learning notebook. Interview practice includes a 20-minute implementation task and explanation prompts.</p>`}</section>
    <section><h2>Weekly mock</h2><p>One formative mock per week, based on assessed completed topics. Written and practical responses receive assessor feedback. Weekly scores support revision and do not issue certificates.</p>
      ${button(active&&!active.submission_id?'Resume this week’s mock':'Start this week’s mock','weeklyStart','',!!active?.submission_id)}
      ${active&&!active.submission_id?weeklyForm(active):''}
      ${data?.weekly.filter(w=>w.submission_id||w.id!==active?.id).map(w=>`<details><summary>${esc(w.week_start)} · ${w.review?`${w.review.score}/100`:w.submission_id?'Awaiting assessment':'In progress · Resume'}</summary>${w.review?`<p>${esc(w.review.next_step)}</p><ul>${w.questions.map(q=>`<li>${esc(q.topic)}: ${w.review!.ratings[q.id]?.rating??'Pending'}/4 — ${esc(w.review!.ratings[q.id]?.evidence??'')}</li>`).join('')}</ul>`:w.submission_id?'<p>Your answers are submitted and awaiting assessor feedback.</p>':weeklyForm(w)}</details>`).join('')??''}</section>
    <details><summary>Help: how to learn, progress and get assessed</summary><ol>
      <li>Start with the course outline and prerequisites. Continue lessons in Instructor; use Study for available course documents.</li>
      <li>Practise each topic, predict outputs and inspect failures. Use existing Stuck? help and Coach when needed. Declare assistance honestly.</li>
      <li>Build Micro, Minor and Major work in your course container. Use the Runtime dropdown for setup and the terminal. Open application previews from Project actions.</li>
      <li>Submit a frozen set of public files for review. An assessor must be assigned by your institution or the platform; contact course support if your review remains unassigned.</li>
      <li>Arrange an observed unfamiliar practical task and project defence. Use the feedback to revise and submit again. Changed prerequisite evidence requires downstream reassessment.</li>
      <li>Claim the certificate when all requirements pass. Its verification page shows your name, role, ratings, assessment dates and conditions. Historical certificates keep their original scope.</li>
    </ol></details>`;
}
