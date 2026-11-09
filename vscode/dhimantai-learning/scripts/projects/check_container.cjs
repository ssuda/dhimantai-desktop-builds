/* Real local Podman acceptance against an existing course image; owns and removes its test container. */
const {execFileSync} = require('node:child_process');
const {mkdtempSync, cpSync, readFileSync, rmSync, mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {randomUUID} = require('node:crypto');
const {CourseEngine} = require('../../out/src/courseEngine');
const {createReadingProject, loadProjectCurriculum, projectSnapshot, runProjectCheck} = require('../../out/src/projectCore');

async function main() {
  const image = process.env.DHIMANTAI_PROJECT_IMAGE;
  if (!image) throw new Error('Set DHIMANTAI_PROJECT_IMAGE to an existing local course runtime image.');
  const podman = process.env.DHIMANTAI_PODMAN || 'podman';
  const extension = resolve(__dirname, '../..');
  // On macOS Podman shares /Users; the host's /var temporary directory may be a different VM path.
  const root = mkdtempSync(join(extension, '.project-container-')), project = join(root,'projects','my agent');
  const name = 'dhimantai-project-check-' + randomUUID().slice(0,8);
  let created = false;
  try {
    mkdirSync(join(root,'projects'));
    cpSync(join(extension,'media/projects/course-agent'),project,{recursive:true});
    const user = process.platform === 'win32' ? '1000:1000' : `${process.getuid()}:${process.getgid()}`;
    execFileSync(podman,['run','--detach','--pull=never','--name',name,'--user',user,'--volume',root+':/course',image,'sleep','300'],{timeout:30000,stdio:'pipe'});
    created = true;
    const engine = new CourseEngine(podman,name,root);
    const curriculum = JSON.parse(readFileSync(join(extension,'media/projects/course-agent.json'),'utf8'));
    const snapshot = await projectSnapshot(project,curriculum,[]);
    const setup = await runProjectCheck(project,curriculum.steps[0],snapshot.digest,new AbortController().signal,engine);
    if (setup.status !== 'passed') {
      const diagnostic = execFileSync(podman,engine.execArgs(project,'python',['-c','import os,sys; print(os.getcwd()); print(os.listdir()); print(sys.path)']),{encoding:'utf8',timeout:10000});
      throw new Error('Container setup failed: '+setup.output+'\n'+diagnostic);
    }
    const unfinished = await runProjectCheck(project,curriculum.steps[1],snapshot.digest,new AbortController().signal,engine);
    if (unfinished.status !== 'failed' || !unfinished.output.includes('NotImplementedError')) throw new Error('Starter did not fail at the expected task.');
    const cwd = execFileSync(podman,engine.execArgs(project,'pwd',[]),{encoding:'utf8',timeout:10000}).trim();
    if (cwd !== '/course/projects/my agent') throw new Error('Wrong project working directory: '+cwd);
    const reading = [];
    for (const id of ['shelf-reading','rich-reading']) {
      const folder = join(root,'projects',id);
      await createReadingProject(join(extension,'media'),id,folder);
      const plan = await loadProjectCurriculum(join(extension,'media'),id);
      const observed = await projectSnapshot(folder,plan,[]);
      const outcomes = [];
      for (const step of plan.steps) {
        const result = await runProjectCheck(folder,step,observed.digest,new AbortController().signal,engine);
        if (result.status !== 'passed') throw new Error(id+' '+step.id+': '+result.status+'\n'+result.output);
        if (step.check === 'shelf:search' && !result.output.includes('No books found')) throw new Error('Shelf search observation changed.');
        if (step.check === 'rich:text' && !result.output.includes("'Hello, reader!\\n'")) throw new Error('Rich text observation changed.');
        outcomes.push(step.id);
      }
      reading.push({id,steps:outcomes});
    }
    mkdirSync(join(root,'author','scripts'), {recursive:true});
    cpSync(join(__dirname,'validate_course_agent.py'),join(root,'author/scripts/validate_course_agent.py'));
    execFileSync(podman,engine.execArgs(project,'python',['-c',
      'import runpy,sys; from pathlib import Path; refs=runpy.run_path(sys.argv[1])["REFERENCE"]; [(Path(sys.argv[2])/"course_agent"/name).write_text(source) for name,source in refs.items()]',
      '/course/author/scripts/validate_course_agent.py', engine.path(project)]), {timeout:10000,stdio:'pipe'});
    for (const scenario of ['submission','missing']) {
      const demo = execFileSync(podman,engine.execArgs(project,'python',['-m','course_agent','--scenario',scenario,'--trace']),{encoding:'utf8',timeout:10000});
      if (!demo.includes('Mode: scripted simulation')) throw new Error('Missing simulation mode label.');
      if (!demo.includes('Status: '+(scenario === 'submission' ? 'answered' : 'insufficient_evidence'))) throw new Error('Wrong scenario outcome.');
    }
    // A hanging learner check must die inside the container, even if its client exits.
    writeFileSync(join(project,'checks/test_timeout.py'),'import time\ntime.sleep(90)\n');
    const timed = await runProjectCheck(project,{...curriculum.steps[0],check:'checks.test_timeout'},snapshot.digest,new AbortController().signal,engine);
    if (timed.status !== 'timed_out') throw new Error('Expected a bounded container timeout: '+JSON.stringify(timed));
    const processes = execFileSync(podman,['top',name,'args'],{encoding:'utf8',timeout:10000});
    if (processes.includes('checks.test_timeout')) throw new Error('Learner process survived the deadline.');
    console.log(JSON.stringify({runtime:'existing course image',image,setup:setup.status,unfinished:unfinished.status,scriptedDemos:2,reading,cwd,timeout:timed.status,remainingLearnerProcesses:0}));
  } finally {
    if (created) execFileSync(podman,['rm','--force',name],{timeout:15000,stdio:'pipe'});
    rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message, error.stdout?.toString() || '', error.stderr?.toString() || '');process.exitCode=1;});
