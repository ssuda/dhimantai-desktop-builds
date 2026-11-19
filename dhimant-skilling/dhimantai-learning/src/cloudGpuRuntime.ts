import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CloudCli,CLOUD_CLIS,CloudProvider,CliProvider,AVAILABLE_CLOUD_PROVIDERS,VM_CLOUDS} from './cloudCli';
import type {SkySpotRuntime} from './skySpotRuntime';
import {GpuLabRequirement,SshHost,parseSshHost} from './sshRuntimeConfig';

export interface CloudQuote {type:string;zone:string;region:string;nodes:number;gpusPerNode:number;price?:number;currency?:string}
interface CloudRecord {
  version:1;provider:CliProvider;account:string;name:string;scope:string;quote:CloudQuote;
  resources:Record<string,string>;ids:string[];created:string;phase:'creating'|'running'|'cleanup';
  expiresAt?:number;
}
export function cheapestSpot(quotes:CloudQuote[],requirement:GpuLabRequirement) {
  const layouts=requirement.layouts??[{nodes:requirement.nodes,gpusPerNode:requirement.gpusPerNode}];
  return quotes.filter(q=>layouts.some(l=>l.nodes===q.nodes&&l.gpusPerNode===q.gpusPerNode)
    && typeof q.price==='number'&&Number.isFinite(q.price)&&q.price>0)
    .sort((a,b)=>a.price!*a.nodes-b.price!*b.nodes)[0];
}
/** Provider CLI provisioning journal. No SDK, shell interpolation, hidden on-demand fallback or unbounded retries. */
export class CloudGpuRuntime {
  private vm?:SkySpotRuntime;
  private providerId?:CloudProvider;
  private cli!:CloudCli;
  private record!:CloudRecord;
  private key='';
  private identity='';
  private ending?:Promise<void>;
  private allocated=false;
  private preserveWork=false;
  constructor(private context:vscode.ExtensionContext,private scope:string) {}
  get label(){if(this.vm)return this.vm.label;return this.record?CLOUD_CLIS[this.record.provider].label+' · Spot':'Cloud';}
  get remainingMs(){if(this.vm)return this.vm.remainingMs;return Math.max(1,(this.record.expiresAt??Date.now()+180*60000)-Date.now()-5*60000);}
  private async save(){await this.context.globalState.update(this.key,this.record);}
  async connect(requirement:GpuLabRequirement):Promise<{hosts:SshHost[];requirement:GpuLabRequirement}> {
    if(requirement.layouts?.length) {
      const selection=await vscode.window.showQuickPick([
        {label:'Cheapest compatible layout',layout:undefined as GpuLabRequirement['layouts']},
        ...requirement.layouts.map(layout=>({label:layout.label,layout:[layout]})),
      ],{title:'Choose the lab exercise',placeHolder:'The networking exercise requires two separate machines'});
      if(!selection)throw new Error('Cloud connection cancelled.');
      if(selection.layout)requirement={...requirement,...selection.layout[0],layouts:selection.layout};
    }
    const options=AVAILABLE_CLOUD_PROVIDERS.map(id=>id==='jarvis'
      ? {label:CLOUD_CLIS[id].label,description:'India · Spot GPU container',id}
      : {label:VM_CLOUDS[id].label,description:'Spot GPU VMs · SkyPilot',id});
    const provider=this.providerId?options.find(option=>option.id===this.providerId)
      :await vscode.window.showQuickPick(options,{title:'Choose your GPU cloud'});
    if(!provider)throw new Error('Cloud connection cancelled.');
    this.providerId=provider.id;
    if(provider.id!=='jarvis'){
      const {SkySpotRuntime}=await import('./skySpotRuntime');
      this.vm=new SkySpotRuntime(this.context.asAbsolutePath('media/course/sky_spot.py'),provider.id,this.scope);
      return this.vm.connect(requirement);
    }
    this.cli=new CloudCli(provider.id);
    const account=await this.cli.authenticate();
    this.key='gpuCloud.'+createHash('sha256').update(this.scope+'|'+provider.id+'|'+account).digest('hex');
    const previous=this.context.globalState.get<CloudRecord>(this.key);
    if(previous) {
      this.record=previous;this.allocated=true;
      this.identity=previous.resources.identity;
      if(previous.phase==='running') {
        this.preserveWork=true;
        if(!(requirement.layouts??[requirement]).some(l=>l.nodes===previous.quote.nodes&&l.gpusPerNode===previous.quote.gpusPerNode))
          throw new Error('The saved cloud allocation has a different layout. Reconnect its original layout and finish that lab before switching.');
        const hosts=await this.resume();
        return {hosts,requirement:{...requirement,nodes:previous.quote.nodes,gpusPerNode:previous.quote.gpusPerNode,managedContainer:true}};
      }
      // Never duplicate a timed-out creation. Finish its recorded teardown before another allocation.
      await this.teardown();
    }
    const region='India';
    const name='dhai-'+randomBytes(8).toString('hex');
    this.record={version:1,provider:provider.id,account,name,scope:this.scope,quote:{region,zone:'',type:'',nodes:requirement.nodes,gpusPerNode:requirement.gpusPerNode},resources:{},ids:[],created:new Date().toISOString(),phase:'creating',expiresAt:Date.now()+180*60000};
    const quote=await this.quote(requirement);
    this.record.quote=quote;
    if(!quote.price)throw new Error('A current compatible spot price is required before creating compute.');
    const price=`${quote.currency??'USD'} ${(quote.price*quote.nodes).toFixed(3)}/hour estimated compute; lowest quoted compatible cost among the reviewed shapes in this region`;
    const budget='Keep dhimantAI open for automatic completion and the three-hour stop. If your computer is off, cloud billing continues until you pause or delete the instance.';
    const message=`${quote.nodes} × ${quote.type} in ${quote.zone||quote.region}, ${quote.gpusPerNode} lab GPU(s) per machine, 100 GB disk per machine. ${price}. Storage, network and applicable taxes are extra and separate from the course fee. Spot can be interrupted. Finish lab saves work and deletes this lab's resources. ${budget}`;
    let action=await vscode.window.showInformationMessage(message,{modal:true},'Start spot runtime','View pricing');
    if(action==='View pricing'){await vscode.env.openExternal(vscode.Uri.parse(CLOUD_CLIS[provider.id].pricing));action=await vscode.window.showInformationMessage(message,{modal:true},'Start spot runtime');}
    if(action!=='Start spot runtime')throw new Error('Cloud allocation cancelled.');
    await this.cli.requireAccount(account);
    this.record.expiresAt=Date.now()+180*60000;
    const folder=join(this.context.globalStorageUri.fsPath,'gpu-cloud',name);await mkdir(folder,{recursive:true,mode:0o700});
    this.identity=join(folder,'id_ed25519');
    await promisify(execFile)('ssh-keygen',['-t','ed25519','-N','','-C',name,'-f',this.identity],{timeout:30000,windowsHide:true});
    this.record.resources.identity=this.identity;this.allocated=true;await this.save();
    try {
      const hosts=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Creating spot lab runtime'},()=>this.jarvis());
      this.record.phase='running';await this.save();
      return {hosts,requirement:{...requirement,nodes:quote.nodes,gpusPerNode:quote.gpusPerNode,managedContainer:true}};
    }catch(error){
      try{await this.teardown();}catch(cleanup){throw new Error(`${(error as Error).message}\nCleanup needs attention: ${(cleanup as Error).message}. The allocation is recorded; select the cloud runtime to retry cleanup.`);}
      throw error;
    }
  }
  async savedArtifact(file:string){if(this.vm)return this.vm.savedArtifact(file);this.record.resources.artifact=file;await this.save();}
  async failedSetup(){if(this.vm)return this.vm.failedSetup();if(this.preserveWork)await this.pause();else await this.teardown();}
  private async resume():Promise<SshHost[]> {
    const r=this.record;await this.cli.requireAccount(r.account);
    if(r.provider==='jarvis') {
      const instance=await this.jarvisInstance();
      let current=instance;
      if(instance.status==='Paused') {
        const prices=await this.cli.run(['gpus','--json']);
        const offer=prices.find((p:any)=>p.gpu_type===r.quote.type&&p.region===r.quote.region&&p.workload_type!=='vm'&&Number(p.spot_price)>0&&Number(p.spot_num_free_devices??p.num_free_devices)>=r.quote.gpusPerNode);
        if(!offer)throw new Error('Compatible spot capacity is unavailable. Your saved allocation is retained; reconnect when capacity returns.');
        const status=await this.cli.run(['status','--json']);
        if(!['INR','USD'].includes(status.currency))throw new Error('The cloud account billing currency could not be verified.');
        const rate=Number(offer.spot_price)*r.quote.gpusPerNode;
        if(rate>r.quote.price!||status.currency!==r.quote.currency) {
          const approval=await vscode.window.showInformationMessage(`Resume the saved lab at ${status.currency} ${rate.toFixed(3)}/hour estimated compute? Storage, network and taxes are extra. Keep dhimantAI open for automatic cleanup.`,{modal:true},'Resume spot runtime');
          if(approval!=='Resume spot runtime')throw new Error('Resume cancelled. Your saved cloud allocation is retained.');
        }
        await this.cli.requireAccount(r.account);
        r.quote.price=rate;r.quote.currency=status.currency;await this.save();
        current=await this.cli.run(['resume',String(instance.machine_id),'--gpu',r.quote.type,'--num-gpus',String(r.quote.gpusPerNode),'--spot','--json','--yes'],900000);
        r.ids=[String(current.machine_id)];r.expiresAt=Date.now()+180*60000;await this.save();
      }
      return [this.jarvisHost(current)];
    }
    throw new Error('The saved provider is not supported.');
  }
  private async quote(requirement:GpuLabRequirement):Promise<CloudQuote> {
    const {provider}=this.record;
    if(provider==='jarvis') {
      const status=await this.cli.run(['status','--json']);
      if(!['INR','USD'].includes(status.currency))throw new Error('The cloud account billing currency could not be verified.');
      const layouts=(requirement.layouts??[requirement]).filter(l=>l.nodes===1);
      if(!layouts.length)throw new Error('JarvisLabs spot instances support the single-machine exercise. Its spot containers cannot join a VPC. Use SSH for the two-machine networking exercise; no on-demand cluster was created.');
      const capabilities:Record<string,number>={A30:8,L4:8.9,A100:8,'A100-80GB':8,H100:9,H200:9};
      const rows=await this.cli.run(['gpus','--json']);
      const offers=rows.flatMap((row:any)=>{
        const memory=String(row.vram??'').match(/^(\d+(?:\.\d+)?)\s*G(?:i?B)?$/i);
        if(!['IN1','IN2'].includes(row.region)||row.workload_type==='vm'||!memory||Number(memory[1])*1000<requirement.minVramMiB||!(capabilities[row.gpu_type]>=requirement.minComputeCapability))return [];
        return layouts.filter(l=>Number(row.spot_num_free_devices??row.num_free_devices)>=l.gpusPerNode).map(l=>({
          region:row.region,zone:'',type:row.gpu_type,nodes:1,gpusPerNode:l.gpusPerNode,price:Number(row.spot_price)*l.gpusPerNode,currency:status.currency}));
      });
      const cheapest=cheapestSpot(offers,requirement);
      if(!cheapest)throw new Error('No priced, compatible spot capacity is available in India. No on-demand or overseas fallback was used.');
      return cheapest;
    }
    throw new Error('Select an Indian GPU provider.');
  }
  private async jarvisInstance() {
    const instances=await this.cli.run(['list','--json']);
    const matches=instances.filter((v:any)=>v.name===this.record.name||this.record.ids.includes(String(v.machine_id)));
    if(matches.length!==1)throw new Error('The saved JarvisLabs allocation could not be uniquely identified. Check the account before creating another machine.');
    return matches[0];
  }
  private jarvisHost(instance:any):SshHost {
    if(instance.status!=='Running'||instance.is_spot!==true||instance.num_gpus!==this.record.quote.gpusPerNode||instance.gpu_type!==this.record.quote.type||instance.name!==this.record.name||instance.template==='vm'||instance.region!==this.record.quote.region||!Number.isSafeInteger(instance.machine_id)||instance.machine_id<=0)
      throw new Error('JarvisLabs did not return the requested Indian spot GPU runtime.');
    return {...parseSshHost(instance.ssh_command),identity:this.identity};
  }
  private async jarvis():Promise<SshHost[]> {
    const r=this.record,q=r.quote;
    await this.cli.requireAccount(r.account);
    const prices=await this.cli.run(['gpus','--json']);
    const offer=prices.find((p:any)=>p.gpu_type===q.type&&p.region===q.region&&p.workload_type!=='vm'&&Number(p.spot_num_free_devices??p.num_free_devices)>=q.gpusPerNode&&Number(p.spot_price)>0&&Number(p.spot_price)*q.gpusPerNode<=q.price!);
    if(!offer)throw new Error('The reviewed Indian spot quote is no longer available. No higher-cost fallback was created.');
    r.resources.key=r.name;await this.save();
    await this.cli.run(['ssh-key','add',this.identity+'.pub','--name',r.name,'--json']);
    r.resources.createRequested='1';await this.save();
    const instance=await this.cli.run(['create','--gpu',q.type,'--num-gpus',String(q.gpusPerNode),'--template','pytorch','--storage','100','--name',r.name,'--region',q.region,'--spot','--json','--yes'],900000);
    r.ids=[String(instance.machine_id)];await this.save();
    return [this.jarvisHost(instance)];
  }
  async pause() {
    if(this.vm)return this.vm.pause();
    if(!this.record)return;await this.cli.requireAccount(this.record.account);
    const r=this.record;
    if(r.provider==='jarvis'){
      const instance=await this.jarvisInstance();
      if(instance.status==='Paused')return;
      if(instance.status!=='Pausing')await this.cli.run(['pause',String(instance.machine_id),'--json','--yes']);
      const deadline=Date.now()+180000;
      for(let attempt=0;attempt<30&&Date.now()<deadline;attempt++) {
        const current=await this.cli.run(['get',String(instance.machine_id),'--json']);
        if(current.status==='Paused')return;
        await new Promise(resolve=>setTimeout(resolve,3000));
      }
      throw new Error('JarvisLabs has not confirmed the pause. Check the instance billing state.');
    }
  }
  teardown():Promise<void> {return this.ending??=(this.vm?this.vm.teardown():this.destroy()).finally(()=>{this.ending=undefined;});}
  private async destroy() {
    if(!this.record||!this.allocated)return;await this.cli.requireAccount(this.record.account);
    const r=this.record;r.phase='cleanup';await this.save();
    if(r.provider==='jarvis') {
      const instances=await this.cli.run(['list','--json']);
      const owned=instances.filter((v:any)=>v.name===r.name||r.ids.includes(String(v.machine_id)));
      if(owned.length>1)throw new Error('Multiple cloud instances share the lab identifier. Cleanup needs review.');
      if(!owned.length&&!r.ids.length&&r.resources.createRequested)
        throw new Error('The create result is unknown and its instance is not listed yet. The allocation record was retained to prevent a duplicate rental. Retry reconciliation or ask the provider to resolve the request for '+r.name+'.');
      // Record a reconciled ID before deletion so a lost delete response can safely be retried.
      if(owned.length){r.ids=owned.map((instance:any)=>String(instance.machine_id));await this.save();}
      for(const instance of owned)await this.cli.run(['destroy',String(instance.machine_id),'--json','--yes'],180000);
      const remaining=await this.cli.run(['list','--json']);
      if(remaining.some((v:any)=>v.name===r.name||r.ids.includes(String(v.machine_id))))throw new Error('Cloud deletion has not completed. Its cleanup record was retained.');
      if(r.resources.key){
        const publicKey=(await readFile(this.identity+'.pub','utf8')).trim();
        const keys=await this.cli.run(['ssh-key','list','--json']);
        for(const key of keys.filter((k:any)=>k.key_name===r.resources.key&&k.ssh_key.trim()===publicKey))
          await this.cli.run(['ssh-key','remove',String(key.key_id),'--json','--yes']);
      }
    }else throw new Error('The saved provider is not supported. Its allocation record was retained.');
    await this.context.globalState.update(this.key,undefined);
    this.allocated=false;
  }
}
