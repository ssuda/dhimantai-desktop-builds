import { createHash } from 'node:crypto';

/** UUIDv5: retries reuse an id, but edited files or prerequisite evidence start a new submission. */
export function evidenceRequestId(namespace:string,evidence:object):string {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace))throw new Error('Refresh the evidence form before submitting.');
  const bytes=createHash('sha1').update(Buffer.from(namespace.replaceAll('-',''),'hex')).update(JSON.stringify(evidence)).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export interface SkillingProfile {
  course_id: string; title: string; role: string; level: string; certifiable: boolean; fingerprint: string;
  technology_stack: string[]; prerequisites: string[]; recommended_next: string[]; outcomes: string[];
  criteria: Record<string,string>; rubrics?:Record<string,Record<string,string>>; scope: string; project_theme: string;
}
export interface SkillingReview {
  ratings: Record<string,{rating:number;evidence:string}>; conditions:string; task:string; next_step:string;
  observed:boolean; identity_checked:boolean; unfamiliar_task:boolean; passed:boolean; score:number;
}
export interface Readiness {
  profile: SkillingProfile | null; eligible:boolean; score:number|null; blockers:string[];
  lesson_access?:{reason:string;lessons:string[]}|null;
  milestones:{id:string;title:string;status:string;unlocked:boolean;lock_reason?:string|null;basis:unknown;submission_id:string|null;review:SkillingReview|null}[];
}
export interface WeeklyAttempt {
  id:string;week_start:string;submission_id:string|null;
  questions:{id:string;topic:string;topic_key:string;prompt:string}[];review?:SkillingReview|null;
}
export interface SkillingPathway {
  pathway:Readiness;current_week:string;course_titles?:Record<string,string>;
  topics:{key:string;topic:string;ready:boolean;challenges:{id:string;title:string;difficulty:string;prompt:string}[];interview:string[]}[];
  weekly:WeeklyAttempt[];
}
export interface SkillingBrief {
  course_id:string;course_title:string;kind:string;profile_hash:string;language:string;
  brief:{title:string;requirements:string;milestones:{id:string;title:string;task:string}[]};
}
export const PREVIEW_PORTS = [8000, 8080, 3000, 5173, 8501] as const;
export const previewPublishArgs = PREVIEW_PORTS.flatMap(port => ['--publish', `127.0.0.1::${port}/tcp`]);
/** Never open a public bind, remote host, wildcard address or arbitrary URI from container metadata. */
export function previewUrl(mapping:string):string {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(mapping.trim());
  if (!match || +match[1]<1 || +match[1]>65535) throw new Error('This preview port is not bound to localhost. Rebuild the course runtime.');
  return `http://127.0.0.1:${+match[1]}/`;
}
