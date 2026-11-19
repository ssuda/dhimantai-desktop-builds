import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {notebookResume, unfinishedQuestion} from '../src/notebookContinuity';
import {emptyNotebook} from '../src/tutorNotebook';
import {TutorNotebookStore} from '../src/tutorNotebookStore';
import {LessonRuntimeJournal, lessonScript} from '../src/lessonRuntimeJournal';
import {NotebookCells} from '../src/notebookCells';
import {readCourseNotes} from '../src/courseNoteStore';

test('resume keeps unanswered and submitted questions pending until their own feedback, excluding private notes',()=>{
  const book=emptyNotebook();
  book.cells.push({id:'explanation',kind:'board',text:'Setup',packet:{active_subtopic:'Files'}},
    {id:'question',kind:'board',text:'Your turn: saved?',packet:{is_question_prompt:true,tutor_checkpoint_id:'q1',tutor_question_prompt:'Read saved',active_subtopic:'Files'}},
    {id:'private',kind:'note',text:'PRIVATE NOTE'},
    {id:'unrelated',kind:'board',text:'Earlier feedback',packet:{tutor_feedback:true,tutor_checkpoint_id:'q0'}});
  assert.equal(unfinishedQuestion(book)?.id,'question');
  assert.equal(notebookResume(book)?.question?.text,'Read saved');
  assert.doesNotMatch(JSON.stringify(notebookResume(book)),/PRIVATE NOTE/);
  book.cells[1].packet!.student_answer='my draft';
  assert.equal(notebookResume(book)?.question?.submitted,true);
  book.cells.push({id:'feedback',kind:'board',text:'Feedback',packet:{tutor_feedback:true,tutor_checkpoint_id:'q1'}});
  assert.equal(unfinishedQuestion(book),undefined);
});

test('multibyte resume context respects RPC budget and never labels drafts as executed',()=>{
  const book=emptyNotebook();
  book.cells.push({id:'q',kind:'board',text:'తెలుగు'.repeat(900),packet:{is_question_prompt:true,tutor_checkpoint_id:'q'}});
  for(let i=1;i<=4;i++)book.drafts.push({key:`q:${i}`,snippet:`code-${i}`,source:'తెలుగు'.repeat(300),language:'python',stdin:'',prediction:'',explanation:'',helped:false});
  const resume=notebookResume(book)!;
  assert.ok(new TextEncoder().encode(JSON.stringify(resume)).length<=11500);
  assert.equal(resume.kernel,'unverified');
  assert.equal(resume.question?.text,'', 'an oversized question must not become a truncated authoritative prompt');
});

test('course notes aggregate existing chapters while isolating account, environment and course',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'course-notes-'));
  try {
    for(const [env,owner,chapter,text] of [['staging','a','one','Python 3.12'],['staging','a','two','Key takeaway'],['staging','b','one','OTHER ACCOUNT'],['prod','a','one','OTHER ENV'],['staging','a','other','OTHER COURSE']]){
      const store=new TutorNotebookStore(directory,env,owner+'\0tutor:'+chapter), book=await store.load();
      book.cells.push({id:'note',kind:'note',text},{id:'board',kind:'board',text:'Not a private note'}, {id:'blank',kind:'note',text:'  \n '});await store.save(book);
    }
    const notes=await readCourseNotes(directory,'staging','a',[{scope:'\0tutor:one',chapter:'One'},{scope:'\0tutor:two',chapter:'Two'}]);
    assert.deepEqual(notes.map(n=>n.text),['Python 3.12','Key takeaway']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('real Python definitions survive explicit journal replay after a fresh process; files and script persist',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lesson-restore-'));
  const runtime=()=>new NotebookCells(()=>({}),undefined,async()=>directory,10000);
  let cells=runtime();
  try {
    const journal=new LessonRuntimeJournal(join(directory,'lesson.runs.json'));await journal.load();
    for(const [index,source] of ['saved = 41\nopen("environment.txt", "w").write("python")','saved += 1'].entries()) {
      const snapshot={snippet:`code-${index+1}`,revision:0,language:'python',source,stdin:'',question:'Setup'};
      assert.equal((await cells.run('python',source)).exit_code,0);await journal.record(snapshot);
    }
    await writeFile(join(directory,'lesson.py'),lessonScript(journal.runs));
    await cells.close(); cells=runtime();assert.equal(cells.live,false);
    assert.equal(await readFile(join(directory,'environment.txt'),'utf8'),'python');
    const reopened=new LessonRuntimeJournal(journal.file);await reopened.load();
    assert.equal(cells.live,false,'loading history must not execute code');
    const lost=await cells.run('python','print(saved)');
    assert.notEqual(lost.exit_code,0);assert.match(lost.stderr+lost.stdout,/NameError/);
    await cells.close();cells=runtime();
    for(const run of reopened.runs)assert.equal((await cells.run(run.language,run.source,run.stdin)).exit_code,0);
    assert.equal((await cells.run('python','print(saved)')).stdout,'42\n');
    const script=await readFile(join(directory,'lesson.py'),'utf8');assert.match(script,/saved = 41[\s\S]*saved \+= 1/);
    const other=new LessonRuntimeJournal(join(directory,'other.runs.json'));await other.load();assert.equal(other.runs.length,0);
    await reopened.clear();await assert.rejects(journal.record({snippet:'code-3',revision:0,language:'python',source:'x=1',stdin:'',question:'Setup'}),/another window/);
  } finally {await cells.close();await rm(directory,{recursive:true,force:true});}
});
