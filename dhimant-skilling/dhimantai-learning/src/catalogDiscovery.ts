import type { Course } from './api';
import { compareCourseActivity, nextChapter } from './courseProgress';
import type { CatalogCourse, PublicCatalog } from './learnerCatalog';

export type LearnerCourse = Course & {catalog?: CatalogCourse; outlineUnavailable?: boolean};

/** Institute courses come from the assigned syllabus. Individual enrolments can precede a published syllabus. */
export function learnerCourses(subjects: Course[], catalog?: PublicCatalog): LearnerCourse[] {
  const courses: LearnerCourse[] = subjects.map(course => {
    const match = catalog?.courses.find(c => c.id === course.project_coach?.course_id || c.title === course.name)
      ?? catalog?.courses.find(c => course.chapters.some(ch => c.chapters.some(item => item.id === ch.id)));
    return {...course, catalog:match};
  });
  if (catalog?.individual) {
    const matched = new Set(courses.map(c => c.catalog?.id));
    for (const entry of catalog.courses.filter(c => c.enrolled && !matched.has(c.id)))
      courses.push({name:entry.title, chapters:[], catalog:entry, outlineUnavailable:true});
  }
  return courses.sort(compareCourseActivity);
}

/** Teaching coverage is not an assessment or a certificate. */
export function lessonsCovered(course: CatalogCourse) {
  return !!course.chapters.length && course.chapters.every(ch => ch.progress?.status === 'covered');
}

export function courseLearningStatus(course: CatalogCourse): 'covered' | 'inProgress' | 'notStarted' | undefined {
  if (lessonsCovered(course)) return 'covered';
  if (course.chapters.some(ch => ['in_progress','covered','content_changed'].includes(ch.progress?.status ?? ''))) return 'inProgress';
  if (!course.enrolled || course.chapters.length && course.chapters.every(ch => ch.progress?.status === 'not_started')) return 'notStarted';
}

/** Transparent suggestions from actual study history; preserve the service's order on ties. */
export function courseSuggestions(courses: CatalogCourse[]) {
  const studied = courses.filter(c => c.enrolled && c.chapters.some(ch =>
    ['covered', 'in_progress', 'content_changed'].includes(ch.progress?.status ?? '')));
  const categories = new Set(studied.map(c => c.category).filter(Boolean));
  return courses.filter(c => !c.enrolled && c.can_join && !c.expired && c.category && categories.has(c.category))
    .slice(0, 3).map(course => ({course, reason:`More in ${course.category}`}));
}

export function resumeTopic(course: Pick<CatalogCourse, 'chapters'>, chapterId?: string) {
  const topics = course.chapters.find(ch => ch.id === chapterId)?.progress?.topics ?? [];
  return topics.find(topic => topic.status === 'in_progress' || topic.status === 'content_changed')?.title
    ?? topics.find(topic => topic.status === 'not_started')?.title;
}

export function coursePriceKind(course: CatalogCourse) {
  if (course.company_training) return 'company';
  if (course.is_free) return 'free';
  return course.chapters[0]?.free ? 'preview' : 'paid';
}

export function accessLabel(course: CatalogCourse): string {
  const kind = coursePriceKind(course);
  if (kind === 'free') return 'All chapters free';
  if (kind === 'company') return 'Company training';
  if (course.unlocked && !course.expired) return 'Full course unlocked';
  return kind === 'preview' ? 'Chapter 1 free' : 'Paid course';
}

export function applyTeachingChapters(courses: CatalogCourse[], lessons?: Course[]) {
  const byId = new Map(lessons?.flatMap(subject => subject.chapters.map(ch => [ch.id, ch] as const)));
  for (const course of courses.filter(c => c.enrolled)) {
    for (const chapter of course.chapters) {
      const lesson = byId.get(chapter.id);
      chapter.progress = lesson?.progress;
      chapter.locked = lessons ? !lesson || !!lesson.locked || !!lesson.expired : undefined;
    }
  }
}

export function openChapter(course: CatalogCourse, chapter: CatalogCourse['chapters'][number]) {
  return !course.expired && !chapter.locked && !!(chapter.free || course.unlocked || course.is_free);
}

/** Keep the chapter named on a card and the chapter opened by Instructor in sync. */
export function catalogChapter(course: CatalogCourse) {
  const accessible = course.chapters.filter(ch => openChapter(course, ch));
  return (course.enrolled ? nextChapter(accessible, () => true) : undefined) ?? accessible[0];
}

export function chapterActionLabel(course: CatalogCourse, chapter: CatalogCourse['chapters'][number]) {
  const number = course.chapters.indexOf(chapter) + 1;
  const status = chapter.progress?.status;
  if (status === 'content_changed') return 'Start updated chapter ' + number;
  if (status === 'covered') return 'Review chapter ' + number;
  return (status === 'in_progress' ? 'Resume chapter ' : 'Start chapter ') + number;
}
