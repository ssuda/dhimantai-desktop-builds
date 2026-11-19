import type { CatalogCourse } from './learnerCatalog';

/** Teaching coverage is not an assessment or a certificate. */
export function lessonsCovered(course: CatalogCourse) {
  return !!course.chapters.length && course.chapters.every(ch => ch.progress?.status === 'covered');
}

/** Transparent suggestions from actual study history; preserve the service's order on ties. */
export function courseSuggestions(courses: CatalogCourse[]) {
  const studied = courses.filter(c => c.enrolled && c.chapters.some(ch =>
    ['covered', 'in_progress', 'content_changed'].includes(ch.progress?.status ?? '')));
  const categories = new Set(studied.map(c => c.category).filter(Boolean));
  return courses.filter(c => !c.enrolled && c.can_join && !c.expired && c.category && categories.has(c.category))
    .slice(0, 3).map(course => ({course, reason:`Explore more in ${course.category}, based on your learning so far.`}));
}

export function resumeTopic(course: CatalogCourse, chapterId?: string) {
  const topics = course.chapters.find(ch => ch.id === chapterId)?.progress?.topics ?? [];
  return topics.find(topic => topic.status === 'in_progress' || topic.status === 'content_changed')?.title
    ?? topics.find(topic => topic.status === 'not_started')?.title;
}
