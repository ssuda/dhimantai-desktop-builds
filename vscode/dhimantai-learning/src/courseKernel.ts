import * as vscode from 'vscode';
import {CourseWorkspaces} from './courseWorkspace';
import {Auth} from './auth';
import {registerPracticeKernel} from './practiceKernel';

/** Course and Practice notebooks use the same cell execution and completion behavior. */
export function registerCourseKernel(courses:CourseWorkspaces,context:vscode.ExtensionContext,auth:Auth){
  const kernel=registerPracticeKernel(async(doc,language)=>{
    if(!courses.enabled)throw new Error('Enable course containers to use this runtime.');
    const engine=await courses.forFile(doc.uri,language);
    if(!engine)throw new Error('Choose Open Copy in Course, select the matching course, then run the cell in the copy. To run here, select a local language kernel.');
    return engine;
  },{id:'dhimantai-course',label:'dhimantAI Course · Podman',lab:doc=>courses.languageFor(doc.uri)==='pglab',wants:doc=>courses.enabled && !!courses.recordFor(doc.uri),
    resetEvents:reset=>[auth.onDidChange(()=>reset()),vscode.workspace.onDidChangeConfiguration(e=>{
      if(e.affectsConfiguration('dhimantai.environment')||e.affectsConfiguration('dhimantai.courseContainers'))reset();
    })]});
  context.subscriptions.push(kernel);
}
