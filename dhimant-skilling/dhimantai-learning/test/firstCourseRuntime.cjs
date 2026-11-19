// Run on the release platform with its local Podman machine and the published Data Science image.
const assert = require('node:assert/strict');
const {copyFile, mkdir, mkdtemp, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomUUID} = require('node:crypto');
const {findPodman, run, stream, checkWindowsResourceLimits, requireLocalConnection} = require('../out/src/podman');
const {CourseEngine} = require('../out/src/courseEngine');
const {NotebookCells} = require('../out/src/notebookCells');
const {firstPandasCell} = require('../out/src/starterExercises');

async function main() {
  const [image, receipt] = process.argv.slice(2);
  assert.match(image || '', /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/, 'Supply the published Data Science image by digest');
  const bin = await findPodman();
  assert.ok(bin, 'Start the local Podman machine used by the desktop');
  if (process.env.CONTAINER_HOST) requireLocalConnection(process.env.CONTAINER_HOST);
  else if (process.platform !== 'linux' || process.env.CONTAINER_CONNECTION) {
    const connections = JSON.parse(await run(bin, ['system','connection','list','--format','json']));
    const connection = connections.find(c => process.env.CONTAINER_CONNECTION ? c.Name === process.env.CONTAINER_CONNECTION : c.Default);
    assert.ok(connection, 'Select the local Podman connection used by the desktop');
    requireLocalConnection(connection.URI);
  }
  if (process.platform === 'win32') await checkWindowsResourceLimits(bin);
  const name = 'dhimantai-first-lesson-' + randomUUID();
  const folder = await mkdtemp(join(tmpdir(), name));
  const user = (process.getuid?.() ?? 1000) + ':' + (process.getgid?.() ?? 1000);
  let cells;
  try {
    await stream(bin, ['run','--detach','--name',name,'--pids-limit','1024','--memory','1536m','--cpus','2',
      '--volume',folder + ':/course' + (process.platform === 'linux' ? ':Z' : ''),
      ...(process.platform === 'linux' ? ['--userns=keep-id'] : []),'--user',user,'--env','HOME=/course',
      '--workdir','/course',image,'sleep','infinity'], message => process.stderr.write(message));
    const engine = new CourseEngine(bin,name,folder,true);
    const environment = join(folder,'.dhimantai');
    await mkdir(environment);
    await copyFile(join(__dirname,'../media/course/python_environment.py'),join(environment,'python_environment.py'));
    engine.pythonEnvironment = true;
    await run(bin,engine.execArgs(folder,'python',['-c','import sys; assert sys.prefix != sys.base_prefix']),100000);
    cells = new NotebookCells(() => ({}),async () => engine,async () => folder,60000);
    const outputs = [];
    for (const [source,expected] of [['print("Runtime ready")','Runtime ready'],[firstPandasCell,'10']]) {
      const result = await cells.run('python',source);
      assert.equal(result.status,'exited');
      assert.equal(result.exit_code,0,result.stderr);
      assert.equal(result.truncated,false);
      assert.equal(result.stdout.trim(),expected);
      outputs.push(result.stdout.trim());
    }
    const verified = JSON.stringify({platform:process.platform, arch:process.arch, image, outputs},null,2);
    if (receipt) await writeFile(receipt,verified + '\n',{flag:'wx'});
    console.log(verified);
  } finally {
    try { await cells?.close(); }
    finally {
      try { await run(bin,['rm','--force','--ignore',name]); }
      finally { await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
