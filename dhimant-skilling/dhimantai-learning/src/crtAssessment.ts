import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Auth } from './auth';
import type { Environment, EnvironmentName } from './environments';
import { learnerRpc } from './learnerCatalog';

import { CRT_ENTRY, CRT_EXIT } from './crtAssessmentForms';
export { CRT_ENTRY, CRT_EXIT } from './crtAssessmentForms';

interface Attempt {
  id:string; exam_id:string; revision:number; answers:Record<string,unknown>;
  marked_for_review:number[]; submitted_at:string|null;
}

export function registerCrtAssessments(context:vscode.ExtensionContext, auth:Auth,
    environment:()=>EnvironmentName, service:()=>Environment) {
  const panels = new Map<string,vscode.WebviewPanel>();
  return vscode.commands.registerCommand('dhimantai.openCrtAssessment', async (lesson:string, owner:string, env:EnvironmentName) => {
    if (![CRT_ENTRY,CRT_EXIT].includes(lesson) || !owner || environment() !== env || (await auth.session())?.user.id !== owner) return;
    const key = [env,owner,lesson].join('/');
    const existing = panels.get(key);
    if (existing) { existing.reveal(); return; }
    const backend = service();
    const panel = vscode.window.createWebviewPanel('dhimantai.crtAssessment',lesson===CRT_ENTRY?'CRT entry diagnostic':'CRT exit mock',
      vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});
    panels.set(key,panel);
    let closed = false, blocked=false, latestSave=0, attempt:Attempt|undefined, queue = Promise.resolve();
    const sameOwner = async () => environment()===env && (await auth.session())?.user.id===owner;
    const active = async () => !closed && await sameOwner();
    const rpc = async <T>(name:Parameters<typeof learnerRpc>[1], body:object={}) => {
      const token = await auth.accessToken();
      const session = await auth.session();
      if (!token || session?.access_token!==token || session.user.id!==owner || environment()!==env)
        throw new Error('Sign in with the account that opened this assessment.');
      return learnerRpc<T>(backend,name,body,token);
    };
    const post = async (message:object) => { if (await active()) await panel.webview.postMessage(message); };
    const scores = async () => post({type:'scores',scores:await rpc('crt_assessment_scores')});
    const load = async () => {
      const value = attempt ? await rpc<Attempt>('exam_attempt_state',{p_id:attempt.id})
        : await rpc<Attempt>('exam_open',{p_exam_id:lesson});
      if (value.exam_id!==lesson) throw new Error('The exam service returned a different assessment.');
      attempt=value; blocked=false;
      await post({type:'state',state:value});
      await scores();
    };
    const receive = panel.webview.onDidReceiveMessage(msg => {
      const isSave=msg?.type==='save';
      if (isSave) {
        if (!Number.isSafeInteger(msg.sequence) || msg.sequence<=latestSave) return;
        latestSave=msg.sequence;
      }
      queue = queue.then(async () => {
        // Finish edits received before the tab closed. Keep only the most recent
        // full snapshot when several edits arrive during a slow request.
        if (!await sameOwner() || (closed && !isSave)) { if (!closed) panel.dispose(); return; }
        if (isSave && (msg.sequence<latestSave || blocked)) return;
        if (msg?.type==='close') { panel.dispose(); return; }
        if (msg?.type==='load') { await load(); return; }
        if (msg?.type==='scores') { await scores(); return; }
        if (!attempt || !['save','submit'].includes(msg?.type) || !Number.isSafeInteger(msg.revision) ||
            !msg.answers || typeof msg.answers!=='object' || Array.isArray(msg.answers)) return;
        const body={p_attempt_id:attempt.id,p_revision:isSave?attempt.revision:msg.revision,p_answers:msg.answers,p_review:attempt.marked_for_review};
        if (msg.type==='save') {
          const revision=await rpc<number>('exam_save_answers',body);
          attempt.revision=revision;
          await post({type:'saved',revision,sequence:msg.sequence});
        } else {
          const result=await rpc<Attempt>('exam_submit',body);
          if (result.id!==attempt.id || !result.submitted_at) throw new Error('Submission could not be confirmed.');
          attempt=result;
          await post({type:'state',state:result});
          await scores();
        }
      }).catch(async error=>{
        if (isSave) blocked=true;
        await post({type:'error',operation:msg?.type,message:error instanceof Error?error.message:'The exam service is unavailable.'});
      });
    });
    const checkOwner=async()=>{ if (!closed && !await active()) panel.dispose(); };
    const accountChanges=auth.onDidChange(checkOwner);
    const configChanges=vscode.workspace.onDidChangeConfiguration(checkOwner);
    panel.onDidDispose(()=>{closed=true;panels.delete(key);receive.dispose();accountChanges.dispose();configChanges.dispose();});
    const nonce=randomBytes(16).toString('hex');
    const script=panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media','crtAssessment.js'));
    panel.webview.html=assessmentHtml(lesson,nonce,script.toString());
  });
}

export function assessmentHtml(lesson:string,nonce:string,script:string) {
  const title=lesson===CRT_ENTRY?'Entry diagnostic':'Exit mock';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <title>${title}</title><style nonce="${nonce}">body{max-width:58rem;margin:2rem auto;padding:0 1.3rem;font:var(--vscode-font-size,14px)/1.5 var(--vscode-font-family,sans-serif);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}
  h1,h2{line-height:1.25}header{position:sticky;top:0;background:var(--vscode-editor-background);padding:.5rem 0;border-bottom:1px solid var(--vscode-panel-border);z-index:1}header p{margin:.2rem 0}fieldset{margin:1.35rem 0;padding:.4rem 0;border:0}legend{font-weight:600;white-space:pre-wrap}label{display:block;padding:.2rem 0}input[type=text],textarea{box-sizing:border-box;width:100%;max-width:40rem;padding:.5rem;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border))}textarea{min-height:5rem}button{cursor:pointer;margin:.4rem .5rem .4rem 0;padding:.45rem .85rem;font:inherit;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:disabled{opacity:.55;cursor:default}
  table{border-collapse:collapse;min-width:65%}th,td{text-align:left;padding:.4rem .8rem;border-bottom:1px solid var(--vscode-panel-border)}:focus-visible{outline:2px solid var(--vscode-focusBorder)}</style></head>
  <body data-entry="${CRT_ENTRY}" data-exit="${CRT_EXIT}"><h1>${title}</h1><header><strong id="section"></strong><p id="clock"></p><p id="save-status" role="status">Opening your assessment…</p></header>
  <main><p id="instructions" hidden>Each section lasts 20 minutes. Your answers save as you work. You can close and resume while the clock runs. At the deadline, the exam service grades your saved answers.</p>
  <div id="questions"></div><button type="button" id="close" hidden>Save and close</button><button type="button" id="submit" hidden>Submit assessment</button>
  <div id="confirmation" hidden><p id="confirm-note"></p><button id="confirm" type="button">Confirm submission</button><button id="cancel" type="button">Keep working</button></div>
  <button id="retry" type="button" hidden>Reload saved attempt</button>
  <details id="review" hidden><summary>Review submitted answers</summary><ol></ol></details>
  <section id="results" hidden><h2>Entry and exit scores</h2><table><thead><tr><th scope="col">Section</th><th scope="col">Entry diagnostic</th><th scope="col">Exit mock</th></tr></thead><tbody></tbody></table><button type="button" id="refresh">Refresh scores</button></section></main>
  <script nonce="${nonce}" src="${script}"></script></body></html>`;
}
