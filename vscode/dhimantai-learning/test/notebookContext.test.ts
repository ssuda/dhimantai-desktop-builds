import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {notebookContext,sharedNotebookContext} from '../src/notebookContext';

test('public notebook context is bounded, excludes private notes and files, and drops stale runs',()=>{
  const snapshot = {snippet:'code-1',revision:0,language:'python',source:'print(42)',stdin:'',question:'Try code',files:[{name:'private.txt',content:'SECRET'}]};
  const cells = [{id:'private',kind:'note' as const,text:'SECRET NOTE'},{id:'lesson',kind:'board' as const,text:'Try a loop'}];
  const current = notebookContext(cells,[{snapshot,run:{success:true,output:'42',stderr:'',incomplete:false}}]);
  assert.equal(current.cells.length,2); assert.equal(current.cells[0].run?.output,'42');
  assert.doesNotMatch(JSON.stringify(current),/SECRET|private.txt/);
  const edited = notebookContext(cells,[{snapshot:{...snapshot,revision:1,source:'print(43)'}}]);
  assert.equal(edited.cells[0].run,undefined);
  const large = notebookContext(cells,Array.from({length:40},(_,n)=>({snapshot:{...snapshot,snippet:'code-'+(n+1),source:'界'.repeat(4000)}})),'code-40');
  assert.equal(large.truncated,true); assert.equal(large.cells[0].id,'code-40');
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).length<=9000);
  assert.ok(sharedNotebookContext(current));
  assert.equal(sharedNotebookContext({cells:[{id:'note',kind:'note',text:'private',truncated:false}],truncated:false}),undefined);
  assert.equal(sharedNotebookContext({cells:[{...current.cells[0],run:null}],truncated:false}),undefined);
});
