import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopExtensionPath,preserveDesktopDefaults} from '../src/desktopConfiguration';

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
