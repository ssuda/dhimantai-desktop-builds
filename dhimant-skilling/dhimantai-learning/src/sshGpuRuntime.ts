import * as vscode from 'vscode';
import {ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,mkdir,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {NotebookCells,CellOptions} from './notebookCells';
import {SshConnection,SshCommandError} from './sshConnection';
import {SshHost,GpuLabRequirement,configuredSshHosts,parseSshHost,hostLabel,quoteSh,sshArgs} from './sshRuntimeConfig';

interface NodeRecord {
  machine:string; hostname:string; architecture:string; python:string; root:string; packages:string;
  user:string; sshPort:number; gpus:{uuid:string;name:string;memory:number}[]; addresses:{ip:string;interface:string}[];
}
export function runtimeResult(output:string):any {
  const lines=output.split(/\r?\n/).filter(line=>line.startsWith('DHIMANTAI_RESULT '));
  if(lines.length!==1)throw new Error('The machine did not return a valid setup result.');
  return JSON.parse(lines[0].slice(17));
}
export function validateGpuNodes(nodes:NodeRecord[],recipe:GpuLabRequirement) {
  if(nodes.length!==recipe.nodes||new Set(nodes.map(n=>n.machine)).size!==recipe.nodes)throw new Error('Enter a different physical machine for each cluster node.');
  if(new Set(nodes.map(n=>n.architecture)).size!==1||new Set(nodes.map(n=>n.packages)).size!==1)throw new Error('Cluster machines must use the same architecture and package versions.');
  if(nodes.some(n=>n.gpus.length!==recipe.gpusPerNode))throw new Error('A required GPU is missing.');
}

/** The SSH streams own the remote workers. Ready means a real inference probe succeeded. */
export class SshGpuRuntime implements vscode.Disposable {
  private connection:SshConnection;
  private cells?:NotebookCells;
  private supervisors:ChildProcessWithoutNullStreams[]=[];
  private abort=new AbortController();
  private ready=false;
  private disposed=false;
  private preparing=false;
  private saving=false;
  private terminals:vscode.Terminal[]=[];
  private source='';
  private config:any;
  private hosts:SshHost[]=[];
  private records:NodeRecord[]=[];
  private sudo=new Map<string,string>();
  get connected(){return this.ready&&!this.disposed;}
  get busy(){return this.preparing||this.saving||!!this.cells?.busy;}
  get label(){return `SSH · ${this.records.length} machine${this.records.length===1?'':'s'} · ${this.records.reduce((n,r)=>n+r.gpus.length,0)} GPUs`;}
  constructor(private media:string,private scope:string,private requirement:GpuLabRequirement,private state:vscode.Memento) {
    this.connection=new SshConnection(media);
  }
  async connect(supplied?:SshHost[]) {
    if(this.disposed)throw new Error('Select the runtime again to reconnect.');
    if(this.ready)return;
    this.preparing=true;
    try {
      if(!supplied&&this.requirement.layouts?.length) {
        const layout=await vscode.window.showQuickPick(this.requirement.layouts.map(value=>({...value,label:value.label})),{title:'Choose the lab layout',placeHolder:'Use two machines only for the cross-machine exercise'});
        if(!layout)throw new Error('GPU connection cancelled.');
        this.requirement={...this.requirement,nodes:layout.nodes,gpusPerNode:layout.gpusPerNode};
      }
      this.hosts=supplied??await this.chooseHosts();
      if(this.hosts.length!==this.requirement.nodes)throw new Error(`This lab requires ${this.requirement.nodes} machines.`);
      await this.connection.initialize();
      this.source=await readFile(join(this.media,'gpu_setup.py'),'utf8');
      const files:Record<string,string>={};
      for(const name of ['cells.py','sql_runtime.py','lab_scenarios.py','gpu_setup.py','cluster.py'])
        files[name]=(await readFile(join(this.media,name==='cluster.py'?'inference_cluster.py':name))).toString('base64');
      this.config={session:randomBytes(12).toString('hex'),workspace:createHash('sha256').update(this.scope).digest('hex').slice(0,24),recipe:this.requirement};
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Preparing GPU runtime',cancellable:true},async(progress,cancel)=>{
        const cancelled=cancel.onCancellationRequested(()=>this.abort.abort());
        try {
          // Sequential preparation keeps SSH trust and administrator prompts understandable.
          for(const host of this.hosts) {
            progress.report({message:hostLabel(host)+': checking the machine'});
            await this.system(host,message=>progress.report({message}));
            const result=runtimeResult(await this.exec(host,'prepare',{...this.config,files},3600000,message=>progress.report({message:hostLabel(host)+': '+message})));
            this.records.push(result);
          }
          validateGpuNodes(this.records,this.requirement);
          if(this.requirement.nodes>1) {
            const addresses=this.records.map(record=>(record.addresses.find(a=>a.interface==='eth1')??record.addresses[0])?.ip);
            if(addresses.some(a=>!a)||new Set(addresses).size!==addresses.length)throw new Error('Each machine needs a unique private address in the same VPC. Supply VM connections in one private network; JarvisLabs spot containers support the single-machine exercise.');
            this.config={...this.config,peers:addresses,head:addresses[0]};
            for(let i=0;i<this.hosts.length;i++) {
              progress.report({message:`Starting cluster machine ${i+1} of ${this.hosts.length}`});
              await this.supervise(this.hosts[i],{...this.config,...this.records[i],address:addresses[i]});
            }
          }
          progress.report({message:'Checking GPU execution and inference'});
          const verified=runtimeResult(await this.exec(this.hosts[0],'verify',this.headConfig(),1000000,message=>progress.report({message})));
          if(verified.nodes!==this.requirement.nodes||verified.gpus!==this.requirement.nodes*this.requirement.gpusPerNode)throw new Error('The runtime did not verify every required GPU.');
          if(this.abort.signal.aborted||this.disposed)throw new Error('GPU setup cancelled.');
          this.ready=true;
          this.cells=new NotebookCells(()=>({}),undefined,undefined,0,{target:this.label,start:async()=>{
            if(!this.ready||this.disposed)throw new Error('The GPU runtime disconnected. Select it to reconnect.');
            return this.connection.start(this.hosts[0],this.command('execute',this.headConfig()));
          }});
        }finally{cancelled.dispose();}
      });
      if(!supplied)await this.state.update('gpuSshHosts.'+createHash('sha256').update(this.scope.split('|').slice(0,2).join('|')).digest('hex'),this.hosts);
    }catch(error){this.dispose();throw error;}finally{this.preparing=false;}
  }
  private async chooseHosts() {
    const saved=this.state.get<SshHost[]>('gpuSshHosts.'+createHash('sha256').update(this.scope.split('|').slice(0,2).join('|')).digest('hex'),[]);
    const known=[...saved,...(await configuredSshHosts()).map(host=>({host}))];
    const selected:SshHost[]=[];
    for(let i=0;i<this.requirement.nodes;i++) {
      const title=`GPU runtime: machine ${i+1} of ${this.requirement.nodes}`;
      const choice=await vscode.window.showQuickPick([
        {label:'Add SSH connection…',host:undefined as SshHost|undefined},
        ...known.filter(h=>!selected.some(s=>hostLabel(s)===hostLabel(h))).map(host=>({label:hostLabel(host),host})),
      ],{title,placeHolder:`${this.requirement.gpusPerNode} NVIDIA GPU per machine · dhimantAI prepares the software`,ignoreFocusOut:true});
      if(!choice)throw new Error('GPU connection cancelled.');
      let host=choice.host;
      if(!host) {
        const input=await vscode.window.showInputBox({title,prompt:'Enter an SSH host or paste its SSH command',placeHolder:'ssh ubuntu@host',ignoreFocusOut:true,
          validateInput:value=>{try{parseSshHost(value);return undefined;}catch(error){return (error as Error).message;}}});
        if(!input)throw new Error('GPU connection cancelled.');host=parseSshHost(input);
      }
      if(selected.some(s=>hostLabel(s)===hostLabel(host!)))throw new Error('Enter a different machine for each node.');
      selected.push(host);
    }
    return selected;
  }
  private headConfig(){return {...this.config,...this.records[0],...(this.config.head?{address:this.config.head}:{})};}
  private command(action:string,config:any,stdin=false) {
    const payload=stdin?'-':Buffer.from(JSON.stringify(config)).toString('base64');
    const python=config.python??'python3';
    return `${quoteSh(python)} -u -c ${quoteSh('import base64; exec(compile(base64.b64decode('+JSON.stringify(Buffer.from(this.source).toString('base64'))+'),"gpu_setup.py","exec"))')} ${quoteSh(action)} ${quoteSh(payload)}`;
  }
  private exec(host:SshHost,action:string,config:any,timeout:number,progress?:(message:string)=>void) {
    return this.connection.exec(host,this.command(action,config,true),{input:Buffer.from(JSON.stringify(config)).toString('base64'),timeout,signal:this.abort.signal,progress});
  }
  private async elevated(host:SshHost,command:string) {
    if((await this.connection.exec(host,'id -u',{signal:this.abort.signal})).trim()==='0')return {command,input:''};
    const key=hostLabel(host);
    if(!this.sudo.has(key)) {
      try{await this.connection.exec(host,'sudo -n true',{signal:this.abort.signal});this.sudo.set(key,'');}
      catch {
        if(this.abort.signal.aborted)throw new Error('GPU setup cancelled.');
        const password=await vscode.window.showInputBox({title:'Prepare '+key,prompt:'Administrator password for installing the lab runtime',password:true,ignoreFocusOut:true});
        if(password===undefined)throw new Error('Administrator access is required to prepare this machine.');
        await this.connection.exec(host,"sudo -S -p '' -v",{input:password+'\n',signal:this.abort.signal});this.sudo.set(key,password);
      }
    }
    const password=this.sudo.get(key)!;
    return {command:password?"sudo -S -p '' "+command:'sudo -n '+command,input:password?password+'\n':''};
  }
  private async system(host:SshHost,progress:(message:string)=>void) {
    const probe='for tool in python3 ip iptables git gcc curl ffmpeg; do command -v "$tool" >/dev/null || exit 1; done; python3 -c "import venv" && nvidia-smi -L >/dev/null 2>&1';
    try{await this.connection.exec(host,probe,{signal:this.abort.signal});return;}
    catch(error){if(!(error instanceof SshCommandError)||error.code===255)throw error;}
    const script=await readFile(join(this.media,'gpu_system_setup.sh'),'utf8');
    const elevated=await this.elevated(host,(this.requirement.managedContainer?'env DHIMANTAI_GPU_CONTAINER=1 ':'')+'sh -c '+quoteSh(script));
    try{await this.connection.exec(host,elevated.command,{input:elevated.input,timeout:1800000,signal:this.abort.signal,progress});}
    catch(error){
      if(error instanceof SshCommandError&&error.code===194) {
        progress(hostLabel(host)+': restarting after NVIDIA driver installation');
        const restart=await this.elevated(host,'sh -c '+quoteSh('(sleep 2; /sbin/reboot) >/dev/null 2>&1 </dev/null &'));
        await this.connection.exec(host,restart.command,{input:restart.input,signal:this.abort.signal});
        const deadline=Date.now()+600000;
        for(let attempt=0;attempt<24&&Date.now()<deadline;attempt++) {
          if(this.abort.signal.aborted)throw new Error('GPU setup cancelled.');
          await new Promise(resolve=>setTimeout(resolve,15000));
          try{await this.connection.exec(host,probe,{timeout:30000,signal:this.abort.signal});return;}catch{/* bounded reboot reconnect */}
        }
        throw new Error(hostLabel(host)+': the GPU did not become ready after restarting. Check the machine driver and retry explicitly.');
      }
      throw error;
    }
  }
  private async supervise(host:SshHost,config:any) {
    const elevated=await this.elevated(host,this.command('firewall',config));
    const child=this.connection.start(host,elevated.command);this.supervisors.push(child);
    child.stdin.on('error',()=>{});if(elevated.input)child.stdin.write(elevated.input);
    await new Promise<void>((resolve,reject)=>{
      let errorText='',started=false,finished=false;
      const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);this.abort.signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
      const cancel=()=>{child.stdin.end();finish(new Error('GPU setup cancelled.'));};
      const timer=setTimeout(()=>{child.stdin.end();finish(new Error('Cluster startup timed out. Check private connectivity between the machines.'));},150000);
      this.abort.signal.addEventListener('abort',cancel,{once:true});
      child.stderr.on('data',chunk=>{errorText=(errorText+chunk).slice(-4000);});
      createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith('DHIMANTAI_READY ')){started=true;finish();}});
      child.once('error',()=>finish(new Error('Could not start the SSH cluster connection.')));
      child.once('close',()=>{
        finish(new Error(errorText||'The cluster connection stopped.'));
        if(started&&!this.disposed){this.dispose();void vscode.window.showErrorMessage('The GPU cluster disconnected. Select the runtime to reconnect.');}
      });
      if(this.abort.signal.aborted)cancel();
    });
  }
  run(language:string,source:string,stdin='',options:CellOptions={}) {
    if(!this.ready||!this.cells)throw new Error('Connect the selected GPU runtime before running.');
    if(this.saving)throw new Error('Wait for the lab workspace to finish saving.');
    return this.cells.run(language,source,stdin,options);
  }
  input(value:string|null){this.cells?.input(value);}
  restart(){this.cells?.restart();}
  async terminal() {
    if(!this.ready||this.saving)throw new Error('Connect the GPU runtime before opening its terminal.');
    const host=this.hosts.length===1?this.hosts[0]:(await vscode.window.showQuickPick(this.hosts.map((host,i)=>({label:'Machine '+(i+1),description:hostLabel(host),host})),{title:'Open GPU terminal'}))?.host;
    if(!host)return;
    const index=this.hosts.indexOf(host),record=this.records[index];
    const command=this.command('terminal',{...this.config,...record,address:this.config.peers?.[index]});
    const args=sshArgs(host,command);args[0]='-tt';
    const terminal=vscode.window.createTerminal({name:'GPU · '+hostLabel(host),shellPath:'ssh',shellArgs:args});
    this.terminals.push(terminal);terminal.show();
  }
  async saveWorkspace(directory:string) {
    if(!this.ready)throw new Error('The remote runtime is unavailable. Its last saved checkpoint must be preserved before deletion.');
    if(this.busy)throw new Error('Wait for the running cell before finishing the lab.');
    this.saving=true;
    for(const terminal of this.terminals)terminal.dispose();this.terminals=[];
    try {
    await mkdir(directory,{recursive:true,mode:0o700});
    const disk=await statfs(directory);const limit=Math.max(0,disk.bavail*disk.bsize-1024**3);
    if(limit<1024**2)throw new Error('Free local disk space before saving the remote workspace.');
    const folder=join(directory,'lab-'+Date.now());await mkdir(folder,{mode:0o700});
    for(let i=0;i<this.hosts.length;i++) {
      const remaining=await statfs(directory);
      await this.connection.download(this.hosts[i],this.command('archive',{...this.config,...this.records[i]}),join(folder,'machine-'+(i+1)+'.tar.gz'),Math.min(limit,remaining.bavail*remaining.bsize-1024**3));
    }
    return folder;
    }finally{this.saving=false;}
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.ready=false;this.abort.abort();this.cells?.restart();
    for(const terminal of this.terminals)terminal.dispose();this.terminals=[];
    for(const child of this.supervisors)child.stdin.end();this.connection.dispose();this.sudo.clear();}
}
