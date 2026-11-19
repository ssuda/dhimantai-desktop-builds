// Opt-in real Podman acceptance: npm run compile && node test/programmingContainerSmoke.cjs [result.json]
// Only the VS Code UI/account boundary is stubbed; image build, readiness and notebook execution are real.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const {createRequire} = require('node:module'), {runInNewContext} = require('node:vm');
const base = path.resolve(__dirname,'..');
const filename = path.join(base,'out/src/courseWorkspace.js'), nativeRequire = createRequire(filename);
const {NotebookCells} = nativeRequire('./notebookCells');
const {courseExamples,readyMessage} = nativeRequire('./courseReadiness');
const {PROGRAMMING_RUNTIME} = nativeRequire('./courseRecipe');
const assert = require('node:assert/strict');
(async()=>{
  const root = await fsp.mkdtemp(path.join(os.homedir(),'.dhimantai-shared-smoke-'));
  const state = new Map(), exported = {};
  const vscode = {Uri:{file:fsPath=>({scheme:'file',fsPath})},env:{},workspace:{isTrusted:true,getConfiguration:()=>({get:key=>key==='exercisesFolder'?root:undefined})},
    ProgressLocation:{Notification:1},window:{withProgress:async(_,fn)=>fn({report:({message})=>console.log(message)}),showWarningMessage:async message=>console.log(message)}};
  const stubs = new Map([['vscode',vscode],['./courseDebug',{courseDebugPort:async()=>undefined}],['./courseTerminal',{}],['./colab',{}],['./notebookKernelPicker',{}]]);
  runInNewContext(fs.readFileSync(filename,'utf8'),{exports:exported,process,console,Buffer,require:name=>stubs.has(name)?stubs.get(name):nativeRequire(name)});
  const context={extensionPath:base,globalState:{keys:()=>[...state.keys()],get:key=>state.get(key),update:async(key,value)=>state.set(key,value)}};
  const auth={session:async()=>({user:{id:'shared-smoke'}})};
  const output={append:message=>fs.appendFileSync(path.join(root,'build.log'),message),appendLine:message=>fs.appendFileSync(path.join(root,'build.log'),message+'\n')};
  const courses = new exported.CourseWorkspaces(context,auth,()=> 'local',output,true,undefined,async()=>{throw new Error('Shared runtime must not download a course image');});
  let cells, engine;
  try {
    const file = await courses.programmingFolder('shared-smoke','local');
    console.log('SMOKE_ROOT='+root);
    engine = await courses.forFile(file,'java');
    assert.equal(engine.target,PROGRAMMING_RUNTIME);
    cells = new NotebookCells(()=>({}),language=>courses.forFile(file,language),async()=>path.join(engine.root,'smoke-notebook'),60000);
    const results=[];
    for(const language of ['java','c','python','javascript','typescript','go','rust','sql','pglab','bash','zsh']) {
      const events=[];
      const run=await cells.run(language,courseExamples[language],'',{event:e=>events.push(e)});
      assert.equal(run.exit_code,0,language+': '+run.stderr);
      assert.ok(run.stdout.includes(readyMessage),language+': '+run.stdout);
      assert.deepEqual(events.slice(0,2),[{kind:'phase',phase:'preparing'},{kind:'phase',phase:'running'}]);
      assert.equal(run.runtime_target,PROGRAMMING_RUNTIME);
      results.push({language,exit:run.exit_code,target:run.runtime_target});
      console.log('PASS '+language);
    }
    // The runner accepts generated class names without modifying learner source.
    const sum = `public class Main {
    public static void main(String[] args) {
        int total = 0;
        for (int value : new int[] {1, 2, 3, 4, 5}) total += value;
        System.out.println("Total = " + total);
    }
}`;
    const named = await cells.run('java',sum.replace('public class Main','public class Sum'));
    assert.equal(named.exit_code,0,named.stderr);
    assert.equal(named.stdout,'Total = 15\n');
    const sumRun = await cells.run('java',sum);
    assert.equal(sumRun.exit_code,0,sumRun.stderr);
    assert.equal(sumRun.stdout,'Total = 15\n');
    const helperRun = await cells.run('java',`class Sum {
    private final int total;
    Sum(int total) { this.total = total; }
    int value() { return total; }
}
public class Main {
    public static void main(String[] args) {
        System.out.println("Total = " + new Sum(15).value());
    }
}`);
    assert.equal(helperRun.exit_code,0,helperRun.stderr);
    assert.equal(helperRun.stdout,'Total = 15\n');
    console.log('PASS Java example entry class and non-public helper');
    await cells.run('java','import java.nio.file.*; public class Main { public static void main(String[] a) throws Exception { Files.writeString(Path.of("shared.txt"),"shared from Java"); } }');
    const c=await cells.run('c','#include <stdio.h>\nint main() { char s[80]; FILE *f=fopen("shared.txt","r"); if(!f)return 1; fgets(s,80,f); fclose(f); puts(s); }');
    assert.equal(c.stdout,'shared from Java\n');
    console.log('PASS Java-to-C file sharing');
    const result={platform:process.platform,arch:process.arch,results,fileSharing:true,
      javaExamples:{namedClassExit:named.exit_code,mainExit:sumRun.exit_code,stdout:sumRun.stdout,helperExit:helperRun.exit_code}};
    if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {
    await cells?.close();
    await courses.stopAll();
    if(engine)await nativeRequire('./podman').run(engine.bin,['rm',engine.name]);
    console.log('Smoke containers stopped; build log: '+path.join(root,'build.log'));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
