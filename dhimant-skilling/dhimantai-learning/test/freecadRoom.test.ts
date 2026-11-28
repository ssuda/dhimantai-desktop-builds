import * as assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FreeCADRoom, needsFreeCADVoiceGesture} from '../webview/freecadRoom';
import {capturePoint, matchingWindow} from '../src/desktopControl';
import {cadAction, FREECAD_CHAPTER} from '../src/freecadCourse';
import {compatibleMacQt, macFreeCADBundle} from '../src/freecadInstaller';

test('FreeCAD waits for a click in the notebook only when voice needs activation', () => {
  assert.equal(needsFreeCADVoiceGesture(FREECAD_CHAPTER, 'tutor', true, false), true);
  assert.equal(needsFreeCADVoiceGesture(FREECAD_CHAPTER, 'tutor', true, true), false);
  assert.equal(needsFreeCADVoiceGesture(FREECAD_CHAPTER, 'tutor', false, false), false);
  assert.equal(needsFreeCADVoiceGesture('other-chapter', 'tutor', true, false), false);
});

test('macOS resolves PATH aliases to a FreeCAD bundle with the compatible Qt runtime', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'freecad-bundle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bundle = join(root, 'FreeCAD.app');
  const binary = join(bundle, 'Contents', 'MacOS', 'FreeCAD');
  const lib = join(bundle, 'Contents', 'Resources', 'lib');
  await mkdir(join(bundle, 'Contents', 'MacOS'), {recursive: true});
  await mkdir(lib, {recursive: true});
  await writeFile(binary, '');
  const alias = join(root, 'freecad');
  await symlink(binary, alias);
  const core = join(lib, 'libQt6Core.6.dylib');
  for (const version of ['6.8.3', '6.11.2']) {
    const target = 'libQt6Core.' + version + '.dylib';
    await writeFile(join(lib, target), '');
    await symlink(target, core);
    assert.equal(await macFreeCADBundle(alias), version === '6.8.3' ? undefined : await realpath(bundle));
    await rm(core);
  }
  assert.equal(compatibleMacQt(undefined), false);
  assert.equal(compatibleMacQt('6.11.1'), false);
  assert.equal(compatibleMacQt('6.12.0'), false);
});

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
  const bounds={x:40,y:60,width:800,height:400};
  const right={pid:8,window_id:32,title:'* Mounting-plate - FreeCAD',bounds};
  assert.equal(matchingWindow(target,[{...right,pid:4},right])?.window_id,32);
  assert.equal(matchingWindow(target,[{...right,title:'Other part - FreeCAD'}]),undefined);
  assert.equal(matchingWindow(target,[right,{...right,window_id:33}]),undefined);
  assert.deepEqual(capturePoint({x:70,y:80},bounds,1600,800),{x:60,y:40});
  assert.throws(()=>capturePoint({x:20,y:80},bounds,1600,800));
  assert.throws(()=>capturePoint({x:70,y:80},bounds,800,800));
});
