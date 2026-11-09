import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

// Exercise extension-host boundaries with a small VS Code double, without launching a host shell.
function moduleWithHost(name: string, vscode: any, platform = process.platform, dependencies: Record<string, any> = {}) {
  const filename = resolve(__dirname, '../src', name + '.js'), exports = {};
  const nativeRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), {exports, module:{exports}, process:{platform}, AbortController,
    require:(id: string) => id === 'vscode' ? vscode : Object.hasOwn(dependencies,id) ? dependencies[id] : nativeRequire(id)});
  return exports as any;
}
const disposable = () => ({dispose(){}});
const from = (...items: any[]) => ({dispose(){items.forEach(item => item?.dispose());}});

for (const [platform, key] of [['win32','windows'], ['darwin','osx'], ['linux','linux']] as const) {
  test(`new course terminals replace an existing host profile on ${platform}`, async () => {
    const changes: any[] = [], folder = {uri:{fsPath:'/course/project'}};
    let value: string | undefined = platform === 'win32' ? 'PowerShell' : 'zsh';
    const vscode = {ConfigurationTarget:{Workspace:2}, workspace:{getConfiguration:(section: string, uri: any) => {
      assert.equal(section, 'terminal.integrated'); assert.equal(uri,folder.uri);
      return {get:(setting: string) => {assert.equal(setting, 'defaultProfile.'+key); return value;},
        update:async (setting: string, next: string, scope: number) => {changes.push({setting,next,scope});value=next;}};
    }}};
    const profile = moduleWithHost('courseShellProfile',vscode,platform);
    assert.equal(await profile.preferCourseShell(folder),true);
    assert.deepEqual(changes,[{setting:'defaultProfile.'+key,next:'dhimantAI Course Container',scope:2}]);
    assert.equal(await profile.preferCourseShell(folder),false);
    const manifest = JSON.parse(readFileSync(resolve(__dirname,'../../package.json'),'utf8'));
    assert.equal(manifest.contributes.configurationDefaults['terminal.integrated.defaultProfile.'+key],value);
  });
}

test('terminal profile passes container options through and cancellation never creates a host shell', async () => {
  let provider: any, result: any = {shellPath:'podman',shellArgs:['exec','-it','course','/bin/zsh','-il']};
  const vscode = {Disposable:{from}, TerminalProfile:class {constructor(public options: any){}},
    window:{registerTerminalProfileProvider:(_id: string,p: any) => {provider=p;return disposable();}},
    workspace:{workspaceFolders:[],onDidChangeWorkspaceFolders:disposable,onDidChangeConfiguration:disposable}};
  const profile=moduleWithHost('courseShellProfile',vscode);
  const registration=profile.registerCourseShellProfile(async()=>result,()=>true,()=>true);
  assert.equal((await provider.provideTerminalProfile()).options,result);
  result=undefined;
  await assert.rejects(provider.provideTerminalProfile(),/Choose a course/);
  registration.dispose();
});

test('course terminal uses Podman exec with a quoted-by-argv project path on every platform', () => {
  const api=moduleWithHost('courseTerminal',{ThemeIcon:class {}},'win32');
  const options=api.courseTerminalOptions({bin:'C:\\Program Files\\RedHat\\Podman\\podman.exe',name:'course-python',
    root:'C:\\course',path:()=>'/course/my project'},'Course project','C:\\course\\my project');
  assert.equal(options.shellPath,'C:\\Program Files\\RedHat\\Podman\\podman.exe');
  assert.equal(options.shellArgs[3],'/course/my project');
  assert.deepEqual(Array.from(options.shellArgs.slice(-3)),['course-python','/bin/zsh','-il']);
});

test('removed local runtime requests do nothing; cancelled container setup stays actionable', async () => {
  const commands: string[] = [], messages: any[] = [];
  let receive: (message: any)=>Promise<void> = async()=>{};
  const doc={uri:{fsPath:'/tmp/notebook.ipynb',toString:()=> 'file:///tmp/notebook.ipynb'},
    notebookType:'jupyter-notebook',isClosed:false,getCells:()=>[]};
  const vscode={Disposable:{from},NotebookCellKind:{Code:2},
    window:{activeNotebookEditor:{notebook:doc},onDidChangeActiveNotebookEditor:disposable},
    workspace:{onDidCloseNotebookDocument:disposable,onDidChangeConfiguration:disposable},
    commands:{executeCommand:async(id: string)=>{commands.push(id);return undefined;}}};
  const api=moduleWithHost('notebookRuntime',vscode,'win32',{
    './colab':{useColabForNotebook:async()=>{throw new Error('unexpected Colab request');}},
    './notebookCommands':{jupyterMetadata:()=>({kernelspec:{language:'python'}})}});
  api.bindNotebookRuntime({postMessage:async(m: any)=>messages.push(m),
    onDidReceiveMessage:(listener: typeof receive)=>{receive=listener;return disposable();}},async()=>{});
  await receive({type:'runtime',runtime:'local',uri:doc.uri.toString()});
  await receive({type:'runtime',runtime:'terminal',uri:'file:///stale.ipynb'});
  assert.deepEqual(commands,[]);
  await receive({type:'runtime',runtime:'setup',uri:doc.uri.toString()});
  assert.deepEqual(commands,['dhimantai.setupCourse']);
  assert.equal(messages.at(-1).busy,false);
  assert.match(messages.at(-1).status,/setup was not completed/);
  await api.newNotebook();
  assert.equal(commands.at(-1),'dhimantai.newCourseNotebook');
});

test('a legacy courseContainers=false preference cannot enable host execution', () => {
  const dependencies=Object.fromEntries(['podman','courseEngine','courseRecovery','courseDebug','courseReadiness',
    'courseTerminal','colab','colabNotebooks'].map(name=>['./'+name,{}]));
  const api=moduleWithHost('courseWorkspace',{workspace:{getConfiguration:()=>({get:()=>false})}},'win32',dependencies);
  const courses=Object.create(api.CourseWorkspaces.prototype);
  courses.available=true;
  assert.equal(courses.enabled,true);
  courses.available=false;
  assert.equal(courses.enabled,false);
});

test('Practice refuses execution when course setup returns no container', async () => {
  let executed=0, success:boolean|undefined;
  const outputs:any[]=[];
  const controller={onDidChangeSelectedNotebooks:disposable,dispose(){},
    createNotebookCellExecution:()=>({start(){},token:{onCancellationRequested:disposable},
      clearOutput:async()=>{},appendOutput:async(output:any)=>outputs.push(output),end:(ok:boolean)=>{success=ok;}})} as any;
  const vscode={EventEmitter:class {event=disposable;fire(){}},Disposable:class {static from=from;constructor(_callback?:()=>void){}dispose(){}},
    NotebookCellKind:{Code:2},NotebookCellOutput:class {constructor(public items:any[]){}},
    NotebookCellOutputItem:{stderr:(text:string)=>text},
    notebooks:{createNotebookController:()=>controller},
    workspace:{isTrusted:true,notebookDocuments:[],onDidCloseNotebookDocument:disposable,onDidOpenNotebookDocument:disposable},
  };
  const api=moduleWithHost('practiceKernel',vscode,'win32',{
    './notebookCells':{NotebookCells:class {
      constructor(_tools:any,private engine:any){} restart(){} stop(){}
      async run(){await this.engine('python');executed++;return {status:'exited',exit_code:0};}
    }},
    './notebookCommands':{jupyterMetadata:()=>({}),learnerCell:()=>true},
    './practiceIpynb':{practiceLink:()=>undefined},'./environments':{ENVIRONMENTS:{production:{}}},
  });
  api.registerPracticeKernel(async()=>undefined,{id:'container-required'});
  const cell={kind:2,metadata:{},document:{languageId:'python',getText:()=>'print("should not run")'}};
  await controller.executeHandler([cell],{uri:{toString:()=> 'file:///example.ipynb'},getCells:()=>[cell]});
  assert.equal(executed,0);
  assert.equal(success,false);
  assert.match(JSON.stringify(outputs),/Set up the course container/);
});
