import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {instructorDraft,draftAttachments} from '../src/notebookHandoff';
import {emptyNotebook} from '../src/tutorNotebook';

test('handoff carries unsent text and editable code while preserving the destination draft and input',()=>{
  const target={...emptyNotebook(),textDraft:'My Instructor answer'};
  const source={...emptyNotebook(),textDraft:'Why does this fail?\n\nWhat I tried: two pointers',drafts:[{
    key:'cell-a:0',snippet:'code-1',language:'c',source:'int main() {}',stdin:'aba',prediction:'palindrome',explanation:'compare ends',helped:false,
  }]};
  const result=instructorDraft(target,source,'test');
  assert.equal(result.textDraft,source.textDraft);
  assert.equal(result.cells[0].text,target.textDraft);assert.equal(result.cells[0].kind,'note');
  assert.equal(result.cells[1].kind,'code');assert.equal(result.drafts[0].key,result.cells[1].id+':0');
  assert.equal(result.drafts[0].stdin,'aba');
  assert.equal(target.cells.length,0);assert.equal(source.drafts[0].key,'cell-a:0');
});

test('handoff attachments are bounded and keep only attachment data',()=>{
  assert.deepEqual(draftAttachments([{name:'attempt.png',type:'image/png',data:'YWJj',secret:'drop'}]),[
    {name:'attempt.png',type:'image/png',data:'YWJj'}]);
  assert.throws(()=>draftAttachments([{name:'script',type:'application/javascript',data:'YWJj'}]));
  assert.throws(()=>draftAttachments(Array(17).fill({name:'x.png',type:'image/png',data:'YWJj'})));
});
