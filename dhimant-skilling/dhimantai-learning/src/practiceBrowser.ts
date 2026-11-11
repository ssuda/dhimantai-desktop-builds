import { CourseWorkspaces, CourseScope, notebookFile } from './courseWorkspace';
import { hasColabLabs } from './colabNotebooks';
import * as vscode from 'vscode';
import { Api, ApiError, Chapter, Course, Language, GeneratedExercise, PracticeQuestion, QuestionPool } from './api';
import { Auth } from './auth';
import { jupyterMetadata } from './notebookCommands';
import { Environment, EnvironmentName } from './environments';
import { ProjectResults, ProjectSummary } from './projectResults';
import { byDifficulty, dueReviews, hardReady, onRecordsChanged, ProblemRecord, progressText, rememberTopic, sharedRecords, trend, trendText } from './helpRecord';
import { courseCoverage, coverageLabel } from './courseProgress';
import { learnerRpc, PublicCatalog } from './learnerCatalog';

type Scope = { account: string; environment: EnvironmentName };
type ChapterNode = Scope & { kind: 'chapter'; chapter: Chapter; course: string; languages: Language[]; pools?: QuestionPool[] };
type Node = ChapterNode
  | { kind: 'project'; project: ProjectSummary }
  | (Scope & { kind: 'course'; course: Course; languages: Language[]; pools?: QuestionPool[] })
  | (Scope & {kind: 'courseGrade'; course: string})
  | { kind: 'pool'; parent: ChapterNode; pool: QuestionPool; questions?: PracticeQuestion[] }
  | { kind: 'topic'; parent: ChapterNode; name: string; questions: PracticeQuestion[] }
  | { kind: 'question'; parent: ChapterNode; question: PracticeQuestion; siblings?: PracticeQuestion[] }
  | { kind: 'progress'; account: string }
  | { kind: 'reviews'; account: string; due: ProblemRecord[] }
  | { kind: 'review'; account: string; problem: ProblemRecord }
  | { kind: 'generate'; parent: ChapterNode }
  | { kind: 'notice'; label: string; command?: string; args?: unknown[] };

export class PracticeBrowser implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private sequence = 0;
  // A graded pass changes ticks, progress and the review list.
  private readonly records = onRecordsChanged(() => this.changed.fire());

  constructor(private readonly auth: Auth, private readonly environment: () => EnvironmentName,
      private readonly service: () => Environment, private readonly containers?: CourseWorkspaces,
      private readonly results?: ProjectResults, private readonly media = '') {}

  refresh() { this.sequence++; this.changed.fire(); }
  dispose() { this.records.dispose(); this.changed.dispose(); }

  private async requireScope(scope: Scope) {
    if ((await this.auth.session())?.user.id !== scope.account || this.environment() !== scope.environment) {
      throw new Error('Your account or service changed. Refresh Practice and choose the chapter again.');
    }
  }

  private scopedApi(scope: Scope) {
    const service = this.service();
    return new Api(this.auth, () => {
      if (this.environment() !== scope.environment) throw new Error('Your service changed. Refresh Practice.');
      return service;
    }, scope.account);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const folder = (label: string, icon: string) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(icon);
      return item;
    };
    switch (node.kind) {
      case 'courseGrade': {
        const item = new vscode.TreeItem('Grade & certificate');
        item.iconPath = new vscode.ThemeIcon('mortar-board');
        item.command = {command:'dhimantai.courseGrade',title:'Course grade & certificate',arguments:[node.course]};
        return item;
      }
      case 'project': {
        const item = new vscode.TreeItem(node.project.title);
        item.id = 'project:' + node.project.root;
        item.description = node.project.status;
        item.tooltip = node.project.root + '\n' + node.project.status + '\nSaved on this computer; not a grade.';
        item.iconPath = new vscode.ThemeIcon('repo');
        item.command = {command: 'dhimantai.openSavedProject', title: 'Open project', arguments: [node.project.root]};
        return item;
      }
      case 'course': {
        const item = folder(node.course.name, 'library');
        item.description = courseCoverage(node.course.chapters);
        if (hasColabLabs(node.course.name)) item.contextValue = 'dhimantaiCourseColab';
        else if (this.containers?.enabled) item.contextValue = 'dhimantaiCourse';
        return item;
      }
      case 'chapter': {
        if (node.chapter.locked) {
          const item = new vscode.TreeItem(node.chapter.name);
          item.id = 'chapter:' + node.chapter.id;
          item.iconPath = new vscode.ThemeIcon('lock');
          // An ended access period is bought again from the catalog; the row says so and opens it.
          const expired = node.chapter.expired;
          item.description = coverageLabel(node.chapter.progress) + ' · ' + (expired ? 'Access ended · Buy again' : 'Purchase to unlock');
          item.tooltip = expired ? 'Your access to this course ended. Buy it again from the Course Catalog to continue.'
            : 'Purchase this course or a bundle to unlock this chapter.';
          item.accessibilityInformation = {label: `${node.chapter.name}, ${expired ? 'access ended. Buy the course again' : 'locked. Purchase to unlock'}`};
          item.command = expired ? { command: 'dhimantai.courseCatalog', title: 'Buy this course again' }
            : { command: 'dhimantai.pricing', title: 'View course pricing' };
          return item;
        }
        const item = folder(node.chapter.name, 'book');
        item.id = 'chapter:' + node.chapter.id;
        item.description = coverageLabel(node.chapter.progress);
        item.tooltip = [node.chapter.lesson, item.description].filter(Boolean).join('\n');
        return item;
      }
      case 'pool': return folder(node.pool === 'textbook' ? 'Textbook Questions' : 'Institution Questions', 'folder');
      case 'topic': return folder(node.name, 'symbol-key');
      case 'question': {
        const q = node.question;
        const item = new vscode.TreeItem(q.title);
        item.id = 'question:' + node.parent.chapter.id + ':' + q.id;
        const records = sharedRecords(node.parent.account), solved = records.find(r => r.id === q.id)?.solved;
        // Hard is a stretch goal, not a lock: it stays openable.
        const stretch = !solved && q.difficulty?.toLowerCase() === 'hard' && !hardReady(node.siblings ?? [], records);
        item.description = [solved ? (solved.help ? '✓ solved · needed help' : '✓ solved') : '', q.language, q.difficulty,
          stretch ? 'Try after 2 Medium solved independently' : ''].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(solved ? 'pass' : q.kind === 'written' ? 'note' : 'code');
        item.command = { command: 'dhimantai.openPracticeQuestion', title: 'Open practice exercise', arguments: [node] };
        return item;
      }
      case 'generate': {
        const item = new vscode.TreeItem('Generate an exercise…');
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: 'dhimantai.generateExercise', title: 'Generate an exercise', arguments: [node.parent] };
        return item;
      }
      case 'progress': {
        const records = sharedRecords(node.account);
        const item = new vscode.TreeItem('Progress: ' + progressText(records));
        item.tooltip = trendText(trend(records)) + '\nA problem counts as solved when every graded test passes, hidden ones included.';
        item.iconPath = new vscode.ThemeIcon('graph');
        return item;
      }
      case 'reviews': {
        const item = new vscode.TreeItem('Review today', vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'reviews';
        item.description = `${node.due.length} due`;
        item.tooltip = 'Solve these again from memory. Spaced practice after 1, 3 and 7 days makes a solution stick.';
        item.iconPath = new vscode.ThemeIcon('history');
        return item;
      }
      case 'review': {
        const item = new vscode.TreeItem(node.problem.title);
        item.id = 'review:' + node.problem.id;
        item.description = node.problem.language;
        item.iconPath = new vscode.ThemeIcon('debug-restart');
        item.command = { command: 'dhimantai.openExercise', title: 'Review this exercise', arguments: [node.problem.id, node.account, undefined, node.problem.title] };
        return item;
      }
      case 'notice': {
        const item = new vscode.TreeItem(node.label);
        if (node.command) item.command = { command: node.command, title: node.label, arguments: node.args };
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const sequence = this.sequence;
    let projects: Node[] = [];
    try {
      if (!node) {
        const account = (await this.auth.session())?.user.id;
        projects = (await this.results?.summaries(this.media, this.environment(), account ?? 'local') ?? [])
          .map(project => ({kind: 'project' as const, project}));
        if (sequence !== this.sequence) return [];
        if (!account) return [
          ...projects,
          { kind: 'notice', label: 'Course Catalog · first chapter free', command: 'dhimantai.courseCatalog' },
          { kind: 'notice', label: 'Create an account', command: 'dhimantai.signUp' },
          { kind: 'notice', label: 'Sign in', command: 'dhimantai.signIn' },
        ];
        const scope = { account, environment: this.environment() };
        const { courses, languages, question_pools } = await this.scopedApi(scope).practiceCatalog();
        // Older services do not return source availability. Use their existing account catalog.
        let pools = question_pools;
        if (!pools) {
          const backend = this.service(), token = await this.auth.accessToken();
          await this.requireScope(scope);
          pools = (await learnerRpc<PublicCatalog>(backend, 'public_learning_catalog', {}, token)).individual
            ? ['textbook'] : ['textbook', 'institution'];
        }
        await this.requireScope(scope);
        if (sequence !== this.sequence) return [];
        const due = dueReviews(sharedRecords(account)).filter(r => /^[0-9a-f-]{36}$/i.test(r.id));
        const nodes: Node[] = [{ kind: 'progress', account }, ...(due.length ? [{ kind: 'reviews' as const, account, due }] : []),
          ...(courses.length ? courses.map(course => ({ kind: 'course' as const, course, languages, pools, ...scope }))
            : [{ kind: 'notice' as const, label: 'No courses yet. Browse the catalog to get started.' }])];
        // The catalog, pricing and purchases are one page, also in this view's title bar.
        return [...nodes, ...projects, { kind: 'notice', label: 'Saved Practice notebooks', command: 'dhimantai.practiceHistory' },
          { kind: 'notice', label: 'My certificates', command: 'dhimantai.courseGrade', args: ['__certificates__'] },
          { kind: 'notice', label: 'Course Catalog · courses & pricing', command: 'dhimantai.courseCatalog' }];
      }
      if (node.kind === 'course' || node.kind === 'chapter') await this.requireScope(node);
      if (node.kind === 'topic' || node.kind === 'pool') await this.requireScope(node.parent);
      switch (node.kind) {
        case 'course': return [...node.course.chapters.map(chapter => ({
          kind: 'chapter' as const, chapter, course: node.course.name, languages: node.languages, pools:node.pools,
          account: node.account, environment: node.environment,
        })), {kind:'courseGrade',course:node.course.name,account:node.account,environment:node.environment}];
        case 'reviews': return node.due.map(problem => ({ kind: 'review', account: node.account, problem }));
        case 'chapter': {
          if (node.chapter.locked) return [];
          const pools = node.pools ?? ['textbook'];
          const sources = await Promise.allSettled(pools.map(pool => this.scopedApi(node).practiceQuestions(node.chapter.id, pool)));
          await this.requireScope(node);
          if (sequence !== this.sequence) return [];
          const children: Node[] = [];
          sources.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              if (result.value.questions.length) children.push({kind:'pool',parent:node,pool:pools[index],questions:result.value.questions});
            } else children.push({kind:'notice', label:`${pools[index] === 'textbook' ? 'Textbook' : 'Institution'} questions could not be loaded. Retry.`,command:'dhimantai.refreshPractice'});
          });
          children.push({kind:'generate',parent:node});
          return children;
        }
        case 'pool': {
          const questions = node.questions ?? (await this.scopedApi(node.parent).practiceQuestions(node.parent.chapter.id, node.pool)).questions;
          await this.requireScope(node.parent);
          if (sequence !== this.sequence) return [];
          const topics = new Map<string, PracticeQuestion[]>();
          for (const q of questions) {
            const name = q.topic || 'Chapter exercises';
            const group = topics.get(name);
            if (group) group.push(q);
            else topics.set(name, [q]);
          }
          return topics.size ? [...topics].map(([name, questions]) => ({kind: 'topic', parent: node.parent, name, questions}))
            : [{ kind: 'notice', label: 'No published exercises in this source.' }];
        }
        case 'topic': {
          // Easiest first, so each exercise builds on the last.
          const ordered = byDifficulty(node.questions);
          return ordered.map(question => ({ kind: 'question', parent: node.parent, question, siblings: ordered }));
        }
        default: return [];
      }
    } catch (error) {
      if (sequence !== this.sequence) return [];
      const message = !node && error instanceof ApiError && [404, 410].includes(error.status)
        ? 'Practice browsing is unavailable on this service. Check the DhimantAI environment and backend version.'
        : error instanceof Error ? error.message : 'Could not load Practice.';
      // An ended access period is bought again from the catalog.
      const expired = error instanceof ApiError && error.status === 403;
      return [...projects, { kind: 'notice', label: message, ...(expired ? {command: 'dhimantai.courseCatalog'} : {}) },
        { kind: 'notice', label: 'Retry loading Practice', command: 'dhimantai.refreshPractice' },
        ...(!node ? [{ kind: 'notice' as const, label: 'Saved Practice notebooks', command: 'dhimantai.practiceHistory' }] : [])];
    }
  }

  async openCourse(node: Extract<Node, {kind:'course'}>) {
    if (node?.kind !== 'course') {
      await vscode.commands.executeCommand('dhimantai.practice.focus');
      return;
    }
    if (!this.containers?.enabled) return;
    await this.requireScope(node);
    await this.containers.enter({course:node.course.name, account:node.account, environment:node.environment});
  }

  private async workstationScope(target?: string | vscode.Uri | Extract<Node, {kind: 'course'}>): Promise<CourseScope | undefined> {
    if (!this.containers?.enabled) throw new Error('The course container is unavailable. Set up the course runtime before running.');
    if(typeof target==='string') {
      const account=(await this.auth.session()??await this.auth.signIn())?.user.id;if(!account)return;
      const scope={account,environment:this.environment()};
      const {courses}=await this.scopedApi(scope).practiceCatalog();await this.requireScope(scope);
      if(!courses.some(c=>c.name===target))throw new Error('This course is not available to your account. Open its catalog entry and check access.');
      return {...scope,course:target};
    }
    if (target && 'kind' in target && target.kind === 'course') {
      await this.requireScope(target);
      return { course: target.course.name, account: target.account, environment: target.environment };
    }
    const files = target instanceof vscode.Uri ? [target] : [vscode.window.activeNotebookEditor?.notebook.uri,
      vscode.window.activeTextEditor?.document.uri, ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)];
    const record = files.flatMap(file => file ? [this.containers!.recordFor(file)] : []).find(Boolean);
    if (record) { await this.requireScope(record); return record; }
    const account = (await this.auth.session() ?? await this.auth.signIn())?.user.id;
    if (!account) return;
    const scope = {account, environment: this.environment()};
    const {courses} = await this.scopedApi(scope).practiceCatalog();
    await this.requireScope(scope);
    if (!courses.length) throw new Error('Join a course from Browse Course Catalog before setting up its workstation.');
    const selected = await vscode.window.showQuickPick(courses.map(course => ({label: course.name})), {
      title: 'Course workstation', placeHolder: 'Choose the course container to prepare'
    });
    if (!selected) return;
    await this.requireScope(scope);
    return {...scope, course: selected.label};
  }

  async setupCourse(target?: string | vscode.Uri | Extract<Node, {kind: 'course'}>) {
    const scope = await this.workstationScope(target);
    if (!scope) return;
    const engine = await this.containers!.setup(scope);
    void vscode.window.showInformationMessage(`${scope.course} workstation ready. Course packages and code execution verified.`);
    return vscode.Uri.file(engine.root);
  }

  async newCourseNotebook() {
    const scope = await this.workstationScope();
    if (!scope) return;
    const engine = await this.containers!.setup(scope);
    await vscode.commands.executeCommand('dhimantai.openLearningRoom', vscode.Uri.file(engine.root));
  }

  async courseTerminalOptions(target?: vscode.Uri) {
    const scope = await this.workstationScope(target);
    if (!scope) return;
    const root = await this.containers!.courseFolder(scope);
    const candidates = target ? [target] : [vscode.window.activeNotebookEditor?.notebook.uri,
      vscode.window.activeTextEditor?.document.uri, ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)];
    const current = candidates.find(uri => uri && this.containers!.recordFor(uri)?.root === root.fsPath);
    return this.containers!.terminalOptions(current ?? root);
  }

  async openCourseTerminal(target?: vscode.Uri) {
    const options = await this.courseTerminalOptions(target);
    if (options) {
      const root = vscode.Uri.file(options.cwd as string);
      await this.containers!.terminal(root);
      return root;
    }
  }

  async openCourseColab(node?: Extract<Node, {kind:'course'}>) {
    if (!node || node.kind !== 'course') {
      const courses = (await this.getChildren()).filter((row): row is Extract<Node, {kind:'course'}> =>
        row.kind === 'course' && hasColabLabs(row.course.name));
      if (!courses.length) {
        await vscode.commands.executeCommand('dhimantai.courseCatalog');
        void vscode.window.showInformationMessage('Join Inference Engineering or Build an LLM from Scratch, then choose Open Course with Colab Runtime.');
        return;
      }
      if (courses.length === 1) node = courses[0];
      else {
        const selected = await vscode.window.showQuickPick(courses.map(course => ({label: course.course.name, course})),
          {title: 'Choose a course for Colab'});
        if (!selected) return;
        node = selected.course;
      }
    }
    await this.requireScope(node);
    await this.containers?.enterColab({course:node.course.name, account:node.account, environment:node.environment});
  }

  async openCopyInCourse(doc = vscode.window.activeNotebookEditor?.notebook) {
    if (!doc || doc.isClosed || doc.uri.scheme !== 'file' || doc.notebookType !== 'jupyter-notebook')
      throw new Error('Save and open a local .ipynb notebook first.');
    if (!this.containers?.enabled) throw new Error('Set up the course container before opening this notebook.');
    if (this.containers.recordFor(doc.uri)) {
      await vscode.window.showNotebookDocument(doc, {viewColumn: vscode.ViewColumn.One, preview: false});
      await vscode.commands.executeCommand('notebook.selectKernel', { id: 'dhimantai-course', extension: 'optficial.dhimantai-learning' });
      return;
    }
    const account = (await this.auth.session() ?? await this.auth.signIn())?.user.id;
    if (!account) return;
    const scope = {account, environment: this.environment()};
    const metadata = jupyterMetadata(doc);
    if (metadata.dhimantai_coach?.environment && metadata.dhimantai_coach.environment !== scope.environment)
      throw new Error('Select the same DhimantAI environment as this notebook before opening it in a course.');
    const {courses, languages} = await this.scopedApi(scope).practiceCatalog();
    const language = metadata.kernelspec?.language;
    if (!languages.some(l => l.id === language)) throw new Error('This notebook language is unavailable in the course runtime.');
    if (!courses.length) throw new Error('No Practice courses are available for this account.');
    const course = await vscode.window.showQuickPick(courses.map(c => c.name), {title: 'Open Copy in Course', placeHolder: 'Choose the matching course for this notebook'});
    if (!course || doc.isClosed) return;
    await this.requireScope(scope);
    if (doc.isDirty) {
      const save = 'Save and copy';
      const choice = await vscode.window.showInformationMessage('Save your current edits before copying this notebook into the course?', {modal: true}, save);
      if (choice !== save || !await doc.save()) return;
    }
    const notebook = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
    await this.containers.enter({...scope, course}, {kind: 'notebook', language, notebook});
  }

  async openQuestion(node: Extract<Node, {kind: 'question'}>) {
    await this.requireScope(node.parent);
    // The notebook names the next exercise in this topic after a graded pass.
    rememberTopic((node.siblings ?? [node.question]).filter(q => q.kind !== 'written'), node.parent.course);
    if (node.question.kind === 'written') {
      await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', node.question.id, node.parent.account,
        node.parent.course, undefined, undefined, node.question.title, 'written');
      return;
    }
    await vscode.commands.executeCommand('dhimantai.openExercise', node.question.id, node.parent.account, node.parent.course, node.question.title);
  }

  async generate(node: ChapterNode) {
    await this.requireScope(node);
    if (node.chapter.locked) { await vscode.commands.executeCommand('dhimantai.pricing'); return; }
    if (!vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true)) {
      throw new Error('Turn on AI assistance in DhimantAI settings to generate an exercise.');
    }
    const language = await vscode.window.showQuickPick(node.languages.map(l => ({label: l.name, id: l.id})),
      { title: node.chapter.name, placeHolder: 'Choose the programming language' });
    if (!language) return;
    const difficulty = await vscode.window.showQuickPick(['Easy', 'Medium', 'Hard'],
      { title: node.chapter.name, placeHolder: 'Choose the exercise difficulty' });
    if (!difficulty) return;
    const focus = await vscode.window.showInputBox({ title: 'Generate an exercise', prompt: 'Optional focus. Press Enter to use the chapter.',
      placeHolder: 'For example, indexing lists', validateInput: text => [...text.trim()].length > 200 ? 'Use up to 200 characters.' : undefined });
    if (focus === undefined) return;
    await this.requireScope(node);
    const api = this.scopedApi(node);
    const exercise = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Generating your practice exercise…'},
      () => api.generateExercise(node.chapter.id, language.id, difficulty.toLowerCase(), focus.trim()));
    await this.requireScope(node);
    await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', '', node.account, node.course, exercise);
  }
}

export function exerciseNotebook(result: GeneratedExercise, environment: EnvironmentName): vscode.NotebookData {
  const { exercise, course, chapter, language, kernel, difficulty } = result;
  const question = [exercise.title, exercise.task, 'Example input', exercise.example_input,
    'Expected output', exercise.expected_output].join('\n\n');
  const text = (s: string) => new vscode.MarkdownString()
    .appendText(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).value.replace(/&nbsp;/g, ' ');
  const literal = (s: string) => s.split(/\r?\n/).map(line => '    ' + line).join('\n');
  const brief = [`# ${text(exercise.title)}`, text(`${course} · ${chapter} · ${difficulty} · AI-generated practice`),
    text(exercise.task), '### Example input', literal(exercise.example_input), '### Expected output', literal(exercise.expected_output),
    'Write your solution in the code cell. Run the cell to try it, then save your work.'].join('\n\n');
  const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, brief, 'markdown'),
    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', language)]);
  data.metadata = { nbformat: 4, nbformat_minor: 5, metadata: {
    kernelspec: { name: kernel, display_name: language, language },
    language_info: { name: language },
    dhimantai_coach: { version: 1, environment, path: '/notebook-coach/tutor', question },
  } };
  return data;
}
