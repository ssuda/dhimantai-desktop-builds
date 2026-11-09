import { AgentRoom, AgentGrant } from './agentRoom';
import { NotebookAttachments } from './notebookAttachments';
import MarkdownIt from 'markdown-it';
import { learningMath } from './learningMath';
import { diagram } from './diagram';
import { StudyCropSelector, uploadStudyCrop, type CropImage } from './studyCrop';
import { bindComposer, resizeComposer } from './composer';
import { showStudyQuiz } from './studyQuiz';
import { showStudyResponse } from './studyResponse';
import 'katex/dist/katex.min.css';
import type { StudySource, StudyAction, StudyReply } from '../src/studyContent';
import './study.css';
import './composer.css';

declare function acquireVsCodeApi(): {postMessage(value: unknown): void};
declare const JSZip: any;
declare const initReader: (source: ArrayBuffer, options: object) => void;
declare const epubControls: {destroy():void;nextPage():void; prevPage():void; setFontSize(value:string):void; goToCfi(value:string):void; clearSelection():void};
const host = acquireVsCodeApi();
const readerMarkdown = new MarkdownIt({html:false, breaks:true});
learningMath(readerMarkdown);
readerMarkdown.validateLink = url => /^https:\/\//i.test(url) || url.startsWith('#');
const codeFence = readerMarkdown.renderer.rules.fence!;
readerMarkdown.renderer.rules.fence = (tokens,i,options,env,renderer) => tokens[i].info.trim() === 'svg'
  ? diagram(tokens[i].content) : codeFence(tokens,i,options,env,renderer);
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
btn('dismiss-selection').onclick=()=>{epubControls.clearSelection();selected='';el('selection').hidden=true;controls();};
cropSelector=new StudyCropSelector({button:btn('crop'),overlay:el('crop-overlay'),box:el('crop-box'),apply:btn('apply-crop'),cancel:btn('cancel-crop'),status:el('crop-status'),viewer:el('viewer'),
  available:()=>!!source&&ai&&!busy,
  image(image){cropImage=image;el('crop-toolbar').hidden=!image;const preview=el<HTMLImageElement>('crop-preview');
    if(image){preview.src=image.dataUrl;selected='';el('selection').hidden=true;epubControls.clearSelection();}else preview.removeAttribute('src');},changed:controls});
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
  disconnectAgent(); generation++; epubControls.destroy(); source = undefined; documentKey = ''; selected = ''; busy = false; atStart = atEnd = true;
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
  chapters.title = chapters.selectedOptions[0]?.textContent ?? '';
}
courses.onclick = () => host.postMessage({type:'chooseCourse'});
chapters.onchange = () => { clear(); host.postMessage({type:'choose', id:chapters.value}); };
btn('previous').onclick = () => epubControls.prevPage();
btn('next').onclick = () => epubControls.nextPage();
el<HTMLSelectElement>('font').onchange = event => {
  const fontSize = (event.target as HTMLSelectElement).value;
  post({type:'fontSize',fontSize});cropSelector.reset();epubControls.setFontSize(fontSize);
};
btn('sign-in').onclick = () => host.postMessage({type:'signIn'});

/** Build a small EPUB from the same Markdown source; the existing epub.js reader handles navigation and selection. */
export async function chapterEpub(chapter: StudySource, stylesheet: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const xml = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
  const doc = document.implementation.createDocument('http://www.w3.org/1999/xhtml','html');
  const head = doc.createElementNS(doc.documentElement.namespaceURI,'head');
  const title = doc.createElementNS(doc.documentElement.namespaceURI,'title'); title.textContent = chapter.title;
  const css = doc.createElementNS(doc.documentElement.namespaceURI,'style');
  // Preserve CSS child combinators through EPUB's XML -> HTML iframe loading.
  // XML-escaped > becomes literal &gt; inside HTML's raw-text <style> element.
  // This polyglot CDATA wrapper is a CSS comment in either parser.
  css.append(doc.createTextNode('/*'),doc.createCDATASection('*/\n'+stylesheet+'\n/*'),doc.createTextNode('*/'));
  const referrer = doc.createElementNS(doc.documentElement.namespaceURI,'meta');
  referrer.setAttribute('name','referrer'); referrer.setAttribute('content','no-referrer');
  const style = doc.createElementNS(doc.documentElement.namespaceURI,'style');
  style.textContent = 'body{font-family:system-ui;line-height:1.65;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:12px;color:#222}code{font-family:monospace}h1{font-size:1.5em}h2{font-size:1.2em}img,svg{max-width:100%;height:auto;object-fit:contain}a{color:#365bbb}';
  head.append(title,css,style,referrer); doc.documentElement.append(head);
  const rendered = new DOMParser().parseFromString(readerMarkdown.render(chapter.markdown), 'text/html');
  // A reader never executes source HTML or remote scripts. Rendered links are handled by the extension host.
  rendered.body.querySelectorAll('script,iframe,object,embed,form').forEach(node => node.remove());
  doc.documentElement.append(doc.importNode(rendered.body, true));
  zip.file('mimetype','application/epub+zip',{compression:'STORE'});
  zip.file('META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('package.opf',`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${xml(chapter.id)}</dc:identifier><dc:title>${xml(chapter.title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-08T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>`);
  // epub.js loads the chapter in a Chromium HTML frame. Standards mode is
  // required for KaTeX's positioned fractions and superscripts.
  zip.file('chapter.xhtml','<!DOCTYPE html>\n'+new XMLSerializer().serializeToString(doc));
  zip.file('nav.xhtml',`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${xml(chapter.title)}</a></li></ol></nav></body></html>`);
  return zip.generateAsync({type:'arraybuffer'});
}
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
    clear(); choices = message.courses;
    const selectedCourse = choices.find(c => c.chapters.some(ch => ch.id === message.selected));
    courseId = selectedCourse?.id ?? choices[0]?.id ?? '';
    courseChanged(message.selected); el('notice').textContent = message.notice;
  } else if (message.type === 'courses') {
    const chapter = chapters.value;
    choices = message.courses; courseChanged(chapter);
  } else if (message.type === 'notice') el('notice').textContent = message.message;
  else if (message.type === 'loading') clear();
  else if (message.type === 'chapter') {
    clear(); const current = generation;
    source = message.source; documentKey = message.documentKey; ai = message.aiEnabled; signedIn = message.signedIn;
    el<HTMLSelectElement>('font').value = message.fontSize ?? '100%';
    courseId = message.courseId ?? choices.find(c=>c.chapters.some(ch=>ch.id===source!.id))?.id ?? courseId;
    courseChanged(source!.id);
    el('study-context').textContent=[source!.course,source!.title].filter(Boolean).join(' · ');
    el('title').textContent = source!.title; el('reading-links').replaceChildren();
    el('source-note').textContent = source!.id.startsWith('book:')
      ? 'Original companion notes. Reading links open the book separately.' : 'Published course chapter.';
    for (const link of source!.reading) {
      const button = document.createElement('button'); button.textContent = link.label;
      button.onclick = () => post({type:'link', url:link.url}); el('reading-links').append(button);
    }
    controls();
    try { const epub = await chapterEpub(source!,message.stylesheet); if (current === generation) initReader(epub,{fontSize:el<HTMLSelectElement>('font').value,initialCfi:message.cursor}); }
    catch { if (current === generation) el('loading-text').textContent = 'Could not open this chapter. Select it again to retry.'; }
  } else if (message.type === 'error') { el('loading-text').textContent = message.message; el('notice').textContent = message.message; }

});
controls(); host.postMessage({type:'ready'});
