import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {CdpClient, injectPlayer, pageScript} from '../src/apps/inject';

function fakeBrowser(targets:any[]) {
  const sent:any[]=[];let listener:(m:unknown)=>void=()=>{};
  const transport={send:async(message:any)=>{sent.push(message);
    const result=message.method==='Target.getTargets'?{targetInfos:targets}:message.method==='Target.attachToTarget'?{sessionId:'page-1'}
      :message.method==='Network.setCookie'?{success:true}:{};
    setTimeout(()=>listener({id:message.id,result}),0);},
    onMessage:(l:(m:unknown)=>void)=>{listener=l;return {dispose(){}};}};
  return {client:new CdpClient(transport),sent};
}
test('the desktop attaches to the application tab, signs the learner in by cookie and installs the player before navigating',async()=>{
  const {client,sent}=fakeBrowser([{targetId:'other',type:'page',url:'https://example.com/'},{targetId:'app',type:'page',url:'http://127.0.0.1:28069/web/login'}]);
  const session=await injectPlayer(client,{origin:'http://127.0.0.1:28069',scripts:['window.adapter=1','window.player=2'],
    session:{'dhimantai-erpnext-learner':'abc'},cookie:{name:'session_id',value:'s3cret'},home:'/odoo'});
  assert.equal(session,'page-1');
  assert.deepEqual(sent.map(m=>m.method),['Target.getTargets','Target.attachToTarget','Page.enable','Network.enable','Network.setCookie','Page.addScriptToEvaluateOnNewDocument','Page.navigate']);
  assert.equal(sent[1].params.targetId,'app','the application tab, not another page');
  assert.deepEqual(sent[4].params,{name:'session_id',value:'s3cret',domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Lax'});
  assert.ok(sent.slice(2).every(m=>m.sessionId==='page-1'));
  assert.equal(sent[6].params.url,'http://127.0.0.1:28069/odoo');
  client.dispose();
});
test('without the application tab nothing is injected',async()=>{
  const {client,sent}=fakeBrowser([{targetId:'a',type:'page',url:'https://one.example/'},{targetId:'b',type:'page',url:'https://two.example/'}]);
  await assert.rejects(injectPlayer(client,{origin:'http://127.0.0.1:1',scripts:[],session:{},home:'/'}),/not open/);
  assert.equal(sent.length,1);client.dispose();
});
test('the page script runs only on the application origin, once, and survives a failing script',async()=>{
  const source=pageScript({origin:'http://127.0.0.1:28069',scripts:['throw new Error("adapter broke")','window.ran=(window.ran||0)+1'],
    session:{'dhimantai-erpnext-learner':'abc'},home:'/'});
  const on=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:28069/odoo',runScripts:'outside-only'}).window as any;
  on.console.error=()=>{};
  on.eval(source);on.eval(source);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(on.ran,1);assert.equal(on.sessionStorage.getItem('dhimantai-erpnext-learner'),'abc');
  const off=new JSDOM('<!doctype html><body></body>',{url:'https://evil.example/',runScripts:'outside-only'}).window as any;
  off.eval(source);
  assert.equal(off.ran,undefined);assert.equal(off.sessionStorage.getItem('dhimantai-erpnext-learner'),null,'no learner data reaches another site');
});
