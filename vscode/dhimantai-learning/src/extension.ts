import { CourseWorkspaces } from './courseWorkspace';
import { registerCourseKernel } from './courseKernel';
import * as vscode from 'vscode';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, ApiError } from './api';
import { taskRunner } from './task';
import { Auth, setAuthDiagnostics } from './auth';
import { ENVIRONMENTS, Environment, EnvironmentName } from './environments';
import { registerNextLine } from './nextLine';
import { PracticeBrowser } from './practiceBrowser';
import { registerLearningNavigation } from './learningNavigation';
import { CourseCatalog } from './courseCatalog';
import { registerStudyReader } from './studyReader';
import { registerCourseShellProfile } from './courseShellProfile';
import { openLegacyExercise } from './legacyExercise';
import { useColabForNotebook } from './colab';
import { newNotebook } from './notebookRuntime';
import { ExtensionUpdates } from './updates';
import { registerNotebookSubmission } from './notebookCommands';
import { registerLearningRoom } from './learningRoom';
import { registerCapstone } from './capstone';
import { ProjectCoach } from './projectCoach';
import { openTutorHandoff, openTutorNotebook } from './tutorHandoff';
import { CopilotPolicy } from './copilotPolicy';
import { registerPracticeInNotebook } from './practiceInNotebook';
import { registerPracticeKernel } from './practiceKernel';
import { MIRRORED, MirroredLanguage, mirrorFolder, registerCellMirrors } from './cellMirror';
import { practiceLink } from './practiceIpynb';
import { jupyterMetadata } from './notebookCommands';
import { runPublicTests, Toolchains } from './localRunner';

export async function activate(context: vscode.ExtensionContext) {
  registerLearningNavigation(context);
  // Integration tests point the extension at a local contract server; never honoured outside VS Code's test mode.
  const testing = context.extensionMode === vscode.ExtensionMode.Test;
  const testEnvironment: Environment | undefined = testing && process.env.DHIMANTAI_TEST_ENVIRONMENT
    ? JSON.parse(process.env.DHIMANTAI_TEST_ENVIRONMENT) : undefined;
  const notebookSubmissionView = registerNotebookSubmission(context, testEnvironment);
  const envName = (): EnvironmentName => {
    const value = vscode.workspace.getConfiguration('dhimantai').get<string>('environment', 'production');
    return (value in ENVIRONMENTS ? value : 'production') as EnvironmentName;
  };
  const env = () => testEnvironment ?? ENVIRONMENTS[envName()];
  const output = vscode.window.createOutputChannel('dhimantAI');
  setAuthDiagnostics(output);
  const auth = new Auth(context.secrets, envName, env);
  const task = taskRunner(output);
  const courses = new CourseWorkspaces(context,auth,envName,output,!testing || process.env.DHIMANTAI_TEST_COURSES === '1',
    async scope => {
      const service = env();
      const scoped = new Api(auth, () => {
        if (envName() !== scope.environment) throw new Error('Your service changed. Reopen the course.');
        return service;
      }, scope.account);
      return (await scoped.courseLabs(scope.course)).labs;
    });
  const copilotPolicy = new CopilotPolicy(output, uri => {
    const record = courses.recordFor(uri);
    return record?.environment === envName() ? record.course : undefined;
  });
  context.subscriptions.push(copilotPolicy);
  await copilotPolicy.enforce();
  stopCourses = () => courses.stopAll();
  const learningRoom = registerLearningRoom(context, envName, env, auth, courses, copilotPolicy);
  context.subscriptions.push(learningRoom, registerCapstone(context));
  registerCourseKernel(courses,context,auth);
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.courseDockerfile', () =>
    courses.openDockerfile().catch(e => vscode.window.showErrorMessage(e.message))));
  const practice = new PracticeBrowser(auth, envName, env, courses);
  context.subscriptions.push(registerCourseShellProfile(() => practice.courseTerminalOptions(),
    uri => !!courses.recordFor(uri), () => courses.enabled));
  const workstationAction = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      const choice = await vscode.window.showErrorMessage(message, 'Retry setup', 'Show setup log');
      if (choice === 'Retry setup') return workstationAction(action);
      if (choice === 'Show setup log') output.show(true);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('dhimantai.newCourseNotebook', () => workstationAction(() => practice.newCourseNotebook())),
    vscode.commands.registerCommand('dhimantai.setupCourse', target => workstationAction(() => practice.setupCourse(target))),
    vscode.commands.registerCommand('dhimantai.courseTerminal', target => workstationAction(() => practice.openCourseTerminal(target)))
  );
  const study = await registerStudyReader(context, auth, envName, env, copilotPolicy);
  context.subscriptions.push(study);
  const catalog = new CourseCatalog(auth, envName, env, () => practice.refresh(), learningRoom.hasNotebook, study.companions);
  context.subscriptions.push(catalog);
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.pricing', () => catalog.open()));
  const installed = context.extension.packageJSON.version as string;
  const updates = new ExtensionUpdates(envName, installed, () => {});
  const installPackage = async (bytes: Buffer, version: string) => {
    const directory = await mkdtemp(join(tmpdir(), 'dhimantai-update-'));
    try {
      const file = join(directory, `dhimantai-learning-${version}.vsix`);
      await writeFile(file, bytes);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file),
        { installOnlyNewlyAddedFromExtensionPackVSIX: true });
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  };
  const installUpdate = () => vscode.env.appName === 'dhimantAI'
    ? vscode.window.showInformationMessage('Update the dhimantAI desktop application to update its bundled learning interface.')
    : updates.install(installPackage);
  const checkUpdates = async () => {
    if (vscode.env.appName === 'dhimantAI') return;
    await updates.check();
    const available = updates.state.available;
    const auto = vscode.workspace.getConfiguration('dhimantai').get<boolean>('autoUpdate', false);
    if (updates.state.status === 'available' && auto && available) {
      await updates.installAutomatically(context.globalState, installPackage);
      return;
    }
    const notificationKey = `updateNotice:${envName()}`;
    if (updates.state.status === 'available' && available && context.globalState.get(notificationKey) !== available) {
      await context.globalState.update(notificationKey, available);
      const choice = await vscode.window.showInformationMessage(`dhimantAI Learning ${available} is available (installed ${installed}).`, 'Install update');
      if (choice) await vscode.commands.executeCommand('dhimantai.installUpdate');
    }
  };
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const projectCoach = new ProjectCoach(context, auth, envName, env, courses);
  context.subscriptions.push(projectCoach);
  // Notebook teaching stays inside its notebook. Projects reuse the Coach in the right sidebar.
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.hideCoach', async () => {
    await projectCoach.hide();
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs)
      if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('dhimantai.coach'))
        await vscode.window.tabGroups.close(tab, true);
  }));
  await vscode.commands.executeCommand('dhimantai.hideCoach');
  void projectCoach.restore();
  const service = (name: EnvironmentName) => testEnvironment ?? ENVIRONMENTS[name];
  context.subscriptions.push(registerNextLine(context.secrets, service, task));
  // Practice lives in one real notebook: help, sample tests and Instructor replies are cells and toolbar actions.
  // A notebook outside a course folder uses a course container when the learner has a course; with none, or with
  // containers off, it runs on this computer as before. Hold the first Run while setup/repair completes.
  const runtimeFolders = new WeakMap<vscode.NotebookDocument, vscode.Uri>();
  const localNotebooks = new WeakSet<vscode.NotebookDocument>();
  const offerLocal = async (doc: vscode.NotebookDocument, message: string) => {
    const choice = await vscode.window.showErrorMessage(message, 'Use this computer', 'Open settings');
    if (choice === 'Use this computer') { localNotebooks.add(doc); return undefined; }
    if (choice === 'Open settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'dhimantai.courseContainers');
    throw new Error(message);
  };
  const notebookEngine = async (doc: vscode.NotebookDocument, language: string) => {
    if (!vscode.workspace.getConfiguration('dhimantai').get('courseContainers', true)) return undefined;
    const inCourse = !!courses.recordFor(doc.uri);
    if (!inCourse && (!courses.enabled || localNotebooks.has(doc))) return undefined;
    if (!courses.enabled) throw new Error('The course container is unavailable. Set up the course runtime before running.');
    let target = inCourse ? doc.uri : runtimeFolders.get(doc);
    if (!target) {
      let failure = 'Choose a course container to run this notebook.';
      try { target = await practice.setupCourse(doc.uri); } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        if (failure.startsWith('Join a course')) return undefined; // no course yet: this computer, as before
      }
      if (!target) return offerLocal(doc, failure);
      runtimeFolders.set(doc, target);
    }
    const engine = await courses.forFile(target, language);
    const failed = 'The course container could not start. Open the course setup log to resolve the remaining error.';
    if (!engine && inCourse) throw new Error(failed);
    if (!engine) return offerLocal(doc, failed);
    return engine;
  };
  context.subscriptions.push(registerPracticeKernel(notebookEngine,{lab:doc=>courses.languageFor(doc.uri)==='pglab',resetEvents:reset=>[auth.onDidChange(()=>reset()),vscode.workspace.onDidChangeConfiguration(e=>{
    if(e.affectsConfiguration('dhimantai.environment')||e.affectsConfiguration('dhimantai.courseContainers'))reset();
  })]}));
  context.subscriptions.push(registerPracticeInNotebook({
    secrets: context.secrets, service, ...learningRoom.help,
    async tests(doc, language, source, cases) {
      const toolchains = vscode.workspace.getConfiguration('dhimantai').get<Toolchains>('toolchains', {});
      const engine = await notebookEngine(doc, language);
      if ((language === 'sql' || language === 'pglab') && !engine) throw new Error('PostgreSQL sample tests run in the course container, which includes PostgreSQL.');
      return engine ? engine.tests(language, {source, stdin: '', argv: [], files: []}, cases)
        : runPublicTests(language, source, cases, vscode.Uri.joinPath(media, 'pycall.py').fsPath, toolchains);
    },
  }));
  // Official language extensions analyse files, so non-Python Practice code is mirrored into a hidden project.
  context.subscriptions.push(registerCellMirrors((doc,selected) => {
    if(doc.uri.scheme!=='file')return;
    const link = doc.uri.scheme === 'file' ? practiceLink(jupyterMetadata(doc), Object.keys(ENVIRONMENTS)) : undefined;
    const chosen=selected??link?.language??jupyterMetadata(doc).kernelspec?.language;
    const language=['pglab','bash','zsh'].includes(chosen)?'shellscript':chosen;
    return language && (MIRRORED as readonly string[]).includes(language) ? language as MirroredLanguage : undefined;
  }, doc => mirrorFolder(doc.uri)));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'dhimantai.courseCatalog';
  status.text = '$(mortar-board) dhimantAI';
  status.tooltip = 'Open Course Catalog, Instructor, and Doubt Solver.';
  status.show();

  const command = (id: string, label: string, action: (...args: any[]) => Promise<unknown>) =>
    vscode.commands.registerCommand(id, (...args: any[]) => task(label, async () => { await action(...args); }));

  const uriHandler: vscode.UriHandler = {
    async handleUri(uri) {
      if (uri.path === '/open-notebook') {
        await task('Opening Instructor notebook', () => openTutorNotebook(uri));
        return;
      }
      if (uri.path === '/tutor') {
        await task('Opening Instructor code', () => openTutorHandoff(uri, {
          auth, envName, env, storage: context.globalStorageUri, closeExercise: async () => {},
        }));
        return;
      }
      if (uri.path !== '/open') return;
      const params = new URLSearchParams(uri.query);
      const target = params.get('env');
      if (target && Object.hasOwn(ENVIRONMENTS, target) && target !== envName()) {
        await vscode.workspace.getConfiguration('dhimantai').update('environment', target, vscode.ConfigurationTarget.Global);
      }
      await vscode.commands.executeCommand('dhimantai.openExercise', params.get('question') ?? '', params.get('account') ?? undefined);
    },
  };

  context.subscriptions.push(
    output, status, updates, practice,
    vscode.window.createTreeView('dhimantai.practice', {treeDataProvider: practice}),
    auth.onDidChange(() => practice.refresh()),
    vscode.commands.registerCommand('dhimantai.openCopyInCourse', () => {
      const doc = vscode.window.activeNotebookEditor?.notebook;
      return workstationAction(() => practice.openCopyInCourse(doc));
    }),
    command('dhimantai.newNotebook', 'Creating notebook', () => newNotebook()),
    command('dhimantai.openCourseColab', 'Opening course on Colab', node => practice.openCourseColab(node)),
    command('dhimantai.useColabKernel', 'Connecting notebook to Colab', () => useColabForNotebook()),
    vscode.commands.registerCommand('dhimantai.openCourse', node => practice.openCourse(node)
      .catch(error => vscode.window.showErrorMessage(error.message))),
    vscode.commands.registerCommand('dhimantai.refreshPractice', () => practice.refresh()),
    vscode.commands.registerCommand('dhimantai.browsePractice', () => vscode.commands.executeCommand('dhimantai.practice.focus')),
    command('dhimantai.courseCatalog', 'Loading course catalog', () => catalog.open()),
    vscode.commands.registerCommand('dhimantai.desktopWelcome', () => vscode.env.appName === 'dhimantAI' ? catalog.welcome(context.globalState) : undefined),
    vscode.commands.registerCommand('dhimantai.openPracticeQuestion', node =>
      practice.openQuestion(node).catch(error => vscode.window.showErrorMessage(error.message))),
    command('dhimantai.generateExercise', 'Generating exercise', async node => {
      if (node?.kind === 'chapter') await practice.generate(node);
      else {
        await vscode.commands.executeCommand('dhimantai.practice.focus');
        void vscode.window.showInformationMessage('Expand a course and chapter in DhimantAI Practice, then choose Generate an exercise.');
      }
    }),
    vscode.commands.registerCommand('dhimantai.checkForUpdates', checkUpdates),
    vscode.commands.registerCommand('dhimantai.installUpdate', async () => {
      await updates.check();
      await installUpdate();
    }),
    vscode.commands.registerCommand('dhimantai.updateSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dhimantai.autoUpdate')),
    vscode.commands.registerCommand('dhimantai.downloadUpdate', async () => {
      if (!updates.downloadUrl) return vscode.window.showInformationMessage('Install your locally built VSIX using Extensions: Install from VSIX…');
      await vscode.env.openExternal(vscode.Uri.parse(updates.downloadUrl));
      const choice = await vscode.window.showInformationMessage('After the VSIX downloads, install it using Extensions: Install from VSIX… Reload VS Code if asked.', 'Install downloaded VSIX…');
      if (choice) await vscode.commands.executeCommand('workbench.extensions.action.installVSIX');
    }),
    vscode.commands.registerCommand('dhimantai.toggleAI', async () => {
      const config = vscode.workspace.getConfiguration('dhimantai');
      const target = config.inspect<boolean>('aiAssistance')?.workspaceValue === undefined ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
      await config.update('aiAssistance', !config.get<boolean>('aiAssistance', true), target);
    }),
    vscode.commands.registerCommand('dhimantai.askCoach', async () => {
      const editor = vscode.window.activeNotebookEditor;
      await vscode.commands.executeCommand('dhimantai.hideCoach');
      return vscode.commands.executeCommand(editor ? 'dhimantai.notebook.ask' : 'dhimantai.openDoubtSolver');
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dhimantai.environment')) {
        practice.refresh();
        if (!testing) void updates.check();
        void vscode.window.showInformationMessage(`dhimantAI now uses ${envName()}. Sign in and reopen your exercise.`);
      }
      if (e.affectsConfiguration('dhimantai.autoUpdate') && !testing) void checkUpdates();
    }),

    command('dhimantai.signIn', 'Signing in', async (expectedEnvironment?: string) => {
      if (expectedEnvironment && expectedEnvironment !== envName()) throw new Error(`Choose ${expectedEnvironment} in Dhimantai: Environment before signing in to that account.`);
      const session = await auth.signIn();
      if (session) void vscode.window.showInformationMessage(`Signed in to dhimantAI as ${session.user.email ?? session.user.phone ?? 'your account'}.`);
    }),
    command('dhimantai.signUp', 'Creating account', async (expectedEnvironment?: string) => {
      if (expectedEnvironment && expectedEnvironment !== envName()) throw new Error(`Choose ${expectedEnvironment} in Dhimantai: Environment before signing up.`);
      const session = await auth.signUp();
      if (session) {
        void vscode.window.showInformationMessage('Your account is ready. Join a course to get started.');
        await catalog.open();
      }
    }),
    command('dhimantai.signOut', 'Signing out', () => auth.signOut()),
    command('dhimantai.openExercise', 'Opening exercise', async (questionId?: string, expectedUser?: string, course?: string, selectedTitle?: string) => {
      let session = (await auth.session()) ?? (await auth.signIn());
      if (!session) return;
      // The app's link names its account: the same exercise can be in one account's course and not another's.
      if (expectedUser && session.user.id !== expectedUser) {
        const who = session.user.email ?? session.user.phone ?? 'another account';
        const choice = await vscode.window.showWarningMessage(
          `VS Code is signed in to dhimantAI ${envName()} as ${who}, but you opened this exercise from a different account in the app.`,
          { modal: true, detail: 'Sign in here with the same account you use in the dhimantAI app.' },
          'Sign in with the app account',
        );
        if (!choice) return;
        await auth.signOut();
        session = await auth.signIn();
        if (!session) return;
        if (session.user.id !== expectedUser) throw new Error('That is still a different account from the one in the app. Sign out in the app or here so both use the same account.');
      }
      const id = questionId ?? await vscode.window.showInputBox({
        title: `Open dhimantAI exercise (${envName()})`,
        prompt: 'Paste the exercise ID from dhimantAI Practice. Opening from the app with "Open exercise with Instructor" is easier.',
        ignoreFocusOut: true,
        validateInput: v => (/^[0-9a-f-]{36}$/i.test(v.trim()) ? undefined : 'Exercise IDs look like 3f2b…-…'),
      });
      if (!id) return;
      try {
        await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', id, session.user.id, course, undefined, undefined, selectedTitle);
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 403)) throw error;
        const who = session.user.email ?? session.user.phone ?? 'your account';
        const message = `${error.message} VS Code is using dhimantAI ${envName()} as ${who}. Open the exercise from the dhimantAI app with "Open exercise with Instructor", and sign in here with the same account.`;
        void vscode.window.showErrorMessage(message, 'Switch account', 'Change service').then(choice => {
          if (choice === 'Switch account') void auth.signOut().then(() => vscode.commands.executeCommand('dhimantai.signIn'));
          if (choice === 'Change service') void vscode.commands.executeCommand('workbench.action.openSettings', 'dhimantai.environment');
        });
      }
    }),
    vscode.window.registerUriHandler(uriHandler),
  );
  if (!testing) void checkUpdates();
  // A learning workspace window: pick the exercise back up.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  let restoringExercise = false;
  if (folder && !testing) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, '.dhimantai.json'));
      restoringExercise = true;
      void openLegacyExercise(folder, envName).catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
    } catch { /* A normal workspace opens the catalog welcome once. */ }
  }
  const welcome = () => catalog.welcome(context.globalState);
  if (!restoringExercise && (!testing || process.env.DHIMANTAI_TEST_WELCOME === '1')) {
    void welcome().catch(error => output.appendLine(`Course Catalog welcome: ${error instanceof Error ? error.message : String(error)}`));
  }
  return testing ? { auth, courses, practice, notebookSubmissionView, uriHandler, copilotPolicy, catalog, welcome } : undefined;
}

// Nothing keeps running after VS Code closes: course containers stop, and a machine dhimantAI started stops too.
let stopCourses: (() => Promise<void>) | undefined;
export function deactivate() { return stopCourses?.(); }
