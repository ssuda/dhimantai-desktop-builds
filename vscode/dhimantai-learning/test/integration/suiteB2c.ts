import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { learnerRpc, PublicCatalog } from '../../src/learnerCatalog';
import { CourseCatalog } from '../../src/courseCatalog';
import { JSDOM } from 'jsdom';
import { AuthPageDriver } from './authPageDriver';

export async function run() {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error) }); throw error; }
  };
  const server = process.env.DHIMANTAI_TEST_SERVER!;
  const env = JSON.parse(process.env.DHIMANTAI_TEST_ENVIRONMENT!);
  const call = async (path: string, body = {}) => (await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  const ext = vscode.extensions.getExtension<{ auth: Auth; practice: PracticeBrowser }>('optficial.dhimantai-learning')!;
  const { auth, practice } = await ext.activate();
  const accountPage = new AuthPageDriver();
  const original = { info: vscode.window.showInformationMessage, pick: vscode.window.showQuickPick, input: vscode.window.showInputBox };
  const messages: string[] = [];
  const password = 'a local test password';
  (vscode.window as any).showInformationMessage = async (message: string) => { messages.push(message); };
  (vscode.window as any).showQuickPick = async (items: any[]) => items.find(item => item.id === 'individual');
  (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => options.password ? password : options.title === 'Your name' ? 'Test Learner' : 'new@example.test';
  try {
    await check('course previews are available before signup without granting enrollment', async () => {
      const catalog = await learnerRpc<PublicCatalog>(env, 'public_learning_catalog');
      assert.equal(catalog.individual, false);
      assert.equal(catalog.courses[0].title, 'Python');
      assert.equal(catalog.courses[0].enrolled, false);
      assert.equal(await auth.session(), undefined);
    });
    await check('individual signup creates a profile and offers the course catalog', async () => {
      const signup = vscode.commands.executeCommand('dhimantai.signUp');
      await accountPage.waitForPage();
      await accountPage.submit({name:'Test Learner', email:'new@example.test', password, confirmation:password});
      await signup;
      assert.equal((await auth.session())?.user.email, 'new@example.test');
      assert.ok((await call('/__state')).users[0].profile);
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'DhimantAI Course Catalog')));
      assert.ok(!(await practice.getChildren()).some(node => node.kind === 'course'), 'signup alone does not enroll');
    });
    await check('joining a catalog course makes it available in Practice and survives retries', async () => {
      const catalog = new CourseCatalog(auth, () => 'production', () => env, () => practice.refresh());
      try {
        await catalog.open();
        const dom = new JSDOM((catalog as any).panel.webview.html, { runScripts: 'outside-only' });
        const sent: any[] = [];
        (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (message: any) => sent.push(message) });
        for (const script of dom.window.document.querySelectorAll('script')) dom.window.eval(script.textContent!);
        assert.equal(sent.length, 0);
        assert.equal(dom.window.document.querySelector('input'), null, 'a short catalog needs no search box');
        assert.equal(dom.window.document.querySelectorAll('main [data-course] button:not(.secondary)').length, 1, 'one primary action per course');
        const join = dom.window.document.querySelector('button[data-action="join"]') as HTMLButtonElement;
        join.click(); join.click();
        assert.equal(sent.length, 1, 'joining disables repeated clicks');
        assert.equal(sent[0].id, 'python');
        assert.match(dom.window.document.querySelector('main')!.textContent!, /Unlock all · ₹499/, 'the course price sits on its card');
        assert.equal(dom.window.document.querySelectorAll('.offer').length, 1, 'only multi-course offers are bundles');
        assert.match(dom.window.document.querySelector('.offer')!.textContent!, /Programming bundle/);
        assert.match(dom.window.document.querySelector('main')!.textContent!, /First chapter free/);
        assert.match(dom.window.document.querySelector('main')!.textContent!, /Locked/);
        const buy = dom.window.document.querySelector('button[data-action="buy"]') as HTMLButtonElement;
        buy.click(); buy.click();
        assert.equal(sent.filter(m => m.type === 'buy').length, 1, 'purchase disables repeated clicks');
        assert.equal(sent.at(-1).id, 'python-once');
        dom.window.close();
        await (catalog as any).handle({ type: 'join', id: 'not-published' });
        assert.equal((await call('/__state')).users[0].joined, false);
        await (catalog as any).handle({ type: 'join', id: 'python' });
        assert.ok((await practice.getChildren()).some(node => node.kind === 'course' && node.course.name === 'Python'));
        const courseNode = (await practice.getChildren()).find(node => node.kind === 'course')!;
        const chapters = await practice.getChildren(courseNode);
        const locked = chapters.find(node => node.kind === 'chapter' && node.chapter.locked)!;
        assert.equal(practice.getTreeItem(locked).command?.command, 'dhimantai.pricing');
        assert.equal((await practice.getChildren(locked))[0].kind, 'notice', 'locked chapters do not expose questions');
        const selected = await learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, await auth.accessToken());
        assert.equal(selected.courses[0].enrolled, true);
        await learnerRpc(env, 'join_learning_course', { p_course: 'python' }, await auth.accessToken());
      } finally { catalog.dispose(); }
    });
    await check('fully free courses show all chapters without a checkout or coming-soon price', async () => {
      const catalog = new CourseCatalog(auth, () => 'production', () => env, () => practice.refresh());
      try {
        await catalog.open();
        const selected = await learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, await auth.accessToken());
        selected.courses = selected.courses.map(course => ({ ...course, is_free: true, unlocked: true,
          chapters: course.chapters.map(chapter => ({ ...chapter, free: true })) }));
        // Keep the old paid offer in this fixture to ensure the card still suppresses checkout.
        (catalog as any).render(selected);
        const dom = new JSDOM((catalog as any).panel.webview.html);
        try {
          const card = dom.window.document.querySelector('.course')!;
          assert.match(card.textContent!, /Free course · All chapters included/);
          assert.doesNotMatch(card.textContent!, /Locked|coming soon|First chapter free|Unlock all/);
          assert.equal(card.querySelectorAll('button[data-action="buy"]').length, 0);
          assert.deepEqual([...card.querySelectorAll<HTMLButtonElement>('.actions button')].map(b => b.dataset.action),
            ['practice', 'study'], 'joined free courses offer Continue and Study');
        } finally { dom.window.close(); }
      } finally { catalog.dispose(); }
    });
    await check('institute accounts get an individual sign-in action without public-course enrollment', async () => {
      await call('/__settings', { institute: true });
      const catalog = new CourseCatalog(auth, () => 'production', () => env, () => practice.refresh());
      try {
        await catalog.open();
        const dom = new JSDOM((catalog as any).panel.webview.html, { runScripts: 'outside-only' });
        const sent: any[] = [];
        (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (message: any) => sent.push(message) });
        for (const script of dom.window.document.querySelectorAll('script')) dom.window.eval(script.textContent!);
        assert.equal(sent.length, 0);
        const card = dom.window.document.querySelector('.course')!;
        const action = card.querySelector('.actions button') as HTMLButtonElement;
        assert.equal(action.textContent, 'Use individual account');
        assert.equal(action.disabled, false);
        assert.equal(card.querySelectorAll('.actions button').length, 1);
        assert.equal(dom.window.document.querySelectorAll('button[data-action="buy"]').length, 0);
        assert.match(dom.window.document.body.textContent!, /Public courses use a separate individual learner account/);
        action.click();
        assert.equal(sent[0].type, 'signIn');
        dom.window.close();
        const account = (await auth.session())!.user.id;
        const signin = (catalog as any).handle(sent[0]);
        await accountPage.waitForPage();
        accountPage.close();
        await signin; // Cancelling sign-in keeps the existing session.
        assert.equal((await auth.session())!.user.id, account);
        assert.ok(!(await practice.getChildren()).some(node => node.kind === 'course'));
        await (catalog as any).handle({type: 'join', id: 'python'});
        assert.equal((catalog as any).selection.catalog.courses[0].enrolled, false);
      } finally {
        catalog.dispose();
        await call('/__settings', { institute: false });
      }
    });
    await check('Engineering Essentials paths stay separate from searchable project cards', async () => {
      const catalog = new CourseCatalog(auth, () => 'production', () => env, () => practice.refresh());
      try {
        await catalog.open();
        const selected = await learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, await auth.accessToken());
        const base = selected.courses[0];
        const essential = (id: string, title: string, free = true) => ({ ...base, id: 'engineering-' + id, title, is_free: free, unlocked: free,
          enrolled: false, chapters: base.chapters.map((chapter, i) => ({ ...chapter, free: free || i === 0 })) });
        selected.courses = [...selected.courses.map(c => c.id === 'build-an-llm' ? {...c, category: 'AI & Machine Learning'} : c),
          essential('git', 'Git for Everyday Engineering'), essential('sql-data', 'SQL and Data Integrity', false)];
        (catalog as any).render(selected);
        const dom = new JSDOM((catalog as any).panel.webview.html, { runScripts: 'outside-only' });
        try {
          const doc = dom.window.document;
          (dom.window as any).acquireVsCodeApi = () => ({ postMessage() {} });
          for (const script of doc.querySelectorAll('script')) dom.window.eval(script.textContent!);
          // Essentials have their own section under Software Engineering, never mixed into the plain course grid.
          assert.equal(doc.querySelectorAll('.category > .courses [data-course^="engineering-"]').length, 0);
          assert.ok(doc.querySelector('#category-software-engineering ~ .essentials, .category .essentials'));
          assert.equal(doc.querySelectorAll('.essentials .course').length, 2);
          const paths = [...doc.querySelectorAll<HTMLButtonElement>('.paths button')];
          assert.deepEqual(paths.map(b => b.textContent), ['All', 'Before a first project', 'Backend and data']);
          paths[2].click();
          const visible = [...doc.querySelectorAll<HTMLElement>('.essentials .course')].filter(c => !c.hidden).map(c => c.dataset.course);
          assert.deepEqual(visible, ['engineering-sql-data']);
          assert.equal(doc.querySelector('.essentials button[data-action="capstone"]'), null);
          assert.equal(doc.querySelectorAll('main > .projects [data-project]').length, 4);
          assert.ok([...doc.querySelectorAll<HTMLElement>('[data-project]')].every(p => !p.hidden), 'course paths do not filter projects');
          // Categories group the catalog in a fixed order.
          const headings = [...doc.querySelectorAll('.category > h3')].map(h => h.textContent);
          assert.equal(headings[0], 'Software Engineering');
          if (selected.courses.some(c => c.id === 'build-an-llm')) {
            assert.ok(headings.includes('AI & Machine Learning'));
            assert.ok(doc.querySelector('#category-ai-machine-learning ~ .courses [data-course="build-an-llm"], [aria-labelledby="category-ai-machine-learning"] [data-course="build-an-llm"]'));
          }
          const cards = [...doc.querySelectorAll('.essentials .course')].map(c => c.textContent!);
          assert.match(cards[0], /· Free/);assert.match(cards[1], /First chapter free/);
          assert.match(doc.querySelector('.essentials > p')!.textContent!, /Courses labelled Free include all chapters\. Paid courses include a free first chapter;/);
          const search = doc.querySelector<HTMLInputElement>('#search')!;
          assert.ok(search, 'search includes both courses and projects');
          const find = (query: string) => { search.value = query; search.dispatchEvent(new dom.window.Event('input')); };
          const visibleProjects = () => [...doc.querySelectorAll<HTMLElement>('[data-project]')].filter(p => !p.hidden).map(p => p.dataset.project);
          find('research agent');
          assert.deepEqual(visibleProjects(), ['course-agent']);
          assert.equal(doc.querySelector<HTMLElement>('.essentials')!.hidden, true);
          assert.equal(doc.querySelector<HTMLElement>('#empty')!.hidden, true);
          find('regression test');
          assert.deepEqual(visibleProjects(), ['shelf'], 'learning outcomes are searchable');
          find('no-such-course-or-project');
          assert.equal(doc.querySelector<HTMLElement>('.projects')!.hidden, true);
          assert.equal(doc.querySelector<HTMLElement>('#empty')!.hidden, false);
          assert.match(doc.querySelector('#empty')!.textContent!, /courses or projects/);
          find('');
          assert.equal(visibleProjects().length, 4);
          assert.equal(doc.querySelector<HTMLElement>('.essentials')!.hidden, false);
          assert.equal(doc.querySelector<HTMLElement>('.projects')!.hidden, false);
        } finally { dom.window.close(); }
        for (const free of [true, false]) {
          selected.courses = selected.courses.map(c => ({...c, is_free:free}));
          (catalog as any).render(selected);
          const rendered = new JSDOM((catalog as any).panel.webview.html);
          const intro = rendered.window.document.querySelector('.essentials > p')!.textContent!;
          assert.match(intro, free ? /free in full, with all chapters included/ : /free first chapter.*remaining chapters/);
          assert.doesNotMatch(intro, /Start free with|The others/);
          rendered.window.close();
        }
      } finally { catalog.dispose(); }
    });
    await check('email confirmation creates no local session until verification and sign-in', async () => {
      await auth.signOut();
      await call('/__settings', { confirmation: true });
      assert.equal(await auth.signUpWithPassword('Confirm Learner', 'confirm@example.test', password), undefined);
      assert.equal(await auth.session(), undefined);
      assert.match(messages.at(-1)!, /Check your email/);
      await assert.rejects(auth.signInWithPassword('confirm@example.test', password), /Email not confirmed/);
      await call('/__verify', { email: 'confirm@example.test' });
      await auth.signInWithPassword('confirm@example.test', password);
      assert.equal((await auth.session())?.user.email, 'confirm@example.test');
    });
    await check('profile failure recovers through sign-in without creating a second account', async () => {
      await auth.signOut();
      await call('/__settings', { confirmation: false, profileFailure: true });
      await assert.rejects(auth.signUpWithPassword('Retry Learner', 'retry@example.test', password), /retry profile/);
      assert.equal(await auth.session(), undefined);
      const count = (await call('/__state')).signups;
      await call('/__settings', { profileFailure: false });
      await auth.signInWithPassword('retry@example.test', password);
      assert.equal((await call('/__state')).signups, count);
      assert.equal((await auth.session())?.user.email, 'retry@example.test');
    });
    await check('cancellation, invalid fields and missing rollout do not create identities', async () => {
      await auth.signOut();
      const count = (await call('/__state')).signups;
      (vscode.window as any).showInputBox = async () => undefined;
      const signup = auth.signUp();
      accountPage.close();
      assert.equal(await signup, undefined);
      await assert.rejects(auth.signUpWithPassword('A', 'invalid', 'short'));
      await call('/__settings', { unavailable: true });
      await assert.rejects(auth.signUpWithPassword('New Learner', 'unavailable@example.test', password), /not available on this service/);
      assert.equal((await call('/__state')).signups, count);
    });
  } finally {
    accountPage.dispose();
    (vscode.window as any).showInformationMessage = original.info;
    (vscode.window as any).showQuickPick = original.pick;
    (vscode.window as any).showInputBox = original.input;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
