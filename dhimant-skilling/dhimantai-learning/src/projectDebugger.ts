import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import {isAbsolute, relative, sep} from 'node:path';
import type {CourseEngine} from './courseEngine';
import {publicContextPath} from './projectContext';
import {deadline, PauseEpoch} from './debugEvidence';

const type = 'dhimantai-project';
/** The adapter, launcher and debuggee all run as the learner in the selected project container. */
export class ProjectDebugger implements vscode.Disposable {
  private sessions = new Map<string,{root:string; engine:CourseEngine; current:()=>boolean}>();
  private subscriptions: vscode.Disposable[];
  constructor(private paused:(root:string,path:string,line:number,current:()=>boolean)=>void) {
    this.subscriptions = [
      vscode.debug.registerDebugAdapterDescriptorFactory(type,{createDebugAdapterDescriptor:session => {
        const owned = this.sessions.get(session.configuration.projectDebugId);
        if (!owned?.current() || !vscode.workspace.isTrusted) throw new Error('Start Debug this step from the current project.');
        return new vscode.DebugAdapterExecutable(owned.engine.bin, owned.engine.execArgs(owned.root,'python',['-m','debugpy.adapter']));
      }}),
      vscode.debug.registerDebugAdapterTrackerFactory(type,{createDebugAdapterTracker:session => {
        const id = session.configuration.projectDebugId, owned = this.sessions.get(id);
        if (!owned) return;
        const pauses = new PauseEpoch();
        return {
          onWillReceiveMessage: message => {
            if (['continue','next','stepIn','stepOut','disconnect','terminate','restart'].includes(message.command)) pauses.invalidate();
          },
          onDidSendMessage: message => {
            if (message.type !== 'event') return;
            if (['continued','terminated','exited'].includes(message.event)) pauses.invalidate();
            if (message.event !== 'stopped') return;
            const pause = pauses.stopped(message.body?.threadId,message.body?.reason);
            if (pauses.thread === undefined) return;
            const current = () => pauses.matches(pause) && this.sessions.get(id) === owned && owned.current();
            void deadline(session.customRequest('stackTrace',{threadId:pauses.thread,startFrame:0,levels:1})).then(stack => {
              const frame = stack?.stackFrames?.[0];
              if (!current() || !frame?.source?.path || !Number.isSafeInteger(frame.line) || frame.line < 1) return;
              const file = relative(owned.root,frame.source.path).split(sep).join('/');
              if (!isAbsolute(file) && publicContextPath(file)) this.paused(owned.root,file,frame.line,current);
            }).catch(() => {});
          },
        };
      }}),
      vscode.debug.onDidTerminateDebugSession(session => {
        if (session.type === type) this.sessions.delete(session.configuration.projectDebugId);
      }),
    ];
  }
  async start(root:string, engine:CourseEngine, args:string[], current:()=>boolean, runOnly=false) {
    const id = randomUUID(), remote = engine.path(root);
    this.sessions.set(id,{root,engine,current});
    try {
      const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)), {
        type, name:runOnly ? 'Run project step' : 'Debug project step', request:'launch', projectDebugId:id,
        ...(args[0] === '-c' ? {code:args[1]} : {module:args[1]}), args:args.slice(2), cwd:remote, console:'internalConsole',
        internalConsoleOptions:'openOnSessionStart', justMyCode:true, subProcess:false, pathMappings:[{localRoot:root,remoteRoot:remote}],
      }, {noDebug:runOnly});
      if (!started) throw new Error('The project debugger did not start. Check the Debug Console and retry.');
    } catch (error) { this.sessions.delete(id); throw error; }
  }
  dispose() { this.sessions.clear(); this.subscriptions.forEach(subscription => subscription.dispose()); }
}
