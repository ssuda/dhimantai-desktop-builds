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
import { hasColabLabs, prepareColabNotebooks, validateCourseLabs, CourseLab } from './colabNotebooks';

export interface CourseScope {
  course: string;
  account: string;
  environment: EnvironmentName;
}
interface CourseRecord extends CourseScope {
  root: string;
  key: string;
  debugger?: { bin: string; port: number };
  /** Set after the first successful setup: later runs only start the container, with no download or build. */
  prepared?: boolean;
}
interface Recipe {
  language?: string;
  torch?: string;
  requirements?: string[];
  imports?: string[];
  labs?: boolean;
}
const languages = ['python', 'c', 'java', 'javascript', 'typescript', 'go', 'rust', 'sql', 'pglab', 'bash', 'zsh'];
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
  private readonly verifiedLanguages = new WeakMap<CourseEngine, Set<string>>();
  constructor(
    private context: vscode.ExtensionContext,
    private auth: Auth,
    private env: () => EnvironmentName,
    private readonly output: vscode.OutputChannel,
    private readonly available: boolean,
    private readonly downloadLabs?: (scope: CourseScope) => Promise<CourseLab[]>
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
    return this.available && vscode.workspace.getConfiguration('dhimantai').get('courseContainers', true);
  }
  recordFor(uri: vscode.Uri) {
    return uri.scheme === 'file' ? this.records.find((r) =>
      within(r.root, uri.fsPath) && !within(join(r.root, 'colab'), uri.fsPath)) : undefined;
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
    const key = this.recordFor(uri)?.course.trim().toLowerCase();
    if (!key) return;
    return this.loadedRecipes[key]?.language ?? (languages.includes(key) ? key : undefined);
  }
  private async check(s: CourseScope) {
    await this.checkAccount(s);
    if (vscode.env.remoteName || !vscode.workspace.isTrusted)
      throw new Error('Open the course in a trusted, local VS Code window to use Podman.');
  }

  private async recipe(s: CourseScope) {
    const key = s.course.trim().toLowerCase(),
      r = (await this.recipes)[key] ?? {};
    return { ...r, language: r.language ?? (languages.includes(key) ? key : 'python') };
  }

  private async writeRecipe(record: CourseRecord) {
    const recipe = await this.recipe(record),
      root = record.root;
    const generated = join(root, 'runtime');
    await mkdir(generated, { recursive: true });
    if ((await realpath(generated)) !== generated)
      throw new Error('The course runtime folder must be inside the course.');
    const template = await readFile(join(this.media, 'Dockerfile'), 'utf8');
    const torch = recipe.torch
      ? 'RUN python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==' +
        recipe.torch
      : '';
    await createOnce(
      join(root, 'Dockerfile'),
      template.replace('# COURSE_EXTRA_INSTALL', torch).replace('COURSE_LANGUAGE', recipe.language)
    );
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
      'cells.py'
    ];
    for (const file of helpers) {
      const source = join(['pytrace.py', 'pycall.py'].includes(file) ? dirname(this.media) : this.media, file);
      const target = join(generated, file),
        text = await readFile(source, 'utf8');
      if ((await readFile(target, 'utf8').catch(() => null)) !== text) await atomic(target, text);
    }
    const hash = createHash('sha256');
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
    return { ...s, key, root: await realpath(path) };
  }

  private async prepare(s: CourseScope, previous?: CourseRecord, repair = false): Promise<CourseEngine> {
    if (!this.enabled) throw new Error('Enable DhimantAI course containers in Settings to set up this workstation.');
    await this.check(s);
    const record = await this.courseDirectory(s, previous);
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
              '127.0.0.1::5678/tcp',
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

  /** Stop every course container this window started (and a machine it started), when VS Code closes. */
  async stopAll() {
    const engines = [...this.engines.values()];
    this.engines.clear();
    if (engines.length) await stopCourseRuntime(engines[0].bin, engines.map(engine => engine.name));
  }

  /** Whether running here needs only a container start, not the one-time Podman install and image build. */
  isSetUp(uri: vscode.Uri): boolean {
    const record = this.enabled ? this.recordFor(uri) : undefined;
    return !!record && (this.engines.has(record.key) || record.prepared === true);
  }

  async forFile(uri: vscode.Uri, language?: string): Promise<CourseEngine | undefined> {
    if (!this.enabled) return;
    const record = this.recordFor(uri);
    if (!record) return;
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
    if (!languages.includes(language)) throw new Error('Unsupported course language.');
    const verified = this.verifiedLanguages.get(engine) ?? new Set<string>();
    if (verified.has(language)) return;
    if (language !== 'python')
      await stream(
        engine.bin,
        ['exec', '--user', '0', engine.name, '/usr/local/sbin/dhimantai-language', language],
        (s) => this.output.append(s)
      );
    await repairable(verifyCourseLanguage(engine, language));
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

  async enterColab(scope: CourseScope) {
    await this.checkAccount(scope);
    if (!hasColabLabs(scope.course)) throw new Error('Colab TPU labs are available for Build an LLM from Scratch.');
    const labs = await this.courseLabs(scope);
    if (!await ensureColab()) return;
    await this.checkAccount(scope);
    const { root } = await this.courseDirectory(scope);
    const directory = join(root, 'colab');
    const names = await prepareColabNotebooks(labs, directory, scope.environment);
    const selected = await vscode.window.showQuickPick(names.map(name => ({
      label: name.replace(/\.ipynb$/, ''), name,
      description: name.startsWith('00-') ? 'Start here — verify your TPU connection' : 'Course lesson',
    })), { title: 'LLM course on Colab TPU', placeHolder: 'Choose a notebook. Existing edits are preserved.' });
    if (!selected) return;
    await this.checkAccount(scope);
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(join(directory, selected.name)));
    await chooseColabKernel(doc);
  }

  async enter(
    scope: CourseScope,
    action: { kind: 'start' } | { kind: 'notebook'; language: string; notebook: string } = { kind: 'start' }
  ) {
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
    await this.serial(() => this.writeRecipe(record));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(record.root, 'Dockerfile')));
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  async terminal(target = this.activeFile()) {
    const engine = await this.forFile(target);
    if (!engine) throw new Error('Choose a course workstation first.');
    openCourseTerminal(engine, this.recordFor(target)?.course);
  }
  async terminalOptions(target: vscode.Uri): Promise<vscode.TerminalOptions> {
    const engine = await this.forFile(target);
    if (!engine) throw new Error('Choose a course workstation before opening its terminal.');
    return courseTerminalOptions(engine, this.recordFor(target)!.course);
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
