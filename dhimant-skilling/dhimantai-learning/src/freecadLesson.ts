import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {copyFile,link,lstat,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureFreeCAD} from './freecadInstaller';
import {presentFreeCAD} from './freecadFocus';
import {CadAction} from './freecadCourse';

export interface CadState {status:string;radius?:number;validSolid?:boolean;selected?:string[];jpeg?:string;pid?:number;title?:string}
type Action=CadAction|'resume'|'state';

async function privateKey(folder:string) {
  const file=join(folder,'.connection-key');
  try {return await readFile(file,'utf8');} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const key=randomBytes(32).toString('hex'), staged=join(folder,'.key-'+key.slice(0,12));
  await writeFile(staged,key,{flag:'wx',mode:0o600});
  try {await link(staged,file);} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  finally {await rm(staged,{force:true});}
  return readFile(file,'utf8');
}

function request(pipe:string,key:string,action:Action,signal:AbortSignal):Promise<CadState> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const socket=createConnection(process.platform==='win32'?'\\\\.\\pipe\\'+pipe:pipe);
    // Opening the document also loads the CAD libraries on first use.
    const timeout=action==='resume'?45000:4000;
    const deadline=Date.now()+timeout;
    const timer=setTimeout(()=>socket.destroy(new Error('FreeCAD did not respond in time.')),timeout);
    const abort=()=>socket.destroy(new Error('Lesson closed.'));
    signal.addEventListener('abort',abort,{once:true});
    socket.setEncoding('utf8');
    socket.once('connect',()=>socket.write(JSON.stringify({action,key,expires:deadline})+'\n'));
    let body='';
    socket.on('data',chunk=>{
      body+=chunk;
      if(body.length>14500){socket.destroy(new Error('Oversized FreeCAD response.'));return;}
      if(body.includes('\n')){
        try {const state=JSON.parse(body); if(typeof state.status!=='string')throw Error(); resolve(state);}
        catch {reject(new Error('Invalid FreeCAD response.'));}
        socket.destroy();
      }
    });
    socket.on('error',reject);
    socket.once('close',()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('FreeCAD disconnected.'));});
  });
}
const launches=new Map<string,Promise<void>>();
export async function openFreeCAD(root:string,assets:string,accountScope:string,signal:AbortSignal,progress:(text:string)=>void) {
  const scope=createHash('sha256').update(accountScope).digest('hex').slice(0,32);
  // Linux app sandboxes can open this ordinary user folder. Include the desktop
  // profile in the identity so independent installations keep separate work.
  const linuxRoot=join(homedir(),'dhimantAI','FreeCAD');
  const folder=process.platform==='linux'
    ? join(linuxRoot,createHash('sha256').update(root+'\0'+scope).digest('hex').slice(0,32))
    : join(root,'freecad-lessons',scope);
  await mkdir(folder,{recursive:true,mode:0o700});
  const key=await privateKey(folder);
  const name='cad-'+createHash('sha256').update(key).digest('hex').slice(0,24);
  // sockaddr_un has a short path limit on macOS. Scope the socket to a
  // private, local-user directory independent of the extension storage path.
  const socketRoot=process.platform==='linux'?join(linuxRoot,'connections'):join('/tmp','dhimant-'+(process.getuid?.()??'cad'));
  const pipe=process.platform==='win32'?name:join(socketRoot,name);
  if(process.platform!=='win32') {
    await mkdir(socketRoot,{recursive:true,mode:0o700});
    const dir=await lstat(socketRoot);
    if(!dir.isDirectory()||dir.uid!==process.getuid!()||(dir.mode&0o077)!==0)throw new Error('The FreeCAD connection directory is not private.');
  }
  const call=(action:Action)=>request(pipe,key,action,signal);
  async function launch(){
    try {await call('resume');return;} catch(e) {
      const code=(e as NodeJS.ErrnoException).code;
      if(code!=='ENOENT' && code!=='ECONNREFUSED')throw e;
      if(code==='ECONNREFUSED' && process.platform!=='win32')await rm(pipe,{force:true});
    }
    const app=await ensureFreeCAD(join(root,'applications'),progress);
    signal.throwIfAborted();
    const file=join(folder,'Mounting-plate.FCStd');
    const staged=join(folder,'.starter-'+randomBytes(8).toString('hex'));
    await copyFile(join(assets,'Mounting-plate.FCStd'),staged);
    try {await link(staged,file);} catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    } finally {await rm(staged,{force:true});}
    let macro=join(assets,'Instructor.FCMacro');
    if(process.platform==='linux') {
      // A sandboxed FreeCAD may have no access to the desktop installation.
      // Launch this exact packaged macro from a directory both apps can open.
      const digest=createHash('sha256').update(await readFile(macro)).digest('hex');
      const target=join(folder,'Instructor-'+digest.slice(0,16)+'.FCMacro');
      const temp=staged+'.FCMacro';
      await copyFile(macro,temp);
      try {await rename(temp,target);} finally {await rm(temp,{force:true});}
      macro=target;
    }
    const args=app.flatpak?['run','--filesystem='+folder,'--filesystem='+socketRoot,app.flatpak,macro]:[macro];
    progress('Opening the mounting plate in FreeCAD…');
    const child=spawn(app.command,args,{detached:true,stdio:'ignore',
      env:{...process.env,DHIMANT_CAD_KEY:key,DHIMANT_CAD_PIPE:pipe,DHIMANT_CAD_EXERCISE:file}});
    let failure:Error|undefined;
    child.on('error',e=>{failure=e;});
    child.on('exit',code=>{if(code)failure=new Error('FreeCAD exited during startup (code '+code+').');});
    child.unref();
    for(let i=0;i<55;i++){
      await delay(Math.min(1500,200+i*100),undefined,{signal});
      if(failure)throw failure;
      // The GUI event loop is running now, including its first-run Start tab.
      try {await call('resume');return;} catch(e) {
        if(!['ENOENT','ECONNREFUSED'].includes((e as NodeJS.ErrnoException).code??''))throw e;
      }
    }
    throw new Error('FreeCAD did not open the exercise. Check its startup dialog and retry the lesson.');
  }
  // A quick rejoin can supersede a pending startup. Never inherit its abort.
  const prior=launches.get(pipe);
  if(prior)await prior.catch(()=>{});
  signal.throwIfAborted();
  const job=launch();
  launches.set(pipe,job);
  try{await job;}finally{if(launches.get(pipe)===job)launches.delete(pipe);}
  let cuaAvailable=true;
  return {call:async(action:CadAction|'state')=>{
    if(cuaAvailable && action!=='state' && action!=='observe'){
      const target=await call('state');
      if(target.status!=='ready')return target;
      if(target.pid && target.title)cuaAvailable=await presentFreeCAD({pid:target.pid,title:target.title},signal);
    }
    const {pid:_pid,title:_title,...result}=await call(action);
    return result;
  }};
}
