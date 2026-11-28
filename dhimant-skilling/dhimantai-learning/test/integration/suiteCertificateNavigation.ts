import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { learningFrame, learningPanel } from './learningFrame';

export async function run() {
  const {auth} = await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:'+process.env.DHIMANTAI_CDP_PORT);
  const page = browser.contexts()[0].pages().find(p=>p.url().includes('workbench'))!;
  page.setDefaultTimeout(10000);
  const capture = async (name:string) => {
    const out = process.env.DHIMANTAI_UX_OUT;
    if (out) { mkdirSync(out,{recursive:true}); await page.screenshot({path:join(out,name+'.png')}); }
  };
  try {
    const session = await auth.signUpWithPassword('Demo Learner','learner@example.test','test-learner-password',false);
    assert.ok(session);
    const joined = await fetch(process.env.DHIMANTAI_TEST_SERVER+'/rest/v1/rpc/join_learning_course',{
      method:'POST',headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({p_course:'python'})});
    assert.ok(joined.ok);
    await vscode.commands.executeCommand('dhimantai.courseCatalog');
    await vscode.commands.executeCommand('dhimantai.learningNavigation.focus');
    const side = await learningFrame(page,'nav[aria-label="Learning destinations"]');
    await side.getByRole('button',{name:'Open account profile'}).getByText('learner@example.test').waitFor();
    await side.getByRole('button',{name:/Resume/}).waitFor();
    assert.match(await side.locator('.resume').innerText(),/1 of 2 chapters taught/);
    await side.getByRole('button',{name:'src ›'}).click();
    await side.getByRole('button',{name:'lesson.py'}).click();
    await page.locator('.tab.active').filter({hasText:'lesson.py'}).waitFor();
    await vscode.commands.executeCommand('notifications.clearAll');
    for (const [key, title] of [['mine','My courses'], ['practice','Practice'], ['mine','My courses'], ['practice','Practice']]) {
      const link = side.locator(`[data-key="${key}"]`);
      await link.click();
      const tab = page.getByRole('tab',{name:title,exact:true});
      await page.locator('.tab.active').filter({hasText:title}).waitFor();
      const view = await learningPanel(page, `body:has(header h1:text-is("${title}")) .cards .course-card[data-course="Python"]`);
      await view.getByRole('heading',{name:title,exact:true}).waitFor();
      assert.equal(await tab.count(),1);
      assert.equal(await link.getAttribute('aria-current'),'page');
      assert.ok(await side.getByRole('navigation',{name:'Learning destinations'}).isVisible());
      assert.match(await view.locator('.course-card').innerText(),/1\/2 chapters taught/);
      if (key === 'practice') {
        for (const label of ['Practice by course','Saved practice notebooks','My certificates'])
          assert.ok(await view.getByRole('heading',{name:label,exact:true}).isVisible());
        await view.getByRole('button',{name:'Open practice',exact:true}).click();
        await page.locator('.quick-input-widget').getByText('Index a Python list',{exact:true}).waitFor();
        await page.keyboard.press('Escape');
        assert.ok(await side.getByRole('navigation',{name:'Learning destinations'}).isVisible());
      } else {
        if (!await view.locator('details[open]').count()) await view.getByText('Outline',{exact:true}).click();
        assert.match(await view.locator('details').innerText(),/Loops · Locked/);
      }
      await capture(key);
    }
    await side.getByRole('button',{name:'My certificates'}).click();
    let grade = await learningFrame(page,'.certificate-library [data-action="courseRequirements"]');
    assert.match(await grade.locator('.activity-count').innerText(),/0 of 37/);
    await vscode.commands.executeCommand('notifications.clearAll');
    await capture('my-certificates');
    await grade.getByRole('button',{name:/View requirements/}).click();
    grade = await learningFrame(page,'#panel-Overview .journey');
    await capture('overview');
    const tablist = grade.getByRole('tablist');
    assert.deepEqual(await tablist.getByRole('tab').allTextContents(),['Overview','Projects','Grades','Certificate','Help']);
    await tablist.getByRole('tab',{name:'Overview'}).press('ArrowRight');
    await grade.getByRole('heading',{name:'Projects and assessments'}).waitFor();
    assert.equal(await grade.getByRole('tabpanel').count(),1);
    assert.equal(await grade.getByRole('tabpanel').locator('input,textarea,select').count(),0);
    await capture('projects');
    await tablist.getByRole('tab',{name:'Grades'}).click();
    assert.equal(await grade.getByRole('tabpanel').locator('tbody:empty').count(),0);
    await grade.getByText('View 37 required activities').waitFor();
    await capture('grades');
    await tablist.getByRole('tab',{name:'Certificate',exact:true}).click();
    const locked = grade.locator('.credential-preview.locked .paper');
    assert.notEqual(await locked.evaluate(el=>getComputedStyle(el).filter),'none');
    assert.ok(await grade.getByRole('button',{name:/Claim certificate/}).isDisabled());
    const prior = grade;
    await Promise.all([page.waitForEvent('framedetached',{predicate:f=>f===prior}),
      grade.getByRole('button',{name:'Refresh',exact:true}).click()]);
    grade = await learningFrame(page,'.credential-preview.locked');
    await capture('certificate');
    await grade.getByRole('tab',{name:'Help',exact:true}).click();
    await grade.getByRole('heading',{name:'How to learn, progress and get assessed'}).waitFor();
    await capture('help');
    await page.setViewportSize({width:790,height:790});
    await vscode.workspace.getConfiguration('workbench').update('colorTheme','Dark Modern',vscode.ConfigurationTarget.Global);
    const dark = await learningFrame(page,'body.vscode-dark #tab-Overview');
    for (const name of ['Overview','Projects','Grades','Certificate','Help']) {
      await dark.getByRole('tab',{name,exact:true}).click();
      assert.ok(await dark.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), name+' fits a narrow desktop');
    }
    await side.getByRole('button',{name:/Resume/}).click();
    await page.locator('.tab.active').filter({hasText:'Python'}).waitFor();
    await auth.signOut();
    await vscode.commands.executeCommand('dhimantai.learningNavigation.focus');
    const signedOut = await learningFrame(page,'footer [data-key="signIn"]');
    assert.equal(await signedOut.locator('[data-key="resume"]').count(),0);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,library:true,tabs:5,projectFile:true,resume:true,signOut:true}));
  } finally { await browser.close(); }
}
