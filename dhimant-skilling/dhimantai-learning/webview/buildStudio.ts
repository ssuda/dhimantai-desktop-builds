import {bindInstructorComposer} from './composer';
import './instructorCodeCell.css';
import {InstructorCodeCell} from './instructorCodeCell';
import type {CellSuggestion,BufferEdit} from '../src/studioJsx';
declare function acquireVsCodeApi():{postMessage(message:unknown):void};
const host=acquireVsCodeApi();
const send=(type:string,fields:object={})=>host.postMessage({type,...fields});
const byId=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const pending=new Map<number,(value:any)=>void>();
let sequence=0, runRevision=0;
function request<T>(type:string,fields:object):Promise<T> {
  const id=++sequence;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{pending.delete(id);resolve(undefined as T);},12000);
    pending.set(id,value=>{clearTimeout(timer);resolve(value);});send(type,{...fields,id});
  });
}
let busy=false, predict=false, attemptLabel='', draft=0, ownId='';
const field=byId<HTMLTextAreaElement>('message');
field.addEventListener('input',()=>draft++);
let voiceScope = '';
const composer=bindInstructorComposer(host,byId<HTMLFormElement>('composer'),async ({text,attachments})=>{
  const version=draft;
  const isPrediction=predict && byId<HTMLSelectElement>('replyType').value==='predict' && !attachments.length;
  try {
    const files=await composer.attachments.encoded(false,attachments);
    if(draft!==version||busy)return;
    send(isPrediction?'predict':'ask',isPrediction?{prediction:text,draft:version}:{message:text.trim()||'Explain my attachment.',attachments:files,draft:version});
  } catch(error){byId('status').textContent=String(error);}
});
function composerMode(){
  field.placeholder=predict&&byId<HTMLSelectElement>('replyType').value==='predict'?'What do you predict?':'Ask Instructor or reply…';
}
type ProjectLanguage = 'php' | 'sql' | 'jsx';
const languages = {php:'PHP', sql:'MySQL', jsx:'React JSX'};
const ownDrafts = new Map<ProjectLanguage, string>();
let example: {id:string; language:'php'|'sql'; source:string} | undefined;
let exampleDraft = '';
let ownLanguage: ProjectLanguage = 'php';
let cell: InstructorCodeCell | undefined;
let currentExecution: string | undefined;
let canRunApp = false;
const origin = byId<HTMLSelectElement>('origin');
function isExample() { return !!example && origin.value === 'example'; }
function publishDraft() {
  if (!cell) return;
  const language=cell.languagePicker.value;
  if(language==='jsx') return;
  send('draft', {draft:ownId, revision:++runRevision, language, source:cell.code.value, example:isExample()?example!.id:undefined});
}
function updateRun() {
  if (!cell) return;
  const jsx = !isExample() && ownLanguage === 'jsx';
  cell.runButton.textContent = jsx ? byId('run').textContent : 'Run';
  byId('run').hidden = !canRunApp || (jsx && byId<HTMLDetailsElement>('consoleBox').open);
  cell.runButton.disabled = busy || (jsx && !canRunApp);
  cell.languagePicker.disabled = busy || isExample();
  origin.disabled = busy;
}
function mountCell() {
  cell?.code.destroy();
  currentExecution = undefined;
  const authored = isExample();
  const language = authored ? example!.language : ownLanguage;
  cell = new InstructorCodeCell({
    id:'equipment-desk', key:'equipment-desk', languages, language,
    source:authored ? exampleDraft : ownDrafts.get(language) ?? '',
    note:language === 'jsx' ? 'Run App opens the saved React project.' :
      (authored ? 'Instructor example' : 'My snippet')+' · Equipment Desk '+attemptLabel,
    changed:() => {
      if (!cell) return;
      if (authored) exampleDraft = cell.code.value;
      else ownDrafts.set(language, cell.code.value);
      publishDraft();
      currentExecution = undefined;
      cell.resultBlock.hidden = true;
      updateRun();
    },
    changeLanguage:value => { ownLanguage = value as ProjectLanguage; mountCell(); },
    complete:(source,offset) => request<CellSuggestion[]>('suggest',{language,source,offset}).then(r=>r??[]),
    resolve:language === 'jsx' ? (ticket,source,offset) => request<BufferEdit[]|undefined>('resolve',{ticket,source,offset}) : undefined,
    run:() => {
      if (busy || !cell) return;
      if (language === 'jsx') { if (canRunApp) send('run'); return; }
      currentExecution = crypto.randomUUID();
      send('runSnippet', {draft:ownId, language, source:cell.code.value, revision:runRevision, execution:currentExecution});
      updateRun();
    },
  });
  byId('projectCell').replaceChildren(cell.element);
  publishDraft();
  updateRun();
}
origin.addEventListener('change', mountCell);
byId('consoleBox').addEventListener('toggle', updateRun);
byId('replyType').addEventListener('change',()=>{composer.dictation?.cancel();composerMode();});
function busyState(value:boolean) {
  busy=value;composer.setAvailable(!value);
  composer.dictation?.setScope(value ? '' : voiceScope);
  for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) button.disabled=value;
  updateRun();
}
window.addEventListener('message',event=>{
  const m=event.data;
  if(m.type==='audioOff'){composer.dictation?.cancel();composer.cancelCapture();return;}
  if(m.type==='accepted'){
    if(draft===m.draft){field.value='';field.dispatchEvent(new Event('input'));composer.attachments.clear();}return;
  }
  if(m.type==='result') {pending.get(m.id)?.(m.result);pending.delete(m.id);return;}
  if(m.type==='busy') {busyState(m.value);return;}
  if(m.type==='status') {byId('status').textContent=m.text;return;}
  if(m.type==='console') {
    if(cell && currentExecution===m.execution) {
      const result=m.result;
      if(result.error) cell.output.textContent=result.error+(result.line?' · line '+result.line:'');
      else if(Array.isArray(result.columns)) cell.output.textContent=result.columns.length ?
        [result.columns,...result.rows].map((row:unknown[])=>row.join('\t')).join('\n') : 'Query completed.';
      else cell.output.textContent=[result.stdout, result.notice ?? JSON.stringify(result.value,null,2)].filter(Boolean).join('\n');
      cell.resultBlock.hidden=false;cell.output.hidden=false;
    }
    return;
  }
  if(m.type!=='state') return;
  voiceScope=m.voiceScope;
  composer.dictation?.setScope(busy ? '' : voiceScope);
  composer.playback?.reply(m.audioId);
  byId('title').textContent=m.title;byId('concept').textContent=m.concept;
  byId('task').textContent=m.task;byId('question').textContent=m.question;
  byId('practice').hidden=!m.offerPractice;byId('retry').hidden=!m.retry;
  predict=!!m.predict && !m.prediction;
  byId('replyKind').hidden=!predict;composerMode();composer.setAvailable(!busy);
  byId('run').hidden=predict || m.offerPractice;
  byId('run').textContent=m.practice?'Run App · Practice inventory':'Run App';
  byId('demo').hidden=!m.demo;byId('next').hidden=!m.next;
  byId('check').hidden=m.next;byId('assignment').hidden=!m.guided;
  byId('history').replaceChildren(...m.history.map((s:string)=>{const p=document.createElement('p');p.textContent=s;return p;}));
  attemptLabel=m.attemptLabel;
  if(!ownId){ownId=m.draft;runRevision=m.draftRevision??0;}
  canRunApp=!byId('run').hidden;
  byId('originChoice').hidden=!m.example;
  if(m.example?.id !== example?.id) {
    example=m.example;
    exampleDraft=example?.source??'';
    origin.value=example?'example':'own';
    if(example)byId<HTMLDetailsElement>('consoleBox').open=true;
    mountCell();
  } else if(!cell) mountCell();
  updateRun();
});
document.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if(button && !button.closest('.practice-code-editor') && !busy) send(button.dataset.action!);
});
send('ready');
