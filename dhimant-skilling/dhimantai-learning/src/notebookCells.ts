import {spawn, ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {programEnvironment, assertInCourseContainer, Toolchains, which} from './localRunner';
import type {CourseEngine} from './courseEngine';
import type {Execution} from './api';
import {RuntimePreparationError} from './runtimeErrors';

export type CellEvent = {kind:'stream'; stream:'stdout'|'stderr'; text:string}
  | {kind:'phase'; phase:'preparing'|'running'}
  | {kind:'input'; prompt:string} | {kind:'display'; data:Record<string,string>};
export interface CellOptions {
  argv?: string[]; files?: {name:string;content:string}[]; interactive?:boolean;
  setup?:string; database?:'lab'; signal?:AbortSignal; event?:(event:CellEvent)=>void;
}
export interface CellTransport {target:string; start:()=>Promise<ChildProcessWithoutNullStreams>}

/** A notebook owns one session and one folder. Only explicit Run executes learner content. */
export class NotebookCells {
  get busy() { return !!(this.pending || this.launching || this.starting); }
  get live() { return !!this.child && !this.child.killed && this.child.exitCode === null; }
  private session = 0;
  get sessionId() { return this.session; }
  private child?:ChildProcessWithoutNullStreams;
  private folder?:string;
  private generation=0;
  private engineKey?:string;
  private target?:string;
  private remote=false;
  private launching=false;
  private starting?:Promise<ChildProcessWithoutNullStreams>;
  private processes = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private pending?:{id:string; event?:(event:CellEvent)=>void; finish:(execution:Execution)=>void};
  constructor(private tools:()=>Toolchains, private engine?: (language:string)=>Promise<CourseEngine|undefined>,
    private workspace?:(engine?:CourseEngine)=>Promise<string>, private timeout=0, private transport?:CellTransport) {}
  private async start(language:string) {
    const requestedGeneration=this.generation;
    const engine=await this.engine?.(language);
    if(requestedGeneration!==this.generation)throw new Error('Notebook runtime restarted. Run again.');
    if (!engine && !this.transport) assertInCourseContainer();
    const key=this.transport?'transport':engine?engine.bin+'|'+engine.name:'local';
    this.target=this.transport?.target??engine?.target;
    if(this.child && key===this.engineKey)return this.child;
    if(this.child)this.restart();
    this.engineKey=key;this.remote=!!engine||!!this.transport;
    if (this.starting) return this.starting;
    const generation=this.generation;
    this.starting=(async()=>{
      if(this.transport){
        const child=await this.transport.start();
        if(generation!==this.generation){this.track(child);child.stdin.end();throw new Error('Notebook runtime restarted. Run again.');}
        return this.attach(child);
      }
      const python=engine ? undefined : this.tools().python ?? which(process.platform==='win32'?'python':'python3') ?? which('python');
      if (!engine && !python) throw new Error('Set up the course runtime or install Python 3 to run notebook cells.');
      const folder=this.folder ?? (this.workspace ? await this.workspace(engine) : engine
        ? await mkdtemp(join(engine.root,'.notebook-')) : await mkdtemp(join(tmpdir(),'dhimantai-notebook-')));
      await mkdir(folder,{recursive:true}); this.folder=folder;
      // Ship runner fixes with the client, including for already published course images.
      const helper=join(folder,'.dhimantai-runtime');
      await mkdir(helper,{recursive:true});
      const script=join(helper,'cells.py');
      await Promise.all(['cells.py', 'sql_runtime.py', 'lab_scenarios.py'].map(async file =>
        writeFile(join(helper,file),await readFile(resolve(__dirname,'../../media/course',file)))));
      if (generation!==this.generation) throw new Error('Notebook runtime restarted. Run again.');
      const child=spawn(engine?.bin ?? python!,engine
        ? engine.execArgs(folder,'python',['-u',engine.path(script)])
        : ['-u',script],{cwd:folder,env:programEnvironment(),windowsHide:true});
      return this.attach(child);
    })();
    try{return await this.starting;}finally{this.starting=undefined;}
  }
  private track(child:ChildProcessWithoutNullStreams) {
    // `exit` (or an I/O error) does not mean the process has released its stdio/cwd.
    this.processes.set(child,new Promise(resolve=>child.once('close',()=>{
      this.processes.delete(child);resolve();
    })));
    // A transport can finish launching after a restart, before attach installs diagnostics.
    child.on('error',()=>{});
  }
  private attach(child:ChildProcessWithoutNullStreams) {
      this.session++;
      this.track(child);
      this.child=child;
      let diagnostic='';
      child.stderr.on('data',b=>{diagnostic=(diagnostic+b.toString()).slice(-3000);});
      const stopped=(message:string)=>{
        if(this.child!==child)return;
        this.child=undefined;
        this.pending?.finish({status:'exited',exit_code:1,stdout:'',stderr:message,command:'Notebook cell',duration_seconds:0,truncated:false});
      };
      child.on('error',e=>stopped(e.message));child.on('close',()=>stopped(diagnostic || 'Runtime stopped. Run the required cells again.'));
      child.stdin.on('error',e=>stopped(e.message));
      createInterface({input:child.stdout}).on('line',line=>{
        try {
          const message=JSON.parse(line), pending=this.pending;
          if(!pending || pending.id!==message.id)return;
          if(message.kind==='done')pending.finish(message.execution);
          else if(['stream','input','display'].includes(message.kind))pending.event?.(message);
        } catch {stopped('Invalid notebook runtime response. Restart the runtime to retry.');}
      });
      return child;
  }
  async run(language:string,source:string,stdin='',options:CellOptions={}):Promise<Execution>{
    if(this.pending || this.launching || this.starting)throw new Error('A notebook cell is already running.');
    if(options.signal?.aborted)throw new Error('Run cancelled.');
    this.launching=true;
    options.event?.({kind:'phase',phase:'preparing'});
    let child:ChildProcessWithoutNullStreams;
    try{child=await this.start(language);}
    catch(error){throw new RuntimePreparationError(error);}
    finally{this.launching=false;}
    if(options.signal?.aborted || child!==this.child)throw new Error('Run cancelled.');
    return new Promise(resolve=>{
      const id=randomUUID();
      const abort=()=>this.stop();
      const timer=this.timeout ? setTimeout(()=>{
        this.stop();
        this.pending?.finish({status:'timeout',exit_code:null,stdout:'',stderr:'Notebook cell timed out. Run the required cells again.',command:language,duration_seconds:this.timeout/1000,truncated:true});
        this.restart();
      },this.timeout):undefined;
      this.pending={id,event:options.event,finish:execution=>{
        clearTimeout(timer);options.signal?.removeEventListener('abort',abort);this.pending=undefined;
        resolve({...execution,...(this.target?{runtime_target:this.target}:{})});
      }};
      options.signal?.addEventListener('abort',abort,{once:true});
      const {signal,event,...data}=options;
      child.stdin.write(JSON.stringify({action:'run',id,language,source,stdin,tools:this.remote?{}:this.tools(),...data})+'\n');
      event?.({kind:'phase',phase:'running'});
    });
  }
  input(value:string|null){if(this.pending)this.child?.stdin.write(JSON.stringify({action:'input',id:this.pending.id,value})+'\n');}
  stop(){this.child?.stdin.write(JSON.stringify({action:'stop'})+'\n');}
  restart(){
    this.generation++; this.folder=undefined;
    this.pending?.finish({status:'cancelled',exit_code:null,stdout:'',stderr:'Notebook runtime restarted. Run the required cells again.',command:'Notebook cell',duration_seconds:0,truncated:false});
    this.child=undefined;
    for(const child of this.processes.keys())
      if(!child.stdin.destroyed && !child.stdin.writableEnded)child.stdin.end(JSON.stringify({action:'close'})+'\n');
    // The bridge handles close inside the container as well as locally, and cleans up owned databases.
  }
  /** Disposable checks must await process closure before removing their working directory. */
  async close(timeout=5000):Promise<void> {
    this.restart();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([
        (async()=>{
          // A cancelled launch can still be finishing transport setup; track its closure too.
          await this.starting?.catch(()=>undefined);
          await Promise.all(this.processes.values());
        })(),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(
          'The notebook runtime did not close in time. Its temporary files were kept. '
          + 'Use Notebook options (⋯) → Restart runtime and run again. If it remains busy, '
          + 'close course terminals and reopen the desktop application.')),timeout);}),
      ]);
    } finally {clearTimeout(timer);}
  }
  get directory(){return this.folder;}
}
