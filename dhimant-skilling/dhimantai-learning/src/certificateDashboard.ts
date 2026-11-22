import { ApiError } from './api';
import type { CatalogCourse } from './learnerCatalog';
import type { CourseCertificate, CourseGrade } from './courseworkProgress';

export interface CertificateCourse {
  id: string; title: string; expired?: boolean; grade?: CourseGrade; error?: string;
}
export type CertificateStatus = 'completed' | 'eligible' | 'progress' | 'unavailable';
export function certificateStatus(course: CertificateCourse, certificates: CourseCertificate[]): CertificateStatus {
  if (certificates.some(c => c.course_id === course.id && !c.revoked_at)) return 'completed';
  if (!course.grade) return 'unavailable';
  return course.grade.eligible ? 'eligible' : 'progress';
}

/** Keep the catalog usable when one result fails; bound concurrent gradebook requests. */
export async function loadCertificateCourses(courses: CatalogCourse[], grade: (id: string) => Promise<CourseGrade>, active = () => true): Promise<CertificateCourse[]> {
  const results: CertificateCourse[] = courses.filter(c => c.enrolled).map(c => ({id:c.id, title:c.title, expired:c.expired}));
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4, results.length)}, async () => {
    while (next < results.length && active()) {
      const item = results[next++];
      try { item.grade = await grade(item.id); }
      catch (error) {
        if (item.expired) item.error = 'Course access has ended. Renew access to check remaining requirements.';
        else if (error instanceof ApiError && error.status === 404) item.error = error.message;
        else item.error = 'Requirements could not be loaded. Refresh to try again.';
      }
    }
  }));
  return results;
}
