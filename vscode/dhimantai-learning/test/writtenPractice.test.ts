import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

// Extract the pure renderer without loading the VS Code host module.
const source=readFileSync(require.resolve('../src/writtenPractice'),'utf8');
const sandbox={exports:{},require:(name:string)=>name==='vscode'?{}:name.startsWith('./')?require('../src/'+name.slice(2)):require(name)};
new Function('exports','require',source)(sandbox.exports,sandbox.require);
const {writtenHtml}=sandbox.exports as {writtenHtml:Function};

test('written Practice escapes content, submits explicit evidence and never offers code execution',()=>{
  const dom=new JSDOM(writtenHtml({id:'q',course:'Review <script>bad()</script>',question:'Identify a bug.'},
    {answer:'</textarea><script>bad()</script>',assistance:'none',usedTutor:false},'test'),{runScripts:'outside-only'});
  const sent:any[]=[];
  (dom.window as any).acquireVsCodeApi=()=>({postMessage:(msg:any)=>sent.push(msg)});
  dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
  assert.equal(dom.window.document.querySelectorAll('script').length,1);
  assert.match(dom.window.document.body.textContent!,/without completing this task/);
  assert.deepEqual([...dom.window.document.querySelectorAll('button')].map(b=>b.id),['attach','detach','review','hint']);
  (dom.window.document.querySelector('#attach') as HTMLButtonElement).click();
  assert.equal(sent.pop().type,'attach');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'attached',names:['plan.jpg'],error:''}}));
  assert.equal(dom.window.document.querySelector('#attached')!.textContent,'Attached: plan.jpg');
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('#detach')!.hidden,false);
  assert.equal(dom.window.document.querySelector('#hint')!.textContent,'Ask me a guiding question');
  const answer=dom.window.document.querySelector<HTMLTextAreaElement>('#answer')!;
  answer.value='';(dom.window.document.querySelector('#review') as HTMLButtonElement).click();
  assert.equal(sent.length,0);
  answer.value='The zero-percent boundary is wrong.';
  (dom.window.document.querySelector('#review') as HTMLButtonElement).click();
  (dom.window.document.querySelector('#review') as HTMLButtonElement).click();
  assert.equal(sent.filter(item=>item.type==='feedback').length,1);
  assert.equal(sent.at(-1).mode,'review');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'feedback',feedback:'Check the boundary.',next_step:'Add one case.'}}));
  assert.match(dom.window.document.querySelector('#feedback')!.textContent!,/Check the boundary\.\n\nAdd one case\./);
  assert.equal(sent.at(-1).usedTutor,true);
  dom.window.close();
});

test('written hints climb the shared help ladder one step at a time',()=>{
  const dom=new JSDOM(writtenHtml({id:'q',course:'Review',question:'Identify a bug.'},
    {answer:'',assistance:'none',usedTutor:false},'test',{next:2,waiting:true}),{runScripts:'outside-only'});
  const sent:any[]=[];
  (dom.window as any).acquireVsCodeApi=()=>({postMessage:(msg:any)=>sent.push(msg)});
  dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
  const doc=dom.window.document;
  assert.equal(doc.querySelector('#hint')!.textContent,'Give me a hint');
  assert.match(doc.querySelector('#help-steps')!.textContent!,/Step 2 of 4/);
  assert.equal(doc.querySelector<HTMLElement>('#help-note')!.hidden,false);
  (doc.querySelector('#hint') as HTMLButtonElement).click();
  const request=sent.find(item=>item.type==='feedback');
  assert.equal(request.mode,'hint');assert.equal(request.helpLevel,2);
  assert.match(request.message,/one hint about the next step/);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'helpState',next:3,waiting:false}}));
  assert.equal(doc.querySelector('#hint')!.textContent,'Show me where to look');
  assert.equal(doc.querySelector<HTMLElement>('#help-note')!.hidden,true);
  dom.window.close();
});
