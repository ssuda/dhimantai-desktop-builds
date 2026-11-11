import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {desktopRoom} from '../src/desktopRoom';
import {desktopExtensionPath} from '../src/desktopConfiguration';
const token = (data: object) => 'header.' + Buffer.from(JSON.stringify(data)).toString('base64url') + '.test';
const service = {apiUrl:'https://api-staging.dhimant.ai', supabaseUrl:'', supabaseAnonKey:''};
const profile = {sub:'student', name:'Learner', attributes:{student_id:'student', role:'student', language:'English'}};
test('desktop follows Flutter getToken signing, profile and room contract', async () => {
  const path = await mkdtemp(join(tmpdir(),'desktop-room-'));
  try {
    await writeFile(join(path,'desktop-client.json'), JSON.stringify({staging:{tokenUrl:service.apiUrl, signingKey:'fixture-only', appName:'dhimantAI Staging'}}));
    let requests = 0;
    const request: typeof fetch = async (url, init) => {
      requests++;
      assert.equal(url, service.apiUrl + '/getToken');
      assert.equal((init!.headers as any)['X-Signature'], createHmac('sha256','fixture-only').update(init!.body as string).digest('hex'));
      const body = JSON.parse(init!.body as string);
      assert.equal(body.identity, 'student'); assert.equal(body.app_name, 'dhimantAI Staging');
      assert.deepEqual(body.attributes, {...profile.attributes, agent_mode:'idle'});
      assert.match(body.room_name, /^vidyai-student-/);
      return Response.json({serverUrl:'wss://lk-staging.dhimant.ai', participantToken:token({sub:'student',video:{room:body.room_name}})});
    };
    const grant = await desktopRoom(path,'staging',service,'student',{url:'unused',token:token(profile)},request);
    assert.equal(requests,1); assert.equal(grant.url,'wss://lk-staging.dhimant.ai');
    await assert.rejects(desktopRoom(path,'staging',service,'someone-else',{url:'unused',token:token(profile)},request), /account changed/);
    assert.equal(requests,1);
    await assert.rejects(desktopRoom(path,'production',{...service,apiUrl:'https://api-prod.dhimant.ai'},'student', {url:'unused',token:token(profile)},request), /not configured/);
    assert.equal(requests,1);
  } finally { await rm(path,{recursive:true,force:true}); }
});

test('a public extension update keeps using the app-owned device configuration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'updated-desktop-room-'));
  try{
    const appRoot=join(root,'app'),bundle=desktopExtensionPath(appRoot),updated=join(root,'user-extension');
    await mkdir(bundle,{recursive:true});await mkdir(updated);
    await writeFile(join(bundle,'desktop-client.json'),JSON.stringify({staging:{tokenUrl:service.apiUrl,signingKey:'app-owned',appName:'dhimantAI Staging'}}));
    // A downloaded extension cannot replace the package's connection configuration.
    await writeFile(join(updated,'desktop-client.json'),JSON.stringify({staging:{tokenUrl:'https://untrusted.invalid',signingKey:'other'}}));
    let requests=0;
    const request:typeof fetch=async(url,init)=>{
      requests++;assert.equal(url,service.apiUrl+'/getToken');
      assert.equal((init!.headers as any)['X-Signature'],createHmac('sha256','app-owned').update(init!.body as string).digest('hex'));
      const body=JSON.parse(init!.body as string);
      return Response.json({serverUrl:'wss://lk-staging.dhimant.ai',participantToken:token({sub:'student',video:{room:body.room_name}})});
    };
    await desktopRoom(updated,'staging',service,'student',{url:'unused',token:token(profile)},request,appRoot);
    assert.equal(requests,1);
    await rm(join(bundle,'desktop-client.json'));
    await assert.rejects(desktopRoom(updated,'staging',service,'student',{url:'unused',token:token(profile)},request,appRoot),/missing/);
    assert.equal(requests,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
