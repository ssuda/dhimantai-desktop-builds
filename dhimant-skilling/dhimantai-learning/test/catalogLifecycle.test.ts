import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';

const flush = async () => { for (let i=0;i<8;i++) await new Promise(done => setTimeout(done,0)); };
function fixture() {
  let authChanged:(s:any)=>void=()=>{}, focus:(s:any)=>void=()=>{}, owner:string|undefined='learner', renew=false;
  let html='',writes=0,reads=0,orders=0,joined=0,opened=true,paid=false,ready=true;
  let finish:undefined|(()=>void), delay=false, createFailure=false;
  const messages:any[]=[],urls:string[]=[],checks:boolean[]=[];
  const panel={webview:{get html(){return html;},set html(value:string){html=value;writes++;},postMessage:async(m:any)=>{messages.push(m);},onDidReceiveMessage:()=>({dispose(){}})},
    reveal(){},onDidDispose:()=>({dispose(){}}),dispose(){}};
  const session=()=>owner?{user:{id:owner,email:owner+'@example.test'}}:undefined;
  const auth={session:async()=>session(),onDidChange:(cb:any)=>{authChanged=cb;return {dispose(){}};},
    accessToken:async()=>{if(renew)authChanged(session());return 'fixture-token';}};
  const rpc=async()=>{reads++;return {individual:true,courses:[{id:'python',title:'Python',summary:'Learn Python',level:'Beginner',
    enrolled:true,unlocked:paid,can_join:true,chapters:[{id:'first',name:'Basics',free:true},{id:'next',name:'Lists',free:false}]}],
    offers:[{id:'python-once',title:'Python',amount:10000,currency:'INR',course_ids:['python'],owned:paid}]};};
  const api={learningPurchases:async(check=false)=>{checks.push(check);return {payments_ready:ready,purchases:orders?[{title:'Python',amount:10000,currency:'INR',status:paid?'paid':'created'}]:[]};},
    studyCatalog:async()=>({courses:[]}),practiceCatalog:async()=>({courses:[]}),purchaseLearningOffer:async()=>{
      orders++;await auth.accessToken();if(delay)await new Promise<void>(done=>{finish=done;});
      if(createFailure)throw new Error('Purchase service unavailable.');
      return {checkout_url:'https://api.example.test/learning-billing/checkout#ticket=fixture'};
    }};
  const vscode={env:{appName:'dhimantAI',openExternal:async(uri:string)=>{urls.push(uri);return opened;}},Uri:{parse:(uri:string)=>uri},ViewColumn:{One:1},
    commands:{executeCommand:async()=>{}},workspace:{onDidChangeConfiguration:()=>({dispose(){}})},window:{
      createWebviewPanel:(_type:any,_title:any,_column:any,options:any)=>{assert.equal(options.retainContextWhenHidden,true);return panel;},
      onDidChangeWindowState:(cb:any)=>{focus=cb;return {dispose(){}};},showInformationMessage:async()=>undefined}};
  const file=resolve(__dirname,'../src/courseCatalog.js'),realRequire=createRequire(file),exports:any={};
  runInNewContext(readFileSync(file,'utf8'),{exports,AbortSignal,Error,fetch:async()=>({ok:true,json:async()=>({courses:{}})}),
    require:(id:string)=>id==='vscode'?vscode:id==='./api'?{Api:class{constructor(){return api;}}}
      :id==='./learnerCatalog'?{learnerRpc:rpc,accessPeriod:()=>''}:realRequire(id)});
  const catalog=new exports.CourseCatalog(auth,()=> 'staging',()=>({apiUrl:'https://api.example.test'}),()=>{joined++;});
  return {catalog,panel,messages,urls,checks,focus:()=>focus({focused:true}),
    get counts(){return {writes,reads,orders,joined};},
    renew:()=>{renew=true;authChanged(session());},delay:()=>{delay=true;},finish:()=>finish?.(),
    switchAccount:(value?:string)=>{owner=value;authChanged(session());},
    failBrowser:()=>{opened=false;},failCreate:()=>{createFailure=true;},pay:()=>{paid=true;},disablePayments:()=>{ready=false;}};
}

test('catalog focus, repeated open and token renewal preserve the displayed page and purchase selection',async()=>{
  const f=fixture();await f.catalog.open();const counts=f.counts;
  f.focus();f.renew();await f.catalog.open();await flush();
  assert.deepEqual(f.counts,counts);
  await f.catalog.handle({type:'buy',id:'python-once'});
  assert.equal(f.urls.length,1,'a refreshed token still opens checkout');assert.equal(f.counts.writes,counts.writes);
  f.pay();f.focus();await flush();
  assert.equal(f.checks.at(-1),true);assert.equal(f.counts.joined,1);
  assert.equal(f.catalog.selection.catalog.courses[0].unlocked,true);
  const after=f.counts;f.focus();await flush();assert.deepEqual(f.counts,after,'settled purchases stop triggering focus refreshes');
});

test('checkout rejects duplicates, survives a queued refresh and never opens for a replaced account',async()=>{
  for(const switchAccount of [false,true]){
    const f=fixture();await f.catalog.open();f.delay();const purchase=f.catalog.handle({type:'buy',id:'python-once'});await flush();
    await f.catalog.handle({type:'buy',id:'python-once'});assert.equal(f.counts.orders,1);
    await f.catalog.refresh(true);assert.ok(f.catalog.selection,'refresh retains the current selection while purchasing');
    if(switchAccount)f.switchAccount('other');f.finish();await purchase;await flush();
    assert.equal(f.urls.length,switchAccount?0:1);
    if(switchAccount)assert.equal(f.catalog.selection.account,'other');
  }
});

test('failed browser launch, failed order creation and unavailable payments all produce retryable feedback',async()=>{
  for(const failure of ['browser','create','unavailable']){
    const f=fixture();if(failure==='unavailable')f.disablePayments();await f.catalog.open();
    if(failure==='browser')f.failBrowser();if(failure==='create')f.failCreate();
    await f.catalog.handle({type:'buy',id:'python-once'});
    const status=f.messages.at(-1);
    assert.equal(status.busy,false);assert.match(status.message,/Could not open|unavailable/);
    assert.equal(f.counts.orders,failure==='unavailable'?0:1);
  }
});

test('catalog restores search and open outlines on refresh, resets them for another account, and re-enables checkout after errors',async()=>{
  const f=fixture();await f.catalog.open();let state:any;
  const page=()=>{
    const dom=new JSDOM(f.panel.webview.html,{runScripts:'outside-only'}),win=dom.window,doc=win.document;
    (win as any).acquireVsCodeApi=()=>({postMessage:()=>{},getState:()=>state,setState:(value:any)=>{state=value;}});
    win.eval(doc.querySelector('script')!.textContent!);return {dom,win,doc};
  };
  let p=page();const search=p.doc.querySelector<HTMLInputElement>('#search')!;
  // This small fixture has no search box; use enough course cards for the production search threshold.
  if(!search){
    f.catalog.selection.catalog.courses.push(...Array.from({length:3},(_,i)=>({...f.catalog.selection.catalog.courses[0],id:'extra'+i,title:'Other '+i})));
    f.catalog.render(f.catalog.selection.catalog);p.dom.window.close();p=page();
  }
  const query=p.doc.querySelector<HTMLInputElement>('#search')!;query.value='Python';query.dispatchEvent(new p.win.Event('input'));
  const detail=p.doc.querySelector<HTMLDetailsElement>('[data-course="python"] details')!;detail.open=true;detail.dispatchEvent(new p.win.Event('toggle'));
  const buy=p.doc.querySelector<HTMLButtonElement>('[data-action="buy"]')!;buy.click();assert.equal(buy.disabled,true);
  p.win.dispatchEvent(new p.win.MessageEvent('message',{data:{type:'catalogStatus',message:'Retry checkout.',busy:false,paymentPending:false}}));
  assert.equal(buy.disabled,false);assert.match(p.doc.getElementById('status-message')!.textContent!,/Retry/);
  p.dom.window.close();p=page();assert.equal(p.doc.querySelector<HTMLInputElement>('#search')!.value,'Python');
  assert.equal(p.doc.querySelector<HTMLDetailsElement>('[data-course="python"] details')!.open,true);p.dom.window.close();
  f.switchAccount('other');await flush();p=page();assert.equal(p.doc.querySelector<HTMLInputElement>('#search')?.value??'','');p.dom.window.close();
});
