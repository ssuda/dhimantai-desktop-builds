import type { Environment } from './environments';

export interface CatalogCourse {
  id: string; title: string; summary: string; level: string; prerequisites: string;
  can_join: boolean; enrolled: boolean; unlocked?: boolean; is_free?: boolean;
  /** Days of access from joining or the latest purchase; after access_until every chapter locks (expired). */
  access_days?: number; access_until?: string | null; expired?: boolean;
  /** Catalog grouping only (Software Engineering, AI & Machine Learning, AI for Professionals). */
  category?: string;
  chapters: { id: string; name: string; lesson?: string; free?: boolean }[];
}
export interface LearningOffer { id: string; title: string; amount: number; currency: string; course_ids: string[]; owned: boolean }
export interface PublicCatalog { individual: boolean; courses: CatalogCourse[]; offers?: LearningOffer[] }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'});
/** Access runs for access_days from joining or the latest purchase; then every chapter locks, the first included. */
export function accessPeriod(course: CatalogCourse): string {
  if (course.expired && course.access_until) return `Access ended ${day(course.access_until)}${course.is_free ? '' : ' · Buy again to continue'}`;
  if (course.access_until) return `Access until ${day(course.access_until)}`;
  return course.access_days ? `${course.access_days} days of access` : '';
}

/** Only these purpose-built RPCs are available to the extension, with the learner's own token. */
export async function learnerRpc<T>(env: Environment,
    name: 'public_learning_catalog' | 'complete_individual_signup' | 'join_learning_course',
    body: object = {}, token?: string): Promise<T> {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${token ?? env.supabaseAnonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404 || data.code === 'PGRST202') {
      throw new Error('Individual signup and the course catalog are not available on this service yet. Update the service or choose another DhimantAI environment.');
    }
    throw new Error(typeof data.message === 'string' ? data.message : `Could not complete this request (${response.status}). Please retry.`);
  }
  return data as T;
}
