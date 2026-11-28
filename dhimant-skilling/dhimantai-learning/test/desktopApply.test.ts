import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {desktopApplyPlan, startDetached} from '../src/desktopApply';

const base = {pid: 4242, applicationName: 'dhimantai'};
test('a detached installer can start a graphical desktop from the Electron extension host', async () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  const directory = await mkdtemp(join(tmpdir(), 'dhimantai-relaunch-'));
  const result = join(directory, 'mode');
  try {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    await startDetached({command:process.execPath, args:['-e',
      "require('node:fs').writeFileSync(process.argv[1], process.env.ELECTRON_RUN_AS_NODE || 'gui')", result]});
    let mode;
    for (let i = 0; i < 100 && !mode; i++) {
      mode = await readFile(result, 'utf8').catch(() => undefined);
      if (!mode) await wait(25);
    }
    assert.equal(mode, 'gui');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
    await rm(directory, {recursive:true, force:true});
  }
});
test('macOS replaces the installed bundle from the verified DMG after the app quits, then reopens it', () => {
  const plan = desktopApplyPlan({...base, platform: 'darwin', appRoot: '/Applications/dhimantAI.app/Contents/Resources/app',
    installer: "/Users/a b/Library/x/dhimantAI-1.1.0'.dmg"})!;
  assert.equal(plan.command, '/bin/sh');
  assert.deepEqual(plan.args.slice(2), ['dhimantai-update', '4242', "/Users/a b/Library/x/dhimantAI-1.1.0'.dmg", '/Applications/dhimantAI.app']);
  assert.ok(!plan.args[1].includes('/Applications'), 'paths are positional arguments, never interpolated into the script');
  assert.match(plan.args[1], /CFBundleIdentifier/); assert.match(plan.args[1], /open "\$app"/);
});
test('read-only or translocated macOS copies fall back to the installer', () => {
  for (const appRoot of ['/Volumes/dhimantAI/dhimantAI.app/Contents/Resources/app', '/private/var/folders/x/AppTranslocation/y/d/dhimantAI.app/Contents/Resources/app'])
    assert.equal(desktopApplyPlan({...base, platform: 'darwin', appRoot, installer: '/tmp/a.dmg'}), undefined);
});
test('Windows runs the user setup silently after the app exits and lets it relaunch the app', () => {
  const plan = desktopApplyPlan({...base, platform: 'win32', appRoot: 'C:\\Users\\a\\AppData\\Local\\Programs\\dhimantAI\\resources\\app',
    installer: "C:\\Users\\o'neil\\setup.exe"})!;
  const script = plan.args.at(-1)!;
  assert.match(script, /Wait-Process -Id \$p/); assert.match(script, /'C:\\Users\\o''neil\\setup\.exe'/);
  assert.match(script, /\/VERYSILENT/); assert.match(script, /MERGETASKS=runcode/);
});
test('invalid process ids and unknown platforms are never applied in place', () => {
  assert.equal(desktopApplyPlan({...base, pid: NaN, platform: 'win32', appRoot: 'C:\\a', installer: 'C:\\s.exe'}), undefined);
  assert.equal(desktopApplyPlan({...base, platform: 'freebsd', appRoot: '/a', installer: '/s.exe'}), undefined);
});
