import * as vscode from 'vscode';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CourseEngine } from './courseEngine';
import type { Execution } from './api';
import { run } from './podman';

export function courseTerminalOptions(engine: CourseEngine, label = 'Course', cwd = engine.root): vscode.TerminalOptions {
  const id = randomUUID();
  return {
    name: label, iconPath: new vscode.ThemeIcon('terminal'), cwd,
    shellPath: engine.bin,
    shellArgs: ['exec', '-it', ...engine.execUser, '--workdir', engine.path(cwd), '--env', 'DHIMANTAI_TERMINAL_ID=' + id, engine.name, '/bin/zsh', '-il'],
    env: { DHIMANTAI_COURSE_CONTAINER: engine.name, DHIMANTAI_COURSE_DIRECTORY: engine.path(cwd), DHIMANTAI_TERMINAL_ID: id },
  };
}

/** One ordinary interactive shell per course, reused by setup, the runtime picker and Run. */
export function openCourseTerminal(engine: CourseEngine, label?: string, cwd = engine.root) {
  const terminal = vscode.window.terminals.find(t => !t.exitStatus &&
    'env' in t.creationOptions && t.creationOptions.env?.DHIMANTAI_COURSE_CONTAINER === engine.name &&
    t.creationOptions.env?.DHIMANTAI_COURSE_DIRECTORY === engine.path(cwd))
    ?? vscode.window.createTerminal(courseTerminalOptions(engine, label, cwd));
  terminal.show(true);
  return terminal;
}

export async function runInCourseTerminal(engine: CourseEngine, cwd: string, command: string, args: string[],
    stdin: string, timeout: number, onCancel: (cancel?: () => void) => void): Promise<Execution> {
  const terminal = openCourseTerminal(engine);
  const id = 'env' in terminal.creationOptions ? terminal.creationOptions.env?.DHIMANTAI_TERMINAL_ID : undefined;
  if (!id) throw new Error('Reopen the course terminal from the runtime dropdown before running again.');
  let ready = false;
  const startupDeadline = Date.now() + 10000;
  while (Date.now() < startupDeadline) {
    const state = await run(engine.bin, ['exec', ...engine.execUser, engine.name, 'python', '/opt/dhimantai/terminal.py', 'state', id]);
    if (state === 'ready') { ready = true; break; }
    if (state === 'busy') throw new Error('Your course terminal is busy. Finish its command or press Ctrl+C there, then Run again.');
    if (terminal.exitStatus) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('The course terminal is not ready. Check its output, then Run again.');
  const job = randomUUID(), folder = join(engine.root, '.dhimantai', 'jobs');
  const input = join(folder, job + '.json'), result = join(folder, job + '.result.json');
  await mkdir(folder, {recursive: true});
  await writeFile(input, JSON.stringify({command, args, cwd:engine.path(cwd), stdin, timeout:timeout / 1000}), {mode:0o600});
  const stop = () => { void run(engine.bin, ['exec', ...engine.execUser, engine.name, 'python', '/opt/dhimantai/terminal.py', 'stop', job]).catch(() => {}); };
  onCancel(stop);
  let completed = false;
  try {
    terminal.sendText('python /opt/dhimantai/terminal.py capture ' + job);
    const deadline = Date.now() + timeout + 15000;
    while (Date.now() < deadline) {
      const text = await readFile(result, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (text) { completed = true; return JSON.parse(text) as Execution; }
      if (terminal.exitStatus || !vscode.window.terminals.includes(terminal))
        throw new Error('The course terminal closed. Reopen it from the runtime dropdown before running again.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The course terminal did not finish this run. Check its output before retrying.');
  } finally {
    onCancel(); if (!completed) stop();
    await Promise.all([rm(input, {force:true}), rm(result, {force:true})]);
  }
}
