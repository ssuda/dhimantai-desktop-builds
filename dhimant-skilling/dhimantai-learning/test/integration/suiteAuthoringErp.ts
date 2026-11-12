/** Opt-in local acceptance: session file names an isolated, pre-provisioned author training account. */
import * as assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openInjectedTab} from '../../src/apps/desktopBrowser';
import {connectPlaywright,discoverWebMcp} from '../../src/apps/playwrightBrowser';
import {FrappeServer} from '../../src/apps/frappe';
import {Replayer} from '../../src/apps/replay';
import {TaskVerifier} from '../../src/apps/verifier';
import {replayPassed,TourTask,freshReplayTasks} from '../../src/apps/authoringModel';
export async function run(){
  const file=process.env.DHIMANTAI_AUTHORING_SMOKE_SESSION;if(!file)throw new Error('Set an isolated local author session file.');
  const config=JSON.parse(readFileSync(file,'utf8'));
  assert.match(config.origin,/^http:\/\/127\.0\.0\.1:\d+$/);assert.match(config.learner,/^[0-9a-f]{20}$/);
  const login=`learner-${config.learner}@training.invalid`,server=new FrappeServer(config.origin,login,config.password);
  const media=join(__dirname,'../../../media/browser');
  let tab:Awaited<ReturnType<typeof openInjectedTab>>,driver:Awaited<ReturnType<typeof connectPlaywright>>|undefined;
  try{
    tab=await openInjectedTab({url:config.origin,home:'/desk',media,adapter:'frappe',server});assert.ok(tab?.transport);
    driver=await connectPlaywright(tab.transport,config.origin);const page=driver.page;
    const form=await server.describe('Customer');assert.ok(form.fields.some(f=>f.name==='customer_name'));
    const task:TourTask={id:'studio-customer',title:'Create a training customer',doctype:'Customer',why:'Practise a real customer workflow',
      steps:[{field:'customer_name',text:'Give your customer a training name',value:'Author smoke {{tag}}'},
        {field:'customer_type',text:'Choose the type',value:'Company',decide:true},
        {field:'customer_group',text:'Choose the group',value:'Commercial'},
        {field:'territory',text:'Choose the territory',value:'India'}],
      expected:{customer_name:'Author smoke {{tag}}',customer_type:'Company',customer_group:'Commercial',territory:'India'}};
    const tasks=process.env.DHIMANTAI_AUTHORING_SMOKE_FULL === '1' ? freshReplayTasks(JSON.parse(readFileSync(media+'/erpnext/course.json','utf8')).lessons,randomBytes(4).toString('hex')) : [task];
    const replayer=new Replayer(tab.client,tab.sessionId,server,new TaskVerifier(server,media+'/player'),login,config.learner.slice(0,10),media+'/player',undefined,
      expression=>page.evaluate(expression));
    const results=await replayer.run(tasks);
    if(!replayPassed(tasks,results)) console.log('ERP validation:',await page.evaluate('({errors:window.dhimantaiApp?.errors(),isNew:window.dhimantaiApp?.current()?.isNew,dirty:window.dhimantaiApp?.current()?.dirty,form:window.dhimantaiApp?.current()?.form})'));
    assert.equal(replayPassed(tasks,results),true,JSON.stringify(results));
    const mcp=await discoverWebMcp(page);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,erpnextReplay:results.map(r=>({task:r.task,ok:r.ok,discriminates:r.discriminates})),webmcp:mcp.status}));
  }catch(error){writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error)}));throw error;}
  finally{await driver?.close();await tab!?.close?.();}
}
