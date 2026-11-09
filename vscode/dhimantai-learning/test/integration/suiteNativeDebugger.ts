import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { CourseEngine } from '../../src/courseEngine';
import { NotebookDebugger } from '../../src/notebookDebugger';
import type { NativeDebugState } from '../../src/debugEvidence';

async function until(check:() => boolean, label:string) {
  for (let i=0; i<300; i++) { if (check()) return; await new Promise(r => setTimeout(r,50)); }
  throw new Error('Timed out: ' + label);
}

export async function run() {
  const extension = vscode.extensions.getExtension('optficial.dhimantai-learning')!;
  await extension.activate();
  const results: object[] = [];
  const course = process.env.DHIMANTAI_NATIVE_COURSE_CONFIG ? JSON.parse(readFileSync(process.env.DHIMANTAI_NATIVE_COURSE_CONFIG,'utf8')) : undefined;
  const engine = course ? new CourseEngine(course.bin,course.name,course.root) : undefined;
  const languages = process.env.DHIMANTAI_NATIVE_LANGUAGES ? process.env.DHIMANTAI_NATIVE_LANGUAGES.split(',') : ['javascript','typescript',...(process.env.DHIMANTAI_NATIVE_PYTHON === '1' ? ['python'] : [])];
  for (const language of languages) {
    let state:NativeDebugState | undefined, pauses=0;
    const controller = new NotebookDebugger(vscode.Uri.joinPath(extension.extensionUri,'media'),(_snapshot,next) => {
      state = next; if (next.phase === 'paused' && next.canInspect) pauses++;
    });
    const source = language === 'c'
      ? '#include <stdio.h>\nint twice(int n) {\n  int doubled = n * 2;\n  return doubled;\n}\nint main(void) {int input; scanf("%d", &input); printf("%d\\n", twice(input));}\n'
      : language !== 'python'
      ? 'function twice(n) {\n  const doubled = n * 2;\n  return doubled;\n}\nconst input = Number(require("fs").readFileSync(0,"utf8"));\nconsole.log(twice(input));\n'
      : 'def twice(n):\n    doubled = n * 2\n    return doubled\n\nvalue = int(input())\nprint(twice(value))\n';
    const typedSource = language === 'typescript' ? source.replace('twice(n)','twice(n: number)') : source;
    const snapshot = {snippet:'code-1',revision:1,language,source:typedSource,stdin:'21\n',question:'Double the input.'};
    let session:vscode.DebugSession | undefined;
    const started = vscode.debug.onDidStartDebugSession(s => { if (s.configuration.__dhimantaiNotebookDebug || s.parentSession?.configuration.__dhimantaiNotebookDebug) session = s; });
    try {
      await controller.start(snapshot,engine,{tsc:require.resolve('typescript/bin/tsc'),
        ...(process.env.DHIMANTAI_NATIVE_PYTHON_PATH ? {python:process.env.DHIMANTAI_NATIVE_PYTHON_PATH} : {})},async () => true);
      await until(() => !!session && state?.phase === 'paused','first native pause for ' + language);
      const initial = await controller.inspect(snapshot);
      assert.ok(initial.line >= 1);
      assert.ok(initial.frames[0].selectedSource);
      const document = vscode.workspace.textDocuments.find(d => d.uri.fsPath.includes('.dhimantai-debug-') && d.getText() === typedSource)!;
      assert.ok(document,'native source copy is open');
      assert.ok(vscode.debug.breakpoints.some(b => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === document.uri.toString()),'launch adds a real VS Code breakpoint');
      const line = language === 'c' ? 4 : 3;
      const breakpoints = await session!.customRequest('setBreakpoints',{source:{path:document.uri.fsPath},breakpoints:[{line:line - 1}]});
      assert.ok(breakpoints.breakpoints.some((b:any) => b.verified),'adapter verified the breakpoint');
      const threads = await session!.customRequest('threads'); const threadId = threads.threads[0].id;
      const previous = pauses;
      await session!.customRequest('continue',{threadId});
      await assert.rejects(controller.currentEvidence(snapshot,initial.id),/no longer current/);
      await until(() => pauses > previous && state?.phase === 'paused','breakpoint inside function');
      const beforeAssignment = await controller.inspect(snapshot), beforeOver = pauses;
      assert.equal(beforeAssignment.line,line - 1);
      assert.ok(beforeAssignment.variables.some(v => v.name === 'n' && v.value === '21'));
      await session!.customRequest('next',{threadId});
      await assert.rejects(controller.currentEvidence(snapshot,beforeAssignment.id),/no longer current/);
      await until(() => pauses > beforeOver && state?.phase === 'paused','native Step Over');
      const evidence = await controller.inspect(snapshot);
      assert.equal(evidence.line,line);
      assert.ok(evidence.variables.some(v => v.name === 'n' && v.value === '21'),JSON.stringify(evidence));
      assert.ok(evidence.variables.some(v => v.name === 'doubled' && v.value === '42'),JSON.stringify(evidence));
      assert.ok(evidence.frames.some(f => /twice/.test(f.name)));
      const beforeStep = pauses;
      await session!.customRequest('stepOut',{threadId});
      await assert.rejects(controller.currentEvidence(snapshot,evidence.id),/no longer current/);
      await until(() => pauses > beforeStep || state?.phase === 'stopped','native Step Out');
      await controller.stop();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),typedSource.replace('n * 2','n * 3'));
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.equal(await controller.import(snapshot),typedSource.replace('n * 2','n * 3'));
      await assert.rejects(controller.import({...snapshot,revision:2,source:'new notebook work'}),/preserve both versions/);
      results.push({language,runtime:engine ? 'course' : 'local',ok:true,breakpoint:true,stdin:true,locals:true,callStack:true,stepOver:true,stepOut:true,staleStateRejected:true,import:true});
    } catch (error) {
      let stack;
      if (session && state?.phase === 'paused') try {
        const threads = await session.customRequest('threads');
        stack = await session.customRequest('stackTrace',{threadId:threads.threads[0].id,levels:3});
      } catch { /* disconnected */ }
      results.push({language,runtime:engine ? 'course' : 'local',ok:false,error:String(error instanceof Error ? error.stack : error),state,stack});
      throw error;
    } finally {
      await controller.stop(); controller.dispose(); started.dispose();
      writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify(results,null,2));
    }
  }
}
