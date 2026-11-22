import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CourseEngine } from '../src/courseEngine';

test('an explicit app run waits for HTTP readiness and opens the mapped port to the right', async () => {
  const commands: unknown[][] = [];
  const warnings: string[] = [];
  let ready = false;
  const server = createServer((_req, res) => { res.writeHead(ready ? 200 : 503); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const mapping = '127.0.0.1:' + address.port;
  const root = await mkdtemp(join(tmpdir(), 'course-preview-'));
  const marker = join(root, '.dhimantai', 'preview-8000');
  const Module = require('node:module');
  const load = Module._load;
  let watcher: {dispose():void} | undefined;
  try {
    Module._load = function(id: string, ...args: unknown[]) {
      if (id === 'vscode') return {commands:{
        getCommands: async () => ['workbench.action.browser.open'],
        executeCommand: async (...args: unknown[]) => commands.push(args),
      }};
      if (id === './podman') return {run: async () => mapping};
      return load.call(this, id, ...args);
    };
    const {watchAppRuns} = require('../src/courseAppPreview') as typeof import('../src/courseAppPreview');
    Module._load = load;
    await mkdir(join(root, '.dhimantai'));
    await writeFile(marker, 'previous run');
    await delay(30);
    watcher = watchAppRuns({root} as CourseEngine, 8000, async () => {}, message => warnings.push(message));
    await delay(450);
    assert.equal(commands.length, 0);
    await writeFile(marker, 'start');
    await delay(700);
    assert.equal(commands.length, 0);
    ready = true;
    for (let i = 0; !commands.length && i < 30; i++) await delay(100);
    const url = 'http://' + mapping + '/';
    assert.deepEqual(commands, [['workbench.action.browser.open', {url, openToSide:true, reuseUrlFilter:url}]]);
    watcher.dispose();
    await writeFile(marker, 'new run');
    await delay(550);
    assert.equal(commands.length, 1);
    assert.deepEqual(warnings, []);
  } finally {
    Module._load = load;
    watcher?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, {recursive:true, force:true});
  }
});
