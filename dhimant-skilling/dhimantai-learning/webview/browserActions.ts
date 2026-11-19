import {BrowserDemonstration,DemonstrationResult,validDemonstration,validDemonstrationResult} from '../src/browserDemonstration';

/** An authenticated worker RPC is forwarded to this window's extension host, never directly to a page. */
export class BrowserActionRelay {
  private pending=new Map<string,{attempt:number;finish:(value:DemonstrationResult)=>void}>();
  constructor(private readonly post:(message:unknown)=>void) {}
  run(command:BrowserDemonstration,attempt:number):Promise<DemonstrationResult> {
    if(!validDemonstration(command)||this.pending.size)return Promise.resolve({status:'rejected',message:'A demonstration is already pending or invalid.'});
    return new Promise(resolve=>{
      const finish=(value:DemonstrationResult)=>{clearTimeout(timer);this.pending.delete(command.id);resolve(value);};
      const timer=setTimeout(()=>finish({status:'uncertain',message:'The browser did not acknowledge the action. Inspect the form before continuing.'}),12000);
      this.pending.set(command.id,{attempt,finish});
      this.post({type:'browserDemonstrate',attempt,command});
    });
  }
  receive(id:string,attempt:number,result:unknown) {
    const pending=this.pending.get(id);
    if(pending?.attempt===attempt&&validDemonstrationResult(result))pending.finish(result);
  }
  close() {for(const pending of this.pending.values())pending.finish({status:'interrupted',message:'The Instructor session changed.'});}
}
