import { previewPublishArgs } from './skilling';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Auth } from './auth';
import { EnvironmentName } from './environments';
import { ensurePodman, run, stopCourseRuntime, stream } from './podman';
import { CourseEngine } from './courseEngine';
import { repairable, withCourseRepair } from './courseRecovery';
import { courseDebug, courseDebugPort } from './courseDebug';
import { courseExamples, verifyCourseLanguage } from './courseReadiness';
import { courseTerminalOptions, openCourseTerminal } from './courseTerminal';
import { chooseColabKernel, ensureColab } from './colab';
import { openNotebookKernelPicker } from './notebookKernelPicker';
import { COURSE_LANGUAGES, courseDockerfile, courseRecipe, Recipe, recipeLanguage } from './courseRecipe';
import { courseAccelerator, hasColabLabs, prepareColabNotebooks, validateCourseLabs, CourseLab } from './colabNotebooks';
import {RuntimeRelease, runtimeRelease, runtimeSelection, runtimeMachines, composeRuntime} from './courseRuntime';

export interface CourseScope {
  course: string;
  account: string;
  environment: EnvironmentName;
  target?: {lesson?:string; lab?:string};
}
interface CourseRecord extends CourseScope {
  root: string;
  key: string;
  debugger?: { bin: string; port: number };
  /** Set after the first successful setup: later runs only start the container, with no download or build. */
  prepared?: boolean;
  machine?: string;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const within = (root: string, file: string) => {
  const r = relative(root, file);
  return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep);
};
async function atomic(file: string, text: string) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createOnce(file: string, data: string) {
  try {
    await writeFile(file, data, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

function installInTerminal(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const terminal = vscode.window.createTerminal({
      name: 'Install Podman',
      shellPath: '/usr/bin/sudo',
      shellArgs: [file, ...args]
    });
    const closed = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      closed.dispose();
      if (t.exitStatus?.code === 0) resolve();
      else reject(new Error('Podman installation did not finish. Select the course to retry.'));
    });
    terminal.show();
  });
}

export function notebookFile(data: vscode.NotebookData) {
  return JSON.stringify(
    {
      ...data.metadata,
      nbformat: 4,
      nbformat_minor: 5,
      cells: data.cells.map((cell) => ({
        id: randomUUID().slice(0, 8),
        cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
        source: cell.value,
        metadata: cell.metadata ?? {},
        ...(cell.kind === vscode.NotebookCellKind.Code ? { outputs: [], execution_count: null } : {})
      }))
    },
    null,
    2
  );
}

export class CourseWorkspaces {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly recordPrefix = 'dhimantai.courseRuntime.';
  private readonly recipes: Promise<Record<string, Recipe>>;
  private loadedRecipes: Record<string, Recipe> = {};
  private readonly media: string;
  private readonly engines = new Map<string, CourseEngine>();
  private readonly releases = new Map<string, RuntimeRelease>();
  private readonly started = new Map<string, CourseEngine>();
  private readonly activeMachines = new Map<string, {selection:string; names:string[]}>();
  private readonly verifiedLanguages = new WeakMap<CourseEngine, Set<string>>();
  constructor(
    private context: vscode.ExtensionContext,
    private auth: Auth,
    private env: () => EnvironmentName,
    private readonly output: vscode.OutputChannel,
    private readonly available: boolean,
    private readonly downloadLabs?: (scope: CourseScope) => Promise<CourseLab[]>,
    private readonly downloadRuntime?: (scope: CourseScope) => Promise<RuntimeRelease | null>
  ) {
    this.media = join(context.extensionPath, 'media', 'course');
    this.recipes = readJson(join(this.media, 'profiles.json'));
    void this.recipes.then(recipes => { this.loadedRecipes = recipes; }, () => {});
  }
  private get records() {
    return this.context.globalState
      .keys()
      .filter((key) => key.startsWith(this.recordPrefix))
      .map((key) => this.context.globalState.get<CourseRecord>(key)!);
  }
  get enabled() {
    // Older settings may contain courseContainers=false; learner execution is now container-only.
    return this.available;
  }
  recordFor(uri: vscode.Uri) {
    return uri.scheme === 'file' ? this.records.find((r) =>
      within(r.root, uri.fsPath) && !within(join(r.root, 'colab'), uri.fsPath)
      && !within(join(r.root, 'gpu'), uri.fsPath)) : undefined;
  }
  private async checkAccount(s: CourseScope) {
    if (s.environment !== this.env() || (await this.auth.session())?.user.id !== s.account)
      throw new Error('Sign in to the course’s DhimantAI account and service before opening it.');
  }
  private async courseLabs(scope: CourseScope) {
    await this.checkAccount(scope);
    if (!this.downloadLabs) throw new Error('Course downloads are unavailable. Reopen the course with the current extension.');
    const labs = validateCourseLabs(await this.downloadLabs(scope));
    await this.checkAccount(scope);
    return labs;
  }
  /** The course's single language, when known without waiting (used to preset new notebook cells). */
  languageFor(uri: vscode.Uri): string | undefined {
    const course = this.recordFor(uri)?.course;
    return course ? recipeLanguage(this.loadedRecipes, course) : undefined;
  }
  private async check(s: CourseScope) {
    await this.checkAccount(s);
    if (vscode.env.remoteName || !vscode.workspace.isTrusted)
      throw new Error('Open the course in a trusted, local VS Code window to use Podman.');
  }

  private async recipe(s: CourseScope) {
    return courseRecipe({...await this.recipes,...this.loadedRecipes}, s.course);
  }

  private async writeRecipe(record: CourseRecord) {
    const recipe = await this.recipe(record),
      root = record.root;
    const generated = join(root, 'runtime');
    await mkdir(generated, { recursive: true });
    if ((await realpath(generated)) !== generated)
      throw new Error('The course runtime folder must be inside the course.');
    const template = await readFile(join(this.media, 'Dockerfile'), 'utf8');
    await createOnce(join(root, 'Dockerfile'), courseDockerfile(template, recipe));
    await createOnce(join(root, 'requirements.txt'), (recipe.requirements ?? []).join('\n') + '\n');
    await createOnce(
      join(root, '.containerignore'),
      '*\n!Dockerfile\n!requirements.txt\n!runtime/\n!runtime/**\n'
    );
    const helpers = [
      'language.sh',
      'kernel.py',
      'bridge.py',
      'terminal.py',
      'debug.py',
      'user.py',
      'shell.sh',
      'zshrc',
      'runner.cjs',
      'pytrace.py',
      'pycall.py',
      'sql_runtime.py',
      'cells.py',
      'lab_scenarios.py'
    ];
    for (const file of helpers) {
      const source = join(['pytrace.py', 'pycall.py'].includes(file) ? dirname(this.media) : this.media, file);
      const target = join(generated, file),
        text = await readFile(source, 'utf8');
      if ((await readFile(target, 'utf8').catch(() => null)) !== text) await atomic(target, text);
    }
    const scenarioFile = join(generated, 'lab_scenarios.json');
    const scenarios = recipe.scenarios
      ? await readFile(join(this.media, 'scenarios', recipe.scenarios + '.json'), 'utf8')
      : JSON.stringify({version:1, scenarios:[]});
    if ((await readFile(scenarioFile, 'utf8').catch(() => null)) !== scenarios) await atomic(scenarioFile, scenarios);
    const hash = createHash('sha256');hash.update('preview-ports-v1');
    async function include(file: string) {
      hash.update(file + '\0');
      hash.update(await readFile(join(root, file)));
      hash.update('\0');
    }
    for (const file of ['Dockerfile', 'requirements.txt', '.containerignore']) await include(file);
    async function walk(dir: string) {
      const contents = await readdir(join(root, dir), { withFileTypes: true });
      for (const entry of contents.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = dir + '/' + entry.name;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) await include(file);
        else throw new Error('Use regular files in the course runtime build context.');
      }
    }
    await walk('runtime');
    return hash.digest('hex').slice(0, 20);
  }

  private serial<T>(fn: () => Promise<T>) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private async courseDirectory(s: CourseScope, previous?: CourseRecord): Promise<CourseRecord> {
    const configured = vscode.workspace.getConfiguration('dhimantai').get<string>('exercisesFolder')?.trim();
    const parent = resolve(
      configured ? configured.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), 'dhimantAI')
    );
    const key = previous?.key ?? digest(JSON.stringify([s.environment, s.account, s.course, parent]));
    const slug =
      s.course
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 36) || 'course';
    const path =
      previous?.root ?? this.records.find((r) => r.key === key)?.root ?? join(parent, 'courses', slug + '-' + key);
    await mkdir(path, { recursive: true });
    return { ...previous, ...s, key, root: await realpath(path) };
  }

  private async prepare(s: CourseScope, previous?: CourseRecord, repair = false): Promise<CourseEngine> {
    if (!this.enabled) throw new Error('The course container is unavailable. Set up the course runtime before running.');
    await this.check(s);
    const record = await this.courseDirectory(s, previous);
    if (s.target) record.target = s.target;
    if (this.downloadRuntime) {
      const published = await this.downloadRuntime(s);
      await this.check(s);
      if (published) return this.preparePublished(record, runtimeRelease(published), repair);
    }
    const { key } = record;
    this.engines.delete(key);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: s.course },
      async (progress) => {
        const report = (message: string) => {
          progress.report({ message });
          this.output.appendLine(message);
        };
        const log = (text: string) => this.output.append(text);
        report(repair ? 'Repairing the course runtime and preserving your course files' : 'Preparing the course Dockerfile and dependencies');
        const fingerprint = await this.writeRecipe(record);
        report('Checking the course runtime');
        const bin = await ensurePodman(report, log, installInTerminal).catch(error => {
          if (process.platform !== 'win32') throw error;
          const guide = 'Windows setup guide';
          void vscode.window.showWarningMessage(
            'To set up Podman manually, enable WSL 2 or Hyper-V, install Podman and start its machine. Restart VS Code and check “podman info” in PowerShell, then choose Open Course Runtime.',
            guide
          ).then(choice => {
            if (choice === guide) void vscode.env.openExternal(vscode.Uri.parse('https://podman-desktop.io/docs/installation/windows-install'));
          });
          throw error;
        });
        const tag = 'localhost/dhimantai-runtime:' + fingerprint;
        await this.check(s);
        if (
          repair || !(await run(bin, ['image', 'exists', tag]).then(
            () => true,
            () => false
          ))
        ) {
          report('Building the course runtime. Allow several minutes for first setup; downloads and computer speed affect the wait. Build details: Output → dhimantAI.');
          await stream(bin, ['build', '--tag', tag, '--file', join(record.root, 'Dockerfile'), record.root], log);
        }
        const name = 'dhimantai-course-' + key;
        const inspect = async () => JSON.parse(await run(bin, ['container', 'inspect', name]))[0];
        let existing;
        if (
          await run(bin, ['container', 'exists', name]).then(
            () => true,
            () => false
          )
        )
          existing = await inspect();
        if (existing && existing.Config.Labels?.['ai.dhimant.course'] !== key)
          throw new Error(
            'Another container already uses the course runtime name. Choose a different exercises folder.'
          );
        if (existing && (repair || existing.Config.Labels?.['ai.dhimant.recipe'] !== fingerprint)) {
          report('Applying the updated course recipe');
          await stream(bin, ['rm', '--force', '--ignore', existing.Id], log);
          existing = undefined;
        }
        if (!existing) await repairable((async () => {
          const source = ('source=' + record.root).replace(/"/g, '""');
          const user = process.getuid ? String(process.getuid()) + ':' + String(process.getgid!()) : '1000:1000';
          await stream(
            bin,
            [
              'run',
              '--detach',
              '--name',
              name,
              '--label',
              'ai.dhimant.course=' + key,
              '--label',
              'ai.dhimant.recipe=' + fingerprint,
              '--mount',
              'type=bind,"' +
                source +
                '",target=/course' +
                (process.platform === 'linux' ? ',relabel=private' : ''),
              ...(process.platform === 'linux' ? ['--userns=keep-id'] : []),
              // A runaway learner program cannot take over the machine; model courses get more room.
              '--pids-limit', '1024', '--memory', (await this.recipe(s)).torch ? '3g' : '1536m',
              '--user',
              user,
              '--env',
              'HOME=/course/.home',
              '--env',
              'SHELL=/bin/zsh',
              '--publish',
              '127.0.0.1::5678/tcp', ...previewPublishArgs,
              '--workdir',
              '/course',
              tag,
              'sleep',
              'infinity'
            ],
            log
          ).catch(async (error) => {
            // A second window can finish creating this course while the first builds.
            const current = await inspect().catch(() => undefined);
            if (
              current?.Config.Labels?.['ai.dhimant.course'] !== key ||
              current.Config.Labels?.['ai.dhimant.recipe'] !== fingerprint
            )
              throw error;
            if (!current.State.Running) await stream(bin, ['start', current.Id], log);
          });
        })());
        else if (!existing.State.Running) await repairable(stream(bin, ['start', name], log));
        const engine = new CourseEngine(bin, name, record.root);
        report('Preparing zsh and Oh My Zsh for the course terminal');
        await repairable(stream(bin, ['exec', '--user', '0', name, 'python', '/opt/dhimantai/user.py',
          String(process.getuid?.() ?? 1000), String(process.getgid?.() ?? 1000)], log));
        const recipe = await this.recipe(s);
        report('Checking the course packages');
        await repairable(run(
          bin,
          engine.execArgs(record.root, 'python', [
            '-c',
            'import importlib; from pathlib import Path; Path.home().mkdir(exist_ok=True); ' +
            `[importlib.import_module(name) for name in ${JSON.stringify(['ipykernel', 'nbformat', ...(recipe.imports ?? [])])}]`
          ]), 60000
        ));
        await repairable(run(bin, engine.execArgs(record.root, 'python', ['-m', 'pip', 'check']), 60000));
        report('Running a course readiness check');
        await this.ensureLanguage(engine, recipe.language);
        await this.check(s);
        const port = await courseDebugPort(engine).catch(() => undefined);
        await this.context.globalState.update(this.recordPrefix + key, { ...record, prepared: true, debugger: port ? {bin, port} : undefined });
        this.engines.set(key, engine);
        report('Course workstation ready. Packages and code execution verified.');
        // Cell execution is the default; the runtime menu opens a terminal only when requested.
        return engine;
      }
    );
  }

  private async preparePublished(record:CourseRecord, release:RuntimeRelease, repair:boolean):Promise<CourseEngine> {
    const selection = runtimeSelection(release, record.target);
    const machines = runtimeMachines(release, selection);
    const machine = machines.includes(record.machine ?? '') ? record.machine! : selection.compose
      ? release.composes[selection.compose].default_service : 'course';
    this.releases.set(record.key, release);
    this.loadedRecipes[record.course.toLowerCase()] = release.recipe;
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:record.course}, async progress => {
      const report = (message:string) => {progress.report({message});this.output.appendLine(message);};
      const log = (message:string) => this.output.append(message);
      const bin = await ensurePodman(report, log, installInTerminal);
      await this.check(record);
      const selectionKey = selection.compose ?? 'course';
      const previous = this.activeMachines.get(record.key);
      if (previous && previous.selection !== selectionKey) {
        report('Pausing the previous lab machines');
        await stream(bin, ['stop', '--time', '10', ...previous.names], log);
      }
      const fingerprint = digest(JSON.stringify([release.source_sha256, selection, 'preview-ports-v1']));
      let name:string;
      const activeNames:string[] = [];
      if (selection.compose) {
        await run(bin, ['compose', 'version']).catch(() => {throw new Error('Install a Compose provider for Podman, then retry course setup.');});
        const directory = join(record.root, '.dhimantai', 'runtime');
        await mkdir(directory, {recursive:true});
        const file = join(directory, selection.compose + '.compose.json');
        await atomic(file, JSON.stringify(composeRuntime(release, selection, record.root, record.key,
          process.getuid?.() ?? 1000, process.getgid?.() ?? 1000), null, 2));
        const args = ['compose', '--project-name', 'dhimantai-' + record.key + '-' + selection.compose, '--file', file];
        report('Preparing the lab machines from published images');
        await stream(bin, [...args, 'up', '-d', ...(repair ? ['--force-recreate'] : [])], log);
        for (const target of machines) {
          const id = (await run(bin, [...args, 'ps', '-q', target])).trim();
          if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('A lab machine did not start: ' + target);
          const info = JSON.parse(await run(bin, ['inspect', id]))[0];
          if (info.Config.Labels?.['ai.dhimant.course'] !== record.key || !info.State.Running)
            throw new Error('The lab machine could not be verified: ' + target);
          await run(bin, ['exec', id, 'python', '-c',
            'import time; from pathlib import Path; deadline=time.monotonic()+30; p=Path("/tmp/dhimantai-runtime-ready"); '
            + '\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.1)\nassert p.exists(), "Course machine startup did not complete"'], 35000);
          const readyFile = release.composes[selection.compose].compose.services[target].environment?.DHIMANTAI_LAB_READY_FILE;
          if (readyFile) await run(bin, ['exec', id, 'python', '-c',
            'import time,sys; from pathlib import Path; deadline=time.monotonic()+120; p=Path(sys.argv[1]); '
            + '\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.2)\nassert p.exists(), "Lab initialization did not complete"',readyFile],125000);
          const engine = new CourseEngine(bin, id, record.root, true, target,
            release.composes[selection.compose].compose.services[target].environment?.DHIMANTAI_DATABASE_MODE === 'service');
          this.started.set(id, engine);
          activeNames.push(id);
          if (target === machine) name = id;
        }
      } else {
        name = 'dhimantai-course-' + record.key;
        report('Downloading the published course image');
        await stream(bin, ['pull', selection.image], log);
        let info = await run(bin, ['container', 'inspect', name]).then(text => JSON.parse(text)[0], () => undefined);
        if (info && info.Config.Labels?.['ai.dhimant.course'] !== record.key) throw new Error('Another container owns the course runtime name.');
        if (info && (repair || info.Config.Labels?.['ai.dhimant.recipe'] !== fingerprint)) {
          await stream(bin, ['rm', '--force', name], log); info = undefined;
        }
        if (!info) {
          const source = record.root.replace(/"/g, '""');
          await stream(bin, ['run', '--detach', '--name', name, '--label', 'ai.dhimant.course=' + record.key,
            '--label', 'ai.dhimant.recipe=' + fingerprint, '--mount', 'type=bind,"source=' + source + '",target=/course' + (process.platform === 'linux' ? ',relabel=private' : ''),
            ...(process.platform === 'linux' ? ['--userns=keep-id'] : []), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            '--pids-limit','1024','--memory',release.recipe.torch ? '3g' : '1536m', '--cpus','2',
            '--env','HOME=/course/.home','--env','SHELL=/bin/zsh','--publish','127.0.0.1::5678/tcp', ...previewPublishArgs,
            '--workdir','/course',selection.image,'sleep','infinity'], log);
        } else if (!info.State.Running) await stream(bin, ['start', name], log);
        await stream(bin, ['exec','--user','0',name,'python','/opt/dhimantai/user.py',
          String(process.getuid?.() ?? 1000),String(process.getgid?.() ?? 1000)], log);
        activeNames.push(name);
      }
      const engine = new CourseEngine(bin, name!, record.root, true, machine,
        !!selection.compose && release.composes[selection.compose].compose.services[machine].environment?.DHIMANTAI_DATABASE_MODE === 'service');
      await repairable(verifyCourseLanguage(engine, engine.serviceDatabase ? 'bash' : release.recipe.language));
      await this.check(record);
      this.started.set(engine.name, engine);
      this.activeMachines.set(record.key, {selection:selectionKey,names:activeNames});
      this.engines.set(record.key, engine);
      const port = selection.compose ? undefined : await courseDebugPort(engine).catch(() => undefined);
      await this.context.globalState.update(this.recordPrefix + record.key, {...record,machine,prepared:true,
        debugger:port ? {bin,port} : undefined});
      report('Ready · ' + (machine === 'course' ? record.course : machine));
      return engine;
    });
  }

  machineState(uri:vscode.Uri) {
    const record = this.recordFor(uri), release = record && this.releases.get(record.key);
    if (!record || !release) return undefined;
    const selection = runtimeSelection(release,record.target);
    return {machines:runtimeMachines(release,selection),selected:this.engines.get(record.key)?.target ?? record.machine};
  }

  async selectMachine(uri:vscode.Uri, machine:string) {
    await this.forFile(uri);
    const record = this.recordFor(uri)!, release = this.releases.get(record.key);
    if (!release || !runtimeMachines(release,runtimeSelection(release,record.target)).includes(machine)) throw new Error('Choose a machine declared by this lab.');
    record.machine = machine;
    await this.serial(() => this.preparePublished(record,release,false));
  }

  /** Stop every course container this window started (and a machine it started), when VS Code closes. */
  async stopAll() {
    const engines = [...this.engines.values(), ...this.started.values()];
    this.engines.clear();
    this.started.clear();
    this.activeMachines.clear();
    if (engines.length) await stopCourseRuntime(engines[0].bin, [...new Set(engines.map(engine => engine.name))]);
  }

  /** Whether running here needs only a container start, not the one-time Podman install and image build. */
  isSetUp(uri: vscode.Uri): boolean {
    const record = this.enabled ? this.recordFor(uri) : undefined;
    return !!record && (this.engines.has(record.key) || record.prepared === true);
  }

  async forFile(uri: vscode.Uri, language?: string, target?:{lesson?:string;lab?:string}): Promise<CourseEngine | undefined> {
    if (!this.enabled) return;
    const record = this.recordFor(uri);
    if (!record) return;
    const exercise = /[/\\]exercises[/\\]([a-f0-9-]{36})(?:[/\\]|$)/i.exec(uri.fsPath)?.[1];
    target ??= exercise ? {lab:exercise} : undefined;
    if (target && JSON.stringify(record.target) !== JSON.stringify(target)) {
      record.target = target;
      record.machine = undefined;
      this.engines.delete(record.key);
    }
    await this.check(record);
    return withCourseRepair(async () => {
      await this.check(record);
      let engine = this.engines.get(record.key);
      if (!engine || (await run(engine.bin, ['inspect', '--format', '{{.State.Running}}', engine.name]).catch(() => '')) !== 'true')
        engine = await this.serial(() => this.prepare(record, record));
      if (language) await this.ensureLanguage(engine, language);
      return engine;
    }, async error => {
      this.output.appendLine(`Course startup failed; repairing ${record.course}: ${error instanceof Error ? error.message : String(error)}`);
      await this.check(record);
      this.engines.delete(record.key);
      await this.serial(() => this.prepare(record, record, true));
    });
  }

  // Generate F5 settings from the last setup. Opening a source file must never start the engine.
  async savedDebugConfiguration(record: CourseRecord, uri: vscode.Uri, language: string, argv: string[]) {
    if (!record.debugger) return;
    const engine = new CourseEngine(record.debugger.bin, 'dhimantai-course-' + record.key, record.root);
    return courseDebug(engine, uri.fsPath, language, argv, record.debugger.port);
  }

  private async ensureLanguage(engine: CourseEngine, language: string) {
    if (!COURSE_LANGUAGES.includes(language)) throw new Error('Unsupported course language.');
    const verified = this.verifiedLanguages.get(engine) ?? new Set<string>();
    if (verified.has(language)) return;
    if (language !== 'python' && !engine.published)
      await stream(
        engine.bin,
        ['exec', '--user', '0', engine.name, '/usr/local/sbin/dhimantai-language', language],
        (s) => this.output.append(s)
      );
    await repairable(verifyCourseLanguage(engine, engine.serviceDatabase && ['sql','pglab'].includes(language) ? 'bash' : language));
    verified.add(language);
    this.verifiedLanguages.set(engine, verified);
  }

  async setup(scope: CourseScope) {
    return withCourseRepair(() => this.serial(() => this.prepare(scope)), async error => {
      this.output.appendLine(`Course setup failed; repairing ${scope.course}: ${error instanceof Error ? error.message : String(error)}`);
      await this.serial(() => this.prepare(scope, undefined, true));
    });
  }

  /** Register ownership without starting or installing anything while browsing/editing. */
  async courseFolder(scope: CourseScope) {
    await this.checkAccount(scope);
    const record = await this.courseDirectory(scope);
    const key = this.recordPrefix + record.key;
    if (!this.context.globalState.get(key)) await this.context.globalState.update(key, record);
    return vscode.Uri.file(record.root);
  }

  async exerciseDirectory(scope: CourseScope, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid exercise ID.');
    await this.checkAccount(scope);
    const root = (await this.courseFolder(scope)).fsPath;
    await this.importPrevious(dirname(dirname(root)), root, scope, id);
    return vscode.Uri.file(join(root, 'exercises', id));
  }

  async enterColab(scope: CourseScope, provider: 'google.colab' | 'jupyter' = 'google.colab') {
    await this.checkAccount(scope);
    if (!hasColabLabs(scope.course)) throw new Error('No Colab labs are available for this course.');
    const accelerator = courseAccelerator(scope.course)!;
    const labs = await this.courseLabs(scope);
    if (provider === 'google.colab' && !await ensureColab()) return;
    await this.checkAccount(scope);
    const root = (await this.courseFolder(scope)).fsPath;
    const directory = join(root, provider === 'google.colab' ? 'colab' : 'gpu');
    const names = await prepareColabNotebooks(labs, directory, scope.environment, scope.course, provider);
    const selected = await vscode.window.showQuickPick(names.map(name => ({
      label: name.replace(/\.ipynb$/, ''), name,
      description: name.startsWith('00-') ? `Start here — connect your ${accelerator.toUpperCase()} runtime` : 'Course lesson',
    })), { title: `${scope.course} · ${accelerator.toUpperCase()} runtime`, placeHolder: 'Choose a notebook. Existing edits are preserved.' });
    if (!selected) return;
    await this.checkAccount(scope);
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(join(directory, selected.name)));
    if (provider === 'google.colab') await chooseColabKernel(doc, accelerator);
    else await openNotebookKernelPicker(doc);
    return doc;
  }

  async enter(
    scope: CourseScope,
    action: { kind: 'start' } | { kind: 'notebook'; language: string; notebook: string } = { kind: 'start' }
  ) {
    // GPU course labs can connect directly to student hardware or Colab; downloading
    // them must not first provision a local CPU container or require Google sign-in.
    if (action.kind === 'start' && courseAccelerator(scope.course) === 'gpu') return this.enterColab(scope, 'jupyter');
    const labs = action.kind === 'start' && (await this.recipe(scope)).labs ? await this.courseLabs(scope) : undefined;
    const engine = await this.setup(scope);
    const recipe = await this.recipe(scope);
    const language = action.kind === 'notebook' ? action.language : recipe.language;
    await this.ensureLanguage(engine, language);
    const dir = join(engine.root, 'notebooks');
    await mkdir(dir, { recursive: true });
    let name: string;
    if (action.kind === 'notebook') {
      name = randomUUID() + '.ipynb';
      await createOnce(join(dir, name), action.notebook);
    } else if (recipe.labs && action.kind === 'start') {
      const availableLabs: string[] = [];
      for (const {name: f, notebook} of labs ?? []) {
        const title = String(notebook.cells[0].source).split('\n')[0].replace(/^#+ /, '');
        availableLabs.push(f);
        notebook.metadata.dhimantai_coach = {
          version: 1,
          environment: scope.environment,
          path: '/notebook-coach/tutor',
          question: title
        };
        await createOnce(join(dir, f), JSON.stringify(notebook, null, 2));
      }
      if (!availableLabs.length) throw new Error('No labs are unlocked. Open Pricing & Purchases to unlock the course.');
      name = availableLabs[0];
    } else {
      name = 'Start.ipynb';
      const notebook = new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, courseExamples[language], language)
      ]);
      notebook.metadata = {
        metadata: {
          kernelspec: { name: language === 'python' ? 'python3' : language, display_name: language, language },
          dhimantai_coach: {
            version: 1,
            environment: scope.environment,
            path: '/notebook-coach/tutor',
            question: 'Explore ' + scope.course
          }
        }
      };
      await createOnce(join(dir, name), notebookFile(notebook));
    }
    await this.check(scope);
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(join(dir, name)));
    await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.commands.executeCommand('notebook.selectKernel', {
      id: 'dhimantai-course',
      extension: 'optficial.dhimantai-learning'
    });
    return doc;
  }

  private activeFile() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const active = vscode.window.activeNotebookEditor?.notebook.uri;
    const target = [uri, active].find((file) => file && this.recordFor(file));
    if (!target) throw new Error('Open a file or notebook in a DhimantAI course first.');
    return target;
  }
  async openDockerfile() {
    const record = this.recordFor(this.activeFile())!;
    await this.check(record);
    const release = this.releases.get(record.key);
    if (release) {
      const image = runtimeSelection(release,record.target).image;
      const doc = await vscode.workspace.openTextDocument({language:'dockerfile',content:'# Published course image\nFROM ' + image + '\n'});
      await vscode.window.showTextDocument(doc,{preview:true});
      return;
    }
    await this.serial(() => this.writeRecipe(record));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(record.root, 'Dockerfile')));
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  async terminal(target = this.activeFile()) {
    const engine = await this.forFile(target);
    if (!engine) throw new Error('Choose a course workstation first.');
    const cwd = (await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory ? target.fsPath : dirname(target.fsPath);
    openCourseTerminal(engine, this.recordFor(target)?.course + (engine.target === 'course' ? '' : ' · ' + engine.target), cwd);
  }
  async terminalOptions(target: vscode.Uri): Promise<vscode.TerminalOptions> {
    const engine = await this.forFile(target);
    if (!engine) throw new Error('Choose a course workstation before opening its terminal.');
    const cwd = (await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory ? target.fsPath : dirname(target.fsPath);
    return courseTerminalOptions(engine, this.recordFor(target)!.course, cwd);
  }
  private async importPrevious(parent: string, root: string, scope: CourseScope, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid exercise identifier.');
    const dest = join(root, 'exercises', id);
    if (
      await access(dest).then(
        () => true,
        () => false
      )
    )
      return;
    const old = join(
      parent,
      scope.environment === 'production' ? '' : scope.environment,
      'account-' + scope.account.slice(0, 8)
    );
    for (const dir of await readdir(old, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() || !dir.name.endsWith('-' + id.slice(0, 8))) continue;
      const from = join(old, dir.name);
      const meta = await readJson(join(from, '.dhimantai.json')).catch(() => undefined);
      if (meta?.userId !== scope.account || meta.questionId !== id || meta.environment !== scope.environment)
        continue;
      await mkdir(join(root, 'exercises'), { recursive: true });
      const tmp = await mkdtemp(join(root, 'exercises', '.migrate-'));
      try {
        await cp(from, tmp, { recursive: true });
        await rename(tmp, dest);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }
  }
}
