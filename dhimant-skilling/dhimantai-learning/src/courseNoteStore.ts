import type {TutorNotebook} from './tutorNotebook';
import {savedPractice} from './practiceNotebook';
import {TutorNotebookStore} from './tutorNotebookStore';

export interface CourseNote {scope:string; id:string; chapter:string; text:string}
function notebookNotes(book:TutorNotebook, location:{scope:string; chapter:string}):CourseNote[] {
  return book.cells.filter(cell => cell.kind === 'note' && cell.text.trim())
    .map(cell => ({...location, id:cell.id, text:cell.text}));
}

export async function readCourseNotes(directory:string, environment:string, account:string,
    scopes:{scope:string; chapter:string}[], practiceCourse?:string):Promise<CourseNote[]> {
  const notes:CourseNote[] = [];
  for (const item of scopes) {
    const store = new TutorNotebookStore(directory, environment, account + item.scope);
    const book = await store.load();
    notes.push(...notebookNotes(book, item));
  }
  if (practiceCourse) {
    const history = await TutorNotebookStore.practiceHistory(directory, environment, account);
    for (const {notebook} of history) {
      const task = savedPractice(notebook, account);
      if (task?.course === practiceCourse)
        notes.push(...notebookNotes(notebook, {scope:'\0practice:' + task.id, chapter:'Practice · ' + task.title}));
    }
  }
  return notes;
}

export async function writeCourseNote(store:TutorNotebookStore, book:TutorNotebook, note:CourseNote, expected:string) {
  const cell = book.cells.find(cell => cell.id === note.id && cell.kind === 'note');
  if (!cell || cell.text !== expected) throw new Error('This note changed in its lesson.');
  const updated = {...book, cells:book.cells.map(item => item === cell ? {...cell, text:note.text} : item)};
  await store.save(updated);
  return updated;
}
