import * as assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {learningPanel} from './learningFrame';
import {chromium} from 'playwright-core';
import * as vscode from 'vscode';
import {firstPandasCell} from '../../src/starterExercises';
import type {Auth} from '../../src/auth';

export async function run() {
  const extension = vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await extension.activate();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.DHIMANTAI_CDP_PORT);
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench'))!;
  page.setDefaultTimeout(20000);

  const call = async (route:string, body:object = {}) => (await fetch(process.env.DHIMANTAI_TEST_SERVER + route,
    {method:'POST', body:JSON.stringify(body)})).json() as Promise<any>;
  const verified = [];
  try {
    for (const delayed of [false, true]) {
      await call('/__settings',{confirmation:delayed});
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      let view = await learningPanel(page, '.home-feature');
      if (!delayed) {
        await view.locator('.home-feature [data-home-course="c-programming"]').getByRole('button',{name:'Start chapter 1',exact:true}).click();
        view = await learningPanel(page, '#name');
        await view.locator('#name').fill('New Learner');
        await vscode.commands.executeCommand('dhimantai.courseCatalog');
      }
      view = await learningPanel(page, '.home-feature');
      await view.locator('.home-feature [data-home-course="data-science-python"]').getByRole('button',{name:'Start chapter 1',exact:true}).click();
      view = await learningPanel(page, '#name');
      await view.getByText('Continue to Data Science with Python after signing in.').waitFor();
      const email = delayed ? 'confirmed@example.test' : 'direct@example.test';
      const password = 'local-fixture-learner';
      if (delayed) await view.locator('#name').fill('New Learner');
      else assert.equal(await view.locator('#name').inputValue(),'New Learner');
      await view.locator('#email').fill(email);
      await view.locator('#password').fill(password);
      await view.locator('#confirmation').fill(password);
      await view.getByRole('button',{name:'Create account',exact:true}).press('Enter');
      if (delayed) {
        await view.locator('#status').filter({hasText:'confirm your account'}).waitFor();
        assert.ok(!(await call('/__state')).users.find((u:any) => u.email === email).joined);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await call('/__verify',{email});
        const signingIn = vscode.commands.executeCommand('dhimantai.signIn');
        view = await learningPanel(page, '#email');
        await view.locator('#email').fill(email);
        await view.locator('#password').fill(password);
        await view.locator('button.submit').press('Enter');
        await signingIn;
      }
      view = await learningPanel(page, '[role="group"][aria-label*="sales table"]');
      let answers = view.getByRole('group',{name:/pandas sales table/});
      await answers.getByRole('button',{name:'3',exact:true}).click();
      await view.getByRole('status').filter({hasText:'how many rows the table has'}).waitFor();
      if (!delayed) {
        await view.getByRole('button',{name:'Run it to check'}).click();
        const alternative = view.getByRole('link',{name:'Open the original example in JupyterLite'});
        const url = new URL((await alternative.getAttribute('href'))!);
        assert.equal(url.origin,'https://jupyterlite.github.io');
        assert.equal(url.searchParams.get('code'),firstPandasCell);
        assert.equal(url.searchParams.get('execute'),'0');
        await view.getByRole('button',{name:'Run it to check'}).click();
        assert.equal(await view.locator('.practice-code-editor').count(),1);
      }
      await answers.getByRole('button',{name:'10',exact:true}).evaluate(button => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No notebook save acknowledgement')), 10000);
        const onSave = (event: MessageEvent) => {
          if (event.data?.type !== 'notebookSaved') return;
          window.removeEventListener('message', onSave);
          clearTimeout(timeout);
          resolve();
        };
        window.addEventListener('message', onSave);
        (button as HTMLButtonElement).click();
      }));
      await view.getByRole('status').filter({hasText:'Exercise complete.'}).waitFor();
      assert.equal(await view.locator('#notebook-save-status').isVisible(), false);
      assert.ok((await call('/__state')).users.find((u:any) => u.email === email).joined);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      view = await learningPanel(page, '#open-guide');
      await view.getByRole('button',{name:'Explore',exact:true}).click();
      await view.locator('#results [data-course="data-science-python"] .actions')
        .getByRole('button',{name:'Review chapter 1',exact:true}).press('Enter');
      view = await learningPanel(page, '[role="group"][aria-label*="sales table"]');
      answers = view.getByRole('group',{name:/pandas sales table/});
      await view.getByRole('status').filter({hasText:'Exercise complete.'}).waitFor();
      assert.equal(await answers.getByRole('button',{name:'10',exact:true}).isDisabled(),true);
      if (!delayed) {
        const warning = vscode.window.showWarningMessage;
        try {
          (vscode.window as any).showWarningMessage = async (message:string) => {
            assert.equal(message, 'Start this chapter over?'); return 'Start over';
          };
          await view.getByLabel('Notebook options').click();
          await view.getByRole('button',{name:'Start chapter over',exact:true}).click();
          await answers.getByRole('button',{name:'10',exact:true,disabled:false}).click();
          await view.getByRole('status').filter({hasText:'Exercise complete.'}).waitFor();
        } finally { (vscode.window as any).showWarningMessage = warning; }
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await call('/__settings',{chapterRevision:'2'});
        await vscode.commands.executeCommand('dhimantai.courseCatalog');
        view = await learningPanel(page, '#open-guide');
        await view.getByRole('button',{name:'Explore',exact:true}).click();
        await view.getByRole('button',{name:'Start updated chapter 1',exact:true}).click();
        view = await learningPanel(page, '[role="group"][aria-label*="sales table"]');
        assert.equal(await view.getByRole('group',{name:/pandas sales table/}).getByRole('button',{name:'10',exact:true}).isEnabled(),true);
        verified.push('manual chapter restart and automatic restart after publication');
      }
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await auth.signOut();
      verified.push(delayed ? 'email confirmation and later sign-in' : 'immediate signup');
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({verified},null,2));
  } finally { await browser.close(); }
}
