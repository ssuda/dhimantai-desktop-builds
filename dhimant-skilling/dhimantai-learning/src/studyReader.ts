import type { CopilotPolicy } from './copilotPolicy';
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { Auth } from './auth';
import { Api } from './api';
import { trustedRoomUrl } from './coachAudio';
import { Environment, EnvironmentName } from './environments';
import { CompanionCourse, readingCursor, readingFontSize, readingUrl, StudyChoice, StudySource } from './studyContent';
import { studyHtml } from './studyHtml';
import { downloadStudyDocument } from './studyDocument';

export async function registerStudyReader(context: vscode.ExtensionContext, auth: Auth,
    environment: () => EnvironmentName, service: () => Environment, copilot?: CopilotPolicy) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const companions: CompanionCourse[] = [];
  let panel: vscode.WebviewPanel | undefined, epoch = 0, generation = 0, selection = '';
  let choices: StudyChoice[] = [], account: string | undefined, env = environment(), backend = service();
  let loading = new AbortController();
  let active: {source: StudySource; key: string; progressKey: string} | undefined;
  let initialized = false;
  let sessionKey = '', fontSize = '100%';
  const saveSession = () => context.globalState.update(sessionKey, {chapterId:selection, fontSize});
  let selectCopilotCourse: ((course?: string) => Promise<void>) | undefined;
  const cancel = () => { loading.abort(); loading = new AbortController(); generation++; };
  const send = (message: object) => panel?.webview.postMessage(message);
  const fail = (error: unknown) => error instanceof Error ? error.message : 'Study is unavailable. Please retry.';
  const api = () => new Api(auth, () => {
    if (env !== environment()) throw new Error('Your service changed. Reopen Study.');
    return backend;
  }, account);
  async function load(id: string) {
    if (!initialized || !choices.some(c => c.chapters.some(ch => ch.id === id))) return;
    cancel(); const current = generation, owner = epoch, signal = loading.signal;
    active = undefined; selection = id;
    await selectCopilotCourse?.();
    await send({type:'loading'});
    try {
      const source = await api().studyChapter(id, signal);
      if (owner !== epoch || current !== generation || signal.aborted) return;
      if (!source.document) throw new Error('This chapter has no PDF or EPUB for Study. Refresh your courses.');
      const bytes = await downloadStudyDocument(source.document, signal, backend.apiUrl);
      if (owner !== epoch || current !== generation || signal.aborted) return;
      const key = createHash('sha256').update([env, backend.apiUrl, account ?? 'guest', source.id, source.revision].join('\0')).update(bytes).digest('hex');
      active = {source, key, progressKey:'studyPosition:' + key};
      await selectCopilotCourse?.(choices.find(c => c.chapters.some(ch => ch.id === id))?.title);
      if (owner !== epoch || current !== generation || signal.aborted) return;
      await saveSession();
      if (owner !== epoch || current !== generation || signal.aborted) return;
      await send({type:'chapter', source, documentKey:key,
        courseId:choices.find(course => course.chapters.some(chapter => chapter.id === id))?.id,
        bookData:bytes.toString('base64'), fontSize,
        cursor:readingCursor(context.globalState.get(active.progressKey)),
        signedIn:!!account, aiEnabled:!!account && !!source.markdown.trim() && vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true)});
    } catch (error) {
      if (owner === epoch && current === generation && !signal.aborted) await send({type:'error', message:fail(error)});
    }
  }
  async function initialize() {
    cancel(); const owner = ++epoch;
    active = undefined; initialized = false;
    await selectCopilotCourse?.();
    const user = await auth.session();
    if (owner !== epoch || !panel) return;
    account = user?.user.id; env = environment(); backend = service();
    sessionKey = 'studySession:' + createHash('sha256').update([env, backend.apiUrl, account ?? 'guest'].join('\0')).digest('hex');
    const saved = context.globalState.get<{chapterId?:unknown;fontSize?:unknown}>(sessionKey);
    fontSize = readingFontSize(saved?.fontSize);
    const requested = selection || (typeof saved?.chapterId === 'string' ? saved.chapterId : '');
    selection = requested;
    choices = [];
    initialized = true;
    await send({type:'catalog', courses:choices, signedIn:!!account,
      notice:account ? 'Loading available PDF and EPUB books…' : 'Sign in to read your course PDFs and EPUBs.'});
    if (!account) { await send({type:'empty',message:'Sign in to read your course PDFs and EPUBs.'}); return; }
    try {
      const catalog = await api().studyCatalog();
      if (owner !== epoch) return;
      choices = catalog.courses.map(c => ({...c, chapters:c.chapters.filter(ch => ['pdf','epub'].includes(ch.format))})).filter(c => c.chapters.length);
      const chosen = choices.find(c => c.id === requested || c.title === requested || c.chapters.some(ch => ch.id === requested));
      const chapter = chosen?.chapters.find(ch => ch.id === requested) ?? chosen?.chapters[0] ?? (!requested ? choices[0]?.chapters[0] : undefined);
      const notice = chapter ? '' : 'No PDF or EPUB is available for this selection. Choose another course.';
      await send({type:'catalog', courses:choices, selected:chapter?.id, signedIn:true, notice});
      if (chapter) await load(chapter.id);
      else await send({type:'empty',message:notice});
    } catch {
      if (owner === epoch) await send({type:'error', message:'Available PDF and EPUB books could not be loaded. Reopen Study to retry.'});
    }
  }
  async function handle(message: any) {
    if (message?.type === 'ready') return initialize();
    if (message?.type === 'choose' && typeof message.id === 'string') return load(message.id);
    if (message?.type === 'chooseCourse') {
      const owner = epoch, current = generation;
      const picked = await vscode.window.showQuickPick(choices.map(course => ({
        label: course.title, description: `${course.chapters.length} chapters`, course,
      })), {title:'Choose a Study course', placeHolder:'Search courses by name', matchOnDescription:true});
      if (picked && owner === epoch && current === generation && panel) await load(picked.course.chapters[0]?.id);
      return;
    }
    if (message?.type === 'signIn') return vscode.commands.executeCommand('dhimantai.signIn');
    const target = active;
    if (!target || message?.documentKey !== target.key) return;
    if (message.type === 'position') {
      const cursor = readingCursor(message.cursor);
      if (cursor) await context.globalState.update(target.progressKey, cursor);
      return;
    }
    if (message.type === 'fontSize') {
      fontSize = readingFontSize(message.fontSize);
      await saveSession();
      return;
    }
    if (message.type === 'link' && typeof message.url === 'string' && readingUrl(message.url)) {
      const links = [...target.source.reading.map(link => link.url),
        ...Array.from(target.source.markdown.matchAll(/\]\((https:\/\/[^\s)]+)\)/g), m => m[1])];
      if (links.includes(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }
    if (message.type !== 'studyConnect' || typeof message.requestId !== 'string' || message.requestId.length > 80 || !account
        || !vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true)) return;
    const owner=epoch;
    try {
      const grant=await api().learningRoom('study');
      if(active!==target||owner!==epoch)return;
      if(!trustedRoomUrl(env,grant.url))throw new Error('Unexpected LiveKit service.');
      await send({type:'studyGrant',documentKey:target.key,requestId:message.requestId,grant});
    } catch(error) {
      if(active===target&&owner===epoch)await send({type:'helpError',documentKey:target.key,requestId:message.requestId,message:fail(error)});
    }
  }

  function html(view: vscode.Webview) {
    const asset = (path: string) => view.asWebviewUri(vscode.Uri.joinPath(media,path));
    const nonce = randomBytes(16).toString('hex');
    view.html = studyHtml(asset, view.cspSource, nonce);
  }

  function open(target?: unknown) {
    if (panel && typeof target !== 'string') { panel.reveal(); return; }
    selection = typeof target === 'string' ? target : '';
    if (!panel) {
      panel = vscode.window.createWebviewPanel('dhimantai.study', 'dhimantAI Study', vscode.ViewColumn.One,
        {enableScripts:true, retainContextWhenHidden:true, localResourceRoots:[media]});
      selectCopilotCourse = copilot?.bindPanel(panel);
      panel.onDidDispose(() => { cancel(); epoch++; panel = undefined; active = undefined; initialized = false; });
      panel.webview.onDidReceiveMessage(message => { void handle(message).catch(error => send({type:'error', message:fail(error)})); });
      panel.onDidChangeViewState(e => { void send({type:'visibility',visible:e.webviewPanel.visible}); });
      html(panel.webview);
    } else { panel.reveal(); void initialize(); }
  }
  const reset = () => { void selectCopilotCourse?.(); cancel(); epoch++; selection = ''; active = undefined; initialized = false; if (panel) html(panel.webview); };
  const subscriptions = [vscode.commands.registerCommand('dhimantai.openStudy', open), auth.onDidChange(reset),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.environment') || e.affectsConfiguration('dhimantai.aiAssistance')) reset(); })];
  return {companions, dispose() { cancel(); epoch++; panel?.dispose(); subscriptions.forEach(s => s.dispose()); }};
}
