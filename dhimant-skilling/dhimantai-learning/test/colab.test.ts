import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {externalNotebookRuntime} from '../src/colabSetup';

function load(name:string,vscode:any,dependencies:Record<string,any>) {
  const filename=resolve(__dirname,'../src',name+'.js'),exports:any={};
  const nativeRequire=createRequire(filename);
  runInNewContext(readFileSync(filename,'utf8'),{exports,module:{exports},
    require:(id:string)=>id==='vscode'?vscode:dependencies[id]??nativeRequire(id)});
  return exports;
}

function fixture() {
  const calls:string[]=[];
  let install=false,jupyter=true,colab=true,activateError='',api:any={createJupyterServerCollection(){}};
  const vscode:any={version:'1.143.1',env:{},workspace:{isTrusted:true},NotebookCellKind:{Code:2},
    extensions:{getExtension:(id:string)=>id==='google.colab' ? colab ? {activate:async()=>{
      calls.push('colab');if(activateError)throw new Error(activateError);
    }} : undefined : jupyter ? {activate:async()=>{calls.push('jupyter');return api;}} : undefined},
    window:{showInformationMessage:async(_message:string,...items:string[])=>install?items[0]:undefined},
    commands:{executeCommand:async(id:string)=>{calls.push(id);colab=true;}}};
  const exports=load('colab',vscode,{
    './notebookCommands':{jupyterMetadata:(doc:any)=>doc.metadata,externalRuntimeFor:(doc:any)=>externalNotebookRuntime(doc.metadata,doc.getCells().map((c:any)=>c.document.getText()))},
    './notebookKernelPicker':{openNotebookKernelPicker:async()=>{calls.push('picker');return 'Check the kernel';}},
  });
  const doc={uri:{scheme:'file'},notebookType:'jupyter-notebook',isClosed:false,
    metadata:{kernelspec:{language:'python'}},getCells:()=>[{kind:2,document:{languageId:'python',getText:()=>''}}]};
  return {exports,vscode,calls,doc,install:(value:boolean)=>{install=value;},colab:(value:boolean)=>{colab=value;},
    jupyter:(value:boolean)=>{jupyter=value;},api:(value:any)=>{api=value;},fail:(value:string)=>{activateError=value;}};
}

test('Colab setup activates a compatible Jupyter provider before opening the notebook picker',async()=>{
  const f=fixture();
  await f.exports.useColabForNotebook(f.doc);
  assert.deepEqual(f.calls,['jupyter','colab','picker']);
});

test('missing or incompatible Jupyter and failed Colab activation stop before opening a misleading picker',async()=>{
  const f=fixture();
  f.jupyter(false);
  await assert.rejects(f.exports.useColabForNotebook(f.doc),/Enable Microsoft Jupyter.*reload/);
  assert.deepEqual(f.calls,[]);
  f.jupyter(true);f.api({});
  await assert.rejects(f.exports.useColabForNotebook(f.doc),/Update Microsoft Jupyter/);
  assert.deepEqual(f.calls,['jupyter']);
  f.api({createJupyterServerCollection(){}});f.fail('provider unavailable');
  await assert.rejects(f.exports.useColabForNotebook(f.doc),/Colab could not register.*Output.*provider unavailable/);
  assert.deepEqual(f.calls,['jupyter','jupyter','colab']);
});

test('declined installation opens no picker, while an accepted install prepares the provider',async()=>{
  const f=fixture();f.colab(false);
  await f.exports.useColabForNotebook(f.doc);assert.deepEqual(f.calls,[]);
  f.install(true);
  await f.exports.useColabForNotebook(f.doc);
  assert.deepEqual(f.calls,['workbench.extensions.installExtension','jupyter','colab','picker']);
});

test('course kernel never prefers or starts Podman for copied Colab GPU probes or external metadata',async()=>{
  let runner:any,options:any,starts=0;
  const vscode={workspace:{onDidChangeConfiguration:()=>({dispose(){}})}};
  const exports=load('courseKernel',vscode,{
    './practiceKernel':{registerPracticeKernel:(r:any,o:any)=>{runner=r;options=o;return {dispose(){}};}},
    './practiceIpynb':{practiceLink:()=>undefined},
    './notebookCommands':{jupyterMetadata:(doc:any)=>doc.metadata,
      externalRuntimeFor:(doc:any)=>externalNotebookRuntime(doc.metadata,doc.sources)},
  });
  exports.registerCourseKernel({enabled:true,recordFor:()=>({}),forFile:async()=>{starts++;return {};},languageFor:()=> 'python'},
    {subscriptions:[]},{onDidChange:()=>({dispose(){}})});
  const legacy={metadata:{},sources:["assert 'COLAB_RELEASE_TAG' in os.environ\nsubprocess.check_output(['nvidia-smi'])\nprint('DHIMANTAI_GPU_READY')"]};
  const declared={metadata:{dhimantai_runtime:{provider:'google.colab',accelerator:'gpu',version:1}},sources:[]};
  for(const doc of [legacy,declared]) {
    assert.equal(options.wants(doc),false);
    await assert.rejects(runner(doc,'python'),/Use Colab Kernel.*GPU availability has not been checked/);
  }
  const ordinary={metadata:{},sources:["print('COLAB_RELEASE_TAG')"]};
  assert.equal(options.wants(ordinary),true);
  await runner(ordinary,'python');
  assert.equal(starts,1,'only the ordinary course notebook starts Podman');
});

test('repairing notebook metadata removes a previous course-kernel preference',()=>{
  const preferences:number[]=[],doc:any={external:false,notebookType:'jupyter-notebook'},disposable={dispose(){}};
  let changed:(event:any)=>void=()=>{};
  const kernel={updateNotebookAffinity:(_doc:any,value:number)=>preferences.push(value),onDidChangeSelectedNotebooks:()=>disposable};
  const vscode:any={EventEmitter:class {},Disposable:class {static from(){return disposable;}},
    NotebookControllerAffinity:{Default:1,Preferred:2},notebooks:{createNotebookController:()=>kernel},
    workspace:{notebookDocuments:[doc],onDidOpenNotebookDocument:()=>disposable,onDidCloseNotebookDocument:()=>disposable,
      onDidChangeNotebookDocument:(callback:any)=>{changed=callback;return disposable;}}};
  const exports=load('practiceKernel',vscode,{'./notebookCommands':{},'./notebookCells':{},'./practiceIpynb':{}});
  exports.registerPracticeKernel(async()=>undefined,{id:'course',wants:(book:any)=>!book.external});
  doc.external=true;changed({notebook:doc,metadata:{dhimantai_runtime:{provider:'google.colab'}}});
  changed({notebook:{...doc,notebookType:'unrelated-notebook'},metadata:{}});
  assert.deepEqual(preferences,[2,1]);
});
