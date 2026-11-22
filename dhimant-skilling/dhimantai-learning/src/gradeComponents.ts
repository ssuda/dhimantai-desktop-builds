import type { CourseGrade } from './courseworkProgress';
import { progressBar } from './uiTheme';

export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

const iconPaths = {
  lock: 'M5 11h14v10H5z M8 11V8a4 4 0 0 1 8 0v3',
  check: 'm4 12 5 5L20 6',
  book: 'M2 5q6-2 10 1 4-3 10-1v14q-6-2-10 1-4-3-10-1z M12 6v14',
  target: 'M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0 M18 12a6 6 0 1 1-12 0 6 6 0 1 1 12 0 M14 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0',
  code: 'm7 7-5 5 5 5m10-10 5 5-5 5m-3-14-4 18',
  layers: 'm2 8 10-5 10 5-10 5z M2 12l10 5 10-5 M2 16l10 5 10-5',
  briefcase: 'M3 7h18v13H3z M8 7V4h8v3 M3 12q9 5 18 0',
  observe: 'M2 12q10-16 20 0-10 16-20 0z M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M9 22h6',
  branch: 'M6 7v10 M7 14q10 0 10-7 M8 5a2 2 0 1 1-4 0 2 2 0 1 1 4 0 M8 19a2 2 0 1 1-4 0 2 2 0 1 1 4 0 M19 5a2 2 0 1 1-4 0 2 2 0 1 1 4 0',
  file: 'M5 2h9l5 5v15H5z M14 2v6h5',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5 M12 17v.2',
  refresh: 'M20 7v5h-5 M19.5 12a7.5 7.5 0 1 0-2 5.2 M20 12a8 8 0 0 0-2-5',
  medal: 'M17 8a5 5 0 1 1-10 0a5 5 0 1 1 10 0 M8.5 12l-2 8 5.5-3 5.5 3-2-8',
  info: 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0 M12 11v5 M12 8v.2',
  warning: 'M12 3 22 20H2L12 3Z M12 9v4 M12 16v.2',
  checklist: 'm3 7 2 2 3-4 M11 7h10 M3 15l2 2 3-4 M11 15h10',
  clock: 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0 M12 7v5l3 2',
};
export function icon(name: keyof typeof iconPaths) {
  return `<svg class="certificate-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${iconPaths[name]}"/></svg>`;
}

export type ActionButton = (text: string, action: string, id?: string, disabled?: boolean) => string;
const unpublishedActivities = 'No required activities published';
export function activityProgress(grade: CourseGrade) {
  const published = grade.required_count > 0;
  const label = published ? `${grade.passed_count} of ${grade.required_count}` : 'Not set yet';
  const caption = published ? 'required activities passed' : unpublishedActivities;
  return `<div class="activity-progress"><div class="activity-count"><span class="icon-tile">${icon(published ? 'checklist' : 'clock')}</span>
    <div><strong>${escape(label)}</strong> <small>${caption}</small></div></div>
    ${published ? progressBar(grade.passed_count, grade.required_count, label + ' ' + caption) : ''}</div>`;
}

export function attention(messages: string[]) {
  return `<div class="course-attention"><strong class="attention-title">${icon('warning')}Needs attention</strong>
    <ul>${messages.map(message => `<li>${escape(message)}</li>`).join('')}</ul></div>`;
}

export function gradingGuide(policy?: CourseGrade['policy']) {
  let practice = '';
  if (policy?.version === 'coursework-v1' && policy.project_weight !== undefined && policy.exercise_weight !== undefined
      && policy.pass_percent !== undefined && policy.mastery_percent !== undefined) {
    practice = `<li>Practice grades weight projects ${escape(policy.project_weight)}% and exercises ${escape(policy.exercise_weight)}%. Without projects, exercises count for 100%.</li>
      <li>Each activity needs ${escape(policy.pass_percent)}%. Your best valid score counts.</li>
      <li>Each topic needs ${escape(policy.mastery_percent)}% mastery and independent passes on two exercises (one if only one is assigned).</li>`;
  } else if (policy?.description) {
    practice = `<li>${escape(policy.description)}</li>`;
  }
  return `<section class="grading-guide"><h2>${icon('info')}How certificates are graded</h2><ul>${practice}
    <li>Pass your independent roadmap assessments to earn a certificate. Coursework has no final exam.</li></ul></section>`;
}
