import type {Room} from 'livekit-client';
import {cadAction, CadAction} from '../src/freecadCourse';

interface State {status:string;radius?:number;jpeg?:string}
export class FreeCADRoom {
  private pending=new Map<string,(value:State)=>void>();
  private timer?:ReturnType<typeof setTimeout>;
  private closed=false;
  private failures=0;
  private radius?:number;
  constructor(private readonly attempt:number,private readonly post:(msg:unknown)=>void) {}
  private call(action:CadAction|'state'):Promise<State> {
    if(this.closed)return Promise.resolve({status:'closed'});
    const id=crypto.randomUUID();
    return new Promise(resolve=>{
      const finish=(result:State)=>{clearTimeout(timer);this.pending.delete(id);resolve(result);};
      const timer=setTimeout(()=>finish({status:'timeout'}),5000);
      this.pending.set(id,finish);
      this.post({type:'freecadAction',id,attempt:this.attempt,action});
    });
  }
  receive(id:string,result:State) {this.pending.get(id)?.(result);}
  async command(action:unknown) {
    if(!cadAction(action))return {status:'invalid'};
    const result=await this.call(action);
    if(action==='demonstrate_radius' && result.status==='ready')this.radius=result.radius;
    return result;
  }
  bind(room:Room, agent:()=>string|undefined, current:()=>boolean, ready:()=>boolean, report:(text:string)=>void) {
    room.localParticipant.registerRpcMethod('freecad_exercise',async data=>{
      const peer=room.remoteParticipants.get(data.callerIdentity);
      if(!current() || this.closed || data.callerIdentity!==agent() || !peer?.isAgent)return '{"status":"closed"}';
      let action;try{action=JSON.parse(data.payload).action;}catch{return '{"status":"invalid"}';}
      if(!ready() && action!=='observe')return '{"status":"connecting"}';
      return JSON.stringify(await this.command(action));
    });
    this.watch(()=>current() && ready() && !!agent(),async radius=>{
      return room.localParticipant.performRpc({destinationIdentity:agent()!,method:'on_freecad_change',
        payload:JSON.stringify({radius}),responseTimeout:5000});
    },report);
  }
  watch(connected:()=>boolean,change:(radius:number)=>Promise<string>,status:(message:string)=>void) {
    let pending:{radius:number;remaining:number}|undefined;
    const sample=async()=>{
      if(this.closed)return;
      if(connected()){
        try {
          const result=await this.call('state');
          if(this.closed)return;
          if(result.status==='ready' && typeof result.radius==='number'){
            const before=this.radius;
            this.radius=result.radius;
            status('Instructor can see the mounting plate in FreeCAD.');
            if(before!==undefined && before!==result.radius)pending={radius:result.radius,remaining:3};
            if(pending){
              const update=pending;
              if(--update.remaining===0)pending=undefined;
              const ack=await change(update.radius);
              if(ack==='ok')pending=undefined;
              else if(ack!=='busy')throw new Error('Instructor unavailable');
            }
          } else if(result.status==='inactive'||result.status==='changed') {
            pending=undefined;
            status('Instructor view is paused. Return to the mounting-plate exercise in FreeCAD.');
          } else throw new Error('FreeCAD unavailable');
          this.failures=0;
        } catch {
          if(++this.failures>=3){
            status('FreeCAD observation stopped. Reopen the lesson to reconnect.');
            return;
          }
        }
      }
      if(!this.closed)this.timer=setTimeout(sample,2500*(1+this.failures));
    };
    void sample();
  }
  close(){
    this.closed=true;clearTimeout(this.timer);
    for(const finish of this.pending.values())finish({status:'closed'});
  }
}
