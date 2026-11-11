/** Real VS Code + course-container final checks. GitHub mutation boundaries use controlled adapters. */
import * as assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { Auth } from '../../src/auth';
import { CourseEngine } from '../../src/courseEngine';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { CourseCatalog } from '../../src/courseCatalog';
import { PracticeBrowser } from '../../src/practiceBrowser';
import { ProjectResults } from '../../src/projectResults';
import { loadProjectCurriculum, runProjectCheck } from '../../src/projectCore';
import { submitProject } from '../../src/projectResults';
import { projectGitHub } from '../../src/projectGitHub';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

export async function run() {
  const results: object[] = [];
  const ext = vscode.extensions.getExtension<{auth: Auth; catalog: CourseCatalog; practice: PracticeBrowser; projectResults: ProjectResults}>('optficial.dhimantai-learning')!;
  const {auth, catalog, practice, projectResults} = await ext.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const originalEngine = CourseWorkspaces.prototype.forFile, originalRecord = CourseWorkspaces.prototype.recordFor;
  const engine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!, process.env.DHIMANTAI_PROJECT_CONTAINER!, dirname(root));
  CourseWorkspaces.prototype.forFile = async () => engine;
  CourseWorkspaces.prototype.recordFor = () => ({root, course: 'Python', key: 'test', account: 'test', environment: 'staging'});
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const account = (await auth.session())!.user.id;
  const env = vscode.workspace.getConfiguration('dhimantai').get<string>('environment', 'production');
  const cdp = await connect();
  const ui = (expression: string) => cdp.webview(`d => { if (!d.getElementById('submitProject')) return null; return (${expression})(d); }`);
  const state = () => ui(`d => ({step: d.getElementById('step').value, busy: d.getElementById('submitProject').disabled,
    status: d.getElementById('status').textContent, completion: d.getElementById('completion').textContent})`);
  const until = async (predicate: (value: any) => boolean, label: string) => {
    for (let n = 0; n < 400; n++) { const value = await state(); if (value && predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('Timed out: ' + label + ' ' + JSON.stringify(await state()));
  };
  const submit = () => ui(`d => {d.getElementById('submitProject').click(); return true;}`);
  const record = () => projectResults.get(env, account, root)!;
  try {
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(s => s.step === '0', 'Coach opened');
    await new Promise(r => setTimeout(r, 500));
    await ui(`d => { const step = d.getElementById('step'); step.value = '9'; step.dispatchEvent(new Event('change')); return true; }`);
    await until(s => s.step === '9' && !s.busy, 'Final milestone');
    await submit();
    await until(s => !s.busy && s.completion.includes('Needs work'), 'Starter rejected');
    assert.equal(record().submissions.at(-1)!.outcome, 'needs_work');
    results.push({step: 'unfinished starter final check', passed: true});

    mkdirSync(join(dirname(root), 'author/scripts'), {recursive: true});
    const reference = join(dirname(root), 'author/scripts/reference.py');
    copyFileSync(join(ext.extensionPath, 'scripts/projects/validate_course_agent.py'), reference);
    execFileSync(engine.bin, engine.execArgs(root, 'python', ['-c',
      'import runpy; from pathlib import Path; refs=runpy.run_path("/course/author/scripts/reference.py")["REFERENCE"]; [(Path("course_agent")/name).write_text(source) for name,source in refs.items()]']),
      {timeout: 15000, stdio: 'pipe'});
    await new Promise(r => setTimeout(r, 500));
    await submit();
    await until(s => !s.busy && record().submissions.length === 2, 'Skipped placeholder rejected');
    assert.equal(record().submissions.at(-1)!.outcome, 'needs_work');
    writeFileSync(join(root, 'tests/test_my_agent.py'), `import unittest\nfrom course_agent.search import search_documents\n\nclass StudentCase(unittest.TestCase):\n    def test_unmatched_query(self):\n        self.assertEqual(search_documents('absent', [{'id': 'one', 'title': 'Course', 'text': 'Read it'}], 3), [])\n`);
    execFileSync('git', ['add', '.'], {cwd: root});
    execFileSync('git', ['-c', 'user.name=Test learner', '-c', 'user.email=learner@example.test', 'commit', '-qm', 'Implement project and regression test'], {cwd: root});
    await new Promise(r => setTimeout(r, 500));
    await submit();
    await until(s => !s.busy && record().submissions.length === 3, 'Final checks finished');
    const saved = record().submissions.at(-1)!;
    assert.equal(saved.outcome, 'completed', JSON.stringify(saved.runs));
    assert.equal(saved.git.dirty, false);
    assert.equal(saved.git.head, execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim());
    assert.equal(record().submissions.length, 3);
    results.push({step: 'skipped tests rejected, complete project accepted with commit', passed: true});
    const empty = join(dirname(root), 'empty'); mkdirSync(empty);
    const plan = await loadProjectCurriculum(join(ext.extensionPath, 'media'), 'course-agent');
    const zero = await runProjectCheck(empty, {...plan.steps.at(-1)!, check: 'final:agent'}, 'empty', new AbortController().signal, engine);
    assert.equal(zero.status, 'failed'); assert.match(zero.output, /0 tests/);
    const reading = await loadProjectCurriculum(join(ext.extensionPath, 'media'), 'shelf-reading');
    const readingResult = await submitProject(join(dirname(root), 'shelf-reading'), reading,
      {coachTurns: 0, otherHelp: 'none_reported'}, 'Traced entry, storage, search and report; compared tests and fixture.', new AbortController().signal, engine);
    assert.equal(readingResult.outcome, 'completed'); assert.equal(readingResult.evidence, 'reading_checks_and_self_report');
    results.push({step: 'empty suite rejected and all shelf reading checks recorded as self-report', passed: true});

    await catalog.open();
    assert.match((catalog as any).panel.webview.html, /Completed locally · final checks passed/);
    const projectNode = (await practice.getChildren()).find(node => node.kind === 'project');
    assert.ok(projectNode); assert.match(String(practice.getTreeItem(projectNode).description), /Completed locally/);
    writeFileSync(join(root, 'EXPLANATION.md'), readFileSync(join(root, 'EXPLANATION.md'), 'utf8') + '\nNew evidence\n');
    await catalog.refresh();
    assert.match((catalog as any).panel.webview.html, /Changed since submission/);
    assert.match(String(practice.getTreeItem((await practice.getChildren()).find(node => node.kind === 'project')!).description), /Changed since submission/);
    execFileSync('git', ['add', '.'], {cwd: root});
    execFileSync('git', ['-c', 'user.name=Test learner', '-c', 'user.email=learner@example.test', 'commit', '-qm', 'Update explanation'], {cwd: root});
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(s => s.completion.includes('Changed since submission'), 'Reopened saved result');
    results.push({step: 'catalog and My Courses status, stale result and reopening', passed: true});

    const shelf = join(dirname(root), 'shelf-capstone');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach', shelf);
    await until(s => s.step === '0', 'Shelf capstone');
    await ui(`d => { const step = d.getElementById('step'); step.value = '6'; step.dispatchEvent(new Event('change')); return true; }`);
    await until(s => s.step === '6' && !s.busy, 'Shelf final milestone');
    await submit();
    await until(s => !s.busy && s.completion.includes('Needs work'), 'Shelf full checker rejected unfinished work');
    const shelfResult = projectResults.get(env, account, shelf)!.submissions.at(-1)!;
    assert.equal(shelfResult.outcome, 'needs_work'); assert.equal(shelfResult.runs[0].command, 'python check.py');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach', root);
    await until(s => s.step === '9', 'Return to submitted agent');
    results.push({step: 'Shelf capstone uses its complete Git/regression checker', passed: true});

    const getExtension = vscode.extensions.getExtension, info = vscode.window.showInformationMessage,
      external = vscode.env.openExternal, commands = vscode.commands.getCommands, execute = vscode.commands.executeCommand;
    let approved = false, pushes = 0, link = '', prArgs: any;
    const repo = {rootUri: vscode.Uri.file(root), state: {remotes: [{name: 'origin', pushUrl: 'git@github.com:learner/project.git'}]},
      status: async () => {}, push: async (remote: string, branch: string) => {assert.equal(remote, 'origin'); assert.equal(branch, 'main'); pushes++;}};
    const repositories = [repo];
    (vscode.extensions as any).getExtension = (id: string) => id === 'vscode.git' ? {activate: async () => ({getAPI: () => ({repositories})})} : undefined;
    (vscode.window as any).showInformationMessage = async (_message: string, _options: any, choice: string) => approved ? choice : undefined;
    (vscode.env as any).openExternal = async (uri: vscode.Uri) => {link = uri.toString(true); return true;};
    try {
      await projectGitHub(root, 'publish'); assert.equal(pushes, 0, 'cancelled publication cannot push');
      approved = true; await projectGitHub(root, 'publish'); assert.equal(pushes, 1);
      // The mocked push sets no upstream: the compare page would 404, so the learner is told to publish first.
      await assert.rejects(projectGitHub(root, 'pullRequest'), /Publish the main branch/); assert.equal(link, '');
      execFileSync('git', ['config', 'branch.main.remote', 'origin'], {cwd: root});
      execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], {cwd: root});
      await projectGitHub(root, 'pullRequest'); assert.match(link, /^https:\/\/github.com\/learner\/project\/compare\/main\?expand=1$/);
      (vscode.extensions as any).getExtension = (id: string) => id === 'vscode.git' ? {activate: async () => ({getAPI: () => ({repositories})})}
        : id === 'GitHub.vscode-pull-request-github' ? {activate: async () => {}} : undefined;
      (vscode.commands as any).getCommands = async () => ['pr.create'];
      (vscode.commands as any).executeCommand = async (command: string, args: any) => {assert.equal(command, 'pr.create'); prArgs = args;};
      await projectGitHub(root, 'pullRequest'); assert.deepEqual(prArgs, {repoPath: root, compareBranch: 'main'});
      repo.state.remotes = []; repositories.push(repo);
      await assert.rejects(projectGitHub(root, 'publish'), /only repository/);
      results.push({step: 'GitHub cancellation, scoped push, PR form and multiple repository guard (controlled)', passed: true});
    } finally {
      (vscode.extensions as any).getExtension = getExtension; (vscode.window as any).showInformationMessage = info;
      (vscode.env as any).openExternal = external; (vscode.commands as any).getCommands = commands; (vscode.commands as any).executeCommand = execute;
    }
    const out = process.env.DHIMANTAI_UX_OUT;
    if (out) { mkdirSync(out, {recursive: true}); const screenshot = await cdp.send('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(out, 'project-completion.png'), Buffer.from(screenshot.data, 'base64')); }
  } catch (error) { results.push({passed: false, error: String(error instanceof Error ? error.stack : error)}); throw error; }
  finally { CourseWorkspaces.prototype.forFile = originalEngine; CourseWorkspaces.prototype.recordFor = originalRecord;
    cdp.close(); writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2)); }
}
