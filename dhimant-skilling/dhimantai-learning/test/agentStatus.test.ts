import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {agentStatusLabel, RunStatus, type AgentStatus} from '../webview/agentStatus';

const idle: AgentStatus = {ready:true, listening:false, outputPaused:false, activity:'', running:false, pausedForRun:false, runFinished:false};

test('the status line names each Instructor and run state', () => {
  assert.equal(agentStatusLabel({...idle, ready:false, running:true}), '');
  assert.equal(agentStatusLabel({...idle, listening:true, running:true}), 'Listening…');
  assert.equal(agentStatusLabel({...idle, activity:'thinking'}), 'Thinking…');
  assert.equal(agentStatusLabel({...idle, activity:'speaking'}), 'Replying…');
  assert.equal(agentStatusLabel({...idle, running:true, activity:'thinking'}), 'Running your code…');
  assert.equal(agentStatusLabel({...idle, running:true, pausedForRun:true}), 'Running your code · explanation paused');
  assert.equal(agentStatusLabel({...idle, pausedForRun:true, runFinished:true}),
    'Run finished · explanation paused. Ask to continue when you are ready.');
  assert.equal(agentStatusLabel({...idle, runFinished:true}), 'Run finished · Ready');
  assert.equal(agentStatusLabel({...idle, outputPaused:true, activity:'speaking'}), '', 'a retracted reply stays hidden');
  assert.equal(agentStatusLabel(idle), '');
});

test('a run shows Running, then a short Ready, and a paused explanation waits for the next reply', async () => {
  let changes = 0;
  const run = new RunStatus(() => changes++, 20);
  run.setRunning(true); run.setRunning(true);
  assert.equal(changes, 1, 'repeated updates while running do not redraw');
  run.paused();
  run.setRunning(false);
  assert.deepEqual([run.running, run.finished, run.pausedForRun], [false, true, true]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(run.finished, false, 'Ready is a short confirmation');
  assert.equal(run.pausedForRun, true, 'the paused explanation stays visible until the learner continues');
  run.replyStarted();
  assert.equal(run.pausedForRun, false);

  run.setRunning(true); run.setRunning(false);
  run.replyStarted();
  assert.equal(run.finished, false, 'a new reply replaces Ready at once');
  run.reset();
});
