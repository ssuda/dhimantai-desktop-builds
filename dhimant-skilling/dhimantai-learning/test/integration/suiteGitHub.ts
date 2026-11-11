import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

/** Real built-in providers, with remote writes confined to a disposable local bare repository. */
export async function run() {
  const results: { step: string; ok: boolean }[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    await body(); results.push({ step, ok: true });
  };
  const original = { quick: vscode.window.showQuickPick, execute: vscode.commands.executeCommand,
    extension: vscode.extensions.getExtension, error: vscode.window.showErrorMessage };
  const commands: string[] = [];
  const errors: string[] = [];
  let selected: string | undefined;
  let offered: { command: string }[] = [];
  let simulate = true;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dhimantai-git-')));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  const cfg = vscode.workspace.getConfiguration('git');
  const enabled = cfg.inspect<boolean>('enabled')?.globalValue;
  const parentRepositories = cfg.inspect<string>('openRepositoryInParentFolders')?.globalValue;
  try {
    await vscode.extensions.getExtension('optficial.dhimantai-learning')!.activate();
    await vscode.extensions.getExtension('vscode.git')!.activate();
    await vscode.extensions.getExtension('vscode.github')!.activate();
    (vscode.window as any).showQuickPick = async (items: any, options: any, ...rest: any[]) => {
      if (options?.title !== 'Git & GitHub') return (original.quick as any)(items, options, ...rest);
      offered = items;
      return items.find((item: any) => item.command === selected);
    };
    (vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
      if (command === 'dhimantai.gitHub') return original.execute(command, ...args);
      commands.push(command);
      if (!simulate) return original.execute(command, ...args);
    };
    (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
    const choose = async (command?: string) => {
      selected = command;
      await original.execute('dhimantai.gitHub');
    };
    await check('opening and cancelling the menu performs no repository action', async () => {
      await choose();
      assert.deepEqual(commands, []);
      assert.ok(offered.some(item => item.command === 'github.publish'));
      const available = await vscode.commands.getCommands(true);
      for (const item of offered) assert.ok(available.includes(item.command), `${item.command} exists in this editor`);
    });
    await check('publish, clone and repository actions delegate to built-in commands with no automatic follow-up', async () => {
      for (const item of offered) {
        commands.length = 0;
        await choose(item.command);
        assert.deepEqual(commands, [item.command]);
      }
      assert.deepEqual(errors, []);
    });
    await check('disabled Git blocks repository operations and keeps Source Control accessible', async () => {
      await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
      commands.length = 0;
      await choose('git.push');
      assert.deepEqual(commands, []);
      assert.match(errors.pop()!, /Git is disabled/);
      await choose('workbench.view.scm');
      assert.deepEqual(commands, ['workbench.view.scm']);
      await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    });
    await check('missing built-in GitHub gives setup guidance without publishing or installing anything', async () => {
      (vscode.extensions as any).getExtension = (id: string) => id === 'vscode.github' ? undefined : original.extension(id);
      commands.length = 0;
      await choose('github.publish');
      assert.deepEqual(commands, []);
      assert.match(errors.pop()!, /built-in GitHub/);
      (vscode.extensions as any).getExtension = original.extension;
    });
    await check('provider failure is shown without reporting success or retrying a write', async () => {
      (vscode.extensions as any).getExtension = (id: string) => id === 'vscode.git'
        ? { activate: async () => { throw new Error('Git is unavailable'); } } : original.extension(id);
      commands.length = 0;
      await choose('git.pull');
      assert.deepEqual(commands, []);
      assert.match(errors.pop()!, /Git is unavailable/);
      (vscode.extensions as any).getExtension = original.extension;
    });
    await check('Push, Fetch and Pull work through the real Git extension against a local remote', async () => {
      // The test process creates fixture commits; no course code or network repository is used.
      const seed = join(root, 'seed'), remote = join(root, 'remote.git'), working = join(root, 'working');
      mkdirSync(seed);
      writeFileSync(join(root, 'gitconfig'), '[user]\nname = Git Integration Test\nemail = git-test@example.invalid\n');
      git(seed, 'init', '-b', 'main');
      writeFileSync(join(seed, 'hello.txt'), 'initial\n');
      git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Initial fixture');
      git(root, 'clone', '--bare', seed, remote);
      git(root, 'clone', remote, working);
      git(seed, 'remote', 'add', 'origin', remote);
      // This suite starts in an empty window, so explicitly permit its fixture repository.
      await cfg.update('openRepositoryInParentFolders', 'always', vscode.ConfigurationTarget.Global);
      // Toggling Git above replaces its model; obtain the current API after it settles.
      let repository: any;
      for (let attempt = 0; attempt < 50 && !repository; attempt++) {
        try {
          const api = vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1);
          if (api.state === 'initialized') repository = await api.openRepository(vscode.Uri.file(working));
        } catch { /* Git is still reinitializing after the settings change. */ }
        if (!repository) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(repository, 'built-in Git opens the disposable checkout');
      writeFileSync(join(working, 'outgoing.txt'), 'outgoing\n');
      git(working, 'add', '.'); git(working, 'commit', '-m', 'Outgoing fixture');
      await repository.status();
      simulate = false;
      await choose('git.push');
      assert.equal(git(remote, 'rev-parse', 'main'), git(working, 'rev-parse', 'HEAD'));
      git(seed, 'pull', '--ff-only', 'origin', 'main');
      writeFileSync(join(seed, 'hello.txt'), 'incoming\n');
      git(seed, 'commit', '-am', 'Incoming fixture'); git(seed, 'push', 'origin', 'main');
      await choose('git.fetch');
      assert.equal(readFileSync(join(working, 'hello.txt'), 'utf8'), 'initial\n', 'fetch leaves files unchanged');
      assert.equal(git(working, 'rev-parse', 'origin/main'), git(remote, 'rev-parse', 'main'));
      await choose('git.pull');
      assert.equal(readFileSync(join(working, 'hello.txt'), 'utf8'), 'incoming\n');
      assert.equal(git(working, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
      assert.deepEqual(errors, []);
    });
  } finally {
    (vscode.window as any).showQuickPick = original.quick;
    (vscode.commands as any).executeCommand = original.execute;
    (vscode.extensions as any).getExtension = original.extension;
    (vscode.window as any).showErrorMessage = original.error;
    await cfg.update('enabled', enabled, vscode.ConfigurationTarget.Global);
    await cfg.update('openRepositoryInParentFolders', parentRepositories, vscode.ConfigurationTarget.Global);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
    rmSync(root, { recursive: true, force: true });
  }
}
