import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentRoom} from '../webview/agentRoom';

test('AgentRoom acknowledges accepted board writes and rejects stale or unrendered packets',async()=>{
  const handlers=new Map<string,(data:any)=>Promise<string>>();
  const peer={identity:'worker',isAgent:true,trackPublications:new Map()};
  const packets:any[]=[];
  class Room {
    remoteParticipants=new Map([['worker',peer]]);
    localParticipant={
      registerRpcMethod(name:string,handler:(data:any)=>Promise<string>){handlers.set(name,handler);},
      async performRpc(){return 'ok';}
    };
    on(){} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  const globals=globalThis as any, previous=globals.LivekitClient;
  globals.LivekitClient={Room,RoomEvent:{}};
  const room=new AgentRoom({packet(packet){
    if(packet.study_request_id!=='current'||typeof packet.content!=='string'||!packet.content.trim())return false;
    packets.push(packet);return true;
  },state(){},error(message){throw new Error(message);}});
  try {
    await room.connect({url:'unused',token:'unused'},{mode:'study'});
    for(const method of ['display_on_screen','write_on_whiteboard']) {
      const deliver=(packet:object)=>handlers.get(method)!({callerIdentity:'worker',payload:JSON.stringify(packet)});
      assert.equal(JSON.parse(await deliver({study_request_id:'current',content:'A useful step'})).status,'ok');
      assert.equal(JSON.parse(await deliver({study_request_id:'old',content:'Stale step'})).status,'ignored');
      assert.equal(JSON.parse(await deliver({study_request_id:'current',content:' '})).status,'ignored');
      await assert.rejects(handlers.get(method)!({callerIdentity:'worker',payload:'not json'}));
    }
    assert.equal(packets.length,2);
  } finally {await room.close();globals.LivekitClient=previous;}
});
