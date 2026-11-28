import type {EditorTool} from './courseEditorTools';
export type StudioMode = 'guided'|'independent';
export type LessonId = 'request'|'php';
export interface StudioEntry {
  id:LessonId; checkpoint:string; commit:string; title:string; file:string; symbol:string;
  concept:string; task:string; demonstration?:{before:string;after:string};
}
export interface StudioDefinition { editor_extensions:EditorTool[]; version:string; items:string[]; quantity:{min:number;max:number}; entries:StudioEntry[] }
export interface StudioAccess {
  id:string; mode:StudioMode; entry:LessonId; lesson:LessonId;
  release:{version:string; image:string; checkpoints:Record<string,string>};
}
export interface StudioReply {guidance:string; example?:{language:'php'|'sql';source:string}}
