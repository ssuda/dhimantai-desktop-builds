import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {desktopRoom} from '../src/desktopRoom';
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
