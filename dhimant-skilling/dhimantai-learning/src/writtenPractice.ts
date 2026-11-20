import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { bindDictation, dictationStatus, microphoneControl } from './dictation';
import { Api, WrittenPractice } from './api';
import { practiceReviews } from './crtPracticeReview';
import { assessmentForTask } from './crtAssessmentForms';
import type { Auth } from './auth';
import type { EnvironmentName } from './environments';
import { HELP_LEVELS, HelpEvent, MAX_HELP_LEVEL, nextLevel, ProblemRecord } from './helpRecord';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { EXTENSIONS, MAX_FILES, PracticeAttachment, loadAttachments } from './practiceAttachments';
import { UI_TOKENS } from './uiTheme';

/** The shared per-account help record, so written challenges use the same ladder as coded Practice. */
export interface HelpStore {
  records(account: string): ProblemRecord[];
  note(account: string, event: HelpEvent): Promise<ProblemRecord[]>;
}
type Help = {next: number; waiting: boolean};

type Capture = {answer?: string; supported: boolean};
const captureWrites = new Map<string, Promise<void>>();

type Draft = {answer: string; assistance: string; usedTutor: boolean};
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]!));
// Course recordings are immutable, public objects. Keep arbitrary authored text escaped.
const recordingRoot = 'https://db.vidyai.in/storage/v1/object/public/vidyai/course-media/crt/';
function taskHtml(question: string): string {
  const markup = /```text\r?\n([\s\S]*?)\r?\n```|!?\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;
  let html = '', position = 0;
  for (const match of question.matchAll(markup)) {
    html += escape(question.slice(position, match.index));
    if (match[1] !== undefined) {
      html += `<code class="figure">${escape(match[1])}</code>`;
    } else if (match[0].startsWith('![') && match[3].startsWith(recordingRoot) && /^[a-f0-9]{64}\/[a-z-]+\.png$/.test(match[3].slice(recordingRoot.length))) {
      html += `<img class="chart" src="${escape(match[3])}" alt="${escape(match[2])}">`;
    } else if (match[3].startsWith(recordingRoot) && /^[a-f0-9]{64}\/[a-z-]+\.mp3$/.test(match[3].slice(recordingRoot.length))) {
      html += `<span class="recording">${escape(match[2])} <audio controls preload="none" aria-label="${escape(match[2])}" src="${escape(match[3])}"></audio></span>`;
    } else {
      html += escape(match[0]);
    }
    position = match.index! + match[0].length;
  }
  return html + escape(question.slice(position));
}
export function writtenHtml(task: WrittenPractice, draft: Draft, nonce: string, help: Help = {next: 1, waiting: false}, media?: (file: string) => string, cspSource = '', capture?: Capture, canGoBack = false): string {
  const guide = practiceReviews[task.id];
  const labels = JSON.stringify(HELP_LEVELS.map(level => ({label: level.label, message: level.message}))).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Written practice</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}'; media-src ${recordingRoot}; img-src ${recordingRoot}">
  ${media ? `<link rel="stylesheet" href="${media('audioControls.css')}"><script nonce="${nonce}" src="${media('dictation.js')}"></script>` : ''}
  <style nonce="${nonce}">${UI_TOKENS}body{max-width:1280px;margin:24px auto;padding:0 clamp(14px,3vw,36px);font: max(15px,var(--vscode-font-size,13px))/1.55 var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  h1{font-size:1.5em}pre{white-space:pre-wrap;font:inherit}code.figure{display:block;overflow-x:auto;white-space:pre;font-family:var(--vscode-editor-font-family,monospace)}.chart{display:block;max-width:100%;height:auto}.recording audio{max-width:100%;vertical-align:middle}label{display:block;margin-top:18px}textarea,input{box-sizing:border-box;width:100%;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));font:inherit}
  textarea{min-height:220px;resize:vertical}button{margin:14px 8px 0 0;padding:8px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}button:disabled{opacity:.5;cursor:default}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--dh-button-border)}
  .muted{color:var(--dh-muted)}.ladder{margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.ladder button{margin:0}:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}#feedback:not(:empty){border-inline-start:3px solid var(--dh-accent);padding:12px;background:var(--dh-surface)}
  header h1{margin:4px 0 16px;font-size:clamp(21px,2.2vw,32px)}header p{margin:0}.written-workspace{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr);align-items:start;gap:16px}
  .written-brief,.written-answer{min-width:0;padding:clamp(12px,2vw,24px);border:1px solid var(--dh-border);border-radius:var(--dh-radius);background:var(--dh-surface)}
  .written-brief summary{cursor:pointer;font-weight:650}#task{overflow-wrap:anywhere}#task:last-child{margin-bottom:0}.written-answer>label:first-child{font-weight:650;margin-top:0}input,textarea,button{border-radius:6px}
  @media(max-width:839px){.written-workspace{grid-template-columns:1fr}}.written-workspace:has(.written-brief:not([open])){grid-template-columns:1fr}</style></head><body>
  <header>${canGoBack ? '<button id="back-course" class="secondary" type="button">← Back to course</button>' : ''}<p class="muted">${escape(task.course)} · Written practice</p><h1>${escape(task.title || task.course)}</h1></header>
  <main class="written-workspace"><details class="written-brief" open><summary>Exercise instructions</summary>
  ${assessmentForTask[task.id] ? '<button type="button" id="start-assessment">Start assessment</button>' : ''}
  <pre id="task">${taskHtml(task.question)}</pre></details><section class="written-answer" aria-label="Your response">
  <label for="answer">Your work and evidence</label><textarea id="answer" maxlength="12000" placeholder="Include what you did (prompts, commands or code), the actual results and your explanation. Do not include secrets or personal data.">${escape(draft.answer)}</textarea>
  ${guide ? `<section aria-label="First response">
    <button id="capture" type="button" ${capture?.answer ? 'hidden' : ''}>${escape(guide.label)}</button>
    ${guide.transcript ? '<button id="accommodation" type="button" class="secondary">Use transcript accommodation</button>' : ''}
    <pre id="transcript"></pre><pre id="original"></pre><pre id="guide"></pre>
    <p class="muted">Your first response is saved on this computer. Use the work field for a later retry.</p></section>` : ''}
  <label for="assistance">Help used</label><input id="assistance" maxlength="900" value="${escape(draft.assistance)}" placeholder="Documentation, Instructor, AI or peer help; write none if unaided">
  <label for="message">Question for Practice Instructor (optional)</label><input id="message" maxlength="600">${microphoneControl}${dictationStatus}
  <div class="ladder"><button type="button" id="attach" class="secondary">Attach photo or PDF</button><button type="button" id="detach" class="secondary" hidden>Remove</button><span id="attached" class="muted">A screenshot, a diagram or handwritten working. Up to 4 files, 2 MB each.</span></div>
  <button type="button" id="review">Submit for feedback</button>
  <div class="ladder"><span>Stuck?</span><button type="button" id="hint" class="secondary"></button><span id="help-steps" class="muted"></span></div>
  <p id="help-note" class="muted" hidden></p>
  <p class="muted">Your draft stays on this computer. Feedback is guidance, not a verified grade or mastery award. You can start any other course without completing this task.</p>
  <p id="status" role="status"></p><pre id="feedback" aria-live="polite"></pre></section></main>
  <script nonce="${nonce}">
  const host=acquireVsCodeApi(), answer=document.getElementById('answer'), assistance=document.getElementById('assistance'), message=document.getElementById('message'), status=document.getElementById('status');
  const dictation=window.installDictation?.(host,message);
  dictation?.setScope('written');
  const levels=${labels}, max=${MAX_HELP_LEVEL};
  let busy=false, usedTutor=${draft.usedTutor}, sequence=0, saveTimer, help={next:${Number(help.next)},waiting:${help.waiting === true}};
  const showHelp=()=>{const hint=document.getElementById('hint'), note=document.getElementById('help-note');
    hint.textContent=levels[help.next-1].label;
    document.getElementById('help-steps').textContent='Step '+help.next+' of '+max;
    note.hidden=!help.waiting;note.textContent=help.waiting?'Add what you tried to your work first. Until then, help stays at this step.':'';};
  showHelp();
  document.getElementById('start-assessment')?.addEventListener('click',()=>host.postMessage({type:'crtAssessment'}));
  function showCapture(value) {
    const button=document.getElementById('capture');
    if(!button)return;
    button.hidden=!!value.answer;
    const support=document.getElementById('accommodation');
    if(support)support.hidden=!!value.transcript;
    document.getElementById('transcript').textContent=value.transcript||'';
    document.getElementById('original').textContent=value.answer ? (value.supported?'Transcript-supported first response':'First response')+'\\n'+value.answer : '';
    document.getElementById('guide').textContent=value.review||'';
  }
  document.getElementById('capture')?.addEventListener('click',()=>{
    if(!answer.value.trim()){status.textContent='Enter the first response before saving it.';return;}
    host.postMessage({type:'firstCapture',action:'save',answer:answer.value});
  });
  document.getElementById('accommodation')?.addEventListener('click',()=>host.postMessage({type:'firstCapture',action:'transcript'}));
  ${guide ? "host.postMessage({type:'firstCapture',action:'read'});" : ''}
  const data=()=>({answer:answer.value,assistance:assistance.value,usedTutor});
  document.getElementById('back-course')?.addEventListener('click',()=>host.postMessage({type:'backToCourse',...data()}));
  const save=()=>{clearTimeout(saveTimer);host.postMessage({type:'save',sequence:++sequence,...data()});};
  [answer,assistance].forEach(el=>el.addEventListener('input',()=>{clearTimeout(saveTimer);saveTimer=setTimeout(save,250);}));
  for(const mode of ['hint','review']) document.getElementById(mode).onclick=()=>{
    if(busy)return;
    if(mode==='review'&&(!answer.value.trim()||!assistance.value.trim())){status.textContent='Include your work and help used before submitting.';return;}
    dictation?.setScope('');save();busy=true;document.getElementById('hint').disabled=document.getElementById('review').disabled=true;
    status.textContent=mode==='review'?'Reviewing this submitted version…':'Preparing a hint…';
    host.postMessage({type:'feedback',mode,...data(),message:mode==='hint'&&!message.value.trim()?levels[help.next-1].message:message.value,helpLevel:mode==='hint'?help.next:undefined});
  };
  document.getElementById('attach').onclick=()=>{if(!busy)host.postMessage({type:'attach'});};
  document.getElementById('detach').onclick=()=>{if(!busy)host.postMessage({type:'detach'});};
  addEventListener('message',({data:reply})=>{
    if(reply.type==='firstCapture'){showCapture(reply);return;}
    if(reply.type==='attached'){document.getElementById('attached').textContent=reply.error||(reply.names.length?'Attached: '+reply.names.join(', '):'A screenshot, a diagram or handwritten working. Up to 4 files, 2 MB each.');document.getElementById('detach').hidden=!reply.names.length;return;}
    if(reply.type==='saved'){if(!busy)status.textContent='Draft saved on this computer.';return;}
    if(reply.type==='saveError'){status.textContent=reply.error;return;}
    if(reply.type==='helpState'){help={next:reply.next,waiting:reply.waiting};showHelp();return;}
    if(reply.type!=='feedback')return;
    busy=false;dictation?.setScope('written');document.getElementById('hint').disabled=document.getElementById('review').disabled=false;
    if(reply.error){status.textContent=reply.error;return;}
    usedTutor=true;save();
    document.getElementById('feedback').textContent=reply.feedback+'\\n\\n'+reply.next_step;
    status.textContent='Feedback on the version you submitted. No grade or completion was awarded.';
  });
  </script></body></html>`;
}

export async function openWrittenPractice(context: vscode.ExtensionContext, task: WrittenPractice, api: Api,
    auth: Auth, account: string, env: EnvironmentName, environment: () => EnvironmentName, store: HelpStore,
    navigation?: {panel:vscode.WebviewPanel; back():void; cleanup(dispose:()=>void):void}): Promise<vscode.WebviewPanel> {
  const key = `writtenPractice.${env}.${account}.${task.id}`;
  const raw = context.globalState.get<Draft>(key);
  const draft = raw && typeof raw.answer === 'string' && typeof raw.assistance === 'string'
    ? {answer:raw.answer.slice(0,12000),assistance:raw.assistance.slice(0,900),usedTutor:raw.usedTutor === true}
    : {answer:'',assistance:'',usedTutor:false};
  const panel = navigation?.panel ?? vscode.window.createWebviewPanel('dhimantai.learningRoom', 'Practice notebook · ' + task.course,
    vscode.ViewColumn.One, {enableScripts:true,retainContextWhenHidden:true});
  const helpState = (all: ProblemRecord[]) => nextLevel(all.find(r => r.id === task.id));
  const opened = await store.note(account, {type:'open', id:task.id, title:task.title || task.course, language:'', kind:'written'});
  const {level, waiting} = helpState(opened);
  const nonce = randomBytes(16).toString('base64');
  const media = (file:string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media',file)).toString();
  panel.webview.html = writtenHtml(task,draft,nonce,{next:level,waiting},media,panel.webview.cspSource,context.globalState.get<Capture>(key + '.first'),!!navigation);
  // A changed answer after help is the written equivalent of running code: it earns the next rung.
  const tokenKey = 'written\0' + task.id;
  let answerAtHelp: string | undefined, attempted = true;
  let closed = false, pending: AbortController | undefined, writes = Promise.resolve(), sequence = 0;
  const active = async () => !closed && environment() === env && (await auth.session())?.user.id === account;
  const dictation = bindDictation(panel.webview, () => !closed && panel.visible && environment() === env &&
    vscode.workspace.getConfiguration('dhimantai').get('aiAssistance',true) ? {key:'written', api,
      language:context.globalState.get<string>(`dhimantai.coachingLanguage.${env}.${account}`)} : undefined);
  const dispose = () => {dictation.dispose();closed=true;pending?.abort();receiver.dispose();disposal.dispose();};
  const disposal = panel.onDidDispose(dispose);
  let files: PracticeAttachment[] = [];
  const receiver = panel.webview.onDidReceiveMessage(async msg => {
    const guide = practiceReviews[task.id];
    if (msg?.type === 'firstCapture' && guide && await active()) {
      const firstKey = key + '.first';
      const update = (captureWrites.get(firstKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (!await active()) return;
        let first = context.globalState.get<Capture>(firstKey) ?? {supported:false};
        if (msg.action === 'save' && !first.answer && typeof msg.answer === 'string' && msg.answer.trim() && msg.answer.length <= 12000) {
          first = {...first,answer:msg.answer.trim()};
          await context.globalState.update(firstKey,first);
        } else if (msg.action === 'transcript' && guide.transcript && !first.answer && !first.supported) {
          first = {supported:true};
          await context.globalState.update(firstKey,first);
        }
        if (await active()) await panel.webview.postMessage({type:'firstCapture', ...first,
          transcript:first.supported || first.answer ? guide.transcript : undefined,
          review:first.answer ? guide.review : undefined});
      });
      captureWrites.set(firstKey,update);
      try {await update;}
      catch {if (await active()) await panel.webview.postMessage({type:'saveError',error:'Could not load or save the first response. Please retry.'});}
      finally {if (captureWrites.get(firstKey) === update) captureWrites.delete(firstKey);}
      return;
    }
    if (msg?.type==='crtAssessment' && assessmentForTask[task.id] && await active()) {
      await vscode.commands.executeCommand('dhimantai.openCrtAssessment',assessmentForTask[task.id],account,env);
      return;
    }
    if ((msg?.type === 'attach' || msg?.type === 'detach') && !pending && await active()) {
      let error = '';
      try {
        if (msg.type === 'detach') files = [];
        else {
          const chosen = await vscode.window.showOpenDialog({canSelectMany: true, openLabel: 'Attach',
            title: `Attach up to ${MAX_FILES} photos or PDFs (2 MB each)`, filters: {'Photos and PDFs': EXTENSIONS}});
          if (chosen?.length) files = await loadAttachments(chosen.map(uri => uri.fsPath));
        }
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      if (await active()) await panel.webview.postMessage({type:'attached', names: files.map(f => f.name), error});
      return;
    }
    if (!await active() || !msg || typeof msg.answer !== 'string' || msg.answer.length > 12000
        || typeof msg.assistance !== 'string' || msg.assistance.length > 900 || typeof msg.usedTutor !== 'boolean') return;
    if (msg.type==='backToCourse' && navigation) {
      try {
        await writes;
        await context.globalState.update(key,{answer:msg.answer,assistance:msg.assistance,usedTutor:msg.usedTutor});
        if (await active()) {dispose();navigation.back();}
      } catch { if (await active()) await panel.webview.postMessage({type:'saveError',error:'Could not save this draft. Try again before returning to the course.'}); }
      return;
    }
    if (msg.type === 'save' && Number.isSafeInteger(msg.sequence) && msg.sequence > sequence) {
      sequence = msg.sequence;
      if (!attempted && msg.answer !== answerAtHelp) {
        attempted = true;
        const all = await store.note(account, {type:'run', id:task.id});
        if (await active()) await panel.webview.postMessage({type:'helpState', ...helpState(all)});
      }
      const value = {answer:msg.answer,assistance:msg.assistance,usedTutor:msg.usedTutor};
      writes = writes.catch(() => {}).then(async () => {
        if (await active()) await context.globalState.update(key,value);
      });
      try { await writes; if (await active()) await panel.webview.postMessage({type:'saved'}); }
      catch { if (await active()) await panel.webview.postMessage({type:'saveError',error:'Could not save this draft. Copy your work before closing.'}); }
      return;
    }
    if (msg.type !== 'feedback' || pending || !['hint','review'].includes(msg.mode)
        || typeof msg.message !== 'string' || msg.message.length > 600) return;
    // The webview asks for a rung; the record decides the most it may get, and the server checks again.
    const requested = msg.mode === 'hint' && Number.isInteger(msg.helpLevel)
      ? Math.max(1, Math.min(msg.helpLevel, helpState(store.records(account)).level)) : undefined;
    const abort = new AbortController(); pending = abort;
    try {
      if (!vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance',true)) throw new Error('AI assistance is off. Your draft remains available.');
      const reply = await api.writtenFeedback(task.id, {mode:msg.mode,answer:msg.answer,message:msg.message,
        assistance:msg.assistance + (msg.usedTutor ? '\nPractice Instructor feedback received.' : ''),
        ...(requested ? {help_level:requested, ladder_token:ladderToken(tokenKey)} : {}), ...(files.length ? {attachments: files} : {})},
        AbortSignal.any([abort.signal,AbortSignal.timeout(45000)]));
      if (reply.assessment !== 'feedback_only') throw new Error('Unexpected review response. No grade was recorded.');
      if (requested) rememberLadderToken(tokenKey, reply.ladder_token);
      const all = await store.note(account, requested ? {type:'help', id:task.id, level:reply.help_level ?? requested} : {type:'ask', id:task.id});
      if (requested) { answerAtHelp = msg.answer; attempted = false; }
      if (await active()) await panel.webview.postMessage({type:'helpState', ...helpState(all)});
      if (await active()) await panel.webview.postMessage({type:'feedback',...reply});
    } catch (error) {
      if (await active()) await panel.webview.postMessage({type:'feedback',error:error instanceof Error ? error.message : 'Feedback unavailable. Try again.'});
    } finally { if (pending === abort) pending=undefined; }
  });
  navigation?.cleanup(dispose);
  return panel;
}
