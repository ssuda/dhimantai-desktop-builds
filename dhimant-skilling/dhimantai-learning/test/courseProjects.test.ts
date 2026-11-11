import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

test('course project setup reuses authored and custom briefs, preserves gates and cancels on account change', async () => {
  let command: (id:string)=>Promise<void>, owner = 'learner', level = 'micro', custom = true, switchAccount = false;
  const briefs: any[] = [], created: any[] = [], navigation: string[] = [], errors: string[] = [];
  const api = {
    skillingPathway:async()=>({pathway:{profile:{title:'Python',project_theme:'A tested command-line tool'},
      milestones:[{id:'micro',unlocked:true},{id:'minor',unlocked:false},{id:'major',unlocked:true}]}}),
    skillingBrief:async(...args:any[])=>{briefs.push(args);return {brief:{title:'Chosen project'}};},
  };
  const vscode = {commands:{registerCommand:(_id:string,fn:typeof command)=>{command=fn;},
    executeCommand:async(id:string)=>{navigation.push(id);}},window:{
    showQuickPick:async(items:any[])=>items.find(i=>i.id===level)??items.find(i=>i.custom===custom),
    showInputBox:async(options:any)=>{assert.ok(options.validateInput('short')); assert.equal(options.validateInput('A command-line planner with saved tasks and deadline filters.'),undefined);
      if(switchAccount)owner='another-learner';return 'A command-line planner with saved tasks and deadline filters.';},
    showInformationMessage:async()=> 'Open roadmap',showErrorMessage:(message:string)=>{errors.push(message);},
  }};
  const exports:any={};
  runInNewContext(readFileSync(resolve(__dirname,'../src/courseProjects.js'),'utf8'), {exports,
    require:(id:string)=>id==='vscode'?vscode:id==='./api'?{Api:class{constructor(){return api;}}}
      :id==='./skillingActions'?{createGuidedProject:async(_context:any,plan:any,current:any)=>{assert.ok(await current());created.push(plan);}}:{}});
  exports.registerCourseProjects({}, {session:async()=>({user:{id:owner}})},()=> 'staging',()=>({}));
  await command!('python');
  assert.equal(briefs[0][1],'micro'); assert.match(briefs[0][2],/planner/); assert.equal(created.length,1);
  custom=false;level='major'; await command!('python');
  assert.deepEqual(briefs[1],['python','major','']); assert.equal(created.length,2);
  level='minor';await command!('python');assert.equal(briefs.length,2);assert.deepEqual(navigation,['dhimantai.courseGrade']);
  custom=true;level='micro';switchAccount=true;await command!('python');
  assert.equal(briefs.length,2,'account switching cancels before requesting or creating a project');assert.deepEqual(errors,[]);
});
