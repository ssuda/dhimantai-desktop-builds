import { execFile, spawn } from 'node:child_process';

/** Container stdio carries actions only; authentication stays inside the extension. */
export function runManagedProject(root: string, runner: string, question: string, signal: AbortSignal,
    engine: {bin: string; execArgs(cwd: string, command: string, args: string[]): string[]},
    model: (messages: unknown[], signal: AbortSignal) => Promise<{action: object}>) {
  return new Promise<{output: string; passed: boolean}>((resolve) => {
    const child = spawn(engine.bin, engine.execArgs(root, 'timeout', ['--signal=KILL', '230s', 'python', '-u', '-c', runner, question]),
      {cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    let output = '', buffer = '', calls = 0, pending = false, finished = false;
    const append = (text: string) => { output = (output + text).slice(-12000); };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true}, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const finish = (passed: boolean, message = '') => {
      if (finished) return;
      finished = true; append(message); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      controller.abort(); stop(); resolve({output, passed});
    };
    const cancel = () => finish(false, '\nManaged live run cancelled.');
    const timer = setTimeout(() => finish(false, '\nManaged live run timed out.'), 240000);
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) { cancel(); return; }
    child.stdin.on('error', () => {}); // A learner process may exit while a provider reply is pending.
    child.stderr.on('data', chunk => append(chunk.toString()));
    child.stdout.on('data', async chunk => {
      if (finished) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 32000) return finish(false, '\nLive request exceeds the project limit.');
      if (!buffer.includes('\n')) return;
      if (pending || ++calls > 6) return finish(false, '\nLive run exceeded its request limit.');
      const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
      if (buffer.trim()) return finish(false, '\nLive run sent concurrent requests.');
      pending = true;
      try {
        const request = JSON.parse(line);
        if (!Array.isArray(request.messages)) throw new Error('Invalid live request.');
        const result = await model(request.messages, requestSignal);
        if (!finished) child.stdin.write(JSON.stringify({action: result.action}) + '\n');
      } catch (error) {
        if (!finished) finish(false, '\n' + (error instanceof Error ? error.message : 'Managed live model unavailable.'));
      } finally { pending = false; }
    });
    child.on('error', () => finish(false, '\nCould not start the course container.'));
    child.on('close', code => finish(code === 0));
  });
}
