import * as vscode from 'vscode';

/** Navigation for the custom desktop; each row opens the existing client surface. */
export function registerLearningNavigation(context: vscode.ExtensionContext) {
  const desktop = vscode.env.appName === 'dhimantAI';
  void vscode.commands.executeCommand('setContext', 'dhimantai.customDesktop', desktop);
  if (!desktop) return;
  const entries = [
    ['Courses', 'library', 'dhimantai.courseCatalog'],
    ['Instructor', 'book', 'dhimantai.openLearningRoom'],
    ['Doubt Solver', 'question', 'dhimantai.openDoubtSolver'],
    ['Practice', 'code', 'dhimantai.browsePractice'],
    ['Git & GitHub', 'source-control', 'dhimantai.gitHub'],
  ];
  const items = entries.map(([label, icon, command]) => {
    const item = new vscode.TreeItem(label);
    item.id = command; item.iconPath = new vscode.ThemeIcon(icon);
    item.command = {command, title:label};
    return item;
  });
  context.subscriptions.push(vscode.window.createTreeView('dhimantai.learningNavigation', {
    treeDataProvider:{getTreeItem:item=>item, getChildren:()=>items}, showCollapseAll:false,
  }));
}
