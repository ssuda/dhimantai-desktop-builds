/** Drive the learner's Shelf workflow against the course container and disposable coursework service. */
import * as assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import { Auth } from '../../src/auth';
import { CourseEngine } from '../../src/courseEngine';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { checkArguments } from '../../src/projectCore';
import { ProjectResults } from '../../src/projectResults';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

export async function run() {
  const ext = vscode.extensions.getExtension<{auth:Auth; projectResults:ProjectResults}>('optficial.dhimantai-learning')!;
  const {auth, projectResults} = await ext.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const account = (await auth.session())!.user.id;
  const environment = vscode.workspace.getConfiguration('dhimantai').get<string>('environment','production');
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const engine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!, process.env.DHIMANTAI_PROJECT_CONTAINER!, dirname(root));
  const original = CourseWorkspaces.prototype.forProject;
  const originalGrade = Api.prototype.courseGrade;
  let releaseDashboard = () => {};
  CourseWorkspaces.prototype.forProject = async () => engine;
  const git = (...args:string[]) => execFileSync('git',['-c','user.name=Shelf learner','-c','user.email=learner@example.test',...args],{cwd:root,encoding:'utf8'}).trim();
  const cdp = await connect();
  const panel = (expression:string) => cdp.webview('d => d.getElementById("submitProject") ? ('+expression+')(d) : null');
  const wait = async (check:()=>Promise<unknown>, label:string) => {
    for (let i=0;i<250;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,120)); }
    throw new Error(label+' '+await panel('d=>[d.getElementById("step").value,d.getElementById("status").textContent,d.getElementById("noteError").textContent]'));
  };
  const save = (answer:string, button='checkpoint') => panel('d=>{d.getElementById("note").value='+JSON.stringify(answer)+';d.getElementById('+JSON.stringify(button)+').click();return true;}');
  const progress = (count:number,step:number) => wait(()=>panel('d=>d.getElementById("step").value==="'+step+'" && d.getElementById("progressText").textContent.startsWith("'+count+'/7") && !d.getElementById("checkpoint").disabled'), 'Expected verified milestones '+count);
  const complete = async (answer:string,count:number) => {await save(answer); await progress(count, Math.min(count,6));};
  try {
    const visibilityTest = readFileSync(join(ext.extensionPath, 'test/integration/shelfGitVisibility.py'), 'utf8');
    const historyCheck = checkArguments({check:'shelf-evidence:history'});
    await promisify(execFile)(engine.bin, engine.execArgs(root, 'python', ['-I', '-B', '-c', visibilityTest, ...historyCheck]), {timeout:20_000});
    await vscode.commands.executeCommand('dhimantai.openBuildStudio',root);
    await progress(0,0);
    await save('unverified draft','saveDraft');
    await wait(()=>panel('d=>d.getElementById("saved").textContent.includes("Checkpoint saved")'),'Save draft');
    await save('incorrect');
    await wait(()=>panel('d=>d.getElementById("noteError").textContent.includes("does not match")'),'Reject unsupported checkpoint');
    await progress(0,0);
    await complete('shelf/__main__.py -> shelf/cli.py -> shelf/search.py',1);
    await complete('No books found. -> Dune, Children of Dune',2);
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    await vscode.commands.executeCommand('dhimantai.openProjectMentor',root);
    await progress(2,2);
    await save('test_issue_12');
    await wait(()=>panel('d=>d.getElementById("noteError").textContent.includes("regression test")'),'Reject missing regression test');
    writeFileSync(join(root,'tests/test_issue_12.py'),"import unittest\nfrom shelf.models import Book\nfrom shelf.search import search\n\nclass SearchRegression(unittest.TestCase):\n    def test_issue_12(self):\n        book = Book('Dune', 'Frank Herbert', 1965)\n        self.assertEqual(search([book], 'dune'), [book])\n");
    await complete('test_issue_12',3);
    await panel('d=>{const field=d.getElementById("message");field.value="Which earlier observation explains this test?";field.dispatchEvent(new Event("input",{bubbles:true}));d.getElementById("composer").requestSubmit();return true;}');
    await wait(()=>panel('d=>d.getElementById("conversation").textContent.includes("Your earlier search returned no books")'),'Earlier reproduction and regression reach the Instructor together');
    const culprit = git('log','-1','--format=%h','-S','if wanted in getattr(book, field)','start','--','shelf/search.py');
    await complete(culprit,4);
    git('switch','-c','fix-search-case');
    const source = join(root,'shelf/search.py');
    writeFileSync(source, readFileSync(source,'utf8').replace('if wanted in getattr(book, field)','if wanted in normalize(getattr(book, field))'));
    await complete('fix-search-case',5);
    git('add','shelf/search.py','tests/test_issue_12.py'); git('commit','-qm','Fix case-insensitive searches for #12');
    await complete(git('rev-parse','--short','HEAD'),6);
    writeFileSync(join(root,'PR.md'),'## Cause\nCommit '+culprit+' compared a normalized query to original title and author fields.\n\n## Fix\nNormalize the searched book field while retaining the normalized query.\n\n## Test\nAdded an assertion for lowercase dune and ran python check.py. No external help.\n');
    git('add','PR.md'); git('commit','-qm','Document the cause and regression');
    const checker = join(root,'check.py'), supplied = readFileSync(checker);
    writeFileSync(checker,'print("11 of 11 checks passed.")\n');
    await save(git('rev-parse','--short','HEAD'));
    await wait(()=>panel('d=>d.getElementById("noteError").textContent.includes("Restore the supplied check.py")'),'Reject a replaced final checker');
    await progress(6,6);
    writeFileSync(checker,supplied);
    await complete(git('rev-parse','--short','HEAD'),7);
    await panel('d=>{d.getElementById("submitProject").click();return true;}');
    await wait(()=>panel('d=>d.getElementById("submitProject").textContent==="Sync result" && !d.getElementById("submitProject").disabled && d.getElementById("submissionHelp").textContent.includes("pending")'),'Queue lost acknowledgement');
    const saved = projectResults.get(environment,account,root)!.submissions;
    assert.equal(saved.length,1); assert.match(saved[0].runs[0].output,/11 of 11 checks passed/);
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    await vscode.commands.executeCommand('dhimantai.openProjectMentor',root);
    await wait(()=>panel('d=>d.getElementById("submitProject").textContent==="Sync result" && !d.getElementById("submitProject").disabled'),'Reopen the original pending result');
    await panel('d=>{d.getElementById("submitProject").click();return true;}');
    await wait(()=>panel('d=>d.getElementById("status").textContent.startsWith("Simulated lost acknowledgement") && !d.getElementById("submitProject").disabled'),'Retry the original result from the Instructor');
    const dashboardGate = new Promise<void>(resolve => { releaseDashboard = resolve; });
    Api.prototype.courseGrade = async function(course) {
      const grade = await originalGrade.call(this,course);
      await dashboardGate;
      return grade;
    };
    const openingGrade = vscode.commands.executeCommand('dhimantai.courseGrade','__certificates__');
    const grade = (expression:string) => cdp.webview('d => d.getElementById("notice") && d.title==="Course grade & certificate" ? ('+expression+')(d) : null');
    await wait(()=>grade('d=>d.getElementById("notice").textContent.includes("Loading") && d.querySelector("[data-action=sync]")?.disabled===false'),'Pending result on My certificates');
    await grade('d=>{d.querySelector("[data-action=sync]").click();return true;}');
    await wait(async () => {
      const state = await (await fetch(process.env.DHIMANTAI_TEST_SERVER + '/__state')).json() as {requests:string[]};
      return state.requests.filter(r=>r==='POST /coursework/projects/shelf/result').length === 3;
    },'Retry while the certificate library is loading');
    releaseDashboard();
    await openingGrade;
    if (vscode.env.appName === 'dhimantAI') {
      await wait(()=>cdp.evaluate('!document.querySelector(".part.sidebar")?.checkVisibility() && !document.querySelector(".part.auxiliarybar")?.checkVisibility()'),'Hide project panels when viewing certificates');
    }
    await wait(()=>grade('d=>d.getElementById("notice").textContent.includes("synced") && !d.querySelector("[data-action=sync]")'),'Acknowledged retry clears pending count');
    await vscode.commands.executeCommand('dhimantai.openProjectMentor',root);
    await wait(()=>panel('d=>d.getElementById("submitProject").textContent==="View course grade"'),'Restore confirmed submission');
    await panel('d=>{d.getElementById("submitProject").click();return true;}');
    await wait(()=>grade('d=>[...d.querySelectorAll("tr")].some(r=>r.textContent.includes("Shelf Capstone") && r.textContent.includes("100/100"))'),'Python gradebook shows Shelf credit');
    assert.deepEqual(projectResults.get(environment,account,root)!.submissions.map(result=>result.id),[saved[0].id]);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({milestones:7,finalChecks:11,request:saved[0].id,branch:saved[0].git.branch,commit:saved[0].git.head,projectScore:100,pending:0}));
  } finally {
    releaseDashboard();
    Api.prototype.courseGrade = originalGrade;
    CourseWorkspaces.prototype.forProject = original;
    cdp.close();
  }
}
