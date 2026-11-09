import type { CopilotPolicy } from './copilotPolicy';
import {cellCompletions} from './cellCompletion';
import { NotebookDebugger } from './notebookDebugger';
import { learnerTests, skillStages } from './skillPractice';
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TutorNotebookStore } from './tutorNotebookStore';
import { emptyNotebook, importNotebook, serializeNotebook, NOTEBOOK_FILE_LIMIT, NOTEBOOK_FORMAT_HELP, readNotebook, TutorNotebook } from './tutorNotebook';
import { replyChoices, quickReplies, practiceStrategy, notebookHelpActions } from './practiceConversation';
import { NotebookCells } from './notebookCells';
import { cellLanguages } from './roomCode';
import { practiceContext, generatedPractice, practiceDocument, savedPractice, PracticeNotebook } from './practiceNotebook';
import type { Course, GeneratedExercise } from './api';
import { Api } from './api';
import { desktopRoom } from './desktopRoom';
import { Auth } from './auth';
import { audioPolicy, trustedRoomUrl, audioControls, CoachAudio, SpokenReply } from './coachAudio';
import { learningComposer } from './learningComposer';
import { sharedNotebookContext } from './notebookContext';
import { Environment, EnvironmentName } from './environments';
import { CourseWorkspaces } from './courseWorkspace';
import { makeVariation, newVariationSeed } from './learningLoop';
import { exportRecords, HelpEvent, MAX_HELP_LEVEL, nextLevel, ProblemRecord, record, trend, trendText, validRecords } from './helpRecord';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { RoomCodeSession, validCodeAction, validSnapshot } from './roomCode';
import { practiceAttachments } from './practiceAttachments';
import { openWrittenPractice } from './writtenPractice';
import { fallbackFolder, openPracticeFile } from './practiceInNotebook';
import { PRACTICE_KERNEL } from './practiceKernel';

const html = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]!));

export function registerLearningRoom(context: vscode.ExtensionContext, environment: () => EnvironmentName, service: () => Environment, auth: Auth, courses?: CourseWorkspaces, copilot?: CopilotPolicy) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const notebookDirectory = join(context.globalStorageUri.fsPath, 'tutor-notebooks');
  // How much help each Practice problem took, per account, on this computer only (src/helpRecord.ts).
  const recordKey = (account: string) => 'dhimantai.helpRecords.' + account;
  const records = (account: string) => validRecords(context.globalState.get(recordKey(account)));
  const note = async (account: string, event: HelpEvent) => {
    const next = record(records(account), event);
    await context.globalState.update(recordKey(account), next);
    return next;
  };
  const helpState = (all: ProblemRecord[], id: string) => {
    const {level, waiting} = nextLevel(all.find(r => r.id === id));
    return {type: 'helpState', next: level, waiting, max: MAX_HELP_LEVEL, trend: trendText(trend(all))};
  };
  type Mode = 'tutor' | 'doubt_solver';
  const notebooks = new Map<Mode | 'practice', {panel: vscode.WebviewPanel; exercise?: string}>();
  const updateNotebookContext = () => vscode.commands.executeCommand('setContext', 'dhimantai.tutorNotebookOpen',
    [...notebooks.values()].some(({panel}) => panel.visible));
  const closeNotebooks = () => { for (const {panel} of [...notebooks.values()]) panel.dispose(); };
  function open(practice?: PracticeNotebook, initialCourse?: vscode.Uri, initialMode: Mode = 'tutor') {
    const key = practice ? 'practice' : initialMode;
    const existing = notebooks.get(key);
    if (existing && existing.exercise === practice?.id
        && (!practice || existing.panel.title === 'Practice notebook · ' + practice.title)) {
      // Revealing a retained webview keeps its lesson, draft, runtime and live session intact.
      existing.panel.reveal();
      return;
    }
    existing?.panel.dispose();
    const name = environment(), backend = service();
    let courseFile = initialCourse ?? (practice ? (practice.runtimeFile ? vscode.Uri.file(practice.runtimeFile) : undefined) : [vscode.window.activeNotebookEditor?.notebook.uri, vscode.window.activeTextEditor?.document.uri,
      ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)]
      .find(uri => uri && courses?.recordFor(uri)));
    const courseName = courseFile && courses?.recordFor(courseFile)?.course;
    const host = vscode.window.createWebviewPanel('dhimantai.learningRoom', practice ? 'Practice notebook · ' + practice.title : initialMode === 'doubt_solver' ? 'Doubt Solver notebook' : 'Instructor notebook', vscode.ViewColumn.One,
      {enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true});
    notebooks.set(key, {panel:host, exercise:practice?.id});
    const selectCopilotCourse = copilot?.bindPanel(host, practice?.course, practice?.assistance ?? true);
    const ownsPanel = () => notebooks.get(key)?.panel === host;
    void vscode.commands.executeCommand('dhimantai.hideCoach');
    if (vscode.env.appName !== 'dhimantAI') void vscode.commands.executeCommand('dhimantai.practice.focus', {preserveFocus:true});
    // Older VS Code versions render the legacy sidebar as an adjacent editor tab.
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs)
      if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('dhimantai.coach'))
        void vscode.window.tabGroups.close(tab, true);
    const view = host.webview, nonce = randomBytes(16).toString('base64');
    const asset = (path: string) => view.asWebviewUri(vscode.Uri.joinPath(media, path));
    const origin = new URL(backend.apiUrl).origin;
    let notebook = emptyNotebook(), store: TutorNotebookStore | undefined, documentKey = '', documentAccount = '';
    let savedSequence = 0;
    let lessonCourses: Course[] = [], lessonAccount = '';
    let notebookWrites = Promise.resolve();
    const courseEngine = async (language: string) => {
      if (!courses?.enabled) throw new Error('Set up the course container before running.');
      if (!courseFile) courseFile = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse');
      if (!courseFile) throw new Error('Choose a course workstation before running code.');
      const engine = await courses.forFile(courseFile, language);
      if (!engine) throw new Error('Set up the course workstation before running code.');
      return engine;
    };
    const cells = new NotebookCells(() => ({}),
      courseEngine, async engine => join(engine!.root, 'notebook-files',
        createHash('sha256').update(name+'|'+documentAccount+'|'+key+'|'+(practice?.id??'')).digest('hex').slice(0,24)));
    let notebookRequest: AbortController | undefined;
    let testEvidence: {snapshot: import('./roomCode').CodeSnapshot; rows: {id:string; verdict:string; stdin:string; expected:string; actual:string; stderr:string}[]} | undefined;
    let revision = 0, account: string | undefined, attempt: number | undefined, codeSession: RoomCodeSession | undefined;
    const aiEnabled = () => (!practice || practice.assistance) && vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true);
    const active = (id: number) => ownsPanel() && name === environment() && revision === id;
    let spokenReply: SpokenReply | undefined;
    const clearAudio = () => { spokenReply = undefined; void view.postMessage({type:'audioOff', audioId:null}); };
    if (practice) {
      const speech = new CoachAudio(context.secrets, () => backend).bind(view, () =>
        ownsPanel() && host.visible && name === environment() && aiEnabled() ? spokenReply : undefined);
      host.onDidDispose(() => speech.dispose());
    }
    const debugging = new NotebookDebugger(media,(snapshot,state) => {
      if (ownsPanel()) void view.postMessage({type:'notebookDebugState',attempt,snippet:snapshot.snippet,revision:snapshot.revision,state});
    });
    host.onDidDispose(() => debugging.dispose());
    const reset = () => { void selectCopilotCourse?.(); clearAudio(); void debugging.stop(); notebookRequest?.abort(); notebookRequest = undefined; testEvidence = undefined; revision++; account = undefined; attempt = undefined; codeSession?.clear(); codeSession = undefined; };
    host.onDidDispose(() => {
      if (ownsPanel()) notebooks.delete(key);
      reset(); cells.restart(); void updateNotebookContext();
    });
    void updateNotebookContext();
    const checkAccount = async () => {
      const prior = account || documentAccount;
      if (prior && (await auth.session())?.user.id !== prior && (account === prior || documentAccount === prior)) {
        reset(); cells.restart(); store = undefined; documentKey = documentAccount = ''; lessonAccount = ''; lessonCourses = []; notebook = emptyNotebook(); void view.postMessage({type: 'signedOut'});
      }
    };
    const credentials = context.secrets.onDidChange(e => {
      if (e.key === 'dhimantai.session.' + name) void checkAccount();
    });
    host.onDidDispose(() => credentials.dispose());
    const settings = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('dhimantai.courseContainers')) {
        testEvidence = undefined; notebookRequest?.abort();
        void debugging.stop(); cells.restart(); codeSession?.clear(); void view.postMessage({type:'runtimeRestarted', runtime:'course'});
      }
      if (event.affectsConfiguration('dhimantai.aiAssistance')) {
        if (!aiEnabled()) clearAudio();
        debugging.invalidate(); codeSession?.clear(); void view.postMessage({type: 'codeSettings', aiEnabled: aiEnabled()});
      }
    });
    host.onDidDispose(() => settings.dispose());
    host.onDidChangeViewState(({webviewPanel}) => {
      void updateNotebookContext();
      if (!webviewPanel.visible) void view.postMessage({type:'audioOff'});
      void view.postMessage({type:'visibility', visible:webviewPanel.visible});
    });
    view.onDidReceiveMessage(async msg => {
      if ((!ownsPanel() && msg?.type !== 'notebookChanged') || name !== environment()) return;
      if (msg?.type === 'ready') {
        await view.postMessage({type:'visibility', visible:host.visible});
        await view.postMessage(practice ? {type:'openPractice'} : {type:'openTutor', mode:initialMode});
        if (courses?.enabled && courseFile) {
          await view.postMessage({type:'workstationState', label:'preparing…'});
          try {
            await courses!.forFile(courseFile, practice?.language);
            await view.postMessage({type:'workstationState', label:'ready'});
          } catch (error) {
            await view.postMessage({type:'workstationState', label:'setup needed', error:error instanceof Error ? error.message : 'Choose Set up / rebuild course to retry.'});
          }
        }
        return;
      }
      if (msg?.type === 'runtime' && ['course', 'terminal', 'setup'].includes(msg.runtime)) {
        if (msg.runtime !== 'terminal') testEvidence = undefined;
        const target = courseFile;
        if (msg.runtime === 'terminal') {
          const root = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.courseTerminal', target);
          if (root && ownsPanel() && name === environment()) courseFile = root;
          return;
        }
        const root = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse', target);
        if (!root || !ownsPanel() || name !== environment()) return;
        courseFile = root; notebookRequest?.abort();
        void debugging.stop(); cells.restart(); codeSession?.clear();
        await view.postMessage({type:'runtimeSelected', runtime:'course'});
        return;
      }
      if (msg?.type === 'tutorLessons' && !practice && initialMode === 'tutor' && Number.isSafeInteger(msg.attempt)) {
        reset();
        const id = revision;
        lessonCourses = []; lessonAccount = '';
        try {
          const user = await auth.session() ?? await auth.signIn();
          if (!user) throw new Error('Sign in to choose a lesson.');
          if (!active(id)) return;
          account = user.user.id;
          const catalog = await new Api(auth, () => backend, user.user.id).practiceCatalog();
          const currentUser = await auth.session();
          if (!active(id) || currentUser?.user.id !== user.user.id) return;
          lessonCourses = catalog.courses; lessonAccount = user.user.id;
          await view.postMessage({type:'tutorLessons', attempt:msg.attempt, courses:lessonCourses, preferredCourse:courseName});
        } catch (error) {
          if (active(id)) await view.postMessage({type:'tutorLessons', attempt:msg.attempt, courses:[],
            error:error instanceof Error ? error.message : 'Could not load lessons. Retry.'});
        }
        return;
      }
      if (msg?.type === 'courseCatalog') { await vscode.commands.executeCommand('dhimantai.courseCatalog'); return; }
      if (msg?.type === 'notebookChanged') {
        // Capture the owning store before an async account check or a mode switch.
        const target = store, owner = documentAccount, key = documentKey;
        if (!target || !owner || msg.documentKey !== key || !Number.isSafeInteger(msg.sequence) || msg.sequence <= savedSequence) return;
        try {
          const value = readNotebook(msg.notebook);
          if (practice && value.exerciseId !== practice.id) throw new Error('This notebook belongs to a different Practice task.');
          savedSequence = msg.sequence;
          notebookWrites = notebookWrites.catch(() => {}).then(async () => {
            if ((await auth.session())?.user.id !== owner) return;
            await target.save(value);
            if (documentKey === key) { notebook = value; await view.postMessage({type:'notebookSaved', documentKey:key}); }
          });
          await notebookWrites;
        } catch (error) {
          if (documentKey === key) await view.postMessage({type:'notebookError', message:error instanceof Error ? error.message : 'Could not save the notebook.'});
        }
        return;
      }
      if (['exportNotebook', 'importNotebook', 'restartRuntime'].includes(msg?.type)) {
        const owner = documentAccount, key = documentKey;
        if (!owner || msg.documentKey !== key || (await auth.session())?.user.id !== owner || documentKey !== key) return;
        try {
          if (msg.type === 'restartRuntime') { testEvidence = undefined; notebookRequest?.abort(); void debugging.stop(); cells.restart(); codeSession?.clear(); await view.postMessage({type:'runtimeRestarted'}); return; }
          if (msg.type === 'exportNotebook') {
            const value = readNotebook(msg.notebook);
            const content = serializeNotebook(value);
            const file = await vscode.window.showSaveDialog({title:'Save Instructor notebook', filters:{'Jupyter notebook':['ipynb']}, saveLabel:'Save notebook'});
            if (file && documentKey === key && (await auth.session())?.user.id === owner)
              await vscode.workspace.fs.writeFile(file, Buffer.from(content));
          } else {
            const files = await vscode.window.showOpenDialog({title:'Open notebook (.ipynb, maximum 12 MiB)', filters:{'Jupyter notebook':['ipynb']}, canSelectMany:false});
            if (!files?.[0] || documentKey !== key) return;
            if ((await vscode.workspace.fs.stat(files[0])).size > NOTEBOOK_FILE_LIMIT) throw new Error('This notebook exceeds the 12 MiB file limit. Save a smaller .ipynb file.');
            const content = await vscode.workspace.fs.readFile(files[0]);
            const value = importNotebook(content, files[0].path.split('/').pop()!.replace(/\.ipynb$/i, ''));
            if (practice && value.exerciseId !== practice.id) throw new Error('Open a notebook saved for this Practice task. To open a standard Jupyter notebook, use Open saved notebook in Instructor.');
            if (practice) value.title = practice.title;
            if ((await auth.session())?.user.id !== owner || documentKey !== key) return;
            await store!.save(value); clearAudio(); notebook = value; documentKey = randomBytes(16).toString('hex'); savedSequence = 0; void debugging.stop(); cells.restart(); codeSession?.clear();
            await view.postMessage({type:'restoreNotebook', documentKey, notebook});
          }
        } catch (error) { if (documentKey === key) await view.postMessage({type:'notebookError', message:error instanceof Error ? error.message : 'Could not save the notebook.'}); }
        return;
      }
      if (msg?.type === 'leave') { reset(); return; }
      if (msg?.type === 'join' && (msg.mode === 'tutor' || msg.mode === 'doubt_solver') && Number.isSafeInteger(msg.attempt)) {
        if (!practice && msg.mode !== initialMode) return;
        reset();
        const id = revision;
        try {
          const user = await auth.session() ?? await auth.signIn();
          if (!user) throw new Error('Sign in to start a learning session.');
          if (!active(id)) return;
          if (practice && user.user.id !== practice.account) throw new Error('Sign in to the account that opened this Practice task.');
          account = user.user.id;
          const lesson = !practice && msg.mode === 'tutor' && lessonAccount === account
            ? lessonCourses.flatMap(course => course.chapters.map(chapter => ({...chapter, course:course.name})))
              .find(chapter => chapter.id === msg.chapterId && !chapter.locked) : undefined;
          if (!practice && msg.mode === 'tutor' && !lesson) throw new Error('Choose an available lesson from your course before starting Instructor.');
          const nextStore = new TutorNotebookStore(notebookDirectory, name, account + (practice ? '\0practice:' + practice.id
            : msg.mode === 'tutor' ? '\0tutor:' + lesson!.id : '\0doubt_solver'));
          await notebookWrites.catch(() => {});
          if (!active(id)) return;
          if (store?.file !== nextStore.file || documentAccount !== account) {
            cells.restart();
            let saved = await nextStore.load();
            if (practice && !saved.exerciseId) { saved = practiceDocument(practice); await nextStore.save(saved); }
            if (practice) saved.title = practice.title;
            if (!active(id)) return;
            store = nextStore; notebook = saved; documentAccount = account; documentKey = randomBytes(16).toString('hex'); savedSequence = 0;
          }
          // Even revisiting the same document restores it after the lesson chooser.
          documentKey = randomBytes(16).toString('hex'); savedSequence = 0;
          await view.postMessage({type:'restoreNotebook', attempt:msg.attempt, documentKey, notebook});
          if (lesson && courses?.enabled) courseFile = await courses.courseFolder({course:lesson.course, account, environment:name});
          if (!active(id)) return;
          const api = new Api(auth, () => {
            if (!active(id)) throw new Error('Session changed.');
            return backend;
          }, account);
          const media = vscode.env.appName === 'dhimantAI' && msg.mode === 'tutor' && !practice;
          let grant = practice ? undefined : await api.learningRoom(msg.mode);
          if (media && grant) grant = await desktopRoom(context.extensionPath, name, backend, account, grant);
          if (!active(id)) return;
          if (grant && !trustedRoomUrl(name, grant.url)) throw new Error('Unexpected LiveKit service.');
          attempt = msg.attempt;
          const owner = account;
          codeSession = new RoomCodeSession({
            current: async () => { const user = await auth.session(); return active(id) && user?.user.id === owner; },
            aiEnabled,
            run: async (snapshot, signal, event) => {
              if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace before running code.');
              return cells.run(snapshot.language,snapshot.source,snapshot.stdin,{signal,event,
                argv:snapshot.argv,files:snapshot.files,interactive:snapshot.interactive,
                ...((practice?.language === 'pglab' || courseFile && courses?.languageFor(courseFile)==='pglab') ? {database:'lab' as const,setup:practice?.dataset} : {}),
                ...(practice?.language === 'sql' ? {setup:practice.dataset} : {})});
            },
            coach: async () => { throw new Error('Ask Instructor in this notebook for feedback.'); },
          });
          const helpRecords = practice ? await note(owner, {type:'open', id:practice.id, title:practice.title, language:practice.language}) : [];
          if (!active(id)) return;
          await selectCopilotCourse?.(practice?.course ?? lesson?.course, practice?.assistance ?? true);
          if (!active(id)) return;
          await view.postMessage({type: practice ? 'practiceReady' : 'grant', attempt: msg.attempt, aiEnabled: aiEnabled(),
            ...(!practice && lesson ? {chapterId:lesson.id} : {}),
            ...(media && lesson ? {media:true, lesson:{subject:lesson.course, name:lesson.name}} : {}),
            ...(practice ? {help:helpState(helpRecords, practice.id)} : {}),
            ...(practice ? {practice:{id:practice.id, language:practice.language, title:practice.title,
              tools:{tests:practice.tests.length, trace:practice.language === 'python'}}} : {}),
            codeRuntime: (courseFile ? courses?.recordFor(courseFile)?.course ?? 'Course' : 'Course') + ' · Podman', ...grant});
        } catch (e) {
          if (active(id)) await view.postMessage({type: 'failed', attempt: msg.attempt,
            message: e instanceof Error ? e.message : 'Could not start the learning room.'});
        }
        return;
      }
      if (msg?.type === 'cellCompletion' && msg.attempt === attempt && Number.isSafeInteger(msg.request)
          && typeof msg.source==='string' && typeof msg.language==='string') {
        try {
          const folder=cells.directory??join(notebookDirectory,'completions',createHash('sha256').update(documentAccount+'|'+key).digest('hex').slice(0,24));
          const items=await cellCompletions(folder,msg.language,msg.source,msg.offset);
          await view.postMessage({type:'cellCompletions',attempt,request:msg.request,items});
        }catch{await view.postMessage({type:'cellCompletions',attempt,request:msg.request,items:[]});}
        return;
      }
      if (msg?.type === 'cellFiles' && msg.attempt === attempt) {
        if(!cells.directory){await vscode.window.showInformationMessage('Run a cell to create this notebook’s files folder.');return;}
        const files=await vscode.window.showOpenDialog({defaultUri:vscode.Uri.file(cells.directory),canSelectMany:false,openLabel:'Open notebook file'});
        if(files?.[0])await vscode.commands.executeCommand('vscode.open',files[0]);
        return;
      }
      if (msg?.type === 'cellControl' && msg.attempt === attempt && codeSession) {
        if (msg.action === 'stop') codeSession.stop();
        else if (msg.action === 'input' && (msg.value === null || typeof msg.value === 'string' && msg.value.length<=4000)) cells.input(msg.value);
        return;
      }
      if (msg?.type === 'notebookDebug' && msg.attempt === attempt && codeSession && validSnapshot(msg.snapshot)
          && Number.isSafeInteger(msg.request) && ['start','open','stop','inspect','import'].includes(msg.action)) {
        const id = revision, owner = account, currentCode = codeSession, snapshot = msg.snapshot;
        const reply = (result:object) => { if (active(id)) void view.postMessage({type:'notebookDebugResult',attempt,request:msg.request,...result}); };
        try {
          if (!owner || (await auth.session())?.user.id !== owner) throw new Error('Your account changed.');
          if (practice && snapshot.language !== practice.language) throw new Error('Use the task’s solution language.');
          currentCode.change(snapshot);
          if (!currentCode.matches(snapshot)) throw new Error('Use the current cell version.');
          const current = async () => active(id) && codeSession === currentCode && currentCode.matches(snapshot) && (await auth.session())?.user.id === owner;
          if (msg.action === 'start') {
            const engine = await courseEngine(snapshot.language);
            if (!await current()) throw new Error('Your notebook changed during debugger setup.');
            await debugging.start(snapshot,engine,{},current);
            reply({});
          } else {
            if (!debugging.owns(snapshot)) throw new Error('Start Debug in VS Code from this cell first.');
            if (msg.action === 'open') { await debugging.open(); reply({}); }
            if (msg.action === 'stop') { await debugging.stop(); reply({}); }
            if (msg.action === 'import') reply({source:await debugging.import(snapshot)});
            if (msg.action === 'inspect') {
              if (!aiEnabled()) throw new Error('AI assistance is off. You can still use the VS Code debugger.');
              reply({evidence:await debugging.inspect(snapshot)});
            }
          }
        } catch (error) { reply({error:error instanceof Error ? error.message : 'Could not complete the debugger action.'}); }
        return;
      }
      // All three notebook modes use the same help contract, evidence and reply handling.
      if (msg?.type === 'notebookTurn' && codeSession && msg.attempt === attempt) {
        const id = revision, currentCode = codeSession, owner = account;
        if (notebookRequest || !aiEnabled() || !validSnapshot(msg.snapshot) || !Number.isSafeInteger(msg.request)) return;
        const abort = new AbortController(); notebookRequest = abort;
        try {
          if (!owner || (await auth.session())?.user.id !== owner || !active(id)) throw new Error('Your account changed.');
          const snapshot = msg.snapshot;
          if (practice && snapshot.language !== practice.language) throw new Error('Select the ' + practice.language + ' solution cell for this task.');
          if (typeof msg.message !== 'string' || msg.message.length > 600 || typeof msg.prediction !== 'string' || msg.prediction.length > 600)
            throw new Error('Keep your request under 600 characters.');
          currentCode.change(snapshot);
          if (!currentCode.matches(snapshot)) throw new Error('Your code changed. Ask again from the current cell.');
          const api = new Api(auth, () => backend, owner);
          const history = Array.isArray(msg.history) ? msg.history.slice(-8).filter((item: any) =>
            item && ['tutor','learner'].includes(item.role) && typeof item.text === 'string').map((item: any) => ({role:item.role,text:item.text.slice(0,1500)})) : [];
          const debuggerState = msg.debugger && msg.stage === 'debug' && msg.submitted !== true
            ? await debugging.currentEvidence(snapshot,msg.debugger.id) : undefined;
          const strategy = practiceStrategy(msg.strategy), action = notebookHelpActions.find(action => action.strategy === strategy);
          const evidence = testEvidence, prior = evidence?.snapshot;
          const currentTests = !!prior && prior.snippet === snapshot.snippet && prior.revision === snapshot.revision
            && prior.source === snapshot.source && prior.stdin === snapshot.stdin && prior.language === snapshot.language;
          const failed = currentTests && evidence?.rows.find(row => row.verdict !== 'passed');
          const publicTest = strategy !== 'by_hand' ? undefined : !currentTests ? {state:evidence ? 'changed' : 'not_run'}
            : failed ? {state:'current', id:failed.id, input:failed.stdin, expected:failed.expected, actual:failed.actual, stderr:failed.stderr, verdict:failed.verdict}
            : {state:'passed'};
          // A ladder request gets at most the next rung this learner has earned here; the server checks again.
          const requested = practice && msg.submitted !== true && Number.isSafeInteger(msg.helpLevel) && msg.helpLevel >= 1 && msg.helpLevel <= MAX_HELP_LEVEL
            ? Math.min(msg.helpLevel, nextLevel(records(owner).find(r => r.id === practice.id)).level) : undefined;
          const path = practice?.path ?? '/notebook-coach/tutor';
          const tokenKey = path + '\0' + (practice?.id ?? documentKey);
          const reply = await api.notebookCoach(path, {stage:msg.submitted === true ? 'review' : requested ? (requested === 2 ? 'steps' : 'guide')
            : skillStages.includes(msg.stage) ? msg.stage : action?.stage ?? 'guide',
            ...(requested ? {help_level:requested} : {}), ladder_token:ladderToken(tokenKey),
            strategy, focus_line:Number.isSafeInteger(msg.focusLine) && msg.focusLine >= 1 && msg.focusLine <= snapshot.source.split('\n').length ? msg.focusLine : null,
            ...(publicTest ? {public_test:publicTest} : {}),
            language:practice?.language ?? snapshot.language, question:practice?.question ?? snapshot.question, source:snapshot.source, stdin:snapshot.stdin,
            ...(sharedNotebookContext(msg.notebookContext) ? {notebook_context:sharedNotebookContext(msg.notebookContext)} : {}),
            message:msg.message, previous:'', error:debuggerState ? '' : msg.run?.stderr ?? '', history,
            ...(msg.submitted !== true && practiceAttachments(msg.attachments).length ? {attachments:practiceAttachments(msg.attachments)} : {}),
            ...(debuggerState ? {debugger:debuggerState} : {}),
            ...(!debuggerState && msg.run ? {observed_run:{...msg.run, ...(msg.prediction ? {prediction:msg.prediction} : {})}} : {}),
          }, AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]));
          if (!active(id) || (await auth.session())?.user.id !== owner) return;
          if (!aiEnabled()) throw new Error('AI assistance is off.');
          if (debuggerState) await debugging.currentEvidence(snapshot,debuggerState.id);
          if (!currentCode.matches(snapshot)) throw new Error('Your code changed while ' + assistantName + ' was replying. Ask again for feedback on the current version.');
          rememberLadderToken(tokenKey, reply.ladder_token ?? ladderToken(tokenKey));
          // A code review is help too: it counts against independent attempts like any other ask.
          const level = requested ? Math.min(requested, Number.isSafeInteger(reply.help_level) ? reply.help_level! : requested) : 0;
          if (practice) {
            const all = await note(owner, level ? {type:'help', id:practice.id, level} : {type:'ask', id:practice.id});
            if (active(id)) await view.postMessage(helpState(all, practice.id));
          }
          const content = [reply.guidance, reply.prompt].filter(Boolean).join('\n\n');
          spokenReply = practice && content ? {id:randomBytes(16).toString('hex'), text:content, account:owner, environment:name, path} : undefined;
          await view.postMessage({type:'notebookReply', attempt, request:msg.request, submitted:msg.submitted === true,
            content, audioId:spokenReply?.id ?? null, choices:replyChoices(reply.choices), replies:quickReplies(reply.replies), strategy:practiceStrategy(reply.strategy ?? strategy), line:reply.line});
        } catch (error) {
          if (active(id)) await view.postMessage({type:'notebookReply',attempt,request:msg.request,
            error:error instanceof Error ? error.message : assistantName + ' could not reply. Try again.'});
        } finally { if (notebookRequest === abort) notebookRequest = undefined; }
        return;
      }
      // Sample tests, step-through and a new input: learning tools that run code, never ask a model.
      if (msg?.type === 'practiceTool' && codeSession && (practice || ['my_tests','test_code'].includes(msg.tool))
          && msg.attempt === attempt && validSnapshot(msg.snapshot)
          && ['tests', 'trace', 'variation', 'my_tests','test_code'].includes(msg.tool) && Number.isSafeInteger(msg.request)) {
        const id = revision, owner = account, snapshot = msg.snapshot, tool: string = msg.tool;
        const reply = (result: object) => { if (active(id)) void view.postMessage({type:'practiceToolResult', attempt, request:msg.request, tool, ...result}); };
        try {
          if (!owner || (await auth.session())?.user.id !== owner) throw new Error('Your account changed.');
          if (practice && snapshot.language !== practice.language) throw new Error('Use the ' + practice.language + ' solution cell for this task.');
          const cases = tool === 'my_tests' ? learnerTests(msg.cases) : practice?.tests ?? [];
          if (tool === 'variation') {
            const sample = snapshot.stdin.trim() ? snapshot.stdin : cases.find(t => t.stdin?.trim())?.stdin ?? '';
            const variation = makeVariation(undefined, newVariationSeed(), [], {files:[], stdin:sample});
            reply({variation:{seed:variation.seed, stdin:variation.stdin ?? '', prompt:variation.prompt, file:variation.file, argv:[]}});
            return;
          }
          if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace before running code.');
          const input = {source:snapshot.source, stdin:snapshot.stdin, argv:snapshot.argv??[], files:snapshot.files??[]};
          const engine = await courseEngine(snapshot.language);
          if (!active(id) || (await auth.session())?.user.id !== owner) return;
          if (tool === 'test_code') {
            const execution = await engine.run(snapshot.language,input);
            if (!active(id) || (await auth.session())?.user.id !== owner) return;
            reply({execution}); return;
          }
          if (tool === 'tests' || tool === 'my_tests') {
            if (!cases.length) throw new Error('This exercise has no sample tests yet.');
            const results = await engine.tests(snapshot.language, input, cases);
            if (!active(id) || (await auth.session())?.user.id !== owner) return;
            const rows = results.map(r => {
              const test = cases.find(t => t.id === r.id);
              const given = test?.kind === 'cli' ? 'Arguments: ' + (test.argv ?? []).join(' ') : test?.kind === 'function' ? 'Call: ' + (test.call ?? '') : test?.stdin ?? '';
              return {id:r.id, verdict:r.verdict, stdin:given.slice(0, 500), expected:(test?.expected ?? '').slice(0, 1000),
                actual:r.actual.slice(0, 1000), stderr:r.stderr.slice(-600)};
            });
            testEvidence = {snapshot:{...snapshot}, rows};
            reply({tests:rows});
            if (tool === 'tests' && practice) {
              const all = await note(owner, {type:'samples', id:practice.id, total:rows.length, passed:rows.filter(r => r.verdict === 'passed').length});
              if (active(id)) await view.postMessage(helpState(all, practice.id));
            }
            return;
          }
          if (snapshot.language !== 'python') throw new Error('Step-through is available for Python.');
          const trace = await engine.trace(input);
          if (trace.execution.status === 'toolchain_missing') throw new Error(trace.execution.stderr);
          if (!trace.steps.length) throw new Error(trace.execution.stderr || 'The program finished before any of your lines ran.');
          reply({trace:{stopped:trace.stopped, error:trace.error, stdout:trace.stdout.slice(0, 4000),
            steps:trace.steps.slice(0, 400).map(s => ({line:s.line, event:s.event, function:s.function, output:s.output,
              locals:Object.fromEntries(Object.entries(s.locals).slice(0, 20).map(([k, v]) => [k, String(v).slice(0, 200)])),
              ...(s.exception ? {exception:s.exception.slice(0, 300)} : {})}))}});
        } catch (error) { reply({error:error instanceof Error ? error.message : 'Could not run this tool. Try again.'}); }
        return;
      }
      if (msg?.type === 'codeChanged' && msg.attempt === attempt && validSnapshot(msg)) debugging.invalidate(msg);
      if ((msg?.type === 'codeChanged' || msg?.type === 'codeAction') && msg.attempt === attempt && codeSession) {
        const currentCode = codeSession, id = revision, owner = account;
        const user = await auth.session();
        if (!active(id) || codeSession !== currentCode) return;
        if (!owner || user?.user.id !== owner) { reset(); void view.postMessage({type: 'signedOut'}); return; }
        if (msg.type === 'codeChanged' && validSnapshot(msg)) currentCode.change(msg);
        if (validCodeAction(msg) && msg.action === 'run') {
          if (practice) { const all = await note(owner, {type:'run', id:practice.id}); if (active(id)) await view.postMessage(helpState(all, practice.id)); }
          await currentCode.handle(msg, result => { void view.postMessage(result); });
        }
        return;
      }
      if (!account || typeof msg?.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(msg.videoId)) return;
      const videoId: string = msg.videoId;
      if (msg.type === 'checkVideo') {
        const id = revision, url = origin + '/vscode-learning/videos/' + videoId;
        let ok = false;
        try {
          const r = await fetch(url, {method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(12000)});
          ok = r.ok && r.headers.get('X-DhimantAI-Video') === videoId;
        } catch { /* Keep a catalog/network failure local to this card. */ }
        if (!active(id)) return;
        await view.postMessage({type: 'videoChecked', attempt: msg.attempt, videoId, ok, url});
      }
    });
    // A course or Practice task has one language: new cells use it and the picker stays hidden.
    const cellLanguage = practice?.language ?? (courseFile ? courses?.languageFor(courseFile) : undefined);
    const assistantName = initialMode === 'doubt_solver' ? 'Doubt Solver' : 'Instructor';
    view.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${practice ? 'Practice notebook' : initialMode === 'doubt_solver' ? 'Doubt Solver notebook' : 'Instructor notebook'}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${view.cspSource}; style-src ${view.cspSource} 'unsafe-inline'; font-src ${view.cspSource}; img-src data: blob:; media-src blob:; connect-src ${audioPolicy}; frame-src 'self' ${origin}">
<link rel="stylesheet" href="${asset('learning-room/room.css')}"></head><body>
<header class="workspace-header"><div class="workspace-topline"><div class="workspace-title"><span id="notebook-mode" class="eyebrow">DHIMANTAI · ${practice ? 'PRACTICE NOTEBOOK' : initialMode === 'doubt_solver' ? 'DOUBT SOLVER' : 'INSTRUCTOR NOTEBOOK'}</span><h1>${html(practice?.title || courseName || 'Your learning notebook')}</h1></div>
<div class="workspace-actions"><select id="course-runtime" aria-label="Runtime"><option value="course">Course container</option><option value="terminal">Open course terminal</option><option value="setup">Set up / rebuild course</option></select>
<details class="workspace-menu"><summary aria-label="Notebook options" title="Notebook options">⋯</summary><div class="menu-content"><button id="doubt_solver" ${practice ? 'hidden' : ''} aria-pressed="false">Open Doubt Solver</button><hr><button id="save-notebook">Save a copy</button><button id="open-notebook" aria-describedby="notebook-format">Open saved notebook</button><small id="notebook-format">${NOTEBOOK_FORMAT_HELP}</small><button id="restart-runtime">Restart runtime</button><button id="wide" aria-pressed="false">Focus view</button><hr>
<label class="code-follow"><input type="checkbox" id="follow-code" checked> Let ${assistantName} follow code edits and runs</label><label class="code-follow"><input type="checkbox" id="stuck-hints"> Offer hints when I’m stuck</label><small id="code-observer-status" role="status"></small></div></details></div></div>
<div class="workspace-status"><span id="status" role="status">${practice ? 'Opening Practice…' : initialMode === 'doubt_solver' ? 'Connecting to Doubt Solver…' : 'Choose a lesson to learn with Instructor.'}</span><small id="notebook-save-status" role="status">Your notebook stays on this computer.</small><button id="tutor" hidden aria-pressed="false">Retry</button><button id="end" hidden disabled>End session</button></div>
${practice ? '' : '<section id="tutor-lessons" aria-label="Instructor lessons" hidden><label for="lesson-course">Course or subject</label><select id="lesson-course"></select><p>Choose a lesson to learn step by step.</p><div id="lesson-list" role="group" aria-label="Available lessons"></div><button type="button" id="lesson-catalog" class="quiet">Course Catalog</button></section>'}</header>
<div class="notebook-toolbar"><div class="notebook-tools"><div class="add-code-group"><button id="add-code">＋ Code</button><select id="cell-language" aria-label="New code cell language">${Object.entries(cellLanguages).map(([id,label])=>`<option value="${id}"${cellLanguage===id?' selected':''}>${label}</option>`).join('')}</select></div><button id="add-note" class="quiet" title="A private note on this computer. ${assistantName} never sees it unless you share it.">＋ Note</button>${practice ? '<button type="button" id="clear-conversation" disabled>Clear conversation</button>' : ''}<button type="button" id="latest" hidden>Jump to latest</button></div></div>
<main id="feed" role="region" aria-label="Learning notebook" aria-live="polite" tabindex="0"></main>
${!practice && vscode.env.appName === 'dhimantAI' ? '<section id="camera-panel" hidden aria-label="Camera shared with Instructor"><video id="camera-preview" muted autoplay playsinline></video><small>Camera shared with Instructor</small></section>' : ''}
${learningComposer(assistantName, !!practice, practice ? audioControls(view, media, nonce)
  : (vscode.env.appName === 'dhimantAI' ? '<button type="button" id="audio-microphone" disabled aria-pressed="false" aria-label="Start microphone" title="Start microphone"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg></button><button type="button" id="audio-camera" disabled aria-pressed="false" aria-label="Start camera" title="Start camera"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h12v12H3ZM15 10l6-4v12l-6-4"/></svg></button>' : '') + '<button type="button" id="sound" aria-pressed="false" aria-label="Mute speaker">Mute</button>')}
${practice ? '' : `<script nonce="${nonce}" src="${asset('livekit-client.umd.js')}"></script>`}<script nonce="${nonce}" src="${asset('learning-room/room.js')}"></script></body></html>`;
  }
  const subscriptions = vscode.Disposable.from(vscode.commands.registerCommand('dhimantai.openLearningRoom', (course?: vscode.Uri) => open(undefined, course)),
    vscode.commands.registerCommand('dhimantai.openDoubtSolver', () => open(undefined, undefined, 'doubt_solver')),
    vscode.commands.registerCommand('dhimantai.exportPracticeRecord', async () => {
      const user = await auth.session();
      if (!user) { void vscode.window.showInformationMessage('Sign in to export your Practice record.'); return; }
      const target = await vscode.window.showSaveDialog({title:'Export Practice record (counts and times only, no code)',
        defaultUri:vscode.Uri.file(join(homedir(), 'dhimantai-practice-record.json')), filters:{JSON:['json']}});
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(exportRecords(records(user.user.id)), null, 2)));
      void vscode.window.showInformationMessage('Practice record saved. It contains no code, questions or Instructor replies.');
    }),
    vscode.commands.registerCommand('dhimantai.practiceHistory', async () => {
      const session = await auth.session() ?? await auth.signIn();
      if (!session) return;
      const env = environment(), account = session.user.id;
      const history = await TutorNotebookStore.practiceHistory(notebookDirectory, env, account);
      const choices = history.flatMap(({notebook, modified}) => {
        const practice = savedPractice(notebook, account);
        return practice ? [{label:practice.title, description:new Date(modified).toLocaleString(),
          detail:[practice.course, practice.language, 'Saved on this computer'].filter(Boolean).join(' · '), practice}] : [];
      });
      if (environment() !== env || (await auth.session())?.user.id !== account) return;
      if (!choices.length) { void vscode.window.showInformationMessage('No saved Practice notebooks for this account and environment on this computer.'); return; }
      const selected = await vscode.window.showQuickPick(choices, {title:'Saved Practice notebooks', matchOnDescription:true, matchOnDetail:true});
      if (!selected || environment() !== env || (await auth.session())?.user.id !== account) return;
      if (!selected.practice.id.startsWith('generated-')) {
        await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', selected.practice.id, account, selected.practice.course);
        return;
      }
      if (courses?.enabled && selected.practice.course)
        selected.practice.runtimeFile = (await courses.courseFolder({course:selected.practice.course, account, environment:env})).fsPath;
      if (environment() === env && (await auth.session())?.user.id === account) open(selected.practice);
    }),
    vscode.commands.registerCommand('dhimantai.openPracticeNotebook', async (questionId: string, expectedAccount?: string, course?: string, generated?: GeneratedExercise, source?: string, selectedTitle?: string, kind?: 'written') => {
      const session = await auth.session() ?? await auth.signIn();
      if (!session) return;
      if (expectedAccount && session.user.id !== expectedAccount) throw new Error('Sign in with the account that selected this Practice task.');
      const env = environment(), backend = service();
      const api = new Api(auth, () => backend, session.user.id);
      if (!generated && !/^[0-9a-f-]{36}$/i.test(questionId)) throw new Error('Choose a Practice exercise.');
      if (kind === 'written') {
        const task = await api.writtenPractice(questionId);
        if (task.id !== questionId || task.kind !== 'written' || task.preparation !== 'recommended') throw new Error('The service returned a different challenge.');
        if (environment() !== env || (await auth.session())?.user.id !== session.user.id) throw new Error('Your account or service changed.');
        notebooks.get('practice')?.panel.dispose();
        const host = await openWrittenPractice(context,task,api,auth,session.user.id,env,environment,{records,note});
        notebooks.set('practice', {panel:host, exercise:questionId});
        copilot?.bindPanel(host);
        host.onDidDispose(() => {
          if (notebooks.get('practice')?.panel === host) notebooks.delete('practice');
          void updateNotebookContext();
        });
        host.onDidChangeViewState(() => { void updateNotebookContext(); });
        void updateNotebookContext();
        return;
      }
      const practice = generated ? generatedPractice(generated, 'generated-' + randomBytes(12).toString('hex'), session.user.id)
        : practiceContext(await api.workspace(questionId), session.user.id, course, selectedTitle);
      if (environment() !== env || (await auth.session())?.user.id !== session.user.id) throw new Error('Your account or service changed.');
      if (!generated && practice.id !== questionId) throw new Error('The service returned a different Practice task.');
      // Code from an earlier exercise folder starts the solution cell; a saved notebook still wins.
      if (typeof source === 'string' && source.trim() && source.length <= 12000) practice.starter = source;
      const courseName = course || practice.course;
      if (courses?.enabled && courseName) {
        const scope = {course:courseName, account:session.user.id, environment:env};
        practice.runtimeFile = (generated ? await courses.courseFolder(scope) : await courses.exerciseDirectory(scope, questionId)).fsPath;
      }
      // The shared learning notebook is the default; native Jupyter remains an explicit option.
      if (vscode.workspace.getConfiguration('dhimantai').get<string>('practiceEditor', 'panel') === 'notebook') {
        const folder = practice.runtimeFile ? vscode.Uri.file(practice.runtimeFile) : fallbackFolder(context.globalStorageUri, env, session.user.id);
        // Practice always runs in the selected course container.
        const doc = await openPracticeFile(practice, env, folder, PRACTICE_KERNEL);
        await note(session.user.id, {type:'open', id:practice.id, title:practice.title, language:practice.language});
        if (doc.cellCount === 0) throw new Error('The Practice notebook is empty.');
        return;
      }
      if (generated) await new TutorNotebookStore(notebookDirectory, env, session.user.id + '\0practice:' + practice.id).save(practiceDocument(practice));
      if (environment() !== env || (await auth.session())?.user.id !== session.user.id) throw new Error('Your account or service changed.');
      open(practice);
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.environment')) closeNotebooks(); }),
    new vscode.Disposable(closeNotebooks));
  return { dispose: () => subscriptions.dispose(), hasNotebook: () => notebooks.size > 0, help: {records, note} };
}
