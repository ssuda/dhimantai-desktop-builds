import type {EditorTool} from './courseEditorTools';
export type StudioMode = 'guided'|'independent';
// Stable published syllabus IDs. build_starters.py ships the corresponding project entries.
export const equipmentDeskChapters = {
  '6050fa5c-6bfc-5532-a4b9-39e464db5810': 'request',
  '70b4d92f-63de-53bb-affc-1307a9fd387e': 'php',
  '34d9fc95-4cce-54aa-a875-bc408b5b5e0c': 'schema',
  'bd266003-8eea-5c89-b723-6ef46c9471fb': 'validation',
  '5e61e7c8-4c56-5011-99e8-8eec4a21945b': 'transactions',
  'ef868c75-e6f7-5d38-b44d-a97412fd3a2d': 'react',
  '338b3a77-116e-5ae0-837b-a5c43c8d9242': 'testing',
  '81722c06-88bf-5c98-85ec-855d8eae5f45': 'capstone',
} as const;
export type LessonId = typeof equipmentDeskChapters[keyof typeof equipmentDeskChapters];
export function equipmentLesson(chapter: string): LessonId | undefined {
  return Object.hasOwn(equipmentDeskChapters, chapter) ? equipmentDeskChapters[chapter as keyof typeof equipmentDeskChapters] : undefined;
}
export interface StudioEntry {
  id:LessonId; checkpoint:string; commit:string; title:string; file:string; symbol:string;
  concept:string; task:string; checks?:string[]; assignment?:string; demonstration?:{before:string;after:string};
}
export interface StudioDefinition { editor_extensions:EditorTool[]; version:string; items:string[]; quantity:{min:number;max:number}; entries:StudioEntry[] }
export interface StudioAccess {
  id:string; mode:StudioMode; entry:LessonId; lesson:LessonId;
  release:{version:string; image:string; checkpoints:Record<string,string>};
}
export interface StudioReply {guidance:string; example?:{language:'php'|'sql';source:string}}
