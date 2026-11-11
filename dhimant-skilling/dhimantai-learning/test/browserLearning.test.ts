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
    assert.equal((await post(observation())).status,409);
    assert.equal((await post({...observation(2),training_tag:'aaaaaaaaaa'})).status,400);
    assert.equal((await post({sequence:2,clear:true})).status,200);
    assert.equal(learning.latest('account-a','staging')?.observation,null);
    assert.equal((await post(observation(1))).status,409);
    current=false;assert.equal((await post(observation(3))).status,410);
    assert.equal((await fetch(url+'/course',{headers})).status,410);
    assert.equal(events.length,2);
  }finally{subscription.dispose();await learning.stop();}
});
