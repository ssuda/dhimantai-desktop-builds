import {readNotebook, TutorNotebook} from './tutorNotebook';
export interface DraftAttachment {name:string; type:string; data:string}
export function draftAttachments(value:unknown):DraftAttachment[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>16)throw new Error('Choose up to 16 attachments.');
  let total=0;
  return value.map(file=>{
    if(!file || typeof file.name!=='string' || file.name.length>120
      || !['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type)
      || typeof file.data!=='string' || file.data.length>14*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
      throw new Error('Could not carry an attachment to Instructor. Your draft is still here.');
    const bytes=Buffer.from(file.data,'base64').length;total+=bytes;
    if(!bytes || bytes>10*1024*1024 || total>20*1024*1024)throw new Error('Attachments exceed the 20 MB draft limit.');
    return {name:file.name,type:file.type,data:file.data};
  });
}

/** Copy the learner's draft and code without replacing existing Instructor work. */
export function instructorDraft(target:TutorNotebook, source:TutorNotebook, id:string):TutorNotebook {
  const result=readNotebook(target), draft=readNotebook(source);
  if (draft.textDraft?.trim()) {
    if (result.textDraft?.trim() && result.textDraft!==draft.textDraft) {
      result.cells.push({id:'handoff-draft-'+id,kind:'note',text:result.textDraft});
    }
    result.textDraft=draft.textDraft;
  }
  let snippet=Math.max(0,...result.drafts.map(code=>Number(code.snippet.slice(5))));
  for (const [index, code] of draft.drafts.entries()) {
    const cellId='handoff-code-'+id+'-'+index;
    result.cells.push({id:cellId,kind:'code',text:code.source,packet:{language:code.language}});
    result.drafts.push({...code,key:cellId+':0',snippet:'code-'+ ++snippet,skills:undefined});
  }
  for (const [index, note] of draft.cells.filter(cell=>cell.kind==='note').entries())
    result.cells.push({id:'handoff-note-'+id+'-'+index,kind:'note',text:note.text});
  return readNotebook(result);
}
