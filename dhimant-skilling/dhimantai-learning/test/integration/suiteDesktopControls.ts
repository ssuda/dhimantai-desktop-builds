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
  const rail = page.locator('.dhimantai-app-controls:visible');
  const shots = process.env.DHIMANTAI_UX_OUT;
  if (shots) mkdirSync(shots, {recursive:true});
  const snap = async (name: string) => { if (shots) await page.screenshot({path: join(shots,name + '.png')}); };
  try {
    await catalog.open();
    await page.locator('iframe.webview').first().waitFor();
    const view = await Promise.any((await page.locator('iframe.webview').all()).map(async outer => {
      const name = await outer.getAttribute('name');
      const catalogFrame = page.frameLocator(`iframe[name="${name}"]`).frameLocator('#active-frame');
      await catalogFrame.getByRole('heading', {name:'Course Catalog', exact:true}).waitFor();
      return catalogFrame;
    }));
    const dialog = view.getByRole('dialog');
    await rail.locator('button').last().click();
    await dialog.getByRole('button',{name:/Sign In/}).waitFor();
    assert.equal(await dialog.getByRole('button',{name:/Sign Out/}).count(),0);
    await dialog.press('Escape');
    await dialog.waitFor({state:'hidden'});
    await auth.signUpWithPassword('Asha Kumar','asha@example.test','local-fixture-password');
    await catalog.refresh();
    await view.getByRole('button',{name:'Explore',exact:true}).click();
    const search = view.locator('input[type=search]');
    await search.fill('Python');
    await rail.locator('button').last().click();
    await dialog.getByText('asha@example.test').waitFor();
    assert.ok(await dialog.getByRole('heading',{name:'Asha Kumar'}).isVisible());
    assert.equal(await dialog.evaluate(() => document.activeElement?.getAttribute('data-control')),'continue',
      await dialog.evaluate(() => JSON.stringify({focus:document.hasFocus(), active:document.activeElement?.outerHTML.slice(0,140)})));
    assert.deepEqual(await dialog.getByRole('heading',{level:3}).allTextContents(), ['Learning','Account']);
    await snap('profile');
    await dialog.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(await search.inputValue(),'Python');
    const update = rail.locator('button').first();
    await update.click();
    await rail.locator('button[data-status=unavailable]').waitFor();
    assert.equal(await dialog.count(),0);
    await update.click();
    await rail.locator('button[data-status=unavailable]').waitFor();
    offline = false;
    await update.click();
    await rail.locator('button[data-status=current]').waitFor();
    assert.equal(await dialog.count(),0);
    await snap('updates');
    mismatch = true;
    await update.click();
    await rail.locator('button[data-status=unavailable]').waitFor();
    assert.equal(await dialog.count(),0);
    const axe = readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
    for (const [theme, bodyClass] of [['Light Modern','vscode-light'],['Dark Modern','vscode-dark'],['Default High Contrast','vscode-high-contrast']]) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      await view.locator('body.' + bodyClass).waitFor();
      await rail.locator('button').last().click();
      await dialog.waitFor();
      const content = await (await dialog.elementHandle())!.ownerFrame();
      await content!.evaluate(axe);
      const violations = await content!.evaluate(async () => (await (window as any).axe.run('#dc-dialog',{
        runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},resultTypes:['violations']})).violations.map((v:any)=>v.id));
      assert.deepEqual(violations,[],theme + ' profile: ' + JSON.stringify(violations));
      await dialog.getByRole('button',{name:'Close',exact:true}).click();
    }
    await page.setViewportSize({width:640,height:520});
    await rail.locator('button').last().click();
    await dialog.waitFor();
    const narrow = await dialog.evaluate(el => ({width:el.clientWidth, scroll:el.scrollWidth, height:el.getBoundingClientRect().height, viewport:innerHeight}));
    assert.ok(narrow.width < 400 && narrow.scroll <= narrow.width && narrow.height <= narrow.viewport,JSON.stringify(narrow));
    await page.setViewportSize({width:1200,height:800});
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(await search.inputValue(),'Python');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({profile:true,updates:true,retry:true,compatibility:true,
      accessibilityThemes:3,sidebarOnly:true}));
  } finally {
    ExtensionUpdates.prototype.check = checkExtension; DesktopUpdates.prototype.check = checkDesktop;
    await browser.close();
  }
}
