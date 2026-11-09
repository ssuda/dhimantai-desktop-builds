import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Api, WrittenPractice } from './api';
import type { Auth } from './auth';
import type { EnvironmentName } from './environments';
import { HELP_LEVELS, HelpEvent, MAX_HELP_LEVEL, nextLevel, ProblemRecord } from './helpRecord';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { EXTENSIONS, MAX_FILES, PracticeAttachment, loadAttachments } from './practiceAttachments';

/** The shared per-account help record, so written challenges use the same ladder as coded Practice. */
export interface HelpStore {
  records(account: string): ProblemRecord[];
  note(account: string, event: HelpEvent): Promise<ProblemRecord[]>;
}
type Help = {next: number; waiting: boolean};

type Draft = {answer: string; assistance: string; usedTutor: boolean};
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]!));
export function writtenHtml(task: WrittenPractice, draft: Draft, nonce: string, help: Help = {next: 1, waiting: false}): string {
  const labels = JSON.stringify(HELP_LEVELS.map(level => ({label: level.label, message: level.message}))).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <style nonce="${nonce}">body{max-width:850px;margin:24px auto;padding:0 22px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);line-height:1.55}
  h1{font-size:1.5em}pre{white-space:pre-wrap;font:inherit}label{display:block;margin-top:18px}textarea,input{box-sizing:border-box;width:100%;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));font:inherit}
  textarea{min-height:220px;resize:vertical}button{margin:14px 8px 0 0;padding:8px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}button:disabled{opacity:.5;cursor:default}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
  .muted{color:var(--vscode-descriptionForeground)}.ladder{margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.ladder button{margin:0}:focus-visible{outline:2px solid var(--vscode-focusBorder)}#feedback{border-top:1px solid var(--vscode-panel-border);padding-top:15px}</style></head><body>
  <p class="muted">Free engineering practice · Optional preparation</p><h1>${escape(task.course)}</h1>
  <pre id="task">${escape(task.question)}</pre>
  <label for="answer">Your work and evidence</label><textarea id="answer" maxlength="12000" placeholder="Include your explanation, commands or code, and actual results. Do not include secrets or personal data.">${escape(draft.answer)}</textarea>
  <label for="assistance">Help used</label><input id="assistance" maxlength="900" value="${escape(draft.assistance)}" placeholder="Documentation, Instructor, AI or peer help; write none if unaided">
  <label for="message">Question for Practice Instructor (optional)</label><input id="message" maxlength="600">
  <div class="ladder"><button type="button" id="attach" class="secondary">Attach photo or PDF</button><button type="button" id="detach" class="secondary" hidden>Remove</button><span id="attached" class="muted">A terminal screenshot, a diagram or handwritten working. Up to 4 files, 2 MB each.</span></div>
  <button type="button" id="review">Submit for feedback</button>
  <div class="ladder"><span>Stuck?</span><button type="button" id="hint" class="secondary"></button><span id="help-steps" class="muted"></span></div>
  <p id="help-note" class="muted" hidden></p>
  <p class="muted">Your draft stays on this computer. Feedback is guidance, not a verified grade or mastery award. You can start any other course without completing this task.</p>
  <p id="status" role="status"></p><pre id="feedback" aria-live="polite"></pre>
  <script nonce="${nonce}">
  const host=acquireVsCodeApi(), answer=document.getElementById('answer'), assistance=document.getElementById('assistance'), message=document.getElementById('message'), status=document.getElementById('status');
  const levels=${labels}, max=${MAX_HELP_LEVEL};
  let busy=false, usedTutor=${draft.usedTutor}, sequence=0, saveTimer, help={next:${Number(help.next)},waiting:${help.waiting === true}};
  const showHelp=()=>{const hint=document.getElementById('hint'), note=document.getElementById('help-note');
    hint.textContent=levels[help.next-1].label;
    document.getElementById('help-steps').textContent='Step '+help.next+' of '+max;
    note.hidden=!help.waiting;note.textContent=help.waiting?'Add what you tried to your work first. Until then, help stays at this step.':'';};
  showHelp();
  const data=()=>({answer:answer.value,assistance:assistance.value,usedTutor});
  const save=()=>{clearTimeout(saveTimer);host.postMessage({type:'save',sequence:++sequence,...data()});};
  [answer,assistance].forEach(el=>el.addEventListener('input',()=>{clearTimeout(saveTimer);saveTimer=setTimeout(save,250);}));
  for(const mode of ['hint','review']) document.getElementById(mode).onclick=()=>{
    if(busy)return;
    if(mode==='review'&&(!answer.value.trim()||!assistance.value.trim())){status.textContent='Include your work and help used before submitting.';return;}
    save();busy=true;document.getElementById('hint').disabled=document.getElementById('review').disabled=true;
    status.textContent=mode==='review'?'Reviewing this submitted version…':'Preparing a hint…';
    host.postMessage({type:'feedback',mode,...data(),message:mode==='hint'&&!message.value.trim()?levels[help.next-1].message:message.value,helpLevel:mode==='hint'?help.next:undefined});
  };
  document.getElementById('attach').onclick=()=>{if(!busy)host.postMessage({type:'attach'});};
  document.getElementById('detach').onclick=()=>{if(!busy)host.postMessage({type:'detach'});};
  addEventListener('message',({data:reply})=>{
    if(reply.type==='attached'){document.getElementById('attached').textContent=reply.error||(reply.names.length?'Attached: '+reply.names.join(', '):'A terminal screenshot, a diagram or handwritten working. Up to 4 files, 2 MB each.');document.getElementById('detach').hidden=!reply.names.length;return;}
    if(reply.type==='saved'){if(!busy)status.textContent='Draft saved on this computer.';return;}
    if(reply.type==='saveError'){status.textContent=reply.error;return;}
    if(reply.type==='helpState'){help={next:reply.next,waiting:reply.waiting};showHelp();return;}
    if(reply.type!=='feedback')return;
    busy=false;document.getElementById('hint').disabled=document.getElementById('review').disabled=false;
    if(reply.error){status.textContent=reply.error;return;}
    usedTutor=true;save();
    document.getElementById('feedback').textContent=reply.feedback+'\\n\\n'+reply.next_step;
    status.textContent='Feedback on the version you submitted. No grade or completion was awarded.';
  });
  </script></body></html>`;
}

export async function openWrittenPractice(context: vscode.ExtensionContext, task: WrittenPractice, api: Api,
    auth: Auth, account: string, env: EnvironmentName, environment: () => EnvironmentName, store: HelpStore): Promise<vscode.WebviewPanel> {
  const key = `writtenPractice.${env}.${account}.${task.id}`;
  const raw = context.globalState.get<Draft>(key);
  const draft = raw && typeof raw.answer === 'string' && typeof raw.assistance === 'string'
    ? {answer:raw.answer.slice(0,12000),assistance:raw.assistance.slice(0,900),usedTutor:raw.usedTutor === true}
    : {answer:'',assistance:'',usedTutor:false};
  const panel = vscode.window.createWebviewPanel('dhimantai.learningRoom', 'Practice notebook · ' + task.course,
    vscode.ViewColumn.One, {enableScripts:true,retainContextWhenHidden:true});
  const helpState = (all: ProblemRecord[]) => nextLevel(all.find(r => r.id === task.id));
  const opened = await store.note(account, {type:'open', id:task.id, title:task.title || task.course, language:'', kind:'written'});
  const {level, waiting} = helpState(opened);
  const nonce = randomBytes(16).toString('base64');
  panel.webview.html = writtenHtml(task,draft,nonce,{next:level,waiting});
  // A changed answer after help is the written equivalent of running code: it earns the next rung.
  const tokenKey = 'written\0' + task.id;
  let answerAtHelp: string | undefined, attempted = true;
  let closed = false, pending: AbortController | undefined, writes = Promise.resolve(), sequence = 0;
  const active = async () => !closed && environment() === env && (await auth.session())?.user.id === account;
  panel.onDidDispose(() => {closed=true;pending?.abort();});
  let files: PracticeAttachment[] = [];
  panel.webview.onDidReceiveMessage(async msg => {
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
  return panel;
}
