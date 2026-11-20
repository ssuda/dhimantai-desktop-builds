import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {JSDOM} from 'jsdom';
import {CRT_ENTRY, CRT_EXIT} from '../src/crtAssessmentForms';

const moduleSource=readFileSync(require.resolve('../src/crtAssessment'),'utf8');
const exportsForTest:{assessmentHtml?:Function}={};
new Function('exports','require',moduleSource)(exportsForTest,(name:string)=>name==='vscode'?{}:
  name.startsWith('./')?require('../src/'+name.slice(2)):require(name));
const client=readFileSync(resolve(__dirname,'../../media/crtAssessment.js'),'utf8');

test('rapid edits preserve the latest response and an absent exit score is distinct from zero',()=>{
  const messages:any[]=[];
  const dom=new JSDOM(exportsForTest.assessmentHtml!(CRT_ENTRY,'nonce','crtAssessment.js'),{runScripts:'outside-only'});
  const w=dom.window, d=w.document;
  try {
    (w as any).acquireVsCodeApi=()=>({postMessage:(m:unknown)=>messages.push(m)});
    w.eval(client);
    const send=(data:unknown)=>w.dispatchEvent(new w.MessageEvent('message',{data}));
    const now=Date.now();
    send({type:'state',state:{exam_id:CRT_ENTRY,started_at:new Date(now).toISOString(),deadline:new Date(now+3600000).toISOString(),
      server_time:new Date(now).toISOString(),answers:{},revision:0,questions:[{position:0,question_text:'Percentage?',question_type:'numerical_value'}]}});
    const input=d.querySelector('fieldset input') as HTMLInputElement;
    for (const value of ['7','7.5']) {input.value=value;input.dispatchEvent(new w.Event('input'));}
    const saves=messages.filter(m=>m.type==='save');
    assert.equal(saves.length,2);assert.equal(saves[1].answers['0'],'7.5');
    send({type:'saved',revision:1,sequence:saves[0].sequence});
    assert.equal((d.getElementById('submit') as HTMLButtonElement).disabled,true);
    send({type:'saved',revision:2,sequence:saves[1].sequence});
    assert.equal((d.getElementById('close') as HTMLButtonElement).disabled,false);
    send({type:'scores',scores:{[CRT_ENTRY]:{status:'scored',score:0,sections:{'Numerical ability and data':0,'Reasoning':0,'Verbal ability':0}},
      [CRT_EXIT]:{status:'available'}}});
    const total=d.querySelector('tbody tr:last-child')!;
    assert.deepEqual([...total.children].map(c=>c.textContent),['Total','0 / 36','Not started']);
  } finally { w.close(); }
});
