import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {Api} from '../api';
import {Auth} from '../auth';
import {Environment} from '../environments';
import {appServer, AppConnection, AppForm} from './index';
import {openInjectedTab} from './desktopBrowser';
import {Replayer, ReplayResult, ReplayTask} from './replay';
import {TaskVerifier} from './verifier';

/** Where the application home is, after sign-in, for each adapter. */
const HOME: Record<AppConnection['app'], string> = {frappe: '/desk', odoo: '/odoo'};

/** One authoring pass, independent of VS Code UI so it can be tested with fakes. */
export interface AuthoringSteps {
  discover(forms: string[]): Promise<AppForm[]>;
  ask(questions: string[]): Promise<{question: string; answer: string}[] | undefined>;
  interview(goal: string, forms: AppForm[]): Promise<string[]>;
  draft(goal: string, forms: AppForm[], answers: {question: string; answer: string}[], revise?: {course: unknown; problems: string[]}): Promise<{title: string; lessons: ReplayTask[]}>;
  replay(lessons: ReplayTask[]): Promise<ReplayResult[]>;
  report(message: string): void;
}

/**
 * Discover → interview → draft → replay in the real application → revise from what failed (up to twice).
 * Returns the course only when every task was completed in the application and every decision matters.
 */
export async function authorCourse(goal: string, formNames: string[], steps: AuthoringSteps) {
  const forms = await steps.discover(formNames);
  steps.report(`Discovered ${forms.length} forms: ${forms.map(f => `${f.form} (${f.fields.length} fields)`).join(', ')}.`);
  const answers = await steps.ask(await steps.interview(goal, forms));
  if (!answers) return undefined;
  let course = await steps.draft(goal, forms, answers);
  for (let round = 0; ; round++) {
    steps.report(`Replaying “${course.title}” (${course.lessons.length} tasks) in the application…`);
    const results = await steps.replay(course.lessons);
    for (const r of results) steps.report(`  ${r.ok ? (r.discriminates ? 'passed' : 'passed, but a wrong decision would also pass') : 'failed'}: ${r.task}${r.reason ? ' — ' + r.reason : ''}`);
    const problems = results.flatMap(r => !r.ok ? [`Task ${r.task}: replay failed: ${r.reason}`]
      : r.discriminates === false ? [`Task ${r.task}: a wrong value in a decide=true field still passes; check that field in expected.`] : []);
    if (!problems.length) return {course, results};
    if (round >= 2) throw new Error('The draft still fails in the application after two revisions: ' + problems.slice(0, 3).join(' '));
    steps.report('Revising the draft from what failed in the application…');
    course = await steps.draft(goal, forms, answers, {course, problems});
  }
}

/** Command: author a practical course for a business application running in a sandbox. */
export function registerPracticalAuthoring(context: vscode.ExtensionContext, auth: Auth, service: () => Environment, output: vscode.OutputChannel) {
  return vscode.commands.registerCommand('dhimantai.authorPracticalCourse', async () => {
    const account = (await auth.session())?.user.id;
    if (!account) { void vscode.window.showInformationMessage('Sign in with your teacher account to author a course.'); return; }
    const pick = await vscode.window.showQuickPick([{label: 'ERPNext (Frappe)', app: 'frappe' as const}, {label: 'Odoo', app: 'odoo' as const}],
      {title: 'Author a practical course: which application?'});
    if (!pick) return;
    const ask = (prompt: string, value = '', password = false) => vscode.window.showInputBox({title: 'Author a practical course', prompt, value, password, ignoreFocusOut: true});
    const url = (await ask('Sandbox address (the application must run in a sandbox, not production)', pick.app === 'odoo' ? 'http://127.0.0.1:8069' : 'http://127.0.0.1:8080'))?.replace(/\/$/, '');
    if (!url || !/^https?:\/\/[^/]+$/.test(url)) return;
    const db = pick.app === 'odoo' ? await ask('Odoo database name') : undefined;
    const user = await ask('Sandbox administrator login', pick.app === 'odoo' ? 'admin' : 'Administrator');
    const password = user ? await ask('Sandbox administrator password', '', true) : undefined;
    const forms = (await ask('Forms to teach, comma-separated', pick.app === 'odoo' ? 'res.partner, product.template, sale.order' : 'Customer, Item, Sales Order'))
      ?.split(',').map(f => f.trim()).filter(Boolean);
    const goal = await ask('What should learners be able to do afterwards?');
    if (!user || !password || !forms?.length || !goal) return;
    const connection: AppConnection = {app: pick.app, url, user, password, db};
    const server = appServer(connection), api = new Api(auth, service, account);
    const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'browser').fsPath;
    output.show(true);
    const report = (message: string) => output.appendLine('[authoring] ' + message);
    try {
      const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Authoring a practical course'}, async progress => authorCourse(goal, forms, {
        discover: async names => { progress.report({message: 'Discovering forms'}); return Promise.all(names.map(name => server.describe(name))); },
        interview: async (g, f) => { progress.report({message: 'Preparing questions'}); return (await api.appAuthoring<{questions: string[]}>({stage: 'interview', goal: g, forms: f})).questions; },
        ask: async questions => {
          const answers = [];
          for (const question of questions) {
            const answer = await vscode.window.showInputBox({title: 'Author a practical course', prompt: question, ignoreFocusOut: true});
            if (answer === undefined) return undefined;
            answers.push({question, answer});
          }
          return answers;
        },
        draft: async (g, f, answers, revise) => {
          progress.report({message: revise ? 'Revising the draft' : 'Drafting tasks'});
          return (await api.appAuthoring<{course: {title: string; lessons: ReplayTask[]}}>({stage: 'draft', goal: g, forms: f, answers, revise})).course;
        },
        replay: async lessons => {
          progress.report({message: 'Replaying in the application'});
          // The author's own sandbox session performs every task in the integrated browser, as a learner would.
          const tab = await openInjectedTab({url, home: HOME[pick.app], media, adapter: pick.app, server});
          if (!tab) throw new Error('Replay needs the dhimantAI desktop browser.');
          try {
            const tag = randomBytes(5).toString('hex');
            return await new Replayer(tab.client, tab.sessionId, server, new TaskVerifier(server, media + '/player'), user, tag, media + '/player').run(lessons);
          } finally { await tab.dispose(); }
        },
        report,
      }));
      if (!result) return;
      const target = await vscode.window.showSaveDialog({title: 'Save the verified course', filters: {JSON: ['json']},
        defaultUri: vscode.Uri.file(result.course.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json')});
      if (!target) return;
      const id = result.course.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({id, version: 1, app: pick.app, ...result.course}, null, 2) + '\n'));
      void vscode.window.showInformationMessage(`“${result.course.title}”: every task was completed in ${pick.label} and saved.`);
    } catch (error) {
      report('Stopped: ' + (error instanceof Error ? error.message : String(error)));
      void vscode.window.showErrorMessage('Course authoring: ' + (error instanceof Error ? error.message : String(error)));
    }
  });
}
