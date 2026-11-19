import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';

// Exercise the whole first-launch path with a fake CLI: no real VM is created or resized.
function freshMac(hostGiB: number) {
  let running = false, memoryMiB = 0;
  const calls: string[][] = [];
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === '--version') return 'podman version 5.8.1';
    if (args[0] === 'system') return '[]';
    if (args[0] === 'info') {
      if (!running) throw new Error('No machine is running');
      return args.at(-1)!.includes('MemTotal') ? String(memoryMiB * 1024 ** 2 - 100_000_000) : 'arm64';
    }
    if (args[0] === 'machine') {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'init') { memoryMiB = Number(args[args.indexOf('--memory') + 1]); return ''; }
      if (args[1] === 'start') { running = true; return ''; }
    }
    throw new Error('Unexpected command: ' + args.join(' '));
  };
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async (_bin: string, args: string[]) => ({stdout: await command(args), stderr: ''})
  });
  const spawn = (_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), stderr: new EventEmitter()});
    Promise.resolve().then(() => command(args)).then(stdout => {
      child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0);
    }, error => {
      child.stderr.emit('data', Buffer.from(error.message)); child.emit('close', 1);
    });
    return child;
  };
  const exports: {ensurePodman?: typeof import('../src/podman').ensurePodman} = {};
  runInNewContext(readFileSync(join(__dirname, '../src/podman.js'), 'utf8'), {
    exports,
    require: (name: string) => name === 'node:child_process' ? {execFile, spawn}
      : name === 'node:os' ? {...require(name), totalmem: () => hostGiB * 1024 ** 3} : require(name),
    process: {platform: 'darwin', arch: 'arm64', env: {}},
    Buffer, URL, setTimeout, clearTimeout, AbortSignal, fetch
  });
  return {
    calls,
    open: (memoryMiB: number) => exports.ensurePodman!(() => {}, () => {}, async () => {}, memoryMiB)
  };
}

test('fresh ERP setup checks host RAM before creating a 6 GB machine', async () => {
  const mac = freshMac(4);
  await assert.rejects(mac.open(6144), /at least 8 GB of RAM/);
  assert.ok(!mac.calls.some(args => args[0] === 'machine' && ['init', 'start'].includes(args[1])),
    'a low-memory Mac must fail before allocating or starting a VM');
});

test('fresh ERP setup allocates 6 GB on an 8 GB Mac', async () => {
  const mac = freshMac(8);
  await mac.open(6144);
  const init = mac.calls.find(args => args[0] === 'machine' && args[1] === 'init');
  assert.equal(init?.[init.indexOf('--memory') + 1], '6144');
  assert.equal(mac.calls.filter(args => args[0] === 'machine' && args[1] === 'start').length, 1);
});

test('ordinary coding setup keeps its 2 GB allocation on a 4 GB Mac', async () => {
  const mac = freshMac(4);
  await mac.open(2048);
  const init = mac.calls.find(args => args[0] === 'machine' && args[1] === 'init');
  assert.equal(init?.[init.indexOf('--memory') + 1], '2048');
});
