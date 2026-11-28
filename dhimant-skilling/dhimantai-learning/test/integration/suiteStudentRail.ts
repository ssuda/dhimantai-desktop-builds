/** Run the packaged desktop with real on-disk profiles. Pass the old executable second to verify the upgrade baseline. */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright-core';

const oldViews = ['explorer','search','scm','debug','extensions','extension.dhimantai-learning'];
const tabNames = (page: Page) => page.locator('.part.activitybar [role=tab]:visible .action-label')
  .evaluateAll(items => items.map(item => item.getAttribute('aria-label')!.split(' (')[0]));

function seedPins(profile: string) {
  const directory = join(profile, 'User', 'globalStorage');
  mkdirSync(directory, {recursive:true});
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(directory, 'state.vscdb'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const pins = oldViews.map((view, order) => ({
      id:'workbench.view.' + view, order, visible:true, pinned:view !== 'extension.dhimantai-learning',
    }));
    db.prepare('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)').run('workbench.activity.pinnedViewlets2', JSON.stringify(pins));
  } finally { db.close(); }
}

async function inspectApp(executable: string, profile: string, check: (page: Page) => Promise<void>) {
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, {force:true});
  const child = spawn(executable, ['--user-data-dir',profile,'--extensions-dir',join(profile,'extensions'),
    '--remote-debugging-port=0','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),'--new-window'], {stdio:'ignore'});
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(portFile) && child.exitCode === null && Date.now() < deadline) await delay(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? await context.waitForEvent('page');
      await page.waitForURL(/workbench/);
      await page.locator('.part.activitybar .action-label[aria-label="Learning"]').waitFor();
      await check(page);
    } finally {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => undefined);
      await browser.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const timeout = setTimeout(() => child.kill(), 3000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
  }
}

async function main() {
  const [executable, previous] = process.argv.slice(2);
  assert.ok(executable && existsSync(executable), 'Pass the path to the student desktop executable');
  const directory = mkdtempSync(join(tmpdir(), 'dhimantai-student-rail-'));
  try {
    for (const profileType of ['existing','new']) {
      const profile = join(directory, profileType);
      mkdirSync(join(profile,'User'), {recursive:true});
      writeFileSync(join(profile,'User/settings.json'), JSON.stringify({'dhimantai.autoUpdate':false}));
      if (profileType === 'existing') {
        seedPins(profile);
        if (previous) {
          await inspectApp(previous, profile, async page => {
            const names = await tabNames(page);
            for (const name of ['Explorer','Search','Source Control','Run and Debug','Extensions']) assert.ok(names.includes(name), JSON.stringify(names));
            console.log('Previous desktop', names);
          });
          seedPins(profile);
        }
      }
      await inspectApp(executable, profile, async page => {
        const rail = page.locator('.part.activitybar');
        const assertRail = async () => {
          assert.deepEqual(await tabNames(page), ['Learning']);
          const buttons = rail.locator('button:visible');
          assert.equal(await buttons.count(), 2);
          assert.equal(await buttons.first().getAttribute('aria-haspopup'), null);
          assert.equal(await buttons.last().getAttribute('aria-haspopup'), 'dialog');
        };
        await assertRail();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+f' : 'Control+Shift+f');
        await page.locator('.part.sidebar .search-view:visible').waitFor();
        await assertRail();
        const output = process.env.DHIMANTAI_UX_OUT;
        if (output) {
          mkdirSync(output, {recursive:true});
          await page.screenshot({path:join(output, profileType + '-profile-search.png')});
        }
        await rail.locator('.action-label[aria-label="Learning"]').click();
        await rail.locator('[aria-selected="true"] .action-label[aria-label="Learning"]').waitFor();
        await assertRail();
        console.log(profileType + ' profile: only Learning, Updates and Profile at launch, in Search and on return');
      });
    }
  } finally { rmSync(directory, {recursive:true, force:true}); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
