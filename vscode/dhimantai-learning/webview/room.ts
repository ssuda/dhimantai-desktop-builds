import type { NativeDebugReply } from '../src/debugEvidence';
import { skillStages, SkillStage } from '../src/skillPractice';
import type { RemoteParticipant, RemoteTrackPublication, Room } from 'livekit-client';
import { diagram } from './diagram';
import { renderBoard, renderHeading } from './markdown';
import { topicTeachBackRequest } from '../src/teachBack';
import { PracticeCodeEditors, ToolReply } from './practiceCodeEditor';
import type { CodeSnapshot, observedRun } from '../src/roomCode';
import { SpeakerControl } from './audioControls';
import { LearningDevices } from './learningDevices';
import { NotebookAttachments } from './notebookAttachments';
import { icon } from './icons';
import { notebookContext } from '../src/notebookContext';
import { emptyNotebook, readNotebook } from '../src/tutorNotebook';
import type { NotebookCell, TutorNotebook } from '../src/tutorNotebook';
import type { Course } from '../src/api';
import { conversationCell, replyChoices, quickReplies, notebookHelpActions, practiceStrategy } from '../src/practiceConversation';
import { HELP_LEVELS } from '../src/helpRecord';
import './room.css';
import './composer.css';
import { bindComposer } from './composer';
import '../media/audioControls.css';

declare const LivekitClient: typeof import('livekit-client');
declare function acquireVsCodeApi(): {postMessage(message: unknown): void};
const host = acquireVsCodeApi(), { RoomEvent } = LivekitClient;
// Spoken replies play only replies this page accepted and showed (see send()).
const spokenReplies = (window as unknown as {installCoachAudio?: (api: typeof host) => {reply(audioId: string | null): void} | undefined}).installCoachAudio?.(host);
type Mode = 'tutor' | 'doubt_solver';
const names = {tutor: 'Instructor', doubt_solver: 'Doubt Solver'};
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => byId<HTMLButtonElement>(id);
const latestButton = button('latest');
const feed = byId('feed'), status = byId('status'), field = byId<HTMLTextAreaElement>('message');
const notebookPage = document.scrollingElement ?? document.documentElement;
const messageBar = document.getElementById('message-bar');
const heading = document.querySelector('.workspace-title h1');
if (heading) heading.innerHTML = renderHeading(heading.textContent ?? '');
let cancelRemoval: (() => void) | undefined;
function confirmRemoval(trigger: HTMLButtonElement, message: string, remove: () => void) {
  cancelRemoval?.();
  const key = documentKey, prompt = document.createElement('div'), text = document.createElement('p');
  prompt.className = 'delete-confirmation'; prompt.setAttribute('role','group'); prompt.setAttribute('aria-label',message);
  text.textContent = message;
  const cancel = document.createElement('button'), confirm = document.createElement('button');
  cancel.type = confirm.type = 'button'; cancel.textContent = 'Cancel'; confirm.textContent = 'Delete'; confirm.dataset.confirmDelete = '';
  const close = () => { prompt.remove(); cancelRemoval = undefined; trigger.focus(); };
  cancel.onclick = close; cancelRemoval = close;
  confirm.onclick = () => { close(); if (key === documentKey && !sending) { remove(); if (!trigger.isConnected) field.focus(); } };
  prompt.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  prompt.append(text,cancel,confirm);
  (trigger.closest('article') ?? trigger.parentElement!).append(prompt); cancel.focus();
}
let attempt = 0, mode: Mode = 'tutor', room: Room | undefined, agent: string | undefined;
let ready = false, sending = false, coaching = false, voice = true, blockedAudio = false, visible = true;
let mediaAllowed = false, mediaBusy = false;
const devices = new LearningDevices({
  current: () => ready && visible && mediaAllowed && mode === 'tutor' && room && agent ? {room, agent} : undefined,
  capture: device => device === 'microphone'
    ? LivekitClient.createLocalAudioTrack({echoCancellation: true, noiseSuppression: true, autoGainControl: true})
    : LivekitClient.createLocalVideoTrack({resolution: {width: 640, height: 480, frameRate: 10}}),
  pause: () => pauseForQuestion(),
  report: message => { status.textContent = message; },
  changed: state => {
    mediaBusy = state.busy;
    for (const [id, active, name] of [['audio-microphone', state.microphone, 'microphone'], ['audio-camera', state.camera, 'camera']] as const) {
      const control = button(id);
      if (!control || !button('audio-camera')) continue;
      control.setAttribute('aria-pressed', String(active));
      control.title = (active ? 'Stop ' : 'Start ') + name;
      control.setAttribute('aria-label', control.title);
      control.disabled = mediaBusy || !ready || !visible || !mediaAllowed || mode !== 'tutor';
    }
    const preview = byId<HTMLVideoElement>('camera-preview');
    if (preview) {
      byId('camera-panel').hidden = !state.camera;
      if (state.cameraTrack) { state.cameraTrack.attach(preview); preview.muted = true; void preview.play().catch(() => {}); }
      else { preview.pause(); preview.srcObject = null; }
    }
  },
});
if (button('audio-camera')) {
  button('audio-microphone').onclick = () => { void devices.toggle('microphone'); };
  button('audio-camera').onclick = () => { void devices.toggle('camera'); };
}
window.addEventListener('pagehide', () => devices.stop());
const audio = new Set<HTMLMediaElement>();
const voiceByMode = new Map<Mode, boolean>();
const speaker = button('sound') ? new SpeakerControl(button('sound'), {
  supported: () => 'setSinkId' in HTMLMediaElement.prototype,
  select: async deviceId => {
    const current = room;
    if (current && !await current.switchActiveDevice('audiooutput', deviceId)) throw new Error('Output unavailable');
    if (room !== current) throw new Error('Session changed');
  },
}) : undefined;
const attachments = new NotebookAttachments(document.getElementById('attachments'), document.getElementById('attachment-status'), controls);
type PlaybackState = 'playing' | 'paused' | 'ended' | 'unavailable';
const videos = new Map<string, {body: HTMLElement; title: string; topic: string; frame?: HTMLIFrameElement; url?: string;
  state?: PlaybackState; seconds?: number; ask?: HTMLButtonElement; resume?: HTMLButtonElement}>();
let activeVideo: string | undefined;
let currentVideo: string | undefined, latestVideoUpdate: Promise<boolean> = Promise.resolve(true);
let pendingPause: {video: string; promise: Promise<boolean>; finish: (ok: boolean) => void} | undefined;
let observationSequence = 0, latestObservation: Promise<unknown> = Promise.resolve();
let lessonScope = '';
let notebook = emptyNotebook(), documentKey = '', restoring = false, cellSequence = 0;
let saveSequence = 0;
let practice: {id:string; language:string; title:string} | undefined;
// The open question the learner chose to ask about instead of answering, and its toggle (created on first use).
let askInsteadOf = '', askInstead: HTMLButtonElement | undefined;
let practiceMode = false;
let lessonCourses: Course[] = [], selectedLesson = '';
function renderLessons() {
  const list = byId('lesson-list'), course = byId<HTMLSelectElement>('lesson-course');
  if (!list || !course) return;
  list.replaceChildren();
  const chapters = lessonCourses.find(item => item.name === course.value)?.chapters ?? [];
  for (const chapter of chapters) {
    const choice = document.createElement('button'); choice.type = 'button';
    choice.textContent = (chapter.lesson || chapter.name) + (chapter.locked ? ' · Locked' : '');
    if (chapter.lesson && chapter.lesson !== chapter.name) choice.title = chapter.name;
    choice.disabled = !!chapter.locked; choice.setAttribute('aria-pressed', String(chapter.id === selectedLesson));
    choice.onclick = () => begin('tutor', chapter.id);
    list.append(choice);
  }
  if (!chapters.length) list.textContent = 'No lessons available. Open Course Catalog to view your courses.';
}
function clearDocument() {
  clearTimeout(saveTimer); documentKey = ''; saveSequence = 0;
  attachments.clear(); askInsteadOf = ''; editors.restartRuntime();
  restoreNotebook(emptyNotebook());
}
function chooseLesson() {
  close('Loading your lessons…'); mode = 'tutor'; selectedLesson = ''; lessonCourses = [];
  const course = byId<HTMLSelectElement>('lesson-course'); if (course) course.replaceChildren();
  clearDocument(); controls(); renderLessons(); button('tutor').hidden = true;
  host.postMessage({type:'tutorLessons', attempt});
}
type NotebookReply = {content?:string; error?:string; audioId?:string | null; choices?:string[]; replies?:string[]; strategy?:string; line?:number};
let notebookCounter = 0, pendingNotebook: {request:number; finish:(reply:NotebookReply) => void} | undefined;
const replyContexts = new Map<string, CodeSnapshot & {skillStage?:SkillStage}>();
const activeSkills = new Map<string, SkillStage>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function snapshotNotebook(): TutorNotebook { return {...notebook, textDraft:field.value, drafts: editors.drafts()}; }
function saveNotebook() {
  if (restoring || !documentKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    host.postMessage({type:'notebookChanged', documentKey, sequence:++saveSequence, notebook:snapshotNotebook()});
  }, 250);
}
function addCell(kind: NotebookCell['kind'], text: string, packet?: Record<string, unknown>) {
  const cell: NotebookCell = {id:'cell-' + Date.now().toString(36) + '-' + ++cellSequence, kind, text, ...(packet ? {packet} : {})};
  notebook.cells.push(cell); renderCell(cell); saveNotebook();
  if (!practice && ready) { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
  return cell;
}
function restoreNotebook(value: TutorNotebook) {
  cancelRemoval?.();
  activeSkills.clear();
  pendingNotebook?.finish({error:'The notebook changed. Ask ' + names[mode] + ' again.'});
  replyContexts.clear();
  restoring = true;
  notebook = readNotebook(value);
  field.value = notebook.textDraft ?? '';
  editors.restore(notebook.drafts); editors.update(ready, attempt);
  feed.replaceChildren();
  for (const cell of notebook.cells) renderCell(cell);
  if (practice && ready && notebook.exerciseId === practice.id) editors.checkpoint('practice:' + practice.id);
  restoring = false; updateLatest();
  controls();
}
function updateConversationCard(cell: NotebookCell, row = feed.querySelector<HTMLElement>(`[data-cell-id="${cell.id}"]`)) {
  const body = row?.querySelector<HTMLElement>(':scope > .conversation-body');
  const toggle = row?.querySelector<HTMLButtonElement>('[data-collapse]');
  if (!body || !toggle) return;
  body.hidden = cell.collapsed === true;
  toggle.textContent = cell.collapsed ? 'Expand' : 'Collapse';
  toggle.setAttribute('aria-expanded', String(!cell.collapsed));
  row!.classList.toggle('is-collapsed', !!cell.collapsed);
}
function removeConversation(cells: NotebookCell[]) {
  if (sending) return;
  const ids = new Set(cells.filter(conversationCell).map(cell => cell.id));
  notebook.cells = notebook.cells.filter(cell => !ids.has(cell.id));
  for (const id of ids) { editors.removeCell(id); feed.querySelector(`[data-cell-id="${id}"]`)?.remove(); replyContexts.delete(id); }
  if (!practiceMode) { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
  saveNotebook(); controls(); updateLatest();
}
function conversationControls(body: HTMLElement, cell: NotebookCell) {
  if (!conversationCell(cell) || (!practiceMode && cell.packet?.is_question_prompt)) return;
  const row = body.parentElement!, label = row.firstElementChild!;
  const header = document.createElement('div'), bar = document.createElement('div');
  header.className = 'conversation-header'; bar.className = 'cell-actions';
  row.prepend(header); header.append(label, bar);
  const preview = document.createElement('span'); preview.className = 'conversation-preview';
  const excerpt = document.createElement('div');
  if (cell.kind === 'board') excerpt.innerHTML = renderBoard(cell.text); else excerpt.textContent = cell.text;
  preview.textContent = (excerpt.textContent ?? '').replace(/\s+/g, ' ').slice(0, 100); row.append(preview);
  body.classList.add('conversation-body'); body.id = cell.id + '-body';
  const collapse = document.createElement('button'); collapse.dataset.collapse = '';
  collapse.setAttribute('aria-controls', body.id);
  collapse.onclick = () => { cell.collapsed = !cell.collapsed; updateConversationCard(cell); saveNotebook(); updateLatest(); };
  const remove = document.createElement('button'); remove.dataset.removeConversation = '';
  remove.title = 'Delete ' + (cell.kind === 'message' ? 'your message' : names[mode] + ' reply');
  remove.setAttribute('aria-label', remove.title);
  remove.innerHTML = icon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>');
  remove.onclick = () => confirmRemoval(remove, 'Delete this message from your saved notebook?', () => removeConversation([cell]));
  bar.append(collapse, remove);
  if ((practiceMode || cell.packet?.notebook_help) && cell.kind === 'board') {
    const actions = document.createElement('div'); actions.className = 'lesson-actions practice-replies';
    const suggestions = quickReplies(cell.packet?.replies), choices = replyChoices(cell.packet?.choices);
    const options = suggestions.length ? suggestions.map(text => [text, text]) : choices.length
      ? choices.map(choice => [choice, 'My answer is: ' + choice])
      : ['Show me where to start', 'I have an idea', 'I am stuck'].map(text => [text, text]);
    const addAction = (label: string, message: string, target: HTMLElement) => {
      const action = document.createElement('button'); action.textContent = label; action.dataset.reply = '';
      action.onclick = () => {
        if (!currentReply(cell)) return;
        const context = replyContexts.get(cell.id);
        void send(message + '\n\nAbout your reply: ' + cell.text.slice(0, 400), false, label, practiceStrategy(cell.packet?.strategy), context?.snippet, context?.skillStage, undefined, true);
      };
      target.append(action);
    };
    for (const [label, message] of options) {
      addAction(label, message, actions);
    }
    if (typeof cell.packet?.line === 'number') {
      const go = document.createElement('button'); go.dataset.reply = ''; go.textContent = 'Go to line ' + cell.packet.line;
      go.onclick = () => { const source = replyContexts.get(cell.id); if (source && currentReply(cell)) editors.focusLine(source.snippet, Number(cell.packet!.line)); };
      actions.prepend(go);
    }
    body.append(actions);
    const stale = document.createElement('p'); stale.className = 'practice-reply-stale muted'; body.append(stale);
  }
  updateConversationCard(cell, row);
}
function currentReply(cell: NotebookCell) {
  const latest = [...notebook.cells].reverse().find(c => c.kind === 'board' && conversationCell(c));
  const prior = replyContexts.get(cell.id), now = prior && (prior.snippet === 'code-0' ? helpContext() : editors.context(prior.snippet))?.snapshot;
  return cell === latest && !!prior && !!now && now.revision === prior.revision
    && now.source === prior.source && now.stdin === prior.stdin && now.language === prior.language;
}
function updateHelpReplies() {
  for (const cell of notebook.cells.filter(c => c.kind === 'board' && conversationCell(c))) {
    const row = feed.querySelector(`[data-cell-id="${cell.id}"]`), current = currentReply(cell);
    for (const action of row?.querySelectorAll<HTMLButtonElement>('[data-reply]') ?? []) action.disabled = !current || sending || !ready || !editors.aiEnabled;
    const stale = row?.querySelector<HTMLElement>('.practice-reply-stale');
    if (stale) { stale.hidden = current; stale.textContent = replyContexts.has(cell.id)
      ? 'Earlier explanation. Ask about your current code or inputs to continue.' : 'Earlier conversation. Ask ' + names[mode] + ' about your current code to continue.'; }
  }
}
function renderCell(cell: NotebookCell) {
  if (cell.kind === 'board') { renderTeaching(cell); return; }
  appendCard(cell.kind === 'note' ? 'Note · only you' : ['message','code'].includes(cell.kind) ? 'You' : 'Instructor', body => {
    body.parentElement?.setAttribute('data-cell-id', cell.id);
    if (cell.kind === 'note') {
      const note = document.createElement('textarea'); note.value = cell.text; note.rows = 4; note.maxLength = 12000;
      note.setAttribute('aria-label','My notes'); note.placeholder = 'A private note. It stays on this computer and is never sent to Instructor.';
      note.oninput = () => { cell.text = note.value; saveNotebook(); };
      // Notes are private by default; sharing one is a separate, deliberate step.
      const share = document.createElement('button'); share.textContent = 'Share with Instructor'; share.className = 'quiet note-share';
      share.title = 'Send this note to Instructor and discuss it'; share.dataset.share = 'note';
      share.onclick = () => { if (note.value.trim()) void send('Discuss my notes with me:\n' + note.value, false, note.value, 'hint'); };
      body.parentElement?.classList.add('note-cell'); body.append(note, share);
    } else if (cell.kind === 'code') editors.add(body, cell.id + ':0', typeof cell.packet?.language === 'string' ? cell.packet.language : 'python', cell.text);
    else if (cell.kind === 'diagram') body.innerHTML = diagram(cell.text);
    else if (cell.kind === 'recap') body.innerHTML = renderBoard(cell.text);
    else if (cell.kind === 'voice') { const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p'); summary.textContent = 'Spoken explanation'; text.textContent = cell.text; details.append(summary, text); body.append(details); }
    else { body.className = 'learner-message'; body.textContent = cell.text; }
    conversationControls(body, cell);
    if (cell.kind === 'code' || cell.kind === 'note') {
      const row = body.parentElement!, header = document.createElement('div'), remove = document.createElement('button');
      header.className = 'cell-header'; header.append(row.firstElementChild!); row.prepend(header);
      remove.type = 'button'; remove.className = 'quiet'; remove.dataset.removeCell = '';
      remove.textContent = cell.kind === 'code' ? 'Delete code cell' : 'Delete note';
      remove.onclick = () => confirmRemoval(remove, remove.textContent + '? This removes its saved content from this notebook.', () => {
        editors.removeCell(cell.id); notebook.cells = notebook.cells.filter(item => item !== cell);
        row.remove(); replyContexts.clear(); activeSkills.clear();
        if (cell.kind === 'code') { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
        saveNotebook(); controls(); updateLatest();
      });
      header.append(remove);
    }
  }, !restoring && nearBottom());
}
const toolReplies = new Map<number, (reply: ToolReply) => void>();
let toolCounter = 0;
const debugReplies = new Map<number, (reply:NativeDebugReply) => void>();
const editors = new PracticeCodeEditors({
  assistant: () => names[mode],
  debug: (snapshot, action) => new Promise<NativeDebugReply>(resolve => {
    const request = ++toolCounter;
    const timer = setTimeout(() => { debugReplies.delete(request); resolve({error:'Debugger request timed out. Check VS Code and retry explicitly.'}); },180000);
    debugReplies.set(request,reply => { clearTimeout(timer); resolve(reply); });
    host.postMessage({type:'notebookDebug',attempt,request,snapshot,action});
  }),
  post: message => {
  if ((message as any)?.type === 'codeChanged' || ((message as any)?.type === 'codeAction' && (message as any)?.action === 'run')) {
    replyContexts.clear(); updateHelpReplies();
  }
  host.postMessage(message);
}, observe: observeCode,
  tool: (snapshot, tool, cases) => new Promise<ToolReply>(resolve => {
    replyContexts.clear(); updateHelpReplies();
    const request = ++toolCounter;
    toolReplies.set(request, resolve);
    host.postMessage({type:'practiceTool', attempt, request, tool, snapshot, cases});
    setTimeout(() => { if (toolReplies.delete(request)) resolve({error:'No result yet. Try again.'}); }, 180000);
  }),
  submit: (text, display) => send(text, false, display), changed: () => { saveNotebook(); updateHelpReplies(); },
  tutor: (snapshot, run, message, prediction, stage, debuggerState) => send('TUTOR_NOTEBOOK_HELP\n' + JSON.stringify({
    cell_id:snapshot.snippet, language:snapshot.language, source:snapshot.source, stdin:snapshot.stdin,
    question:snapshot.question, message, prediction, run:run ?? null, ...(stage ? {stage} : {}), ...(debuggerState ? {debugger:debuggerState,run:null} : {}),
  }), false, message, 'hint')});
editors.follow(byId<HTMLInputElement>('follow-code').checked);

function observeCode(snapshot?: CodeSnapshot, run?: ReturnType<typeof observedRun>, guidance?: string) {
  const live = room, dest = agent, id = attempt;
  if (!ready || !live || !dest) return;
  if (mediaAllowed) {
    // Flutter rooms use the same Instructor but do not expose the extension-only observation RPC.
    byId('code-observer-status').textContent = `Use Ask ${names[mode]} to share a cell from this notebook.`;
    return;
  }
  const shared = notebookContext(notebook.cells, editors.contexts(), snapshot?.snippet);
  const sharing = visible && editors.following && editors.aiEnabled;
  const payload = sharing && snapshot ? {
    sequence: ++observationSequence, notebook:shared, snippet: snapshot.snippet, revision: snapshot.revision,
    language: snapshot.language, source: snapshot.source.slice(0, 4000), question: snapshot.question.slice(0, 1200),
    stdin: snapshot.stdin.slice(0, 600), guidance: (guidance ?? '').slice(0, 1200),
    source_truncated: snapshot.source.length > 4000, input_truncated: snapshot.stdin.length > 600,
    run: run ? {...run, output: run.output.slice(0, 2000), stderr: run.stderr.slice(0, 800),
      incomplete: run.incomplete || run.output.length > 2000 || run.stderr.length > 800} : null,
  } : sharing && shared.cells.length ? {sequence: ++observationSequence, notebook:shared} : {sequence: ++observationSequence, clear: true};
  // LiveKit RPC payloads are byte bounded, including multibyte source and JSON escaping.
  if (sharing && snapshot && typeof payload.source === 'string') while (new TextEncoder().encode(JSON.stringify(payload)).length > 14000) {
    if (payload.source.length) { payload.source = payload.source.slice(0, Math.max(0, payload.source.length - 500)); payload.source_truncated = true; }
    else if (payload.run && payload.run.output.length) { payload.run.output = payload.run.output.slice(0, -500); payload.run.incomplete = true; }
    else if (payload.guidance) payload.guidance = payload.guidance.slice(0, -500);
    else if (payload.question) payload.question = payload.question.slice(0, -200);
    else break;
  }
  // The status describes what was actually sent.
  const assistant = names[mode], unavailable = `Live ${assistant} observation is unavailable. Use Ask ${assistant} to explicitly share this cell.`;
  const shown = 'snippet' in payload ? `${assistant} can see your current snippet, input and latest run.`
    : 'notebook' in payload ? `${assistant} can see your shared notebook cells. Select a code cell to share it.`
    : sharing ? `${assistant} has no notebook cells to follow yet.` : 'Automatic code observation is paused.';
  latestObservation = live.localParticipant.performRpc({destinationIdentity: dest, method: 'on_editor_activity',
    payload: JSON.stringify(payload), responseTimeout: 6000}).then(result => {
      if (id !== attempt || payload.sequence !== observationSequence) return;
      byId('code-observer-status').textContent = result === 'ok' ? shown : unavailable;
    }).catch(() => {
      if (id === attempt && payload.sequence === observationSequence) byId('code-observer-status').textContent = unavailable;
    });
}

function controls() {
  button('doubt_solver').textContent = mode === 'doubt_solver' ? 'Return to Instructor' : 'Open Doubt Solver';
  if (!practiceMode && byId('notebook-mode')) byId('notebook-mode').textContent = 'DHIMANTAI · ' + (mode === 'doubt_solver' ? 'DOUBT SOLVER' : 'INSTRUCTOR NOTEBOOK');
  if (byId('tutor-lessons')) byId('tutor-lessons').hidden = practiceMode || mode !== 'tutor';
  const choosing = !practiceMode && mode === 'tutor' && !selectedLesson;
  if (messageBar) messageBar.hidden = choosing;
  const notebookTools = document.querySelector<HTMLElement>('.notebook-tools');
  if (notebookTools) notebookTools.hidden = choosing;
  if (!practiceMode) {
    const title = document.querySelector('.workspace-title h1');
    const lesson = lessonCourses.flatMap(course => course.chapters).find(chapter => chapter.id === selectedLesson);
    if (title) title.innerHTML = renderHeading(mode === 'doubt_solver' ? 'Ask a specific question' : lesson?.lesson || lesson?.name || 'Choose a lesson');
  }
  byId('composer').hidden = choosing;
  for (const id of ['add-code', 'add-note', 'save-notebook', 'open-notebook']) if (button(id)) button(id).disabled = !documentKey;
  editors.tutorBusy = coaching;
  // Both learning modes own executable cells and share the active public notebook.
  editors.update(ready, attempt);
  if (button('clear-conversation')) button('clear-conversation').disabled = sending || !notebook.cells.some(conversationCell);
  updateHelpReplies();
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-practice-strategy], #practice-help')) action.disabled = sending || !ready || !editors.aiEnabled;
  for (const action of feed.querySelectorAll<HTMLButtonElement>('[data-remove-conversation], [data-remove-cell], [data-confirm-delete]')) action.disabled = sending;
  composerMode();
  byId<HTMLInputElement>('follow-code').disabled = !ready || !editors.aiEnabled || !!practice;
  byId<HTMLInputElement>('stuck-hints').disabled = !ready || mode !== 'tutor' || !editors.aiEnabled || !editors.following || !!practice;
  button('send').disabled = !ready || sending || (!field.value.trim() && !attachments.count) || (!!practice && !editors.aiEnabled);
  attachments.lock(sending);
  for (const id of ['attach-images','attach-pdfs']) if (button(id)) button(id).disabled = !ready || sending || (!!practice && !editors.aiEnabled);
  button('video').disabled = !ready || sending || !!practice;
  button('teach-back').disabled = !ready || sending;
  speaker?.update(!voice || blockedAudio, false, blockedAudio ? 'Enable speaker' : undefined);
  if (button('audio-camera')) for (const id of ['audio-microphone', 'audio-camera']) {
    button(id).disabled = mediaBusy || !ready || !visible || !mediaAllowed || mode !== 'tutor';
  }
}
/** Instructor's latest open written question, answered from the separate message bar. */
function openQuestion(): NotebookCell | undefined {
  if (practice || mode !== 'tutor') return;
  const cell = [...notebook.cells].reverse().find(c => c.kind === 'board' && c.packet?.is_question_prompt);
  const p = cell?.packet;
  if (!p || typeof p.tutor_checkpoint_id !== 'string' || p.tutor_practice_editor || typeof p.student_answer === 'string'
      || p.tutor_checkpoint_id !== editors.activeCheckpoint || p.tutor_checkpoint_id === askInsteadOf) return;
  return cell;
}
function composerMode() {
  if (!askInstead) {
    askInstead = document.createElement('button');
    askInstead.type = 'button'; askInstead.className = 'quiet ask-instead'; askInstead.textContent = 'Ask a question instead';
    askInstead.onclick = () => { const q = openQuestion(); if (q) askInsteadOf = String(q.packet!.tutor_checkpoint_id); controls(); field.focus(); };
    (byId('composer-mode-actions') ?? byId('composer')).prepend(askInstead);
  }
  const question = attachments.count ? undefined : openQuestion(), label = document.querySelector('label[for="message"]');
  const assistant = names[mode];
  if (label) label.textContent = question ? 'Your answer to Instructor' : 'Ask ' + assistant;
  field.placeholder = question ? 'Your answer and reasoning…' : `Ask ${assistant} or reply…`;
  const action = question ? 'Answer Instructor' : 'Ask ' + assistant;
  button('send').title = action + ' (Ctrl/Cmd+Enter)'; button('send').setAttribute('aria-label', action);
  if (byId('send-label')) byId('send-label').textContent = action;
  const context = byId('composer-context');
  if (context) {
    context.hidden = !question;
    context.textContent = question ? 'Replying to: ' + question.text.slice(0, 180) + (question.text.length > 180 ? '…' : '') : '';
  }
  askInstead.hidden = !question;
  for (const hint of feed.querySelectorAll<HTMLElement>('[data-question-hint]'))
    hint.hidden = hint.dataset.questionHint !== question?.packet?.tutor_checkpoint_id;
}
/** The message bar answers Instructor's open question, or asks one. Attachments go with a question. */
async function submitField(): Promise<boolean> {
  if (!ready || sending || (!field.value.trim() && !attachments.count)) return false;
  const question = attachments.count ? undefined : openQuestion();
  if (!question) return send(field.value, true);
  const text = field.value, packet = question.packet!;
  if (!text.trim() || sending) return false;
  const ok = await send('TUTOR_NOTEBOOK_ANSWER\n' + JSON.stringify({checkpoint_id:packet.tutor_checkpoint_id, answer:text}), false, text);
  // Backend question identity remains authoritative; delivery alone does not assess it.
  if (ok) { packet.student_answer = text; if (field.value === text) field.value = ''; saveNotebook(); }
  controls();
  return ok;
}
const toolbar = document.querySelector<HTMLElement>('.notebook-toolbar');
function nearBottom() { return notebookPage.scrollHeight - notebookPage.scrollTop - notebookPage.clientHeight < 48; }
function updateLatest() { latestButton.hidden = nearBottom(); }
function appendCard(label: string, fill: (body: HTMLElement) => void, follow = nearBottom()) {
  const row = document.createElement('article'), tag = document.createElement('small'), body = document.createElement('div');
  tag.textContent = label;
  row.append(tag, body);
  fill(body);
  feed.append(row);
  // A long answer opens at its beginning. Later packets leave a reader in place.
  if (follow) {
    // The sticky toolbar stays over the page top; open the card just below it.
    const top = notebookPage.scrollTop + row.getBoundingClientRect().top - (toolbar?.offsetHeight ?? 0);
    notebookPage.scrollTop = Math.max(0, Math.min(notebookPage.scrollHeight - notebookPage.clientHeight, top));
  }
  updateLatest();
}
document.addEventListener('scroll', updateLatest);
feed.addEventListener('toggle', updateLatest, true);
feed.addEventListener('load', updateLatest, true);
window.addEventListener('resize', updateLatest);
button('latest').onclick = () => {
  const latest = [...notebook.cells].reverse().find(conversationCell);
  if (practice && latest) { latest.collapsed = false; updateConversationCard(latest); saveNotebook(); }
  notebookPage.scrollTop = notebookPage.scrollHeight; updateLatest();
};
if (button('clear-conversation')) button('clear-conversation').onclick = () => confirmRemoval(button('clear-conversation'), 'Delete all conversation messages? Your task, code and private notes will stay.', () => removeConversation(notebook.cells));
const focusButton = button('wide'), focusHome = document.createComment('focus view control');
focusButton.before(focusHome);
function focusView(active: boolean) {
  document.body.classList.toggle('focus-view', active);
  focusButton.textContent = active ? 'Exit focus view' : 'Focus view'; focusButton.setAttribute('aria-pressed', String(active));
  if (active) document.querySelector('.workspace-actions')?.append(focusButton);
  else focusHome.after(focusButton);
  if (active) focusButton.focus();
  else (focusButton.closest('details')?.querySelector<HTMLElement>('summary') ?? focusButton).focus();
}
focusButton.onclick = () => focusView(!document.body.classList.contains('focus-view'));
function close(message: string) {
  devices.stop(); mediaAllowed = false;
  clearTimeout(saveTimer);
  const saved = snapshotNotebook();
  if (documentKey) host.postMessage({type:'notebookChanged', documentKey, sequence:++saveSequence, notebook:saved});
  pendingNotebook?.finish({error:'Session changed.'}); pendingNotebook = undefined;
  ++attempt; ready = sending = coaching = false; blockedAudio = false; agent = undefined;
  lessonScope = '';
  const old = room; room = undefined;
  for (const el of audio) { el.pause(); el.srcObject = null; el.remove(); }
  audio.clear();
  for (const entry of videos.values()) entry.body.replaceChildren();
  videos.clear(); activeVideo = undefined;
  currentVideo = undefined; pendingPause?.finish(false); latestVideoUpdate = Promise.resolve(true);
  if (old) void old.disconnect().catch(() => {});
  button('end').disabled = true;
  button('tutor').textContent = practiceMode ? 'Retry Practice' : 'Retry ' + names[mode]; button('tutor').hidden = false;
  for (const key of Object.keys(names)) button(key).setAttribute('aria-pressed', 'false');
  status.textContent = message; controls(); host.postMessage({type: 'leave'});
  byId('code-observer-status').textContent = '';
  restoreNotebook(saved);
}
function begin(next: Mode, chapterId = '') {
  if (!practiceMode && next === 'tutor' && !chapterId) { chooseLesson(); return; }
  if (next === mode && chapterId === selectedLesson && !button('end').disabled) return;
  close('Connecting to ' + names[next] + '…');
  mode = next; selectedLesson = chapterId; clearDocument(); renderLessons();
  voice = voiceByMode.get(mode) ?? true; controls(); button('end').disabled = false;
  button(next).setAttribute('aria-pressed', 'true');
  host.postMessage({type: 'join', mode, attempt, ...(chapterId ? {chapterId} : {})});
  button('tutor').hidden = true;
  if (practiceMode) status.textContent = 'Opening Practice…';
}
function renderVideo(id: string, embedded: boolean) {
  const entry = videos.get(id);
  if (!entry?.url) return;
  entry.body.replaceChildren();
  if (embedded) {
    const frame = document.createElement('iframe');
    frame.src = entry.url; frame.title = 'DhimantAI lesson video';
    frame.allow = "autoplay; encrypted-media; fullscreen; microphone 'none'; camera 'none'";
    frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.allowFullscreen = true;
    entry.frame = frame; entry.body.append(frame);
    const actions = document.createElement('div'); actions.className = 'video-actions';
    const ask = document.createElement('button'), resume = document.createElement('button');
    ask.type = resume.type = 'button'; ask.textContent = 'Pause and ask'; resume.textContent = 'Resume video';
    ask.disabled = resume.disabled = true;
    ask.onclick = async () => {
      if (currentVideo !== id || !await pauseForQuestion()) return;
      status.textContent = 'Video paused. Ask your question below.'; field.focus();
    };
    resume.onclick = () => videoCommand(id, 'resume');
    entry.ask = ask; entry.resume = resume; actions.append(ask, resume); entry.body.append(actions);
  } else {
    entry.frame = undefined;
    const p = document.createElement('p'); p.textContent = 'This video cannot play inside VS Code. You can continue asking questions here.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry inline video';
    retry.onclick = () => renderVideo(id, true);
    entry.body.append(p, retry);
  }
  updateLatest();
}
function videoCommand(id: string, action: 'pause' | 'resume') {
  const entry = videos.get(id);
  if (entry?.frame && entry.url) entry.frame.contentWindow?.postMessage({id, action}, new URL(entry.url).origin);
}
function syncVideo(id: string): Promise<boolean> {
  const v = videos.get(id), live = room, dest = agent, session = attempt;
  if (!v?.state || !live || !dest) return Promise.resolve(false);
  const payload = JSON.stringify({event: v.state === 'unavailable' ? 'closed' : v.state,
    video_id: id, video_title: v.title, video_topic: v.topic, timestamp_sec: v.seconds ?? 0});
  // Preserve player-event order at the worker as well as in the webview.
  return latestVideoUpdate = latestVideoUpdate.then(async () => {
    if (session !== attempt) return false;
    try {
      return await live.localParticipant.performRpc({destinationIdentity: dest, method: 'on_video_state_update',
        payload, responseTimeout: 6000}) === 'ok' && session === attempt;
    } catch { return false; }
  });
}
async function pauseForQuestion(): Promise<boolean> {
  if (!activeVideo) {
    const session = attempt;
    const ok = await latestVideoUpdate || !!currentVideo && await syncVideo(currentVideo);
    if (session !== attempt) return false;
    return activeVideo ? pauseForQuestion() : ok;
  }
  if (pendingPause?.video === activeVideo) return pendingPause.promise;
  pendingPause?.finish(false);
  const video = activeVideo, session = attempt;
  let finish!: (ok: boolean) => void;
  const promise = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => finish(false), 10000);
    finish = ok => { clearTimeout(timer); if (pendingPause?.finish === finish) pendingPause = undefined; resolve(ok); };
  });
  pendingPause = {video, promise, finish};
  videoCommand(video, 'pause');
  const ok = await promise;
  if (!ok && ready && session === attempt) status.textContent = 'Could not confirm the video pause. Pause the video and try again; your question is still here.';
  return ok;
}
function videoPacket(data: Record<string, unknown>) {
  const id = data.video_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id) || data.provider !== 'youtube') return;
  const existing = videos.get(id);
  if (data.action === 'resume' && existing?.frame && existing.url) {
    videoCommand(id, 'resume'); return;
  }
  if (existing) return;
  const title = typeof data.title === 'string' && data.title ? data.title : 'Lesson video';
  appendCard(title, body => {
    body.textContent = 'Checking the DhimantAI video catalog…';
    videos.set(id, {body, title, topic: typeof data.topic === 'string' ? data.topic : ''});
  });
  host.postMessage({type: 'checkVideo', videoId: id, attempt});
}
function board(text: string, section?: unknown, packet: Record<string, unknown> = {}) {
  if (!text.trim() || text.length > 100000) return;
  if (mode === 'tutor' && (packet.is_question_prompt || packet.tutor_feedback)) {
    editors.checkpoint(packet.is_question_prompt && typeof packet.tutor_checkpoint_id === 'string' ? packet.tutor_checkpoint_id : '');
  }
  const prior = [...notebook.cells].reverse().find(cell => cell.packet?.tutor_checkpoint_id === packet.tutor_checkpoint_id && packet.tutor_checkpoint_id);
  addCell('board', text, {...packet, active_subtopic:section, ...(prior?.packet?.student_answer ? {student_answer:prior.packet.student_answer} : {})});
  controls();
}
const learningActions: Record<string, [string, string]> = {
  continueLesson:['Continue','Please continue the lesson.'], hint:['Hint','Give me one hint for this step.'],
  explainSimply:['Explain simply','Explain this idea more simply.'], workedExample:['Worked example','Show a worked example of this idea.'],
  similarProblem:['Try another','Give me a similar problem to try.'], harderProblem:['Harder problem','Give me a harder problem on this topic.'],
  testMe:['Try on my own','Give me a fresh problem to attempt independently.'], summarize:['Recap','Summarize what we have learned.'],
  explainDiagram:['Explain diagram','Explain this diagram.'], simulation:['Explore','Show an exploration of this idea.'], video:['Video','Show a video about this topic.'],
};
function renderActions(body: HTMLElement, packet: Record<string, unknown>) {
  if (practice || packet.notebook_help || mode !== 'tutor' || (packet.tutor_practice_editor as {source?:string} | undefined)?.source === 'Practice exercise') return;
  const menu = packet.tutor_action_menu as {actions?: unknown} | undefined;
  const ids = ['continueLesson', 'hint', ...(Array.isArray(menu?.actions) ? menu!.actions : [])];
  const bar = document.createElement('div'); bar.className = 'lesson-actions';
  for (const id of [...new Set(ids)].filter(id => typeof id === 'string' && learningActions[id])) {
    const [label, text] = learningActions[id], action = document.createElement('button');
    action.textContent = label; action.onclick = () => { void send(text, false, text, id); }; bar.append(action);
  }
  body.append(bar);
}
function renderTeaching(cell: NotebookCell) {
  const text = cell.text, packet = cell.packet ?? {}, section = packet.active_subtopic;
  appendCard(names[mode], body => {
    body.parentElement?.setAttribute('data-cell-id', cell.id);
    body.innerHTML = renderBoard(text);
    // Coach replies are explanations, never new executable solution cells.
    if (!packet.notebook_help && (!practiceMode || !conversationCell(cell))) editors.mount(body, text, packet.tutor_practice_editor, cell.id);
    if (packet.is_question_prompt && typeof packet.tutor_checkpoint_id === 'string' && !packet.tutor_practice_editor) {
      // Answers go in the one text cell at the bottom; this only points there while the question is open.
      const hint = document.createElement('small'); hint.className = 'answer-hint muted';
      hint.dataset.questionHint = packet.tutor_checkpoint_id; hint.textContent = 'Answer below.';
      hint.hidden = openQuestion()?.packet?.tutor_checkpoint_id !== packet.tutor_checkpoint_id;
      body.append(hint);
    }
    renderActions(body, packet);
    conversationControls(body, cell);
    // Instructor sends the course section first, then the concept taught this turn.
    const heading = body.firstElementChild;
    const concept = heading?.nextElementSibling;
    if (mode !== 'tutor' || typeof section !== 'string' || heading?.tagName !== 'H2' || heading.textContent?.trim() !== section.trim()) return;
    const step = concept?.matches('h3') ? concept : concept?.matches('p') ? concept.querySelector(':scope > strong:first-child') : null;
    if (!step || (step !== concept && step.nextSibling && step.nextSibling.nodeName !== 'BR')) return;
    const title = document.createElement('h2');
    title.append(...Array.from(step.childNodes));
    if (step.nextSibling?.nodeName === 'BR') step.nextSibling.remove();
    step.remove();
    const context = document.createElement('small');
    context.textContent = section;
    heading.replaceWith(context, title);
  }, !restoring && nearBottom());
}
async function connect(grant: {url: string; token: string; chapterId?: string; media?: boolean; lesson?: {subject: string; name: string}}, id: number) {
  mediaAllowed = grant.media === true;
  byId<HTMLInputElement>('follow-code').disabled = mediaAllowed;
  if (mediaAllowed) byId('code-observer-status').textContent = 'Use Ask Instructor to share a cell from this notebook.';
  const live = new LivekitClient.Room({audioOutput: {deviceId: speaker?.deviceId}}); room = live;
  const current = () => room === live && id === attempt;
  const isAgent = (peer?: RemoteParticipant) => current() && !!peer?.isAgent && (!agent || peer.identity === agent);
  const subscribe = (pub: RemoteTrackPublication, peer: RemoteParticipant) => {
    if (isAgent(peer) && pub.kind === 'audio') pub.setSubscribed(true);
  };
  live.on(RoomEvent.TrackPublished, subscribe);
  live.on(RoomEvent.TrackSubscribed, (track, _pub, peer) => {
    if (!isAgent(peer) || track.kind !== 'audio') return;
    const el = track.attach(); el.muted = !visible || !voice || !!activeVideo; document.body.append(el); audio.add(el);
    if (voice) void el.play().catch(() => { if (current()) { blockedAudio = true; controls(); } });
  });
  live.on(RoomEvent.TrackUnsubscribed, track => { for (const el of track.detach()) { audio.delete(el); el.remove(); } });
  live.on(RoomEvent.DataReceived, (bytes, peer) => {
    if (!isAgent(peer) || bytes.length > 320000) return;
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
    if (data?.method === 'video_visual') videoPacket(data);
    else if (data?.method === 'video_pause_request') void pauseForQuestion();
    else if (data?.method === 'draw_svg' && typeof data.svg === 'string' && data.svg.length <= 100000) {
      addCell('diagram', data.svg);
    } else if (['display_on_screen', 'write_on_whiteboard'].includes(data?.method) && typeof data.content === 'string') {
      board(data.content, data.active_subtopic, data);
    } else if (mode === 'tutor' && (data?.method === 'topic_update' || data?.method === 'tutor_example_progress')) {
      const title = typeof data.current_topic === 'string' ? data.current_topic : typeof data.topic === 'string' ? data.topic : '';
      if (title) notebook.title = title.slice(0,300);
      const items = Array.isArray(data.lesson_topics) ? data.lesson_topics : [];
      const content = '### Lesson progress\n\n' + items.filter((item: any) => typeof item.title === 'string').map((item: any) => '- ' + item.title + ' — ' + (item.learning_status || item.status || '')).join('\n');
      if (items.length) {
        const scope = JSON.stringify([data.subject, data.chapter_name, data.lesson_name]);
        const prior = notebook.cells.find(cell => cell.kind === 'recap' && cell.packet?.progressScope === scope);
        if (prior) { prior.text = content; const body = feed.querySelector('[data-cell-id=\"' + prior.id + '\"] > div'); if (body) body.innerHTML = renderBoard(content); saveNotebook(); }
        else addCell('recap', content, {progressScope:scope});
      }
    } else if (data?.method === 'tutor_session_summary') {
      const cards = Array.isArray(data.recap_cards) ? data.recap_cards : [];
      const recap = ['## Lesson recap', data.big_idea || data.remark || '', ...cards.map((card: any) => typeof card === 'string' ? card : [card.title, ...(Array.isArray(card.takeaways) ? card.takeaways.map((point: string) => '- ' + point) : [card.content || card.summary || card.key_takeaway || ''])].filter(Boolean).join('\n\n')), data.strength ? '**What went well:** ' + data.strength : '', data.work_on ? '**Keep practising:** ' + data.work_on : ''].filter(value => typeof value === 'string').join('\n\n');
      addCell('recap', recap); editors.checkpoint('');
    } else if (data?.method === 'lesson_context') {
      const scope = JSON.stringify([data.subject, data.chapter_name, data.lesson_name, data.subtopic]);
      if (scope !== lessonScope) editors.checkpoint('');
      lessonScope = scope;
    }
  });
  live.localParticipant.registerRpcMethod('display_on_screen', async data => {
    if (!isAgent(live.remoteParticipants.get(data.callerIdentity))) return '';
    const payload = JSON.parse(data.payload);
    if (typeof payload?.content === 'string') board(payload.content, payload.active_subtopic, payload);
    return '';
  });
  live.registerTextStreamHandler('lk.transcription', async (reader, peer) => {
    if (!isAgent(live.remoteParticipants.get(peer.identity))) return;
    const text = await reader.readAll();
    if (!current() || !text.trim() || reader.info.attributes?.['lk.transcription_final'] === 'false') return;
    addCell('voice', text.slice(0,12000));
  });
  live.on(RoomEvent.ParticipantDisconnected, peer => { if (current() && peer.identity === agent) close('Instructor disconnected. Retry to reconnect.'); });
  live.on(RoomEvent.Disconnected, () => { if (current()) close('Disconnected. Retry to reconnect.'); });
  live.on(RoomEvent.Reconnecting, () => { if (current()) {devices.stop(); ready = false; status.textContent = 'Reconnecting…'; controls();} });
  let switched = false;
  live.on(RoomEvent.Reconnected, () => {
    if (current() && switched && agent) {
      if (!isAgent(live.remoteParticipants.get(agent))) { close('The session changed. Retry to reconnect.'); return; }
      ready = true; status.textContent = names[mode] + ' connected'; controls();
    }
  });
  try {
    await live.connect(grant.url, grant.token, {autoSubscribe:false});
    if (!current()) { await live.disconnect(); return; }
    for (const peer of live.remoteParticipants.values()) for (const pub of peer.trackPublications.values()) subscribe(pub, peer);
    const deadline = Date.now() + 65000;
    while (current() && Date.now() < deadline) {
      const peer = [...live.remoteParticipants.values()].find(p => p.isAgent);
      if (peer) {
        agent = peer.identity;
        try {
          const ack = await live.localParticipant.performRpc({destinationIdentity: agent, method:'switch_mode',
            payload: JSON.stringify({mode, ...(mode === 'tutor' ? mediaAllowed
              ? {lesson_subject:grant.lesson?.subject, lesson_name:grant.lesson?.name}
              : {chapter_id:grant.chapterId} : {})}), responseTimeout: 30000});
          if (ack !== 'ok') {
            if (current()) close(ack === 'error: choose Tutor or Doubt Solver in this room' && mode === 'tutor'
              ? 'This Instructor service needs an update to open selected lessons. Contact support.'
              : ack.startsWith('error:') ? ack.slice(6).trim() : 'Could not start this lesson. Retry.');
            return;
          }
          if (!current()) return;
          if (mediaAllowed) {
            const audioAck = await live.localParticipant.performRpc({destinationIdentity: agent, method:'toggle_audio',
              payload:JSON.stringify({input_enabled:false, output_enabled:true}), responseTimeout:8000});
            if (audioAck !== 'ok') throw new Error('Instructor audio was not ready. Retry to reconnect.');
            if (!current()) return;
          }
          switched = ready = true; status.textContent = names[mode] + ' connected'; controls(); field.focus(); return;
        } catch (e) {
          // A newly joined worker registers the app RPCs after identity checks.
          if (!(e instanceof LivekitClient.RpcError && e.code === LivekitClient.RpcError.ErrorCode.UNSUPPORTED_METHOD)) throw e;
        }
      }
      await new Promise(r => setTimeout(r, 350));
    }
    if (current()) close('Instructor did not become ready. Retry to reconnect.');
  } catch { if (current()) close('Could not connect. Retry to continue.'); }
}
/** Help also works before the learner adds code. The synthetic empty selection never becomes a notebook cell. */
function helpContext() {
  return editors.selection() ?? {snapshot:{snippet:'code-0', revision:0,
    language:byId<HTMLSelectElement>('cell-language').value || 'python', source:'', stdin:'',
    question:([...notebook.cells].reverse().find(cell => cell.kind === 'board' && !cell.packet?.notebook_help)?.text
      || heading?.textContent || 'Help me with this notebook.').slice(0,6000)}, prediction:'', run:undefined, focusLine:undefined};
}
function helpStatus(message: string) {
  status.textContent = message;
  const inline = byId('notebook-help-status');
  if (inline) inline.textContent = message;
}
async function send(text: string, fromField: boolean, display = text, action?: string, targetCell?: string, followupStage?:SkillStage, helpLevel?: number, notebookHelp = false): Promise<boolean> {
  const draft = fromField ? field.value : undefined;
  const live = room, dest = agent, id = attempt;
  if (practice || notebookHelp) {
    const attached = fromField && attachments.count > 0;
    if (!ready || sending || !editors.aiEnabled || (!text.trim() && !attached)) return false;
    sending = coaching = true; controls();
    try {
      // Photos and PDFs go with this question; the server reads them into text for Instructor and keeps nothing.
      const files = attached ? await attachments.encoded() : [];
      const submitted = text.startsWith('PRACTICE_NOTEBOOK_SUBMISSION\n');
      const help = text.startsWith('TUTOR_NOTEBOOK_HELP\n') ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined;
      const payload = submitted ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined;
      const selected = submitted ? editors.solution() : help ? editors.context(help.cell_id)
        : targetCell && targetCell !== 'code-0' ? editors.context(targetCell) : helpContext();
      if (!selected) throw new Error('Select a code cell first.');
      const stage = submitted ? undefined : skillStages.includes(help?.stage) ? help.stage as SkillStage
        : followupStage ?? (!help && !action ? activeSkills.get(selected.snapshot.snippet) : undefined);
      if (stage) activeSkills.set(selected.snapshot.snippet,stage); else activeSkills.delete(selected.snapshot.snippet);
      const request = ++notebookCounter;
      // Every Instructor reply, including a code review, is help for this attempt.
      editors.markHelped(selected.snapshot.snippet);
      helpStatus(names[mode] + ' is thinking…');
      const reply = await new Promise<NotebookReply>(resolve => {
        const timer = setTimeout(() => { pendingNotebook = undefined; resolve({error:names[mode] + ' did not reply in time. Your work is still here; try again.'}); }, 60000);
        pendingNotebook = {request, finish:reply => { clearTimeout(timer); pendingNotebook = undefined; resolve(reply); }};
        host.postMessage({type:'notebookTurn', attempt:id, request, snapshot:selected.snapshot, run:selected.run,
          notebookContext:notebookContext(notebook.cells, editors.contexts(), selected.snapshot.snippet),
          prediction:selected.prediction, submitted, stage, debugger:help?.debugger, strategy:practiceStrategy(action), focusLine:selected.focusLine, helpLevel,
          message:submitted ? ('Review my code and help me decide what to improve. ' + (payload.explanation || '')).slice(0,600)
            : (help?.message || text || 'Look at what I attached and help me with my next step.').slice(0,600),
          ...(files.length && !submitted ? {attachments:files} : {}),
          history:notebook.cells.filter(cell => ['board','message'].includes(cell.kind) && cell.id !== 'practice-question').slice(-8)
            .map(cell => ({role:cell.kind === 'message' ? 'learner' : 'tutor', text:cell.text.slice(0,1500)})),
        });
      });
      if (id !== attempt) return false;
      if (reply.error) throw new Error(reply.error);
      addCell('message', (display || 'About my attachment') + (files.length && !submitted ? '\n\nAttachments: ' + files.map(f => f.name).join(', ') : ''), submitted ? {submission:{language:selected.snapshot.language,
        source:selected.snapshot.source, explanation:payload.explanation, assisted:payload.helped === true}} : undefined);
      const response = addCell('board', (submitted ? '## Code review\n\n' : '') + (reply.content || names[mode] + ' returned no feedback. Try again.'),
        {notebook_help:true, choices:replyChoices(reply.choices), replies:quickReplies(reply.replies), strategy:practiceStrategy(reply.strategy ?? action), line:reply.line});
      replyContexts.set(response.id, {...selected.snapshot,skillStage:stage});
      spokenReplies?.reply(typeof reply.audioId === 'string' ? reply.audioId : null);
      if (files.length && !submitted) attachments.clear();
      helpStatus(names[mode] + ' replied. Choose a reply or ask your next question.');
      if (fromField && field.value === draft) field.value = '';
      return true;
    } catch (error) { if (id === attempt) helpStatus(error instanceof Error ? error.message : names[mode] + ' could not reply. Try again.'); return false; }
    finally { if (id === attempt) { sending = coaching = false; controls(); } }
  }
  const attached = fromField && attachments.count > 0;
  if (!ready || sending || !live || !dest || (!text.trim() && !attached)) return false;
  sending = true; controls();
  try {
    const current = editors.selection();
    observeCode(current?.snapshot, current?.run);
    await latestObservation;
    if (id !== attempt) return false;
    if (!await pauseForQuestion()) {
      if (id === attempt) status.textContent = 'Could not confirm the video pause. Pause the video and try again; your question is still here.';
      return false;
    }
    if (id !== attempt) return false;
    if (attached) {
      const deadline = Date.now() + 120000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attachments.send(live.localParticipant, dest, text, () => id === attempt && room === live && Date.now() < deadline),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Attachment delivery timed out.')), 120000); }),
        ]);
      } finally { clearTimeout(timer); }
    } else await live.localParticipant.sendText(text, {topic:'lk.chat', destinationIdentities:[dest], ...(action ? {attributes:{tutor_action_id:action}} : {})});
    if (id !== attempt) return false;
    addCell('message', display + (attached ? '\n\nAttachments: ' + attachments.names.join(', ') : ''));
    if (attached) attachments.clear();
    if (fromField && field.value === draft) field.value = '';
    return true;
  } catch { if (id === attempt) status.textContent = 'Message delivery could not be confirmed. Your draft is still here.'; }
  finally { if (id === attempt) { sending = false; controls(); } }
  return false;
}

window.addEventListener('message', e => {
  const d = e.data;
  if (d?.type === 'lessonPlayback') {
    const v = videos.get(d.id);
    if (!room || !agent || !v?.frame || !v.url || e.source !== v.frame.contentWindow || e.origin !== new URL(v.url).origin) return;
    if (!['playing', 'paused', 'ended', 'unavailable'].includes(d.state)) return;
    v.state = d.state; v.seconds = Number.isFinite(d.seconds) ? Math.max(0, d.seconds) : 0;
    if (v.ask) v.ask.disabled = !['playing', 'paused'].includes(d.state);
    if (v.resume) v.resume.disabled = d.state !== 'paused';
    if (d.state === 'playing') {
      if (currentVideo !== d.id) pendingPause?.finish(false);
      for (const [id, other] of videos) if (id !== d.id && other.frame && other.url)
        videoCommand(id, 'pause');
      activeVideo = currentVideo = d.id;
    } else if (activeVideo === d.id) activeVideo = undefined;
    for (const el of audio) el.muted = !visible || !voice || !!activeVideo;
    if (d.state === 'unavailable') renderVideo(d.id, false);
    // Pausing an older card must not replace the newer video's worker context.
    if (currentVideo && currentVideo !== d.id) return;
    currentVideo = d.id;
    const pause = pendingPause, update = syncVideo(d.id), session = attempt;
    if (d.state !== 'playing' && pause && pause.video === d.id) void update.then(ok => {
      pause.finish(ok && session === attempt && currentVideo === d.id && !activeVideo);
    });
    return;
  }
  // VS Code forwards host messages from its same-origin bootstrap frame.
  // The YouTube player is on the separate API origin and may only report playback above.
  if (e.origin !== window.location.origin) return;
  if (d?.type === 'openTutor') { button('end').hidden = true; begin(d.mode === 'doubt_solver' ? 'doubt_solver' : 'tutor'); return; }
  if (d?.type === 'tutorLessons') {
    if (d.attempt !== attempt || mode !== 'tutor' || practiceMode) return;
    lessonCourses = d.courses;
    const course = byId<HTMLSelectElement>('lesson-course');
    if (course) {
      course.replaceChildren(...lessonCourses.map(item => { const option = document.createElement('option'); option.value = option.textContent = item.name; return option; }));
      if (lessonCourses.some(item => item.name === d.preferredCourse)) course.value = d.preferredCourse;
    }
    renderLessons(); status.textContent = d.error || 'Choose a lesson to learn with Instructor.';
    button('tutor').textContent = 'Reload lessons'; button('tutor').hidden = !d.error;
    return;
  }
  if (d?.type === 'openPractice') {
    practiceMode = true; document.body.classList.add('practice-notebook');
    button('end').hidden = true; button('doubt_solver').hidden = true;
    begin('tutor'); return;
  }
  if (d?.type === 'helpState') { showHelp(d); return; }
  if (d?.type === 'notebookReply') { if (d.attempt === attempt && pendingNotebook && d.request === pendingNotebook.request) pendingNotebook.finish(d); return; }
  if (d?.type === 'restoreNotebook') {
    if (d.attempt !== undefined && d.attempt !== attempt) return;
    clearTimeout(saveTimer);
    attachments.clear();
    documentKey = d.documentKey; saveSequence = 0; restoreNotebook(d.notebook);
    if (byId('notebook-save-status')) byId('notebook-save-status').textContent = 'Saved on this computer. Runs are temporary.';
    return;
  }
  if (d?.type === 'notebookSaved' || d?.type === 'notebookError') {
    if (d.documentKey && d.documentKey !== documentKey) return;
    if (byId('notebook-save-status')) byId('notebook-save-status').textContent = d.type === 'notebookSaved' ? 'Saved on this computer.' : d.message;
    return;
  }
  if (d?.type === 'runtimeRestarted') {
    replyContexts.clear(); updateHelpReplies();
    pendingNotebook?.finish({error:'Runtime changed. Ask ' + names[mode] + ' again with a current run.'});
    if (d.runtime) {
      selectedRuntime = 'course';
      if (runtimePicker) runtimePicker.value = selectedRuntime;
      editors.runtime = 'Course container · Podman';
    }
    editors.restartRuntime(); status.textContent = 'Runtime restarted. Run the required cells again.'; return;
  }
  if (d?.type === 'runtimeSelected') {
    replyContexts.clear(); updateHelpReplies();
    pendingNotebook?.finish({error:'Runtime changed. Ask ' + names[mode] + ' again with a current run.'});
    selectedRuntime = 'course';
    if (runtimePicker) runtimePicker.value = selectedRuntime;
    editors.runtime = 'Course container · Podman';
    editors.restartRuntime();
    status.textContent = 'Course container ready.';
    return;
  }
  if (d?.type === 'workstationState' && runtimePicker) {
    const option = runtimePicker.querySelector<HTMLOptionElement>('[value="course"]');
    if (option) option.textContent = 'Course container · ' + d.label;
    runtimePicker.title = d.error || 'Commands and code run in your course container.';
    return;
  }
  if (d?.type === 'visibility') {
    visible = d.visible === true;
    if (!visible) devices.stop();
    controls();
    const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run);
    for (const el of audio) el.muted = !visible || !voice || !!activeVideo;
    return;
  }
  if (d?.type === 'signedOut') {
    close('Your account changed. Retry to sign in.'); selectedLesson = ''; lessonCourses = [];
    const course = byId<HTMLSelectElement>('lesson-course'); if (course) course.replaceChildren();
    clearDocument(); renderLessons(); controls(); return;
  }
  if (d?.type === 'suspend') { close('Connection paused. Retry to continue.'); return; }
  if (d?.type === 'codeSettings') {
    editors.update(ready, attempt, d.aiEnabled === true);
    if (!editors.aiEnabled) observeCode();
    controls();
    return;
  }
  if (d?.attempt !== attempt) return;
  if (d.type === 'practiceReady') {
    practice = d.practice; ready = true; mode = 'tutor'; editors.aiEnabled = d.aiEnabled === true;
    showHelp(d.help ?? {});
    editors.practiceTools = {tests: Number(d.practice?.tools?.tests) || 0, trace: d.practice?.tools?.trace === true};
    practiceMode = true; document.body.classList.add('practice-notebook');
    button('tutor').hidden = true; button('end').hidden = true;
    editors.runtime = d.codeRuntime; editors.follow(false); editors.checkpoint('practice:' + practice!.id);
    if (byId('cell-language')) byId<HTMLSelectElement>('cell-language').value = practice!.language;
    if (button('sound')) button('sound').hidden = true;
    button('video').hidden = true; button('doubt_solver').hidden = true;
    byId<HTMLInputElement>('follow-code').checked = false; byId<HTMLInputElement>('follow-code').disabled = true;
    byId<HTMLInputElement>('stuck-hints').disabled = true;
    status.textContent = 'Practice is ready. Ask questions and get feedback here.'; controls(); return;
  }
  if (d.type === 'notebookDebugResult') { debugReplies.get(d.request)?.(d); debugReplies.delete(d.request); }
  if (d.type === 'notebookDebugState') editors.receiveDebug(d);
  if (d.type === 'cellCompletions') editors.completed(d);
  if (d.type === 'codeResult') { editors.receive(d); composerMode(); }
  if (d.type === 'practiceToolResult' && typeof d.request === 'number') { toolReplies.get(d.request)?.(d); toolReplies.delete(d.request); }
  if (d.type === 'grant' && !room) {
    editors.aiEnabled = d.aiEnabled !== false;
    editors.runtime = typeof d.codeRuntime === 'string' ? d.codeRuntime.slice(0, 200) : 'Local language tools';
    void connect(d, attempt);
  }
  if (d.type === 'failed') close(d.message);
  if (d.type === 'videoChecked') {
    const v = videos.get(d.videoId);
    if (!v) return;
    if (!d.ok) { v.body.textContent = 'This video is unavailable in the DhimantAI catalog.'; return; }
    // Let the player negotiate its formats. A few canPlayType combinations
    // cannot predict which video/audio streams YouTube will choose.
    v.url = d.url; renderVideo(d.videoId, true);
  }
});
button('tutor').onclick = () => begin(mode, selectedLesson);
if (byId('lesson-course')) byId('lesson-course').onchange = renderLessons;
if (button('lesson-catalog')) button('lesson-catalog').onclick = () => host.postMessage({type:'courseCatalog'});
button('doubt_solver').onclick = () => begin(mode === 'doubt_solver' ? 'tutor' : 'doubt_solver');
button('end').onclick = () => close('Session ended. Choose an agent to start again.');
if (button('sound')) button('sound').onclick = async () => {
  const live = room, id = attempt;
  voice = blockedAudio || !voice; blockedAudio = false;
  voiceByMode.set(mode, voice);
  for (const el of audio) el.muted = !visible || !voice || !!activeVideo;
  controls();
  try { if (voice && live) { await live.startAudio(); if (room === live && attempt === id && voice) await Promise.all([...audio].map(el => el.play())); } }
  catch { if (room === live && attempt === id && voice) { blockedAudio = true; controls(); } }
};
if (button('attach-images')) button('attach-images').onclick = () => attachments.choose(false);
if (button('attach-pdfs')) button('attach-pdfs').onclick = () => attachments.choose(true);
bindComposer(byId<HTMLFormElement>('composer'), field, submitField);
// One way to get unstuck: each press climbs one rung (question, hint, where, similar example) after a fresh try.
let nextHelp = 1;
function showHelp(d: {next?: unknown; waiting?: unknown; trend?: unknown}) {
  const help = document.getElementById('practice-help') as HTMLButtonElement | null;
  if (!help) return;
  nextHelp = Number.isSafeInteger(d.next) && (d.next as number) >= 1 && (d.next as number) <= HELP_LEVELS.length ? d.next as number : 1;
  help.textContent = HELP_LEVELS[nextHelp - 1].label;
  help.dataset.level = String(nextHelp);
  const steps = document.getElementById('help-steps');
  if (steps) {
    steps.replaceChildren(...HELP_LEVELS.map(item => {
      const dot = document.createElement('span'); dot.className = item.level < nextHelp ? 'used' : item.level === nextHelp ? 'next' : '';
      dot.title = `Step ${item.level}: ${item.short}`; return dot;
    }));
    steps.setAttribute('aria-label', `Help step ${nextHelp} of ${HELP_LEVELS.length}`);
  }
  const note = document.getElementById('help-note');
  if (note) note.textContent = d.waiting === true ? 'Try the last suggestion and run your code to unlock the next step.' : '';
  const trend = document.getElementById('help-trend');
  if (trend && typeof d.trend === 'string') trend.textContent = d.trend.slice(0, 160);
}
const helpButton = document.getElementById('practice-help') as HTMLButtonElement | null;
if (helpButton) helpButton.onclick = () => {
  const item = HELP_LEVELS[nextHelp - 1];
  void send(item.message, false, item.label, 'small_steps', undefined, undefined, item.level);
};
const tutorActions = byId('notebook-help-actions');
if (tutorActions) for (const item of notebookHelpActions) {
  const action = document.createElement('button'); action.type = 'button'; action.textContent = item.label;
  action.dataset.practiceStrategy = item.strategy;
  action.onclick = () => { void send(item.message, false, item.label, item.strategy, undefined, undefined, undefined, true); };
  tutorActions.append(action);
}
field.oninput = () => { controls(); saveNotebook(); };
feed.addEventListener('focusin', () => queueMicrotask(() => composerMode()));
feed.addEventListener('input', () => queueMicrotask(() => composerMode()));
button('video').onclick = () => { void send('Show me a DhimantAI video about the topic we are discussing.', false); };
button('teach-back').onclick = () => { void send(topicTeachBackRequest, false); };
byId<HTMLInputElement>('follow-code').onchange = e => {
  editors.follow((e.target as HTMLInputElement).checked);
  controls();
  if (!editors.following) observeCode();
  else editors.flushObservation();
};
byId<HTMLInputElement>('stuck-hints').onchange = e => editors.offerHints((e.target as HTMLInputElement).checked);
for (const [id, handler] of Object.entries({
  'add-note': () => {
    if (!documentKey) return;
    // Start a note from the draft if there is one; otherwise open an empty note to write in.
    addCell('note', field.value.trim() ? field.value : ''); field.value = ''; saveNotebook();
    const notes = feed.querySelectorAll<HTMLTextAreaElement>('[aria-label="My notes"]');
    notes[notes.length - 1]?.focus();
  },
  'add-code': () => { if (documentKey) addCell('code','',{language:byId<HTMLSelectElement>('cell-language').value}); },
  'save-notebook': () => host.postMessage({type:'exportNotebook', documentKey, notebook:snapshotNotebook()}),
  'open-notebook': () => host.postMessage({type:'importNotebook', documentKey}),
  'restart-runtime': () => host.postMessage({type:'restartRuntime', documentKey}),
})) { if (button(id)) button(id).onclick = handler; }
const runtimePicker = document.getElementById('course-runtime') as HTMLSelectElement | null;
let selectedRuntime = runtimePicker?.value ?? 'course';
if (runtimePicker) runtimePicker.onchange = () => {
  host.postMessage({type:'runtime', runtime:runtimePicker.value});
  runtimePicker.value = selectedRuntime;
};
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.workspace-menu[open]')) {
    if (!menu.contains(event.target as Node) || (event.target as Element).closest('button')) menu.open = false;
  }
});
// Open downward when a short notebook leaves no room above the message bar.
for (const menu of document.querySelectorAll<HTMLDetailsElement>('.composer-menu')) menu.addEventListener('toggle', () => {
  if (!menu.open) return;
  const content = menu.querySelector<HTMLElement>('.menu-content'), feedTop = byId('feed').getBoundingClientRect().top;
  menu.classList.toggle('drop-down', !!content && menu.getBoundingClientRect().top - feedTop < content.offsetHeight + 16);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('focus-view')) focusView(false);
  if (event.key === 'Escape') for (const menu of document.querySelectorAll<HTMLDetailsElement>('.workspace-menu[open]')) {
    menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus();
  }
});
host.postMessage({type:'ready'});
window.addEventListener('pagehide', () => {
  attachments.clear();
  if (documentKey) host.postMessage({type:'notebookChanged',documentKey,sequence:++saveSequence,notebook:snapshotNotebook()});
  close('Session ended.');
});
