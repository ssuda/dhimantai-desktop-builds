import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { CourseEngine } from '../../src/courseEngine';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

export async function runPersonalPractice(debug = false) {
  const project = debug ? 'trail-log' : 'museum-entry', title = debug ? 'Trail log' : 'Museum entry';
  const origin = debug ? 'stock.py:4' : 'stock.py:2';
  const ext = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await ext.activate();
  const session = await auth.signInWithPassword(EMAIL, PASSWORD);
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath, parent = dirname(root);
  const engine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!, process.env.DHIMANTAI_PROJECT_CONTAINER!, parent);
  const savedEngine = CourseWorkspaces.prototype.forProject, savedRecord = CourseWorkspaces.prototype.recordFor;
  const execute = vscode.commands.executeCommand, info = vscode.window.showInformationMessage;
  const cdp = await connect();
  const ui = (expression:string) => cdp.webview(`d => {if (!d.getElementById('architecturePractice') || d.defaultView.frameElement?.id !== 'active-frame') return null; return (${expression})(d);}`);
  const wait = async (id:string, expected:string) => {
    for (let i=0; i<260; i++) {
      if (String(await ui(`d => d.getElementById('${id}').textContent`)).includes(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Waiting for '+expected+'. Panel: '+await ui("d=>d.getElementById('coach').textContent.slice(-3200)"));
  };
  const click = async (id:string) => {
    for (let i=0; i<150; i++) {
      if (await ui(`d => {const el=d.getElementById('${id}');if(el.hidden || el.disabled)return false;el.click();return true;}`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Control did not become available: '+id);
  };
  const save = async (path:string, source:string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),source);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await wait('status','Files saved.');
  };
  try {
    CourseWorkspaces.prototype.forProject = async () => engine;
    CourseWorkspaces.prototype.recordFor = () => ({root,course:'Python',key:'architecture-test',account:session.user.id,
      environment:vscode.workspace.getConfiguration('dhimantai').get('environment','production')});
    const source = join(root,'stock.py');
    await vscode.window.showTextDocument(vscode.Uri.file(source));
    await execute('dhimantai.openProjectCoach');
    await wait('title','Your project');
    await save(source,readFileSync(source,'utf8')+(debug
      ? '\ndef customer_items(item, cart=[]):\n    cart.append(item)\n    return list(cart)\n'
      : '\ndef counter_limit(items):\n    return items < 6\n'));
    await wait('conversation',origin);
    assert.equal(await ui("d=>d.getElementById('architectureFollowup').hidden"),true);
    await click('hint');
    await wait('conversation',debug ? 'Predict each result before running them.' : 'Try the exact boundary value');
    await click('hint');
    await wait('conversation',debug ? 'Where is the object created' : 'Which single decision');
    assert.equal(await ui("d=>d.getElementById('architectureFollowup').hidden"),true);
    const advance = new URL('/__advance_practice',process.env.DHIMANTAI_TEST_MEMORY_URL);
    assert.equal(advance.hostname,'127.0.0.1');
    assert.ok((await fetch(advance,{method:'POST',headers:{Authorization:'Bearer '+process.env.DHIMANTAI_TEST_MEMORY_LEARNER}})).ok);
    await execute('dhimantai.openProjectCoach',root);
    await wait('architectureFollowup',title);
    const target = join(parent,project);
    (vscode.commands as any).executeCommand = async (name:string,...args:any[]) => {
      if (name === 'dhimantai.projectFolder') {
        assert.equal(args[0].projectId,project);
        return vscode.Uri.file(parent);
      }
      if (name === 'vscode.openFolder') {
        assert.equal(JSON.parse(readFileSync(args[0].fsPath,'utf8')).folders[0].path,target);
        return execute('dhimantai.openProjectCoach',target);
      }
      return execute(name,...args);
    };
    (vscode.window as any).showInformationMessage = async () => 'Open in Current Window';
    await click('architectureFollowup');
    await wait('title',title);
    await wait('architectureMemory','Try this case independently');
    assert.ok(!String(await ui("d=>d.getElementById('architectureMemory').textContent")).includes('stock.py'));
    await ui(`d=>{d.getElementById('architectureLocation').value='${debug?'trips.py:4':'tickets.py:7'}';d.getElementById('architectureCount').value='${debug?2:1}';d.getElementById('architecturePredict').click();return true;}`);
    await wait('architectureMemory','on your first prediction, without recorded help');
    await click('check'); await wait('checkState','failed');
    if (debug) {
      const testPath = join(target,'test_regression.py');
      writeFileSync(testPath,'');
      await save(testPath,'import unittest\nfrom trips import record_stop\n\nclass Trips(unittest.TestCase):\n    def test_fresh_trip(self):\n        record_stop("Park")\n        self.assertEqual(record_stop("Pier"), ["Pier"])\n');
      await click('check');
      await wait('architectureMemory','Your test caught the original bug without recorded help.');
      assert.ok(!String(await ui("d=>d.getElementById('architectureMemory').textContent")).includes('Your local repair passed'));
      await save(join(target,'trips.py'),'def record_stop(name, stops=None):\n    if stops is None:\n        stops = []\n    stops.append(name)\n    return list(stops)\n');
    } else await save(join(target,'tickets.py'),'def kiosk_youth(age):\n    return age <= 16\n\ndef online_youth(age):\n    return kiosk_youth(age)\n');
    await click('check');
    await wait('architectureMemory','at '+origin+'.');
    await wait('architectureMemory','Your local repair passed without recorded help.');
    await execute('dhimantai.openProjectCoach',target);
    await wait('architectureMemory',(debug ? 'reproducing the failure and isolating the cause' : 'tracing the behavior and choosing the design')+' at '+origin+'.');
    const record = await ui("d=>d.getElementById('architectureMemory').textContent");
    if (process.env.DHIMANTAI_UX_OUT) {
      mkdirSync(process.env.DHIMANTAI_UX_OUT,{recursive:true});
      await execute('notifications.clearAll');
      const image = await cdp.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(process.env.DHIMANTAI_UX_OUT,debug ? 'debug-practice.png' : 'personal-architecture.png'),Buffer.from(image.data,'base64'));
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({results:[{step:debug ? 'own project debugging, delayed transfer, independent diagnosis, red test and verified repair' : 'own project review, delayed choice and unaided transfer',pass:true}],record}));
  } finally {
    CourseWorkspaces.prototype.forProject=savedEngine; CourseWorkspaces.prototype.recordFor=savedRecord;
    (vscode.commands as any).executeCommand=execute; (vscode.window as any).showInformationMessage=info;
    cdp.close();
  }
}

export const run = () => runPersonalPractice();
