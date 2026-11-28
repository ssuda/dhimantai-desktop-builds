import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';
import { learningFrame } from './learningFrame';

interface Menu {items: {id: string; label?: string}[]}
type Menus = Record<string, Menu>;

// The focused workbench sends this exact menu to Electron to build its native menu bar.
async function expectMenu(label: string, matches: (ids: string[], menus: Menus) => boolean) {
  const file = join(process.env.DHIMANTAI_TEST_PROFILE!, 'User', 'globalStorage', 'storage.json');
  let ids: string[] = [], names: string[] = [];
  for (let i = 0; i < 120; i++) {
    let menus: Menus | undefined;
    try { menus = JSON.parse(readFileSync(file, 'utf8')).lastKnownMenubarData?.menus; } catch { /* first save pending */ }
    if (menus?.Skilling) {
      names = Object.keys(menus);
      ids = menus.Skilling.items.map(item => item.id).filter(id => !id.endsWith('.separator'));
      if (matches(ids, menus)) return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(label + ' — ' + JSON.stringify({names,ids}));
}

export async function run() {
  assert.equal(vscode.env.appName, 'dhimantAI');
  const {auth} = await vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!.activate();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.DHIMANTAI_CDP_PORT);
  const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'))!;
  const command = vscode.commands.executeCommand;
  const check = 'dhimantai.skilling.check', grade = 'dhimantai.skilling.grade', ask = 'dhimantai.skilling.ask';
  try {
    const session = await page.context().newCDPSession(page);
    // Electron only accepts the focused window's menu. Keep this disposable test window focused during automation.
    await session.send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await page.bringToFront();
    await command('workbench.action.closeAllEditors');
    const home = page.getByRole('button', {name:'Browse Courses',exact:true}).first();
    await home.click({timeout:10000});
    await learningFrame(page, 'main[data-loading]');
    await expectMenu('guest catalog', (ids, menus) => ids.join() === 'dhimantai.courseCatalog'
      && !!menus.Edit && !menus.File && !menus.View && !menus.Help && !menus.Run && !menus.Terminal && !menus.Go && !menus.Selection);
    await auth.signInWithPassword(EMAIL, PASSWORD);
    const account = (await auth.session())!.user.id;
    await command('dhimantai.openPracticeNotebook', QUESTION_ID, account, 'Python');
    await expectMenu('published exercise', ids => [ask,check,grade,'dhimantai.skilling.course'].every(id => ids.includes(id)));
    const exercise = await learningFrame(page,'body.practice-notebook #message');
    await exercise.locator('#message:enabled').waitFor();
    const dispatched = await command(ask);
    assert.equal(dispatched,true, 'Ask Instructor delivered to ' + vscode.window.tabGroups.activeTabGroup.activeTab?.label);
    await exercise.locator('#message:focus').waitFor({timeout:5000});
    const generated = {assessment:'practice_only',title:'Explain a change',question:'What would you change?',language:'python',course:'Python'};
    await command('dhimantai.openPracticeNotebook', 'generated', account, 'Python', generated);
    const ungraded = await learningFrame(page,'body.practice-notebook h1:text-is("Explain a change")');
    await ungraded.getByRole('heading',{name:'Explain a change',exact:true}).first().waitFor({timeout:8000});
    await ungraded.getByText('Practice is ready. Ask questions and get feedback here.',{exact:true}).waitFor();
    await page.bringToFront();
    await expectMenu('ungraded exercise', ids => ids.includes(ask) && !ids.includes(check) && !ids.includes(grade));
    await command('workbench.action.closeActiveEditor');
    await expectMenu('reactivated published exercise', ids => ids.includes(check) && ids.includes(grade));
    await command('dhimantai.openLearningRoom', 'Python', QUESTION_ID);
    await expectMenu('lesson', (ids,menus) => ids.includes('dhimantai.skilling.course') && !ids.includes(grade) && !menus.File);
    await command('dhimantai.openPracticeNotebook', QUESTION_ID, account, 'Python', undefined, undefined, undefined, 'written');
    const written = await learningFrame(page, 'label[for=message]:has-text("Question for Instructor")');
    await expectMenu('written exercise', ids => ids.includes('dhimantai.skilling.feedback') && ids.includes(ask) && !ids.includes(grade));
    assert.equal(await command(ask), true);
    await written.waitForFunction(() => document.activeElement?.id === 'message', undefined, {timeout:5000});
    await command('dhimantai.skilling.feedback');
    await written.getByText('Write your answer before submitting.', {exact:true}).waitFor();
    const file = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:'ordinary file'}));
    await expectMenu('unrelated file', (ids,menus) => ids.join() === 'dhimantai.courseCatalog' && !!menus.File && !!menus.View && !menus.Terminal && !menus.Run);
    await command(grade);
    assert.equal(vscode.window.activeTextEditor, file);

    const root = vscode.workspace.workspaceFolders![0].uri;
    await command('dhimantai.openProjectCoach',root.fsPath);
    const editor = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'README.md'));
    const project = 'dhimantai.skilling.project', discuss = 'dhimantai.skilling.discuss';
    await expectMenu('project file', ids => ids.includes(project) && !ids.includes(grade) && !ids.includes(discuss));
    editor.selection = new vscode.Selection(0,0,0,5);
    await expectMenu('selected project lines', ids => ids.includes(discuss));
    await command(discuss);
    await command('dhimantai.courseCatalog');
    await expectMenu('catalog after project', ids => !ids.includes(project) && !ids.includes(discuss));

    await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor','notebook',vscode.ConfigurationTarget.Global);
    await command('dhimantai.openPracticeNotebook', QUESTION_ID, account, 'Python');
    await expectMenu('native exercise notebook', (ids,menus) => ids.includes(check) && ids.includes(grade) && !!menus.File && !menus.Terminal);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({passed:true, surfaces:['empty','catalog','lesson','written practice','practice','ungraded practice','file','project selection','Jupyter']}));
  } finally { await browser.close(); }
}
