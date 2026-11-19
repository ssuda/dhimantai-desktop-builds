import * as vscode from 'vscode';
import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';
import {createServer,Server} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWriteStream} from 'node:fs';
import {SshHost,hostLabel,quoteSh,sshArgs} from './sshRuntimeConfig';

export class SshCommandError extends Error {constructor(message:string,readonly code:number|null){super(message);}}

/** System OpenSSH owns keys, agent, config, jump hosts and host-key verification. */
export class SshConnection implements vscode.Disposable {
  private children=new Set<ChildProcessWithoutNullStreams>();
  private server?:Server;
  private folder='';
  private env:NodeJS.ProcessEnv={};
  private prompts=Promise.resolve();
  private passwords=new Map<string,string>();
  private requests=new Map<string,number>();
  private cancelled=new vscode.CancellationTokenSource();
  private disposed=false;
  constructor(private readonly media:string) {}
  async initialize() {
    this.folder=await mkdtemp(join(tmpdir(),'dhimantai-ssh-'));
    const nonce=randomBytes(32).toString('hex');
    this.server=createServer((request,response)=>{
      if(request.method!=='POST'||request.url!=='/'+nonce){response.writeHead(403).end();return;}
      let body='';request.setEncoding('utf8');
      request.on('data',part=>{body+=part;if(body.length>8000)request.destroy();});
      request.on('end',()=>{
        this.prompts=this.prompts.catch(()=>{}).then(async()=>{
          try {
            if(this.disposed){response.writeHead(410).end();return;}
            const {prompt,hint,session}=JSON.parse(body);
            if(typeof prompt!=='string'||prompt.length>6000||!this.attempts.has(session))throw new Error('Invalid SSH prompt');
            const requestKey=session+'|'+prompt;
            const count=(this.requests.get(requestKey)??0)+1;this.requests.set(requestKey,count);
            if(count>3){response.writeHead(403).end();return;}
            let answer:string|undefined;
            if(hint==='confirm'||/continue connecting.*fingerprint|yes\/no/i.test(prompt)) {
              answer=await vscode.window.showWarningMessage(prompt,{modal:true},'Connect')==='Connect'?'yes':undefined;
            } else {
              answer=count===1?this.passwords.get(prompt):undefined;
              answer??=await vscode.window.showInputBox({title:'SSH authentication',prompt,password:true,ignoreFocusOut:true},this.cancelled.token);
              if(answer!==undefined)this.passwords.set(prompt,answer);
            }
            if(answer===undefined||this.disposed)response.writeHead(403).end();else response.end(answer);
          } catch {response.writeHead(400).end();}
        });
      });
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});
    const address=this.server.address();if(!address||typeof address==='string')throw new Error('Could not open SSH authentication.');
    const launcher=join(this.folder,process.platform==='win32'?'askpass.cmd':'askpass.sh');
    await writeFile(launcher,process.platform==='win32'
      ? '@echo off\r\n"'+process.execPath+'" "'+join(this.media,'ssh-askpass.cjs')+'" %*\r\n'
      : '#!/bin/sh\nexec '+quoteSh(process.execPath)+' '+quoteSh(join(this.media,'ssh-askpass.cjs'))+' "$@"\n',{mode:0o700});
    this.env={...process.env,ELECTRON_RUN_AS_NODE:'1',SSH_ASKPASS:launcher,SSH_ASKPASS_REQUIRE:'force',DISPLAY:process.env.DISPLAY||'dhimantai:0',DHIMANTAI_ASKPASS_URL:`http://127.0.0.1:${address.port}/${nonce}`};
  }
  private attempts=new Set<string>();
  start(host:SshHost,command:string) {
    if(this.disposed||!this.server)throw new Error('The SSH connection is closed. Select the runtime to reconnect.');
    const attempt=randomBytes(16).toString('hex');this.attempts.add(attempt);
    const child=spawn('ssh',sshArgs(host,command),{env:{...this.env,DHIMANTAI_SSH_ATTEMPT:attempt},windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.children.add(child);child.once('close',()=>{this.children.delete(child);this.attempts.delete(attempt);
      for(const key of this.requests.keys())if(key.startsWith(attempt+'|'))this.requests.delete(key);});
    return child;
  }
  async exec(host:SshHost,command:string,options:{input?:string;timeout?:number;signal?:AbortSignal;progress?:(message:string)=>void}={}) {
    if(options.signal?.aborted)throw new Error('GPU setup cancelled.');
    const child=this.start(host,command);
    return new Promise<string>((resolve,reject)=>{
      let out='',err='',finished=false;
      const end=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(out);};
      const abort=()=>{child.kill();end(new Error('GPU setup cancelled.'));};
      const timer=setTimeout(()=>{child.kill();end(new Error(hostLabel(host)+': setup timed out. Retry explicitly.'));},options.timeout??60000);
      options.signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{out+=chunk.toString();if(out.length>2_000_000){child.kill();end(new Error('Unexpected SSH response size.'));}});
      child.stderr.on('data',chunk=>{
        err=(err+chunk.toString()).slice(-4000);
        for(const line of chunk.toString().split('\n'))if(line.startsWith('DHIMANTAI_PROGRESS '))options.progress?.(line.slice(19));
      });
      child.once('error',()=>end(new Error('Could not start OpenSSH. Install the system SSH client and retry.')));
      child.once('close',code=>end(code===0?undefined:new SshCommandError(hostLabel(host)+': '+(err.trim()||'SSH command failed.'),code)));
      child.stdin.on('error',()=>{});child.stdin.end(options.input??'');
    });
  }
  async download(host:SshHost,command:string,file:string,limit:number) {
    const child=this.start(host,command),stream=createWriteStream(file,{flags:'wx',mode:0o600,flush:true});
    try {
      await new Promise<void>((resolve,reject)=>{
        let bytes=0,err='',finished=false,code:number|null|undefined,flushed=false;
        const finish=(error?:Error)=>{if(finished)return;if(!error&&(code!==0||!flushed))return;finished=true;clearTimeout(timer);error?reject(error):resolve();};
        const timer=setTimeout(()=>{child.kill();stream.destroy();finish(new Error('Saving the remote workspace timed out.'));},900000);
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){child.kill();stream.destroy();finish(new Error('There is not enough local disk space to save this workspace.'));}});
        child.stderr.on('data',chunk=>{err=(err+chunk).slice(-3000);});
        child.stdout.pipe(stream);child.stdin.end();
        stream.once('close',()=>{flushed=true;finish();});stream.once('error',error=>{child.kill();finish(error);});
        child.once('error',error=>{stream.destroy();finish(error);});
        child.once('close',value=>{code=value;if(value!==0){stream.destroy();finish(new Error(err||'Could not save remote lab files.'));}else finish();});
      });
    }catch(error){await rm(file,{force:true});throw error;}
  }
  dispose() {
    this.disposed=true;this.cancelled.cancel();this.cancelled.dispose();this.passwords.clear();this.requests.clear();
    for(const child of this.children){child.stdin.end();const timer=setTimeout(()=>child.kill(),15000);timer.unref();child.once('close',()=>clearTimeout(timer));}this.children.clear();
    this.server?.closeAllConnections();this.server?.close();
    if(this.folder)void rm(this.folder,{recursive:true,force:true});
  }
}
