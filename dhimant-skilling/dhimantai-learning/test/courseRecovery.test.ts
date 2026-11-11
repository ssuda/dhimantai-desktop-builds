import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {RepairableCourseError, repairable, withCourseRepair} from '../src/courseRecovery';

const broken = (message: string) => new RepairableCourseError(new Error(message));

test('a failed course start holds the run until repair finishes, then starts without another user run', async () => {
  let finish!: () => void, starts = 0, executed = false;
  const repair = new Promise<void>(resolve => { finish = resolve; });
  const pending = withCourseRepair(async () => {
    if (++starts === 1) throw broken('Container stopped');
    return {container: 'ready'};
  }, () => repair).then(engine => { executed = true; return engine; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1); assert.equal(executed, false);
  finish();
  assert.deepEqual(await pending, {container: 'ready'});
  assert.equal(starts, 2); assert.equal(executed, true);
});

test('failed repairs and repeated startup failures remain errors without local execution or endless retries', async () => {
  let starts = 0, repairs = 0;
  const start = async () => { starts++; throw broken('Container unavailable'); };
  await assert.rejects(withCourseRepair(start, async () => { repairs++; }), /Container unavailable/);
  assert.equal(starts, 2); assert.equal(repairs, 1);
  starts = 0;
  await assert.rejects(withCourseRepair(start, async () => { throw new Error('Repair needs OS permission'); }), /OS permission/);
  assert.equal(starts, 1);
});

test('install and language-install errors surface unchanged without removing the container', async () => {
  for (const original of [new Error('Podman installation did not finish. Select the course to retry.'), new Error('dhimantai-language rust: network unreachable')]) {
    let starts = 0, repairs = 0;
    await assert.rejects(withCourseRepair(async () => { starts++; throw original; }, async () => { repairs++; }), error => error === original);
    assert.equal(starts, 1); assert.equal(repairs, 0);
  }
});

test('a failed readiness check is repaired exactly once', async () => {
  let starts = 0, repairs = 0;
  const engine = await withCourseRepair(async () => {
    if (++starts === 1) await repairable(Promise.reject(new Error('pip check failed')));
    return 'ready';
  }, async error => { repairs++; assert.ok(error instanceof RepairableCourseError); assert.match(error.message, /pip check failed/); });
  assert.equal(engine, 'ready'); assert.equal(starts, 2); assert.equal(repairs, 1);
});
