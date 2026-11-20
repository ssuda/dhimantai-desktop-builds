import * as vscode from 'vscode';

/** Navigation for the custom desktop; each row opens the existing client surface. */
export function registerLearningNavigation(context: vscode.ExtensionContext) {
  const desktop = vscode.env.appName === 'dhimantAI';
  void vscode.commands.executeCommand('setContext', 'dhimantai.customDesktop', desktop);
  if (!desktop) return;
  // The one app-level navigation in the desktop. Names match the lesson tabs and the profile menu:
  // "My courses" is the course and exercise browser; a lesson's own Practice tab is that chapter's exercises.
  const entries: [string, string, string, unknown[]?][] = [
    ['Courses', 'library', 'dhimantai.courseCatalog'],
    ['My courses', 'mortar-board', 'dhimantai.browsePractice'],
    ['Instructor', 'book', 'dhimantai.openLearningRoom'],
    ['Doubt Solver', 'question', 'dhimantai.openDoubtSolver'],
    ['My certificates', 'verified', 'dhimantai.courseGrade', ['__certificates__']],
    ['Git & GitHub', 'source-control', 'dhimantai.gitHub'],
  ];
  const items = entries.map(([label, icon, command, args]) => {
    const item = new vscode.TreeItem(label);
    item.id = command + (args ? ':' + args.join(':') : ''); item.iconPath = new vscode.ThemeIcon(icon);
    item.command = {command, title:label, arguments:args};
    return item;
  });
  context.subscriptions.push(vscode.window.createTreeView('dhimantai.learningNavigation', {
    treeDataProvider:{getTreeItem:item=>item, getChildren:()=>items}, showCollapseAll:false,
  }));
}
