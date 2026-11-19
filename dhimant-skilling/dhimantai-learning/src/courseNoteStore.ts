import type {TutorNotebook} from './tutorNotebook';
import {TutorNotebookStore} from './tutorNotebookStore';

export interface CourseNote {scope:string; id:string; chapter:string; text:string}
export async function readCourseNotes(directory:string, environment:string, account:string,
    scopes:{scope:string; chapter:string}[]):Promise<CourseNote[]> {
  const notes:CourseNote[] = [];
  for (const item of scopes) {
    const store = new TutorNotebookStore(directory, environment, account + item.scope);
    const book = await store.load();
    notes.push(...book.cells.filter(cell => cell.kind === 'note' && cell.text.trim()).map(cell => ({...item, id:cell.id, text:cell.text})));
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
