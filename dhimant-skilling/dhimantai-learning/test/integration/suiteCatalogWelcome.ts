import {learningFrame} from './learningFrame';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectResults } from '../../src/projectResults';
import { loadProjectCurriculum } from '../../src/projectCore';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';
import { CATALOG_PROJECTS } from '../../src/catalogProjects';
import { CourseCatalog } from '../../src/courseCatalog';
import { Auth } from '../../src/auth';

/** Exercises the actual activation hook, catalog buttons and registered learning commands in VS Code. */
export async function run() {
  const results: {step: string; ok: boolean; error?: string}[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); results.push({step, ok:true}); }
    catch (error) { results.push({step, ok:false, error:String(error instanceof Error ? error.stack : error)}); }
  };
  const extension = vscode.extensions.getExtension<{catalog: CourseCatalog; projectResults: ProjectResults; welcome: () => Promise<void>}>('optficial.dhimantai-learning')!;
  const {catalog, projectResults, welcome} = await extension.activate();
  const browser = vscode.env.appName === 'dhimantAI'
    ? await chromium.connectOverCDP('http://127.0.0.1:' + process.env.DHIMANTAI_CDP_PORT) : undefined;
  const desktop = browser?.contexts()[0].pages().find(page => page.url().includes('workbench'));
  if (browser) assert.ok(desktop);
  const panel = () => (catalog as any).panel as vscode.WebviewPanel | undefined;
  const create = vscode.window.createWebviewPanel;
  let learning: vscode.WebviewPanel | undefined, receive: ((message: any) => Promise<void>) | undefined;
  const replies: any[] = [];
  const notebooks = new Set<vscode.WebviewPanel>();
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const host = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      learning = host;
      notebooks.add(host);
      host.onDidDispose(() => notebooks.delete(host));
      (host.webview as any).onDidReceiveMessage = (handler: any) => { receive = handler; return new vscode.Disposable(() => {}); };
      (host.webview as any).postMessage = async (message: any) => { replies.push(message); return true; };
    }
    return host;
  };
  const click = async (action: string, id?: string) => {
    if (desktop && (action === 'tutor' || action === 'doubtSolver')) {
      await catalog.open();
      const name = action === 'tutor' ? 'Instructor' : 'Doubt Solver';
      const sidebar = await learningFrame(desktop,'nav[aria-label="Learning destinations"]');
      await sidebar.getByRole('button',{name,exact:true}).click();
      await desktop.locator('.tab.active').filter({hasText:name + ' notebook'}).waitFor({state:'visible'});
      return;
    }
    const dom = new JSDOM(panel()!.webview.html, {runScripts:'outside-only'});
    try {
      const sent: any[] = [];
      (dom.window as any).acquireVsCodeApi = () => ({postMessage:(message: any) => sent.push(message)});
      for (const script of dom.window.document.querySelectorAll('script')) dom.window.eval(script.textContent!);
      assert.equal(sent.length, 0);
      const button = dom.window.document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]${id ? `[data-id="${id}"]` : ''}`);
      assert.ok(button, `Missing ${action} button`);
      button.click();
      assert.equal(sent.length, 1);
      await (catalog as any).handle(sent[0]);
    } finally { dom.window.close(); }
  };
  const settings = async (unavailable: boolean) => {
    await fetch(process.env.DHIMANTAI_TEST_SERVER + '/__settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({unavailable})});
  };
  try {
    await check('activation welcomes a new profile with the public Course Catalog before sign-in', async () => {
      await welcome(); // Joins the bounded initial load, without creating another panel.
      assert.ok(panel(), 'activation opens Course Catalog');
      assert.match(panel()!.webview.html, /<h1>Course Catalog<\/h1>/);
      assert.match(panel()!.webview.html, /<h3>Python<\/h3>/);
      assert.match(panel()!.webview.html, /data-action="signIn"/);
      assert.ok(!vscode.window.tabGroups.all.some(g => g.tabs.some(t => /Instructor notebook|Doubt Solver notebook/.test(t.label))),
        'welcome does not start an unsolicited learning session');
    });
    if (desktop) await check('Project Mentor opens the project catalog in an empty window', async () => {
      const commands = extension.packageJSON.contributes.commands as {command:string; title:string}[];
      assert.ok(commands.some(c => c.command === 'dhimantai.openProjectMentor' && c.title === 'Open Project Mentor'));
      assert.ok(commands.every(c => !['dhimantai.openProjectCoach', 'dhimantai.openBuildStudio'].includes(c.command)));
      await vscode.commands.executeCommand('dhimantai.openProjectMentor');
      const view = await learningFrame(desktop, '#results [data-project]');
      assert.equal(await view.locator('input[name=category]:checked').inputValue(), 'type:project');
    });
    if (desktop) await check('Explore category chips select projects and bundles directly by click and keyboard', async () => {
      const view = await learningFrame(desktop,'#open-guide');
      await view.getByRole('button',{name:'Explore',exact:true}).click();
      const categories = view.getByRole('group', {name:'Category', exact:true});
      const count = view.locator('#result-count');
      await categories.getByText('Projects',{exact:true}).click();
      assert.equal(await count.textContent(), `${CATALOG_PROJECTS.length} matching projects`);
      const bundles = categories.getByRole('radio',{name:'Bundles',exact:true});
      await bundles.focus(); await bundles.press('Space');
      await view.locator('#results [data-bundle]:visible').first().waitFor();
      assert.equal(await count.textContent(), '1 matching bundle');
      await categories.getByText('All',{exact:true}).click();
      assert.equal(await view.locator('[data-group="type:project"] .course:visible').count(),6);
      const colors = await view.locator('#results .course').evaluateAll(cards => cards.map(card => ({
        group:card.closest('section')?.dataset.group, color:getComputedStyle(card).backgroundColor
      })));
      assert.equal(new Set(colors.filter(c => c.group === 'type:project').map(c => c.color)).size,1);
      assert.ok(new Set(colors.map(c => c.color)).size >= 3);
      if (process.env.DHIMANTAI_UX_OUT) await desktop.screenshot({path:join(process.env.DHIMANTAI_UX_OUT,'explore.png')});
      await view.locator('[data-group="type:project"] .group-more').click();
      assert.equal(await view.locator('[data-group="type:project"] .course:visible').count(),12);
    });
    if (desktop) await check('Home track shortcuts open filtered Explore using the keyboard', async () => {
      const view = await learningFrame(desktop,'#open-guide');
      await view.getByRole('button',{name:'Home',exact:true}).click();
      const chip = view.locator('.type-chip[data-browse-category="type:project"]');
      await chip.focus(); await chip.press('Enter');
      assert.ok(await view.locator('#explore-title').evaluate(el => el === document.activeElement));
      assert.equal(await view.locator('#results [data-project]:visible').count(), CATALOG_PROJECTS.length);
      assert.equal(await view.locator('#results [data-course]:visible').count(), 0);
    });
    if (desktop) await check('optional help opens from the catalog footer and returns keyboard focus', async () => {
      const view = await learningFrame(desktop,'#open-guide');
      const trigger = view.getByRole('button', {name:'Help & Course Guide', exact:true});
      await trigger.scrollIntoViewIfNeeded();
      await trigger.evaluate(el => (el as HTMLButtonElement).focus({preventScroll:true}));
      const scroll = await trigger.evaluate(el => {
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) throw new Error('Guide is outside the viewport');
        return window.scrollY;
      });
      assert.ok(scroll > 0);
      await trigger.press('Enter');
      const guide = view.getByRole('dialog', {name:'Help & Course Guide'});
      assert.equal(await guide.getByRole('tab').count(), 5);
      await guide.getByRole('tab', {name:'Learning', exact:true}).press('ArrowRight');
      assert.ok(await guide.getByRole('tabpanel', {name:'Run Your Code'}).isVisible());
      assert.ok(await guide.getByRole('button', {name:'Set Up Course Container'}).isVisible());
      if (process.env.DHIMANTAI_UX_OUT) await desktop.screenshot({path:join(process.env.DHIMANTAI_UX_OUT, 'course-guide.png')});
      await guide.getByRole('tab', {name:'AI Help Rules'}).click();
      assert.ok(await guide.getByText('How to restore Copilot', {exact:true}).isVisible());
      await guide.getByRole('tab', {name:'AI Help Rules'}).press('Escape');
      await guide.waitFor({state:'hidden'});
      assert.ok(await trigger.evaluate(el => document.activeElement === el));
      assert.equal(await trigger.evaluate(() => window.scrollY), scroll);
    });
    await check('command search delegates to the native palette before sign-in', async () => {
      const execute = vscode.commands.executeCommand;
      const opened: unknown[][] = [];
      (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
        if (command === 'workbench.action.quickOpen') { opened.push(args); return; }
        return execute(command, ...args);
      };
      try {
        await click('commands');
        assert.deepEqual(opened, [['>dhimantAI ']]);
      } finally { (vscode.commands as any).executeCommand = execute; }
    });
    await check('Projects is a standalone catalog category with complete cards before sign-in', async () => {
      const dom = new JSDOM(panel()!.webview.html);
      try {
        const section = dom.window.document.querySelector('#results')!;
        assert.ok(section, 'projects are independent of Engineering Essentials');
        const cards = [...section.querySelectorAll<HTMLElement>('[data-project]')];
        assert.deepEqual(cards.map(c => c.dataset.project), CATALOG_PROJECTS.map(project => project.id));
        for (const card of cards) {
          const project = CATALOG_PROJECTS.find(project => project.id === card.dataset.project)!;
          assert.equal(card.querySelector('h3')!.textContent, project.title);
          assert.equal(card.querySelector('p')!.textContent, project.description);
          assert.equal(card.querySelector('.size-tag')!.textContent, project.level);
          assert.equal(card.querySelector('.project-status')!.textContent, 'Not started');
          assert.match(card.textContent!, /Beginner|Intermediate/);
          assert.ok(card.textContent!.includes('Estimated ' + project.estimatedTime));
          assert.match(card.textContent!, /Learning outcomes/);
          assert.equal(card.querySelectorAll('li').length, project.outcomes.length);
          const buttons = [...card.querySelectorAll<HTMLButtonElement>('button')];
          assert.equal(buttons.length, 1, 'one clear action per project');
          assert.equal(buttons[0].textContent, 'Start Project');
          assert.equal(buttons[0].dataset.id, card.dataset.project);
          assert.equal(buttons[0].disabled, false);
        }
      } finally { dom.window.close(); }
    });
    await check('Start Project selects the exact project without a second picker, even offline', async () => {
      const execute = vscode.commands.executeCommand, pick = vscode.window.showQuickPick;
      let setups = 0;
      (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
        if (command === 'dhimantai.projectFolder') { setups++; return; } // Cancel before any runtime or file mutation.
        return execute(command, ...args);
      };
      (vscode.window as any).showQuickPick = async () => { throw new Error('A selected project must not open another picker'); };
      try {
        await settings(true);
        await catalog.refresh();
        for (const id of ['course-agent', 'shelf']) await click('project', id);
        assert.equal(setups, 2, 'every card reaches the course folder selection');
        await (catalog as any).handle({type:'project', id:'unknown'});
        await vscode.commands.executeCommand('dhimantai.startCapstone', '../unknown');
        for (const id of ['shelf-reading', 'rich-reading']) {
          await (catalog as any).handle({type:'project', id});
          await vscode.commands.executeCommand('dhimantai.startCapstone', id);
        }
        assert.equal(setups, 2, 'unknown and paused IDs cannot start setup');
      } finally {
        (vscode.commands as any).executeCommand = execute;
        (vscode.window as any).showQuickPick = pick;
        await settings(false);
        await catalog.refresh();
      }
    });
    await check('the command palette offers active projects and the old reading shortcut opens no picker', async () => {
      const pick = vscode.window.showQuickPick;
      const choices: string[][] = [];
      (vscode.window as any).showQuickPick = async (items: {id: string}[]) => { choices.push(items.map(i => i.id)); };
      try {
        await vscode.commands.executeCommand('dhimantai.startCapstone');
        await vscode.commands.executeCommand('dhimantai.startCapstone', 'engineering-code-reading');
        assert.deepEqual(choices, [CATALOG_PROJECTS.map(project => project.id)]);
      } finally { (vscode.window as any).showQuickPick = pick; }
    });
    await check('old reading workspaces and saved shortcuts cannot launch Coach or erase notes', async () => {
      const media = join(extension.extensionPath, 'media');
      const environment = vscode.workspace.getConfiguration('dhimantai').get<string>('environment', 'production');
      const show = vscode.window.showInformationMessage;
      const notices: string[] = [];
      (vscode.window as any).showInformationMessage = (text: string) => { notices.push(text); };
      try {
        for (const id of ['shelf-reading', 'rich-reading']) {
          const plan = await loadProjectCurriculum(media, id);
          const root = mkdtempSync(join(tmpdir(), id));
          try {
            writeFileSync(join(root, '.dhimantai-project.json'), JSON.stringify({id, version:1}));
            const notebook = join(root, 'READING_NOTES.md');
            writeFileSync(notebook, 'My saved reading notes');
            const saved = await projectResults.save(environment, 'local', root, plan);
            await vscode.commands.executeCommand('dhimantai.openSavedProject', root);
            await vscode.commands.executeCommand('dhimantai.openProjectCoach', root);
            assert.deepEqual(projectResults.get(environment, 'local', root), saved);
            assert.equal(readFileSync(notebook, 'utf8'), 'My saved reading notes');
            assert.ok(!(await projectResults.summaries(media, environment, 'local')).some(p => p.root === root));
          } finally {
            await projectResults.remove(environment, 'local', root);
            rmSync(root, {recursive:true, force:true});
          }
        }
        assert.equal(notices.length, 4);
        assert.ok(notices.every(text => text.includes('paused on desktop')));
      } finally { (vscode.window as any).showInformationMessage = show; }
    });
    await check('lifecycle messages cannot restart a pending catalog load', async () => {
      let reads = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const auth = new Auth({
        get: async () => { reads++; await gate; return undefined; },
        store: async () => {}, delete: async () => {},
        onDidChange: () => new vscode.Disposable(() => {}),
      }, () => 'production', () => JSON.parse(process.env.DHIMANTAI_TEST_ENVIRONMENT!));
      const pendingCatalog = new CourseCatalog(auth, () => 'production',
        () => JSON.parse(process.env.DHIMANTAI_TEST_ENVIRONMENT!), () => {});
      const loading = pendingCatalog.open();
      const host = (pendingCatalog as any).panel as vscode.WebviewPanel;
      const html = host.webview.html;
      const dom = new JSDOM(html, {runScripts:'outside-only'});
      const delivered: Promise<unknown>[] = [];
      try {
        const sent: any[] = [];
        (dom.window as any).acquireVsCodeApi = () => ({postMessage: (message: any) => {
          sent.push(message);
          delivered.push((pendingCatalog as any).handle(message));
        }});
        for (const script of dom.window.document.querySelectorAll('script')) dom.window.eval(script.textContent!);
        assert.equal(sent.length, 0);
        for (const message of [undefined, null, {}, {type:'ready'}, {type:'unknown'}]) {
          delivered.push((pendingCatalog as any).handle(message));
        }
        assert.equal(reads, 1, 'lifecycle and unknown messages must not start another load');
        assert.equal(host.webview.html, html, 'the loading document and its buttons stay mounted');
        release();
        await Promise.all([loading, ...delivered]);
        assert.match(host.webview.html, /<h3>Python<\/h3>/, 'the original load completes');
      } finally {
        pendingCatalog.dispose();
        release();
        await Promise.allSettled([loading, ...delivered]);
        dom.window.close();
      }
    });
    await check('welcome respects the host startup policy; explicit Catalog navigation still opens it', async () => {
      panel()!.dispose();
      await welcome();
      if (vscode.env.appName === 'dhimantAI') assert.ok(panel(), 'the custom desktop welcomes an empty window with Course Catalog');
      else assert.equal(panel(), undefined, 'the stock VS Code profile is not welcomed again');
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      assert.ok(panel());
    });
    await check('offline Catalog opens separate Instructor and Doubt Solver tabs and reuses each one', async () => {
      await settings(true);
      panel()!.dispose();
      await catalog.open();
      assert.equal((catalog as any).selection, undefined);
      const html = panel()!.webview.html;
      await (catalog as any).handle({type:'ready'});
      assert.equal(panel()!.webview.html, html, 'offline lifecycle messages does not reload the document');
      await click('doubtSolver');
      assert.equal(learning?.title, 'Doubt Solver notebook');
      await receive!({type:'ready'});
      assert.deepEqual(replies.at(-1), {type:'openTutor', mode:'doubt_solver'});
      const doubt = learning;
      await click('tutor');
      const tutor = learning;
      assert.notEqual(tutor, doubt, 'each mode owns its own notebook panel');
      assert.equal(notebooks.size, 2);
      await receive!({type:'ready'});
      assert.deepEqual(replies.at(-1), {type:'openTutor', mode:'tutor'});
      const opened = replies.filter(message => message.type === 'openTutor').length;
      await click('doubtSolver');
      await click('tutor');
      assert.equal(notebooks.size, 2, 'repeated clicks never duplicate tabs');
      assert.equal(replies.filter(message => message.type === 'openTutor').length, opened,
        'revealing an existing tab never restarts its lesson or session');
    });
    await check('opening both tabs before webview readiness preserves their modes and defers welcome', async () => {
      for (const notebook of [...notebooks]) notebook.dispose();
      await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
      const doubt = learning, doubtReceive = receive!;
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      const tutor = learning;
      await doubtReceive({type:'ready'});
      assert.deepEqual(replies.at(-1), {type:'openTutor', mode:'doubt_solver'});
      await receive!({type:'ready'});
      assert.notEqual(tutor, doubt);
      assert.equal(notebooks.size, 2);
      assert.deepEqual(replies.at(-1), {type:'openTutor', mode:'tutor'});
      tutor!.dispose();
      assert.equal(notebooks.size, 1, 'closing Instructor keeps Doubt Solver open');
      panel()!.dispose();
      let marked = false;
      const state = {get: () => false, update: async () => {marked = true;}, keys: () => []} as vscode.Memento;
      await catalog.welcome(state);
      assert.equal(panel(), undefined, 'first welcome never replaces an already open learning notebook');
      assert.equal(marked, false, 'welcome is deferred to a later launch');
    });
    await check('restored source work defers welcome and explicit Catalog navigation can recover offline', async () => {
      for (const notebook of [...notebooks]) notebook.dispose();
      const document = await vscode.workspace.openTextDocument({language:'python', content:'print("keep my work")'});
      await vscode.window.showTextDocument(document);
      const state = {get: () => false, update: async () => {}, keys: () => []} as vscode.Memento;
      await catalog.welcome(state);
      assert.equal(vscode.window.activeTextEditor?.document, document);
      assert.equal(panel(), undefined);
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      assert.ok(panel());
      await settings(false);
      await click('refresh');
      assert.match(panel()!.webview.html, /<h3>Python<\/h3>/);
    });
  } finally {
    await browser?.close();
    (vscode.window as any).createWebviewPanel = create;
    for (const notebook of [...notebooks]) notebook.dispose();
    catalog.dispose();
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({passed:results.filter(r=>r.ok).length,
      failed:results.filter(r=>!r.ok).length,results},null,2));
  }
  if (results.some(r => !r.ok)) throw new Error('Course Catalog welcome checks failed');
}
