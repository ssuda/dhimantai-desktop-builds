import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

test('Study restores across host restarts and isolates accounts and services', async()=>{
  const extensionPath=resolve(__dirname,'../..');
  const stored=new Map<string,unknown>();
  const cursor='epubcfi(/6/2!/4/26/2/1:0)';
  const companions=JSON.parse(readFileSync(join(extensionPath,'media/study/book_companions.json'),'utf8')).courses;
  const chapter=companions.flatMap((c:any)=>c.chapters).find((c:any)=>c.title==='Protect an Abstraction Barrier');
  async function host(user='reader-a',environment='staging') {
    let open:(target?:unknown)=>void=()=>{},message:(value:any)=>void=()=>{},disposePanel=()=>{};
    const sent:any[]=[];let views=0;
    const uri=(fsPath:string)=>({fsPath});
    const vscode={Uri:{joinPath:(base:any,...parts:string[])=>uri(join(base.fsPath,...parts))},ViewColumn:{One:1},
      commands:{registerCommand:(_name:string,callback:any)=>{open=callback;return {dispose(){}};}},
      workspace:{getConfiguration:()=>({get:()=>true}),onDidChangeConfiguration:()=>({dispose(){}})},
      window:{createWebviewPanel:()=>{views++;return {webview:{postMessage:async(m:any)=>{sent.push(m);return true;},onDidReceiveMessage:(fn:any)=>{message=fn;},asWebviewUri:(u:any)=>u.fsPath},
        onDidDispose:(fn:any)=>{disposePanel=fn;},onDidChangeViewState(){},reveal(){},dispose(){disposePanel();}};}}};
    const sandbox={exports:{},AbortController,require:(name:string)=>name==='vscode'?vscode:name==='./coachAudio'?{trustedRoomUrl:()=>true}:
      name==='./studyDocument'?{downloadStudyDocument:async()=>Buffer.from('fixture-book')}:
      name==='./api'?{Api:class{
        async studyCatalog(){return {courses:companions.map((c:any)=>({...c,chapters:c.chapters.map((ch:any)=>({...ch,format:'epub'}))}))};}
        async studyChapter(id:string){const c=companions.find((c:any)=>c.chapters.some((ch:any)=>ch.id===id));return {...c.chapters.find((ch:any)=>ch.id===id),course:c.title,reading:[],document:{format:'epub',url:'https://books.example/book.epub'}};}
      }}:name.startsWith('./')?require('../src/'+name.slice(2)):require(name)};
    runInNewContext(readFileSync(join(extensionPath,'out/src/studyReader.js'),'utf8'),sandbox);
    const context={extensionUri:uri(extensionPath),globalState:{get:(key:string)=>stored.get(key),update:async(key:string,value:unknown)=>{stored.set(key,value);}}};
    const registration=await (sandbox.exports as any).registerStudyReader(context,{session:async()=>user?{user:{id:user}}:undefined,onDidChange:()=>({dispose(){}})},()=>environment,()=>({apiUrl:'https://'+environment+'.example.test'}));
    const waitChapter=async()=>{for(let i=0;i<100;i++){const result=sent.filter(m=>m.type==='chapter').at(-1);if(result)return result;await new Promise(r=>setTimeout(r,5));}throw new Error('No chapter delivered');};
    return {open,send:(m:any)=>message(m),ready:()=>message({type:'ready'}),waitChapter,sent,registration,views:()=>views};
  }
  const first=await host();first.open(chapter.id);first.ready();const loaded=await first.waitChapter();
  first.send({type:'fontSize',documentKey:loaded.documentKey,fontSize:'125%'});
  first.send({type:'position',documentKey:loaded.documentKey,cursor});
  await new Promise(r=>setTimeout(r,10));first.registration.dispose();
  const restarted=await host();restarted.open();restarted.ready();const restored=await restarted.waitChapter();
  assert.equal(restored.source.id,chapter.id);assert.equal(restored.fontSize,'125%');assert.equal(restored.cursor,cursor);
  const count=restarted.sent.length;restarted.open();assert.equal(restarted.views(),1);assert.equal(restarted.sent.length,count,'revealing Study leaves its document mounted');
  for(const [user,environment] of [['reader-b','staging'],['reader-a','production']]) {
    const isolated=await host(user,environment);isolated.open();isolated.ready();const fresh=await isolated.waitChapter();
    assert.equal(fresh.source.id,companions[0].chapters[0].id);assert.equal(fresh.fontSize,'100%');assert.equal(fresh.cursor,undefined);isolated.registration.dispose();
  }
  const guest=await host('');guest.open();guest.ready();await new Promise(r=>setTimeout(r,20));
  assert.equal(guest.sent.some(m=>m.type==='chapter'),false,'guests never receive bundled Markdown');
  assert.ok(guest.sent.some(m=>m.type==='empty'&&/Sign in/.test(m.message)));guest.registration.dispose();
  restarted.send({type:'position',documentKey:'stale',cursor:'epubcfi(/6/2!/4/2/1:0)'});
  restarted.registration.dispose();
  const last=await host();last.open();last.ready();assert.equal((await last.waitChapter()).cursor,cursor);last.registration.dispose();
});
