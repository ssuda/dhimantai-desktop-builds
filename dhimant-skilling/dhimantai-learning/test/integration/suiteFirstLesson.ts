import * as assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
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
  const view = page.frameLocator('iframe.webview:visible').last().frameLocator('#active-frame');
  const call = async (route:string, body:object = {}) => (await fetch(process.env.DHIMANTAI_TEST_SERVER + route,
    {method:'POST', body:JSON.stringify(body)})).json() as Promise<any>;
  const verified = [];
  try {
    for (const delayed of [false, true]) {
      await call('/__settings',{confirmation:delayed});
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      if (!delayed) {
        await view.getByRole('button',{name:'Start C Programming',exact:true}).click();
        await view.locator('#name').fill('New Learner');
        await vscode.commands.executeCommand('dhimantai.courseCatalog');
      }
      await view.getByRole('button',{name:'Start Data Science with Python',exact:true}).click();
      await view.getByText('Continue to Data Science with Python after signing in.').waitFor();
      const email = delayed ? 'confirmed@example.test' : 'direct@example.test';
      const password = 'local-fixture-learner';
      if (delayed) await view.locator('#name').fill('New Learner');
      else assert.equal(await view.locator('#name').inputValue(),'New Learner');
      await view.locator('#email').fill(email);
      await view.locator('#password').fill(password);
      await view.locator('#confirmation').fill(password);
      await view.getByRole('button',{name:'Create account',exact:true}).click();
      if (delayed) {
        await view.locator('#status').filter({hasText:'confirm your account'}).waitFor();
        assert.ok(!(await call('/__state')).users.find((u:any) => u.email === email).joined);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await call('/__verify',{email});
        const signingIn = vscode.commands.executeCommand('dhimantai.signIn');
        await view.locator('#email').fill(email);
        await view.locator('#password').fill(password);
        await view.locator('button.submit').click();
        await signingIn;
      }
      const answers = view.getByRole('group',{name:/pandas sales table/});
      await answers.getByRole('button',{name:'3',exact:true}).click();
      await view.getByRole('status').filter({hasText:'How does that differ from counting rows?'}).waitFor();
      if (!delayed) {
        await view.getByRole('button',{name:'Try in a code cell'}).click();
        const alternative = view.getByRole('link',{name:'Open the original example in JupyterLite'});
        const url = new URL((await alternative.getAttribute('href'))!);
        assert.equal(url.origin,'https://jupyterlite.github.io');
        assert.equal(url.searchParams.get('code'),firstPandasCell);
        assert.equal(url.searchParams.get('execute'),'0');
        await view.getByRole('button',{name:'Try in a code cell'}).click();
        assert.equal(await view.locator('.practice-code-editor').count(),1);
      }
      await answers.getByRole('button',{name:'10',exact:true}).click();
      await view.getByRole('status').filter({hasText:'Exercise complete.'}).waitFor();
      await view.locator('#notebook-save-status').filter({hasText:'Saved on this computer.'}).waitFor();
      assert.ok((await call('/__state')).users.find((u:any) => u.email === email).joined);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('dhimantai.openLearningRoom','Data Science with Python','10000000-0000-0000-0000-000000000001');
      await view.getByRole('status').filter({hasText:'Exercise complete.'}).waitFor();
      assert.equal(await answers.getByRole('button',{name:'10',exact:true}).isDisabled(),true);
      await auth.signOut();
      verified.push(delayed ? 'email confirmation and later sign-in' : 'immediate signup');
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({verified},null,2));
  } finally { await browser.close(); }
}
