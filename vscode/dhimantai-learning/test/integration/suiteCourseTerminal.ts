/** Real VS Code New Terminal profile, backed by a disposable course container. */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {CourseEngine} from '../../src/courseEngine';
import {courseTerminalOptions} from '../../src/courseTerminal';
import {COURSE_SHELL_TITLE, preferCourseShell} from '../../src/courseShellProfile';
import {run as podman} from '../../src/podman';
import {PracticeBrowser} from '../../src/practiceBrowser';

export async function run() {
  await vscode.extensions.getExtension('optficial.dhimantai-learning')!.activate();
  const folder=vscode.workspace.workspaceFolders![0], root=dirname(folder.uri.fsPath);
  const engine=new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!,process.env.DHIMANTAI_PROJECT_CONTAINER!,root);
  await podman(engine.bin,['exec','--user','0',engine.name,'python','/opt/dhimantai/user.py',
    String(process.getuid?.() ?? 1000),String(process.getgid?.() ?? 1000)]);
  const original=PracticeBrowser.prototype.courseTerminalOptions;
  PracticeBrowser.prototype.courseTerminalOptions=async()=>courseTerminalOptions(engine,'Course project',folder.uri.fsPath);
  let terminal:vscode.Terminal|undefined;
  try {
    const key='defaultProfile.'+(process.platform==='darwin'?'osx':process.platform==='win32'?'windows':'linux');
    const config=vscode.workspace.getConfiguration('terminal.integrated',folder.uri);
    await config.update(key,process.platform==='win32'?'PowerShell':'zsh',vscode.ConfigurationTarget.Workspace);
    await preferCourseShell(folder);
    assert.equal(config.get(key),COURSE_SHELL_TITLE);
    const before=new Set(vscode.window.terminals);
    await vscode.commands.executeCommand('workbench.action.terminal.new');
    for(let i=0;i<100;i++) {
      terminal=vscode.window.terminals.find(t=>!before.has(t));
      if(terminal)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(terminal,'New Terminal creates a container terminal');
    const options=terminal.creationOptions as vscode.TerminalOptions;
    assert.equal(options.shellPath,engine.bin);
    assert.equal(options.env?.DHIMANTAI_COURSE_CONTAINER,engine.name);
    // The marker crosses the real interactive terminal and the mounted course folder.
    terminal.sendText('python -c "import os,sys; from pathlib import Path; Path(\'terminal-proof.txt\').write_text(sys.platform + \'|\' + os.getcwd())"');
    let proof='';
    for(let i=0;i<100;i++) {
      proof=await readFile(join(folder.uri.fsPath,'terminal-proof.txt'),'utf8').catch(()=>'');
      if(proof)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(proof,'linux|/course/course-agent');
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({vscode:vscode.version,profile:COURSE_SHELL_TITLE,
      terminal:proof,passed:1,failed:0},null,2));
  } finally {terminal?.dispose();PracticeBrowser.prototype.courseTerminalOptions=original;}
}
