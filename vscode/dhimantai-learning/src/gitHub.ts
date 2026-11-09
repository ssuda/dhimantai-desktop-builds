import * as vscode from 'vscode';

interface GitAction extends vscode.QuickPickItem {
  command: string;
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

async function activateBuiltin(id: string, name: string) {
  const extension = vscode.extensions.getExtension(id);
  if (!extension) throw new Error(`Enable the built-in ${name} extension in Extensions (search @builtin git), then reload the editor.`);
  await extension.activate();
}

export function registerGitHub(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.gitHub', async () => {
    const action = await vscode.window.showQuickPick(actions, {
      title: 'Git & GitHub',
      placeHolder: 'Choose a repository action',
      matchOnDescription: true,
    });
    if (!action) return;
    try {
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
