import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { EMAIL, PASSWORD } from './contractServer';

/** Exercise the browser handoff in a real extension host without opening a browser or creating users. */
export async function run(): Promise<void> {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error) }); throw error; }
  };
  const ext = vscode.extensions.getExtension<{ auth: Auth; practice: PracticeBrowser }>('optficial.dhimantai-learning')!;
  const { auth, practice } = await ext.activate();
  const original = {
    openExternal: vscode.env.openExternal, info: vscode.window.showInformationMessage,
    warning: vscode.window.showWarningMessage, quickPick: vscode.window.showQuickPick,
    input: vscode.window.showInputBox,
  };
  (vscode.window as any).showQuickPick = async (items: any[]) => items.find(item => item.id === 'institute');
  const opened: string[] = [], warnings: string[] = [];
  let browserWorks = true, finishSignup: ((choice: string | undefined) => void) | undefined;
  (vscode.env as any).openExternal = async (uri: vscode.Uri) => { opened.push(uri.toString(true)); return browserWorks; };
  (vscode.window as any).showInformationMessage = (message: string) => {
    if (message.startsWith('Complete student signup')) return new Promise(resolve => { finishSignup = resolve; });
    return Promise.resolve(undefined);
  };
  (vscode.window as any).showWarningMessage = async (message: string) => { warnings.push(message); };
  const config = vscode.workspace.getConfiguration('dhimantai');
  try {
    await check('signup command opens the selected service without a session or a busy extension', async () => {
      const nodes = await practice.getChildren();
      assert.ok(nodes.some(node => practice.getTreeItem(node).command?.command === 'dhimantai.signUp'));
      for (const [environment, host] of [['production', 'app.dhimant.ai'], ['staging', 'app-staging.dhimant.ai'], ['development', 'app-dev.dhimant.ai']]) {
        await config.update('environment', environment, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('dhimantai.signUp');
        assert.equal(opened.at(-1), `https://${host}/#/student-signup`);
        assert.equal(await auth.session(), undefined);
        finishSignup?.(undefined);
      }
    });
    await check('signup from the sign-in picker cancels the pending authenticated action', async () => {
      (vscode.window as any).showQuickPick = async (items: any[]) => items.find(item => item.id === 'signup') ?? items.find(item => item.id === 'institute');
      assert.equal(await auth.signIn(), undefined);
      assert.equal(await auth.session(), undefined);
      finishSignup?.(undefined);
    });
    await check('a service change during browser registration cannot sign in to the wrong service', async () => {
      await auth.signUpWithInstitute();
      await config.update('environment', 'production', vscode.ConfigurationTarget.Global);
      finishSignup?.('Sign In');
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.match(warnings.at(-1)!, /Signup was opened for development.*now uses production/);
      assert.equal(await auth.session(), undefined);
    });
    await check('failed browser launch and local signup are actionable without signing in', async () => {
      browserWorks = false;
      await assert.rejects(auth.signUpWithInstitute(), /Could not open signup.*https:\/\/app\.dhimant\.ai\/#\/student-signup/);
      browserWorks = true;
      const count = opened.length;
      await config.update('environment', 'local', vscode.ConfigurationTarget.Global);
      await assert.rejects(auth.signUpWithInstitute(), /local DhimantAI web app/);
      assert.equal(opened.length, count, 'local signup must not silently open another service');
      assert.equal(await auth.session(), undefined);
    });
    await check('returning from signup uses normal sign-in and preserves the existing session', async () => {
      await config.update('environment', 'production', vscode.ConfigurationTarget.Global);
      (vscode.window as any).showQuickPick = async (items: any[]) => items.find(item => item.id === 'email') ?? items.find(item => item.id === 'institute');
      (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => options.password ? PASSWORD : EMAIL;
      await vscode.commands.executeCommand('dhimantai.signUp');
      finishSignup?.('Sign In');
      for (let i = 0; i < 100 && !(await auth.session()); i++) await new Promise(resolve => setTimeout(resolve, 20));
      const session = await auth.session();
      assert.equal(session?.user.email, EMAIL);
      await auth.signUpWithInstitute();
      finishSignup?.(undefined);
      assert.deepEqual(await auth.session(), session, 'opening signup must not replace or delete an account');
    });
  } finally {
    finishSignup?.(undefined);
    (vscode.env as any).openExternal = original.openExternal;
    (vscode.window as any).showInformationMessage = original.info;
    (vscode.window as any).showWarningMessage = original.warning;
    (vscode.window as any).showQuickPick = original.quickPick;
    (vscode.window as any).showInputBox = original.input;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
