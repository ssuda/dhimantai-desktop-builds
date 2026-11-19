import type {BrowserTask, VerifiedTask} from './browserLearning';
import type {EnvironmentName} from './environments';

export const ERP_COURSE = 'ERPNext Essentials';
export const verifiedKey = (environment:EnvironmentName, account:string) => `browser.erpnext.verified.${environment}.${account}`;
export type BrowserTaskStatus = 'completed' | 'checked' | 'not_started';
export interface BrowserCourseProgress {
  tasks: {id:string; chapter:string; title:string; status:BrowserTaskStatus}[];
}
export const browserProgressNote = 'Saved on this computer. Completed means the ERPNext record was checked and your explanation was recorded.';

/** Use the desktop's verified records, never the currently open form or Instructor coverage. */
export function browserCourseProgress(tasks:BrowserTask[], verified:Record<string,VerifiedTask> = {}):BrowserCourseProgress {
  return {tasks:tasks.map(task => {
    const saved = verified[task.id];
    const checked = !!saved?.record && Number.isFinite(Date.parse(saved.checkedAt));
    return {id:task.id, chapter:task.instructorChapter, title:task.title || task.doctype,
      status:checked ? saved.explained === true ? 'completed' : 'checked' : 'not_started'};
  })};
}
export function browserTaskLabel(status?:BrowserTaskStatus) {
  return status === 'completed' ? 'Completed' : status === 'checked' ? 'Checked · Explanation pending' : status === 'not_started' ? 'Not completed' : 'Task progress unavailable';
}
export function browserProgressLabel(progress?:BrowserCourseProgress) {
  return progress ? `${progress.tasks.filter(task => task.status === 'completed').length}/${progress.tasks.length} tasks completed` : 'Task progress unavailable';
}
