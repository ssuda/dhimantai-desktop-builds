import type { CourseEngine } from './courseEngine';
import { run } from './podman';
import * as vscode from 'vscode';
import type { Execution } from './api';
import { programEnvironment, Toolchains } from './localRunner';
import { ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { openCourseTerminal, runInCourseTerminal } from './courseTerminal';

/**
 * Runs the learner's program with the real tools, where they can see them:
 * compiled languages build through a VS Code Task (errors land in the Problems panel via problem
 * matchers), then the program runs in the integrated terminal with the exact command a developer
 * would type. Terminal shell integration lets the coach read the output and exit code.
 * Returns undefined when this is not possible here (no folder workspace, no shell integration),
 * so the caller can fall back to the hidden runner.
 */

const windows = process.platform === 'win32';

interface Step { command: string; args: string[] }
export interface NativePlan { build?: Step & { matcher: string[] }; run: Step }

export function nativePlan(language: string, argv: string[], tools: Toolchains = {}, useWindows = windows): NativePlan | undefined {
  const exe = useWindows ? '.\\main.exe' : './main';
  const out = useWindows ? 'main.exe' : 'main';
  switch (language) {
    case 'python': return { run: { command: tools.python ?? (useWindows ? 'python' : 'python3'), args: ['main.py', ...argv] } };
    case 'javascript': return { run: { command: tools.node ?? 'node', args: ['main.js', ...argv] } };
    case 'typescript': return {
      build: { command: tools.tsc ?? 'tsc', args: ['main.ts', '--strict', '--target', 'ES2022', '--module', 'commonjs', '--sourceMap'], matcher: ['$tsc'] },
      run: { command: tools.node ?? 'node', args: ['main.js', ...argv] },
    };
    case 'c': return { build: { command: tools.cc ?? 'gcc', args: ['-std=c17', '-Wall', '-Wextra', '-g', 'main.c', '-o', out, '-lm'], matcher: ['$gcc'] }, run: { command: exe, args: argv } };
    case 'rust': return { build: { command: tools.rustc ?? 'rustc', args: ['--edition=2021', '-g', 'main.rs', '-o', out], matcher: ['$rustc'] }, run: { command: exe, args: argv } };
    case 'go': return { build: { command: tools.go ?? 'go', args: ['build', '-gcflags=all=-N -l', '-o', out, 'main.go'], matcher: ['$go'] }, run: { command: exe, args: argv } };
    case 'java': return { build: { command: tools.javac ?? 'javac', args: ['-g', 'Main.java'], matcher: ['$javac'] }, run: { command: tools.java ?? 'java', args: ['-cp', '.', 'Main', ...argv] } };
    default: return undefined;
  }
}

/** Plain text from terminal output: drop ANSI colour codes and shell-integration OSC sequences. */
export function plainTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

const quote = (part: string) => (/^[\w./:=@%+\\-]+$/.test(part) ? part : `"${part.replace(/(["\\$`])/g, '\\$1')}"`);
export const commandLine = (step: Step) => [step.command, ...step.args].map(quote).join(' ');

/**
 * A real terminal tab in VS Code's panel that we drive ourselves (a pseudoterminal): the program runs
 * natively from the learner's file, its output streams into the terminal as they would see it, keystrokes
 * go to the program's input, and Ctrl+C stops it. We capture exactly what it printed, stdout and stderr
 * separately, without parsing a shell's prompt.
 */
export class RunTerminal implements vscode.Pseudoterminal {
  private readonly write = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.write.event;
  private readonly closed = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closed.event;
  child?: ChildProcess;
  typedInput = false;
  cancelRuntime?: () => void;
  private opened = false;
  private pending: string[] = [];
  open() {
    this.opened = true;
    this.print('\x1b[2mProgram output. Type to send input; Ctrl+C stops the program.\x1b[0m\r\n');
    for (const text of this.pending) this.write.fire(text);
    this.pending = [];
  }
  /** VS Code closed the terminal tab: stop any running program. */
  close() { this.stopChild(); }
  print(text: string) {
    const value = text.replace(/\r?\n/g, '\r\n');
    // VS Code attaches the terminal renderer asynchronously; fast runs can finish before open().
    if (this.opened) this.write.fire(value);
    else this.pending.push(value);
  }
  handleInput(data: string) {
    if (!this.child) return;
    if (data === '\x03') { this.print('^C\r\n'); return this.stopChild(); }
    this.typedInput = true;
    const text = data.replace(/\r/g, '\n');
    this.print(text);
    this.child.stdin?.write(text);
  }
  stopChild() {
    this.cancelRuntime?.(); this.cancelRuntime = undefined;
    const pid = this.child?.pid;
    if (!pid) return;
    try { process.kill(windows ? pid : -pid, 'SIGKILL'); } catch { this.child?.kill('SIGKILL'); }
  }
}

export class NativeRunner implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private pty?: RunTerminal;
  private readonly disposables: vscode.Disposable[] = [];
  private cancelCourseRun?: () => void;

  constructor() {
    this.disposables.push(vscode.window.onDidCloseTerminal(t => { if (t === this.terminal) { this.terminal = undefined; this.pty = undefined; } }));
  }

  dispose() {
    this.cancelCourseRun?.();
    this.pty?.stopChild();
    this.disposables.forEach(d => d.dispose());
  }

  /** Build only (compiled languages), through the same task; true when there is nothing to build or it built. */
  async buildOnly(language: string, dir: vscode.Uri, tools: Toolchains): Promise<{ ok: boolean; diagnostics?: string }> {
    const plan = nativePlan(language, [], tools);
    const folder = vscode.workspace.getWorkspaceFolder(dir);
    if (!plan?.build) return { ok: true };
    if (!folder) return { ok: false, diagnostics: 'Open the exercise as a folder to build it.' };
    const built = await this.build(folder, dir, plan.build);
    return { ok: built?.code === 0, diagnostics: built?.diagnostics };
  }

  /** Interrupt the running program, as Ctrl+C would. */
  stop() {
    this.cancelCourseRun?.();
    this.pty?.stopChild();
  }

  private show(): RunTerminal {
    if (!this.terminal || !this.pty) {
      this.pty = new RunTerminal();
      this.terminal = vscode.window.createTerminal({ name: 'dhimantAI run', pty: this.pty, iconPath: new vscode.ThemeIcon('play') });
    }
    this.terminal.show(true);
    return this.pty;
  }

  /** Build (if needed) through a task, then run in the terminal. Undefined = cannot here (use the hidden runner). */
  async run(language: string, dir: vscode.Uri, argv: string[], tools: Toolchains, stdin = '', timeoutMs = 45_000, engine?: CourseEngine): Promise<Execution | undefined> {
    const plan = nativePlan(language, argv, engine ? {} : tools, engine ? false : windows);
    if (!plan) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(dir);
    const started = Date.now();
    if (engine) openCourseTerminal(engine);
    if (plan.build) {
      if (!folder && !engine) return undefined;
      let built;
      if (engine) {
        const args = [...plan.build.args, ...(language === 'typescript' ? ['--typeRoots','/usr/local/lib/node_modules/@types'] : [])];
        try { await run(engine.bin,engine.execArgs(dir.fsPath,plan.build.command,args),120000); built={code:0,diagnostics:''}; }
        catch(e) { built={code:1,diagnostics:e instanceof Error?e.message:String(e)}; }
      } else built = await this.build(folder!, dir, plan.build);
      if (built === undefined) return undefined;
      if (built.code !== 0) {
        return { status: 'compile_error', exit_code: null, stdout: '', stderr: built.diagnostics || `${plan.build.command} failed (exit ${built.code}). See the Problems panel.`,
          command: commandLine(plan.build), duration_seconds: (Date.now() - started) / 1000, truncated: false };
      }
    }
    if (engine) return runInCourseTerminal(engine, dir.fsPath, plan.run.command, plan.run.args, stdin, timeoutMs,
      cancel => { this.cancelCourseRun = cancel; });
    const pty = this.show();
    pty.stopChild();
    pty.print(`\r\n\x1b[1m$ ${commandLine(plan.run)}\x1b[0m\r\n`);
    let stdout = '', stderr = '', truncated = false, timedOut = false;
    const limit = (current: string, chunk: Buffer) => {
      const remaining = 200_000 - current.length;
      const text = chunk.toString('utf8');
      truncated ||= text.length > remaining;
      return current + text.slice(0, remaining);
    };
    const args = plan.run.args;
    const command = plan.run.command.startsWith('.') ? join(dir.fsPath, plan.run.command.replace(/^\.[\\/]/, '')) : plan.run.command;
    return new Promise<Execution | undefined>(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, { cwd: dir.fsPath, env: programEnvironment(), shell: false, detached: !windows, windowsHide: true });
      } catch {
        return resolve(undefined);
      }
      pty.child = child;
      pty.typedInput = false;
      // Saved input goes in at once; otherwise input stays open so the learner can type into the terminal.
      if (stdin) { pty.print(`\x1b[2m(input from the exercise)\x1b[0m\r\n${stdin}`); child.stdin?.end(stdin); }
      child.stdout?.on('data', (chunk: Buffer) => { stdout = limit(stdout, chunk); pty.print(chunk.toString('utf8')); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = limit(stderr, chunk); pty.print(`\x1b[31m${chunk.toString('utf8')}\x1b[0m`); });
      const timer = setTimeout(() => { timedOut = true; pty.print('\r\n\x1b[33mStopped: the program ran longer than 45 seconds.\x1b[0m\r\n'); pty.stopChild(); }, timeoutMs);
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (pty.child === child) { pty.child = undefined; pty.cancelRuntime = undefined; }
        if (error.code === 'ENOENT') pty.print(`\x1b[31m${plan.run.command} was not found on this computer.\x1b[0m\r\n`);
        resolve(error.code === 'ENOENT' ? { status: 'toolchain_missing', exit_code: null, stdout: '', stderr: `${plan.run.command} was not found.`, command: commandLine(plan.run), duration_seconds: 0, truncated: false } : undefined);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (pty.child === child) { pty.child = undefined; pty.cancelRuntime = undefined; }
        const exit = code ?? (signal && !timedOut ? -(constants.signals[signal] ?? 0) || null : null);
        pty.print(`\x1b[2m[${timedOut ? 'stopped' : `exited with code ${exit}`}]\x1b[0m\r\n`);
        resolve({ status: timedOut ? 'timeout' : 'exited', exit_code: timedOut ? null : exit, stdout, stderr, command: commandLine(plan.run),
          duration_seconds: (Date.now() - started) / 1000, truncated, interactive_input: pty.typedInput });
      });
    });
  }

  /** Compile through a VS Code Task so problem matchers put errors in the Problems panel. */
  private async build(folder: vscode.WorkspaceFolder, dir: vscode.Uri, step: Step & { matcher: string[] }): Promise<{ code: number; diagnostics: string } | undefined> {
    const task = new vscode.Task({ type: 'dhimantai', task: 'build' }, folder, 'Build', 'dhimantAI',
      new vscode.ProcessExecution(step.command, step.args, { cwd: dir.fsPath }), step.matcher);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true, showReuseMessage: false };
    let execution: vscode.TaskExecution;
    try {
      execution = await vscode.tasks.executeTask(task);
    } catch {
      return undefined;
    }
    const code = await new Promise<number>(resolve => {
      const sub = vscode.tasks.onDidEndTaskProcess(e => { if (e.execution === execution) { sub.dispose(); resolve(e.exitCode ?? 1); } });
    });
    // Problem matchers publish asynchronously; give them a moment, then summarise for the coach.
    await new Promise(r => setTimeout(r, 300));
    const problems = vscode.languages.getDiagnostics().flatMap(([uri, list]) => uri.fsPath.startsWith(dir.fsPath) ? list.map(d => ({ uri, d })) : [])
      .filter(({ d }) => d.severity === vscode.DiagnosticSeverity.Error);
    const diagnostics = problems.map(({ uri, d }) => `${uri.path.split('/').pop()}:${d.range.start.line + 1}:${d.range.start.character + 1}: error: ${d.message}`).join('\n');
    return { code, diagnostics };
  }
}

