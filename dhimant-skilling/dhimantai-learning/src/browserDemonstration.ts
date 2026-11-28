/** No selectors, scripts, arbitrary URLs or values cross the Instructor action boundary. */
export const BROWSER_ACTIONS=['open_source','prepare_draft','fill_routine','inspect_result','show_task'] as const;
export interface BrowserDemonstration {
  id:string; task:string; snapshot:string; action:typeof BROWSER_ACTIONS[number];
}
export interface DemonstrationResult {status:'completed'|'failed'|'rejected'|'interrupted'|'uncertain'; message:string; duration_ms?:number; evidence?:string}
export function validDemonstration(value:unknown):value is BrowserDemonstration {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).sort().join(',')==='action,id,snapshot,task'&&typeof v.id==='string'&&/^[a-f0-9]{32}$/.test(v.id)
    &&typeof v.snapshot==='string'&&/^[a-f0-9]{32}$/.test(v.snapshot)&&typeof v.task==='string'
    &&(v.action==='show_task' ? /^[a-z0-9-]{1,40}$/.test(v.task) : ['stock','payables','delivery','receivables'].includes(v.task))
    &&BROWSER_ACTIONS.includes(v.action as typeof BROWSER_ACTIONS[number]);
}
export function validDemonstrationResult(value:unknown):value is DemonstrationResult {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).every(k=>['status','message','duration_ms','evidence'].includes(k))
    &&['completed','failed','rejected','interrupted','uncertain'].includes(String(v.status))
    &&typeof v.message==='string'&&v.message.length<=600
    &&(v.duration_ms===undefined||typeof v.duration_ms==='number'&&Number.isFinite(v.duration_ms)&&v.duration_ms>=0&&v.duration_ms<=60000)
    &&(v.evidence===undefined||typeof v.evidence==='string'&&v.evidence.length<=1800);
}
