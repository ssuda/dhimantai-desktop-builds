import { AgentRoom, AgentGrant } from './agentRoom';
import { NotebookAttachments } from './notebookAttachments';
import { diagram } from './diagram';
import { StudyCropSelector, uploadStudyCrop, type CropImage } from './studyCrop';
import { bindComposer, resizeComposer } from './composer';
import { showStudyQuiz } from './studyQuiz';
import { showStudyResponse } from './studyResponse';
import 'katex/dist/katex.min.css';
import type { StudySource, StudyAction, StudyReply } from '../src/studyContent';
import type { PdfStudyReader } from './studyPdf';
import './study.css';
import './composer.css';

declare function acquireVsCodeApi(): {postMessage(value: unknown): void};
declare const initReader: (source: ArrayBuffer, options: object) => void;
declare const epubControls: {destroy():void;nextPage():void; prevPage():void; setFontSize(value:string):void; goToCfi(value:string):void; clearSelection():void};
const host = acquireVsCodeApi();
let pdfReader: PdfStudyReader | undefined;
const readerControls = () => pdfReader ?? epubControls;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = (id: string) => el<HTMLButtonElement>(id);
const courses = btn('course'), chapters = el<HTMLSelectElement>('chapter');
const questionField = el<HTMLTextAreaElement>('question');
questionField.setAttribute('aria-label','Ask Study');
questionField.rows=1;
const studyDialog = el<HTMLDialogElement>('study-dialog');
let choices: {id:string;title:string;chapters:{id:string;title:string}[]}[] = [];
let courseId = '';
let source: StudySource | undefined, documentKey = '', selected = '', ai = false, busy = false, generation = 0;
let signedIn = false, visible = true;
let cropImage:CropImage|undefined, cropSelector:StudyCropSelector;
let atStart = true, atEnd = true;
const post = (data: object) => host.postMessage({...data, documentKey});

let roomReady=false, requestId='', deliveredQuiz='', responding=false;
let submittedDraft='';
let exchange:HTMLElement|undefined;
const writtenCards = new Set<string>();
let action:StudyAction|undefined;
let screen:StudyAction = 'ask';
let screenScroll = 0;
interface ScreenState { draft:string; nodes:Node[]; scroll:number; attachments:File[] }
const screens = new Map<StudyAction, ScreenState>();
let responseTimer:ReturnType<typeof setTimeout>|undefined;
let grantWait:{resolve:(grant:AgentGrant)=>void;reject:(error:Error)=>void}|undefined;
function finishHelp(error='') {
  if(error)responding=false;
  clearTimeout(responseTimer);busy=false;controls();
  el('help-status').textContent=error||'Ready for your next question.';
}
const agentRoom=new AgentRoom({
  packet(packet) {
    if(!source||!requestId||!exchange?.isConnected)return false;
    if(packet.study_request_id!==requestId)return false;
    if(packet.method==='on_viva_questions') {
      if(action!=='quiz'||deliveredQuiz===requestId||!Array.isArray(packet.questions)||packet.questions.length!==3)return false;
      const questions=packet.questions.map((q:any)=>({question:q.question_text,options:q.options,correct:typeof q.correct_option==='string'&&/^[ABCD]$/.test(q.correct_option)?'ABCD'.indexOf(q.correct_option):-1,explanation:q.explanation,source_quote:''}));
      if(questions.some((q:any)=>typeof q.question!=='string'||!Array.isArray(q.options)||q.options.length!==4||q.options.some((o:unknown)=>typeof o!=='string')||q.correct<0||typeof q.explanation!=='string')){
        finishHelp('The quiz could not be displayed. Ask again.');return false;
      }
      deliveredQuiz=requestId;el('questions').replaceChildren();showReply({content:'Try these three practice questions.',questions,source_id:source.id,revision:source.revision});finishHelp();
    }else if(['display_on_screen','write_on_whiteboard'].includes(packet.method)&&typeof packet.content==='string'&&packet.content.trim()){
      // A later authored practice question must not erase its explanation.
      // Reliable data and RPC can deliver the same card; render it only once.
      if(!writtenCards.has(packet.content)) {
        writtenCards.add(packet.content);
        const card=document.createElement('section');card.className='study-answer-card';
        showStudyResponse(card,packet.content,action==='summary',packet.is_question_prompt===true);
        exchange.append(card);
        if(studyDialog.open)card.querySelector('.study-your-turn')?.scrollIntoView({block:'start'});
      }
      if(action==='ask'&&questionField.value===submittedDraft){questionField.value='';resizeComposer(questionField);attachments.clear();}
      if(action!=='quiz')finishHelp();
    }else if(packet.method==='draw_svg'&&typeof packet.svg==='string'){
      exchange.insertAdjacentHTML('beforeend',diagram(packet.svg));
    }else return false;
    return true;
  },
  state(state){responding=state==='thinking'||state==='speaking';controls();},
  error(message){roomReady=false;finishHelp(message);}
});
const attachments=new NotebookAttachments(el('attachments'),el('attachment-status'),controls);
btn('send').querySelector('svg')!.insertAdjacentHTML('beforeend','<rect class="stop-icon" x="7" y="7" width="10" height="10" rx="1"/>');
function disconnectAgent(){requestId='';roomReady=false;responding=false;void agentRoom.close();grantWait?.reject(new Error('The Study chapter changed.'));grantWait=undefined;clearTimeout(responseTimer);}
function syncSound(){agentRoom.sound(visible&&studyDialog.open&&btn('sound').getAttribute('aria-pressed')==='true');}
function openStudy(requestedAction?:StudyAction){
  const target = requestedAction ?? screen;
  if(studyDialog.open)screenScroll=el('study-content').scrollTop;
  if(target !== screen) {
    // Detach the entire view so quiz choices, folds, references and scroll state survive.
    disconnectAgent();
    screens.set(screen,{draft:questionField.value,nodes:Array.from(el('study-content').childNodes),scroll:screenScroll,attachments:attachments.snapshot()});
    const saved = screens.get(target);
    el('study-content').replaceChildren(...(saved?.nodes ?? freshContent()));
    questionField.value = saved?.draft ?? '';
    attachments.restore(saved?.attachments ?? []);
    screenScroll = saved?.scroll ?? 0;
    screen = target;
  }
  el('help-title').textContent={explain:'Explain selection',summary:'Chapter summary',quiz:'Chapter quiz',ask:'Ask Study'}[screen];
  if(!studyDialog.open)studyDialog.showModal();
  el('study-content').scrollTop=screenScroll;
  resizeComposer(questionField);controls();syncSound();
}
// A clean, locally authored shell. Generated content never becomes a template.
const contentTemplate = el('study-content').cloneNode(true) as HTMLElement;
function freshContent(): Node[] { return Array.from(contentTemplate.cloneNode(true).childNodes); }
function closeStudy(){
  screenScroll=el('study-content').scrollTop;
  studyDialog.close();syncSound();
  if(busy){disconnectAgent();finishHelp('Request stopped. Ask again when ready.');}
}
btn('open-study').onclick=()=>{openStudy('ask');questionField.focus();};
btn('close-study').onclick=closeStudy;
studyDialog.addEventListener('cancel',event=>{event.preventDefault();closeStudy();});
btn('sound').onclick=()=>{
  const enabled=btn('sound').getAttribute('aria-pressed')!=='true';
  btn('sound').setAttribute('aria-pressed',String(enabled));
  btn('sound').title=enabled?'Mute speaker':'Unmute speaker';
  btn('sound').setAttribute('aria-label',btn('sound').title);syncSound();
};
btn('dismiss-selection').onclick=()=>{readerControls().clearSelection();selected='';el('selection').hidden=true;controls();};
cropSelector=new StudyCropSelector({button:btn('crop'),overlay:el('crop-overlay'),box:el('crop-box'),apply:btn('apply-crop'),cancel:btn('cancel-crop'),status:el('crop-status'),viewer:el('viewer'),
  available:()=>!!source&&ai&&!busy,
  image(image){cropImage=image;el('crop-toolbar').hidden=!image;const preview=el<HTMLImageElement>('crop-preview');
    if(image){preview.src=image.dataUrl;selected='';el('selection').hidden=true;readerControls().clearSelection();}else preview.removeAttribute('src');},changed:controls});
btn('dismiss-crop').onclick=()=>cropSelector.reset();
btn('explain-crop').onclick=()=>{if(cropImage)void help('explain',cropImage);};
window.addEventListener('resize',()=>cropSelector.reset());
async function connectAgent(currentRequest:string){
  if(roomReady)return;
  const key=documentKey;
  const grant=await new Promise<AgentGrant>((resolve,reject)=>{grantWait={resolve,reject};post({type:'studyConnect',requestId:currentRequest});});
  if(key!==documentKey||currentRequest!==requestId||!source)throw new Error('The Study request changed.');
  await agentRoom.connect(grant,{mode:'study',source_id:source.id,revision:source.revision});
  if(key!==documentKey||currentRequest!==requestId)throw new Error('The Study request changed.');
  roomReady=true;
}
function controls() {
  const working=busy||responding;
  for (const name of ['summary','quiz']) btn(name).disabled = !source || !ai || busy;
  btn('send').disabled = !source || !ai || (!working&&!questionField.value.trim()&&!attachments.count);
  btn('send').dataset.working=String(working);
  btn('send').title=working?'Stop response':'Send message (Ctrl/Cmd+Enter)';
  btn('send').setAttribute('aria-label',working?'Stop response':'Send message');
  questionField.disabled = !source || !ai || busy;
  btn('clear-question').hidden = !questionField.value;
  btn('clear-question').disabled = busy;
  el('send-label').textContent = working ? 'Stop response' : 'Send message';
  attachments.lock(busy);
  for(const id of ['attach-images','attach-pdfs'])btn(id).disabled=!source||!ai||busy;
  el('attachment-menu').setAttribute('aria-disabled',String(!source||!ai||busy));
  el('study-content').setAttribute('aria-busy',String(busy));
  el('ask').setAttribute('aria-busy',String(busy));
  btn('open-study').disabled = !source || !ai;
  btn('crop').disabled = !source || !ai || busy || !!cropSelector?.pending;
  btn('explain-crop').disabled = !source || !ai || busy || !cropImage;
  btn('explain').disabled = !source || !ai || busy || !selected;
  el('selection-toolbar').hidden = !selected;
  const navigationDisabled = !source || !!cropSelector?.selecting || !!cropSelector?.pending;
  btn('previous').disabled = navigationDisabled || atStart;
  btn('next').disabled = navigationDisabled || atEnd;
  el<HTMLSelectElement>('font').disabled = !source || !!cropSelector?.selecting || !!cropSelector?.pending;
  btn('sign-in').hidden = signedIn;
}
function clear() {
  exchange=undefined;
  screens.clear();screen='ask';screenScroll=0;action=undefined;
  attachments.clear();
  el('study-content').replaceChildren(...freshContent());
  cropSelector.reset();el('crop-reference').hidden=true;el<HTMLImageElement>('crop-reference-image').removeAttribute('src');
  disconnectAgent(); generation++; pdfReader?.destroy(); pdfReader=undefined; epubControls.destroy(); source = undefined; documentKey = ''; selected = ''; busy = false; atStart = atEnd = true;
  if(studyDialog.open)studyDialog.close();syncSound();
  el('selection').hidden = true; el('response').replaceChildren(); el('questions').replaceChildren();
  el('help-status').textContent = ''; questionField.value = '';resizeComposer(questionField);
  el('viewer').replaceChildren(); el('title').textContent = ''; el('page').textContent = '';
  el('reading-links').replaceChildren(); el('loading').style.display = 'flex'; el('loading').style.opacity = '1';
  el('loading-text').textContent = 'Opening chapter…'; controls();
}
function options(select: HTMLSelectElement, values: {id:string;title:string}[]) {
  select.replaceChildren(...values.map(value => { const option = document.createElement('option'); option.value=value.id; option.textContent=value.title; return option; }));
}
function courseChanged(id?: string) {
  const course = choices.find(c => c.id === courseId);
  courses.textContent = course ? `${course.title} ⌄` : 'Choose course…'; courses.title = course ? `${course.title} — Search courses` : 'Search courses';
  courses.disabled = !choices.length;
  options(chapters, course?.chapters ?? []);
  if (id && course?.chapters.some(c => c.id === id)) chapters.value = id;
  else chapters.selectedIndex = -1;
  chapters.title = chapters.selectedOptions[0]?.textContent ?? '';
}
courses.onclick = () => host.postMessage({type:'chooseCourse'});
chapters.onchange = () => { clear(); host.postMessage({type:'choose', id:chapters.value}); };
btn('previous').onclick = () => readerControls().prevPage();
btn('next').onclick = () => readerControls().nextPage();
el<HTMLSelectElement>('font').onchange = event => {
  const fontSize = (event.target as HTMLSelectElement).value;
  post({type:'fontSize',fontSize});cropSelector.reset();readerControls().setFontSize(fontSize);
};
btn('sign-in').onclick = () => host.postMessage({type:'signIn'});

(window as any).DhimantStudyBridge = (event: any) => {
  if (!source) return;
  if (event.event === 'text_selected') {
    cropSelector.reset();
    selected = typeof event.text === 'string' ? event.text.slice(0,2400) : '';
    el('selection').textContent = selected; el('selection').hidden = !selected; controls();
  } else if (event.event === 'reader_ready') {
    el('loading').style.display = 'none';
  } else if (event.event === 'page_changed') {
    atStart = !!event.atStart; atEnd = !!event.atEnd;
    cropSelector.reset();
    selected = ''; el('selection').hidden = true; controls();
    el('page').textContent = event.totalPages ? `Page ${event.pageIndex} of ${event.totalPages}` : 'Reading';
    post({type:'position', cursor:event.cfi});
  } else if (event.event === 'link_clicked') post({type:'link',url:event.url});
  else if (event.event === 'error') {
    el('loading-text').textContent = 'The chapter could not be displayed. Select the chapter again to retry.';
    el('loading').style.opacity = '1';
    el('loading').style.display = 'flex';
  }
};
async function help(requestedAction: StudyAction,image?:CropImage) {
  if (!source || !ai || busy || (requestedAction === 'explain' && !selected && !image)) return;
  const draft = questionField.value, question = draft.trim() || (attachments.count?'Help me understand the attached material.':'');
  if (requestedAction === 'ask' && !question) return;
  openStudy(requestedAction === 'ask' ? screen : requestedAction);
  action=requestedAction;
  const key=documentKey;
  busy=true;requestId=crypto.randomUUID();writtenCards.clear();controls();
  submittedDraft=draft;
  const currentRequest=requestId;
  if(image){el('help-title').textContent='Explain selected area';el('crop-reference').hidden=false;el<HTMLImageElement>('crop-reference-image').src=image.dataUrl;}
  else if(action!=='ask'){el('crop-reference').hidden=true;el<HTMLImageElement>('crop-reference-image').removeAttribute('src');}
  if(action!=='ask') {el('text-reference').hidden = action!=='explain'||!!image;el('text-reference-content').textContent = action==='explain'&&!image ? selected : '';}
  el('help-status').textContent=roomReady?'Agent is thinking…':'Connecting to Study…';
  if(action!=='ask') {el('response').replaceChildren();el('questions').replaceChildren();}
  // Keep each learner message and its authored answer together. Follow-ups
  // retain the question they answer; a new crop/summary starts a fresh context.
  exchange=document.createElement('section');exchange.className='study-exchange';
  exchange.dataset.requestId=currentRequest;
  if(action==='ask') {
    const message=document.createElement('p');message.className='study-question';
    message.textContent=[question,...attachments.names].join('\n');exchange.append(message);
  }
  el('response').append(exchange);
  if(action==='ask')exchange.scrollIntoView({block:'start'});
  else el('study-content').scrollTop=0;
  responseTimer=setTimeout(()=>{if(key===documentKey){disconnectAgent();finishHelp('Study did not reply in time. Ask again to reconnect.');}},120000);
  try{
    await connectAgent(currentRequest);if(key!==documentKey||currentRequest!==requestId||!source)return;
    if(image){
      el('help-status').textContent='Sending selected area…';
      await uploadStudyCrop(image.dataUrl,currentRequest,{source_id:source.id,revision:source.revision},
        (method,payload)=>agentRoom.rpc(method,payload),()=>key===documentKey&&currentRequest===requestId);
      if(key!==documentKey||currentRequest!==requestId||!source)return;
    }
    let uploaded:{image_submission_id:string;image_count:number}|undefined;
    if(action==='ask'&&attachments.count){
      el('help-status').textContent='Sending attachments…';
      const sent=await agentRoom.upload(attachments,question,()=>key===documentKey&&currentRequest===requestId);
      uploaded={image_submission_id:sent.image_submission_id,image_count:Number(sent.image_count)};
      if(key!==documentKey||currentRequest!==requestId||!source)return;
    }
    const method={explain:'explain_selection',summary:'study_quick_summary',quiz:'study_quiz_me',ask:'study_question'}[action];
    const reply=await agentRoom.rpc(method,{source_id:source.id,revision:source.revision,request_id:requestId,
      ...(image?{is_cropped_snippet:true,selection_request_id:currentRequest,selection_image_request_id:currentRequest}
        :action==='explain'?{selected_text:selected,selection_request_id:requestId}:{}),...(action==='ask'?{question,...uploaded}:{})},uploaded?60000:15000);
    if(key!==documentKey||currentRequest!==requestId)return;
    if(reply!=='ok'){let reason='Study could not accept this request.';try{reason=JSON.parse(reply).message||reason;}catch{}throw new Error(reason);}
    // Keep the draft until an actual written response arrives, including when
    // the server accepts a request but generation or delivery later fails.
    if(busy)el('help-status').textContent='Agent is thinking…';
  }catch(error){if(key===documentKey&&currentRequest===requestId){disconnectAgent();finishHelp(error instanceof Error?error.message:'Study is unavailable.');}}
}
for (const action of ['explain','summary','quiz'] as const) btn(action).onclick = () => {
  openStudy(action);
  if(action==='explain'||(action==='quiz'?!el('questions').hasChildNodes():!el('response').querySelector('.study-answer-card')))void help(action);
};
bindComposer(el<HTMLFormElement>('ask'),questionField,()=>{
  if(busy||responding){disconnectAgent();finishHelp('Response stopped.');return;}
  return help('ask');
});
const attachmentMenu=el<HTMLDetailsElement>('attachment-menu');
attachmentMenu.querySelector('summary')!.onclick=event=>{if(!source||!ai||busy)event.preventDefault();};
for(const [id,pdf] of [['attach-images',false],['attach-pdfs',true]] as const)btn(id).onclick=()=>{attachmentMenu.open=false;attachments.choose(pdf);};
document.addEventListener('click',event=>{if(!attachmentMenu.contains(event.target as Node))attachmentMenu.open=false;});
attachmentMenu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();attachmentMenu.open=false;attachmentMenu.querySelector('summary')!.focus();}});
questionField.addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.files??[]);if(files.length){event.preventDefault();attachments.add(files);}});
questionField.oninput=controls;
btn('clear-question').onclick=()=>{questionField.value='';resizeComposer(questionField);controls();questionField.focus();};
function showReply(reply: StudyReply) {
  el('response').replaceChildren();
  showStudyQuiz(el('questions'),reply.questions,()=>{closeStudy();btn('quiz').focus();});
}
window.addEventListener('message', async event => {
  const message = event.data;
  if(message.type==='visibility'){visible=!!message.visible;syncSound();if(!visible){cropSelector.reset();if(busy){disconnectAgent();finishHelp('Request stopped when Study was hidden. Ask again when ready.');}}return;}
  if(message.type==='studyGrant'&&message.documentKey===documentKey&&message.requestId===requestId){grantWait?.resolve(message.grant);grantWait=undefined;return;}
  if(message.type==='helpError'&&message.documentKey===documentKey&&message.requestId===requestId){grantWait?.reject(new Error(message.message));grantWait=undefined;finishHelp(message.message);return;}
  if (message.type === 'catalog') {
    clear(); choices = message.courses; signedIn=!!message.signedIn; controls();
    const selectedCourse = choices.find(c => c.chapters.some(ch => ch.id === message.selected));
    courseId = selectedCourse?.id ?? choices[0]?.id ?? '';
    courseChanged(message.selected); el('notice').textContent = message.notice;
  } else if (message.type === 'courses') {
    const chapter = chapters.value;
    choices = message.courses; courseChanged(chapter);
  } else if (message.type === 'notice') el('notice').textContent = message.message;
  else if (message.type === 'loading') clear();
  else if (message.type === 'empty') { el('loading-text').textContent=message.message; controls(); }
  else if (message.type === 'chapter') {
    clear(); const current = generation;
    source = message.source; documentKey = message.documentKey; ai = message.aiEnabled; signedIn = message.signedIn;
    el<HTMLSelectElement>('font').value = message.fontSize ?? '100%';
    courseId = message.courseId ?? choices.find(c=>c.chapters.some(ch=>ch.id===source!.id))?.id ?? courseId;
    courseChanged(source!.id);
    el('study-context').textContent=[source!.course,source!.title].filter(Boolean).join(' · ');
    el('title').textContent = source!.title; el('reading-links').replaceChildren();
    el('source-note').textContent = 'Published course ' + (source!.document?.format.toUpperCase() ?? 'document') + '.';
    el('font-label').textContent=source!.document?.format==='pdf'?'Zoom':'Text size';
    for (const link of source!.reading) {
      const button = document.createElement('button'); button.textContent = link.label;
      button.onclick = () => post({type:'link', url:link.url}); el('reading-links').append(button);
    }
    controls();
    try {
      if(!source!.document || !message.bookData)throw new Error('No PDF or EPUB');
      const bytes=Uint8Array.from(atob(message.bookData),(c:string)=>c.charCodeAt(0));
      if(source!.document.format==='pdf'){
        const {PdfStudyReader}=await import('./studyPdf');if(current!==generation)return;
        pdfReader=new PdfStudyReader(el('viewer'),event=>(window as any).DhimantStudyBridge(event));
        const assets=el('viewer').dataset.pdfAssets!.replace(/\/?$/,'/');
        await pdfReader.open(bytes,assets,message.cursor,el<HTMLSelectElement>('font').value);
      }else if(source!.document.format==='epub')initReader(bytes.buffer,{fontSize:el<HTMLSelectElement>('font').value,initialCfi:message.cursor});
      else throw new Error('Unsupported document');
    }
    catch (error) { console.error('Study document could not open:',error); if (current === generation) el('loading-text').textContent = 'Could not open this chapter. Select it again to retry.'; }
  } else if (message.type === 'error') { el('loading-text').textContent = message.message; el('notice').textContent = message.message; }

});
controls(); host.postMessage({type:'ready'});
