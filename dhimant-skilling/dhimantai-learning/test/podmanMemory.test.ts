import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ensureMacRuntimeMemory, ERP_MEMORY_MIB } from '../src/podman';

function runtime(options: {active?: boolean; enough?: boolean; ram?: number; failSet?: boolean; failStartOnce?: boolean; wrongConnection?: boolean} = {}) {
  const calls: string[][] = [], reports: string[] = [];
  let memory = options.enough ? 8e9 : 2e9;
  let startFailed = false;
  const io = {
    totalmem: () => (options.ram ?? 16) * 1024 ** 3,
    run: async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'info') return String(memory);
      if (args[1] === 'list') return JSON.stringify([{Name:'selected'}, {Name:'other'}]);
      if (args[1] === 'inspect') return JSON.stringify([
        {Name:'other', State:'running', Resources:{Memory:2048}, SSHConfig:{Port:123}, ConnectionInfo:{}},
        {Name:'selected', State:'running', Resources:{Memory:2048}, SSHConfig:{Port:456}, ConnectionInfo:{}},
      ]);
      if (args.includes('ps')) return options.active ? (args.includes('sudo') ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa') : '';
      return '';
    },
    stream: async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[1] === 'set') { if (options.failSet) throw new Error('set failed'); memory = 6.3e9; }
      if (args[1] === 'start' && options.failStartOnce && !startFailed) { startFailed = true; throw new Error('Cannot start larger VM'); }
    },
  };
  const ensure = (confirm?: () => Promise<boolean>) => ensureMacRuntimeMemory('podman', ERP_MEMORY_MIB,
    message => reports.push(message), () => {}, confirm, io, `ssh://core@127.0.0.1:${options.wrongConnection ? 789 : 456}/run/podman.sock`);
  return {calls, reports, ensure};
}

test('an undersized idle macOS VM is resized in place using the selected connection', async () => {
  const r = runtime(); await r.ensure();
  assert.deepEqual(r.calls.filter(a => ['stop','set','start'].includes(a[1])), [
    ['machine','stop','selected'], ['machine','set','--memory','6144','selected'], ['machine','start','selected'],
  ]);
  assert.ok(!r.calls.some(a => a.includes('rm') || a.includes('init')));
  assert.equal(r.calls.filter(a => a[0] === 'info').length, 2);
});

test('adequate memory is reused; low physical RAM and unknown machines cannot trigger a restart', async () => {
  const enough = runtime({enough:true}); await enough.ensure(); assert.equal(enough.calls.length, 1);
  for (const options of [{ram:4}, {wrongConnection:true}]) {
    const r = runtime(options); await assert.rejects(r.ensure());
    assert.ok(!r.calls.some(a => a[1] === 'stop'));
  }
});

test('active containers require a restart choice and both rootful and rootless containers are restored', async () => {
  const declined = runtime({active:true}); await assert.rejects(declined.ensure(async () => false), /setup paused/);
  assert.ok(!declined.calls.some(a => a[1] === 'stop'));
  const accepted = runtime({active:true}); await accepted.ensure(async () => true);
  assert.ok(accepted.calls.some(a => a.join(' ') === 'machine ssh selected podman start aaaaaaaaaaaa'));
  assert.ok(accepted.calls.some(a => a.join(' ') === 'machine ssh selected sudo podman start bbbbbbbbbbbb'));
});

test('a failed resize still starts the existing machine and restores its containers', async () => {
  const r = runtime({active:true, failSet:true}); await assert.rejects(r.ensure(async () => true), /previous settings/);
  assert.ok(r.calls.some(a => a.join(' ') === 'machine start selected'));
  assert.ok(r.calls.some(a => a.includes('aaaaaaaaaaaa')));
});

test('a failed larger VM start restores the previous memory and containers', async () => {
  const r = runtime({active:true, failStartOnce:true}); await assert.rejects(r.ensure(async () => true), /previous settings/);
  assert.ok(r.calls.some(a => a.join(' ') === 'machine set --memory 2048 selected'));
  assert.equal(r.calls.filter(a => a.join(' ') === 'machine start selected').length, 2);
  assert.ok(r.calls.some(a => a.includes('aaaaaaaaaaaa')));
});
