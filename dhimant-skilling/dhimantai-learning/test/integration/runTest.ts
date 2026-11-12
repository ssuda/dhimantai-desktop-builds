// Launches a real, pinned VS Code with the extension under development and runs suite.ts inside it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { ContractServer } from './contractServer';
import { B2cServer } from './b2cServer';
import { ENVIRONMENTS } from '../../src/environments';
import { createProject, createReadingProject } from '../../src/projectCore';
import { cloneCapstone } from '../../src/capstoneRepo';

const VSCODE_VERSION = process.env.VSCODE_TEST_VERSION ?? '1.106.3';

async function main() {
  const testCourses = ['suiteCourseRuntimes', 'suiteCourseRecovery'].includes(process.argv[2]);
  const testPractice = process.argv[2] === 'suiteExternalProgramming';
  const server = ['suiteB2c', 'suiteCatalogWelcome', 'suiteSignup'].includes(process.argv[2]) ? new B2cServer() : new ContractServer(testCourses || process.argv[2] === 'suiteColab' ? ['Python','Build an LLM from Scratch'] : undefined);
  const url = await server.start();
  const root = resolve(__dirname, '../../..');
  const results = join(mkdtempSync(join(tmpdir(), 'dhimantai-vscode-')), 'results.json');
  const userData = mkdtempSync(join(tmpdir(), 'dhimantai-user-'));
  const workspaceArgs: string[] = [];
  let projectContainer = '', projectDirectory = '';
  const projectPodman = process.env.DHIMANTAI_PODMAN || 'podman';
  try {
  if (['suiteProjectCoach', 'suiteProjectCompletion', 'suiteCourseTerminal'].includes(process.argv[2])) {
    if (!process.env.DHIMANTAI_PROJECT_IMAGE) throw new Error('Set DHIMANTAI_PROJECT_IMAGE to an existing course image for container-only project acceptance.');
    projectDirectory = mkdtempSync(join(root, '.project-coach-'));
    const project = join(projectDirectory, 'course-agent');
    await createProject(join(root, 'media/projects/course-agent'), project);
    for (const id of ['shelf-reading','rich-reading'] as const) await createReadingProject(join(root,'media'),id,join(projectDirectory,id));
    await cloneCapstone(join(root, 'media/capstone/shelf.bundle'), join(projectDirectory, 'shelf-capstone'));
    workspaceArgs.push(project);
    projectContainer = 'dhimantai-project-ui-' + Date.now();
    const user = process.getuid ? `${process.getuid()}:${process.getgid!()}` : '1000:1000';
    execFileSync(projectPodman, ['run','--detach','--pull=never','--name',projectContainer,'--user',user,
      '--volume',projectDirectory + ':/course',process.env.DHIMANTAI_PROJECT_IMAGE,'sleep','300'], {timeout:30000,stdio:'pipe'});
  }
  if (process.argv[2] === 'suiteNativeDebugger') {
    mkdirSync(join(userData,'User'));
    writeFileSync(join(userData,'User','settings.json'),JSON.stringify({'extensions.autoUpdate':false,'extensions.autoCheckUpdates':false}));
  }
  if (process.argv[2] === 'suiteCopilotPolicy') {
    // Existing preferences must survive the desktop window's temporary course policy.
    mkdirSync(join(userData, 'User'));
    writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'chat.disableAIFeatures': false }));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dhimantai-copilot-'));
    const folders = ['first', 'second'].map(name => {
      const path = join(workspaceRoot, name);
      mkdirSync(path);
      return { path };
    });
    const workspace = join(workspaceRoot, 'learning.code-workspace');
    writeFileSync(workspace, JSON.stringify({ folders, settings: { 'chat.disableAIFeatures': false, 'editor.fontSize': 17 } }));
    workspaceArgs.push(workspace);
  }
    // Use a pre-downloaded copy when present (slow networks); otherwise test-electron downloads the pinned build.
    const app = process.env.VSCODE_TEST_EXECUTABLE ?? join(root, '.vscode-test', VSCODE_VERSION, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
    if (process.env.VSCODE_TEST_EXECUTABLE && !existsSync(app)) throw new Error('VSCODE_TEST_EXECUTABLE does not exist: ' + app);
    await runTests({
      ...(existsSync(app) ? { vscodeExecutablePath: app } : { version: VSCODE_VERSION }),
      extensionDevelopmentPath: root,
      extensionTestsPath: resolve(__dirname, process.argv[2] ?? 'suiteLearningRoom'),
      // Native debugger checks opt into an isolated directory of real language adapters.
      launchArgs: [...workspaceArgs, ...(process.env.VSCODE_TEST_LANGUAGE_EXTENSIONS
        ? ['--extensions-dir',process.env.VSCODE_TEST_LANGUAGE_EXTENSIONS]
        : process.argv[2] === 'suiteNativeDebugger' && process.env.VSCODE_TEST_DEBUG_EXTENSIONS
          ? ['--extensions-dir',process.env.VSCODE_TEST_DEBUG_EXTENSIONS] : ['--disable-extensions']), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--user-data-dir', userData,
        '--use-inmemory-secretstorage', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
        // The UX audit drives the real window and screenshots it through Chrome's debugging protocol.
        ...(['suiteComposerShortcut', 'suiteLearningVideo', 'suiteStudy', 'suiteStudyDocuments', 'suiteStudyRegressions', 'suiteStudyExperience', 'suiteStudyCrop', 'suiteStudyConversation', 'suitePracticeUx', 'suiteGeneratedPractice', 'suiteNotebookCoachHistory', 'suiteNotebookCoachChat', 'suiteProjectCoach', 'suiteProjectCompletion'].includes(process.argv[2]) ? ['--remote-debugging-port=' + (process.env.DHIMANTAI_CDP_PORT ?? '9339'), '--window-size=1440,900'] : [])],
      extensionTestsEnv: {
        DHIMANTAI_TEST_ENVIRONMENT: JSON.stringify(process.argv[2] === 'suiteLearningVideo' ? ENVIRONMENTS.staging
          : { apiUrl: url, supabaseUrl: url, supabaseAnonKey: 'test-anon-key' }),
        DHIMANTAI_TEST_SERVER: url,
        DHIMANTAI_TEST_WELCOME: process.argv[2] === 'suiteCatalogWelcome' ? '1' : '0',
        DHIMANTAI_TEST_COURSES: testCourses || testPractice ? '1' : '0',
        DHIMANTAI_TEST_LEARNING_WORKSPACE: testPractice ? '1' : '0',
        DHIMANTAI_TEST_RESULTS: results,
        DHIMANTAI_CDP_PORT: process.env.DHIMANTAI_CDP_PORT ?? '9339',
        DHIMANTAI_UX_OUT: process.env.DHIMANTAI_UX_OUT ?? '',
        DHIMANTAI_PROJECT_CONTAINER: projectContainer,
        DHIMANTAI_PROJECT_PODMAN: projectPodman,
        DHIMANTAI_NATIVE_PYTHON: process.env.DHIMANTAI_NATIVE_PYTHON ?? '0',
        DHIMANTAI_NATIVE_LANGUAGES: process.env.DHIMANTAI_NATIVE_LANGUAGES ?? '',
        DHIMANTAI_NATIVE_PYTHON_PATH: process.env.DHIMANTAI_NATIVE_PYTHON_PATH ?? '',
        DHIMANTAI_NATIVE_COURSE_CONFIG: process.env.DHIMANTAI_NATIVE_COURSE_CONFIG ?? '',
      },
    });
    console.log(readFileSync(results, 'utf8'));
  } catch (error) {
    try { console.error(readFileSync(results, 'utf8')); } catch { /* suite did not start */ }
    console.error('VS Code integration tests failed:', error);
    process.exitCode = 1;
  } finally {
    server.stop();
    if (projectContainer) execFileSync(projectPodman,['rm','--force',projectContainer],{timeout:15000,stdio:'pipe'});
    if (projectDirectory) rmSync(projectDirectory,{recursive:true,force:true});
  }
}

void main();
