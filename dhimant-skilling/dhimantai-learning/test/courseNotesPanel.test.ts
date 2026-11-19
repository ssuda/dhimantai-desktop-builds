import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';

test('course notes group and search chapters, sync both ways, and preserve a conflicting draft',async()=>{
  let handler:(message:any)=>Promise<void>, disposed=false, reveals=0, current=true;
  let dom:JSDOM;
  const panel={webview:{html:'',asWebviewUri:(uri:string)=>uri,postMessage:async(data:unknown)=>{dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data}));},
    onDidReceiveMessage:(fn:typeof handler)=>{handler=fn;}},onDidDispose:()=>{},onDidChangeViewState:()=>{},reveal:()=>{reveals++;},dispose:()=>{disposed=true;}};
  const exports:any={};
  runInNewContext(readFileSync(join(__dirname,'../src/courseNotes.js'),'utf8'),{exports,
    require:(id:string)=>id==='vscode'?{window:{createWebviewPanel:()=>panel},ViewColumn:{One:1},Uri:{joinPath:join}}:require(id)});
  const notes=[{scope:'chapter-one',id:'n1',chapter:'Environment',text:'Python 3.12'},
    {scope:'chapter-one',id:'n2',chapter:'Environment',text:'Torch on CPU'},
    {scope:'chapter-two',id:'n1',chapter:'Files',text:'Remember file paths'}];
  const manager=new exports.CourseNotes('media'), messages:any[]=[];
  const open=()=>manager.open('owner/course','Python',async()=>current,
    async()=>notes.filter(n=>n.text.trim()).map(n=>({...n})), async (note:typeof notes[number],expected:string)=>{
      const original=notes.find(n=>n.scope===note.scope && n.id===note.id)!;
      assert.equal(original.text,expected);original.text=note.text;
    });
  open();
  dom=new JSDOM(panel.webview.html,{runScripts:'outside-only',url:'https://notes.example'});
  const {window:w}=dom, doc=w.document;
  w.acquireVsCodeApi=()=>({postMessage:(message:unknown)=>messages.push(message)});
  const input=(field:HTMLTextAreaElement|HTMLInputElement,value:string)=>{
    field.value=value; field.dispatchEvent(new w.Event('input'));
  };
  const headings=()=>Array.from(doc.querySelectorAll('section:not([hidden]) h2'),h=>h.textContent);
  try {
    const script=doc.querySelector('script')!.getAttribute('src')!;
    w.eval(readFileSync(join(__dirname,'../..',script),'utf8'));
    await handler!(messages.shift());
    assert.deepEqual(headings(),['Environment','Files']);
    assert.equal(doc.querySelector('#status')!.textContent,'3 notes');
    const search=doc.querySelector<HTMLInputElement>('#search')!;
    input(search,'paths');
    assert.deepEqual(headings(),['Files']);assert.match(doc.querySelector('#status')!.textContent!,/1 of 3/);
    input(search,'ENVIRONMENT');assert.deepEqual(headings(),['Environment']);
    input(search,'');
    const first=doc.querySelector('textarea')!, last=doc.querySelectorAll('textarea')[2];
    last.focus(); input(last,'Use relative file paths');
    await new Promise(done=>setTimeout(done,300));
    assert.equal(messages.length,1);
    assert.deepEqual([messages[0].scope,messages[0].id,messages[0].expected],['chapter-two','n1','Remember file paths']);
    await handler!(messages.shift());
    assert.equal(notes[2].text,'Use relative file paths');
    notes[0].text='Python 3.13';
    input(last,'Still editing');last.setSelectionRange(3,3);
    await handler!({type:'load'});
    assert.equal(first.value,'Python 3.13');assert.equal(last.value,'Still editing');
    assert.equal(doc.activeElement,last);assert.equal(last.selectionStart,3);
    notes[2].text='Changed in the lesson';
    await handler!({type:'load'});
    assert.equal(last.value,'Still editing');assert.match(last.parentElement!.textContent!,/Changed in the lesson/);
    last.parentElement!.querySelector('button')!.click();
    await handler!(messages.shift());assert.equal(notes[2].text,'Still editing');
    input(last,'  \n');last.blur();await handler!(messages.shift());
    assert.equal(notes[2].text,'  \n');assert.deepEqual(headings(),['Environment']);
    assert.equal(doc.querySelector('#status')!.textContent,'2 notes');
    notes[0].text='';notes[1].text='';await handler!({type:'load'});
    assert.equal(doc.querySelectorAll('article,h2').length,0);assert.match(doc.querySelector('#status')!.textContent!,/No private notes/);
    open();assert.equal(reveals,1);
    current=false;await handler!({type:'load'});assert.equal(disposed,true);
  } finally {dom.window.close();}
});
