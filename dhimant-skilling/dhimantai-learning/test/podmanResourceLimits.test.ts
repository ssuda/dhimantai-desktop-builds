import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {checkWindowsResourceLimits, resourceLimitError} from '../src/podman';

test('detects broken WSL rootless resource delegation before creating a course container', async () => {
  const calls:string[][] = [];
  await assert.rejects(checkWindowsResourceLimits('podman', {run:async (_bin,args) => {
    calls.push(args);
    return JSON.stringify({host:{security:{rootless:true}, cgroupControllers:[]}});
  }}), /Update Podman to 6\.2\.0.*Do not reset or delete/);
  assert.deepEqual(calls, [['info','--format','json']]);
});

test('accepts a healthy rootless runtime and a rootful VM', async () => {
  for (const host of [{security:{rootless:true},cgroupControllers:['cpu','memory','pids']},
    {security:{rootless:false},cgroupControllers:[]}]) {
    await checkWindowsResourceLimits('podman', {run:async()=>JSON.stringify({host})});
  }
});

test('reports cgroup failure independently of misleading Podman exit code', () => {
  for (const code of [125,127]) {
    const error = resourceLimitError(`podman exited with ${code}. crun: open memory.max: No such file or directory`, 'win32');
    assert.match(error!.message, /current WSL machine/);
    assert.match(error!.message, /Windows PowerShell outside the course cell and course terminal/);
    assert.match(error!.message, /podman --version, wsl --list --verbose, and podman info/);
    assert.match(error!.message, /If podman info fails, resolve the machine or connection error first/);
    assert.match(error!.message, /Access is denied.*restart has not succeeded/);
    assert.match(error!.message, /print\("Runtime ready"\).*actual output/);
    assert.match(error!.message, /Details: podman exited/);
  }
  assert.equal(resourceLimitError('voicelab: command not found', 'win32'), undefined);
  assert.doesNotMatch(resourceLimitError('controller `cpu` is not available','linux')!.message,/PowerShell|WSL/);
});
