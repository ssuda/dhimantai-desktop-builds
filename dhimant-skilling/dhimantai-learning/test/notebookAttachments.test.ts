import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const script = buildSync({entryPoints:[resolve(__dirname,'../../webview/notebookAttachments.ts')], bundle:true,
  write:false, format:'iife', globalName:'AttachmentKit', footer:{js:'globalThis.AttachmentKit = AttachmentKit;'}}).outputFiles[0].text;
function fixture() {
  const dom = new JSDOM('<div id="tray"></div><small id="notice"></small>', {runScripts:'outside-only'});
  const w = dom.window;
  w.URL.createObjectURL = () => 'blob:preview'; w.URL.revokeObjectURL = () => {};
  w.eval(script);
  const draft = new w.AttachmentKit.NotebookAttachments(w.document.getElementById('tray'), w.document.getElementById('notice'), () => {});
  const file = (name:string,type:string) => ({name,type,size:3,arrayBuffer:async () => new Uint8Array([1,2,3]).buffer});
  return {w,draft,file};
}
test('photos, PDFs and the student request travel as one correlated attachment turn', async () => {
  const {w,draft,file} = fixture();
  try {
    draft.add([file('photo.png','image/png'),file('notes.pdf','application/pdf')]);
    const calls:any[] = [];
    await draft.send({streamBytes:async (options:any) => {
      calls.push(options); return {write:async (bytes:Uint8Array) => assert.equal(bytes.length,3), close:async () => calls.push('closed')};
    }, sendText:async (text:string,options:any) => calls.push({text,...options})}, 'agent', 'Explain this diagram.', () => true);
    assert.equal(calls[0].topic,'images'); assert.equal(calls[2].mimeType,'application/pdf');
    assert.equal(calls[0].attributes.image_submission_id,calls[4].attributes.image_submission_id);
    assert.equal(calls[2].attributes.image_index,'1'); assert.equal(calls[4].attributes.image_count,'2');
    assert.match(calls[4].text,/Student typed message: Explain this diagram/);
    assert.equal(draft.count,2,'delivery is cleared only after the owning notebook confirms its current session');
    draft.clear(); assert.equal(w.document.getElementById('tray')!.hidden,true);
  } finally { w.close(); }
});
test('failed or stale attachment uploads retain the draft and never send an incomplete request', async () => {
  const {w,draft,file} = fixture();
  try {
    draft.add([file('notes.pdf','application/pdf')]);
    let textSent = false;
    const participant = {streamBytes:async () => { throw new Error('offline'); }, sendText:async () => { textSent=true; }};
    await assert.rejects(draft.send(participant,'agent','Explain',() => true),/offline/);
    assert.equal(draft.count,1); assert.equal(textSent,false);
    await assert.rejects(draft.send(participant,'agent','Explain',() => false),/Session changed/);
    assert.equal(textSent,false);
    draft.add([file('script.svg','image/svg+xml')]); assert.equal(draft.count,1);
    assert.match(w.document.getElementById('notice')!.textContent!,/PNG, JPEG, WebP, or PDF/);
    w.document.querySelector<HTMLButtonElement>('button')!.click(); assert.equal(draft.count,0);
  } finally { w.close(); }
});
test('Practice encodes attachments for one API request and refuses files over its smaller limits', async () => {
  const {w,draft,file} = fixture();
  try {
    draft.add([file('error.png','image/png'),file('notes.pdf','application/pdf')]);
    assert.deepEqual(JSON.parse(JSON.stringify(await draft.encoded())), [{name:'error.png',type:'image/png',data:'AQID'},{name:'notes.pdf',type:'application/pdf',data:'AQID'}]);
    draft.clear();
    draft.add([{...file('phone.jpg','image/jpeg'), size:3 * 1024 * 1024}]);
    await assert.rejects(draft.encoded(), /up to 2 MB each/);
    draft.clear();
    draft.add(['a','b','c','d','e'].map(n => file(n + '.png','image/png')));
    await assert.rejects(draft.encoded(), /up to 4 photos or PDFs/);
  } finally { w.close(); }
});

test('Study uploads original files without a separate chat message and restores action drafts',async()=>{
  const {w,draft,file}=fixture();
  try {
    draft.add([file('question.png','image/png'),file('worksheet.pdf','application/pdf')]);
    const saved=draft.snapshot();draft.restore([]);assert.equal(draft.count,0);draft.restore(saved);
    const streams:any[]=[];
    const result=await draft.upload({streamBytes:async(options:any)=>{streams.push(options);return {write:async()=>{},close:async()=>{}};}},'agent','Explain both.',()=>true);
    assert.equal(result.image_count,'2');assert.equal(draft.count,2);
    assert.equal(streams[0].attributes.image_submission_id,result.image_submission_id);
    assert.equal(streams[1].mimeType,'application/pdf');
  } finally {w.close();}
});

test('Doubt attachments respect the 16-page budget, keep files after a failed send and say which file is the question', async () => {
  const {w,draft,file} = fixture();
  const pdf = (name: string, pages: number) => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Pages /Count ' + pages + ' >>\n'
      + Array.from({length:pages}, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >>`).join('\n'));
    return {name, type:'application/pdf', size:bytes.length, arrayBuffer:async () => bytes.buffer};
  };
  try {
    assert.equal(w.AttachmentKit.pdfPages(new TextEncoder().encode('<< /Type /Pages >> << /Type/Page >> << /Type /Page >>')), 2);
    assert.equal(w.AttachmentKit.pdfPages(new Uint8Array([1,2,3])), 1, 'an unreadable count is one page; the server checks again');
    draft.add([pdf('chapter.pdf',10), pdf('worksheet.pdf',10)]);
    await new Promise(r => setTimeout(r,0)); await new Promise(r => setTimeout(r,0));
    assert.equal(draft.count,0);
    assert.match(w.document.getElementById('notice')!.textContent!, /20 pages.*up to 16 pages/);
    draft.add([pdf('chapter.pdf',10), ...['a','b','c','d','e','f'].map(n => file(n + '.png','image/png'))]);
    await new Promise(r => setTimeout(r,0)); await new Promise(r => setTimeout(r,0));
    assert.equal(draft.count,7); assert.equal(draft.pageCount,16);
    assert.match(w.document.getElementById('tray')!.textContent!, /PDF · 10 pages/);
    let fail = true;
    const sent: any[] = [];
    const participant = {streamBytes:async () => ({write:async () => {}, close:async () => {}}),
      sendText:async (text: string) => { if (fail) throw new Error('offline'); sent.push(text); }};
    await assert.rejects(draft.send(participant,'agent','Where did I go wrong?',() => true,'learner_attempt'), /offline/);
    assert.equal(draft.count,7,'files stay chosen until the agent receives them');
    fail = false;
    await draft.send(participant,'agent','Where did I go wrong?',() => true,'learner_attempt');
    assert.match(sent[0], /^\[STUDENT_IMAGE_UPLOAD\]\n.*\nAttachment role: learner_attempt\nStudent typed message: Where did I go wrong\?/);
  } finally { w.close(); }
});
