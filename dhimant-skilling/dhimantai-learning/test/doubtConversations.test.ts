import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DoubtConversations} from '../src/doubtConversations';
import {TutorNotebookStore,NotebookConflictError} from '../src/tutorNotebookStore';
import {emptyNotebook} from '../src/tutorNotebook';

test('separate chats persist titles, drafts and chapter identity without crossing account or environment',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'doubt-chats-'));
  try {
    const chats=new DoubtConversations(directory,'staging','alice');
    const first=await chats.create('Python','classes'),second=await chats.create('Java','loops');
    first.book.cells.push({id:'question',kind:'message',text:'Why does ScriptedModel return this value?'});
    first.book.textDraft='My next question';await first.store.save(first.book);
    second.book.cells.push({id:'question',kind:'message',text:'Explain a for loop'});await second.store.save(second.book);
    const reopened=new DoubtConversations(directory,'staging','alice');
    assert.equal((await reopened.list()).length,2);
    assert.equal((await reopened.list()).find(chat=>chat.id===first.book.doubtId)?.title,'Why does ScriptedModel return this value?');
    assert.equal((await reopened.open(first.book.doubtId!)).book.textDraft,'My next question');
    assert.equal((await reopened.open(second.book.doubtId!)).book.cells.length,1);
    assert.deepEqual(await new DoubtConversations(directory,'production','alice').list(),[]);
    const other=new DoubtConversations(directory,'staging','bob');assert.deepEqual(await other.list(),[]);
    await assert.rejects(other.open(first.book.doubtId!),/unavailable/);
    const stale=await reopened.open(first.book.doubtId!);
    await first.store.save({...first.book,textDraft:'Newer draft'});
    await assert.rejects(stale.store.save({...stale.book,textDraft:'Old draft'}),NotebookConflictError);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('legacy divider migration keeps every conversation and its edits, is idempotent and preserves the original',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'doubt-migration-'));
  try {
    const legacy=new TutorNotebookStore(directory,'staging','learner\0doubt_solver:Python');
    await legacy.load();const book={...emptyNotebook(),lessonId:'classes',textDraft:'Continue this',cells:[
      {id:'first',kind:'recap' as const,text:'New doubt',packet:{doubt_divider:true,doubt_id:'old-first'}},
      {id:'q1',kind:'message' as const,text:'Why this class?'},
      {id:'code1',kind:'code' as const,text:''},
      {id:'second',kind:'recap' as const,text:'New doubt',packet:{doubt_divider:true,doubt_id:'old-second'}},
      {id:'q2',kind:'message' as const,text:'What about lists?'},
    ],drafts:[{key:'code1:0',snippet:'code-1',language:'python',source:'print(3)',stdin:'',prediction:'3',explanation:'',helped:false}]};
    await legacy.save(book);const chats=new DoubtConversations(directory,'staging','learner');await chats.migrate('Python','fallback');
    const history=await chats.list();assert.equal(history.length,2);
    const first=await chats.open(history.find(chat=>chat.title==='Why this class?')!.id);
    const second=await chats.open(history.find(chat=>chat.title==='What about lists?')!.id);
    assert.equal(first.book.drafts[0].source,'print(3)');assert.equal(first.book.textDraft,'');assert.equal(second.book.textDraft,'Continue this');
    assert.equal(second.book.drafts.length,0);assert.equal(second.book.lessonId,'classes');
    await first.store.save({...first.book,textDraft:'Edited since migration'});
    await chats.migrate('Python','fallback');assert.equal((await chats.list()).length,2);
    assert.equal((await chats.open(first.book.doubtId!)).book.textDraft,'Edited since migration');
    assert.deepEqual(await legacy.load(),book);
  } finally {await rm(directory,{recursive:true,force:true});}
});
