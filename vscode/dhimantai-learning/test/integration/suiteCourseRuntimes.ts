// Opt-in desktop acceptance test. Run on a machine with Podman available.
import * as assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import type { activate } from '../../src/extension';
import { findPodman, run as podman } from '../../src/podman';
import * as podmanSetup from '../../src/podman';
import { CourseEngine } from '../../src/courseEngine';
import { verifyCourseLanguage } from '../../src/courseReadiness';
import { RunTerminal } from '../../src/nativeRun';
import { openCourseTerminal, runInCourseTerminal } from '../../src/courseTerminal';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

export async function run() {
  const bin = await findPodman();
  assert.ok(bin, 'Install Podman before running the course integration suite.');
  const ext = vscode.extensions.getExtension<NonNullable<Awaited<ReturnType<typeof activate>>>>(
    'optficial.dhimantai-learning'
  )!;
  const { auth, practice } = await ext.activate();
  // These checks cover the Practice panel; suitePracticeNotebook covers the notebook flow.
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  const cfg = vscode.workspace.getConfiguration('dhimantai');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhimantai-course-test-')));
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const open = async (row: Awaited<ReturnType<typeof practice.getChildren>>[number]) => {
    assert.equal(practice.getTreeItem(row).command, undefined, 'browsing must never install a runtime');
    assert.match(practice.getTreeItem(row).contextValue!, /^dhimantaiCourse/);
    await vscode.commands.executeCommand('dhimantai.openCourse', row);
    const doc = vscode.window.activeNotebookEditor?.notebook;
    assert.ok(doc && doc.uri.scheme === 'file' && !vscode.env.remoteName);
    const folder = dirname(dirname(doc.uri.fsPath));
    assert.equal(dirname(folder), join(root, 'courses'));
    assert.match(await readFile(join(folder, 'Dockerfile'), 'utf8'), /FROM docker.io\/library\/python/);
    return { folder, doc };
  };
  const execute = async (doc: vscode.NotebookDocument, success = true) => {
    const cell = doc.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code)!;
    await vscode.commands.executeCommand(
      'notebook.cell.execute',
      { start: cell.index, end: cell.index + 1 },
      doc.uri
    );
    for (let i = 0; i < 1200 && cell.executionSummary?.success === undefined; i++) await wait(100);
    assert.equal(cell.executionSummary?.success, success);
    return cell.outputs.flatMap((o) => o.items.map((i) => Buffer.from(i.data).toString())).join('');
  };
  try {
    const delayed = new RunTerminal();
    let displayed = '';
    const output = delayed.onDidWrite(text => { displayed += text; });
    delayed.print('$ python main.py\n');
    delayed.print('finished before the renderer opened\n');
    assert.equal(displayed, '');
    delayed.open();
    assert.match(displayed, /\$ python main.py\r\nfinished before the renderer opened/);
    output.dispose(); delayed.close();
    await cfg.update('exercisesFolder', root, vscode.ConfigurationTarget.Global);
    await auth.signInWithPassword(EMAIL, PASSWORD);
    const [python, llm] = await practice.getChildren();
    const ensure = podmanSetup.ensurePodman;
    let attempts = 0;
    try {
      (podmanSetup as any).ensurePodman = async () => { attempts++; throw new Error('Podman is unavailable'); };
      await assert.rejects(practice.setupCourse(python as any), /Podman is unavailable/);
      assert.equal(attempts, 2, 'setup attempts one automatic repair and never uses host tools');
    } finally { (podmanSetup as any).ensurePodman = ensure; }
    const courseRoot = (await practice.setupCourse(python as any))!;
    const pendingRoot = courseRoot.fsPath;
    const options = await practice.courseTerminalOptions(courseRoot);
    assert.ok(options, 'opening the terminal sets up an unprepared course');
    assert.equal(options.shellPath, bin);
    const args = options.shellArgs as string[];
    assert.deepEqual(args.slice(-2), ['/bin/zsh', '-il']);
    const container = args[args.length - 3];
    assert.ok(!vscode.window.terminals.some(t => t.creationOptions && 'env' in t.creationOptions &&
      t.creationOptions.env?.DHIMANTAI_COURSE_CONTAINER === container), 'setup leaves the optional course terminal closed');
    const shell = await podman(bin, ['exec', '--workdir', '/course', container, '/bin/zsh', '-ilc',
      'print -r -- "$PWD|$HOME|$SHELL|$ZSH|$ZSH_THEME"; print -P -- "$PROMPT"; sudo -n id -u'], 60000);
    assert.match(shell, /\/course\|\/course\/\.home\|\/bin\/zsh\|\/opt\/oh-my-zsh\|robbyrussell/);
    assert.match(shell, /\n0$/);
    assert.match(shell, /\$ /, 'the interactive course shell has an explicit dollar prompt');
    const terminalEngine = new CourseEngine(bin, container, pendingRoot);
    const terminal = openCourseTerminal(terminalEngine);
    const terminalId = 'env' in terminal.creationOptions ? terminal.creationOptions.env?.DHIMANTAI_TERMINAL_ID : undefined;
    assert.ok(terminalId);
    terminal.sendText('sleep 5');
    for (let i = 0; i < 50; i++) {
      if (await podman(bin, ['exec', container, 'python', '/opt/dhimantai/terminal.py', 'state', terminalId]) === 'busy') break;
      await wait(100);
    }
    await assert.rejects(runInCourseTerminal(terminalEngine, pendingRoot, 'echo', ['must not run'], '', 5000, () => {}), /terminal is busy/);
    terminal.sendText('\x03', false);
    await wait(250);
    if (process.env.DHIMANTAI_TEST_ALL_LANGUAGES === '1') {
      const engine = new CourseEngine(bin, container, pendingRoot);
      for (const language of ['python', 'javascript', 'typescript', 'c', 'java', 'go', 'rust']) {
        await podman(bin, ['exec', '--user', '0', container, '/usr/local/sbin/dhimantai-language', language], 600000);
        await verifyCourseLanguage(engine, language);
      }
      for (const command of ['npm --version', 'mvn --version', 'cmake --version', 'go version', 'cargo --version'])
        assert.ok(await podman(bin, ['exec', container, '/bin/zsh', '-ilc', command], 60000));
      console.log('All seven course languages and their package/build tools passed.');
    }
    await writeFile(join(pendingRoot, '.home', '.zshrc'), '\n# learner customization\n', {flag:'a'});
    const { folder, doc } = await open(python);
    assert.match(await readFile(join(folder, '.home', '.zshrc'), 'utf8'), /learner customization/);
    assert.match(await execute(doc), /Course environment ready/);
    const download = join(root, 'download.ipynb');
    const content = JSON.parse(await readFile(doc.uri.fsPath, 'utf8'));
    content.cells[0].source = 'print("edited before import")';
    await writeFile(download, JSON.stringify(content));
    const outside = await vscode.workspace.openNotebookDocument(vscode.Uri.file(download));
    await vscode.window.showNotebookDocument(outside);
    await vscode.commands.executeCommand('notebook.selectKernel', {
      id: 'dhimantai-course', extension: 'optficial.dhimantai-learning'
    });
    assert.match(await execute(outside, false), /Open Copy in Course/);
    const pick = vscode.window.showQuickPick, info = vscode.window.showInformationMessage;
    try {
      (vscode.window as any).showQuickPick = async () => 'Python';
      (vscode.window as any).showInformationMessage = async (_msg: string, options: any, save: string) => options?.modal ? save : undefined;
      await vscode.commands.executeCommand('dhimantai.openCopyInCourse');
    } finally {
      (vscode.window as any).showQuickPick = pick;
      (vscode.window as any).showInformationMessage = info;
    }
    const copied = vscode.window.activeNotebookEditor!.notebook;
    assert.equal(dirname(copied.uri.fsPath), join(folder, 'notebooks'));
    assert.match(await execute(copied), /edited before import/);
    const labs = await open(llm);
    assert.match(await execute(labs.doc), /tensor/);
    assert.equal((await readdir(join(labs.folder, 'notebooks'))).filter((s) => s.endsWith('.ipynb')).length, 7);
    // The Practice notebook runs, tests and traces exercise code in this same container.
    const source = 'import sys\nprint(sys.platform)\n', input = {source, stdin: '', argv: [], files: []};
    const course = new CourseEngine(bin, container, pendingRoot);
    assert.equal((await course.run('python', input)).stdout.trim(), 'linux');
    const tested = await course.tests('python', input, [{id: 't1', kind: 'stdio', stdin: '', expected: 'linux\n'}]);
    assert.ok(tested.every(test => test.verdict === 'passed'));
    assert.ok((await course.trace(input)).steps.length > 0);

    const name = 'dhimantai-course-' + basename(folder).split('-').at(-1);
    const id = () => podman(bin, ['inspect', '--format', '{{.Id}}', name]);
    const first = await id();
    await podman(bin, ['stop', '--time', '1', name]);
    await open(python);
    assert.equal(await id(), first);
    await writeFile(join(folder, 'requirements.txt'), '# custom course requirements\n', { flag: 'a' });
    await open(python);
    assert.notEqual(await id(), first);
    assert.match(await readFile(join(folder, '.home', '.zshrc'), 'utf8'), /learner customization/);
    await vscode.commands.executeCommand('dhimantai.courseDockerfile');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, join(folder, 'Dockerfile'));
    await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', QUESTION_ID, (await auth.session())!.user.id, 'Python');
    if (process.env.DHIMANTAI_VISUAL_REVIEW === '1') {
      console.log('Notebook and course terminal ready for visual review.');
      await wait(120000);
    }
    await writeFile(
      process.env.DHIMANTAI_TEST_RESULTS!,
      'Python and Build an LLM from Scratch course runtime checks passed.\n'
    );
  } finally {
    // Remove only containers owned by this run's unique temporary course roots.
    for (const dir of await readdir(join(root, 'courses')).catch(() => [])) {
      const key = dir.split('-').at(-1)!;
      const name = 'dhimantai-course-' + key;
      if (
        (await podman(bin, ['inspect', '--format', '{{index .Config.Labels "ai.dhimant.course"}}', name]).catch(
          () => ''
        )) === key
      )
        await podman(bin, ['rm', '-f', name]);
    }
    await rm(root, { recursive: true, force: true });
  }
}
