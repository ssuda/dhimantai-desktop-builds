// Local acceptance against an already running training stack. Creates a fresh learner/company only.
// ERP_ORIGIN=http://127.0.0.1:port ERP_BACKEND=container node scripts/erp-shift-smoke.cjs
const assert=require('node:assert/strict');
const {readFileSync,mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {randomBytes}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright-core');
const {FrappeServer}=require('../out/src/apps/frappe');
const {TaskVerifier,resolveTask}=require('../out/src/apps/verifier');
const {BrowserLearning}=require('../out/src/browserLearning');
const {shiftTasks,checkShiftHandover}=require('../out/src/erpShift');
const {prepareDemo}=require('../out/src/erpDemo');
const {pageScript}=require('../out/src/apps/inject');

(async()=>{
  const origin=process.env.ERP_ORIGIN,backend=process.env.ERP_BACKEND;
  assert.match(origin||'',/^http:\/\/127\.0\.0\.1:\d+$/);assert.match(backend||'',/^dhimantai-erp-[a-f0-9]+-backend$/);
  const root=resolve(__dirname,'..'),media=join(root,'media/browser'),output=resolve(root,'../../reviews/artifacts/erpnext-business-shift');
  mkdirSync(output,{recursive:true});
  const learner=randomBytes(10).toString('hex'),password=randomBytes(24).toString('hex'),tag=learner.slice(0,10),user=`learner-${learner}@training.invalid`;
  const bootstrap=readFileSync(join(media,'erpnext/bootstrap.py'),'utf8');
  execFileSync('podman',['exec','-i',backend,'/home/frappe/frappe-bench/env/bin/python','-'],{input:
    `import os\nos.environ['DHIMANTAI_LEARNER']=${JSON.stringify(learner)}\nos.environ['DHIMANTAI_LEARNER_PASSWORD']=${JSON.stringify(password)}\n`+bootstrap,stdio:['pipe','pipe','pipe'],timeout:120000});
  const server=new FrappeServer(origin,user,password),verifier=new TaskVerifier(server,join(media,'player'));
  const course=JSON.parse(readFileSync(join(media,'erpnext/course.json'),'utf8')),shift=JSON.parse(readFileSync(join(media,'erpnext/shift.json'),'utf8'));
  const tasks=shiftTasks(course.lessons,shift),done={},metrics=[];let handover;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  await prepareDemo(server,tasks,tag,today,done,async(id,value)=>{done[id]=value;});
  const verify=async(id,record)=>verifier.verify(tasks.find(t=>t.id===id),record,user,tag,Object.fromEntries(Object.entries(done).map(([k,v])=>[k,v.record])));
  for(const id of shift.prepared)assert.equal(await verify(id,done[id].record),true,id);
  const learning=new BrowserLearning();let browser;
  try {
    const fragment=await learning.start({origin,account:'smoke',environment:'local',learner,tasks,current:async()=>true,
      course:{id:course.id,title:course.title,shift,finale:shift.finale},verified:()=>done,
      recordVerified:async(id,value)=>{if(!await verify(id,value.record))return false;done[id]=value;return true;},
      recordHandover:async(text,recorded)=>{if(!await checkShiftHandover(shift,done,verify))return false;handover={text,recorded};return true;},
      recordAction:(command,result)=>metrics.push({schema:1,kind:'action',run:tag,shift:shift.id,request:command.id,task:command.task,
        action:command.action,outcome:result.status,duration_ms:result.duration_ms,model_calls:0})});
    learning.setConnection('smoke','local',true,'');
    const params=new URLSearchParams(fragment);
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await server.login();await context.addCookies([{...server.sessionCookie(),url:origin,httpOnly:true,sameSite:'Lax'}]);
    const scripts=['apps/frappe.js','player/shift.js','player/guide.js','player/live.js'].map(p=>readFileSync(join(media,p),'utf8'));
    await context.addInitScript({content:pageScript({origin,scripts,home:'/desk',session:{'dhimantai-erpnext-instructor':JSON.stringify({
      origin:'http://127.0.0.1:'+params.get('bridge'),token:params.get('token'),learner})}})});
    const page=await context.newPage();
    page.on('pageerror',error=>console.error('Page:',error.message.slice(0,300)));
    await page.goto(origin+'/desk');
    try{await page.waitForFunction(()=>window.dhimantaiErpGuide?.headless===true,{},{timeout:30000});}
    catch(error){console.error('Boot state:',await page.evaluate(()=>({path:location.pathname,ready:window.dhimantaiApp?.ready(),guide:!!window.dhimantaiErpGuide,
      headless:window.dhimantaiErpGuide?.headless,panel:!!document.getElementById('dhimantai-guide'),shift:!!window.dhimantaiBusinessShift})));throw error;}
    assert.equal(await page.locator('#dhimantai-guide').count(),0,'no teaching panel inside ERPNext');
    const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out waiting for shift state');};
    await wait(()=>learning.latest('smoke','local')?.observation?.task==='stock');
    // Hold a real navigation between its two structured steps and send trusted
    // keyboard input. The browser must yield before clicking ERPNext's Create action.
    await page.evaluate(()=>{
      const app=window.dhimantaiApp,open=app.openRecord;
      window.__shiftSmokeOpened=false;
      app.openRecord=async(...args)=>{await open(...args);window.__shiftSmokeOpened=true;
        await new Promise(resolve=>window.__shiftSmokeRelease=()=>{app.openRecord=open;resolve();});};
    });
    const interruptObservation=learning.latest('smoke','local').observation;
    const interrupted=learning.demonstrate('smoke','local',{id:randomBytes(16).toString('hex'),task:'stock',snapshot:interruptObservation.shift.snapshot,action:'prepare_draft'});
    await page.waitForFunction(()=>window.__shiftSmokeOpened);
    await page.keyboard.press('Shift');await page.evaluate(()=>window.__shiftSmokeRelease());
    assert.equal((await interrupted).status,'interrupted');
    assert.equal(await page.evaluate(()=>dhimantaiApp.current()?.form),'Purchase Order','student takeover prevents draft creation');
    console.log('Student takeover: trusted keyboard input stopped the next browser mutation.');
    const answer=async()=>{
      const q=learning.latest('smoke','local')?.question;if(!q)return;
      const text=q.kind==='prediction'?q.options[1]:q.kind==='reflection'
        ?'We received four widgets and delivered two, leaving two in Stores and one back-ordered. The supplier is owed INR 400 and the customer owes INR 300. No cash moved. Follow up both balances tomorrow.'
        :'The saved documents show the actual goods and amounts owed. Orders are commitments, receipts and deliveries move stock, and invoices record what is owed without moving cash.';
      assert.equal(await learning.answerQuestion('smoke','local',q.id,text),true);
      await wait(()=>learning.latest('smoke','local')?.question?.id!==q.id);
    };
    for(const id of shift.live) {
      await wait(()=>learning.latest('smoke','local')?.observation?.task===id);
      const before=learning.latest('smoke','local').observation;
      const result=await learning.demonstrate('smoke','local',{id:randomBytes(16).toString('hex'),task:id,snapshot:before.shift.snapshot,action:'prepare_draft'});
      assert.equal(result.status,'completed',JSON.stringify(result));
      console.log(id+': agent opened a linked draft; handing control to the learner.');
      await answer();
      const task=resolveTask(tasks.find(t=>t.id===id),tag,Object.fromEntries(Object.entries(done).map(([k,v])=>[k,v.record])));
      // Simulated learner actions exercise the real form API; the Instructor action never receives these values.
      for(const s of task.steps)await page.evaluate(async({field,value})=>window.dhimantaiApp.setValue(field,value),s);
      if(id==='stock') {
        await page.evaluate(async()=>{const rows=structuredClone(cur_frm.doc.items);rows[0].qty=5;await dhimantaiApp.setValue('items',rows.map(r=>({item_code:r.item_code,qty:r.qty,rate:r.rate,warehouse:r.warehouse,purchase_order:r.purchase_order})) );await dhimantaiApp.save();});
        await learning.continueTask('smoke','local',id);
        await wait(()=>learning.latest('smoke','local')?.observation?.result==='mismatch');
        assert.match(learning.latest('smoke','local').taskStatus,/warehouse’s count/);
        assert.equal(done.stock,undefined,'a wrong draft earns no progress');
        await page.evaluate(async value=>dhimantaiApp.setValue('items',value),task.steps.find(s=>s.field==='items').value);
      }
      await page.evaluate(async()=>{await dhimantaiApp.save();await dhimantaiApp.act('submit');});
      await page.waitForFunction(()=>dhimantaiApp.current()?.final===true);
      await learning.continueTask('smoke','local',id);
      await wait(()=>learning.latest('smoke','local')?.question?.kind==='explanation');
      assert.equal(done[id].assisted,true,'demonstration remains assisted practice');
      await answer();
      if(id!==shift.live.at(-1)){await learning.continueTask('smoke','local',id);}
    }
    await wait(()=>learning.latest('smoke','local')?.question?.kind==='reflection');
    const evidence=learning.latest('smoke','local').question.context;
    assert.match(evidence,/Stock remaining: 2 in Stores/);assert.match(evidence,/80% received/);
    assert.match(evidence,/INR 400 outstanding/);assert.match(evidence,/INR 300 outstanding/);
    await answer();assert.ok(handover);
    await page.screenshot({path:join(output,'erpnext-without-panel.png'),fullPage:false});
    for(const width of [780,1440]) {
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.locator('#dhimantai-guide').count(),0);
    }
    writeFileSync(join(output,'actions.jsonl'),metrics.map(e=>'BUSINESS_SHIFT_USAGE '+JSON.stringify(e)).join('\n')+'\n');
    writeFileSync(join(output,'acceptance.json'),JSON.stringify({at:new Date().toISOString(),run:tag,checks:shift.live.map(id=>({task:id,verified:done[id].explained,assisted:done[id].assisted})),evidence,
      handoverSaved:true,noInjectedPanel:true,studentTakeover:true,modelSession:false,metrics},null,2));
    console.log('PASS: four real transactions, draft recovery, handover, and no ERPNext panel. '+output);
  }finally{await browser?.close();await learning.stop();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
