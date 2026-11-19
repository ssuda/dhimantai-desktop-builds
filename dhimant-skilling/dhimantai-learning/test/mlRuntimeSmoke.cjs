// Real CourseWorkspaces -> Podman -> NotebookCells acceptance, with only VS Code/account APIs stubbed.
// npm run compile && node test/mlRuntimeSmoke.cjs receipt.json
// An optional existing shared image avoids rebuilding unchanged language toolchains on a full Podman disk.
const fs=require('node:fs'), fsp=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {createRequire}=require('node:module'), {runInNewContext}=require('node:vm'), assert=require('node:assert/strict');
const base=path.resolve(__dirname,'..'), filename=path.join(base,'out/src/courseWorkspace.js'), nativeRequire=createRequire(filename);
const {NotebookCells}=nativeRequire('./notebookCells');
const {programmingRecipe}=nativeRequire('./courseRecipe');
const {run}=nativeRequire('./podman');
const {authoredConfiguration}=require('../out/test/authoredConfiguration');

(async()=>{
  const root=await fsp.mkdtemp(path.join(os.homedir(),'.dhimantai-ml-smoke-')), state=new Map(), exported={};
  const vscode={Uri:{file:fsPath=>({scheme:'file',fsPath})},env:{},workspace:{isTrusted:true,getConfiguration:()=>({get:key=>key==='exercisesFolder'?root:undefined})},
    ProgressLocation:{Notification:1},window:{withProgress:async(_,fn)=>fn({report:({message})=>console.log(message)}),showWarningMessage:async message=>console.log(message)}};
  const stubs=new Map([['vscode',vscode],['./courseDebug',{courseDebugPort:async()=>undefined}],['./courseTerminal',{}],['./colab',{}],['./notebookKernelPicker',{}]]);
  runInNewContext(fs.readFileSync(filename,'utf8'),{exports:exported,process,console,Buffer,require:name=>stubs.has(name)?stubs.get(name):nativeRequire(name)});
  const context={extensionPath:base,globalState:{keys:()=>[...state.keys()],get:key=>state.get(key),update:async(key,value)=>state.set(key,value)}};
  const auth={session:async()=>({user:{id:'ml-smoke'}})}, engines=[], owned=new Set(), results=[];
  const output={append:m=>fs.appendFileSync(path.join(root,'build.log'),m),appendLine:m=>fs.appendFileSync(path.join(root,'build.log'),m+'\n')};
  const courses=new exported.CourseWorkspaces(context,auth,()=> 'local',output,true,undefined,
    async scope=>({runtime:null,configuration:authoredConfiguration(scope.course)}));
  console.log('SMOKE_ROOT='+root);
  try {
    for(const title of ['shared programming','Data Science with Python','Machine Learning with scikit-learn']) {
      const shared=title==='shared programming';
      const file=shared?await courses.programmingFolder('ml-smoke','local')
        :await courses.courseFolder({course:title,account:'ml-smoke',environment:'local'});
      owned.add('dhimantai-course-'+courses.recordFor(file).key);
      const cached=process.env.DHIMANTAI_SMOKE_BASE_IMAGE;
      if(cached) {
        assert.match(cached,/^[a-zA-Z0-9./:@_-]+$/);
        await fsp.writeFile(path.join(file.fsPath,'Dockerfile'),`FROM ${cached}\nUSER root\nCOPY requirements.txt /opt/dhimantai/requirements.txt\nRUN python -m pip install --no-cache-dir -r /opt/dhimantai/requirements.txt\nCOPY runtime/ /opt/dhimantai/\nRUN chmod -R a+rX /opt/dhimantai\nUSER learner\n`);
      }
      const engine=await courses.forFile(file,'python');engines.push(engine);
      const cells=new NotebookCells(()=>({}),language=>courses.forFile(file,language),async()=>path.join(engine.root,'ml-notebook'),60000);
      const execution=[];
      try {
        const events=[];
        const forest=await cells.run('python',fs.readFileSync(path.join(__dirname,'fixtures/random_forest.py'),'utf8'),'',{event:e=>events.push(e)});
        assert.equal(forest.exit_code,0,JSON.stringify(forest));
        assert.match(forest.stdout,/Random Forest accuracy: 0\.9\d+/);
        assert.ok(events.some(e=>e.kind==='display'&&e.data['image/png']),'Feature-importance plot must reach the notebook');
        const environment=await cells.run('python',"import sys, json, os\nprint(json.dumps({'uid':os.getuid(),'prefix':sys.prefix,'base':sys.base_prefix,'executable':sys.executable}))");
        const identity=JSON.parse(environment.stdout.trim());assert.notEqual(identity.uid,0);
        assert.match(identity.prefix,/^\/tmp\/dhimantai-python-\d+\/venv$/);assert.notEqual(identity.prefix,identity.base);
        // A tiny offline wheel exercises pip's permission changes and the same-kernel import path.
        const wheel=await cells.run('python',`import zipfile\nfrom pathlib import Path\nwheel=Path('dhimantai_ml_probe-1.0-py3-none-any.whl')\nwith zipfile.ZipFile(wheel,'w') as archive:\n    for name, content in {\n        'dhimantai_ml_probe.py':'answer = 42\\n',\n        'dhimantai_ml_probe-1.0.dist-info/METADATA':'Metadata-Version: 2.1\\nName: dhimantai-ml-probe\\nVersion: 1.0\\n',\n        'dhimantai_ml_probe-1.0.dist-info/WHEEL':'Wheel-Version: 1.0\\nGenerator: smoke\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',\n        'dhimantai_ml_probe-1.0.dist-info/RECORD':''\n    }.items(): archive.writestr(name,content)\nprint(wheel)`);
        assert.equal(wheel.exit_code,0,wheel.stderr);
        const installed=await cells.run('python','%pip install --no-index --force-reinstall ./dhimantai_ml_probe-1.0-py3-none-any.whl');
        assert.equal(installed.exit_code,0,JSON.stringify(installed));
        const imported=await cells.run('python','import dhimantai_ml_probe\nassert dhimantai_ml_probe.answer == 42\nprint(dhimantai_ml_probe.__file__)');
        assert.equal(imported.exit_code,0,imported.stderr);assert.ok(imported.stdout.startsWith(identity.prefix+'/lib/'));
        for(const source of [
          '%pip install --no-index dhimantai-package-that-does-not-exist',
          '!python -m pip install --no-index dhimantai-package-that-does-not-exist',
          'import subprocess, sys\nresult = subprocess.run([sys.executable,"-m","pip","install","--no-index","dhimantai-package-that-does-not-exist"])\nprint(result.returncode)',
        ]) {
          const failed=await cells.run('python',source);assert.notEqual(failed.exit_code,0,JSON.stringify(failed));
          assert.match(failed.stdout+failed.stderr,/No matching distribution|Could not find a version/);
          execution.push({source,exit:failed.exit_code});
          const recovery=await cells.run('python','print("after failed install")');assert.equal(recovery.exit_code,0,recovery.stderr);
        }
        const probe=await cells.run('python','import subprocess, sys\nresult = subprocess.run([sys.executable,"-c","raise SystemExit(7)"])\nassert result.returncode == 7');
        assert.equal(probe.exit_code,0,'Intentional non-pip failures keep Python semantics');
        cells.restart();
        const restarted=await cells.run('python','import dhimantai_ml_probe\nprint(dhimantai_ml_probe.answer)');
        assert.equal(restarted.stdout,'42\n');
        // The terminal command path uses exactly the same environment as the notebook.
        const terminal=await run(engine.bin,engine.execArgs(engine.root,'zsh',['-ilc','python -c "import dhimantai_ml_probe; print(dhimantai_ml_probe.answer)"']),60000);
        assert.equal(terminal.trim(),'42');
        results.push({runtime:title,identity,forest:{exit:forest.exit_code,stdout:forest.stdout,plot:true},
          packageInstallExit:installed.exit_code,packageImported:true,persistedAfterRestart:true,terminalImport:true,failures:execution});
        console.log('PASS '+results.at(-1).runtime);
      } finally {await cells.close();}
    }
    const receipt={platform:process.platform,arch:process.arch,cachedToolchainBase:process.env.DHIMANTAI_SMOKE_BASE_IMAGE||null,
      requirements:programmingRecipe().requirements,results};
    if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt));
  } finally {
    await courses.stopAll();
    for(const name of owned)await run(engines[0]?.bin||'podman',['rm','--force','--ignore',name]);
    console.log('Build log: '+path.join(root,'build.log'));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
