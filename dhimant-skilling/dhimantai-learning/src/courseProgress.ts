/** Teaching coverage, shared by the catalog, lesson picker and course tree. */
export type CoverageStatus = 'not_started' | 'in_progress' | 'covered' | 'content_changed' | 'unavailable';
export interface TopicCoverage {id: string; title: string; parent?: string; status: CoverageStatus; needs_review?: boolean}
export interface ChapterCoverage {
  status: CoverageStatus; covered: number; total: number; topics: TopicCoverage[];
  needs_review?: number; updated_at?: string | null;
}
export const coverageNote = 'Covered means taught by Instructor. Practice and mastery are tracked separately.';
export function coverageLabel(progress?: ChapterCoverage): string {
  if (!progress || progress.status === 'unavailable') return 'Progress unavailable';
  if (progress.status === 'content_changed') return 'Content updated · Revisit';
  const label = {not_started:'Not started', in_progress:'In progress', covered:'Covered'}[progress.status];
  return label + (progress.status === 'in_progress' && progress.total ? ` · ${progress.covered}/${progress.total} topics covered` : '')
    + (progress.needs_review ? ' · Needs review' : '');
}
export function courseCoverage(chapters: {progress?: ChapterCoverage}[]): string {
  if (!chapters.length) return '';
  const covered = chapters.filter(ch => ch.progress?.status === 'covered').length;
  const started = chapters.filter(ch => ch.progress?.status === 'in_progress').length;
  const remaining = chapters.filter(ch => ch.progress?.status === 'not_started').length;
  const changed = chapters.filter(ch => ch.progress?.status === 'content_changed').length;
  const unknown = chapters.length - covered - started - remaining - changed;
  if (unknown === chapters.length) return 'Progress unavailable';
  return `${covered}/${chapters.length} chapters covered · ${started} in progress · ${remaining} not started`
    + (changed ? ` · ${changed} to revisit` : '') + (unknown ? ` · ${unknown} unavailable` : '');
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function topicCoverageHtml(progress?: ChapterCoverage): string {
  if (!progress?.topics.length) return '';
  return `<ul class="topic-coverage">${progress.topics.map(topic => `<li>${topic.status === 'covered'
    ? `✓ <s>${escape(topic.title)}</s> <small>Covered${topic.needs_review ? ' · Needs review' : ''}</small>`
    : `${escape(topic.title)} <small>${coverageLabel({status:topic.status, covered:0, total:0, topics:[], needs_review:topic.needs_review ? 1 : 0})}</small>`}</li>`).join('')}</ul>`;
}

/**
 * The one chapter a learner should open next, shared by Course Catalog and the lesson picker:
 * a chapter in progress (or changed since it was taught), else the first open chapter not yet covered.
 * Without any saved progress there is no recommendation, so nothing is presented as started.
 */
export function nextChapter<T extends {progress?: ChapterCoverage}>(chapters: T[], isOpen: (chapter: T) => boolean): T | undefined {
  if (!chapters.some(ch => ch.progress && ch.progress.status !== 'unavailable')) return undefined;
  const open = chapters.filter(isOpen);
  return open.find(ch => ch.progress?.status === 'in_progress' || ch.progress?.status === 'content_changed')
    ?? open.find(ch => ch.progress?.status !== 'covered');
}
