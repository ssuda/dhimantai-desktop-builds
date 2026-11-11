/** Explicit staging acceptance. Requires a dedicated, already-enrolled QA account file. */
import * as assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import type {PracticeBrowser} from '../../src/practiceBrowser';

export async function run() {
  const config = JSON.parse(process.env.DHIMANTAI_TEST_ENVIRONMENT ?? '{}');
  assert.equal(config.apiUrl, 'https://api-staging.dhimant.ai');
  const qa = JSON.parse(readFileSync(process.env.DHIMANTAI_ENGINEERING_QA_FILE!, 'utf8'));
  assert.match(qa.email, /^qa\.engineering\..*@example\.invalid$/);
  const manifest = JSON.parse(readFileSync(process.env.DHIMANTAI_ENGINEERING_MANIFEST!, 'utf8'));
  const ids = new Set<string>(manifest.courses.flatMap((c: any) => c.chapters.map((ch: any) => ch.id)));
  const courseCount = manifest.courses.length, chapterCount = ids.size;
  // Challenges with one right behaviour are coded Practice questions with hidden tests; the rest are written.
  const challengeKind = new Map<string, string>(manifest.courses.map((c: any) => [c.chapters[2].id, c.chapters[2].question_type]));
  const results: {step: string; ok: boolean; error?: string}[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    try {await body(); results.push({step,ok:true});}
    catch (error) {results.push({step,ok:false,error:String(error instanceof Error ? error.stack : error)});}
  };
  const {auth,practice} = await vscode.extensions.getExtension<{auth:Auth;practice:PracticeBrowser}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(qa.email,qa.password);
  const create = vscode.window.createWebviewPanel;
  const panels: vscode.WebviewPanel[] = [];
  let host: vscode.WebviewPanel, receive: (msg: any) => Promise<void>;
  const responses: any[] = [];
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const panel = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      host=panel;panels.push(panel);
      (panel.webview as any).onDidReceiveMessage = (handler: any) => {receive=handler;return new vscode.Disposable(()=>{});};
      // Drive the real host handlers, retaining the real webview and live HTTP calls.
      (panel.webview as any).postMessage = async (msg: any) => {responses.push(msg);return true;};
    }
    return panel;
  };
  let question: any;
  try {
    await check('every course and unlocked chapter in the manifest appears in the actual Practice tree',async()=>{
      const courses=(await practice.getChildren()).filter(n=>n.kind==='course' && n.course.chapters.some(ch=>ids.has(ch.id)));
      assert.equal(courses.length,courseCount);let chapters=0,questions=0;
      for (const course of courses) {
        for (const node of await practice.getChildren(course)) {
          assert.equal(node.kind,'chapter');if(node.kind!=='chapter')continue;
          // A QA learner with no purchases: free courses open fully, paid ones preview only chapter 1.
          const paid=manifest.courses.find((c:any)=>c.chapters.some((ch:any)=>ch.id===node.chapter.id));
          assert.equal(node.chapter.locked,!paid.is_free && paid.chapters[0].id!==node.chapter.id);chapters++;
          if(node.chapter.locked)continue;
          if(!challengeKind.has(node.chapter.id))continue;
          const pool=(await practice.getChildren(node)).find(n=>n.kind==='pool' && n.pool==='textbook')!;
          const topic=(await practice.getChildren(pool)).find(n=>n.kind==='topic')!;
          const task=(await practice.getChildren(topic)).find(n=>n.kind==='question')!;
          assert.equal(task.kind,'question');if(task.kind!=='question')continue;
          if(challengeKind.get(node.chapter.id)==='coding') assert.equal(task.question.language,'python');
          else assert.equal(task.question.kind,'written');
          questions++;
          if(course.kind==='course' && course.course.name==='Git for Everyday Engineering')question=task;
        }
      }
      assert.equal(chapters,chapterCount);assert.equal(questions,manifest.courses.filter((c:any)=>c.is_free).length);assert.ok(question);
    });
    await check('Instructor lesson picker locks only paid chapters beyond the free preview, never for preparation',async()=>{
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      await receive!({type:'ready'});await receive!({type:'tutorLessons',attempt:1});
      const reply=responses.filter(r=>r.type==='tutorLessons').at(-1);assert.ok(!reply.error,reply.error);
      const chapters=reply.courses.flatMap((c:any)=>c.chapters).filter((ch:any)=>ids.has(ch.id));
      assert.equal(chapters.length,chapterCount);
      const preview=new Set<string>(manifest.courses.filter((c:any)=>!c.is_free).flatMap((c:any)=>c.chapters.slice(1).map((ch:any)=>ch.id)));
      for(const ch of chapters) assert.equal(!!ch.locked,preview.has(ch.id),ch.id);
    });
    await check('opening a written challenge uses the existing Practice command and preserves the Instructor tab',async()=>{
      const tutor=host!;let disposed=false;tutor.onDidDispose(()=>disposed=true);
      const command=practice.getTreeItem(question).command!;
      await vscode.commands.executeCommand(command.command,...command.arguments!);
      assert.notEqual(host!,tutor);assert.equal(disposed,false);
      assert.match(host!.webview.html,/Submit for feedback/);assert.match(host!.webview.html,/Optional preparation/);
      assert.doesNotMatch(host!.webview.html,/id="runtime"|Run code|Purchase to unlock/);
    });
    const draft={answer:'Merging formal into main conflicted on greeting.txt: main said hi and formal said good morning. I kept good morning, committed the merge, then reverted the goodbye commit. git log --oneline shows both branches and the revert; git status is clean. I have not pasted the full log yet.',assistance:'Git documentation; no AI help before this submission',usedTutor:false};
    await check('local written draft survives closing and reopening the actual Practice panel',async()=>{
      await receive!({type:'save',sequence:1,...draft});assert.equal(responses.at(-1).type,'saved');
      host!.dispose();await practice.openQuestion(question);
      assert.match(host!.webview.html,/Merging formal into main/);assert.match(host!.webview.html,/Git documentation/);
    });
    await check('explicit submission returns live staging feedback without a grade',async()=>{
      await receive!({type:'feedback',mode:'review',message:'What should I verify next?',...draft});
      const feedback=responses.filter(r=>r.type==='feedback').at(-1);assert.ok(!feedback.error,feedback.error);
      assert.equal(feedback.assessment,'feedback_only');assert.equal(feedback.assistance,draft.assistance);
      assert.ok(feedback.feedback.length>20);assert.ok(feedback.next_step.length>5);
      assert.equal(feedback.grade,undefined);assert.equal(feedback.completion,undefined);
    });
  } finally {
    (vscode.window as any).createWebviewPanel=create;panels.forEach(p=>p.dispose());
    await auth.signOut();writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify(results,null,2));
  }
  assert.ok(results.every(r=>r.ok),JSON.stringify(results.filter(r=>!r.ok)));
}
