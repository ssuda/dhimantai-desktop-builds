import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Api } from './api';
import { SkillingPathway, SkillingBrief, previewUrl, PREVIEW_PORTS, evidenceRequestId } from './skilling';
import { publicContextPath } from './projectContext';
import { stageProject, initializeProject } from './projectCore';
import { openProject } from './capstone';
import { CourseWorkspaces } from './courseWorkspace';
import { run } from './podman';

const interviewTimers=new WeakMap<vscode.ExtensionContext,vscode.Disposable>();
function startInterviewTimer(context:vscode.ExtensionContext) {
  interviewTimers.get(context)?.dispose();
  const item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,20),deadline=Date.now()+20*60*1000;
  let ticks=0;const update=()=>{
    const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));
    item.text=seconds?`$(clock) Interview ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'$(check) Interview time finished';
    item.tooltip='20-minute practice task. Explain your result and record the assistance used; this timer does not award certification.';
    if(!seconds||++ticks>=1201)clearInterval(timer);
  };
  const timer=setInterval(update,1000);update();item.show();
  const disposable={dispose:()=>{clearInterval(timer);item.dispose();interviewTimers.delete(context);}};
  interviewTimers.set(context,disposable);context.subscriptions.push(disposable);
}

export type SkillingMessage={type?:string;id?:string;fields?:Record<string,string>;requestId?:string};

/** Explicit selection; no workspace crawl, linked paths or automatically included private files. */
export async function selectedEvidence(root:string, paths:string[]) {
  const canonicalRoot=await realpath(root), files:{path:string;text:string}[]=[];
  for(const file of paths) {
    const path=relative(root,file).split('\\').join('/');
    if(!publicContextPath(path)||/(^|\/)(node_modules|vendor|dist|build)(\/|$)/.test(path)) throw new Error('Choose public source, test and documentation files within one project.');
    const info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>64000||await realpath(file)!==join(canonicalRoot,path)) throw new Error('Linked, binary or oversized evidence files cannot be submitted.');
    const text=await readFile(file,'utf8');
    if(text.includes('\0')||text.includes('\uFFFD')) throw new Error('Choose UTF-8 text files.');
    files.push({path,text});
  }
  if(!files.length||files.length>64||Buffer.byteLength(JSON.stringify(files))>260000) throw new Error('Choose 1–64 files totalling at most 260 KB.');
  if(new Set(files.map(f=>f.path)).size!==files.length) throw new Error('Select each evidence file once.');
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function createGuidedProject(context:vscode.ExtensionContext, plan:SkillingBrief,stillCurrent:()=>Promise<boolean>) {
  const parent=await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse',plan.course_title);
  if(!parent||!(await stillCurrent())) return;
  const name=await vscode.window.showInputBox({title:plan.brief.title,prompt:'New project folder name',value:`${plan.course_id}-${plan.kind}`,validateInput:v=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v)?null:'Use letters, numbers, hyphens or underscores.'});
  if(!name||!(await stillCurrent())) return;
  const destination=join(parent.fsPath,name);
  await stageProject(destination,async root=>{
    await mkdir(join(root,'src'),{recursive:true});await mkdir(join(root,'tests'));
    await writeFile(join(root,'.dhimantai-project.json'),JSON.stringify({id:'skilling-project',version:1}));
    await writeFile(join(root,'.dhimantai-skilling.json'),JSON.stringify({course_id:plan.course_id,kind:plan.kind,title:plan.brief.title,requirements:plan.brief.requirements,profile_hash:plan.profile_hash,language:plan.language}));
    await writeFile(join(root,'README.md'),`# ${plan.brief.title}\n\n${plan.brief.requirements}\n\n## Acceptance criteria\n\nState observable inputs, outputs and failure behaviour.\n\n## Run and test\n\nAdd reproducible commands for the course container.\n\n${plan.brief.milestones.map(m=>`## ${m.title}\n\n${m.task}`).join('\n\n')}\n`);
    await writeFile(join(root,'EXPLANATION.md'),'# Design and evidence\n\nRecord predictions, trade-offs, test results, limitations and assistance.\n');
    await writeFile(join(root,'src/README.md'),'Add your implementation here using this course’s language and technology stack.\n');
    await writeFile(join(root,'tests/README.md'),'Add tests for normal, boundary and failure cases. Document how to run them in the course container.\n');
    await writeFile(join(root,'.gitignore'),'.env*\n.home/\n.dhimantai-local/\nnode_modules/\n__pycache__/\n');
    await initializeProject(root);
  });
  if(await stillCurrent())await openProject(context,plan.brief.title,destination,true);
}

export async function skillingAction(message:SkillingMessage,api:Api,course:string,data:SkillingPathway|undefined,
    context:vscode.ExtensionContext,stillCurrent:()=>Promise<boolean>,owner:string):Promise<boolean> {
  const fields=message.fields??{},type=message.type??'';
  if(type==='nextCourse') { if(message.id) await vscode.commands.executeCommand('dhimantai.courseCatalog',message.id);return true; }
  if(type==='skillingProject') {
    const plan=await api.skillingBrief(course,message.id??'',fields.customRequirements??'');
    if(await stillCurrent()) await createGuidedProject(context,plan,stillCurrent);return true;
  }
  if(type==='skillingSubmit') {
    const milestone=data?.pathway.milestones.find(m=>m.id===fields.kind);
    if(!milestone?.unlocked||!data?.pathway.profile) throw new Error('Refresh the roadmap and choose an unlocked milestone.');
    if(!fields.title?.trim()||!fields.requirements?.trim()||!fields.explanation?.trim()||!fields.assistance) throw new Error('Complete the evidence form and declare assistance.');
    const root=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,title:'Choose the project whose public files you will submit'});
    if(!root?.[0]) return true;
    const selected=await vscode.window.showOpenDialog({defaultUri:root[0],canSelectMany:true,canSelectFiles:true,canSelectFolders:false,title:'Select public source, tests and documentation for independent review'});
    if(!selected?.length) return true;
    const files=await selectedEvidence(root[0].fsPath,selected.map(f=>f.fsPath));
    if(!(await stillCurrent())) return true;
    const confirm=await vscode.window.showInformationMessage(`Submit ${files.length} files for independent assessment?`,{modal:true,detail:files.map(f=>f.path).join('\n')+'\n\nThese files, requirements, explanation and assistance declaration will be stored for your assigned assessor. The submitted snapshot is immutable.'},'Submit evidence');
    if(!confirm||!(await stillCurrent())) return true;
    const evidence={kind:fields.kind,profile_hash:data.pathway.profile.fingerprint,basis:milestone.basis,
      payload:{title:fields.title,requirements:fields.requirements,explanation:fields.explanation,assistance:fields.assistance,files}};
    await api.submitSkilling(course,{...evidence,request_id:evidenceRequestId(message.requestId??randomUUID(),evidence)});return true;
  }
  if(type==='weeklyStart') {await api.startSkillingWeekly(course);return true;}
  if(type==='weeklySubmit') {
    const attempt=data?.weekly.find(w=>w.id===message.id);
    if(!attempt||attempt.submission_id) throw new Error('Refresh and resume an unfinished weekly mock.');
    const answers=Object.fromEntries(attempt.questions.map(q=>[q.id,fields[`answer:${attempt.id}:${q.id}`]??'']));
    if(Object.values(answers).some(a=>!a.trim())) throw new Error('Answer every weekly question before submitting.');
    await api.submitSkillingWeekly(attempt.id,answers,fields[`weeklyAssistance:${attempt.id}`]??'');return true;
  }
  if(type==='challenge'||type==='interview'||type==='authoredChallenge') {
    const [authoredTopic,authoredId]=(fields.challenge??'').split('|');
    const topic=data?.topics.find(t=>t.key===(type==='authoredChallenge'?authoredTopic:fields.topic));if(!topic) throw new Error('Choose a published course topic.');
    const challenge=topic.challenges.find(c=>c.id===(type==='authoredChallenge'?authoredId:message.id));
    const markdown=type==='interview'?`# Interview practice · ${topic.topic}\n\n${topic.interview.map((q,i)=>`${i+1}. ${q}`).join('\n\n')}\n\nAllow 20 minutes for the implementation task. Record your elapsed time, assumptions, results and assistance. This is interview practice, not certification evidence.`
      :`# ${challenge?.title}\n\n${challenge?.prompt}\n\nRecord your prediction, implementation, actual output and explanation. Use Ask about This Notebook for help. This supplementary task does not automatically award course marks.`;
    if(type!=='interview'&&!challenge) throw new Error('Choose an available challenge.');
    const stack=data?.pathway.profile?.technology_stack??[];const language=stack.includes('Java')?'java':stack.includes('C17')?'c':stack.includes('SQL')||stack.includes('PostgreSQL')?'sql':'python';
    if(await stillCurrent()) {
      const courseTitle=data!.pathway.profile!.title;
      await vscode.commands.executeCommand('dhimantai.openPracticeNotebook','',owner,courseTitle,{assessment:'practice_only',
        title:type==='interview'?`Interview practice · ${topic.topic}`:challenge!.title,question:markdown,course:courseTitle,language});
      if(type==='interview'&&await stillCurrent())startInterviewTimer(context);
    }return true;
  }
  return false;
}

export function registerProjectPreview(courses:CourseWorkspaces) {
  return vscode.commands.registerCommand('dhimantai.projectPreview',async()=>{
    try {
      if(!vscode.workspace.isTrusted) throw new Error('Trust the project before connecting to its running application.');
      const root=vscode.workspace.workspaceFolders?.find(f=>courses.recordFor(f.uri))?.uri;
      if(!root) throw new Error('Open a project inside its managed course folder.');
      const selected=await vscode.window.showQuickPick(PREVIEW_PORTS.map(port=>({label:String(port),port})),{title:'Preview running project',placeHolder:'Start your app in the course terminal, listening on 0.0.0.0 at one of these ports.'});
      if(!selected) return;
      const engine=await courses.forFile(root);if(!engine) throw new Error('Set up the course runtime first.');
      const mapping=await run(engine.bin,['port',engine.name,`${selected.port}/tcp`]);
      const url=previewUrl(mapping);
      const response=await fetch(url,{signal:AbortSignal.timeout(4000),redirect:'manual'}).catch(()=>undefined);
      if(!response) throw new Error('The application is not responding. Start it in the course terminal, or rebuild an older runtime to enable preview ports.');
      await response.body?.cancel();
      await vscode.commands.executeCommand('simpleBrowser.show',url,{viewColumn:vscode.ViewColumn.Beside,preserveFocus:true});
    } catch(error) {void vscode.window.showErrorMessage(error instanceof Error?error.message:'Project preview is unavailable.');}
  });
}
