import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { branchUpstream, githubCompareUrl, githubRepository, submissionGit } from './projectResults';

interface Repository {
  rootUri: vscode.Uri;
  state: {remotes: {name: string; fetchUrl?: string; pushUrl?: string}[]};
  status(): Promise<void>;
  push(remote: string, branch: string, setUpstream: boolean): Promise<void>;
}
interface GitExtension { getAPI(version: number): {repositories: Repository[]} }

/** Explicit learner actions reuse VS Code credentials and review UI. No token enters our saved results. */
export async function projectGitHub(root: string, action: 'publish' | 'pullRequest', current: () => boolean = () => true) {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this project before using GitHub.');
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) throw new Error('Enable the built-in Git extension to use GitHub.');
  const api = (await extension.activate()).getAPI(1);
  const canonicalRoot = await realpath(root);
  const matches = await Promise.all(api.repositories.map(async repo => ({repo, root: await realpath(repo.rootUri.fsPath)})));
  const repository = matches.find(entry => entry.root === canonicalRoot)?.repo;
  if (!repository) throw new Error('Open this project folder in VS Code so Git can discover its repository.');
  await repository.status();
  const git = await submissionGit(root);
  if (!git.available || !git.branch) throw new Error('Create or switch to a branch and commit your project before using GitHub.');
  if (git.dirty) throw new Error('Review and commit your project changes in Source Control before using GitHub.');
  const remotes = repository.state.remotes.flatMap(remote => {
    const url = githubRepository(remote.pushUrl ?? remote.fetchUrl ?? '');
    return url ? [{name: remote.name, url}] : [];
  });
  if (!current()) return;
  if (action === 'publish' && !remotes.length) {
    if (repository.state.remotes.some(remote => remote.name === 'origin'))
      throw new Error('The origin remote is not a supported GitHub destination. Review it in Source Control before publishing.');
    // github.publish chooses the sole repository and ignores command arguments in VS Code.
    if (api.repositories.length !== 1 || vscode.workspace.workspaceFolders?.length !== 1)
      throw new Error('Open this project as the only repository in a separate window before publishing to GitHub.');
    await vscode.extensions.getExtension('vscode.github')?.activate();
    if (!(await vscode.commands.getCommands(true)).includes('github.publish')) throw new Error('Enable VS Code’s built-in GitHub extension to publish.');
    const approved = await vscode.window.showInformationMessage(`Publish ${root} to GitHub?`, {modal: true,
      detail: `Uploads committed files and Git history at ${git.head.slice(0, 12)}. Review history for private data. VS Code will ask for the repository name and public/private visibility.`}, 'Continue to GitHub');
    if (approved && current()) {
      await repository.status();
      if (api.repositories.length !== 1 || repository.state.remotes.some(remote => remote.name === 'origin')
        || JSON.stringify(await submissionGit(root)) !== JSON.stringify(git)) throw new Error('Git changed. Review the project and retry.');
      if (current()) await vscode.commands.executeCommand('github.publish');
    }
    return;
  }
  if (!remotes.length) throw new Error('Publish to GitHub before creating a pull request.');
  const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(
    remotes.map(r => ({...r, label: r.name, description: r.url})), {title: 'Choose the project’s GitHub destination'});
  if (!remote || !current()) return;
  if (action === 'publish') {
    const approved = await vscode.window.showInformationMessage(`Publish ${git.branch} to ${remote.url}?`, {modal: true,
      detail: `Uploads committed files and history at ${git.head.slice(0, 12)}. Review the destination and history before continuing.`}, 'Publish branch');
    if (!approved || !current()) return;
    const now = await submissionGit(root);
    await repository.status();
    const destination = repository.state.remotes.find(r => r.name === remote.name);
    if (JSON.stringify(now) !== JSON.stringify(git) || githubRepository(destination?.pushUrl ?? destination?.fetchUrl ?? '') !== remote.url)
      throw new Error('Git changed. Review the current branch and destination, then retry.');
    if (current()) await repository.push(remote.name, git.branch, true);
    return;
  }
  const pr = vscode.extensions.getExtension('GitHub.vscode-pull-request-github');
  if (pr) {
    await pr.activate();
    if (current() && (await vscode.commands.getCommands(true)).includes('pr.create')) {
      if (current()) await vscode.commands.executeCommand('pr.create', {repoPath: root, compareBranch: git.branch}); return;
    }
  }
  // GitHub's compare page needs the branch on GitHub first; it lets the learner choose the base and review the PR.
  const upstream = await branchUpstream(root, git.branch);
  if (!upstream || upstream.remote !== remote.name)
    throw new Error(`Publish the ${git.branch} branch to ${remote.url} first (Publish to GitHub), then create the pull request.`);
  if (current()) await vscode.env.openExternal(vscode.Uri.parse(githubCompareUrl(remote.url, upstream.branch)));
}
