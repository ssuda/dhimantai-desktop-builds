import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, chmod, realpath, mkdir } from 'node:fs/promises';
import { join, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { CourseEngine } from './courseEngine';
import { courseDebug, courseDebugPort } from './courseDebug';
import { nativePlan } from './nativeRun';
import { programEnvironment, Toolchains, typescript } from './localRunner';
import { entryFile } from './learning';
import { run } from './podman';
import { CodeSnapshot, validCellInputs } from './roomCode';
import { DebugEvidence, NativeDebugState, PauseEpoch, deadline } from './debugEvidence';
import { debugExtension, localDebugLaunch } from './debugLaunch';

const same = (a: CodeSnapshot, b: CodeSnapshot) => a.snippet === b.snippet && a.revision === b.revision && a.language === b.language
  && a.source === b.source && a.stdin === b.stdin && a.question === b.question
  && JSON.stringify(a.argv??[])===JSON.stringify(b.argv??[]) && JSON.stringify(a.files??[])===JSON.stringify(b.files??[]);
const sourcePath = (a: string, b: string) => process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function ownsSession(id:string, session:vscode.DebugSession): boolean {
  for (let current:vscode.DebugSession | undefined = session; current; current = current.parentSession)
    if (current.configuration.__dhimantaiNotebookDebug === id) return true;
  return false;
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as {port:number}).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function listening(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect({host:'127.0.0.1',port});
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(100, () => done(false));
  });
}

type Owned = {
  id:string; snapshot:CodeSnapshot; file:vscode.Uri; folder:string; remote?:string; engine?:CourseEngine;
  source:string; cancelled?:boolean; session?:vscode.DebugSession; server?:ChildProcess; breakpoint?:vscode.SourceBreakpoint;
  state:NativeDebugState; evidence?:DebugEvidence; pause:PauseEpoch; current:() => Promise<boolean>;
};

/** Only sessions launched from this notebook are observed. No background sharing or expression evaluation. */
export class NotebookDebugger implements vscode.Disposable {
  private owned?: Owned;
  private launching = false;
  private launchEpoch = 0;
  private subscriptions: vscode.Disposable[];
  constructor(private media: vscode.Uri, private changed: (snapshot:CodeSnapshot, state:NativeDebugState) => void) {
    this.subscriptions = [
      vscode.debug.registerDebugAdapterTrackerFactory('*', {createDebugAdapterTracker: session => {
        const o = this.owned;
        if (!o || !ownsSession(o.id,session)) return;
        return {
          onWillReceiveMessage: m => {
            if (m.type === 'request' && ['evaluate','setVariable','setExpression'].includes(m.command)) {
              o.pause.stopped(o.pause.thread,o.pause.reason); o.evidence = undefined;
            }
            if (m.type === 'request' && ['continue','next','stepIn','stepOut','stepBack','reverseContinue','restartFrame','restart','disconnect','terminate','goto'].includes(m.command)) {
              o.pause.invalidate(); o.evidence = undefined;
              this.publish(o, 'running', 'Debugger state changed. Pause again before discussing it.');
            }
          },
          onDidSendMessage: m => {
            if (this.owned !== o) return;
            if (m.type === 'response' && ['evaluate','setVariable','setExpression'].includes(m.command)) {
              o.pause.stopped(o.pause.thread,o.pause.reason); o.evidence = undefined;
            }
            if (m.type !== 'event') return;
            if (m.event === 'stopped') {
              o.session = session; o.evidence = undefined; o.pause.stopped(m.body?.threadId, m.body?.reason);
              this.publish(o, 'paused', 'Paused in VS Code. Predict the next change; inspect Variables and Call Stack, then Step Over or Step Into.');
            } else if (m.event === 'continued') {
              o.pause.invalidate(); o.evidence = undefined; this.publish(o, 'running', 'Running in VS Code. Stop at a breakpoint to inspect values.');
            }
          },
          onError: e => {
            if (this.owned === o) void this.stop().then(() => this.publish(o,'error',e.message));
          },
        };
      }}),
      vscode.debug.onDidStartDebugSession(session => {
        const owned = this.owned;
        if (owned && ownsSession(owned.id,session)) {
          if (owned.cancelled) void vscode.debug.stopDebugging(session);
          else owned.session = session;
        }
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const o = this.owned;
        if (o?.session?.id === session.id) {
          o.session = undefined; o.pause.invalidate(); o.evidence = undefined;
          void this.stopServer(o); this.removeBreakpoint(o);
          this.publish(o,'stopped','Debugging finished. Save fixes in the debug file, then bring changes back into this cell.');
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        const o = this.owned;
        if (o && event.contentChanges.length && event.document.uri.toString() === o.file.toString()) {
          o.pause.invalidate(); o.evidence = undefined;
          this.publish(o,o.state.phase,'Debug file edited. Stop and bring your changes back before debugging the new version.');
        }
      }),
    ];
  }
  private publish(o: Owned, phase: NativeDebugState['phase'], message: string) {
    if (this.owned !== o) return;
    o.state = {phase,message,canInspect:o.pause.thread !== undefined}; this.changed(o.snapshot,o.state);
  }
  private removeBreakpoint(o: Owned) {
    if (o.breakpoint) { vscode.debug.removeBreakpoints([o.breakpoint]); o.breakpoint = undefined; }
  }
  private async stopServer(o: Owned) {
    const child = o.server; o.server = undefined;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') await run('taskkill',['/PID',String(child.pid),'/T','/F'],5000);
        else process.kill(-child.pid,'SIGKILL');
      } catch { /* already exited */ }
    }
    if (o.engine && o.remote) await run(o.engine.bin,o.engine.execArgs(o.folder,'python',[o.remote + '/notebook_debug_server.py','stop']),5000).catch(() => {});
  }
  async stop() {
    ++this.launchEpoch;
    const o = this.owned;
    if (!o) return;
    o.cancelled = true; o.pause.invalidate(); o.evidence = undefined;
    if (o.session) await deadline(vscode.debug.stopDebugging(o.session),5000).catch(() => {});
    o.session = undefined; await this.stopServer(o); this.removeBreakpoint(o);
    this.publish(o,'stopped','Debugger stopped. Your debug file remains available; save and bring fixes back into the notebook.');
  }
  invalidate(snapshot?: CodeSnapshot) {
    const o = this.owned;
    if (o && (!snapshot || (snapshot.snippet === o.snapshot.snippet && !same(snapshot,o.snapshot)))) {
      o.pause.invalidate(); o.evidence = undefined;
      this.publish(o,o.state.phase,'Notebook code or runtime changed. Stop and start a fresh debug session for this version.');
    }
  }
  async start(snapshot: CodeSnapshot, engine: CourseEngine | undefined, tools: Toolchains, current: () => Promise<boolean>) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before debugging code.');
    if (this.launching || this.owned?.session) throw new Error('Stop this notebook’s current debug session first.');
    if (!validCellInputs(snapshot)) throw new Error('Invalid notebook arguments or files.');
    if (!snapshot.source.trim()) throw new Error('Write a complete program in this cell before debugging it.');
    const extensionId = debugExtension(snapshot.language,!!engine);
    if (!extensionId || !vscode.extensions.getExtension(extensionId))
      throw new Error(`Install and enable ${extensionId ?? 'the language debugger'} in VS Code Extensions, then retry Debug in VS Code.`);
    this.launching = true;
    const epoch = ++this.launchEpoch;
    let o: Owned | undefined;
    const valid = async () => epoch === this.launchEpoch && await current();
    try {
      if (!await valid()) return;
      const created = await mkdtemp(join(engine?.root ?? tmpdir(), '.dhimantai-debug-'));
      const folder = engine ? created : await realpath(created);
      const file = vscode.Uri.file(join(folder,entryFile(snapshot.language)));
      o = {id:randomBytes(12).toString('hex'),snapshot:{...snapshot},file,folder,engine,remote:engine?.path(folder),source:snapshot.source,
        state:{phase:'starting',message:'Preparing the native debugger…'},pause:new PauseEpoch(),current};
      this.owned = o; this.publish(o,'starting','Preparing a separate debug file with this cell’s code and standard input.');
      for(const input of snapshot.files??[]){const path=join(folder,input.name);await mkdir(dirname(path),{recursive:true});await writeFile(path,input.content);}
      await writeFile(file.fsPath,snapshot.source); await writeFile(join(folder,'stdin.txt'),snapshot.stdin);
      const plan = nativePlan(snapshot.language,snapshot.argv??[],engine ? {} : tools,engine ? false : undefined)!;
      if (plan.build) {
        let command = plan.build.command, args = plan.build.args;
        if (snapshot.language === 'typescript') {
          if (engine) args = [...args,'--typeRoots','/usr/local/lib/node_modules/@types'];
          else {
            const compiler = typescript(command);
            if (compiler) { command = tools.node ?? 'node'; args = [compiler.script,...args,...compiler.typeArgs]; }
          }
        }
        if (!await valid()) throw new Error('Your notebook changed while preparing the debugger.');
        if (engine) await run(engine.bin,engine.execArgs(folder,command,args),120000);
        else await new Promise<void>((resolve,reject) => {
          const child = spawn(command,args,{cwd:folder,env:programEnvironment(),shell:false,windowsHide:true});
          let output = ''; const timer = setTimeout(() => child.kill(),120000);
          child.stdout.on('data',b => { output = (output + b).slice(-2000); }); child.stderr.on('data',b => { output = (output + b).slice(-2000); });
          child.on('error',e => { clearTimeout(timer); reject(e); });
          child.on('close',code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output || 'Build failed. Check your language tools.')); });
        });
      }
      const port = engine ? await courseDebugPort(engine) : await freePort();
      const profile = engine ? await courseDebug(engine,folder,snapshot.language,snapshot.argv??[],port)
        : localDebugLaunch(snapshot.language,folder,port,tools,
          join(vscode.extensions.getExtension('ms-python.debugpy')?.extensionPath ?? '', 'bundled','libs','debugpy'),process.platform==='win32',snapshot.argv??[]);
      const launch = profile.launch;
      delete launch.preLaunchTask;
      launch.__dhimantaiNotebookDebug = o.id;
      launch.name = 'dhimantAI · Debug notebook cell';
      if (snapshot.language === 'javascript' || snapshot.language === 'typescript') {
        launch.type = 'pwa-node'; launch.outFiles = [join(folder,'*.js')];
      }
      if (engine && ['c','rust'].includes(snapshot.language)) {
        const wrapper = join(folder,'debug-input.sh');
        await writeFile(wrapper,'#!/bin/sh\nexec "$@" < ' + quote(o.remote + '/stdin.txt') + '\n'); await chmod(wrapper,0o755);
        launch.setupCommands = [{text:'set exec-wrapper ' + quote(o.remote + '/debug-input.sh')}]; launch.stopAtEntry = true;
      }
      if (profile.server) {
        if (engine && snapshot.language === 'go') profile.server.splice(profile.server.indexOf('--'),0,'-r','stdin.txt');
        if (!await valid()) throw new Error('Your notebook changed while preparing the debugger.');
        if (engine) {
          await copyFile(vscode.Uri.joinPath(this.media,'course','notebook_debug_server.py').fsPath,join(folder,'notebook_debug_server.py'));
          await writeFile(join(folder,'debug-command.json'),JSON.stringify(profile.server));
          await run(engine.bin,engine.execArgs(folder,'python',[o.remote + '/notebook_debug_server.py','start']),15000);
        } else {
          const [command,...args] = profile.server;
          let output = '', exited = false, pythonReady = false;
          const child = spawn(command,args,{cwd:folder,env:programEnvironment(),shell:false,windowsHide:true,detached:process.platform !== 'win32'});
          o.server = child;
          const capture = (b:Buffer) => {
            const text = output + b;
            pythonReady ||= text.includes('Adapter is accepting incoming client connections');
            output = text.slice(-1500);
          };
          child.stdout.on('data',capture); child.stderr.on('data',capture);
          child.on('error',e => { exited = true; output = e.message; }); child.on('exit',() => { exited = true; });
          child.stdin.on('error',() => {}); child.stdin.end(snapshot.stdin);
          let ready = false;
          for (let tries = 0; tries < 100 && !exited && await valid(); ++tries) {
            if (snapshot.language === 'python' ? pythonReady : await listening(port)) { ready = true; break; }
            await new Promise(resolve => setTimeout(resolve,100));
          }
          if (!ready) throw new Error(output || 'The debug server did not start. Check the selected runtime and debugger tools, then retry.');
        }
      }
      if (!await valid()) throw new Error('Your notebook changed before debugging started.');
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn.Beside,preview:false});
      o.breakpoint = new vscode.SourceBreakpoint(new vscode.Location(file,new vscode.Position(0,0)));
      vscode.debug.addBreakpoints([o.breakpoint]);
      const started = await deadline(vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(file),launch,
        {suppressSaveBeforeStart:true}),30000);
      if (!started || !await valid()) throw new Error('The debugger did not start for this notebook version. Check VS Code’s debugger message and retry.');
      if (o.state.phase === 'starting') this.publish(o,'running','VS Code debugger connected. Set breakpoints in the gutter and use its debug toolbar.');
    } catch (error) {
      if (o) { await this.stop(); this.publish(o,'error',error instanceof Error ? error.message : 'Debugger setup failed.'); }
      throw error;
    } finally { this.launching = false; }
  }
  owns(snapshot:CodeSnapshot) { return this.owned?.snapshot.snippet === snapshot.snippet; }
  async open() {
    const o = this.owned; if (!o) throw new Error('Start Debug in VS Code from this cell first.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(o.file),{viewColumn:vscode.ViewColumn.Beside,preview:false});
  }
  private async unchanged(o: Owned, snapshot: CodeSnapshot) {
    if (this.owned !== o || !same(snapshot,o.snapshot) || !await o.current()) return false;
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === o.file.toString());
    return (document ? document.getText() : await readFile(o.file.fsPath,'utf8')) === o.source;
  }
  async inspect(snapshot: CodeSnapshot): Promise<DebugEvidence> {
    const o = this.owned, epoch = o?.pause.current;
    if (!o || !o.session || epoch === undefined || !o.pause.matches(epoch) || !await this.unchanged(o,snapshot))
      throw new Error('Pause in the unchanged debug file for this cell before asking about debugger state.');
    const request = (command:string,args:object) => deadline(o.session!.customRequest(command,args));
    const stack = await request('stackTrace',{threadId:o.pause.thread,startFrame:0,levels:8});
    const frames: any[] = Array.isArray(stack?.stackFrames) ? stack.stackFrames.slice(0,8) : [];
    const frame = frames[0];
    if (!frame || typeof frame.source?.path !== 'string' || !sourcePath(frame.source.path,o.file.fsPath)
        || !Number.isSafeInteger(frame.line) || frame.line < 1 || frame.line > snapshot.source.split('\n').length)
      throw new Error('The debugger is paused outside this cell. Select a breakpoint in your debug file and continue to it.');
    let incomplete = (stack.totalFrames ?? frames.length) > frames.length;
    const variables: DebugEvidence['variables'] = [];
    try {
      const result = await request('scopes',{frameId:frame.id});
      const scopes = (Array.isArray(result?.scopes) ? result.scopes : []).filter((s:any) => !s.expensive && (s.presentationHint === 'locals' || /local/i.test(s.name))).slice(0,2);
      incomplete ||= !scopes.length;
      for (const scope of scopes) {
        const result = await request('variables',{variablesReference:scope.variablesReference,start:0,count:12});
        const values: any[] = Array.isArray(result?.variables) ? result.variables : [];
        incomplete ||= values.length > 12 || (scope.namedVariables ?? 0) > 12;
        for (const v of values.slice(0,12 - variables.length)) {
          if (typeof v.name !== 'string' || typeof v.value !== 'string') { incomplete = true; continue; }
          incomplete ||= v.value.length > 160 || v.name.length > 80;
          variables.push({name:v.name.slice(0,80),value:v.value.slice(0,160),type:typeof v.type === 'string' ? v.type.slice(0,80) : ''});
        }
      }
    } catch { incomplete = true; }
    if (!o.pause.matches(epoch) || !await this.unchanged(o,snapshot)) throw new Error('Debugger state changed while it was being read. Pause and ask again.');
    o.evidence = {id:randomBytes(12).toString('hex'),reason:o.pause.reason,line:frame.line,variables,incomplete,
      frames:frames.map(f => ({name:String(f.name ?? '').slice(0,120),selectedSource:typeof f.source?.path === 'string' && sourcePath(f.source.path,o.file.fsPath),
        line:typeof f.source?.path === 'string' && sourcePath(f.source.path,o.file.fsPath) && Number.isSafeInteger(f.line) ? f.line : null}))};
    return o.evidence;
  }
  async currentEvidence(snapshot: CodeSnapshot, id: unknown) {
    const o = this.owned;
    if (!o?.evidence || o.evidence.id !== id || o.pause.thread === undefined || !await this.unchanged(o,snapshot))
      throw new Error('That debugger observation is no longer current. Pause and ask again.');
    return o.evidence;
  }
  async import(snapshot: CodeSnapshot) {
    const o = this.owned;
    if (!o || !same(snapshot,o.snapshot) || !await o.current()) throw new Error('The notebook changed since debugging started. Copy your fixes back manually to preserve both versions.');
    if (o.session || this.launching) throw new Error('Stop debugging before bringing changes back.');
    const document = await vscode.workspace.openTextDocument(o.file);
    const source = document.getText();
    if (source.length > 12000) throw new Error('Keep the cell under 12,000 characters.');
    return source;
  }
  dispose() { void this.stop(); this.subscriptions.forEach(s => s.dispose()); }
}
