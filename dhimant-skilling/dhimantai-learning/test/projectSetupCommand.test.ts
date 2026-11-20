import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

test('start command validates new and reopened projects and reports setup failures without opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-command-'));
  try {
    const extension = resolve(__dirname, '../..'), modulePath = join(extension, 'out/src/capstone.js');
    let command!: (id: string) => Promise<void>, runtimeFailure = false;
    const opened: string[] = [], errors: string[] = [];
    const vscode = {
      Uri: {file: (fsPath: string) => ({fsPath}), joinPath: (uri: {fsPath: string}, ...parts: string[]) => ({fsPath: join(uri.fsPath, ...parts)})},
      commands: {
        registerCommand: (_id: string, callback: typeof command) => { command = callback; },
        executeCommand: async (id: string, uri?: {fsPath: string}) => {
          if (id === 'dhimantai.projectFolder') {
            if (runtimeFailure) throw new Error('Controlled container setup failure');
            return {fsPath: root};
          }
          assert.equal(id, 'vscode.openFolder');
          assert.ok(uri!.fsPath.endsWith('.code-workspace'));
          opened.push(JSON.parse(await readFile(uri!.fsPath, 'utf8')).folders[0].path);
        },
      },
      window: {showInformationMessage: async () => 'Open in New Window', showErrorMessage: async (message: string) => { errors.push(message); }},
    };
    // Exercise the shipped command with real repositories and a recording VS Code API boundary.
    const exports: any = {}, realRequire = createRequire(modulePath);
    runInNewContext(await readFile(modulePath, 'utf8'), {
      exports, require: (id: string) => id === 'vscode' ? vscode : realRequire(id),
    });
    exports.registerCapstone({extensionUri: {fsPath: extension}, globalStorageUri: {fsPath: join(root, 'storage')}});
    await command('course-agent');
    const project = join(root, 'course-research-agent');
    assert.deepEqual(opened, [project]);
    await command('course-agent');
    assert.equal(opened.length, 2);
    await rm(join(project, 'course_agent/agent.py'));
    await command('course-agent');
    assert.equal(opened.length, 2, 'an incomplete existing project never opens');
    assert.match(errors.pop()!, /course_agent\/agent.py.*workspace was not opened/);

    runtimeFailure = true;
    await command('shelf');
    assert.match(errors.pop()!, /Could not set up the course runtime.*Controlled container setup failure/);
    assert.equal(opened.length, 2);
    runtimeFailure = false;
    const brokenExtension = join(root, 'missing-bundle');
    exports.registerCapstone({extensionUri: {fsPath: brokenExtension}, globalStorageUri: {fsPath: join(root, 'storage')}});
    await command('shelf');
    assert.match(errors.pop()!, /Could not prepare the project.*Could not create the capstone repository.*workspace was not opened/s);
    assert.equal(opened.length, 2);
  } finally { await rm(root, {recursive: true, force: true}); }
});
