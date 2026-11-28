import * as vscode from 'vscode';
import type { Auth } from './auth';
import type { BrowserCourses } from './browserCourses';
import type { CourseWorkspaces } from './courseWorkspace';
import type { EnvironmentName } from './environments';
import { jupyterMetadata } from './notebookCommands';
import { practiceLink } from './practiceIpynb';
import type { ProjectCoach } from './projectCoach';

const actions = ['ask', 'check', 'grade', 'feedback', 'project', 'discuss', 'course'] as const;
export type SkillingAction = typeof actions[number];
export type SkillingTarget = Partial<Record<SkillingAction, () => unknown>>;
export const courseAction = (course: string, chapter?: string) =>
  () => vscode.commands.executeCommand('dhimantai.courseGrade', course, chapter);

export function registerSkillingMenu(context: vscode.ExtensionContext, auth: Auth, environment: () => EnvironmentName,
    rooms: {menuTarget(): SkillingTarget | undefined; onMenuChange: vscode.Event<void>},
    courses: CourseWorkspaces, projects: Pick<ProjectCoach, 'menuTarget' | 'onMenuChange'>, browser: BrowserCourses) {
  const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  async function target(current: vscode.Tab | undefined): Promise<SkillingTarget> {
    const lab = browser.menuTarget();
    if (lab) return lab;
    const input = current?.input;
    if (input instanceof vscode.TabInputWebview) return input.viewType.endsWith('dhimantai.learningRoom') ? rooms.menuTarget() ?? {} : {};
    const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook ? input.uri
      : input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff ? input.modified : undefined;
    if (!uri) return {};
    const env = environment(), account = (await auth.session())?.user.id;
    if (tab() !== current || environment() !== env) return {};
    const record = courses.recordFor(uri);
    const course = record?.account === account && record?.environment === env && record.runtime !== 'programming' ? record.course : undefined;
    if (input instanceof vscode.TabInputNotebook) {
      const doc = vscode.window.activeNotebookEditor?.notebook;
      if (doc?.uri.toString() !== uri.toString()) return {};
      const metadata = jupyterMetadata(doc);
      const practice = practiceLink(metadata, [env]);
      const result: SkillingTarget = {};
      if (metadata.dhimantai_practice) {
        if (!practice || practice.account !== account) return {};
        if (practice.tests.length) result.check = () => vscode.commands.executeCommand('dhimantai.practice.check');
        if (!practice.questionId.startsWith('generated-')) result.grade = () => vscode.commands.executeCommand('dhimantai.practice.grade');
        if (metadata.dhimantai_practice.code_assistance_allowed === true && vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true))
          result.ask = () => vscode.commands.executeCommand('dhimantai.practice.ask');
        const subject = course ?? practice.course;
        if (subject) result.course = courseAction(subject);
        return result;
      }
      if (course) {
        result.course = courseAction(course);
        result.ask = () => vscode.commands.executeCommand('dhimantai.notebook.ask');
      }
      return {...await projects.menuTarget(uri), ...result};
    }
    const project = await projects.menuTarget(uri);
    return { ...(course ? {course:courseAction(course)} : {}), ...project };
  }
  let revision = 0;
  const published = new Map<string, boolean>();
  const publish = (key: string, value: boolean) => {
    if (published.get(key) === value) return;
    published.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  };
  const selectionChanged = () => {
    const editor = vscode.window.activeTextEditor;
    publish('dhimantai.skilling.hasSelection', !!editor && !editor.selection.isEmpty);
  };
  const refresh = async () => {
    const id = ++revision, current = tab(), input = current?.input;
    publish('dhimantai.editingFiles', input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook ||
      input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff);
    // A removed workspace or unavailable project manifest must clear the previous tab's actions.
    const available: SkillingTarget = await target(current).catch(() => ({}));
    if (revision !== id || tab() !== current) return;
    for (const action of actions) publish('dhimantai.skilling.' + action, !!available[action]);
  };
  context.subscriptions.push(...actions.map(action => vscode.commands.registerCommand('dhimantai.skilling.' + action, async () => {
    const current = tab(), available = await target(current);
    if (tab() === current) return available[action]?.();
  })), rooms.onMenuChange(refresh), projects.onMenuChange(refresh), browser.onMenuChange(refresh), auth.onDidChange(refresh),
    vscode.window.tabGroups.onDidChangeTabs(refresh), vscode.window.tabGroups.onDidChangeTabGroups(refresh),
    vscode.window.onDidChangeTextEditorSelection(selectionChanged), vscode.window.onDidChangeActiveTextEditor(selectionChanged),
    vscode.window.onDidChangeActiveNotebookEditor(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeNotebookDocument(event => { if (event.metadata) void refresh(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai')) void refresh(); }));
  selectionChanged();
  void refresh();
  publish('dhimantai.skillingReady', true);
}
