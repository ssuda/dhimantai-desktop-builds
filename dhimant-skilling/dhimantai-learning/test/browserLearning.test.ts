import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserLearning,browserObservation,BrowserObservation,BrowserTask} from '../src/browserLearning';
const tasks=JSON.parse(readFileSync(join(__dirname,'../../media/browser/erpnext/course.json'),'utf8')).lessons as BrowserTask[];
const observation=(sequence=1):BrowserObservation=>({sequence,course:'erpnext-essentials',task:'company',step:0,training_tag:'0123456789',
  route:'Form/Company/Training 0123456789',doctype:'Company',record:'Training 0123456789',dirty:false,docstatus:0,
  fields:{default_currency:'INR'},errors:[],action:'view',result:null});
test('only bounded authored training fields pass through the browser transport',()=>{
  assert.ok(browserObservation(observation(),tasks));
  for(const changes of [{fields:{password:'secret'}},{fields:{default_currency:'x'.repeat(601)}},{errors:['x'.repeat(501)]},
      {fields:{default_currency:{cookie:'secret'}}},{task:'user'},{step:99},{sequence:true},{dom:'arbitrary HTML'}])
    assert.equal(browserObservation({...observation(),...changes},tasks),undefined);
});
test('loopback observation requires the exact ERP origin, launch token and current account, and clears stale context',async()=>{
  const learning=new BrowserLearning(),events:any[]=[];let current=true;
  const subscription=learning.onUpdate(event=>events.push(event));
  try {
    const saved:Record<string,any>={};
    const fragment=await learning.start({origin:'http://127.0.0.1:43210',account:'account-a',environment:'staging',
      learner:'0123456789abcdef0123',tasks,current:async()=>current,signIn:{usr:'learner-0123456789abcdef0123@training.invalid',pwd:'pw'},
      verified:()=>saved,recordVerified:async(task,done)=>{if(done.record==='forged')return false;saved[task]=done;return true;}});
    const params=new URLSearchParams(fragment),url='http://127.0.0.1:'+params.get('bridge');
    const headers={Origin:'http://127.0.0.1:43210',Authorization:'Bearer '+params.get('token'),'Content-Type':'application/json'};
    const post=(body:unknown,extra={})=>fetch(url+'/observe',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    assert.equal((await post(observation(),{Origin:'https://unrelated.example'})).status,403);
    assert.equal((await post(observation(),{Authorization:'Bearer invalid'})).status,401);
    assert.equal((await fetch(url+'/course',{headers:{...headers,Authorization:'Bearer invalid'}})).status,401);
    const published=await (await fetch(url+'/course',{headers})).json() as {lessons:BrowserTask[];version:string};
    assert.deepEqual(published.lessons,tasks);
    assert.match(published.version,/^[a-f0-9]{16}$/);
    assert.equal((await fetch(url+'/signin',{method:'POST',headers:{...headers,Authorization:'Bearer invalid'}})).status,401);
    assert.deepEqual(await (await fetch(url+'/signin',{method:'POST',headers})).json(),{usr:'learner-0123456789abcdef0123@training.invalid',pwd:'pw'});
    const progress=(body:unknown)=>fetch(url+'/progress',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await progress({task:'user',record:'x',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true})).status,400);
    assert.equal((await progress({task:'company',record:'Training 0123456789',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true,extra:1})).status,400);
    assert.equal((await progress({task:'company',record:'Training 0123456789',checkedAt:'2026-11-11T00:00:00Z',assisted:true,explained:true})).status,200);
    assert.equal(((await (await fetch(url+'/course',{headers})).json()) as any).verified.company.record,'Training 0123456789');
    assert.equal((await progress({task:'customer',record:'forged',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true})).status,409,'a record the desktop cannot verify is refused');
    assert.equal(saved.customer,undefined);
    assert.equal((await post(observation())).status,200);assert.equal(events.length,1);
    assert.equal(learning.latest('account-b','staging'),undefined);
    const question={id:'company:explanation:check-1',task:'company',kind:'explanation',title:'Company accounts',
      question:'What changes when you bill a customer?',context:'Saved record: Training 0123456789',options:[],minLength:30,maxLength:500};
    const publish=(question:unknown)=>fetch(url+'/question',{method:'POST',headers,body:JSON.stringify({question})});
    assert.equal((await publish({...question,task:'unrelated'})).status,400);
    assert.equal((await publish(question)).status,200);
    assert.equal(learning.latest('account-a','staging')?.question?.id,question.id);
    const focus=(id:string,extra={})=>fetch(url+'/focus',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({id})});
    assert.equal((await focus('old-question')).status,409);
    assert.equal((await focus(question.id,{Origin:'https://unrelated.example'})).status,403);
    assert.equal((await focus(question.id)).status,200);
    assert.equal(events.at(-1).focusQuestion,question.id);
    assert.equal(events.at(-1).help,undefined,'focusing a question never starts a second model request');
    assert.equal(learning.latest('account-a','staging')?.focusQuestion,undefined,'background updates never replay a focus request');
    const answer='Receivables grow because the customer owes us for the invoice.';
    assert.equal(await learning.answerQuestion('account-b','staging',question.id,answer),false);
    assert.equal(await learning.answerQuestion('account-a','staging','old-check',answer),false);
    assert.equal(await learning.answerQuestion('account-a','staging',question.id,'short'),false);
    assert.equal(await learning.answerQuestion('account-a','staging',question.id,answer),true);
    assert.deepEqual((await (await fetch(url+'/state',{headers})).json() as any).answer,{id:question.id,answer});
    assert.equal((await publish(null)).status,200);
    assert.equal((await focus(question.id)).status,409);
    assert.equal((await (await fetch(url+'/state',{headers})).json() as any).answer,undefined);
    assert.equal(await learning.continueTask('account-b','staging','company'),false);
    assert.equal(await learning.continueTask('account-a','staging','old-task'),false);
    assert.equal(await learning.continueTask('account-a','staging','company'),true);
    const taskAction=(await (await fetch(url+'/state',{headers})).json() as any).taskAction;
    assert.equal(taskAction.task,'company');
    const completed=await fetch(url+'/continue-result',{method:'POST',headers,body:JSON.stringify({id:taskAction.id,status:'Continue with the next task.'})});
    assert.equal(completed.status,200);assert.equal(learning.latest('account-a','staging')?.taskStatus,'Continue with the next task.');
    assert.equal((await (await fetch(url+'/state',{headers})).json() as any).taskAction,undefined);
    assert.equal(await learning.chooseChapter('account-b','staging',tasks[1].instructorChapter),false);
    assert.equal(await learning.chooseChapter('account-a','staging','unavailable-chapter'),false);
    assert.equal(await learning.chooseChapter('account-a','staging',tasks[1].instructorChapter),true);
    const navigation=(await (await fetch(url+'/state',{headers})).json() as any).taskAction;
    assert.equal(navigation.kind,'open');assert.equal(navigation.task,tasks[1].id);
    assert.equal(await learning.chooseChapter('account-a','staging',tasks[2].instructorChapter),false,'a second click cannot replace in-flight navigation');
    assert.equal(saved.customer,undefined,'skipping never creates completion evidence');
    assert.equal((await post(observation())).status,409);
    assert.equal((await post({...observation(2),training_tag:'aaaaaaaaaa'})).status,400);
    assert.equal((await post({sequence:2,clear:true})).status,200);
    assert.equal(learning.latest('account-a','staging')?.observation,null);
    assert.equal((await post(observation(1))).status,409);
    current=false;assert.equal((await post(observation(3))).status,410);
    assert.equal((await fetch(url+'/course',{headers})).status,410);
    assert.equal(events.length,6);
  }finally{subscription.dispose();await learning.stop();}
});
