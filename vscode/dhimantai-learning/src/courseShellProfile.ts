import * as vscode from 'vscode';

export const COURSE_SHELL_PROFILE = 'dhimantai.courseShell';
export const COURSE_SHELL_TITLE = 'dhimantAI Course (zsh)';

const platformKey = () => process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';

/** New terminals in a course folder open the course container's zsh, like the course terminal. */
export function registerCourseShellProfile(options: () => Promise<vscode.TerminalOptions | undefined>,
    isCourseFolder: (uri: vscode.Uri) => boolean, enabled: () => boolean): vscode.Disposable {
  const provider = vscode.window.registerTerminalProfileProvider(COURSE_SHELL_PROFILE, {
    async provideTerminalProfile() {
      const terminal = await options();
      if (!terminal) throw new Error('Choose a course to open its terminal.');
      return new vscode.TerminalProfile(terminal);
    },
  });
  const apply = () => {
    if (!enabled()) return;
    for (const folder of vscode.workspace.workspaceFolders ?? [])
      if (isCourseFolder(folder.uri)) void preferCourseShell(folder).catch(() => {});
  };
  apply();
  return vscode.Disposable.from(provider, vscode.workspace.onDidChangeWorkspaceFolders(apply));
}

/** Make the course shell the folder's default terminal unless the learner already chose one there. */
export async function preferCourseShell(folder: vscode.WorkspaceFolder) {
  const config = vscode.workspace.getConfiguration('terminal.integrated', folder.uri);
  const key = 'defaultProfile.' + platformKey();
  if (config.inspect(key)?.workspaceFolderValue !== undefined) return false;
  await config.update(key, COURSE_SHELL_TITLE, vscode.ConfigurationTarget.WorkspaceFolder);
  return true;
}
