import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { AuthPageDriver } from './authPageDriver';

export async function run(): Promise<void> {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error instanceof Error ? error.stack : error) }); throw error; }
  };
  const ext = vscode.extensions.getExtension<{ auth: Auth; practice: PracticeBrowser }>('optficial.dhimantai-learning')!;
  const { auth, practice } = await ext.activate();
  const driver = new AuthPageDriver();
  const original = { pick: vscode.window.showQuickPick, input: vscode.window.showInputBox };
  (vscode.window as any).showQuickPick = () => { throw new Error('Authentication must not open a picker'); };
  (vscode.window as any).showInputBox = () => { throw new Error('Authentication must not open an input prompt'); };
  const server = process.env.DHIMANTAI_TEST_SERVER!;
  const call = async (path: string, body = {}) => (await fetch(server + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })).json() as Promise<any>;
  const account = {name: 'Page Learner', email: 'page@example.test', password: 'page test password', confirmation: 'page test password'};
  try {
    await check('signup command opens a complete email-only page and links to sign-in', async () => {
      assert.ok((await practice.getChildren()).some(node => practice.getTreeItem(node).command?.command === 'dhimantai.signUp'));
      const command = vscode.commands.executeCommand('dhimantai.signUp');
      await driver.waitForPage();
      assert.deepEqual([...driver.document().querySelectorAll('input')].map(input => input.id), ['name','email','password','confirmation']);
      assert.doesNotMatch(driver.document().body.textContent!, /institute|roll number|phone|SMS/i);
      assert.match(driver.panel!.title, /Sign up/);
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'DhimantAI Course Catalog')), 'an open account page does not block other commands');
      await driver.navigate();
      assert.deepEqual([...driver.document().querySelectorAll('input')].map(input => input.id), ['email','password']);
      assert.match(driver.panel!.title, /Sign in/);
      driver.close(); await command;
      assert.equal(await auth.session(), undefined);
    });
    await check('confirmation mismatch stays on the page without creating an identity', async () => {
      const pending = auth.signUp();
      await driver.submit({...account, confirmation:'different password'});
      assert.equal((await call('/__state')).signups, 0);
      assert.equal((driver.document().getElementById('confirmation') as HTMLInputElement).validationMessage, 'Enter the same password in both password fields.');
      driver.close(); assert.equal(await pending, undefined);
    });
    await check('email signup completes onboarding and resumes the command in the catalog', async () => {
      const command = vscode.commands.executeCommand('dhimantai.signUp');
      await driver.waitForPage();
      await Promise.all([driver.submit(account), driver.submit(account)]);
      await command;
      assert.equal((await auth.session())?.user.email, account.email);
      assert.equal(driver.panel, undefined);
      const state = await call('/__state');
      assert.ok(state.users[0].profile);
      assert.equal(state.signups, 1, 'repeated submission creates only one identity');
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'DhimantAI Course Catalog')));
    });
    await check('sign-in errors stay inline, clear passwords, and allow a successful retry', async () => {
      await auth.signOut();
      const pending = auth.signIn();
      await driver.submit({email:account.email, password:'incorrect password'});
      assert.match(driver.document().getElementById('status')!.textContent!, /Invalid login credentials/);
      assert.equal((driver.document().getElementById('password') as HTMLInputElement).value, '');
      assert.equal((driver.document().getElementById('email') as HTMLInputElement).value, account.email);
      assert.equal(driver.document().querySelector('button')!.disabled, false);
      await driver.submit({email:account.email, password:account.password});
      assert.equal((await pending)?.user.email, account.email);
    });
    await check('reopening uses one page and closing preserves an existing session', async () => {
      const previous = await auth.session(), count = driver.created;
      const first = auth.signIn(), second = auth.signUp();
      assert.equal(driver.created, count + 1);
      assert.match(driver.panel!.title, /Sign up/);
      driver.close();
      assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
      assert.deepEqual(await auth.session(), previous);
    });
    await check('email confirmation returns to sign-in with inline guidance and no local session', async () => {
      await auth.signOut(); await call('/__settings', {confirmation:true});
      const pending = auth.signUp();
      const email = 'confirm-page@example.test';
      await driver.submit({...account, email});
      assert.equal(await auth.session(), undefined);
      assert.match(driver.document().getElementById('status')!.textContent!, /Check your email/);
      assert.match(driver.panel!.title, /Sign in/);
      assert.equal(driver.document().getElementById('confirmation'), null);
      await call('/__verify', {email});
      await driver.submit({email, password:account.password});
      assert.equal((await pending)?.user.email, email);
    });
    await check('changing service closes the old form without authenticating to another service', async () => {
      const pending = auth.signIn();
      await vscode.workspace.getConfiguration('dhimantai').update('environment', 'staging', vscode.ConfigurationTarget.Global);
      assert.equal(await pending, undefined);
      assert.equal(driver.panel, undefined);
      assert.equal(await auth.session(), undefined);
    });
  } finally {
    driver.dispose();
    (vscode.window as any).showQuickPick = original.pick;
    (vscode.window as any).showInputBox = original.input;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
