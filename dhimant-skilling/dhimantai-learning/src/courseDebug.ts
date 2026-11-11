import type * as vscode from 'vscode';
import { CourseEngine } from './courseEngine';
import { nativePlan } from './nativeRun';
import { run } from './podman';

export async function courseDebugPort(engine: CourseEngine) {
  const binding = await run(engine.bin, ['port', engine.name, '5678/tcp']);
  const port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(binding)?.[1]);
  if (!port) throw new Error('Reopen the course to restore its debugger connection.');
  return port;
}

export async function courseDebug(engine: CourseEngine, folder: string, language: string, argv: string[], knownPort?: number) {
  const remote = engine.path(folder);
  const plan = nativePlan(language, argv, {}, false);
  if (!plan) throw new Error('Unsupported course debugger.');
  const task = (label: string, command: string, args: string[], problemMatcher: string[] = []) => ({
    label,
    type: 'process',
    command: engine.bin,
    args: engine.execArgs(folder, command, args),
    problemMatcher
  });
  const build =
    plan.build &&
    task(
      'dhimantAI: Build',
      plan.build.command,
      [
        ...plan.build.args,
        ...(language === 'typescript' ? ['--typeRoots', '/usr/local/lib/node_modules/@types'] : [])
      ],
      plan.build.matcher
    );

  if (language === 'c' || language === 'rust') {
    const launch: vscode.DebugConfiguration = {
      type: 'cppdbg',
      request: 'launch',
      name: 'Debug in course',
      program: remote + '/main',
      cwd: remote,
      args: argv,
      MIMode: 'gdb',
      preLaunchTask: build!.label,
      pipeTransport: {
        pipeProgram: engine.bin,
        pipeArgs: ['exec', '-i', ...engine.execUser, '--workdir', remote, engine.name],
        debuggerPath: '/usr/bin/gdb'
      },
      sourceFileMap: { [remote]: folder }
    };
    return { launch, tasks: [build!], server: undefined as string[] | undefined };
  }

  const port = knownPort ?? await courseDebugPort(engine);
  const base = { name: 'Debug in course', request: 'attach', port };
  let launch: vscode.DebugConfiguration;
  let server: string[];
  switch (language) {
    case 'python':
      launch = {
        name: base.name, request: 'attach',
        type: 'debugpy',
        connect: { host: '127.0.0.1', port },
        pathMappings: [{ localRoot: folder, remoteRoot: remote }],
        justMyCode: true,
        redirectOutput: true
      };
      server = ['python', '-m', 'debugpy', '--listen', '0.0.0.0:5678', '--wait-for-client', 'main.py', ...argv];
      break;
    case 'javascript':
    case 'typescript':
      launch = {
        ...base,
        type: 'node',
        address: '127.0.0.1',
        localRoot: folder,
        remoteRoot: remote,
        sourceMaps: true
      };
      server = ['node', '--inspect-brk=0.0.0.0:5678', 'main.js', ...argv];
      break;
    case 'java':
      launch = { ...base, type: 'java', hostName: '127.0.0.1', sourcePaths: [folder] };
      server = [
        'java',
        '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:5678',
        '-cp',
        '.',
        'Main',
        ...argv
      ];
      break;
    case 'go':
      launch = {
        ...base,
        type: 'go',
        mode: 'remote',
        host: '127.0.0.1',
        debugAdapter: 'dlv-dap',
        substitutePath: [{ from: folder, to: remote }]
      };
      server = ['dlv', 'exec', './main', '--headless', '--listen=0.0.0.0:5678', '--api-version=2', '--', ...argv];
      break;
    default:
      throw new Error('Unsupported course debugger.');
  }
  const start = {
    ...task('dhimantAI: Prepare debugger', 'python', ['/opt/dhimantai/debug.py', ...server]),
    ...(build ? { dependsOn: build.label } : {})
  };
  launch.preLaunchTask = start.label;
  return { launch, tasks: build ? [build, start] : [start], server };
}
