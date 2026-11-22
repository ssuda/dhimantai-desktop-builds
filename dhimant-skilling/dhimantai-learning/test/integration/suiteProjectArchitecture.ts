import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import type { Auth } from '../../src/auth';
import { CourseEngine } from '../../src/courseEngine';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

/** Uses an isolated test Instructor API over loopback and a real course container. */
export async function run() {
  const ext = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await ext.activate();
  const session = await auth.signInWithPassword(EMAIL, PASSWORD);
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath, parent = dirname(root);
  const engine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!, process.env.DHIMANTAI_PROJECT_CONTAINER!, parent);
  const savedEngine = CourseWorkspaces.prototype.forProject, savedRecord = CourseWorkspaces.prototype.recordFor;
  const chat = Api.prototype.notebookCoach;
  let automatic = 0;
  const cdp = await connect();
  const ui = (expression:string) => cdp.webview(`d => {if (!d.getElementById('architecturePractice') || d.defaultView.frameElement?.id !== 'active-frame') return null; return (${expression})(d);}`);
  const wait = async (id:string, expected:string) => {
    for (let i=0; i<200; i++) {
      if (String(await ui(`d => d.getElementById('${id}').textContent`)).includes(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Waiting for '+id+' to show '+expected+'. Panel status: '+await ui("d=>d.getElementById('status').textContent"));
  };
  const click = (id:string) => ui(`d => {d.getElementById('${id}').click(); return true;}`);
  const predict = (location:string, count:number) => ui(`d => {
    d.getElementById('architectureLocation').value='${location}';
    d.getElementById('architectureCount').value='${count}';
    d.getElementById('architecturePredict').click(); return true;}`);
  const saveSource = async (file: string, replacement: string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), replacement);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await wait('status', 'Files saved.');
  };
  try {
    CourseWorkspaces.prototype.forProject = async () => engine;
    CourseWorkspaces.prototype.recordFor = () => ({root,course:'Python',key:'architecture-test',account:session.user.id,
      environment:vscode.workspace.getConfiguration('dhimantai').get('environment','production')});
    Api.prototype.notebookCoach = async (_path, body:any) => {
      if (body.project_context.project_id==='field-dispatch') automatic++;
      return {guidance:'',prompt:'',line:null};
    };
    await vscode.commands.executeCommand('dhimantai.openProjectCoach', root);
    await wait('title','Checkout previews');
    await click('hint'); await wait('architectureMemory','a tracing hint');
    await predict('pricing.py:6',2); await wait('architectureMemory','on your first prediction, with a tracing hint');
    await click('check'); await wait('checkState','failed');
    await saveSource(join(root,'pricing.py'), 'def price(cents, member):\n    return cents - cents // 10 if member else cents\n\ndef preview(cents, member, receipts):\n    return price(cents, member)\n\ndef checkout(cents, member, receipts):\n    total = price(cents, member)\n    receipts.append(total)\n    return total\n');
    await click('check'); await wait('architectureMemory','repair passed with a tracing hint');
    const second = join(parent,'field-dispatch');
    // Exercise the normal companion-project command. Keep Electron in the test window when it opens the workspace.
    const execute = vscode.commands.executeCommand, info = vscode.window.showInformationMessage;
    let opened = false;
    try {
      (vscode.commands as any).executeCommand = async (name:string, ...args:any[]) => {
        if (name === 'dhimantai.projectFolder') {
          assert.deepEqual(args[0], {kind:'bundledProject', projectId:'field-dispatch'});
          return vscode.Uri.file(parent);
        }
        if (name === 'vscode.openFolder') {
          const workspace = JSON.parse(readFileSync(args[0].fsPath, 'utf8'));
          assert.equal(workspace.folders[0].path, second);
          opened = true;
          return execute('dhimantai.openProjectCoach', second);
        }
        return execute(name, ...args);
      };
      (vscode.window as any).showInformationMessage = async () => 'Open in Current Window';
      await click('architectureNext');
      await wait('architectureMemory','Try this case independently');
      assert.ok(opened);
    } finally {
      (vscode.commands as any).executeCommand = execute;
      (vscode.window as any).showInformationMessage = info;
    }
    const file = join(second,'dispatch.py'), starter = readFileSync(file,'utf8');
    await predict('dispatch.py:15',4); await wait('architectureMemory','on your first prediction, without recorded help');
    await saveSource(file, starter.replace('def assign(self, urgent, distance):','def estimate(self, urgent, distance):')
      .replace('        self.board.append(crew)\n','').replace('def estimate(self, urgent, distance):\n        return self.assign(urgent, distance)',
        'def assign(self, urgent, distance):\n        crew = self.estimate(urgent, distance)\n        self.board.append(crew)\n        return crew'));
    assert.equal(automatic,0);
    await click('check'); await wait('architectureMemory','Earlier, you completed Checkout previews with a tracing hint.');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach',second);
    await wait('architectureMemory','Your local repair passed without recorded help.');
    const record = await ui("d => d.getElementById('architectureMemory').textContent");
    if (process.env.DHIMANTAI_UX_OUT) {
      mkdirSync(process.env.DHIMANTAI_UX_OUT,{recursive:true});
      await vscode.commands.executeCommand('notifications.clearAll');
      const image = await cdp.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(process.env.DHIMANTAI_UX_OUT,'architecture-transfer.png'),Buffer.from(image.data,'base64'));
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({results:[{step:'guided practice and independent transfer',pass:true}],record},null,2));
  } finally {
    CourseWorkspaces.prototype.forProject=savedEngine; CourseWorkspaces.prototype.recordFor=savedRecord;
    Api.prototype.notebookCoach=chat; cdp.close();
  }
}
