/** Shared wire types; reading progress is position, never an assessment. */
export interface ReadingLink { label: string; url: string }
export interface StudyChapter { id: string; title: string; markdown: string; revision?: string }
export interface CompanionCourse {
  id: string; title: string; author: string; summary: string; preparation: string;
  reading: ReadingLink[]; chapters: StudyChapter[];
}
export interface StudySource extends StudyChapter { course: string; reading: ReadingLink[]; revision: string }
export type StudyAction = 'explain' | 'summary' | 'quiz' | 'ask';
export interface StudyQuiz { question: string; options: string[]; correct: number; explanation: string; source_quote: string }
export interface StudyReply { content: string; questions: StudyQuiz[]; source_id: string; revision: string }
export function studyAction(value: unknown): value is StudyAction {
  return typeof value === 'string' && ['explain','summary','quiz','ask'].includes(value);
}
export function readingUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
/** Never persist unbounded reader or webview data. */
export function readingCursor(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 1200 && /^epubcfi\([\d\w\[\](),;=!@~.*^:+\/-]+\)$/.test(value) ? value : undefined;
}
export function readingFontSize(value: unknown): string {
  return typeof value === 'string' && ['100%', '125%', '150%'].includes(value) ? value : '100%';
}
