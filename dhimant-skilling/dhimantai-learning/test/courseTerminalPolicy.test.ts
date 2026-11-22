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
    root:'C:\\course',execUser:[],path:()=>'/course/my project',commandArgs:(command:string,args:string[])=>[command,...args]},'Course project','C:\\course\\my project');
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
    './notebookKernelPicker':{openNotebookKernelPicker:async()=>{throw new Error('unexpected Jupyter request');}},
    './notebookCommands':{jupyterMetadata:()=>({kernelspec:{language:'python'}})}});
  api.bindNotebookRuntime({postMessage:async(m: any)=>messages.push(m),
    onDidReceiveMessage:(listener: typeof receive)=>{receive=listener;return disposable();}},async()=>{});
  await receive({type:'runtime',runtime:'local',uri:doc.uri.toString()});
  await receive({type:'runtime',runtime:'terminal',uri:'file:///stale.ipynb'});
  assert.deepEqual(commands,[]);
  await receive({type:'runtime',runtime:'setup',uri:doc.uri.toString()});
  assert.deepEqual(commands,['dhimantai.courseMachines','dhimantai.setupCourse','dhimantai.courseMachines']);
  assert.equal(messages.at(-1).busy,false);
  assert.match(messages.at(-1).status,/setup was not completed/);
  await api.newNotebook();
  assert.equal(commands.at(-1),'dhimantai.newCourseNotebook');
});

test('a legacy courseContainers=false preference cannot enable host execution', () => {
  const dependencies=Object.fromEntries(['courseAppPreview','podman','courseEngine','courseRecovery','courseDebug','courseReadiness',
    'courseTerminal','colab','colabNotebooks','notebookKernelPicker'].map(name=>['./'+name,{}]));
  const api=moduleWithHost('courseWorkspace',{workspace:{getConfiguration:()=>({get:()=>false})}},'win32',dependencies);
  const courses=Object.create(api.CourseWorkspaces.prototype);
  courses.configuration=async()=>({preferred_accelerator:'gpu'});
  courses.available=true;
  assert.equal(courses.enabled,true);
  courses.available=false;
  assert.equal(courses.enabled,false);
});

test('student GPU selection opens the existing Jupyter picker only for the current notebook', async () => {
  let receive: (message:any)=>Promise<void> = async()=>{};
  const selected:any[] = [], messages:any[] = [];
  const doc = {uri:{fsPath:'/course/gpu.ipynb',toString:()=> 'file:///course/gpu.ipynb'},
    notebookType:'jupyter-notebook',isClosed:false,getCells:()=>[]};
  const vscode = {Disposable:{from},NotebookCellKind:{Code:2},
    window:{activeNotebookEditor:{notebook:doc},onDidChangeActiveNotebookEditor:disposable,showInformationMessage:async()=>{}},
    workspace:{onDidCloseNotebookDocument:disposable,onDidChangeConfiguration:disposable},
    commands:{executeCommand:async()=>undefined}};
  const api = moduleWithHost('notebookRuntime',vscode,'linux',{
    './colab':{useColabForNotebook:async()=>{throw new Error('Colab must not be required for a student GPU');}},
    './notebookCommands':{jupyterMetadata:()=>({kernelspec:{language:'python'}})},
    './notebookKernelPicker':{openNotebookKernelPicker:async(target:any)=>{selected.push(target);return 'Select a kernel and verify a cell.';}}});
  api.bindNotebookRuntime({postMessage:async(message:any)=>messages.push(message),
    onDidReceiveMessage:(listener:typeof receive)=>{receive=listener;return disposable();}},async()=>{throw new Error('No container setup');});
  await receive({type:'runtime',runtime:'jupyter',uri:'file:///stale.ipynb'});
  assert.equal(selected.length,0);
  await receive({type:'runtime',runtime:'jupyter',uri:doc.uri.toString()});
  assert.deepEqual(selected,[doc]);
  assert.match(messages.at(-1).status,/verify a cell/);
  doc.isClosed=true;
  await receive({type:'runtime',runtime:'jupyter',uri:doc.uri.toString()});
  assert.equal(selected.length,1);
});

test('starting the inference course exports labs without setting up a CPU container', async () => {
  const dependencies=Object.fromEntries(['courseAppPreview','podman','courseEngine','courseRecovery','courseDebug','courseReadiness',
    'courseTerminal','colab','notebookKernelPicker'].map(name=>['./'+name,{}]));
  dependencies['./colabNotebooks'] = {};
  dependencies['./courseConfiguration'] = {};
  const api=moduleWithHost('courseWorkspace',{},'linux',dependencies);
  const courses=Object.create(api.CourseWorkspaces.prototype), scope={course:'Inference Engineering',account:'student',environment:'staging'};
  courses.configuration=async()=>({preferred_accelerator:'gpu'});
  const calls:any[]=[];
  courses.enterColab=async(...args:any[])=>{calls.push(args);return 'gpu notebook';};
  courses.setup=async()=>{throw new Error('GPU labs must not prepare a local container');};
  courses.recipe=async()=>{throw new Error('GPU labs must not load local runtime dependencies');};
  assert.equal(await courses.enter(scope),'gpu notebook');
  assert.deepEqual(calls,[[scope]]);
  courses.context={globalState:{keys:()=>['dhimantai.courseRuntime.test'], get:()=>({root:'/course/inference'})}};
  courses.recordPrefix='dhimantai.courseRuntime.';
  assert.equal(courses.recordFor({scheme:'file',fsPath:'/course/inference/gpu/01-runtime.ipynb'}),undefined);
  assert.equal(courses.recordFor({scheme:'file',fsPath:'/course/inference/colab/01-runtime.ipynb'}),undefined);
  assert.ok(courses.recordFor({scheme:'file',fsPath:'/course/inference/exercises/practice.ipynb'}));
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
    workspace:{isTrusted:true,notebookDocuments:[],onDidCloseNotebookDocument:disposable,
      onDidOpenNotebookDocument:disposable,onDidChangeNotebookDocument:disposable},
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

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`a bare ${platform} host refuses learner execution before touching host tools or files`, async () => {
    const unexpected = new Proxy({}, {get() { throw new Error('Unexpected access to host execution'); }});
    const load = (name: string, extra: Record<string, unknown> = {}) => moduleWithHost(name, {}, platform, {
      'node:fs': {existsSync: () => false},
      'node:fs/promises': unexpected, 'node:child_process': unexpected, ...extra,
    });
    const local = load('localRunner');
    const deps = {'./localRunner': local};
    const {NotebookCells} = load('notebookCells', deps);
    const {NativeRunner} = load('nativeRun', {...deps, './courseTerminal': {}});
    const {NotebookDebugger} = load('notebookDebugger', {...deps, './courseDebug': {}, './nativeRun': {}});
    const blocked = /Host execution is disabled/;
    const input = {source: '', argv: [], files: [], stdin: ''};
    await assert.rejects(local.runLocally('python', input), blocked);
    await assert.rejects(local.traceLocally('', input), blocked);
    await assert.rejects(local.runPublicTests('python', '', [{kind: 'function'}], ''), blocked);
    await assert.rejects(new NotebookCells(() => assert.fail(), async () => undefined).run('python', ''), blocked);
    const unavailable = () => { throw new Error('Selected runtime unavailable'); };
    const container = new NotebookCells(() => assert.fail(), async () => ({bin: 'podman', name: 'course'}), unavailable);
    await assert.rejects(container.run('python', ''), /Selected runtime unavailable/);
    const remote = new NotebookCells(() => assert.fail(), undefined, undefined, 0, {target: 'SSH', start: unavailable});
    await assert.rejects(remote.run('python', ''), /Selected runtime unavailable/);
    await assert.rejects(NativeRunner.prototype.buildOnly('cpp', {}, {}), blocked);
    await assert.rejects(NativeRunner.prototype.run('python', {}, [], {}), blocked);
    await assert.rejects(NotebookDebugger.prototype.start({}, undefined, {}, () => assert.fail()), blocked);
  });
}

test('the notebook binds to the chosen remote provider and stops on cancellation', async () => {
  const doc = {notebookType: 'jupyter-notebook'}, editor = {notebook: doc};
  for (const [provider, owner, collection] of [
    ['jupyter', 'ms-toolsai.jupyter', '_builtin.jupyterServerUrlProvider'], ['colab', 'google.colab', 'colab'],
  ]) {
    let id: string | undefined;
    let bindings = 0;
    let canBind = true;
    const vscode = {
      ViewColumn: {One: 1}, window: {showNotebookDocument: async () => editor},
      extensions: {getExtension: () => ({activate: async () => {}})},
      commands: {executeCommand: async (command: string, ...args: any[]) => {
        if (command === 'jupyter.kernel.selectJupyterServerKernel') {
          assert.deepEqual(args, [owner, collection, doc]);
          return id;
        }
        assert.equal(command, 'notebook.selectKernel');
        assert.ok(id);
        assert.equal(args[0].id, id);
        assert.equal(args[0].extension, 'ms-toolsai.jupyter');
        assert.equal(args[0].notebookEditor, editor);
        bindings++;
        return canBind;
      }},
    };
    const picker = moduleWithHost('notebookKernelPicker', vscode);
    assert.match(await picker.openNotebookKernelPicker(doc, provider), /No kernel was selected/);
    assert.equal(bindings, 0);
    id = 'remote-controller';
    assert.match(await picker.openNotebookKernelPicker(doc, provider), /Remote kernel selected/);
    assert.equal(bindings, 1);
    canBind = false;
    await assert.rejects(picker.openNotebookKernelPicker(doc, provider), /remote kernel could not be selected/);
    assert.equal(bindings, 2);
  }
});

test('direct runner calls require the course runtime inside a Linux container', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    for (const marker of ['/run/.containerenv', '/.dockerenv']) {
      const files = new Set<string>();
      const runner = moduleWithHost('localRunner', {}, platform, {'node:fs': {existsSync: (file: string) => files.has(file)}});
      files.add('/opt/dhimantai/runner.cjs');
      assert.throws(() => runner.assertInCourseContainer(), /Host execution is disabled/);
      files.add(marker);
      if (platform === 'linux') assert.doesNotThrow(() => runner.assertInCourseContainer());
      else assert.throws(() => runner.assertInCourseContainer(), /Host execution is disabled/);
      files.delete('/opt/dhimantai/runner.cjs');
      assert.throws(() => runner.assertInCourseContainer(), /Host execution is disabled/);
    }
  }
});
