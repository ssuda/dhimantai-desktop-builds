import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CourseEngine } from '../src/courseEngine';
import { desktopAsset, officialInstallerUrl, machineSetup, requireLocalConnection } from '../src/podman';
import { courseExamples, readyMessage, verifyCourseLanguage } from '../src/courseReadiness';

test('readiness checks execute the course language and reject broken execution', async () => {
  const execution = {status: 'exited', exit_code: 0, stdout: readyMessage + '\n', stderr: '', command: '', duration_seconds: 0, truncated: false};
  for (const language of ['python', 'javascript', 'typescript', 'c', 'java', 'go', 'rust']) {
    await verifyCourseLanguage({run: async (selected, input) => {
      assert.equal(selected, language);
      assert.equal(input.source, courseExamples[language]);
      return execution;
    }}, language);
  }
  for (const result of [{...execution, status: 'toolchain_missing'}, {...execution, exit_code: 1}, {...execution, stdout: ''}])
    await assert.rejects(verifyCourseLanguage({run: async () => result}, 'java'), /course check failed/);
});

test('the first desktop course initializes a machine, while existing machines are reused', () => {
  assert.deepEqual(machineSetup([]), [
    ['machine', 'init', '--cpus', '2', '--memory', '2048', '--disk-size', '30', 'podman-machine-default'],
    ['machine', 'start', 'podman-machine-default']
  ]);
  assert.deepEqual(machineSetup([{ Name: 'teaching', Running: false, Default: true }]), [
    ['machine', 'start', 'teaching']
  ]);
  assert.deepEqual(machineSetup([{ Name: 'running', Running: true }]), []);
  assert.deepEqual(machineSetup([{ Name: 'starting', Running: false, Starting: true }]), []);
});
test('course setup accepts local Podman sockets and rejects remote build engines', () => {
  for (const address of [
    'ssh://core@127.0.0.1:51002/run/podman/podman.sock',
    'unix:///run/user/501/podman.sock',
    'npipe:////./pipe/podman-machine-default'
  ])
    assert.doesNotThrow(() => requireLocalConnection(address));
  assert.throws(() => requireLocalConnection('ssh://user@remote.example/run/podman.sock'), /local Podman/);
});
test('installer names follow the desktop CPU and unsupported combinations fail before download', () => {
  assert.equal(desktopAsset('darwin', 'arm64'), 'podman-installer-macos-arm64.pkg');
  assert.equal(desktopAsset('win32', 'x64'), 'podman-installer-windows-amd64.msi');
  assert.throws(() => desktopAsset('win32', 'ia32'));
});
test('installer verification accepts only the official Podman release paths and matching filename', () => {
  const name = desktopAsset('win32', 'x64');
  const url = (repo: string) => `https://github.com/${repo}/releases/download/v6.1.4/${name}`;
  assert.ok(officialInstallerUrl(url('podman-container-tools/podman'), name));
  assert.ok(officialInstallerUrl(url('containers/podman'), name));
  assert.ok(!officialInstallerUrl(url('someone/podman'), name));
  assert.ok(!officialInstallerUrl(url('containers/podman'), 'other.msi'));
});
test('course exec maps only files under its bind mount and preserves argv literally', () => {
  const root = resolve('test course');
  const engine = new CourseEngine('podman', 'managed', root);
  assert.deepEqual(engine.execArgs(resolve(root, 'my files'), 'python', ['my program.py', 'a;b']), [
    'exec',
    '-i',
    '--workdir',
    '/course/my files',
    'managed',
    'python',
    'my program.py',
    'a;b'
  ]);
  assert.throws(() => engine.path(root + '-another'));
});

test('closing VS Code stops course containers and leaves a machine dhimantAI did not start running', async () => {
  const {mkdtempSync, writeFileSync, readFileSync, chmodSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fake-podman-')), log = join(dir, 'calls');
  const bin = join(dir, 'podman');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);chmodSync(bin, 0o755);
  const {stopCourseRuntime} = await import('../src/podman');
  await stopCourseRuntime(bin, ['dhimantai-course-python', 'dhimantai-course-rust']);
  assert.equal(readFileSync(log, 'utf8'), 'stop --time 2 dhimantai-course-python dhimantai-course-rust\n');
});
