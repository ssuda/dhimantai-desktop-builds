import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {downloadStudyDocument} from '../src/studyDocument';

test('Study downloads the authorized book without credentials and rejects non-book responses',async()=>{
  const original=globalThis.fetch,signal=new AbortController().signal;let body='%PDF-1.4\nfixture',options:RequestInit|undefined,called=0;
  globalThis.fetch=async(_url,init)=>{called++;options=init;return new Response(body);};
  try{
    const document={format:'pdf' as const,url:'https://books.example/intro.pdf'};
    assert.equal((await downloadStudyDocument(document,signal,'https://api.example')).toString(),body);
    assert.equal(options?.credentials,'omit');assert.equal(options?.headers,undefined);
    body='<html>Not found</html>';await assert.rejects(downloadStudyDocument(document,signal,'https://api.example'),/not a readable PDF/);
    body='source_pages: 1';await assert.rejects(downloadStudyDocument({...document,format:'epub'},signal,'https://api.example'),/not a readable EPUB/);
    for(const url of ['file:///book.pdf','http://books.example/intro.pdf','https://user:secret@books.example/book.pdf']){
      const before=called;await assert.rejects(downloadStudyDocument({...document,url},signal,'https://api.example'));assert.equal(called,before);
    }
    globalThis.fetch=async()=>new Response('oversize',{headers:{'content-length':String(65*1024*1024)}});
    await assert.rejects(downloadStudyDocument(document,signal,'https://api.example'),/64 MB/);
  }finally{globalThis.fetch=original;}
});
