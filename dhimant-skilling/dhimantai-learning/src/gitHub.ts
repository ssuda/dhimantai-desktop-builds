import * as vscode from 'vscode';
import { projectIdentity } from './projectCore';
import { projectGitHub } from './projectGitHub';

interface GitAction extends vscode.QuickPickItem {
  command: string;
  /** Project-scoped actions run here instead of a generic editor command. */
  run?: () => Promise<unknown>;
}

const actions: GitAction[] = [
  { label: '$(source-control) Open Source Control', description: 'Review, stage and commit changes', command: 'workbench.view.scm' },
  { label: '$(github) Create GitHub repository', description: 'Publish this folder; choose a name and public or private visibility', command: 'github.publish' },
  { label: '$(repo-clone) Clone repository', description: 'Choose a GitHub repository or paste a Git URL', command: 'git.clone' },
  { label: '$(repo-create) Initialize local repository', description: 'Start tracking a folder with Git', command: 'git.init' },
  { label: '$(cloud-upload) Push', description: 'Upload committed changes to the remote', command: 'git.push' },
  { label: '$(cloud-download) Pull', description: 'Download and integrate remote changes', command: 'git.pull' },
  { label: '$(repo-fetch) Fetch', description: 'Check remote changes without merging them', command: 'git.fetch' },
  { label: '$(git-branch) Create branch', description: 'Start a branch in the current repository', command: 'git.branch' },
  { label: '$(git-branch) Switch branch', description: 'Check out an existing branch', command: 'git.checkout' },
  { label: '$(remote) Add remote', description: 'Connect a local repository to an existing GitHub or Git repository', command: 'git.addRemote' },
];

/** The course project open in this window, preferring the folder of the active editor. */
async function activeProject(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
  for (const folder of active ? [active, ...folders.filter(f => f !== active)] : folders) {
    if (folder.uri.scheme === 'file' && await projectIdentity(folder.uri.fsPath).catch(() => undefined)) return folder.uri.fsPath;
  }
}

/**
 * In a course project the generic Publish/Push would target the course's own bundle remote ("team") or the wrong
 * repository. Offer the project's checked, scoped GitHub actions instead and say where generic ones point.
 */
function projectActions(root: string): GitAction[] {
  return [
    { label: '$(github) Publish this project to GitHub', description: 'Checks the project is committed, then creates a GitHub repository or pushes this branch', command: '', run: () => projectGitHub(root, 'publish') },
    { label: '$(git-pull-request) Create a pull request', description: 'For this project’s branch after it is published to GitHub', command: '', run: () => projectGitHub(root, 'pullRequest') },
    ...actions.filter(action => !['github.publish', 'git.init'].includes(action.command)).map(action => ['git.push', 'git.pull', 'git.fetch'].includes(action.command)
      ? {...action, description: action.description + ' (the course project’s “team” remote is its bundled starter history, not GitHub)'} : action),
  ];
}

async function activateBuiltin(id: string, name: string) {
  const extension = vscode.extensions.getExtension(id);
  if (!extension) throw new Error(`Enable the built-in ${name} extension in Extensions (search @builtin git), then reload the editor.`);
  await extension.activate();
}

export function registerGitHub(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.gitHub', async () => {
    const project = await activeProject();
    const action = await vscode.window.showQuickPick(project ? projectActions(project) : actions, {
      title: project ? 'Git & GitHub · course project' : 'Git & GitHub',
      placeHolder: 'Choose a repository action',
      matchOnDescription: true,
    });
    if (!action) return;
    try {
      if (action.run) { await action.run(); return; }
      if (action.command !== 'workbench.view.scm') {
        if (!vscode.workspace.getConfiguration('git').get<boolean>('enabled', true)) {
          throw new Error('Git is disabled. Enable Git: Enabled in Settings, then try again.');
        }
        await activateBuiltin('vscode.git', 'Git');
        if (action.command === 'github.publish') await activateBuiltin('vscode.github', 'GitHub');
        // Make the built-in GitHub repository picker available for Clone when supported.
        if (action.command === 'git.clone') await vscode.extensions.getExtension('vscode.github')?.activate();
      }
      // The editor owns authentication, repository selection, visibility, file selection,
      // commit prompts and Git errors. Never run shell commands or store GitHub tokens here.
      await vscode.commands.executeCommand(action.command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const choice = await vscode.window.showErrorMessage(`Git & GitHub: ${message}`, 'Open Source Control');
      if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
    }
  }));
}
