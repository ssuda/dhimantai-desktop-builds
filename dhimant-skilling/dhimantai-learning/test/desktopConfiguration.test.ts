import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopExtensionPath,preserveDesktopDefaults,migrateDesktopAppBar} from '../src/desktopConfiguration';

test('the old persisted hidden default migrates once; later and workspace layout choices survive', async () => {
  const state = new Map<string, unknown>(), values = new Map<string, unknown>([['workbench.activityBar.location', 'hidden']]);
  const store = {get: (key: string) => state.get(key), update: async (key: string, value: boolean) => { state.set(key, value); }};
  const settings = {inspect: (key: string) => ({globalValue: values.get(key)}),
    update: async (key: string, value: unknown) => { values.set(key, value); }};
  await migrateDesktopAppBar(store, settings);
  assert.equal(values.get('workbench.activityBar.location'), 'default');
  values.set('workbench.activityBar.location', 'hidden');
  await migrateDesktopAppBar(store, settings);
  assert.equal(values.get('workbench.activityBar.location'), 'hidden');
  state.clear();
  await migrateDesktopAppBar(store, {...settings, inspect: () => ({globalValue: 'hidden', workspaceValue: 'hidden'})});
  assert.equal(values.get('workbench.activityBar.location'), 'hidden');
});

test('an updated extension preserves desktop defaults without replacing explicit preferences',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-defaults-'));
  try {
    const bundle=desktopExtensionPath(root);await mkdir(bundle,{recursive:true});
    await writeFile(join(bundle,'package.json'),JSON.stringify({publisher:'optficial',name:'dhimantai-learning',contributes:{configurationDefaults:{
      'dhimantai.environment':'staging','dhimantai.autoUpdate':false,'workbench.colorTheme':'Light Modern',
      'workbench.activityBar.location':'hidden','workbench.startupEditor':'none','unrelated.setting':'ignored'}}}));
    const values=new Map<string,unknown>([['workbench.colorTheme','Dark Modern']]);
    const settings={inspect:(key:string)=>key==='workbench.startupEditor'?{workspaceValue:'welcomePage'}:{globalValue:values.get(key)},
      update:async(key:string,value:unknown)=>{values.set(key,value);}};
    await preserveDesktopDefaults(root,settings);
    assert.deepEqual(Object.fromEntries(values),{'workbench.colorTheme':'Dark Modern','dhimantai.environment':'staging','dhimantai.autoUpdate':true,'workbench.activityBar.location':'hidden'});
    values.set('dhimantai.autoUpdate',false);
    await preserveDesktopDefaults(root,{...settings,update:async()=>{throw new Error('Already preserved settings must not be rewritten');}});
    assert.equal(values.get('dhimantai.autoUpdate'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
