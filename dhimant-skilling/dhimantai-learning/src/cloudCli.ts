import * as vscode from 'vscode';
import {spawn} from 'node:child_process';
import {which} from './localRunner';

export const CLOUD_CLIS={
  jarvis:{label:'JarvisLabs',bin:'jl',login:['setup'],identity:['status','--json'],install:'https://docs.jarvislabs.ai/cli',pricing:'https://jarvislabs.ai/pricing'},
} as const;
export type CliProvider=keyof typeof CLOUD_CLIS;

export const VM_CLOUDS={
  aws:{label:'AWS EC2',region:'ap-south-1',pricing:'https://aws.amazon.com/ec2/spot/pricing/',setup:'https://docs.skypilot.co/en/latest/cloud-setup/cloud-permissions/aws.html'},
  gcp:{label:'Google Compute Engine',region:'asia-south1',pricing:'https://cloud.google.com/spot-vms/pricing',setup:'https://docs.skypilot.co/en/latest/cloud-setup/cloud-permissions/gcp.html'},
  azure:{label:'Microsoft Azure',region:'eastus',pricing:'https://azure.microsoft.com/pricing/spot/',setup:'https://docs.skypilot.ai/en/latest/getting-started/installation.html#azure'},
} as const;
export type VmCloud=keyof typeof VM_CLOUDS;
export type CloudProvider=CliProvider|VmCloud;
export const AVAILABLE_CLOUD_PROVIDERS:CloudProvider[]=['jarvis','aws','gcp','azure'];

/** All cloud operations use installed provider CLIs; credentials stay in their local stores. */
export class CloudCli {
  readonly bin:string;
  constructor(readonly provider:CliProvider,private readonly env:NodeJS.ProcessEnv={...process.env,CI:'1',JL_NO_UPDATE_CHECK:'1'}) {
    this.bin=which(CLOUD_CLIS[provider].bin)??CLOUD_CLIS[provider].bin;
  }
  private launch(args:readonly string[]) {
    if(process.platform==='win32'&&/\.cmd$/i.test(this.bin))
      throw new Error('Install the official JarvisLabs CLI executable. Command wrappers are not supported.');
    return {bin:this.bin,args:[...args]};
  }
  async run(args:readonly string[],timeout=60000):Promise<any> {
    const launch=this.launch(args);
    return this.execute(launch,timeout);
  }
  private execute(launch:{bin:string;args:string[]},timeout:number):Promise<any> {
    return new Promise((resolve,reject)=>{
      const child=spawn(launch.bin,launch.args,{env:this.env,windowsHide:true,shell:false});
      let out='',err='',ended=false;
      const finish=(error?:Error)=>{if(ended)return;ended=true;clearTimeout(timer);if(error){reject(error);return;}
        try{resolve(out.trim()?JSON.parse(out):undefined);}catch{reject(new Error(CLOUD_CLIS[this.provider].label+' returned an unreadable CLI response.'));}};
      const timer=setTimeout(()=>{child.kill();finish(new Error('The cloud command timed out. Its state will be checked before another create attempt.'));},timeout);
      child.stdout.on('data',chunk=>{out+=chunk;if(out.length>4000000){child.kill();finish(new Error('Cloud response too large.'));}});
      child.stderr.on('data',chunk=>{err=(err+chunk).slice(-5000);});
      child.once('error',()=>finish(new Error(`Install or update the ${CLOUD_CLIS[this.provider].label} CLI to connect this cloud.`)));
      child.once('close',code=>finish(code===0?undefined:new Error(err.trim()||'Cloud command failed.')));
      child.stdin.on('error',()=>{});child.stdin.end();
    });
  }
  private async identity() {
    const result=await this.run(CLOUD_CLIS[this.provider].identity,20000);
    const id=result?.user?.user_id;
    if(typeof id!=='string'||!id)throw new Error('Connect your cloud account.');
    return id;
  }
  async authenticate() {
    try{return await this.identity();}catch {/* The provider CLI owns interactive authentication. */}
    if(!which(CLOUD_CLIS[this.provider].bin)) {
      await vscode.env.openExternal(vscode.Uri.parse(CLOUD_CLIS[this.provider].install));
      throw new Error(`Install the ${CLOUD_CLIS[this.provider].label} CLI from the opened instructions, then choose this runtime again.`);
    }
    if(this.provider==='jarvis')await vscode.env.openExternal(vscode.Uri.parse('https://jarvislabs.ai/settings/api-keys'));
    const launch=this.launch(CLOUD_CLIS[this.provider].login);
    const terminal=vscode.window.createTerminal({name:CLOUD_CLIS[this.provider].label+' · Connect account',shellPath:launch.bin,shellArgs:launch.args,env:{...this.env,CI:null}});
    terminal.show();
    let closed=false;
    const close=vscode.window.onDidCloseTerminal(t=>{if(t===terminal)closed=true;});
    try {
      return await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Complete cloud sign-in in the terminal',cancellable:true},async(_,token)=>{
        const deadline=Date.now()+600000;
        while(Date.now()<deadline&&!closed&&!token.isCancellationRequested) {
          await new Promise(resolve=>setTimeout(resolve,3000));
          try{return await this.identity();}catch{/* Bounded read-only polling; never repeat login or create. */}
        }
        throw new Error('Cloud sign-in was cancelled or timed out. Select the runtime to retry.');
      });
    }finally{close.dispose();terminal.dispose();}
  }
  async requireAccount(expected:string) {if(await this.identity()!==expected)throw new Error('The CLI is connected to a different cloud account. Sign in to the account that owns this runtime.');}
}
