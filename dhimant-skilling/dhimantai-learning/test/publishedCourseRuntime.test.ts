import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {RuntimeRelease,runtimeRelease,runtimeSelection,runtimeMachines,composeRuntime} from '../src/courseRuntime';
import {CourseEngine} from '../src/courseEngine';

const fixture=():RuntimeRelease=>{
  const image='registry.example/course/runtime@sha256:'+'a'.repeat(64);
  const service={image,mem_limit:'512m',cpus:1,pids_limit:128};
  return {version:1,course_id:'course',title:'Course',source_sha256:'b'.repeat(64),recipe:{language:'sql',services:[]},
    images:{course:image},default:{image},lessons:{lesson:{image,compose:'replication'}},labs:{lab:{image,compose:'replication'}},
    composes:{replication:{default_service:'primary',compose:{services:{primary:{...service},'replica-1':{...service}},
      networks:{default:{internal:true}}}}}};
};
test('lessons and labs inherit a shared digest and optional topology',()=>{
  const r=runtimeRelease(fixture());
  assert.deepEqual(runtimeSelection(r),r.default);
  assert.deepEqual(runtimeMachines(r,runtimeSelection(r,{lab:'lab'})),['primary','replica-1']);
  const c=composeRuntime(r,r.lessons.lesson,'/course files','learner-a',1000,1000,'darwin');
  assert.equal(c.services.primary.image,c.services['replica-1'].image);
  assert.notEqual(c.services.primary.environment.HOME,c.services['replica-1'].environment.HOME);
  assert.equal(c.services.primary.labels['ai.dhimant.course'],'learner-a');
  assert.deepEqual(c.services.primary.volumes,[{type:'bind',source:'/course files',target:'/course'}]);
  assert.deepEqual(c.services.primary.entrypoint,['python','/opt/dhimantai/service.py','1000','1000']);
  assert.deepEqual(c.services.primary.command,['sleep','infinity']);
  const linux=composeRuntime(r,r.lessons.lesson,'/course files','learner-a',1000,1000,'linux');
  assert.equal(linux.services.primary.userns_mode,'keep-id');
  assert.equal(linux.services.primary.volumes[0].bind.selinux,'z');
  assert.ok(!r.composes.replication.compose.services.primary.volumes,'the published release remains immutable');
});
test('published notebooks and terminals execute as the learner after service bootstrap',()=>{
  const engine=new CourseEngine('podman','replica','/course files',true,'replica-1');
  const args=engine.execArgs('/course files','python',['-V']);
  assert.deepEqual(args.slice(2,4),['--user',`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`]);
});
test('floating images and host privileges are rejected before any container starts',()=>{
  for(const patch of [{privileged:true},{network_mode:'host'},{ports:['5432:5432']},{volumes:['/etc:/etc']},
    {image:'registry.example/postgres:latest'},{environment:{SECRET:'${HOST_SECRET}'}},{command:['sh','-c','echo $HOST_SECRET']}]){
    const r=fixture();Object.assign(r.composes.replication.compose.services.primary,patch);
    assert.throws(()=>runtimeRelease(r));
  }
});
