import type { DOMWindow } from 'jsdom';

export const lessonPicker = '<section id="tutor-lessons"><select id="lesson-course"></select><div id="lesson-list"></div><button id="lesson-catalog"></button></section><button id="skip-chapter" hidden>Skip chapter →</button>';
export const chapterId = '10000000-0000-0000-0000-000000000001';
export function selectLesson(w: DOMWindow, attempt: number) {
  w.dispatchEvent(new w.MessageEvent('message', {origin:w.location.origin, data:{type:'tutorLessons', attempt,
    courses:[{name:'Python', chapters:[{id:chapterId, name:'Lists'}, {id:'locked', name:'Functions', locked:true}]}]}}));
  w.document.querySelector<HTMLButtonElement>('#lesson-list button')!.click();
}
