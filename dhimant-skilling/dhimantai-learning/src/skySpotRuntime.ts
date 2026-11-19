import * as vscode from 'vscode';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {VM_CLOUDS, VmCloud} from './cloudCli';
import {GpuLabRequirement, parseSshHost} from './sshRuntimeConfig';

interface SpotQuote {
  type:string; gpu:string; region:string; zone:string; price:number; nodes:number; gpusPerNode:number;
}
interface SpotPlan {name:string; owner:string[]; existing:boolean; quote:SpotQuote}

export class SkySpotRuntime {
  private plan?:SpotPlan;
  private lease=randomUUID();
  private scope:string;
  private attempted=false;
  private expiresAt=0;
  constructor(private script:string, private provider:VmCloud, scope:string) {
    this.scope=createHash('sha256').update(scope).digest('hex');
  }
  get label(){return VM_CLOUDS[this.provider].label+' · Spot';}
  get remainingMs(){return Math.max(1,this.expiresAt-Date.now()-5*60000);}

  private launcher(mode:string) {
    const args=[this.script,mode,this.provider];
    if(process.platform==='win32')return {bin:'wsl.exe',args:['--exec','sh','-c',
      'script=$(wslpath -u "$1") && shift && exec python3 -I "$script" "$@"','dhimantai',...args]};
    return {bin:'python3',args:['-I',...args]};
  }

  private call<T>(action:string,fields:Record<string,unknown>={},timeout=120_000):Promise<T> {
    // SkyPilot runs in WSL on Windows and writes the Windows OpenSSH aliases itself.
    const wsl=process.platform==='win32';
    const {bin,args}=this.launcher(action==='account'?'--account':'--cloud');
    const payload={action,provider:this.provider,scope:this.scope,lease:this.lease,name:this.plan?.name,...fields};
    return new Promise((resolve,reject)=>{
      const child=spawn(bin,args,{windowsHide:true,shell:false});
      let stdout='',stderr='',settled=false;
      const fail=(error:Error)=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}};
      const timer=setTimeout(()=>{child.kill();fail(new Error('The cloud operation timed out. Select the same provider to reconcile its saved allocation.'));},timeout);
      child.stdout.on('data',part=>{stdout=(stdout+part).slice(-65536);});
      child.stderr.on('data',part=>{stderr=(stderr+part).slice(-8192);});
      child.on('error',()=>fail(new Error(wsl?'Install WSL and configure SkyPilot in its default Linux distribution.':'Install Python 3 and configure SkyPilot for your cloud account.')));
      child.on('close',code=>{
        if(settled)return;
        const prefix=code===0?'DHIMANTAI_RESULT ':'DHIMANTAI_ERROR ';
        const line=(code===0?stdout:stderr).split(/\r?\n/).filter(row=>row.startsWith(prefix)).at(-1)??'';
        try {
          if(line.startsWith('DHIMANTAI_ERROR '))throw new Error(String(JSON.parse(line.slice(16))));
          if(code!==0||!line.startsWith('DHIMANTAI_RESULT '))throw new Error('SkyPilot did not complete the request. '+stderr.trim().slice(-600));
          const result=JSON.parse(line.slice(17));
          clearTimeout(timer);settled=true;resolve(result);
        }catch(error){fail(error as Error);}
      });
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
    });
  }

  private async prepareAccount() {
    const name={aws:'AWS CLI v2',azure:'Azure CLI',gcp:'Google Cloud CLI (gcloud)'}[this.provider];
    let state=await this.call<string>('account');
    const steps=[
      {step:'install',action:'Install tools',message:'Install '+name+' and SkyPilot for this runtime?',title:'Installing '+name+' and SkyPilot'},
      {step:'login',action:'Sign in',message:'Sign in with your student cloud account using '+name+'.',title:'Complete '+name+' sign-in in the terminal'},
    ];
    if(this.provider==='gcp')steps.push({step:'project',action:'Choose project',
      message:'Choose the existing Google Cloud project for this lab.',title:'Select your Google Cloud project in the terminal'});
    for(const {step,action,message,title} of steps) {
      if(state!==step)continue;
      const detail=step==='login'&&this.provider==='gcp'?'gcloud will also set your local Application Default Credentials for SkyPilot.':undefined;
      const choice=await vscode.window.showInformationMessage(message,{modal:true,detail},action);
      if(choice!==action)throw new Error('Cloud connection cancelled.');
      const launch=this.launcher('--'+step);
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
        title,cancellable:true},
      (_,token)=>new Promise<void>((resolve,reject)=>{
        const terminal=vscode.window.createTerminal({name:name+' · '+action,shellPath:launch.bin,shellArgs:launch.args});
        const close=vscode.window.onDidCloseTerminal(t=>{
          if(t!==terminal)return;
          close.dispose();cancel.dispose();
          if(token.isCancellationRequested)reject(new Error('Cloud connection cancelled.'));
          else if(t.exitStatus?.code!==0)reject(new Error(name+' '+step+' did not finish. Check the terminal output and select the runtime to retry.'));
          else resolve();
        });
        const cancel=token.onCancellationRequested(()=>terminal.dispose());
        terminal.show();
      }));
      state=await this.call<string>('account');
    }
    if(state!=='ready')throw new Error(name+' could not verify the account. Select the runtime to retry.');
  }

  async connect(recipe:GpuLabRequirement) {
    const cloud=VM_CLOUDS[this.provider];
    let plan:SpotPlan|null;
    try {
      await this.prepareAccount();
      plan=await this.call<SpotPlan|null>('plan',{recipe});
      if(!plan) {
        const region=await vscode.window.showInputBox({title:cloud.label+' · Spot GPU region',value:cloud.region,
          prompt:'Enter the region where you want to rent the lab machines.',ignoreFocusOut:true,
          validateInput:value=>/^[a-z][a-z0-9-]{1,40}$/.test(value.trim())?undefined:'Enter a provider region identifier.'});
        if(!region)throw new Error('Cloud connection cancelled.');
        plan=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Checking '+cloud.label+' spot GPU prices'},
          ()=>this.call<SpotPlan>('plan',{region:region.trim(),recipe},300_000));
      }
    }catch(error){
      if((error as Error).message!=='Cloud connection cancelled.') {
        const action=await vscode.window.showErrorMessage((error as Error).message,'Cloud setup guide');
        if(action)await vscode.env.openExternal(vscode.Uri.parse(cloud.setup));
      }
      throw error;
    }
    const q=plan.quote;
    const details=[q.nodes+' × '+q.type+' in '+(q.zone||q.region)+' · '+q.gpusPerNode+' × '+q.gpu+' per VM · 100 GB disk per VM.',
      'Cloud account '+plan.owner.join(' · ')+' · Cluster '+plan.name+'.',
      (plan.existing?'Reviewed spot estimate of USD ':'Estimated spot compute of USD ')+(q.price*q.nodes).toFixed(3)+'/hour for all nodes. Storage, networking and tax are extra. Spot capacity and rates can change.',
      'Keep dhimantAI open for the three-hour lab limit. Finish lab saves your files and releases the VMs. If saving fails, the VMs can continue billing until you recover your work and release them.'].join('\n');
    const accept=plan.existing?'Reconnect to lab':'Start spot runtime';
    let choice=await vscode.window.showInformationMessage(details,{modal:true},accept,'View pricing');
    if(choice==='View pricing'){
      await vscode.env.openExternal(vscode.Uri.parse(cloud.pricing));
      choice=await vscode.window.showInformationMessage(details,{modal:true},accept);
    }
    if(choice!==accept)throw new Error('Cloud allocation cancelled.');
    this.plan=plan;this.attempted=true;
    const ready=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:cloud.label+' · Connecting spot GPUs'},
      ()=>this.call<{hosts:string[];expiresAt:number}>('connect',{plan},1_800_000));
    this.expiresAt=ready.expiresAt;
    return {hosts:ready.hosts.map(host=>({...parseSshHost(host),cloudVm:true})),requirement:{...recipe,nodes:q.nodes,gpusPerNode:q.gpusPerNode,managedContainer:false}};
  }
  async savedArtifact(file:string){await this.call('saved',{file});}
  async pause(){await this.call('pause',{},300_000);}
  async teardown(){if(this.attempted)await this.call('release',{},600_000);}
  async failedSetup(){
    if(!this.attempted)return;
    if(this.plan?.existing)throw new Error('The saved cluster '+this.plan.name+' is retained. Check its billing state in SkyPilot.');
    await this.teardown();
  }
}
