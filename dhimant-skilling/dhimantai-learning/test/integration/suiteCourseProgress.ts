import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD } from './contractServer';

/** Course navigation and saved coverage require no running language container. */
export async function run() {
  const results: {step: string; ok: boolean}[] = [];
  const extension = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await extension.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const create = vscode.window.createWebviewPanel, catalog = Api.prototype.practiceCatalog;
  const panels: vscode.WebviewPanel[] = [], replies: any[] = [];
  let receive: (message: any) => Promise<void>;
  Api.prototype.practiceCatalog = async () => ({languages:[], courses:[
    {name:'Python', chapters:[{id:'chapter',name:'Lists',progress:{status:'covered',covered:1,total:1,
      topics:[{id:'indexing',title:'Indexing',status:'covered'}]}}]},
    {name:'SQL',chapters:[{id:'sql',name:'Joins',progress:{status:'not_started',covered:0,total:1,
      topics:[{id:'join',title:'Inner join',status:'not_started'}]}}]},
  ]});
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const panel = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      panels.push(panel);
      (panel.webview as any).onDidReceiveMessage = (handler: typeof receive) => {
        receive = handler; return new vscode.Disposable(() => {});
      };
      (panel.webview as any).postMessage = async (message: any) => {replies.push(message); return true;};
    }
    return panel;
  };
  try {
    await vscode.commands.executeCommand('dhimantai.openLearningRoom', 'Python');
    await receive!({type:'ready'});
    await receive!({type:'tutorLessons',attempt:1});
    assert.equal(replies.at(-1).preferredCourse, 'Python');
    assert.equal(replies.at(-1).courses[0].chapters[0].progress.topics[0].status, 'covered');
    assert.match(panels[0].webview.html, /id="lesson-list"/);
    results.push({step:'Opening a catalog course selects its Instructor outline and loads saved topic coverage',ok:true});
    await vscode.commands.executeCommand('dhimantai.openLearningRoom', 'SQL');
    assert.equal(panels.length, 1, 'reuse the existing Instructor tab');
    assert.deepEqual(replies.at(-1), {type:'chooseCourse',course:'SQL'});
    await receive!({type:'tutorLessons',attempt:2});
    assert.equal(replies.at(-1).preferredCourse, 'SQL');
    assert.equal(replies.at(-1).courses[1].chapters[0].progress.status, 'not_started');
    results.push({step:'Switching courses reuses Instructor and keeps remaining topics distinct',ok:true});
    await vscode.commands.executeCommand('dhimantai.openLearningRoom', 'SQL');
    assert.deepEqual(replies.at(-1), {type:'chooseCourse',course:'SQL'}, 'reopening a course returns to its current outline');
  } finally {
    panels.forEach(panel => panel.dispose());
    Api.prototype.practiceCatalog = catalog;
    (vscode.window as any).createWebviewPanel = create;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results,null,2));
  }
}
