import * as vscode from 'vscode';
import {CourseWorkspaces} from './courseWorkspace';
import {Auth} from './auth';
import {registerPracticeKernel} from './practiceKernel';
import {practiceLink} from './practiceIpynb';
import {jupyterMetadata} from './notebookCommands';
import {ENVIRONMENTS} from './environments';

/** Course and Practice notebooks use the same cell execution and completion behavior. */
export function registerCourseKernel(courses:CourseWorkspaces,context:vscode.ExtensionContext,auth:Auth){
  const kernel=registerPracticeKernel(async(doc,language)=>{
    if(!courses.enabled)throw new Error('The course container is unavailable. Set up the course runtime before running.');
    const link=practiceLink(jupyterMetadata(doc),Object.keys(ENVIRONMENTS));
    const lesson=jupyterMetadata(doc).dhimantai_tutor_notebook?.lessonId;
    const engine=await courses.forFile(doc.uri,language,link?{lab:link.questionId}:typeof lesson==='string'?{lesson}:undefined);
    if(!engine)throw new Error('Choose Open Copy in Course, select the matching course, then run the cell in the copy.');
    return engine;
  },{id:'dhimantai-course',label:'dhimantAI Course · Podman',lab:doc=>courses.languageFor(doc.uri)==='pglab',wants:doc=>courses.enabled && !!courses.recordFor(doc.uri),
    resetEvents:reset=>[auth.onDidChange(()=>reset()),vscode.workspace.onDidChangeConfiguration(e=>{
      if(e.affectsConfiguration('dhimantai.environment')||e.affectsConfiguration('dhimantai.courseContainers'))reset();
    })]});
  context.subscriptions.push(kernel);
}
