import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

export async function run() {
  const {auth} = await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  const session = await auth.signInWithPassword(EMAIL,PASSWORD);
  const root=vscode.workspace.workspaceFolders![0].uri.fsPath, parent=dirname(root), target=join(parent,'festival-desk');
  const git = (cwd:string,...args:string[]) => execFileSync('git',['-c','core.hooksPath=','-c','commit.gpgsign=false',
    '-c','user.name=Test student','-c','user.email=student@example.invalid',...args],{cwd,encoding:'utf8',stdio:'pipe'}).trim();
  const execute=vscode.commands.executeCommand, info=vscode.window.showInformationMessage, record=CourseWorkspaces.prototype.recordFor;
  const cdp=await connect();
  const ui=(fn:string) => cdp.webview(`d=>{if(!d.getElementById('architecturePractice') || d.defaultView.frameElement?.id !== 'active-frame')return null;return (${fn})(d);}`);
  const wait=async(id:string,text:string) => {
    for(let i=0;i<260;i++) {
      if(String(await ui(`d=>d.getElementById('${id}').textContent`)).includes(text))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Waiting for '+text+' in '+id+' '+await ui("d=>d.getElementById('coach').textContent.slice(-4000)"));
  };
  const click=async(id:string) => {
    for(let i=0;i<120;i++) {
      if(await ui(`d=>{const e=d.getElementById('${id}');if(e.disabled||e.hidden)return false;e.click();return true;}`))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Unavailable control '+id);
  };
  try {
    CourseWorkspaces.prototype.recordFor=()=>({root,course:'Python',key:'git-test',account:session.user.id,
      environment:vscode.workspace.getConfiguration('dhimantai').get('environment','production')});
    git(root,'add','stock.py'); git(root,'commit','-m','Set initial capacity');
    git(root,'switch','-c','team-update');
    writeFileSync(join(root,'stock.py'),'limit = 12\n');git(root,'commit','-am','Raise capacity');
    git(root,'switch','-c','my-work','HEAD~1');
    writeFileSync(join(root,'stock.py'),'limit = 8\n');git(root,'commit','-am','Limit walk-ins');
    assert.throws(()=>git(root,'merge','--no-edit','team-update'));
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(join(root,'stock.py')));
    await vscode.window.showTextDocument(doc);
    await execute('dhimantai.openProjectCoach');
    await wait('title','Your project');
    const edit=new vscode.WorkspaceEdit();edit.insert(doc.uri,doc.positionAt(doc.getText().length),'\n');
    await vscode.workspace.applyEdit(edit);await doc.save();
    await wait('conversation','Git reports an unresolved path.');
    assert.equal(await ui("d=>d.getElementById('architectureFollowup').hidden"),true);
    await click('hint');await wait('conversation','Read the common ancestor');
    const advance=new URL('/__advance_practice',process.env.DHIMANTAI_TEST_MEMORY_URL);
    assert.equal(advance.hostname,'127.0.0.1');
    assert.ok((await fetch(advance,{method:'POST',headers:{Authorization:'Bearer '+process.env.DHIMANTAI_TEST_MEMORY_LEARNER}})).ok);
    await execute('dhimantai.openProjectCoach',root);
    await wait('architectureFollowup','Festival desk');
    (vscode.commands as any).executeCommand=async(name:string,...args:any[])=>{
      if(name==='dhimantai.projectFolder'){assert.equal(args[0].projectId,'festival-desk');return vscode.Uri.file(parent);}
      if(name==='vscode.openFolder'){assert.equal(JSON.parse(readFileSync(args[0].fsPath,'utf8')).folders[0].path,target);return execute('dhimantai.openProjectCoach',target);}
      return execute(name,...args);
    };
    (vscode.window as any).showInformationMessage=async()=>'Open in Current Window';
    await click('architectureFollowup');await wait('title','Festival desk');
    await wait('architectureMemory','Try this case independently');await wait('check','Check Git history');
    assert.equal(await ui("d=>d.getElementById('architectureIdentify').hidden"),true);
    git(target,'switch','-c','volunteer-changes');
    writeFileSync(join(target,'hours.json'),'{"opens":"08:00","closes":"16:00"}\n');git(target,'commit','-am','Open the desk for early arrivals');
    writeFileSync(join(target,'meeting.json'),'{"gate":"North"}\n');git(target,'commit','-am','Move the volunteer meeting point');
    // Instructor should observe the commits while keeping its coaching quiet.
    await wait('architectureMemory','You made two focused commits without recorded help.');
    assert.throws(()=>git(target,'merge','--no-edit','team/operations'));
    writeFileSync(join(target,'hours.json'),'{"opens":"08:00","closes":"18:00"}\n');git(target,'add','hours.json');git(target,'commit','--no-edit');
    await click('check');await wait('architectureMemory','You reconciled both sides of the merge without recorded help.');
    await execute('dhimantai.openProjectCoach',target);
    await wait('architectureMemory','resolving a merge conflict in stock.py.');
    assert.equal(git(root,'diff','--name-only','--diff-filter=U'),'stock.py');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({results:[{step:'Observe Git help in the original repository, then verify independent branch, commits and conflict resolution in another repository',pass:true}]}));
  } finally {
    CourseWorkspaces.prototype.recordFor=record;
    (vscode.commands as any).executeCommand=execute;(vscode.window as any).showInformationMessage=info;cdp.close();
  }
}
