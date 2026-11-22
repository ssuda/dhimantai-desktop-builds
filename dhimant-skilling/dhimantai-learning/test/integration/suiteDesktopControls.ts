import * as assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import type {CourseCatalog} from '../../src/courseCatalog';
import {DesktopUpdates, installedDesktop} from '../../src/desktopUpdates';
import {ExtensionUpdates} from '../../src/updates';

/** Drive the actual activity bar and catalog. Supply deterministic manifests at the updater's network boundary. */
export async function run() {
  const target = await installedDesktop(vscode.env.appRoot);
  const extension = vscode.extensions.getExtension<{auth: Auth; catalog: CourseCatalog}>('optficial.dhimantai-learning')!;
  const {auth, catalog} = await extension.activate();
  await vscode.workspace.getConfiguration('dhimantai').update('autoUpdate', false, vscode.ConfigurationTarget.Global);
  const checkExtension = ExtensionUpdates.prototype.check, checkDesktop = DesktopUpdates.prototype.check;
  let offline = true, mismatch = false;
  ExtensionUpdates.prototype.check = function() {
    Object.assign(this, {fetcher:async () => offline ? new Response(null, {status:503}) : Response.json({
      extension:'optficial.dhimantai-learning', version:extension.packageJSON.version, file:'dhimantai-learning.vsix', sha256:'a'.repeat(64)})});
    return checkExtension.call(this);
  };
  DesktopUpdates.prototype.check = function() {
    Object.assign(this, {fetcher:async () => Response.json({schemaVersion:2, distribution:'dhimantai-desktop', environment:target.environment,
      artifacts:[{...target, arch:mismatch ? 'unsupported' : target.arch, channel:target.version.includes('preview') ? 'preview' : 'stable'}]})});
    return checkDesktop.call(this);
  };
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.DHIMANTAI_CDP_PORT);
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench'))!;
  page.setDefaultTimeout(12000);
  const view = page.frameLocator('iframe.webview:visible').last().frameLocator('#active-frame');
  const dialog = view.getByRole('dialog'), rail = page.locator('.dhimantai-app-controls:visible');
  const shots = process.env.DHIMANTAI_UX_OUT;
  if (shots) mkdirSync(shots, {recursive:true});
  const snap = async (name: string) => { if (shots) await page.screenshot({path: join(shots,name + '.png')}); };
  try {
    await catalog.open();
    await rail.locator('button').last().click();
    await dialog.getByRole('button',{name:/Sign In/}).waitFor();
    assert.equal(await dialog.getByRole('button',{name:/Sign Out/}).count(),0);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    await auth.signUpWithPassword('Asha Kumar','asha@example.test','local-fixture-password');
    await catalog.refresh();
    const search = view.locator('input[type=search]');
    await search.fill('Python');
    await rail.locator('button').last().click();
    await dialog.getByText('asha@example.test').waitFor();
    assert.ok(await dialog.getByRole('heading',{name:'Asha Kumar'}).isVisible());
    assert.equal(await dialog.evaluate(() => document.activeElement?.getAttribute('data-control')),'continue',
      await dialog.evaluate(() => JSON.stringify({focus:document.hasFocus(), active:document.activeElement?.outerHTML.slice(0,140)})));
    assert.deepEqual(await dialog.getByRole('heading',{level:3}).allTextContents(), ['Learning','Account']);
    await snap('profile');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(await search.inputValue(),'Python');
    await rail.locator('button').first().click();
    await dialog.getByText('Check failed',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Retry check'}).click();
    await dialog.getByRole('button',{name:'Retry check'}).waitFor();
    offline = false;
    await dialog.getByRole('button',{name:'Retry check'}).click();
    await dialog.locator('[data-part="extension"]').getByText('Up to date',{exact:true}).waitFor();
    assert.equal(await dialog.getByText('Up to date',{exact:true}).count(),2);
    await snap('updates');
    mismatch = true;
    await dialog.getByRole('button',{name:'Check for Updates'}).click();
    await dialog.getByText('Compatibility warning').waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Download installer'}).count(),0);
    const axe = readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
    for (const [theme, bodyClass] of [['Light Modern','vscode-light'],['Dark Modern','vscode-dark'],['Default High Contrast','vscode-high-contrast']]) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      await view.locator('body.' + bodyClass).waitFor();
      for (const kind of ['updates','profile']) {
        await rail.locator('button').nth(kind === 'updates' ? 0 : 1).click();
        await view.locator('#dc-dialog[open][data-kind=' + kind + ']').waitFor();
        const content = await (await dialog.elementHandle())!.ownerFrame();
        await content!.evaluate(axe);
        const violations = await content!.evaluate(async () => (await (window as any).axe.run('#dc-dialog',{
          runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},resultTypes:['violations']})).violations.map((v:any) => [v.id,v.nodes.map((n:any)=>[n.target,n.failureSummary])]));
        assert.deepEqual(violations,[],theme + ' ' + kind + ': ' + JSON.stringify(violations));
      }
    }
    await page.setViewportSize({width:640,height:520});
    await rail.locator('button').first().click();
    await view.locator('#dc-dialog[open][data-kind=updates]').waitFor();
    const narrow = await dialog.evaluate(el => ({width:el.clientWidth, scroll:el.scrollWidth, height:el.getBoundingClientRect().height, viewport:innerHeight}));
    assert.ok(narrow.width < 400 && narrow.scroll <= narrow.width && narrow.height <= narrow.viewport,JSON.stringify(narrow));
    await page.setViewportSize({width:1200,height:800});
    await dialog.getByText('Release Notes',{exact:true}).click();
    await dialog.getByRole('button',{name:'Learning extension notes'}).click();
    await page.locator('.tab.active').filter({hasText:/changelog/i}).waitFor();
    await rail.locator('button').last().click();
    await dialog.getByRole('heading',{name:'Asha Kumar'}).waitFor();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.locator('.tab.active').filter({hasText:/changelog/i}).waitFor();
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({profile:true,updates:true,retry:true,compatibility:true,
      accessibilityThemes:3,releaseNotes:true,standalone:true}));
  } finally {
    ExtensionUpdates.prototype.check = checkExtension; DesktopUpdates.prototype.check = checkDesktop;
    await browser.close();
  }
}
