import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {FreeCADRoom} from '../webview/freecadRoom';
import {exerciseWindow} from '../src/freecadFocus';
import {cadAction} from '../src/freecadCourse';

test('FreeCAD replies belong to the current room and End interrupts pending observations',async()=>{
  const sent:any[]=[];
  const room=new FreeCADRoom(2,msg=>sent.push(msg));
  const view=room.command('observe');
  assert.equal(sent[0].attempt,2);
  room.receive('previous-id',{status:'ready',radius:42});
  room.receive(sent[0].id,{status:'ready',radius:7});
  assert.equal((await view).radius,7);
  const pending=room.command('top_view');
  room.close();
  assert.deepEqual(await pending,{status:'closed'});
  assert.equal(cadAction('save'),false);
  assert.deepEqual(await room.command('save'),{status:'invalid'});
  assert.equal(sent.length,2);
});

test('a persistent native failure stops observation after three attempts',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let samples=0, message='';
  const room=new FreeCADRoom(1,(value:any)=>{
    samples++;
    queueMicrotask(()=>room.receive(value.id,{status:'disconnected'}));
  });
  room.watch(()=>true,async()=>'ok',text=>{message=text;});
  for(let i=0;i<6;i++){
    await new Promise<void>(resolve=>queueMicrotask(resolve));
    t.mock.timers.tick(15000);
  }
  assert.equal(samples,3);
  assert.match(message,/observation stopped/);
  room.close();
});

test('Cua activation binds exactly one matching FreeCAD process and window',()=>{
  const target={pid:8,title:'Mounting-plate[*] - FreeCAD'};
  const right={pid:8,window_id:32,title:'* Mounting-plate - FreeCAD'};
  assert.equal(exerciseWindow(target,[{...right,pid:4},right]),32);
  assert.equal(exerciseWindow(target,[{...right,title:'Other part - FreeCAD'}]),undefined);
  assert.equal(exerciseWindow(target,[right,{...right,window_id:33}]),undefined);
});
