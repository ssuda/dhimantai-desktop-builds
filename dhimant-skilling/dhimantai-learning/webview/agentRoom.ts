/** Client transport only. Agent selection, prompts and tools live on the server. */
import type { Room, RemoteParticipant } from 'livekit-client';
import type { NotebookAttachments } from './notebookAttachments';
declare const LivekitClient: typeof import('livekit-client');
export interface AgentGrant {url:string;token:string}
export class AgentRoom {
  private room?:Room;
  private agent='';
  private media=new Set<HTMLMediaElement>();
  private enabled=false;
  constructor(private events:{packet(value:any):boolean;state(value:string):void;error(message:string):void}){}
  sound(enabled:boolean){this.enabled=enabled;for(const audio of this.media){audio.muted=!enabled;if(enabled)void audio.play().catch(()=>{});}}
  async close(){const old=this.room;this.room=undefined;this.agent='';for(const audio of this.media)audio.remove();this.media.clear();await old?.disconnect();}
  async connect(grant:AgentGrant,mode:object){
    await this.close();
    const live=this.room=new LivekitClient.Room();
    const current=()=>this.room===live;
    const isAgent=(peer?:RemoteParticipant)=>current()&&!!peer?.isAgent&&(!this.agent||peer.identity===this.agent);
    const {RoomEvent}=LivekitClient;
    live.on(RoomEvent.DataReceived,(bytes,peer)=>{if(!isAgent(peer)||bytes.length>320000)return;
      try{this.events.packet(JSON.parse(new TextDecoder().decode(bytes)));}catch{ /* malformed packet is not a reply */ }});
    for(const method of ['display_on_screen','write_on_whiteboard'])live.localParticipant.registerRpcMethod(method,async data=>{
      if(!isAgent(live.remoteParticipants.get(data.callerIdentity)))return '';
      if(data.payload.length>320000)throw new Error('Response too large');
      const accepted=this.events.packet({...JSON.parse(data.payload),method});
      return JSON.stringify({status:accepted?'ok':'ignored'});
    });
    live.on(RoomEvent.ParticipantAttributesChanged,(changed,peer)=>{if(isAgent(peer as RemoteParticipant)&&changed['lk.agent.state'])this.events.state(changed['lk.agent.state']);});
    live.on(RoomEvent.TrackPublished,(publication,peer)=>{if(isAgent(peer)&&publication.kind==='audio')publication.setSubscribed(true);});
    live.on(RoomEvent.TrackSubscribed,(track,_publication,peer)=>{if(!isAgent(peer)||track.kind!=='audio')return;
      const audio=track.attach();audio.muted=!this.enabled;document.body.append(audio);this.media.add(audio);
      if(this.enabled)void audio.play().catch(()=>{});
    });
    live.on(RoomEvent.TrackUnsubscribed,track=>{for(const audio of track.detach()){this.media.delete(audio);audio.remove();}});
    live.on(RoomEvent.Disconnected,()=>{if(current()){void this.close();this.events.error('Agent disconnected. Ask again to reconnect.');}});
    live.on(RoomEvent.ParticipantDisconnected,peer=>{if(current()&&peer.identity===this.agent){void this.close();this.events.error('Agent disconnected. Ask again to reconnect.');}});
    try{
      await live.connect(grant.url,grant.token,{autoSubscribe:false});
      const deadline=Date.now()+65000;
      while(current()&&Date.now()<deadline){
        const peer=[...live.remoteParticipants.values()].find(p=>p.isAgent);
        if(peer){this.agent=peer.identity;
          for(const publication of peer.trackPublications.values())if(publication.kind==='audio')publication.setSubscribed(true);
          try{const reply=await this.rpc('switch_mode',mode,30000);
            if(reply!=='ok')throw new Error(reply.startsWith('error:')?reply.slice(6).trim():'The agent could not start.');
            return;
          }catch(error){if(!(error instanceof LivekitClient.RpcError&&error.code===LivekitClient.RpcError.ErrorCode.UNSUPPORTED_METHOD))throw error;}
        }
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      throw new Error('The agent did not become ready. Ask again to reconnect.');
    }catch(error){if(current())await this.close();throw error;}
  }
  async rpc(method:string,payload:object,timeout=15000){
    if(!this.room||!this.agent)throw new Error('The agent is not connected.');
    return this.room.localParticipant.performRpc({destinationIdentity:this.agent,method,payload:JSON.stringify(payload),responseTimeout:timeout});
  }
  async upload(attachments:NotebookAttachments,text:string,current:()=>boolean) {
    if(!this.room||!this.agent)throw new Error('The agent is not connected.');
    const room=this.room;
    return attachments.upload(room.localParticipant,this.agent,text,()=>this.room===room&&current());
  }
}
