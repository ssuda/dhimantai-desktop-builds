import { firstPandasCell, starterExercises } from '../src/starterExercises';
import { learningPreferences } from '../src/learningPreferences';
import { notebookResume, unfinishedQuestion } from '../src/notebookContinuity';
import type { NativeDebugReply } from '../src/debugEvidence';
import { skillStages, SkillStage } from '../src/skillPractice';
import { coachingLanguage } from '../src/coachingLanguage';
import { freshTeachingVisuals, requestedVisual } from '../src/lessonVisuals';
import type { RemoteParticipant, RemoteTrackPublication, Room } from 'livekit-client';
import { diagram } from './diagram';
import { bindDiagramBlocks } from './diagramBlocks';
import { bindVisuals, imageSource, imageMarkdown, prepareVisuals } from './visual';
import { markdownPlainText, renderBoard, renderHeading } from './markdown';
import { labelLessonOutputs } from './lessonOutput';
import { topicTeachBackRequest } from '../src/teachBack';
import { PracticeCodeEditors, ToolReply } from './practiceCodeEditor';
import { NotebookNavigation } from './notebookNavigation';
import { bindCoursePicker } from './coursePicker';
import type { CodeSnapshot, observedRun } from '../src/roomCode';
import type {BrowserObservation} from '../src/browserLearning';
import {BrowserCourseProgress, ERP_COURSE, browserProgressLabel, browserProgressNote, browserTaskLabel} from '../src/browserCourseProgress';
import {BrowserQuestion,validBrowserQuestion,validBrowserAnswer,browserAnswerMessage} from '../src/browserQuestion';
import {validDemonstration} from '../src/browserDemonstration';
import {FreeCADRoom} from './freecadRoom';
import {BrowserActionRelay} from './browserActions';
import { SpeakerControl } from './audioControls';
import { mediaIcon } from '../src/mediaIcons';
import { LearningDevices } from './learningDevices';
import { SpeechInterruption } from './speechInterruption';
import { AttachmentRole } from './notebookAttachments';
import { icon } from './icons';
import { notebookContext } from '../src/notebookContext';
import { executionFollowup, lessonCompletion, recordExecutionIssue } from '../src/lessonExecution';
import { emptyNotebook, readNotebook } from '../src/tutorNotebook';
import type { NotebookCell, TutorNotebook } from '../src/tutorNotebook';
import type { Course } from '../src/api';
import { courseCoverage, coverageLabel, coverageNote, nextChapter, topicCoverageHtml, TopicCoverage } from '../src/courseProgress';
import { conversationCell, replyChoices, quickReplies, notebookHelpActions, practiceStrategy } from '../src/practiceConversation';
import { HELP_LEVELS } from '../src/helpRecord';
import './room.css';
import './composer.css';
import { bindComposer, type LearnerMessage } from './composer';
import { aboutMarkdown, isDataQuestion, namedDatasets } from '../src/dataLab';
import type { CourseDataset, DataOutcome } from '../src/dataLab';
import { ImportPreview, outcomeCells, previewCard, renderDataBody } from './dataCells';
import '../media/audioControls.css';

declare const LivekitClient: typeof import('livekit-client');
declare function acquireVsCodeApi(): {postMessage(message: unknown): void};
const host = acquireVsCodeApi(), { RoomEvent } = LivekitClient;
const browserActions=new BrowserActionRelay(message=>host.postMessage(message));
// Spoken replies play only replies this page accepted and showed (see send()).
const spokenReplies = window.installCoachAudio?.(host);
type Mode = 'tutor' | 'doubt_solver';
const names = {tutor: 'Instructor', doubt_solver: 'Doubt Solver'};
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => byId<HTMLButtonElement>(id);
const latestButton = button('latest');
const feed = byId('feed'), status = byId('status'), field = byId<HTMLTextAreaElement>('message');
const notebookSaveStatus = byId('notebook-save-status');
const closeVisual = bindVisuals(feed, refreshDiagramAlternatives);
bindDiagramBlocks(feed, prepareVisuals);
function notebookPage() {
  const panel = document.getElementById('learning-document');
  return panel && getComputedStyle(panel).overflowY === 'auto' ? panel : document.scrollingElement ?? document.documentElement;
}
function notebookTop() {
  const page = notebookPage();
  return page === document.scrollingElement || page === document.documentElement ? 0 : page.getBoundingClientRect().top;
}
const toolbar = document.querySelector<HTMLElement>('.notebook-toolbar');
function scrollToNotebookRow(row: Element) {
  const page = notebookPage();
  page.scrollTop = Math.max(0, Math.min(page.scrollHeight - page.clientHeight,
    page.scrollTop + row.getBoundingClientRect().top - Math.max(notebookTop(), toolbar?.getBoundingClientRect().bottom ?? 0)));
}
const compactToolbar = window.matchMedia?.('(max-width: 1120px)');
const editingTools = toolbar?.querySelector<HTMLElement>('.notebook-tools');
const compactTools = document.getElementById('compact-notebook-tools');
if (editingTools && compactTools && compactToolbar) {
  const home = document.createComment('Notebook tools');
  editingTools.before(home);
  const placeTools = () => {
    if (compactToolbar.matches) compactTools.append(editingTools);
    else home.after(editingTools);
  };
  compactToolbar.addEventListener('change', placeTools);
  placeTools();
}

const navigationToolbar = document.querySelector<HTMLElement>('.notebook-jumps');
function goToNotebookCell(id: string) {
  const cell = notebook.cells.find(cell => cell.id === id);
  const row = [...feed.querySelectorAll<HTMLElement>('[data-cell-id]')].find(row => row.dataset.cellId === id);
  if (!cell || !row) return;
  if (cell.collapsed) { cell.collapsed = false; updateConversationCard(cell, row); saveNotebook(); }
  row.tabIndex = -1; row.focus({preventScroll:true});
  scrollToNotebookRow(row);
  updateLatest();
}
const navigation = navigationToolbar ? new NotebookNavigation(navigationToolbar, goToNotebookCell) : undefined;
function refreshNavigation() {
  const course = mode === 'tutor' && !practiceMode ? lessonCourses.find(course => course.chapters.some(ch => ch.id === selectedLesson)) : undefined;
  const chapter = course?.chapters.find(ch => ch.id === selectedLesson);
  const visibleCells = new Set(Array.from(feed.querySelectorAll<HTMLElement>('[data-cell-id]'), row => row.dataset.cellId));
  navigation?.update(notebook.cells.filter(cell => visibleCells.has(cell.id)).map(cell => ({id:cell.id,
    label: (cell.kind === 'code' ? 'Code · ' : cell.kind === 'message' ? 'You · ' : cell.kind === 'note' ? 'Note · ' : '')
      + markdownPlainText(cell.text).replace(/\s+/g, ' ').slice(0, 90)})),
    chapter && course ? course.name === ERP_COURSE
      ? `${chapter.lesson || chapter.name} · ${taskProgress ? browserTaskLabel(taskProgress.tasks.find(task=>task.chapter===chapter.id)?.status)+' · ' : ''}${browserProgressLabel(taskProgress)}`
      : `${chapter.lesson || chapter.name} · ${coverageLabel(chapter.progress)} · ${courseCoverage(course.chapters)}` : '',
    course?.name === ERP_COURSE ? browserProgressNote : coverageNote,
    course?.name !== ERP_COURSE && chapter?.progress && chapter.progress.status !== 'unavailable' && chapter.progress.total > 0 ? chapter.progress : undefined);
}
const messageBar = document.getElementById('message-bar');
const selectionPage = document.getElementById('course-selection');
const coursePicker = document.querySelector<HTMLElement>('.course-picker');
const syncCoursePicker = coursePicker && bindCoursePicker(coursePicker);
let selectionOpen = !!selectionPage;
const heading = document.querySelector('.workspace-title h1');
const initialTitle = heading?.textContent ?? '';
if (heading) heading.innerHTML = renderHeading(initialTitle);
let cancelRemoval: (() => void) | undefined;
function confirmRemoval(trigger: HTMLButtonElement, message: string, remove: () => void, confirmLabel = 'Delete') {
  cancelRemoval?.();
  const key = documentKey, prompt = document.createElement('div'), text = document.createElement('p');
  prompt.className = 'delete-confirmation'; prompt.setAttribute('role','group'); prompt.setAttribute('aria-label',message);
  text.textContent = message;
  const cancel = document.createElement('button'), confirm = document.createElement('button');
  cancel.type = confirm.type = 'button'; cancel.textContent = 'Cancel'; confirm.textContent = confirmLabel; confirm.dataset.confirmDelete = '';
  const close = () => { prompt.remove(); cancelRemoval = undefined; trigger.focus(); };
  cancel.onclick = close; cancelRemoval = close;
  confirm.onclick = () => { close(); if (key === documentKey && !sending) { remove(); if (!trigger.isConnected) field.focus(); } };
  prompt.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  prompt.append(text,cancel,confirm);
  (trigger.closest('article') ?? trigger.parentElement!).append(prompt); cancel.focus();
}
let attempt = 0, mode: Mode = document.body.dataset.notebookMode === 'doubt_solver' ? 'doubt_solver' : 'tutor', room: Room | undefined, agent: string | undefined;
let coachLanguage = 'en-IN';
let learnerPreferences = learningPreferences(undefined);
const preferenceNotice = document.getElementById('learning-preferences-status');
async function applyLearningPreferences() {
  if (!room || !agent) return;
  const current = room;
  try {
    const ack = await current.localParticipant.performRpc({destinationIdentity:agent, method:'set_learning_preferences',
      payload:JSON.stringify(learnerPreferences), responseTimeout:8000});
    if (ack !== 'ok') throw new Error('Preferences unavailable');
    if (room === current && preferenceNotice) preferenceNotice.textContent = 'Saved. Voice changes apply to the next spoken reply.';
  } catch {
    if (room === current && preferenceNotice) preferenceNotice.textContent = 'Saved on this computer, but the learning service could not apply these preferences. Reconnect or update the service.';
  }
}
for (const id of ['preferred-name', 'check-frequency', 'preferred-voice']) {
  const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (control) control.onchange = () => host.postMessage({type:'learningPreferences', preferences:{
    preferred_name:(document.getElementById('preferred-name') as HTMLInputElement).value,
    check_frequency:(document.getElementById('check-frequency') as HTMLSelectElement).value,
    voice:(document.getElementById('preferred-voice') as HTMLSelectElement).value,
  }});
}
const coachLanguagePicker = document.getElementById('coaching-language') as HTMLSelectElement | null;
if (coachLanguagePicker) coachLanguagePicker.onchange = () => {
  host.postMessage({type:'coachingLanguage', language:coachLanguagePicker.value});
};
let ready = false, sending = false, coaching = false, voice = true, blockedAudio = false, visible = true;
let agentActivity = '';
const pendingTutorRequests = new Set<string>(), retractedTutorRequests = new Set<string>();
let tutorTurn = '', lastTutorRequest = '', tutorOutputPaused = false;
let tutorCancellation = Promise.resolve();
function packetTurn(packet: Record<string, unknown> | undefined) {
  return String(packet?.tutor_request_id || packet?.tutor_turn_id || '');
}
function showAgentActivity() {
  const activity = byId('assistant-activity');
  if (!activity) return;
  const label = !ready ? '' : interruption.listening ? 'Listening…' : tutorOutputPaused ? '' : agentActivity === 'thinking' ? 'Thinking…'
    : agentActivity === 'speaking' ? 'Replying…' : '';
  if (activity.textContent !== label) activity.textContent = label;
  activity.hidden = !label;
}
let freecad:FreeCADRoom|undefined;
let browserCourse=false, browserSnapshot:BrowserObservation|null=null, browserSequence=0;
let taskProgress:BrowserCourseProgress|undefined;
function practicalLesson() {
  return mode==='tutor' && !practiceMode && lessonCourses.some(course=>course.name===ERP_COURSE && course.chapters.some(ch=>ch.id===selectedLesson));
}
function showBrowserProgress() {
  if(!practicalLesson())return;
  // Replace old teaching-coverage cards, including ones restored from older notebooks.
  const old=notebook.cells.filter(cell=>cell.kind==='recap' && cell.packet?.progressScope);
  for(const cell of old)feed.querySelector(`[data-cell-id="${cell.id}"]`)?.remove();
  notebook.cells=notebook.cells.filter(cell=>!old.includes(cell));
  const content='### Course progress\n\n'+browserProgressLabel(taskProgress)+'\n\n'
    +(taskProgress?.tasks.filter(task=>task.status!=='not_started' || task.chapter===selectedLesson)
      .map(task=>'- '+(task.status==='completed'?'✓ ':'')+'**'+task.title+'** — '+browserTaskLabel(task.status)).join('\n') || '')
    +'\n\n'+browserProgressNote;
  const prior=notebook.cells.find(cell=>cell.kind==='recap' && cell.packet?.browserCourseProgress);
  if(prior) {
    if(prior.text!==content || old.length) {
      prior.text=content;
      const body=feed.querySelector(`[data-cell-id="${prior.id}"] > div`);if(body)body.innerHTML=renderBoard(content);
      saveNotebook();
    }
  } else addCell('recap',content,{browserCourseProgress:true});
  refreshNavigation();
}
let browserQuestion:BrowserQuestion|null=null, browserAnswered='', browserAskInstead='';
function showBrowserQuestion(value:unknown) {
  browserQuestion=validBrowserQuestion(value)?value:null;
  let changed = false;
  for (const cell of notebook.cells) {
    if (!validBrowserQuestion(cell.packet?.browser_question)) continue;
    const stale = cell.packet!.browser_question_id !== browserQuestion?.id;
    if (stale && !cell.packet!.browser_question_closed) {
      cell.packet!.browser_question_closed = true; cell.collapsed = true;
      updateConversationCard(cell); changed = true;
    } else if (!stale && cell.packet!.browser_question_closed) {
      cell.packet!.browser_question_closed = false; cell.collapsed = false;
      updateConversationCard(cell); changed = true;
    }
  }
  if (changed) saveNotebook();
  if(!browserQuestion){controls();return;}
  const question=browserQuestion;
  if(!notebook.cells.some(cell=>cell.packet?.browser_question_id===question.id)) {
    addCell('board','### '+(question.kind==='prediction'?'Predict':question.kind==='explanation'?'Explain':'Reflect')+' · '+question.title+'\n\n'+question.question,{browser_question_id:question.id,
      browser_question:question});
  }
  controls();
}
function openBrowserQuestion() {
  return browserCourse && browserQuestion && browserQuestion.id!==browserAnswered
    && browserQuestion.id!==browserAskInstead ? browserQuestion : undefined;
}
function focusBrowserQuestion() {
  browserAskInstead='';controls();
  field.focus();messageBar?.scrollIntoView({block:'nearest'});
  helpStatus(ready?'Write your answer, then use the send arrow for Instructor feedback.'
    :'Connecting to Instructor… Use the send arrow when connected.');
}
let browserSync:Promise<void>=Promise.resolve(), browserObservationFailed=false;
function browserConnectionFailed(message:string) {
  browserObservationFailed=true;
  button('tutor').textContent='Reconnect Instructor';button('tutor').hidden=false;
  helpStatus(message);
}

function syncBrowserObservation():Promise<void> {
  const live=room,dest=agent,id=attempt,observation=browserSnapshot;
  if(!browserCourse || !ready || !live || !dest)return Promise.resolve();
  const sequence=browserSequence=Math.max(browserSequence+1,Date.now()*1000);
  browserSync=browserSync.catch(()=>{}).then(async()=>{
    if(room!==live || id!==attempt || !browserCourse || !ready)return;
    let ack:string;
    try {
      // switch_mode accepts the lesson before its asynchronous preload finishes.
      // Wait briefly for this read-only context handoff; never resend chat here.
      const deadline=Date.now()+4000;
      do {
        ack=await live.localParticipant.performRpc({destinationIdentity:dest,method:'on_browser_activity',
          payload:JSON.stringify(observation?{...observation,sequence}:{sequence,clear:true}),responseTimeout:8000});
        if(ack!=='unavailable' || Date.now()>=deadline)break;
        await new Promise(resolve=>setTimeout(resolve,250));
        if(room!==live || id!==attempt || !browserCourse || !ready)return;
      }while(true);
    } catch(error) {
      const detail='Instructor could not receive this task. Reconnect Instructor.';
      if(room===live && id===attempt && ready) {
        browserConnectionFailed(detail);host.postMessage({type:'browserState',attempt:id,connected:false,detail});
      }
      throw new Error(detail);
    }
    if(room!==live || id!==attempt || !ready)return;
    const connected=ack==='ok';
    browserObservationFailed=!connected;
    if(connected)button('tutor').hidden=true;
    else browserConnectionFailed('Browser observation is unavailable. Reconnect Instructor to retry.');
    if(connected && status.textContent==='Instructor could not receive the current ERPNext form. Reconnect before asking about it.')connectedStatus('Instructor connected');
    host.postMessage({type:'browserState',attempt:id,connected,detail:connected
      ? observation?'Instructor is following this ERPNext task.':'Observation paused. Instructor can still answer questions.'
      : 'Browser observation is unavailable. Reconnect Instructor to retry.'});
    if(!connected)throw new Error('Instructor could not receive the current ERPNext form. Reconnect before asking about it.');
  });
  return browserSync;
}
let mediaAllowed = false, mediaBusy = false;
function updateMediaControls() {
  const mic = document.querySelector<HTMLButtonElement>('[data-live-mic]');
  if (!mic) return;
  const reason = !visible || selectionOpen ? 'Return to the learning room to use the microphone.'
    : !ready ? `Connect to ${names[mode]} to use the microphone.`
    : !mediaAllowed && !dictation ? 'Microphone unavailable in this session.'
    : mediaBusy ? 'Waiting for device access…' : '';
  if (mediaAllowed || !dictation) {
    mic.disabled = !!reason;
    mic.title = reason || (mic.getAttribute('aria-pressed') === 'true' ? 'Stop microphone' : 'Start microphone');
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-describedby', 'media-control-status');
  }
  const message = byId('media-control-status');
  // Not being connected is already in the header; the microphone keeps that reason only in its label.
  if (message) { const shown = ready ? reason : ''; message.textContent = shown; message.hidden = !shown; }
}
const devices = new LearningDevices({
  current: () => ready && visible && !selectionOpen && mediaAllowed && room && agent ? {room, agent} : undefined,
  capture: () => LivekitClient.createLocalAudioTrack({echoCancellation: true, noiseSuppression: true, autoGainControl: true}),
  pause: () => pauseForQuestion(),
  report: message => { status.textContent = message; },
  changed: state => {
    mediaBusy = state.busy;
    const mic = button('audio-microphone');
    if (mic?.hasAttribute('data-live-mic')) {
      mic.setAttribute('aria-pressed', String(state.microphone));
      mic.innerHTML = mediaIcon('microphone', state.microphone);
    }
    updateMediaControls();
  },
});
const dictation = window.installDictation?.(host, field, () => {
  if (spokenReplies) spokenReplies.listenForReply();
  else { interruption.userSpeaking(true); interruption.userSpeaking(false); }
});
function stopDevices() {
  composer.cancelCapture();
  devices.stop();
}
if (button('audio-microphone')?.hasAttribute('data-live-mic')) {
  const dictate = button('audio-microphone').onclick;
  button('audio-microphone').onclick = event => {
    if (!mediaAllowed && dictate) return dictate.call(button('audio-microphone'), event);
    void resumeSpeaker(); void devices.toggle();
  };
}
window.addEventListener('pagehide', stopDevices);
const audio = new Set<HTMLMediaElement>();
function roomAudioMuted(): boolean {
  return !visible || selectionOpen || !voice || !!activeVideo || interruption.muted || tutorOutputPaused;
}
function resumeTutorOutput() {
  if (!tutorOutputPaused) return;
  tutorOutputPaused = false;
  for (const el of audio) el.muted = roomAudioMuted();
  showAgentActivity();
}
const interruption = new SpeechInterruption(() => {
  for (const el of audio) el.muted = roomAudioMuted();
  showAgentActivity();
}, () => {
  const live = room, destinationIdentity = agent, id = attempt;
  if (!live || !destinationIdentity) return;
  void live.localParticipant.performRpc({destinationIdentity, method:'stop_speaking', payload:'{}', responseTimeout:3000})
    .catch(() => { if (room === live && attempt === id) helpStatus('Listening. The stop request could not be confirmed; playback stays paused until Instructor responds again.'); });
});
/** Retry browser playback during a learner gesture, without changing their mute preference. */
async function resumeSpeaker() {
  const live=room,id=attempt;
  if(!live || !voice)return;
  try {
    await live.startAudio();
    if(room!==live || attempt!==id || !voice)return;
    await Promise.all([...audio].map(el=>el.play()));
    if(room===live && attempt===id){blockedAudio=false;controls();}
  } catch { if(room===live && attempt===id && voice){blockedAudio=true;controls();} }
}
const voiceByMode = new Map<Mode, boolean>();
const speaker = button('sound') ? new SpeakerControl(button('sound'), {
  menuLabel: 'Speaker options',
  playback: async speed => {
    const current = room;
    if (!current || !agent) return;
    const ack = await current.localParticipant.performRpc({destinationIdentity: agent, method:'set_speech_playback_speed',
      payload:JSON.stringify({speed}), responseTimeout:8000});
    if (ack !== 'ok' || room !== current) throw new Error('Voice speed was not accepted');
  },
  supported: () => 'setSinkId' in HTMLMediaElement.prototype,
  select: async deviceId => {
    const current = room;
    if (current && !await current.switchActiveDevice('audiooutput', deviceId)) throw new Error('Output unavailable');
    if (room !== current) throw new Error('Session changed');
  },
}) : undefined;
const composer = bindComposer(byId<HTMLFormElement>('composer'), deliverNotebookMessage, {changed:controls, report:helpStatus});
const {attachments} = composer;
type PlaybackState = 'playing' | 'paused' | 'ended' | 'unavailable';
const videos = new Map<string, {body: HTMLElement; title: string; topic: string; frame?: HTMLIFrameElement; url?: string;
  state?: PlaybackState; seconds?: number; ask?: HTMLButtonElement; resume?: HTMLButtonElement}>();
let activeVideo: string | undefined;
let currentVideo: string | undefined, latestVideoUpdate: Promise<boolean> = Promise.resolve(true);
let pendingPause: {video: string; promise: Promise<boolean>; finish: (ok: boolean) => void} | undefined;
let observationContent='';
let observationSequence = 0, latestObservation: Promise<unknown> = Promise.resolve();
let lessonScope = '';
let notebook = emptyNotebook(), documentKey = '', restoring = false, cellSequence = 0;
let saveSequence = 0;
let savedTextDraft: string | undefined;
let sendingComposerMessage = false;
let deliveryNextStep = '';
let practice: {id:string; language:string; title:string; course?:string} | undefined;
// The open question the learner chose to ask about instead of answering, and its toggle (created on first use).
let askInsteadOf = '', askInstead: HTMLButtonElement | undefined;
// Visibility can arrive before openPractice. Preserve the host's exercise heading from the first render.
let practiceMode = document.body.dataset.notebookMode === 'practice';
const localRuntimeLabel = () => 'Course container';
const workspaceMode = document.getElementById('workspace-mode') as HTMLFieldSetElement | null;
const practicePanel = document.getElementById('workspace-practice');
let workspaceBusy = false;
let lastMenuControls = '';
let practiceRequest = 0;
function selectRoomTab() {
  const inRoom = ready && !selectionOpen && !workspaceBusy && !sending && (!practicePanel || practicePanel.hidden);
  const ask = !!inRoom && (practiceMode ? editors.aiEnabled : mode === 'tutor');
  const practiceActions = !!inRoom && practiceMode && !!practice;
  const state = JSON.stringify([ask,practiceActions]);
  if (state !== lastMenuControls) {
    lastMenuControls = state;
    host.postMessage({type:'skillingControls', ask, practice:practiceActions});
  }
  const current = practiceMode || practicePanel && !practicePanel.hidden ? 'practice' : mode;
  for (const tab of workspaceMode?.querySelectorAll<HTMLButtonElement>('[data-room]') ?? [])
    tab.setAttribute('aria-pressed', String(tab.dataset.room === current));
}
function closePracticeList() {
  ++practiceRequest;
  if (practicePanel) practicePanel.hidden = true;
  document.body.classList.remove('browsing-practice');
  selectRoomTab();
}
async function changeWorkspace(mode: string, questionId?: string, carryDraft = false) {
  if (workspaceBusy || sending) return;
  workspaceBusy = true;
  if (workspaceMode) workspaceMode.disabled = true;
  stopDevices(); saveNotebook(true);
  const draft=snapshotNotebook();
  const tried=byId<HTMLTextAreaElement>('doubt-tried')?.value.trim();
  if(carryDraft && tried) {
    const combined=(draft.textDraft||'')+'\n\nWhat I tried: '+tried;
    if(combined.length>4000) {
      draft.cells.push({id:'handoff-tried-'+Date.now().toString(36),kind:'note',text:'What I tried: '+tried});
    } else draft.textDraft=combined;
  }
  try {
    const id=attempt, files=carryDraft?await attachments.encoded(true):undefined;
    if(id!==attempt)return;
    host.postMessage({type:'workspaceMode', mode, questionId, documentKey, notebook:draft,carryDraft,files});
  } catch(error) { workspaceBusy=false;helpStatus(error instanceof Error?error.message:'Could not carry your draft.');controls(); }
}
function browseCoursePractice(chapterId = selectedLesson) {
  stopDevices();
  if (practicePanel) practicePanel.hidden = false;
  document.body.classList.add('browsing-practice');
  selectRoomTab();
  byId('practice-questions')?.replaceChildren();
  const chapterSelect = byId<HTMLSelectElement>('practice-chapter');
  if (chapterSelect) chapterSelect.disabled = true;
  const courseLabel = byId('practice-course');
  if (courseLabel) courseLabel.textContent = practice?.course || lessonCourses.find(course=>course.chapters.some(ch=>ch.id===selectedLesson))?.name || '';
  const status = byId('practice-list-status');
  if (status) status.textContent = 'Loading exercises…';
  const back = button('practice-back');
  if (back) back.textContent = selectionOpen ? 'Back to chapters' : 'Back to notebook';
  host.postMessage({type:'workspacePractice', chapterId, request:++practiceRequest});
  byId('practice-title')?.focus();
}
workspaceMode?.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('button[data-room]')?.dataset.room;
  if (!target || workspaceMode.disabled) return;
  if (target === 'practice') browseCoursePractice();
  else if (!practiceMode && target === mode) closePracticeList();
  else void changeWorkspace(target);
});
if (button('practice-back')) button('practice-back').onclick = () => {
  closePracticeList();
  if (selectionOpen) byId('selection-title')?.focus();
  else workspaceMode?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
};
// Course data (see the course data section below).
let courseData: CourseDataset[] = [], dataState: 'none' | 'loading' | 'ready' | 'error' = 'none', askNormally = false;
let pendingData: {request:number; finish:(reply:DataReply) => void} | undefined;
type DataReply = {outcome?: DataOutcome; datasets?: string[]; error?: string; accessEnded?: boolean; quota?: boolean};
const importedSets = new Map<string, CourseDataset>();
let lessonCourses: Course[] = [], selectedLesson = '', preferredCourse = '', loadingLessons = !practiceMode, lessonLoadError = '';
compactToolbar?.addEventListener('change', () => updateSelectionPage());
function updateSelectionPage() {
  if (!selectionPage) return;
  const opening = selectionOpen && loadingLessons && !selectedLesson;
  selectionPage.hidden = !selectionOpen || opening;
  byId('lesson-loading').hidden = !opening;
  document.body.classList.toggle('selecting-course', selectionOpen);
  const history = byId('doubt-history');
  const historyHost = document.querySelector(selectionOpen ? '#course-selection header' : compactToolbar?.matches ? '#compact-chat-history' : '.workspace-actions');
  if (history && historyHost && history.parentElement !== historyHost) historyHost.append(history);
  button('selection-back').hidden = !selectedLesson;
  button('choose-course').disabled = sending || workspaceBusy;
}
function showCourseSelection(open: boolean) {
  if (!selectionPage) return;
  selectionOpen = open;
  if (open) { stopDevices(); saveNotebook(true); }
  for (const el of audio) el.muted = roomAudioMuted();
  updateSelectionPage();
  updateMediaControls();
  if (open) { notebookPage().scrollTop = 0; byId('selection-title').focus(); }
  else field.focus();
}
function loadCourseSelection() {
  if (sending || workspaceBusy) return;
  showCourseSelection(true);
  loadingLessons = true; lessonLoadError = '';
  renderLessons();
  host.postMessage({type:'tutorLessons', attempt, browse:true});
}
/** A chapter the host asked to resume (Course Catalog's Continue learning); it starts once lessons load. */
let preferredLesson = '';
// Keep transient loading/connection guidance outside the saved notebook.
const lessonPlaceholder = document.createElement('p');
lessonPlaceholder.id = 'lesson-placeholder'; lessonPlaceholder.hidden = true;
lessonPlaceholder.setAttribute('role', 'status'); feed.before(lessonPlaceholder);
function showLessonPlaceholder() {
  lessonPlaceholder.hidden = practiceMode || !!feed.childElementCount;
  if (lessonPlaceholder.hidden) return;
  const chapters = lessonCourses.find(course => course.name === byId<HTMLSelectElement>('lesson-course')?.value)?.chapters ?? [];
  lessonPlaceholder.textContent = loadingLessons ? 'Loading your lessons…'
    : selectedLesson ? (ready && mode === 'doubt_solver' ? 'What would you like to work through? Type your question or attach it below.' : status.textContent)
    : lessonLoadError || (chapters.length ? 'Choose a course and chapter to open your lesson.'
      : 'No lessons available. Open Course Catalog to view your courses.');
  lessonPlaceholder.setAttribute('aria-busy', String(loadingLessons));
}
const lessonPlaceholderObserver = new MutationObserver(showLessonPlaceholder);
lessonPlaceholderObserver.observe(status, {childList:true, subtree:true, characterData:true});
lessonPlaceholderObserver.observe(feed, {childList:true});
function suggestedChapter(course?: Course) {
  const chapters = course?.chapters ?? [];
  const available = (chapter: Course['chapters'][number]) => !chapter.locked && !chapter.expired;
  if (course?.name === ERP_COURSE) {
    const task = taskProgress?.tasks.find(task => task.status !== 'completed' && chapters.some(ch => ch.id === task.chapter && available(ch)));
    return chapters.find(ch => ch.id === task?.chapter);
  }
  return nextChapter(chapters, available);
}
function adjacentChapter(previous = false) {
  const chapters=lessonCourses.find(course=>course.chapters.some(ch=>ch.id===selectedLesson))?.chapters ?? [];
  const index=chapters.findIndex(ch=>ch.id===selectedLesson);
  if (index < 0) return;
  const candidates = previous ? chapters.slice(0,index).reverse() : chapters.slice(index+1);
  return candidates.find(ch=>!ch.locked && !ch.expired);
}
function selectChapter(chapterId:string) {
  if (selectionPage && (sending || workspaceBusy)) return;
  if(chapterId===selectedLesson) { showCourseSelection(false); return; }
  const course=lessonCourses.find(course=>course.chapters.some(ch=>ch.id===selectedLesson));
  if(browserCourse && browserSnapshot && course?.chapters.some(ch=>ch.id===chapterId)) {
    host.postMessage({type:'browserChooseChapter',attempt,chapterId});
    helpStatus('Opening the selected chapter and its browser task.');
  } else begin(mode,chapterId);
}
function renderLessons() {
  updateSelectionPage();
  refreshNavigation();
  const list = byId('lesson-list'), course = byId<HTMLSelectElement>('lesson-course');
  if (!list || !course) return;
  const openTopics = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[data-chapter][open]')].map(detail => detail.dataset.chapter));
  list.replaceChildren();
  list.setAttribute('aria-busy', String(loadingLessons));
  course.disabled = loadingLessons || !lessonCourses.length;
  const search = byId<HTMLInputElement>('lesson-search');
  if (search) search.disabled = loadingLessons;
  const unavailable = !!lessonLoadError && !lessonCourses.length;
  for (const field of [course, search]) {
    if (field) (field.closest<HTMLElement>('.chapter-filter') ?? field).hidden = unavailable;
  }
  syncCoursePicker?.(selectionOpen && !unavailable);
  if (button('reload-lessons')) button('reload-lessons').hidden = !lessonLoadError || loadingLessons;
  showLessonPlaceholder();
  if (loadingLessons) { list.textContent = 'Loading your lessons…'; return; }
  if (lessonLoadError) { list.textContent = lessonLoadError; return; }
  const chapters = lessonCourses.find(item => item.name === course.value)?.chapters ?? [];
  const practical=course.value===ERP_COURSE;
  if (chapters.length && mode === 'tutor') {
    const summary = document.createElement('p'); summary.className = 'course-coverage';
    summary.textContent = practical ? browserProgressLabel(taskProgress) : courseCoverage(chapters);
    summary.title = practical ? browserProgressNote : coverageNote; list.append(summary);
  }
  const grid = document.createElement('div');
  grid.className = 'chapter-grid';
  list.append(grid);
  // One chapter is the obvious next step: the one in progress, else the first not yet covered that is open.
  const upNext = suggestedChapter(lessonCourses.find(item => item.name === course.value));
  for (const chapter of chapters) {
    if (search?.value.trim() && !(chapter.name + ' ' + (chapter.lesson || '')).toLowerCase().includes(search.value.trim().toLowerCase())) continue;
    const taskStatus=taskProgress?.tasks.find(task=>task.chapter===chapter.id)?.status;
    const row = document.createElement('div'); row.className = 'lesson-outline' + (mode === 'tutor' && chapter === upNext ? ' up-next' : '');
    const choice = document.createElement('button'); choice.type = 'button';
    const label = chapter.lesson || chapter.name;
    if (chapter.lesson && chapter.lesson !== chapter.name) choice.title = chapter.name;
    choice.setAttribute('aria-pressed', String(chapter.id === selectedLesson));
    if (chapter.expired) {
      // Still focusable, so a keyboard or screen-reader learner hears why and how to restore access.
      choice.textContent = label + ' · Access ended · Buy again'; choice.className = 'lesson-expired';
      choice.setAttribute('aria-disabled', 'true'); choice.setAttribute('aria-describedby', 'lesson-access-note');
      choice.title = 'Your access to this course ended. Open Course Catalog to buy it again.';
      choice.onclick = () => host.postMessage({type:'courseCatalog'});
    } else {
      choice.textContent = label + (chapter.locked ? ' · Locked' : '');
      choice.disabled = !!chapter.locked;
      choice.onclick = () => selectChapter(chapter.id);
    }
    if (practical ? taskStatus==='completed' : chapter.progress?.status === 'covered') {
      // A covered chapter is done, not cancelled: a check mark, never a strikethrough, and still revisitable.
      const mark = document.createElement('span'); mark.className = 'covered-mark'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = '✓ ';
      const access = chapter.expired ? ' · Access ended · Buy again' : chapter.locked ? ' · Locked' : '';
      choice.classList.add('lesson-covered'); choice.replaceChildren(mark, document.createTextNode(label + access));
    }
    row.append(choice);
    grid.append(row);
    if (mode === 'doubt_solver') continue;
    // A CPU lab is the norm; only GPU needs (or an unreviewed requirement) are worth a line on the card.
    if(chapter.compute && !(chapter.compute.status==='specified' && !chapter.compute.totalGpus)) {
      const compute=document.createElement('small');compute.className='chapter-coverage';
      compute.textContent=chapter.compute.status==='specified'
        ? `${chapter.compute.totalGpus} GPUs · ${chapter.compute.layouts?.length ? chapter.compute.layouts.map(l=>l.nodes+' × '+l.gpusPerNode).join(' or ') : chapter.compute.totalGpus ? chapter.compute.nodes+' machine'+(chapter.compute.nodes===1?'':'s') : 'CPU lab'}`
        : 'Compute requirements pending review';
      compute.title=chapter.compute.note;row.append(compute);
    }
    const progress = document.createElement('small'); progress.className = 'chapter-coverage';
    progress.textContent = practical ? (chapter===upNext?'Pick up here · ':'')+browserTaskLabel(taskStatus)
      : (chapter === upNext ? (chapter.progress?.status === 'not_started' ? 'Up next · ' : 'Pick up here · ') : '') + coverageLabel(chapter.progress);
    row.append(progress);
    if (!practical && chapter.progress?.topics.length) {
      const topics = document.createElement('details'), summary = document.createElement('summary');
      topics.className = 'chapter-topics'; topics.dataset.chapter = chapter.id;
      topics.open = openTopics.has(chapter.id);
      summary.textContent = 'Topics (' + chapter.progress.topics.length + ')';
      topics.innerHTML = topicCoverageHtml(chapter.progress);
      topics.prepend(summary); row.append(topics);
    }
  }
  if (chapters.length && mode === 'tutor') {
    const note = document.createElement('small'); note.className = 'course-coverage'; note.textContent = practical ? browserProgressNote : coverageNote; list.append(note);
  }
  if (chapters.some(chapter => chapter.expired)) {
    const note = document.createElement('small'); note.id = 'lesson-access-note'; note.className = 'muted';
    note.textContent = 'Access to this course ended. Your saved notebooks stay on this computer; buy the course again in Course Catalog to keep learning. This list refreshes when you come back.';
    list.append(note);
  }
  if (!chapters.length) list.textContent = 'No lessons available. Open Course Catalog to view your courses.';
  else if (!grid.childElementCount) list.textContent = 'No chapters match your search.';
}
function clearDocument(keepAttachments = false) {
  composer.cancelCapture();
  clearTimeout(saveTimer); documentKey = ''; saveSequence = 0; savedTextDraft = undefined;
  if (notebookSaveStatus) notebookSaveStatus.textContent = '';
  if (!keepAttachments) attachments.clear();
  askInsteadOf = ''; editors.restartRuntime();
  restoreNotebook(emptyNotebook());
}
function chooseLesson(next:Mode = mode) {
  if (selectionPage) selectionOpen = true;
  close('Loading your lessons…'); mode = next; selectedLesson = ''; lessonCourses = [];
  loadingLessons = true; lessonLoadError = '';
  const course = byId<HTMLSelectElement>('lesson-course'); if (course) course.replaceChildren();
  clearDocument(); controls(); renderLessons(); button('tutor').hidden = true;
  host.postMessage({type:'tutorLessons', attempt});
}
/** Refreshes the lesson list in place, for example after the learner bought a course in the catalog. */
function reloadLessons() {
  if (practiceMode || selectedLesson || loadingLessons || !byId('lesson-list')) return;
  loadingLessons = true; lessonLoadError = ''; status.textContent = 'Loading your lessons…';
  button('tutor').hidden = true;
  renderLessons(); host.postMessage({type:'tutorLessons', attempt});
}
type NotebookReply = {content?:string; ladderNote?:string; error?:string; accessEnded?:boolean; audioId?:string | null; choices?:string[]; replies?:string[]; strategy?:string; line?:number};
/** Ended course access is a next step, not a raw error: say so and offer the catalog. */
function accessNotice(message?: string) {
  let notice = document.getElementById('access-notice');
  if (!message) { if (notice) notice.hidden = true; return; }
  if (!notice) {
    notice = document.createElement('div'); notice.id = 'access-notice'; notice.className = 'access-notice'; notice.setAttribute('role', 'alert');
    const text = document.createElement('p'), open = document.createElement('button');
    open.type = 'button'; open.textContent = 'Open Course Catalog'; open.onclick = () => host.postMessage({type:'courseCatalog'});
    notice.append(text, open);
    const anchor = status.parentElement;
    if (anchor && anchor !== document.body) anchor.after(notice); else document.body.prepend(notice);
  }
  notice.querySelector('p')!.textContent = message; notice.hidden = false;
}
/** Another window saved this notebook. The learner decides which copy to keep; nothing is overwritten silently. */
function notebookConflict(show: boolean) {
  let bar = document.getElementById('notebook-conflict');
  if (!show) { bar?.remove(); return; }
  if (bar) return;
  bar = document.createElement('div'); bar.id = 'notebook-conflict'; bar.className = 'notebook-conflict';
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Notebook changed in another window');
  const reload = document.createElement('button'), keep = document.createElement('button');
  reload.type = keep.type = 'button'; reload.textContent = 'Reload newer copy'; keep.textContent = 'Keep this window’s version';
  reload.title = 'Replace this window’s unsaved edits with the copy saved in the other window';
  keep.title = 'Save this window’s notebook over the other window’s copy';
  reload.onclick = () => host.postMessage({type:'reloadNotebook', documentKey});
  keep.onclick = () => host.postMessage({type:'overwriteNotebook', documentKey, notebook:snapshotNotebook()});
  bar.append(reload, keep);
  (notebookSaveStatus ?? status).after(bar);
}
// Doubt Solver keeps each doubt separate: a divider cell starts a new one with a new id.
let pendingDoubt = '', attachmentRole: AttachmentRole = 'question';
let struggles = 0, idleTimer: ReturnType<typeof setTimeout> | undefined, idleQuestion = '';
const isDivider = (cell: NotebookCell) => cell.packet?.doubt_divider === true && typeof cell.packet.doubt_id === 'string';
function doubtCells() {
  const start = notebook.cells.map(isDivider).lastIndexOf(true);
  return notebook.cells.slice(start + 1);
}
function currentDoubt() {
  if(notebook.doubtId)return notebook.doubtId;
  const divider = [...notebook.cells].reverse().find(isDivider);
  return divider ? divider.packet!.doubt_id as string : pendingDoubt ||= crypto.randomUUID();
}
/** Earlier conversation of the current doubt only, for a reconnecting Doubt Solver. */
function doubtRecap() {
  return doubtCells().filter(cell => ['message', 'board', 'voice'].includes(cell.kind) && cell.text.trim()).slice(-8)
    .map(cell => ({role:cell.kind === 'message' ? 'learner' as const : 'doubt_solver' as const, text:cell.text.slice(0, 1500)}));
}
let doubtContext: {chapter_id?: string; lesson_name?: string} = {};
function switchPayload(grant: {chapterId?: string; lesson?: {subject: string; name: string}}) {
  if (mode === 'tutor') return {mode, language:coachLanguage, chapter_id:grant.chapterId,
    notebook_resume:notebookResume(snapshotNotebook()),
    ...(mediaAllowed ? {lesson_subject:grant.lesson?.subject, lesson_name:grant.lesson?.name} : {})};
  const payload = {mode, language:coachLanguage, doubt_id:currentDoubt(), recap:doubtRecap(), ...doubtContext};
  // LiveKit RPC payloads are byte bounded: drop the oldest recap items first.
  while (payload.recap.length && new TextEncoder().encode(JSON.stringify(payload)).length > 14000) payload.recap.shift();
  if (!payload.recap.length) return {mode, language:coachLanguage, doubt_id:payload.doubt_id, ...doubtContext};
  return payload;
}
function newDoubt() {
  if (sending || mode !== 'doubt_solver' || practiceMode || !documentKey) return;
  switchChat({newChat:true,chapter:selectedLesson});
}
let chatSwitchPending=false;
function switchChat(chat:{newChat?:boolean;chatId?:string;chapter:string}) {
  if(sending || chatSwitchPending)return;
  chatSwitchPending=true;sending=true;controls();
  host.postMessage({type:'switchDoubtChat',documentKey,notebook:snapshotNotebook(),...chat});
}
const chatHistory = document.getElementById('doubt-history') as HTMLDetailsElement | null;
if(chatHistory)chatHistory.ontoggle=()=>{if(chatHistory.open)host.postMessage({type:'doubtHistory'});};
function renderChatHistory(chats: {id:string;title:string;course:string;chapter:string}[]) {
  const list=document.getElementById('doubt-chat-list'); if(!list)return;
  list.replaceChildren();
  for(const chat of chats) {
    const item=document.createElement('button'); item.type='button';item.className='quiet';
    const title=document.createElement('strong'),context=document.createElement('small');
    title.textContent=chat.title;context.textContent=chat.course;
    item.append(title,context); item.setAttribute('aria-current',String(chat.id===notebook.doubtId));
    item.onclick=()=>{if(sending)return;switchChat({chatId:chat.id,chapter:chat.chapter});};
    list.append(item);
  }
  if(!chats.length)list.textContent='Your chats will appear here after you choose a chapter.';
}

let notebookCounter = 0, pendingNotebook: {request:number; finish:(reply:NotebookReply) => void} | undefined;
const replyContexts = new Map<string, CodeSnapshot & {skillStage?:SkillStage}>();
const activeSkills = new Map<string, SkillStage>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function snapshotNotebook(): TutorNotebook { return {...notebook, textDraft:field.value, ...(mode==='doubt_solver'?{attemptDraft:(document.getElementById('doubt-tried') as HTMLTextAreaElement|null)?.value ?? ''}:{}), drafts: editors.drafts()}; }
function lessonXp() {
  return notebook.cells.reduce((total, cell) => total + (Number.isSafeInteger(cell.packet?.xp) && Number(cell.packet?.xp) > 0 ? Number(cell.packet!.xp) : 0), 0);
}
function saveNotebook(immediate=false) {
  if (restoring || !documentKey) return;
  clearTimeout(saveTimer);
  const save=() => {
    host.postMessage({type:'notebookChanged', documentKey, sequence:++saveSequence, notebook:snapshotNotebook()});
  };
  if(immediate)save();else saveTimer = setTimeout(save, 250);
}
/** A closing line "Your turn: …" becomes its own cell that stays open until the learner replies. */
function splitYourTurn(text: string): {body: string; turn?: string} {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].trim()) continue;
    const match = lines[index].match(/^\s*(?:[*_]{1,2})?Your turn:(?:[*_]{1,2})?\s*(.+?)\s*$/);
    return match ? {body:lines.slice(0, index).join('\n').trimEnd(), turn:match[1].replace(/^[*_]{1,2}\s*|\s*[*_]{1,2}$/g, '')} : {body:text};
  }
  return {body:text};
}
function addCell(kind: NotebookCell['kind'], text: string, packet?: Record<string, unknown>) {
  if (kind === 'message' && !packet?.action && !packet?.notebook_help)
    for (const turn of feed.querySelectorAll('.your-turn.is-open')) turn.classList.remove('is-open');
  const cell: NotebookCell = {id:'cell-' + Date.now().toString(36) + '-' + ++cellSequence, kind, text, ...(packet ? {packet} : {})};
  if (packet?.session_summary) feed.querySelectorAll('.execution-followup, .recap-actions').forEach(el => el.remove());
  notebook.cells.push(cell); renderCell(cell); saveNotebook(); refreshNavigation();
  if (kind === 'board') refreshDiagramAlternatives();
  if (!practice && ready) { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
  return cell;
}
function restoreNotebook(value: TutorNotebook) {
  document.getElementById('runtime-restore')?.remove();
  closeVisual();
  cancelRemoval?.();
  activeSkills.clear();
  pendingNotebook?.finish({error:'The notebook changed. Ask ' + names[mode] + ' again.'});
  replyContexts.clear();
  restoring = true;
  notebook = readNotebook(value);
  field.value = notebook.textDraft ?? '';
  const tried=document.getElementById('doubt-tried') as HTMLTextAreaElement|null;
  if (tried) {
    tried.value=notebook.attemptDraft??'';
    const details=tried.closest('details');
    if (details && tried.value) details.open=true;
  }
  editors.restore(notebook.drafts); editors.update(ready, attempt);
  feed.replaceChildren();
  for (const cell of notebook.cells) renderCell(cell);
  const chapter = lessonCourses.flatMap(course => course.chapters).find(ch => ch.id === selectedLesson);
  refreshSummary(chapter?.progress && chapter.progress.status !== 'unavailable' ? chapter.progress.topics : undefined);
  const savedActions = document.getElementById('saved-task-actions');
  savedActions?.replaceChildren();
  if (savedActions && !practiceMode && mode === 'tutor') {
    const pending = unfinishedQuestion(notebook);
    if (typeof pending?.packet?.tutor_checkpoint_id === 'string' && !pending.packet.resume_unverified)
      editors.checkpoint(pending.packet.tutor_checkpoint_id);
    const target = pending ?? [...notebook.cells].reverse().find(cell => cell.kind === 'board' || cell.kind === 'code');
    if (target && notebookResume(notebook)) {
      const bar = document.createElement('div'), detail = document.createElement('small');
      bar.id = 'stopping-point'; bar.dataset.target = target.id;
      const resume = document.createElement('button'), confirm = document.createElement('button');
      resume.type = confirm.type = 'button';
      resume.textContent = 'Return to stopping point';
      resume.onclick = () => goToNotebookCell(target.id);
      confirm.id = 'confirm-saved-task';
      confirm.textContent = 'Ask Instructor to confirm';
      confirm.onclick = () => { void sendLive('Please confirm my saved task before I submit an answer.', false, 'Please confirm my saved task.'); };
      bar.append(detail, resume, confirm); savedActions.append(bar);
    }
  }
  refreshDiagramAlternatives();
  if (practice && ready && notebook.exerciseId === practice.id) editors.checkpoint('practice:' + practice.id);
  restoring = false; updateLatest();
  showBrowserProgress();
  controls();
}
function updateConversationCard(cell: NotebookCell, row = feed.querySelector<HTMLElement>(`[data-cell-id="${cell.id}"]`)) {
  const body = row?.querySelector<HTMLElement>(':scope > .conversation-body');
  const toggle = row?.querySelector<HTMLButtonElement>('[data-collapse]');
  if (!body || !toggle) return;
  const preview=row?.querySelector<HTMLElement>('.conversation-preview');
  if(preview && validBrowserQuestion(cell.packet?.browser_question)) {
    const question=cell.packet!.browser_question as BrowserQuestion;
    preview.textContent=(cell.packet!.browser_question_closed?'Earlier ':'')+question.kind+' · '+question.title;
  }
  body.hidden = cell.collapsed === true;
  toggle.textContent = cell.collapsed ? 'Expand' : 'Collapse';
  toggle.setAttribute('aria-expanded', String(!cell.collapsed));
  row!.classList.toggle('is-collapsed', !!cell.collapsed);
}
function retractTutorRequest(request: string) {
  const live = room, destinationIdentity = agent;
  if (!live || !destinationIdentity || !pendingTutorRequests.delete(request)) return;
  retractedTutorRequests.add(request);
  if (request === lastTutorRequest) {
    tutorOutputPaused = true;
    for (const el of audio) el.muted = true;
    showAgentActivity();
  }
  // Keep the composer editable. A corrected answer can be sent immediately,
  // but reaches the worker after it has reopened the original checkpoint.
  const ack = live.localParticipant.performRpc({destinationIdentity, method:'cancel_tutor_request',
    payload:JSON.stringify({tutor_request_id:request}), responseTimeout:8000});
  tutorCancellation = Promise.all([tutorCancellation, ack]).then(([, result]) => {
    if (result !== 'ok') throw new Error('Cancellation unavailable');
  }).catch(() => {
    if (room === live) close('Instructor could not confirm cancellation. Reconnect Instructor to continue.');
  });
}
function removeConversation(cells: NotebookCell[]) {
  if (sending) return;
  const ids = new Set(cells.filter(conversationCell).map(cell => cell.id));
  for (const cell of cells) {
    const request = packetTurn(cell.packet);
    if (cell.kind !== 'message' || !ids.has(cell.id) || !pendingTutorRequests.has(request)) continue;
    retractTutorRequest(request);
    for (const other of notebook.cells) {
      if (packetTurn(other.packet) === request) ids.add(other.id);
      if (other.packet?.student_answer_request_id === request && !other.packet.feedback_received) {
        delete other.packet.student_answer;
        delete other.packet.student_answer_request_id;
        if (other.packet.browser_question_id === browserAnswered) browserAnswered = '';
      }
    }
  }
  notebook.cells = notebook.cells.filter(cell => !ids.has(cell.id));
  for (const id of ids) { editors.removeCell(id); feed.querySelector(`[data-cell-id="${id}"]`)?.remove(); replyContexts.delete(id); }
  removeCellFollowups(ids); refreshDiagramAlternatives();
  if (!practiceMode) { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
  saveNotebook(true); controls(); updateLatest();
}
function conversationControls(body: HTMLElement, cell: NotebookCell) {
  if (!conversationCell(cell) || (!practiceMode && cell.packet?.is_question_prompt)) return;
  const row = body.parentElement!, label = row.firstElementChild!;
  const header = document.createElement('div'), bar = document.createElement('div');
  header.className = 'conversation-header'; bar.className = 'cell-actions';
  row.prepend(header); header.append(label, bar);
  const preview = document.createElement('span'); preview.className = 'conversation-preview';
  preview.textContent = (cell.kind === 'board' ? markdownPlainText(cell.text) : cell.text).replace(/\s+/g, ' ').slice(0, 100); row.append(preview);
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
/** Use teaching text from this turn only; an older doubt is never a fallback. */
function refreshDiagramAlternatives() {
  for (const row of feed.querySelectorAll<HTMLElement>('[data-cell-id]')) {
    const fallback = row.querySelector<HTMLElement>('.diagram-unavailable');
    if (!fallback) continue;
    const index = notebook.cells.findIndex(cell => cell.id === row.dataset.cellId);
    if (index < 0 || notebook.cells[index].kind !== 'diagram') continue;
    let start = index, end = index + 1;
    const boundary = (cell: NotebookCell) => cell.kind === 'message' || isDivider(cell);
    while (start > 0 && !boundary(notebook.cells[start - 1])) start--;
    while (end < notebook.cells.length && !boundary(notebook.cells[end])) end++;
    const explanation = notebook.cells.slice(start, end).filter(cell => cell.kind === 'board'
      && !cell.packet?.notebook_help && !cell.packet?.data_part && !cell.packet?.is_question_prompt)
      .map(cell => cell.text).join('\n\n');
    let alternative = row.querySelector<HTMLElement>('.diagram-alternative');
    if (!explanation) { alternative?.remove(); continue; }
    if (!alternative) { alternative = document.createElement('div'); alternative.className = 'diagram-alternative'; fallback.after(alternative); }
    // Reuse the same math/Markdown rendering as the original explanation card.
    alternative.innerHTML = renderBoard(explanation);
  }
}
function renderCell(cell: NotebookCell) {
  if (cell.kind === 'board' && typeof cell.packet?.data_part === 'string') { renderDataCell(cell); return; }
  // Older saved notebooks may already contain both the image event and its
  // Markdown copy. Filter their presentation without rewriting saved work.
  let text = restoring && mode === 'tutor' && ['board', 'diagram'].includes(cell.kind)
    ? instructorVisuals(cell.text, cell.packet ?? {}, notebook.cells.slice(0, notebook.cells.indexOf(cell))) : cell.text;
  if (!text.trim() && cell.kind === 'board' && cell.packet?.is_question_prompt) text='Use the figure above to answer.';
  if (!text.trim() && cell.text.trim()) return;
  if (cell.kind === 'board') { renderTeaching(cell, text); return; }
  if (isDivider(cell)) {
    const row = document.createElement('article'), label = document.createElement('small');
    row.className = 'doubt-divider'; row.dataset.cellId = cell.id; row.setAttribute('role', 'separator');
    label.textContent = 'New doubt'; row.setAttribute('aria-label', 'New doubt'); row.append(label); feed.append(row);
    return;
  }
  appendCard(cell.kind === 'note' ? 'private-note' : ['message','code'].includes(cell.kind) ? 'student' : 'assistant', body => {
    body.parentElement?.setAttribute('data-cell-id', cell.id);
    body.parentElement!.dataset.entryKind = cell.kind;
    if (cell.kind === 'note') {
      const note = document.createElement('textarea'); note.value = cell.text; note.rows = 4; note.maxLength = 12000;
      note.setAttribute('aria-label','My notes'); note.placeholder = 'A private note. It stays on this computer and is never sent to Instructor.';
      note.oninput = () => { cell.text = note.value; saveNotebook(); };
      // Notes are private by default; sharing one is a separate, deliberate step.
      const share = document.createElement('button'); share.textContent = 'Share with Instructor'; share.className = 'quiet note-share';
      share.title = 'Send this note to Instructor and discuss it'; share.dataset.share = 'note';
      share.onclick = () => { if (note.value.trim()) void send('Discuss my notes with me:\n' + note.value, false, note.value, 'hint'); };
      body.parentElement?.classList.add('note-cell'); body.append(note, share);
    } else if (cell.kind === 'code') {
      editors.add(body, cell.id + ':0', typeof cell.packet?.language === 'string' ? cell.packet.language : 'python', cell.text);
      if (cell.packet?.starterExample === 'data-science-python') {
        const alternative = document.createElement('p'), browser = document.createElement('a');
        const url = new URL('https://jupyterlite.github.io/demo/repl/index.html');
        url.search = new URLSearchParams({kernel:'python', toolbar:'1', execute:'0', code:firstPandasCell}).toString();
        browser.href = url.href; browser.textContent = 'Open the original example in JupyterLite';
        alternative.append('Waiting for your runtime? ', browser, ' and press Shift+Enter to run it in your browser.');
        body.append(alternative);
      }
    } else if (cell.kind === 'diagram') {
      body.innerHTML = cell.packet?.image_url ? renderBoard(text) : diagram(text);
      if (typeof cell.packet?.label === 'string') {
        const caption = document.createElement('small'); caption.textContent = cell.packet.label; body.append(caption);
      }
    }
    else if (cell.kind === 'recap') {
      const starter = starterExercises.find(item => item.courseId === cell.packet?.starterExercise);
      if (starter) {
        const title = document.createElement('h3'), prompt = document.createElement('p'), choices = document.createElement('div');
        title.textContent = 'First exercise'; prompt.textContent = starter.question;
        choices.className = 'starter-answers'; choices.setAttribute('role','group'); choices.setAttribute('aria-label',starter.question);
        const feedback = document.createElement('p'); feedback.setAttribute('role','status');
        let edit: HTMLButtonElement | undefined;
        const showAnswer = () => {
          const answer = cell.packet?.starterAnswer;
          const complete = answer === starter.correct;
          // A wrong choice is answered by its own misconception; the general hint covers any other.
          feedback.textContent = complete ? 'Exercise complete. ' + starter.feedback
            : typeof answer === 'number' ? starter.why?.[answer] || starter.hint : '';
          for (const [index, choice] of [...choices.querySelectorAll('button')].entries()) {
            choice.setAttribute('aria-pressed', String(index === answer));
            choice.disabled = complete;
          }
          // Predict first: running the code is how the learner checks a prediction, not a way around making one.
          if (edit) edit.hidden = typeof answer !== 'number';
        };
        starter.choices.forEach((label, index) => {
          const choice = document.createElement('button'); choice.type = 'button'; choice.textContent = label;
          choice.onclick = () => { cell.packet!.starterAnswer = index; showAnswer(); saveNotebook(true); controls(); };
          choices.append(choice);
        });
        body.append(title, prompt);
        if (starter.source) {
          const code = document.createElement('pre'); code.textContent = starter.source; body.append(code);
        }
        body.append(choices, feedback);
        if (starter.source) {
          edit = document.createElement('button'); edit.type = 'button'; edit.className = 'starter-run'; edit.textContent = 'Run it to check';
          edit.onclick = () => {
            const existing = notebook.cells.find(item => item.kind === 'code' && item.packet?.starterExample === starter.courseId);
            const example = existing ?? addCell('code', starter.source!, {language:starter.language, starterExample:starter.courseId});
            const row = [...feed.querySelectorAll<HTMLElement>('[data-cell-id]')].find(item => item.dataset.cellId === example.id);
            if (row) scrollToNotebookRow(row);
            row?.querySelector<HTMLElement>('.cm-content')?.focus();
          };
          body.append(edit);
        }
        showAnswer();
      } else {
        body.innerHTML = renderBoard(cell.text);
        if (cell.packet?.session_summary) summaryActions(body, cell);
      }
    }
    else if (cell.kind === 'voice') { const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p'); summary.textContent = 'Spoken explanation'; text.textContent = cell.text; details.append(summary, text); body.append(details); }
    else { body.className = 'learner-message'; body.textContent = cell.text; }
    prepareVisuals(body);
    conversationControls(body, cell);
    if (cell.kind === 'code' || cell.kind === 'note') {
      const row = body.parentElement!, header = document.createElement('div'), remove = document.createElement('button');
      header.className = 'cell-header'; header.append(row.firstElementChild!); row.prepend(header);
      remove.type = 'button'; remove.className = 'quiet'; remove.dataset.removeCell = '';
      remove.textContent = cell.kind === 'code' ? 'Delete code cell' : 'Delete note';
      remove.onclick = () => confirmRemoval(remove, remove.textContent + '? This removes its saved content from this notebook.', () => {
        editors.removeCell(cell.id); notebook.cells = notebook.cells.filter(item => item !== cell);
        row.remove(); removeCellFollowups(new Set([cell.id])); replyContexts.clear(); activeSkills.clear();
        if (cell.kind === 'code') { const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run); }
        saveNotebook(); controls(); updateLatest();
      });
      header.append(remove);
    }
  }, !restoring && nearBottom());
  if (cell.kind === 'diagram' && !restoring) refreshDiagramAlternatives();
}
const toolReplies = new Map<number, (reply: ToolReply) => void>();
let toolCounter = 0;
const debugReplies = new Map<number, (reply:NativeDebugReply) => void>();
const editors = new PracticeCodeEditors({
  executionFinished: (key, snapshot, run, error, expected) => {
    notebook.executionIssues = recordExecutionIssue(notebook.executionIssues ?? [], key, snapshot.snippet, run, error, expected);
    refreshSummary();
    saveNotebook();
  },
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
  if(freecad)return;
  if (mediaAllowed) {
    // Flutter rooms use the same Instructor but do not expose the extension-only observation RPC.
    byId('code-observer-status').textContent = `Use Ask ${names[mode]} to share a cell from this notebook.`;
    return;
  }
  const shared = notebookContext(notebook.cells, editors.contexts(), snapshot?.snippet);
  const sharing = visible && editors.following && editors.aiEnabled;
  const payload = sharing && snapshot ? {
    sequence: observationSequence + 1, notebook:shared, snippet: snapshot.snippet, revision: snapshot.revision,
    language: snapshot.language, source: snapshot.source.slice(0, 4000), question: snapshot.question.slice(0, 1200),
    stdin: snapshot.stdin.slice(0, 600), guidance: (guidance ?? '').slice(0, 1200),
    source_truncated: snapshot.source.length > 4000, input_truncated: snapshot.stdin.length > 600,
    run: run ? {...run, output: run.output.slice(0, 2000), stderr: run.stderr.slice(0, 800),
      incomplete: run.incomplete || run.output.length > 2000 || run.stderr.length > 800} : null,
  } : sharing && shared.cells.length ? {sequence: observationSequence + 1, notebook:shared} : {sequence: observationSequence + 1, clear: true};
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
  const content=JSON.stringify({...payload,sequence:0});
  if(content===observationContent)return;
  observationContent=content;observationSequence=payload.sequence;
  latestObservation = live.localParticipant.performRpc({destinationIdentity: dest, method: 'on_editor_activity',
    payload: JSON.stringify(payload), responseTimeout: 6000}).then(result => {
      if (id !== attempt || payload.sequence !== observationSequence) return;
      if(result!=='ok')observationContent='';
      byId('code-observer-status').textContent = result === 'ok' ? shown : unavailable;
    }).catch(() => {
      if (id === attempt && content===observationContent) {observationContent='';byId('code-observer-status').textContent = unavailable;}
    });
}

function controls() {
  const stoppingPoint = document.getElementById('stopping-point');
  if (stoppingPoint) {
    const target = notebook.cells.find(cell => cell.id === stoppingPoint.dataset.target);
    if (!target || (target.packet?.is_question_prompt && unfinishedQuestion(notebook) !== target)) {
      stoppingPoint.remove();
    } else {
      const confirm = button('confirm-saved-task');
      confirm.hidden = target.packet?.resume_unverified !== true;
      confirm.disabled = !ready || sending;
      stoppingPoint.querySelector('small')!.textContent = !confirm.hidden ? 'This saved task needs Instructor confirmation.'
        : !target.packet?.is_question_prompt ? '' : typeof target.packet.student_answer === 'string'
          ? 'Your last answer is awaiting feedback.' : 'Your last “Your turn” is still waiting for your answer.';
    }
  }
  updateSelectionPage();
  document.body.classList.toggle('room-ready', ready);
  refreshNavigation();
  showLessonPlaceholder();
  showAgentActivity();
  if (workspaceMode) workspaceMode.disabled = workspaceBusy || sending;
  selectRoomTab();
  if (workspaceMode) button('doubt_solver').hidden = mode !== 'doubt_solver';
  button('tutor').disabled=sending;
  button('doubt_solver').textContent = mode === 'doubt_solver' ? 'Open in Instructor' : 'Open Doubt Solver';
  const course = lessonCourses.find(course => course.chapters.some(chapter => chapter.id === selectedLesson));
  const chapterIndex = course?.chapters.findIndex(chapter => chapter.id === selectedLesson) ?? -1;
  if (byId('notebook-mode')) byId('notebook-mode').textContent = practiceMode
    ? practice?.course || 'DHIMANTAI · PRACTICE NOTEBOOK'
    : course ? `${course.name} · Chapter ${chapterIndex + 1} of ${course.chapters.length}` : names[mode];
  if (byId('tutor-lessons')) byId('tutor-lessons').hidden = practiceMode;
  const choosing = !practiceMode && !selectedLesson;
  const assessment=button('crt-assessment');
  if (assessment) {
    assessment.hidden=practiceMode || mode!=='tutor' || !assessment.dataset.lessons?.split(' ').includes(selectedLesson);
    assessment.onclick=()=>host.postMessage({type:'crtAssessment',lesson:selectedLesson});
  }
  const previous = button('previous-chapter'), prior = adjacentChapter(true);
  if (previous) {
    previous.hidden = practiceMode || !selectedLesson;
    previous.disabled = !prior || sending || workspaceBusy;
    previous.title = prior ? 'Review ' + (prior.lesson || prior.name) : 'First available chapter';
  }
  const skip=button('skip-chapter'),next=adjacentChapter();
  if(skip) {
    skip.hidden=practiceMode || mode!=='tutor' || !selectedLesson;
    skip.disabled=!next || sending || workspaceBusy;
    skip.title=next?'Skip to '+(next.lesson||next.name)+'. This does not mark the current chapter complete.':'You are at the last available chapter.';
  }
  if (messageBar) messageBar.hidden = choosing;
  // A new learner's first screen asks for one thing: a prediction. Notebook tools and the runtime picker
  // arrive with the first answer (or with any cell the learner already made).
  const predicting = notebook.cells.some(cell => typeof cell.packet?.starterExercise === 'string' && typeof cell.packet.starterAnswer !== 'number')
    && !notebook.cells.some(cell => cell.kind === 'code' || cell.kind === 'note');
  const notebookTools = document.querySelector<HTMLElement>('.notebook-tools');
  if (notebookTools) notebookTools.hidden = choosing || predicting;
  const runtime = document.getElementById('course-runtime');
  if (runtime) runtime.hidden = predicting;
  if (heading) {
    const lesson = course?.chapters[chapterIndex];
    heading.innerHTML = renderHeading(practiceMode ? practice?.title || (notebook.exerciseId && notebook.title) || initialTitle
      : mode === 'doubt_solver' ? lesson?.lesson || lesson?.name || 'Ask a specific question' : lesson?.lesson || lesson?.name || 'Choose a lesson');
  }
  byId('composer').hidden = choosing;
  for (const id of ['add-code', 'add-note', 'save-notebook', 'open-notebook']) if (button(id)) button(id).disabled = !documentKey;
  const notes = button('course-notes');
  if (notes) notes.disabled = !documentKey || notes.hasAttribute('data-unscoped');
  editors.tutorBusy = coaching;
  // Both learning modes own executable cells and share the active public notebook.
  editors.update(ready, attempt);
  if (button('clear-conversation')) button('clear-conversation').disabled = sending || !notebook.cells.some(conversationCell);
  updateHelpReplies();
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-practice-strategy], #practice-help')) action.disabled = sending || !ready || !editors.aiEnabled;
  for (const action of feed.querySelectorAll<HTMLButtonElement>('[data-remove-conversation], [data-remove-cell], [data-confirm-delete]')) action.disabled = sending;
  dictation?.setScope(!mediaAllowed && visible && ready && !selectionOpen && !sending && editors.aiEnabled ? documentKey : '');
  composerMode();
  updateLessonActions();
  dataControls();
  byId<HTMLInputElement>('follow-code').disabled = !ready || !editors.aiEnabled || !!practice;
  byId<HTMLInputElement>('stuck-hints').disabled = !ready || mode !== 'tutor' || !editors.aiEnabled || !editors.following || !!practice;
  composer.setAvailable(visible && !selectionOpen && ready && !sending && (!practice || editors.aiEnabled));
  button('video').disabled = !ready || sending || !!practice;
  button('teach-back').disabled = !ready || sending;
  for(const action of feed.querySelectorAll<HTMLButtonElement>('[data-browser-question]'))
    action.disabled=!ready || sending || action.dataset.browserQuestion!==browserQuestion?.id || action.dataset.browserQuestion===browserAnswered;
  speaker?.update(!voice || blockedAudio, false, blockedAudio ? 'Enable speaker' : undefined);
  updateMediaControls();
}
function writtenCheckpoint(packet: Record<string, unknown>) {
  if (!packet.is_question_prompt) return false;
  if (packet.tutor_answer_kind === 'written') return true;
  const task = packet.tutor_practice_editor as {source?: string; question?: string} | undefined;
  if (!task) return packet.tutor_answer_kind !== 'code';
  if (packet.tutor_answer_kind === 'code' || task.source !== 'Your turn' || typeof task.question !== 'string') return false;
  // Older generated questions sometimes identified the language of the example as the answer type.
  const prose = task.question.slice(0, 6000).replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, ' ').replace(/`[^`\n]*`/g, ' ');
  return /\b(?:predict|explain|describe|justify|summarize|state the (?:printed line|output)|which (?:printed )?line|in your own words|what (?:does|do|will|would|is)|does the loop)\b/i.test(prose)
    && !/(?:^|[.!?,:\n—]|\b(?:and|then|please|can you|your task is to)\s+)\s*(?:implement|modify|rewrite|edit|fix|complete|write|create|change)\s+(?:(?:a|the|this|python|new)\s+)*(?:program|function|code|loop|comparison|statement|blank)\b/i.test(prose);
}

/** Instructor's latest open written question, answered from the separate message bar. */
function openQuestion(): NotebookCell | undefined {
  if (practice || mode !== 'tutor') return;
  const cell = [...notebook.cells].reverse().find(c => c.kind === 'board' && c.packet?.is_question_prompt);
  const p = cell?.packet;
  if (!p || typeof p.tutor_checkpoint_id !== 'string' || !writtenCheckpoint(p) || p.feedback_received || typeof p.student_answer === 'string'
      || p.tutor_checkpoint_id !== editors.activeCheckpoint || p.tutor_checkpoint_id === askInsteadOf) return;
  return cell;
}
function composerMode() {
  if (!askInstead) {
    askInstead = document.createElement('button');
    askInstead.type = 'button'; askInstead.className = 'quiet ask-instead'; askInstead.textContent = 'Ask a question instead';
    askInstead.onclick = () => { const q = openQuestion(); if (q) askInsteadOf = String(q.packet!.tutor_checkpoint_id);
      if(browserQuestion)browserAskInstead=browserQuestion.id;controls();field.focus(); };
    (byId('composer-mode-actions') ?? byId('composer')).prepend(askInstead);
  }
  const browserPrompt=attachments.count?undefined:openBrowserQuestion();
  const question = attachments.count ? undefined : openQuestion(), label = document.querySelector('label[for="message"]');
  const replying=!!browserPrompt || !!question;
  const assistant = names[mode];
  if (label) label.textContent = replying ? 'Your answer to Instructor' : 'Ask ' + assistant;
  field.placeholder = replying ? 'Your answer and reasoning…' : `Ask ${assistant} or reply…`;
  const action = replying ? 'Answer Instructor' : 'Ask ' + assistant;
  button('send').title = action; button('send').setAttribute('aria-label', action);
  if (byId('send-label')) byId('send-label').textContent = action;
  const context = byId('composer-context');
  if (context) {
    const prompt = markdownPlainText(browserPrompt?.question ?? question?.text ?? '');
    context.hidden = !prompt;
    context.textContent = prompt ? 'Replying to: ' + prompt.slice(0, 180) + (prompt.length > 180 ? '…' : '') : '';
  }
  askInstead.hidden = !replying;
  if (!practiceMode && mode === 'tutor') watchIdle(question);
  doubtComposer();
  for (const hint of feed.querySelectorAll<HTMLElement>('[data-question-hint]'))
    hint.hidden = hint.dataset.questionHint !== question?.packet?.tutor_checkpoint_id;
}
/** The message bar answers Instructor's open question, or asks one. Attachments go with a question. */
async function deliverNotebookMessage(message: LearnerMessage): Promise<boolean> {
  if (!ready) { showDeliveryIssue('Reconnect, then send again.'); return false; }
  if (sending) { helpStatus('Sending your message…'); return false; }
  const browserPrompt=message.attachments.length?undefined:openBrowserQuestion();
  if(browserPrompt) {
    const text=message.text.trim(),id=attempt;
    if(!validBrowserAnswer(browserPrompt,text)) {
      helpStatus(browserPrompt.options.length?'Choose one of the prediction options in Instructor.'
        : `Write ${browserPrompt.minLength}–${browserPrompt.maxLength} characters in your own words.`);return false;
    }
    const cell=notebook.cells.find(c=>c.packet?.browser_question_id===browserPrompt.id);
    const ok=await sendLive(browserAnswerMessage(browserPrompt,text),false,text,undefined,cell);
    if(ok && id===attempt) {
      browserAnswered=browserPrompt.id;
      host.postMessage({type:'browserAnswer',attempt,id:browserPrompt.id,answer:text});
      if(field.value.trim()===text)field.value='';
      saveNotebook();
      helpStatus(browserPrompt.kind==='prediction'?'Prediction sent. Continue the practical step in the browser.'
        :browserPrompt.kind==='reflection'?'Reflection sent. Read your feedback here.'
        :browserSnapshot?.shift?'Answer sent. Read your feedback here, then Continue.':'Answer sent. Read your feedback here, then choose Next task in the browser.');
    }
    controls();return ok;
  }
  const question = message.attachments.length ? undefined : openQuestion();
  if (!question && !message.attachments.length && dataRoute(message.text)) return sendData(message.text);
  if (!question && mode === 'doubt_solver' && !practiceMode) return sendDoubt(message);
  if (!question) return send(message.text, message);
  const text = message.text, packet = question.packet!;
  if (!text.trim() || sending) return false;
  const ok = await sendLive('TUTOR_NOTEBOOK_ANSWER\n' + JSON.stringify({checkpoint_id:packet.tutor_checkpoint_id, answer:text}), false, text, undefined, question);
  // Backend question identity remains authoritative; delivery alone does not assess it.
  if (ok) {
    if (field.value === text) field.value = ''; saveNotebook();
  }
  controls();
  return ok;
}
// On narrow screens the composer follows the feed. Its height is not chat history.
function nearBottom() {
  const page = notebookPage();
  const bottom = page === document.scrollingElement || page === document.documentElement ? window.innerHeight : page.getBoundingClientRect().bottom;
  return feed.getBoundingClientRect().bottom <= bottom + 48;
}
const edges = document.getElementById('notebook-edges');
if (edges && toolbar) {
  const updateEdges = () => {
    const page = notebookPage();
    // Jump buttons earn their place once the notebook is longer than a screen and a half, not for a few pixels of overflow.
    edges.hidden = !feed.getClientRects().length || page.scrollHeight <= page.clientHeight * 1.5;
    if (page instanceof HTMLElement) page.style.scrollPaddingTop = toolbar.offsetHeight + 'px';
  };
  const observer = new ResizeObserver(updateEdges);
  observer.observe(document.body);
  observer.observe(feed);
  observer.observe(toolbar);
  window.addEventListener('resize', updateEdges);
  button('notebook-top').onclick = () => {
    const title = document.querySelector<HTMLElement>('.workspace-title h1');
    (title?.getClientRects().length ? title : feed).focus({preventScroll:true});
    notebookPage().scrollTop = 0;
  };
  button('notebook-bottom').onclick = () => {
    field.focus({preventScroll:true});
    const page = notebookPage();
    page.scrollTop = page.scrollHeight;
  };
}
function updateLatest() { latestButton.hidden = nearBottom(); }
function appendCard(author: 'student' | 'assistant' | 'private-note', fill: (body: HTMLElement) => void, follow = nearBottom(), replaceRow?: HTMLElement) {
  const row = document.createElement('article'), tag = document.createElement('small'), body = document.createElement('div');
  if (author !== 'private-note') {
    row.dataset.speaker = author;
    tag.className = 'speaker-name';
    tag.textContent = author === 'student' ? 'You' : names[mode];
    const avatar = document.createElement('span');
    avatar.className = 'speaker-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    if (author === 'student') avatar.textContent = feed.dataset.learnerInitial || 'Y';
    tag.prepend(avatar);
  } else tag.textContent = 'Note · only you';
  row.append(tag, body);
  fill(body);
  if (replaceRow) replaceRow.replaceWith(row);
  else feed.append(row);
  // A long answer opens at its beginning. Later packets leave a reader in place.
  if (follow) {
    // The sticky toolbar stays over the page top; open the card just below it.
    scrollToNotebookRow(row);
  }
  updateLatest();
}
document.addEventListener('scroll', updateLatest, true);
feed.addEventListener('toggle', updateLatest, true);
feed.addEventListener('load', updateLatest, true);
window.addEventListener('resize', updateLatest);
button('latest').onclick = () => {
  const latest = [...notebook.cells].reverse().find(conversationCell);
  if (practice && latest) { latest.collapsed = false; updateConversationCard(latest); saveNotebook(); }
  const row = feed.lastElementChild;
  if (row) scrollToNotebookRow(row);
  updateLatest();
};
if (button('clear-conversation')) button('clear-conversation').onclick = () => confirmRemoval(button('clear-conversation'), 'Delete all conversation messages? Your task, code and private notes will stay.', () => removeConversation(notebook.cells));
const focusButton = button('wide'), focusHome = document.createComment('focus view control');
focusButton.before(focusHome);
function focusView(active: boolean) {
  document.body.classList.toggle('focus-view', active);
  focusButton.textContent = active ? 'Exit focus view' : 'Focus view'; focusButton.setAttribute('aria-pressed', String(active));
  placeFocusButton();
  (focusButton.closest('details')?.querySelector<HTMLElement>('summary') ?? focusButton).focus();
}
function placeFocusButton() {
  if (document.body.classList.contains('focus-view') && !compactToolbar?.matches) document.querySelector('.workspace-actions')?.append(focusButton);
  else focusHome.after(focusButton);
}
compactToolbar?.addEventListener('change', placeFocusButton);
focusButton.onclick = () => focusView(!document.body.classList.contains('focus-view'));
function close(message: string) {
  freecad?.close();freecad=undefined;
  const cadStatus=document.getElementById('freecad-status');
  if(cadStatus){cadStatus.hidden=true;cadStatus.textContent='';}
  pendingTutorRequests.clear(); retractedTutorRequests.clear();
  tutorTurn = lastTutorRequest = ''; tutorOutputPaused = false; tutorCancellation = Promise.resolve();
  interruption.reset();
  latestObservation=Promise.resolve();observationContent='';
  if(browserCourse)host.postMessage({type:'browserState',attempt,connected:false,detail:'Instructor disconnected. Reconnect to resume live help.'});
  browserObservationFailed=false;browserActions.close();browserSnapshot=null;browserCourse=false;browserQuestion=null;browserAnswered='';browserAskInstead='';
  stopDevices(); mediaAllowed = false;
  clearTimeout(saveTimer);
  const saved = snapshotNotebook();
  if (documentKey) host.postMessage({type:'notebookChanged', documentKey, sequence:++saveSequence, notebook:saved});
  pendingNotebook?.finish({error:'Session changed.'}); pendingNotebook = undefined;
  pendingData?.finish({error:'Session changed.'}); pendingData = undefined;
  ++attempt; ready = sending = sendingComposerMessage = coaching = false; blockedAudio = false; agent = undefined; agentActivity = '';
  courseData = []; dataState = 'none'; dataStatus('');
  document.querySelector('.data-preview')?.remove();
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
  connectionStatus(message); controls(); host.postMessage({type: 'leave'});
  byId('code-observer-status').textContent = '';
  restoreNotebook(saved);
}
function begin(next: Mode, chapterId = '', reconnect = false, chat?:{newChat?:boolean;chatId?:string}) {
  if (!practiceMode && !chapterId) { chooseLesson(next); return; }
  if (selectionPage) { selectionOpen = false; updateSelectionPage(); }
  if (!reconnect && next === mode && chapterId === selectedLesson && !button('end').disabled) return;
  const retry = !chat && next === mode && chapterId === selectedLesson;
  const saved=retry?snapshotNotebook():undefined;
  close('Connecting to ' + names[next] + '…'); accessNotice();
  if (!retry) { struggles = 0; smallerStep(false); }
  // A retry keeps chosen attachments: they are cleared only after the agent receives them.
  mode = next; selectedLesson = chapterId; clearDocument(retry); if(saved)restoreNotebook(saved); renderLessons();
  voice = voiceByMode.get(mode) ?? true; controls(); button('end').disabled = false;
  button(next).setAttribute('aria-pressed', 'true');
  host.postMessage({type: 'join', mode, attempt, ...(chapterId ? {chapterId} : {}), ...chat, ...(!chat && notebook.doubtId ? {chatId:notebook.doubtId} : {})});
  button('tutor').hidden = true;
  if (practiceMode) status.textContent = 'Opening Practice…';
}
function renderVideo(id: string, embedded: boolean) {
  const entry = videos.get(id);
  if (!entry?.url) return;
  entry.body.replaceChildren();
  if (embedded) {
    const frame = document.createElement('iframe');
    frame.src = entry.url; frame.title = 'dhimantAI lesson video';
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
  appendCard('assistant', body => {
    const heading = document.createElement('h3'); heading.textContent = title; body.before(heading);
    body.textContent = 'Checking the dhimantAI video catalog…';
    videos.set(id, {body, title, topic: typeof data.topic === 'string' ? data.topic : ''});
  });
  host.postMessage({type: 'checkVideo', videoId: id, attempt});
}
function deliveredStep(packet: Record<string, unknown>) {
  const failed = failureStep(packet);
  return typeof packet.tutor_step_id === 'string' && notebook.cells.some(cell =>
    !cell.packet?.operational_notice && (cell.packet?.tutor_step_id === packet.tutor_step_id
      || failed && cell.packet?.tutor_retry_of_step_id === failed));
}
function failureStep(packet: Record<string, unknown>) {
  return typeof packet.tutor_retry_of_step_id === 'string' && packet.tutor_retry_of_step_id
    || (typeof packet.tutor_step_id === 'string' ? packet.tutor_step_id : '');
}
function resolveStepFailure(packet: Record<string, unknown>) {
  if (typeof packet.tutor_step_id !== 'string') return;
  const failed = failureStep(packet);
  const notices = notebook.cells.filter(cell => cell.packet?.operational_notice
    && (cell.packet.failed_step === packet.tutor_step_id || cell.packet.failed_step === failed));
  if (!notices.length) return;
  for (const cell of notices) feed.querySelector(`[data-cell-id="${cell.id}"]`)?.remove();
  notebook.cells = notebook.cells.filter(cell => !notices.includes(cell));
  helpStatus('Instructor recovered this step. Your answer and progress are preserved.');
  saveNotebook();
}
/** Revisit a figure once per learner request or question, across every delivery path. */
function instructorVisuals(text: string, packet: Record<string, unknown>, history = notebook.cells) {
  let requestIndex = history.length - 1;
  while (requestIndex >= 0 && history[requestIndex].kind !== 'message') requestIndex--;
  if (packet.is_question_prompt) {
    // A new question needs its givens. Replayed copies of that question do not.
    const checkpoint = packet.tutor_checkpoint_id;
    history = typeof checkpoint === 'string' && checkpoint
      ? history.filter(cell => cell.packet?.is_question_prompt && cell.packet.tutor_checkpoint_id === checkpoint)
      : history.slice(requestIndex + 1).filter(cell => cell.packet?.is_question_prompt);
  } else if (requestIndex >= 0 && requestedVisual(history[requestIndex].text)) {
    history = history.slice(requestIndex + 1);
  }
  return freshTeachingVisuals(text, history.filter(cell => ['board', 'diagram'].includes(cell.kind)).map(cell => cell.text));
}
function board(text: string, section?: unknown, packet: Record<string, unknown> = {}) {
  if (!text.trim() || text.length > 100000) return;
  resolveStepFailure(packet);
  if (browserCourse) {
    const chapter = lessonCourses.flatMap(course => course.chapters).find(ch => ch.id === selectedLesson);
    packet = {...packet, browser_step:chapter?.lesson || chapter?.name || browserQuestion?.title};
    const tag = browserSnapshot?.training_tag;
    if (tag && /^[a-f0-9]{10}$/.test(tag)) text = text.replaceAll('{{company}}', 'Training ' + tag).replaceAll('{{tag}}', tag);
  }
  if (mode === 'tutor') {
    text=instructorVisuals(text,packet);
    // An image-only checkpoint still owns the answer controls when its figure
    // arrived in a separate event immediately before the question.
    if (!text.trim() && packet.is_question_prompt) text='Use the figure above to answer.';
    if (!text.trim()) return;
  }
  if (mode === 'tutor' && (packet.is_question_prompt || packet.tutor_feedback)) {
    editors.checkpoint(packet.is_question_prompt && typeof packet.tutor_checkpoint_id === 'string' ? packet.tutor_checkpoint_id : '');
  }
  if (mode === 'tutor' && packet.tutor_feedback) {
    // Feedback closes its question: the full set of lesson moves comes back.
    const asked = [...notebook.cells].reverse().find(cell => cell.kind === 'board' && cell.packet?.is_question_prompt
      && (!packet.tutor_checkpoint_id || cell.packet.tutor_checkpoint_id === packet.tutor_checkpoint_id));
    if (asked?.packet) {
      asked.packet.feedback_received = true;
    }
    const correct = [packet.correct, packet.is_correct, packet.answer_correct].includes(true);
    struggles = correct ? 0 : struggles + 1;
    smallerStep(struggles >= 2);
  }
  if (mode === 'tutor' && packet.is_question_prompt && !packet.tutor_feedback && packet.tutor_checkpoint_id !== idleQuestion) showHelp({next:1});
  const prior = [...notebook.cells].reverse().find(cell => cell.kind === 'board' && cell.packet?.tutor_checkpoint_id === packet.tutor_checkpoint_id && packet.tutor_checkpoint_id);
  addCell('board', text, {...packet, active_subtopic:section, ...(prior?.packet?.student_answer ? {
    student_answer:prior.packet.student_answer, student_answer_request_id:prior.packet.student_answer_request_id,
  } : {})});
  controls();
}
const learningActions: Record<string, [string, string]> = {
  continueLesson:['Continue','Please continue the lesson.'], hint:['Hint','Give me one hint for this step.'],
  stuck:['I’m stuck','I’m stuck on this question. Ask me one smaller guiding question so I can take the next step myself. Please don’t give me the answer.'],
  explainSimply:['Explain simply','Explain this idea more simply.'], workedExample:['Worked example','Show a worked example of this idea.'],
  similarProblem:['Try another','Give me a similar problem to try.'], harderProblem:['Harder problem','Give me a harder problem on this topic.'],
  testMe:['Try on my own','Give me a fresh problem to attempt independently.'], summarize:['Recap','Summarize what we have learned.'],
  explainDiagram:['Explain diagram','Explain this diagram.'], simulation:['Explore','Show an exploration of this idea.'], video:['Video','Show a video about this topic.'],
};
/** A question is open until the learner answers it or Instructor gives feedback on it. */
const questionOpen = (packet: Record<string, unknown>) => !!packet.is_question_prompt && typeof packet.student_answer !== 'string' && !packet.feedback_received;
/** Session actions belong to the current composer, not to saved explanation cards. */
function updateLessonActions() {
  const primary = byId('composer-mode-actions'), more = byId('notebook-help-actions');
  if (!primary || !more) return;
  const latest = [...notebook.cells].reverse().find(cell => cell.kind === 'board'
    && !cell.packet?.notebook_help && !cell.packet?.data_part);
  const packet = latest?.packet ?? {};
  const available = !!latest && !practice && !practiceMode && mode === 'tutor' && !!selectedLesson
    && (packet.tutor_practice_editor as {source?:string} | undefined)?.source !== 'Practice exercise';
  const menu = packet.tutor_action_menu as {actions?: unknown} | undefined;
  // The existing help ladder handles hints. An unanswered question must not offer a way to skip it.
  const ids = available && (packet.operational_notice === true || (!openQuestion() && !questionOpen(packet)))
    ? ['continueLesson', ...(Array.isArray(menu?.actions) ? menu.actions : [])] : [];
  const visibleActions = new Set(ids.filter((id): id is string => typeof id === 'string'
    && !!learningActions[id] && !['hint', 'stuck'].includes(id)));
  if(browserCourse&&browserSnapshot?.shift)visibleActions.add('continueLesson');
  for (const id of visibleActions) {
    const [label, text] = learningActions[id];
    let action = document.querySelector<HTMLButtonElement>(`[data-lesson-action="${id}"]`);
    if (!action) {
      action = document.createElement('button'); action.type = 'button'; action.dataset.lessonAction = id;
      (id === 'continueLesson' ? primary : more).append(action);
    }
    action.textContent = browserCourse && id==='continueLesson'
      ? browserQuestion && browserQuestion.id!==browserAnswered?'Answer question':'Continue task' : label;
    if(browserCourse && id==='continueLesson')action.dataset.browserContinue='';
    else delete action.dataset.browserContinue;
    action.onclick = () => {
      if (!ready || sending || !editors.aiEnabled) return;
      if(id==='continueLesson' && browserCourse) {
        if(browserQuestion && browserQuestion.id!==browserAnswered) {
          focusBrowserQuestion();
        } else if(ready && browserSnapshot && !sending) {
          host.postMessage({type:'browserContinue',attempt,task:browserSnapshot.task});
          helpStatus('Checking your ERPNext task…');
        } else helpStatus('Open the current ERPNext task and reconnect to continue.');
        return;
      }
      void send(text, false, label === 'I’m stuck' ? label : text, id === 'stuck' ? undefined : id);
    };
  }
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-lesson-action]')) {
    action.hidden = !visibleActions.has(action.dataset.lessonAction!);
    action.disabled = action.hidden || !ready || sending || !editors.aiEnabled;
    if (action.hidden) delete action.dataset.browserContinue;
  }
}
/** Struggle signal: two answers that were not accepted, or a long pause on an open question. */
function smallerStep(show: boolean) {
  let chip = document.getElementById('smaller-step') as HTMLButtonElement | null;
  if (!chip && show) {
    chip = document.createElement('button'); chip.type = 'button'; chip.id = 'smaller-step'; chip.className = 'smaller-step';
    chip.textContent = 'Want a smaller step?';
    chip.onclick = () => {
      smallerStep(false); struggles = 0;
      void send('Can we take a smaller step? Break this into one smaller question I can try first. Please don’t give me the answer.', false, 'Want a smaller step?');
    };
    (byId('composer-mode-actions') ?? byId('composer')).append(chip);
  }
  if (chip) chip.hidden = !show || practiceMode || mode !== 'tutor';
}
function watchIdle(question: NotebookCell | undefined, restart = false) {
  const id = typeof question?.packet?.tutor_checkpoint_id === 'string' ? question.packet.tutor_checkpoint_id : '';
  if (!id) { clearTimeout(idleTimer); idleTimer = undefined; idleQuestion = ''; return; }
  if (id === idleQuestion && !restart) return;
  clearTimeout(idleTimer); idleQuestion = id;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (openQuestion()?.packet?.tutor_checkpoint_id === id && !field.value.trim()) smallerStep(true);
  }, 95000);
}
function latestSummary() {
  return [...notebook.cells].reverse().find(cell => cell.packet?.session_summary);
}
function refreshSummary(topics?: TopicCoverage[]) {
  const cell = latestSummary();
  if (!cell?.packet) return;
  if (topics) {
    const weak = topics.filter(topic => topic.needs_review).map(topic => topic.title).join('; ');
    cell.packet.work_on = weak;
    cell.text = cell.text.replace(/\n\n\*\*Keep practising:\*\* [^\n]*/, '');
    if (weak) cell.text = cell.text.replace(/\n\n(?=\*\*(?:Lesson completed|Session ended|Lesson completion))/, () => '\n\n**Keep practising:** ' + weak + '\n\n');
  }
  const body = feed.querySelector<HTMLElement>(`[data-cell-id="${cell.id}"] > div`);
  if (body) { body.innerHTML = renderBoard(cell.text); summaryActions(body, cell); }
}
function removeCellFollowups(ids: Set<string>) {
  notebook.executionIssues = notebook.executionIssues?.filter(issue => !ids.has(issue.key.split(':')[0]));
  refreshSummary();
}
function summaryActions(body: HTMLElement, cell: NotebookCell) {
  if (cell !== latestSummary()) return;
  const issues = notebook.executionIssues ?? [];
  const pending = executionFollowup(issues);
  if (pending) {
    const note = document.createElement('div'); note.className = 'execution-followup';
    note.setAttribute('role', 'note'); note.innerHTML = renderBoard(pending);
    note.querySelectorAll('ul:first-of-type > li').forEach((item, index) => {
      const issue = issues[index], editor = issue && editors.elementForKey(issue.key);
      if (!editor) { item.append(' (cell unavailable in this notebook)'); return; }
      const link = document.createElement('a');
      link.href = '#' + editor.id; link.textContent = issue.snippet;
      link.setAttribute('aria-label', 'Go to ' + issue.snippet);
      link.onclick = event => {
        event.preventDefault();
        const row = editor.closest<HTMLElement>('[data-cell-id]');
        if (row?.dataset.cellId) goToNotebookCell(row.dataset.cellId);
        for (let parent = editor.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        editor.tabIndex = -1; editor.focus({preventScroll:true}); scrollToNotebookRow(editor);
      };
      item.replaceChildren(link, ': ' + issue.detail);
    });
    body.append(note);
  }
  const bar = document.createElement('div'); bar.className = 'lesson-actions recap-actions';
  const chapters = lessonCourses.find(course => course.chapters.some(ch => ch.id === selectedLesson))?.chapters ?? [];
  const index = chapters.findIndex(ch => ch.id === selectedLesson);
  const next = index < 0 ? undefined : chapters[index + 1];
  const weak = typeof cell.packet?.work_on === 'string' ? cell.packet.work_on.trim() : '';
  if (next && cell.packet?.lesson_completion === 'complete') {
    if (next.locked || next.expired) {
      const access = document.createElement('span');
      access.textContent = (next.lesson || next.name) + (next.expired ? ' · Access ended' : ' · Locked');
      bar.append(access);
    } else {
      const go = document.createElement('button'); go.type = 'button'; go.dataset.nextLesson = next.id;
      go.textContent = 'Next lesson: ' + (next.lesson || next.name); go.onclick = () => begin('tutor', next.id); bar.append(go);
    }
  }
  if (cell.packet?.lesson_completion === 'partial') {
    const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Resume lesson';
    resume.onclick = () => { void send('Please resume the unfinished lesson from where we stopped.', false, 'Resume lesson', 'continueLesson'); };
    bar.append(resume);
  }
  if (weak) {
    const review = document.createElement('button'); review.type = 'button'; review.dataset.reviewWeak = ''; review.textContent = 'Review weak spots';
    review.onclick = () => { void send('Check the topics that still need review, one question at a time.', false, 'Review weak spots', 'reviewWeakSpots'); };
    bar.append(review);
  }
  if (bar.children.length) body.append(bar);
}
function renderTeaching(cell: NotebookCell, text = cell.text, replaceRow?: HTMLElement) {
  const packet = cell.packet ?? {}, section = packet.active_subtopic;
  appendCard('assistant', body => {
    body.parentElement?.setAttribute('data-cell-id', cell.id);
    body.parentElement!.dataset.entryKind = packet.tutor_feedback ? 'feedback' : packet.is_question_prompt ? 'question' : 'lesson';
    const {body:shown, turn} = splitYourTurn(text);
    body.innerHTML = shown.trim() ? renderBoard(shown) : '';
    if (typeof packet.browser_step === 'string') {
      const context = document.createElement('small'); context.className = 'muted';
      context.textContent = 'Feedback for: ' + packet.browser_step; body.prepend(context);
    }
    if (turn) {
      const box = document.createElement('div'), label = document.createElement('strong'), prompt = document.createElement('div');
      box.className = 'your-turn'; box.setAttribute('role', 'note'); box.setAttribute('aria-label', 'Your turn');
      label.textContent = 'Your turn'; prompt.innerHTML = renderBoard(turn); box.append(label, prompt);
      // Open until the learner sends their next message.
      const index = notebook.cells.indexOf(cell);
      if (!notebook.cells.slice(index + 1).some(later => later.kind === 'message' && !later.packet?.action && !later.packet?.notebook_help)) box.classList.add('is-open');
      body.append(box);
    }
    prepareVisuals(body);
    if(validBrowserQuestion(packet.browser_question)) {
      const question=packet.browser_question,actions=document.createElement('div');actions.className='lesson-actions';
      body.parentElement?.setAttribute('data-browser-question-id',question.id);
      for(const option of question.options) {
        const answer=document.createElement('button');answer.type='button';answer.textContent=option;answer.dataset.browserQuestion=question.id;
        answer.disabled=!ready || browserQuestion?.id!==question.id || browserAnswered===question.id;
        answer.onclick=()=>{
          if(browserQuestion?.id!==question.id || browserAnswered===question.id)return;
          browserAskInstead='';
          field.value=option;
          controls();field.focus();messageBar?.scrollIntoView({block:'nearest'});
        };
        actions.append(answer);
      }
      if(actions.children.length)body.append(actions);
    }
    if (mode === 'tutor' && !practiceMode && !packet.is_question_prompt && !packet.tutor_feedback && !packet.notebook_help) {
      labelLessonOutputs(body);
    }
    if (packet.tutor_code_review_basis === 'static_review' || packet.tutor_code_review_basis === 'learner_reported') {
      const basis = document.createElement('small'); basis.className = 'muted';
      basis.textContent = packet.tutor_code_review_basis === 'static_review' ? 'Feedback by code inspection' : 'Feedback based on learner-reported output';
      body.prepend(basis);
    }
    if (mode === 'tutor' && writtenCheckpoint(packet) && typeof packet.tutor_checkpoint_id === 'string') {
      editors.writtenQuestion(body, cell.id, packet.tutor_checkpoint_id);
      // The checkpoint and the notebook share a single answer draft.
      const hint = document.createElement('button'); hint.className = 'answer-hint'; hint.type = 'button';
      hint.dataset.questionHint = packet.tutor_checkpoint_id; hint.textContent = 'Answer this question';
      hint.onclick = () => field.focus();
      hint.hidden = openQuestion()?.packet?.tutor_checkpoint_id !== packet.tutor_checkpoint_id;
      body.append(hint);
    } else if (!packet.notebook_help && (!practiceMode || !conversationCell(cell))) {
      editors.mount(body, text, packet.tutor_practice_editor, cell.id);
    }
    conversationControls(body, cell);
    // Instructor sends the course section first, then the concept taught this turn.
    const heading = body.querySelector(':scope > .exercise-instructions > summary + *') ?? body.firstElementChild;
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
  }, !replaceRow && !restoring && nearBottom(), replaceRow);
}
async function connect(grant: {url: string; token: string; chapterId?: string; media?: boolean; freecad?:boolean; browserCourse?:boolean; lesson?: {subject: string; name: string};
    browserProgress?:BrowserCourseProgress; doubtContext?: {chapter_id?: unknown; lesson_name?: unknown}}, id: number) {
  freecad=grant.freecad ? new FreeCADRoom(attempt,message=>host.postMessage(message)) : undefined;
  mediaAllowed = grant.media === true;
  browserCourse=grant.browserCourse===true;browserSync=Promise.resolve();
  taskProgress=grant.browserProgress;showBrowserProgress();renderLessons();
  document.body.classList.toggle('browser-course',browserCourse);
  if(runtimePicker) {
    runtimePicker.disabled=browserCourse || !!freecad;runtimePicker.options[0].textContent=freecad?'FreeCAD':browserCourse?'ERPNext browser':localRuntimeLabel();
    runtimePicker.querySelector('[value="terminal"]')!.textContent = 'Open course terminal';
    runtimePicker.querySelector('[value="setup"]')!.textContent = 'Set up / rebuild course';
  }
  if(browserCourse || freecad)editors.follow(false);
  doubtContext = {};
  for (const key of ['chapter_id', 'lesson_name'] as const) {
    const value = grant.doubtContext?.[key];
    if (typeof value === 'string' && value && value.length <= 300) doubtContext[key] = value;
  }
  byId<HTMLInputElement>('follow-code').disabled = mediaAllowed;
  if (mediaAllowed && !freecad) byId('code-observer-status').textContent = `Use Ask ${names[mode]} to share a cell from this notebook.`;
  const live = new LivekitClient.Room({audioOutput: {deviceId: speaker?.deviceId}}); room = live;
  const current = () => room === live && id === attempt;
  const isAgent = (peer?: RemoteParticipant) => current() && !!peer?.isAgent && (!agent || peer.identity === agent);
  live.on(RoomEvent.ParticipantAttributesChanged, (changed, peer) => {
    if (!isAgent(peer as RemoteParticipant) || !Object.hasOwn(changed, 'lk.agent.state')) return;
    agentActivity = changed['lk.agent.state'];
    interruption.agentChanged(agentActivity);
    showAgentActivity();
  });
  live.on(RoomEvent.ActiveSpeakersChanged, speakers => {
    if (!current() || !ready || !mediaAllowed) return;
    interruption.userSpeaking(speakers.some(peer => peer === live.localParticipant));
    if (interruption.listening) resumeTutorOutput();
  });
  const subscribe = (pub: RemoteTrackPublication, peer: RemoteParticipant) => {
    if (isAgent(peer) && pub.kind === 'audio') pub.setSubscribed(true);
  };
  live.on(RoomEvent.TrackPublished, subscribe);
  live.on(RoomEvent.TrackSubscribed, (track, _pub, peer) => {
    if (!isAgent(peer) || track.kind !== 'audio') return;
    const el = track.attach(); el.muted = roomAudioMuted(); document.body.append(el); audio.add(el);
    if (voice) void el.play().catch(() => { if (current()) { blockedAudio = true; controls(); } });
  });
  live.on(RoomEvent.TrackUnsubscribed, track => { for (const el of track.detach()) { audio.delete(el); el.remove(); } });
  live.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if(current() && voice){blockedAudio=!live.canPlaybackAudio;controls();}
  });
  live.on(RoomEvent.DataReceived, (bytes, peer) => {
    if (!isAgent(peer) || bytes.length > 320000) return;
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
    const turn = packetTurn(data);
    if (retractedTutorRequests.has(turn)) return;
    if (turn && turn === lastTutorRequest) resumeTutorOutput();
    if (tutorOutputPaused && !turn && data?.method !== 'notebook_resume_ready') return;
    if (data?.method === 'notebook_resume_ready') {
      const pending = unfinishedQuestion(notebook);
      if (pending?.packet && pending.packet.tutor_checkpoint_id === data.checkpoint_id) {
        pending.packet.resume_unverified = data.verified !== true;
        if (data.needs_resubmission) delete pending.packet.student_answer;
        if (data.verified === true && (data.tutor_answer_kind === 'written' || data.tutor_answer_kind === 'code' && data.tutor_practice_editor)) {
          const wasWritten = writtenCheckpoint(pending.packet);
          pending.packet.tutor_answer_kind = data.tutor_answer_kind;
          if (data.tutor_answer_kind === 'code') pending.packet.tutor_practice_editor = data.tutor_practice_editor;
          else delete pending.packet.tutor_practice_editor;
          if (wasWritten !== writtenCheckpoint(pending.packet)) {
            const row = feed.querySelector<HTMLElement>(`[data-cell-id="${pending.id}"]`);
            if (row) renderTeaching(pending, pending.text, row);
          }
        }
        const needsConfirmation = 'Your saved task needs confirmation. Open Notebook options and choose “Ask Instructor to confirm”.';
        if (data.verified !== true) {
          editors.checkpoint(''); status.textContent = needsConfirmation;
        } else {
          if (typeof pending.packet.student_answer !== 'string') editors.checkpoint(data.checkpoint_id);
          if (status.textContent === needsConfirmation) status.textContent = 'Instructor confirmed your saved task.';
        }
        saveNotebook(); controls();
      }
    } else if (data?.method === 'tutor_turn_started' && typeof data.tutor_turn_id === 'string') {
      tutorTurn = data.tutor_turn_id;
    } else if (data?.method === 'tutor_turn_completed') {
      pendingTutorRequests.delete(turn);
    } else if (data?.method === 'tutor_request_failed' && typeof data.message === 'string' && data.message.trim()) {
      const turn = typeof data.tutor_turn_id === 'string' ? data.tutor_turn_id : '';
      if (tutorTurn && turn && turn !== tutorTurn && turn !== lastTutorRequest) return;
      if (deliveredStep(data)) return;
      const step = failureStep(data);
      if (!notebook.cells.some(cell => cell.packet?.operational_notice && (step ? cell.packet.failed_step === step : turn && cell.packet.failed_turn === turn))) {
        addCell('board', data.message.slice(0, 2000), {operational_notice:true, tutor_turn_id:turn, failed_turn:turn, failed_step:step});
      }
      helpStatus(data.message.slice(0, 2000));
      controls();
    } else if (data?.method === 'video_visual') videoPacket(data);
    else if (data?.method === 'video_pause_request') void pauseForQuestion();
    else if (data?.method === 'award_xp' && mode === 'tutor') {
      if (Number.isSafeInteger(data.amount) && data.amount > 0 && data.amount <= 50
          && (!data.award_id || !notebook.cells.some(cell => cell.packet?.award_id === data.award_id))) {
        addCell('recap', `+${data.amount} XP` + (typeof data.reason === 'string' ? ' · ' + data.reason.slice(0,300) : ''),
          {xp:data.amount, ...(typeof data.award_id === 'string' ? {award_id:data.award_id} : {})});
        const summary=[...notebook.cells].reverse().find(cell=>cell.packet?.session_summary);
        if (summary) {
          summary.text=summary.text.replace(/\*\*Lesson XP earned: \d+ XP\*\*/,`**Lesson XP earned: ${lessonXp()} XP**`);
          const body=feed.querySelector<HTMLElement>(`[data-cell-id="${summary.id}"] > div`);
          if (body) {body.innerHTML=renderBoard(summary.text);summaryActions(body,summary);}
          saveNotebook();
        }
      }
    }
    else if (['draw_svg', 'display_image'].includes(data?.method) && data.action !== 'clear') {
      const source = imageSource(data.image_url);
      const visualPacket = {
        ...(turn ? {tutor_turn_id:turn} : {}),
        ...(data.is_question_prompt === true ? {is_question_prompt:true} : {}),
        ...(typeof data.tutor_checkpoint_id === 'string' ? {tutor_checkpoint_id:data.tutor_checkpoint_id} : {}),
      };
      if (source) {
        const label = (typeof data.label === 'string' ? data.label : typeof data.caption === 'string' ? data.caption : '').slice(0, 1000) || 'Textbook figure';
        const markdown=imageMarkdown(source,label);
        const figure=mode==='tutor' ? instructorVisuals(markdown,visualPacket) : markdown;
        if (figure.trim()) addCell('diagram', figure, {...visualPacket, image_url:source, label});
      } else if (typeof data.svg === 'string' && data.svg.trim() && data.svg.length <= 100000) {
        const figure=mode==='tutor' ? instructorVisuals(data.svg,visualPacket) : data.svg;
        if (figure.trim()) addCell('diagram', figure, visualPacket);
      }
    } else if (['display_on_screen', 'write_on_whiteboard'].includes(data?.method) && typeof data.content === 'string') {
      board(data.content, data.active_subtopic, data);
    } else if (mode === 'tutor' && (data?.method === 'topic_update' || data?.method === 'tutor_example_progress')) {
      if(browserCourse) {showBrowserProgress();return;}
      const title = typeof data.current_topic === 'string' ? data.current_topic : typeof data.topic === 'string' ? data.topic : '';
      if (title) notebook.title = title.slice(0,300);
      const items = Array.isArray(data.lesson_topics) ? data.lesson_topics : [];
      // Live teaching updates the same visible outline. Example-only agendas
      // must never replace coverage for the whole chapter.
      const owner = lessonCourses.find(course => course.name === data.subject);
      const chapter = owner?.chapters.find(ch => ch.id === selectedLesson && ch.name === data.chapter_name
        && (ch.lesson || ch.name) === data.lesson_name);
      if (chapter && data.method === 'topic_update' && !data.solved_example_id && items.length
          && items.every((item: any) => typeof item.title === 'string' && typeof item.covered === 'boolean')) {
        const topics: TopicCoverage[] = items.map((item: any) => ({id:item.id, title:item.title,
          status:item.covered ? 'covered' : item.learning_status === 'Not taught' ? 'not_started' : 'in_progress',
          needs_review:item.learning_status === 'Needs review'}));
        const covered = topics.filter(topic => topic.status === 'covered').length;
        chapter.progress = {status:covered === topics.length ? 'covered' : 'in_progress', covered, total:topics.length,
          topics, needs_review:topics.filter(topic => topic.needs_review).length};
        renderLessons(); refreshSummary(topics);
      }
      const content = '### Lesson progress\n\n' + items.filter((item: any) => typeof item.title === 'string').map((item: any) => '- '
        + (item.covered === true ? '✓ ~~' + item.title + '~~' : item.title) + ' — ' + (item.learning_status || item.status || '')).join('\n');
      if (items.length) {
        const scope = JSON.stringify([data.subject, data.chapter_name, data.lesson_name]);
        const prior = notebook.cells.find(cell => cell.kind === 'recap' && cell.packet?.progressScope === scope);
        if (prior) { prior.text = content; const body = feed.querySelector('[data-cell-id=\"' + prior.id + '\"] > div'); if (body) body.innerHTML = renderBoard(content); saveNotebook(); }
        else addCell('recap', content, {progressScope:scope});
      }
    } else if (data?.method === 'tutor_session_summary') {
      resolveStepFailure(data);
      const currentChapter=lessonCourses.find(c=>c.name===data.subject)?.chapters.find(c=>c.id===selectedLesson&&c.name===data.chapter&&(c.lesson||c.name)===data.topic);
      const weak = Array.isArray(data.topics_discussed)
        ? data.topics_discussed.filter((topic: any) => topic?.status === 'Needs review').map((topic: any) => topic.title).filter((title: unknown) => typeof title === 'string').join('; ')
        : typeof data.work_on === 'string' ? data.work_on.trim() : '';
      const cards = Array.isArray(data.recap_cards) ? data.recap_cards : [];
      const recap = ['## Lesson recap', data.big_idea || data.remark || '', ...cards.map((card: any) => typeof card === 'string' ? card : [card.title, ...(Array.isArray(card.takeaways) ? card.takeaways.map((point: string) => '- ' + point) : [card.content || card.summary || card.key_takeaway || ''])].filter(Boolean).join('\n\n')), data.strength ? '**What went well:** ' + data.strength : '', weak ? '**Keep practising:** ' + weak : ''].filter(value => typeof value === 'string').join('\n\n');
      const xp = lessonXp();
      const completion = lessonCompletion(data);
      const completionText = completion === 'complete' ? '**Lesson completed — teaching and required checks finished.**'
        : completion === 'partial' ? '**Session ended — lesson still in progress.**'
          : '**Lesson completion has not been confirmed.**';
      const progress = data.lesson_progress;
      const progressText = progress && Number.isInteger(progress.total) && progress.total > 0
        && Number.isInteger(progress.completed_count) && progress.completed_count >= 0 && progress.completed_count <= progress.total
        ? `\n\n${progress.completed_count}/${progress.total} lesson sections completed.` : '';
      addCell('recap', recap + '\n\n' + completionText + progressText + `\n\n**Lesson XP earned: ${xp} XP**`,
        {session_summary:true, tutor_step_id:data.tutor_step_id, tutor_turn_id:data.tutor_turn_id, lesson_completion:completion, work_on:weak});
      editors.checkpoint(''); struggles = 0; smallerStep(false);
      if(currentChapter&&data.is_complete===true&&data.partial_session===false&&data.summary_scope==='full'&&['ssh','cloud-cli'].includes(selectedRuntime)) {
        saveNotebook(true);host.postMessage({type:'finishLab',attempt,documentKey,chapterId:selectedLesson});
      }
    } else if (data?.method === 'lesson_context') {
      const scope = JSON.stringify([data.subject, data.chapter_name, data.lesson_name, data.subtopic]);
      if (scope !== lessonScope) { editors.checkpoint(''); struggles = 0; smallerStep(false); }
      lessonScope = scope;
    }
  });
  live.localParticipant.registerRpcMethod('display_on_screen', async data => {
    if (!current() || data.callerIdentity!==agent || !isAgent(live.remoteParticipants.get(data.callerIdentity))) return '';
    const payload = JSON.parse(data.payload);
    const turn = packetTurn(payload);
    if (turn && turn === lastTutorRequest && !retractedTutorRequests.has(turn)) resumeTutorOutput();
    if (!retractedTutorRequests.has(turn) && (!tutorOutputPaused || turn) && typeof payload?.content === 'string')
      board(payload.content, payload.active_subtopic, payload);
    return '';
  });
  freecad?.bind(live,()=>agent,current,()=>ready,message=>{
    const indicator=document.getElementById('freecad-status');
    if(current() && indicator){indicator.hidden=false;if(indicator.textContent!==message)indicator.textContent=message;}
  });
  live.localParticipant.registerRpcMethod('demonstrate_browser',async data=>{
    if(!current()||!ready||!browserCourse||!browserSnapshot?.shift||data.callerIdentity!==agent
      ||!isAgent(live.remoteParticipants.get(data.callerIdentity)))return JSON.stringify({status:'rejected',message:'No active business shift.'});
    let command;try{command=JSON.parse(data.payload);}catch{return JSON.stringify({status:'rejected',message:'Invalid browser action.'});}
    if(!validDemonstration(command)||command.task!==browserSnapshot.task||command.snapshot!==browserSnapshot.shift.snapshot)
      return JSON.stringify({status:'rejected',message:'The current form changed. Observe it before demonstrating.'});
    const result=await browserActions.run(command,attempt);
    return JSON.stringify(result);
  });
  live.registerTextStreamHandler('lk.transcription', async (reader, peer) => {
    if (!isAgent(live.remoteParticipants.get(peer.identity))) return;
    const tagged = packetTurn(reader.info.attributes);
    if (tagged && tagged === lastTutorRequest && !retractedTutorRequests.has(tagged)) resumeTutorOutput();
    const turn = tagged || tutorTurn || lastTutorRequest;
    const retractions = retractedTutorRequests.size;
    const paused = tutorOutputPaused;
    const text = await reader.readAll();
    if (!current() || paused || tutorOutputPaused || retractedTutorRequests.has(turn) || (!tagged && retractions !== retractedTutorRequests.size)
        || !text.trim() || reader.info.attributes?.['lk.transcription_final'] === 'false') return;
    addCell('voice', text.slice(0,12000), turn ? {tutor_turn_id:turn} : undefined);
  });
  function disconnected(message: string) {
    const interrupted = sendingComposerMessage;
    close(message);
    if (interrupted) showDeliveryIssue('Reconnect and check for a reply before sending again.');
  }
  live.on(RoomEvent.ParticipantDisconnected, peer => { if (current() && peer.identity === agent) disconnected(names[mode] + ' disconnected. Retry to reconnect.'); });
  live.on(RoomEvent.Disconnected, () => { if (current()) disconnected('Disconnected. Retry to reconnect.'); });
  live.on(RoomEvent.Reconnecting, () => { if (current()) {
    stopDevices(); ready = false; agentActivity = ''; helpStatus('Reconnecting to ' + names[mode] + '…'); controls();
    if(browserCourse)host.postMessage({type:'browserState',attempt:id,connected:false,detail:'Reconnecting to Instructor…'});
  } });
  let switched = false;
  live.on(RoomEvent.Reconnected, () => {
    if (current() && switched && agent) {
      if (!isAgent(live.remoteParticipants.get(agent))) { close('The session changed. Retry to reconnect.'); return; }
      agentActivity = live.remoteParticipants.get(agent)?.attributes?.['lk.agent.state'] ?? '';
      ready = true; connectedStatus(names[mode] + ' connected'); controls();
      if(browserCourse)void syncBrowserObservation().catch(error=>{if(current())helpStatus(error.message);});
    }
  });
  let transportConnected = false;
  try {
    await live.connect(grant.url, grant.token, {autoSubscribe:false});
    if (!current()) { await live.disconnect(); return; }
    transportConnected = true;
    for (const peer of live.remoteParticipants.values()) for (const pub of peer.trackPublications.values()) subscribe(pub, peer);
    const deadline = Date.now() + 65000;
    while (current() && Date.now() < deadline) {
      const peer = [...live.remoteParticipants.values()].find(p => p.isAgent);
      if (peer) {
        agent = peer.identity;
        try {
          let speedAccepted = false;
          if (speaker) {
            try {
              const speedAck = await live.localParticipant.performRpc({destinationIdentity: agent, method:'set_speech_playback_speed',
                payload:JSON.stringify({speed:speaker.playbackSpeed}), responseTimeout:8000});
              speedAccepted = speedAck === 'ok';
            } catch { /* A starting worker may not have registered its RPCs yet. */ }
            if (!current()) return;
          }
          await applyLearningPreferences();
          if (!current()) return;
          const ack = await live.localParticipant.performRpc({destinationIdentity: agent, method:'switch_mode',
            payload: JSON.stringify(switchPayload(grant)), responseTimeout: 30000});
          if (ack !== 'ok') {
            // Older services reject new connection fields with a misleading
            // mode-picker instruction, even when this mode is already selected.
            const incompatible = /^error: choose (?:Tutor|Instructor)(?:,| or) Doubt Solver(?: or Study)? in this room$/i.test(ack);
            if (current()) close(incompatible
              ? names[mode] + ' could not start because the learning service rejected this connection request. Contact support to update the service.'
              : ack.startsWith('error:') ? ack.slice(6).trim() : names[mode] + ' could not start. Retry to reconnect.');
            return;
          }
          if (!current()) return;
          if (speaker && !speedAccepted) {
            try {
              const speedAck = await live.localParticipant.performRpc({destinationIdentity: agent, method:'set_speech_playback_speed',
                payload:JSON.stringify({speed:speaker.playbackSpeed}), responseTimeout:8000});
              if (speedAck !== 'ok') throw new Error('Voice speed unavailable');
            } catch { if (current()) speaker.resetPlaybackSpeed(); }
            if (!current()) return;
          }
          if (mediaAllowed) {
            const audioAck = await live.localParticipant.performRpc({destinationIdentity: agent, method:'toggle_audio',
              payload:JSON.stringify({input_enabled:false, output_enabled:true}), responseTimeout:8000});
            if (audioAck !== 'ok') throw new Error(`${names[mode]} audio was not ready. Retry to reconnect.`);
            if (!current()) return;
          }
          agentActivity = peer.attributes?.['lk.agent.state'] ?? agentActivity;
          switched = ready = true; connectedStatus(names[mode] + ' connected'); controls(); field.focus();
          if(browserCourse)void syncBrowserObservation().catch(error=>{status.textContent=String(error.message);});
          return;
        } catch (e) {
          // A newly joined worker registers the app RPCs after identity checks.
          if (!(e instanceof LivekitClient.RpcError && e.code === LivekitClient.RpcError.ErrorCode.UNSUPPORTED_METHOD)) throw e;
        }
      }
      await new Promise(r => setTimeout(r, 350));
    }
    if (current()) close(names[mode] + ' did not become ready in time. Retry to reconnect. If this continues, contact support.');
  } catch { if (current()) close(transportConnected
    ? names[mode] + ' could not finish starting. Retry to reconnect. If this continues, contact support.'
    : 'Could not reach ' + names[mode] + '. Check your internet connection, then retry.'); }
}
/** Help also works before the learner adds code. The synthetic empty selection never becomes a notebook cell. */
function helpContext() {
  return editors.selection() ?? {snapshot:{snippet:'code-0', revision:0,
    language:byId<HTMLSelectElement>('cell-language').value || 'python', source:'', stdin:'',
    question:([...notebook.cells].reverse().find(cell => cell.kind === 'board' && !cell.packet?.notebook_help)?.text
      || heading?.textContent || 'Help me with this notebook.').slice(0,6000)}, prediction:'', run:undefined, focusLine:undefined};
}
/** A working connection is reported once, in the header; the help row clears any earlier failure. */
function connectedStatus(message: string) {
  deliveryNextStep = '';
  status.textContent = message;
  const inline = byId('notebook-help-status');
  if (inline) inline.textContent = '';
}
/** Connection changes are reported in the header. The help row repeats them only beside a typed question
 * (the learner is looking there) and otherwise keeps just a delivery issue about the learner's own message. */
function connectionStatus(message: string) {
  status.textContent = message;
  const inline = byId('notebook-help-status');
  if (inline && !deliveryNextStep) inline.textContent = field.value.trim() ? message : '';
}
function showDeliveryIssue(nextStep: string) {
  const inline = byId('notebook-help-status');
  if (!inline) return;
  deliveryNextStep = nextStep;
  let draft = '';
  if (field.value) draft = field.value === savedTextDraft ? 'Your draft is saved on this device. ' : 'Your draft is still here. ';
  else if (attachments.count) draft = 'Your attachments are still here. ';
  const message = draft + nextStep;
  if (inline.textContent !== message) inline.textContent = message;
}
function helpStatus(message: string) {
  deliveryNextStep = '';
  status.textContent = message;
  const inline = byId('notebook-help-status');
  if (inline) inline.textContent = message;
}
async function send(text: string, draftMessage: false | LearnerMessage, display = text, action?: string, targetCell?: string, followupStage?:SkillStage, helpLevel?: number, notebookHelp = false): Promise<boolean> {
  const draft = draftMessage ? draftMessage.text : undefined;
  const id = attempt;
  if (practice || notebookHelp) {
    const attached = draftMessage && draftMessage.attachments.length > 0;
    if (!ready || sending || !editors.aiEnabled || (!text.trim() && !attached)) return false;
    sending = coaching = true; controls();
    try {
      // Photos and PDFs go with this question; the server reads them into text for Instructor and keeps nothing.
      const files = attached ? await attachments.encoded(false, draftMessage.attachments) : [];
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
          ...(!practice && mode === 'doubt_solver' ? {doubtId:currentDoubt()} : {}), ...(!practice && mode === 'tutor' && selectedLesson ? {chapterId:selectedLesson} : {}),
          message:submitted ? ('Review my code and help me decide what to improve. ' + (payload.explanation || '')).slice(0,600)
            : (help?.message || text || 'Look at what I attached and help me with my next step.').slice(0,600),
          ...(files.length && !submitted ? {attachments:files} : {}),
          history:(!practice && mode === 'doubt_solver' ? doubtCells() : notebook.cells).filter(cell => ['board','message'].includes(cell.kind) && cell.id !== 'practice-question').slice(-8)
            .map(cell => ({role:cell.kind === 'message' ? 'learner' : 'tutor', text:cell.text.slice(0,1500)})),
        });
      });
      if (id !== attempt) return false;
      if (reply.accessEnded && reply.error) accessNotice(reply.error);
      if (reply.error) throw new Error(reply.error);
      if (!practice && helpLevel) showHelp({next:Math.min(HELP_LEVELS.length, helpLevel + 1)});
      addCell('message', (display || 'About my attachment') + (files.length && !submitted ? '\n\nAttachments: ' + files.map(f => f.name).join(', ') : ''), submitted ? {submission:{language:selected.snapshot.language,
        source:selected.snapshot.source, explanation:payload.explanation, assisted:payload.helped === true}} : {notebook_help:true});
      // The help level held because there was no new attempt: a short plain notice above the reply.
      const held = typeof reply.ladderNote === 'string' && reply.ladderNote.trim() ? '> ' + reply.ladderNote.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[\\`*_[\]<>#|]/g, c => '\\' + c) + '\n\n' : '';
      const response = addCell('board', (submitted ? '## Code review\n\n' : '') + held + (reply.content || names[mode] + ' returned no feedback. Try again.'),
        {notebook_help:true, choices:replyChoices(reply.choices), replies:quickReplies(reply.replies), strategy:practiceStrategy(reply.strategy ?? action), line:reply.line});
      replyContexts.set(response.id, {...selected.snapshot,skillStage:stage});
      spokenReplies?.reply(typeof reply.audioId === 'string' ? reply.audioId : null);
      if (files.length && !submitted) attachments.clear();
      helpStatus(held ? reply.ladderNote!.slice(0, 300) : names[mode] + ' replied. Choose a reply or ask your next question.');
      if (draftMessage && field.value === draft) field.value = '';
      return true;
    } catch (error) {
      if (id === attempt) helpStatus(error instanceof Error ? error.message : names[mode] + ' could not reply. Try again.');
      // The review button owns a status beside the source. Let it show the same
      // actionable failure instead of replacing it with a generic retry notice.
      if (text.startsWith('PRACTICE_NOTEBOOK_SUBMISSION\n')) throw error;
      return false;
    }
    finally { if (id === attempt) { sending = coaching = false; controls(); } }
  }
  return sendLive(text, draftMessage, display, action);
}
async function sendLive(text: string, draftMessage: false | LearnerMessage, display: string, action?: string, question?: NotebookCell): Promise<boolean> {
  const live = room, dest = agent, id = attempt, draft = draftMessage && draftMessage.text;
  const attached = draftMessage && draftMessage.attachments.length > 0;
  if (!ready || sending || !live || !dest || (!text.trim() && !attached)) return false;
  sending = true; sendingComposerMessage = !!(draftMessage || question); controls();
  if (sendingComposerMessage) connectedStatus(names[mode] + ' connected');
  const request = mode === 'tutor' ? 'tutor-request-' + crypto.randomUUID() : '';
  try {
    await tutorCancellation;
    if (id !== attempt || !ready) return false;
    const current = editors.selection();
    observeCode(current?.snapshot, current?.run);
    await latestObservation;
    await syncBrowserObservation();
    if (id !== attempt || !ready) return false;
    if (!await pauseForQuestion()) {
      if (id === attempt) status.textContent = 'Could not confirm the video pause. Pause the video and try again; your question is still here.';
      return false;
    }
    if (id !== attempt || !ready) return false;
    if (request) { pendingTutorRequests.add(request); lastTutorRequest = request; }
    if (attached) {
      const deadline = Date.now() + 120000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attachments.send(live.localParticipant, dest, text, () => id === attempt && room === live && Date.now() < deadline,
            mode === 'doubt_solver' && !practiceMode ? attachmentRole : undefined, request, draftMessage.attachments),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Attachment delivery timed out.')), 120000); }),
        ]);
      } finally { clearTimeout(timer); }
    } else {
      let deliveryTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([
          live.localParticipant.sendText(text,{topic:'lk.chat',destinationIdentities:[dest],
            attributes:{...(request ? {tutor_request_id:request} : {}), ...(action ? {tutor_action_id:action} : {})}}),
          new Promise<never>((_,reject)=>{deliveryTimer=setTimeout(()=>reject(new Error('Message delivery timed out.')),20000);}),
        ]);
      } finally {clearTimeout(deliveryTimer);}
    }
    if (id !== attempt) return false;
    if (question?.packet) {
      question.packet.student_answer = display;
      question.packet.student_answer_request_id = request;
    }
    addCell('message', display + (attached ? '\n\nAttachments: ' + draftMessage.attachments.map(file => file.name).join(', ') : ''), {
      ...(request ? {tutor_request_id:request} : {}),
      ...(action || notebookHelpActions.some(item => item.label === display) ? {action:true} : {}),
    });
    if (attached) attachments.clear();
    if (draftMessage && field.value === draft) field.value = '';
    return true;
  } catch (error) {
    pendingTutorRequests.delete(request);
    if (id === attempt) {
      if (browserObservationFailed) {
        if (sendingComposerMessage) showDeliveryIssue('Reconnect Instructor, then send again.');
      } else if (error instanceof Error && /pages|Session changed/.test(error.message)) helpStatus(error.message);
      else {
        const timedOut = error instanceof Error && error.message === 'Message delivery timed out.';
        helpStatus(timedOut ? 'Message delivery timed out. Check for a reply before sending again.' : 'Message delivery could not be confirmed.');
        if (sendingComposerMessage) showDeliveryIssue(ready ? 'Check for a reply before sending again.' : 'Reconnect and check for a reply before sending again.');
      }
    }
  }
  finally { if (id === attempt) { sending = sendingComposerMessage = false; controls(); } }
  return false;
}

window.addEventListener('message', e => {
  const d = e.data;
  if(e.origin===window.location.origin && d?.type==='handoffAttachments' && d.attempt===attempt && mode==='tutor') {
    attachments.add(d.files.map((file:{name:string;type:string;data:string})=>new File([
      Uint8Array.from(atob(file.data),character=>character.charCodeAt(0))],file.name,{type:file.type})));
    return;
  }
  if(e.origin===window.location.origin && d?.type==='browserReconnect' && d.attempt===attempt && browserCourse) {
    if(!sending)begin(mode,selectedLesson,true);
    return;
  }
  if(e.origin===window.location.origin && d?.attempt===attempt && d.type==='freecadResult') {
    freecad?.receive(d.id,d.result);return;
  }
  if(e.origin===window.location.origin && d?.attempt===attempt && d.type==='freecadSetup') {
    connectionStatus(d.message);return;
  }
  if(d?.type==='browserObservation') {
    if(e.origin!==window.location.origin || d.attempt!==attempt || d.chapter!==selectedLesson)return;
    browserSnapshot=d.observation;
    if(d.progress) {taskProgress=d.progress;showBrowserProgress();renderLessons();}
    if(d.brief&&typeof d.brief.id==='string'&&typeof d.brief.title==='string'&&typeof d.brief.text==='string'
      &&!notebook.cells.some(cell=>cell.packet?.business_shift_brief===d.brief.id))
      addCell('board','### '+d.brief.title+'\n\n'+d.brief.text,{business_shift_brief:d.brief.id});
    showBrowserQuestion(d.question);
    if(typeof d.taskStatus==='string' && d.taskStatus)helpStatus(d.taskStatus);
    if(d.focusQuestion && d.focusQuestion===browserQuestion?.id)focusBrowserQuestion();
    if(ready && browserCourse)void syncBrowserObservation().then(()=>{
      if(d.attempt===attempt && d.chapter===selectedLesson && d.help && typeof d.help==='string' && d.help.length<=1500)return send(d.help,false);
    }).catch(error=>{if(d.attempt===attempt)helpStatus(error.message);});
    return;
  }
  if(e.origin===window.location.origin&&d?.type==='browserDemonstrationResult') {
    browserActions.receive(d.id,d.attempt,d.result);return;
  }
  if(e.origin===window.location.origin && d?.type==='browserAnswerRejected' && d.attempt===attempt) {
    if(browserAnswered===d.id){browserAnswered='';controls();}
    helpStatus('The browser task changed. Your answer is in Instructor; check the current task before continuing.');return;
  }
  if(e.origin===window.location.origin && d?.type==='browserTaskStatus' && d.attempt===attempt && typeof d.status==='string') {
    helpStatus(d.status);return;
  }
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
    for (const el of audio) el.muted = roomAudioMuted();
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
  if (d?.type === 'skillingAction') {
    if (d.attempt !== attempt || !ready || selectionOpen || workspaceBusy || sending || practicePanel && !practicePanel.hidden) return;
    if (d.action === 'ask' && (!practiceMode || editors.aiEnabled)) byId('message')?.focus();
    if (practiceMode && (d.action === 'check' || d.action === 'grade')) editors.runPracticeTool(d.action === 'check' ? 'tests' : 'grade');
    return;
  }
  if (d?.type === 'browseCoursePractice') { browseCoursePractice(); return; }
  if (d?.type === 'workspaceError') {
    if (d.request !== undefined && (d.request !== practiceRequest || practicePanel?.hidden)) return;
    workspaceBusy=false; if (workspaceMode) workspaceMode.disabled=false;
    selectRoomTab();
    helpStatus(d.message);
    if (practicePanel && !practicePanel.hidden && byId('practice-list-status')) byId('practice-list-status').textContent=d.message;
    const chapters = byId<HTMLSelectElement>('practice-chapter');
    if (chapters && chapters.options.length) chapters.disabled = false;
    return;
  }
  if (d?.type === 'workspacePractice') {
    if (!practicePanel || practicePanel.hidden || d.request !== undefined && d.request !== practiceRequest) return;
    const chapters=byId<HTMLSelectElement>('practice-chapter'), list=byId('practice-questions');
    if (d.course && byId('practice-course')) byId('practice-course').textContent = d.course;
    chapters.replaceChildren(...d.chapters.map((chapter:any)=>{
      const option=document.createElement('option'); option.value=chapter.id; option.textContent=chapter.lesson||chapter.name;
      option.disabled=chapter.locked || chapter.expired; return option;
    }));
    chapters.disabled = !chapters.options.length;
    chapters.value=d.chapterId; chapters.onchange=()=>browseCoursePractice(chapters.value);
    list.replaceChildren(...d.questions.map((question:any)=>{
      const choice=document.createElement('button'); choice.type='button';
      const title=document.createElement('strong'); title.textContent=question.title;
      choice.append(title);
      const format = question.kind === 'written' ? 'Written response' : question.language;
      const detail = [format, question.difficulty].filter(Boolean).join(' · ');
      if (detail) { const meta=document.createElement('small'); meta.textContent=detail; choice.append(meta); }
      choice.onclick=()=>changeWorkspace('practice',question.id); return choice;
    }));
    const count = d.questions.length;
    if (byId('practice-list-status')) byId('practice-list-status').textContent = count
      ? count + (count === 1 ? ' exercise' : ' exercises')
      : 'No published exercises for this chapter yet. You can still write and run code in the notebook.';
    return;
  }
  if (d?.type === 'learningPreferencesError') {
    if (preferenceNotice) preferenceNotice.textContent = d.message;
    return;
  }
  if (d?.type === 'learningPreferences') {
    learnerPreferences = learningPreferences(d.preferences);
    for (const [id,key] of [['preferred-name','preferred_name'], ['check-frequency','check_frequency'], ['preferred-voice','voice']] as const) {
      const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (control) control.value = learnerPreferences[key];
    }
    if (ready) void applyLearningPreferences();
    return;
  }
  if (d?.type === 'coachingLanguage') {
    const changed = coachLanguage !== coachingLanguage(d.language);
    coachLanguage = coachingLanguage(d.language);
    if (coachLanguagePicker) coachLanguagePicker.value = coachLanguage;
    if (changed && ready && !practiceMode) {
      const chapter = selectedLesson;
      close('Changing coaching language…'); begin(mode, chapter);
    }
    return;
  }
  if (d?.type === 'openTutor') {
    workspaceBusy = false; closePracticeList();
    button('end').hidden = true;
    preferredLesson = typeof d.lesson === 'string' ? d.lesson : '';
    const next = d.mode === 'doubt_solver' ? 'doubt_solver' : 'tutor';
    begin(next, next === mode ? selectedLesson : '');
    return;
  }
  if (d?.type === 'tutorLessons') {
    if (d.attempt !== attempt || practiceMode) return;
    if (selectedLesson && !(selectionPage && d.browse)) return;
    const scope = (!d.browse && preferredLesson && d.preferredCourse) || preferredCourse || d.preferredCourse;
    if (!d.browse || !d.error) lessonCourses = Array.isArray(d.courses) ? d.courses.filter((course:Course)=>d.browse || mode === 'doubt_solver' || !scope || course.name===scope) : [];
    loadingLessons = false;
    lessonLoadError = typeof d.error === 'string' ? d.error : '';
    taskProgress=d.browserProgress;
    const course = byId<HTMLSelectElement>('lesson-course');
    if (course) {
      course.replaceChildren(...lessonCourses.map(item => { const option = document.createElement('option'); option.value = option.textContent = item.name; return option; }));
      const preferred = [preferredCourse, d.preferredCourse].find(name => lessonCourses.some(item => item.name === name));
      if (preferred) course.value = preferred;
    }
    renderLessons();
    if (selectionPage && d.browse) return;
    status.textContent = lessonLoadError || (mode === 'tutor' ? 'Choose a lesson to learn with Instructor.' : 'Choose a course and chapter to ask Doubt Solver.');
    const resume = preferredLesson;
    if (!lessonLoadError) preferredLesson = '';
    const chosenCourse = lessonCourses.find(item => item.name === course?.value);
    const chapter = !lessonLoadError && (resume ? chosenCourse?.chapters.find(ch => ch.id === resume)
      : scope && mode === 'tutor' ? suggestedChapter(chosenCourse) ?? chosenCourse?.chapters.find(ch => !ch.locked && !ch.expired) : undefined);
    if (chapter && !chapter.locked && !chapter.expired) { begin(mode, chapter.id); return; }
    // Reloading stays reachable, for example after buying a course again.
    button('tutor').textContent = 'Reload lessons'; button('tutor').hidden = false;
    return;
  }
  if (d?.type === 'chooseCourse' && typeof d.course === 'string') {
    if (practiceMode) return;
    workspaceBusy = false; closePracticeList();
    // Continuing the lesson that is already open keeps its live session and notebook.
    if (typeof d.lesson === 'string' && d.lesson && d.lesson === selectedLesson) {
      if(button('end').disabled)begin(mode,d.lesson);
      return;
    }
    preferredCourse = d.course; preferredLesson = typeof d.lesson === 'string' ? d.lesson : ''; chooseLesson();
    return;
  }
  if (d?.type === 'openPractice') {
    practiceMode = true; document.body.classList.add('practice-notebook');
    workspaceBusy = false; closePracticeList();
    button('end').hidden = true; button('doubt_solver').hidden = true;
    begin('tutor'); return;
  }
  if (d?.type === 'helpState') { showHelp(d); return; }
  if (d?.type === 'notebookReply') { if (d.attempt === attempt && pendingNotebook && d.request === pendingNotebook.request) pendingNotebook.finish(d); return; }
  if(d?.type==='openDoubtChat' && chatSwitchPending) {
    chatSwitchPending=false;sending=false;if(chatHistory)chatHistory.open=false;
    begin('doubt_solver',d.chapter,true,{...(d.newChat?{newChat:true}:{chatId:d.chatId})});showHelp({next:1});field.focus();return;
  }
  if(d?.type==='doubtChatError') {chatSwitchPending=false;sending=false;status.textContent=d.message;controls();return;}
  if(d?.type==='doubtHistory' && Array.isArray(d.chats)){renderChatHistory(d.chats);return;}
  if (d?.type === 'restoreNotebook') {
    if (d.attempt !== undefined && d.attempt !== attempt) return;
    if (documentKey !== d.documentKey) composer.cancelCapture();
    clearTimeout(saveTimer); notebookConflict(false); pendingDoubt = '';
    if (typeof d.learnerInitial === 'string') feed.dataset.learnerInitial = d.learnerInitial;
    documentKey = d.documentKey; saveSequence = 0; restoreNotebook(d.notebook);
    document.getElementById('runtime-restore')?.remove();
    savedTextDraft = notebook.textDraft;
    if (notebookSaveStatus) notebookSaveStatus.textContent = '';
    return;
  }
  if (d?.type === 'notebookSaved' || d?.type === 'notebookError') {
    if (d.documentKey && d.documentKey !== documentKey) return;
    savedTextDraft = d.type === 'notebookSaved' ? d.textDraft : undefined;
    if (deliveryNextStep) showDeliveryIssue(deliveryNextStep);
    if (notebookSaveStatus) notebookSaveStatus.textContent = d.type === 'notebookError' ? d.message : '';
    if (d.type === 'notebookSaved' || d.conflict === true) notebookConflict(d.conflict === true);
    return;
  }
  if (d?.type === 'courseNoteUpdated' && d.documentKey === documentKey) {
    const cell = notebook.cells.find(cell => cell.id === d.id && cell.kind === 'note');
    if (cell && cell.text === d.expected) {
      cell.text = d.text;
      const input = feed.querySelector<HTMLTextAreaElement>(`[data-cell-id="${cell.id}"] textarea`);
      if (input) input.value = d.text;
      saveNotebook(true);
    } else if (cell) notebookConflict(true);
    return;
  }
  if (d?.type === 'runtimeHistory' && d.documentKey === documentKey) {
    let bar = document.getElementById('runtime-restore');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'runtime-restore';
      feed.before(bar);
    }
    bar.replaceChildren(); bar.hidden = (!d.count && !notebook.drafts.some(draft=>draft.language==='python')) || !d.needsRestore
      || (selectedRuntime !== 'course' && !selectedRuntime.startsWith('machine:'));
    if (bar.hidden) return;
    const message = document.createElement('p');
    bar.append(message);
    if (!d.count) {
      message.textContent = 'No execution history is available for these saved cells. Run your setup cells once to begin recording recoverable state.';
      return;
    }
    message.textContent = d.restoreBlockReason ? 'Python session state was reset.'
      : d.restoring ? 'Restoring previous successful Python runs…'
      : `Python variables need restoring. Replay ${d.count} successful run(s) for this lesson, in order. This repeats file writes, installations and other code effects.`;
    const error = document.createElement('p');
    if (d.error || d.restoreBlockReason) {
      error.setAttribute('role','alert'); error.textContent = d.error || d.restoreBlockReason;
      bar.append(error);
    }
    if (!d.restoreBlockReason) {
      const restore = document.createElement('button'); restore.textContent = d.restoring ? 'Stop restoring' : 'Restore session state';
      restore.onclick = () => {error.remove(); restore.disabled = true; host.postMessage({type:d.restoring?'stopRestore':'restoreRuntime', documentKey});};
      bar.append(restore);
    }
    const fresh = document.createElement('button'); fresh.className = 'quiet'; fresh.textContent = 'Start fresh'; fresh.disabled = d.restoring;
    fresh.onclick = () => {
      error.remove();
      confirmRemoval(fresh, 'Start a fresh Python session? Your code stays in the notebook. This clears its replay history.',
        () => host.postMessage({type:'freshRuntime', documentKey}), 'Start fresh');
    };
    bar.append(fresh); return;
  }
  if (d?.type === 'runtimeRestored' && d.documentKey === documentKey) {
    editors.restartRuntime(); status.textContent = 'Previous successful Python runs restored. Continue with your unfinished cell.'; return;
  }
  if (d?.type === 'runtimeRestarted') {
    if (d.documentKey && d.documentKey !== documentKey) return;
    host.postMessage({type:'runtimeStatus',documentKey});
    replyContexts.clear(); updateHelpReplies();
    pendingNotebook?.finish({error:'Runtime changed. Ask ' + names[mode] + ' again with a current run.'});
    if (d.runtime) {
      selectedRuntime = 'course';
      if (runtimePicker) runtimePicker.value = selectedRuntime;
      editors.runtime = localRuntimeLabel();
    }
    editors.restartRuntime(); status.textContent = 'Runtime restarted. Run the required cells again.'; return;
  }
  if (d?.type === 'runtimeSelected') {
    replyContexts.clear(); updateHelpReplies();
    pendingNotebook?.finish({error:'Runtime changed. Ask ' + names[mode] + ' again with a current run.'});
    selectedRuntime = ['colab','cloud','jupyter','ssh','cloud-cli'].includes(d.runtime) ? d.runtime : 'course';
    if (selectedRuntime !== 'course') {const bar=document.getElementById('runtime-restore');if(bar)bar.hidden=true;}
    else host.postMessage({type:'runtimeStatus',documentKey});
    if (runtimePicker) runtimePicker.value = selectedRuntime;
    editors.runtime = typeof d.label === 'string' ? d.label : localRuntimeLabel();
    editors.restartRuntime();
    status.textContent = d.message || (selectedRuntime === 'course' ? localRuntimeLabel() + ' ready.' : 'GPU runtime selected.');
    return;
  }
  if (d?.type === 'runtimeError') {status.textContent = d.message; return;}
  if (d?.type === 'workstationState' && runtimePicker && !freecad) {
    const option = runtimePicker.querySelector<HTMLOptionElement>('[value="course"]');
    if (option) option.textContent = d.runtimeLabel || localRuntimeLabel() + ' · ' + d.label;
    if (typeof d.runtimeLabel === 'string' && selectedRuntime === 'course') editors.runtime = d.runtimeLabel;
    if (d.machines && !['colab','cloud','jupyter','ssh','cloud-cli'].includes(selectedRuntime)) {
      runtimePicker.querySelectorAll('[data-machine]').forEach(option => option.remove());
      for (const machine of d.machines.machines ?? []) {
        if (machine === 'course') continue;
        const item = document.createElement('option');
        item.value = 'machine:' + machine; item.dataset.machine = machine; item.textContent = machine;
        runtimePicker.insertBefore(item,runtimePicker.querySelector('[value="terminal"]'));
      }
      selectedRuntime = d.machines.selected && d.machines.selected !== 'course' ? 'machine:' + d.machines.selected : 'course';
      runtimePicker.value = selectedRuntime;
      editors.runtime = d.machines.selected === 'course' ? 'Course container' : d.machines.selected;
    }
    if (!['colab','cloud','jupyter','ssh','cloud-cli'].includes(selectedRuntime)) runtimePicker.title = d.error
      || 'Commands and code run in your selected course container.';
    return;
  }
  if (d?.type === 'visibility') {
    const returned = !visible && d.visible === true;
    visible = d.visible === true;
    // Coming back (for example from the catalog after a purchase) refreshes which lessons are open.
    if (returned) {
      if (selectionOpen && selectedLesson) loadCourseSelection();
      else reloadLessons();
    }
    if (!visible) stopDevices();
    controls();
    const selected = editors.selection(); observeCode(selected?.snapshot, selected?.run);
    for (const el of audio) el.muted = roomAudioMuted();
    return;
  }
  if (d?.type === 'signedOut') {
    delete feed.dataset.learnerInitial;
    workspaceBusy = false; closePracticeList();
    byId('practice-questions')?.replaceChildren(); byId('practice-chapter')?.replaceChildren();
    if (selectionPage) selectionOpen = true;
    chatSwitchPending=false;renderChatHistory([]);
    close('Your account changed. Retry to sign in.'); selectedLesson = ''; lessonCourses = [];
    loadingLessons = false; preferredLesson = ''; lessonLoadError = 'Your account changed. Retry to sign in.';
    taskProgress=undefined;
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
  if (d.type === 'grant' || d.type === 'practiceReady') {
    if (!d.gpuRuntimes && ['colab','cloud','jupyter','ssh','cloud-cli'].includes(selectedRuntime)) {
      selectedRuntime = 'course';
      if (runtimePicker) runtimePicker.value = selectedRuntime;
    }
    for (const option of runtimePicker?.querySelectorAll<HTMLOptionElement>('[data-gpu]') ?? []) {
      const available = d.gpuRuntimes && (!option.hasAttribute('data-managed-gpu') || d.managedGpuRuntimes !== false);
      option.hidden = !available; option.disabled = !available || option.value==='colab' && d.gpuCount>1;
    }
    let notice = document.getElementById('gpu-compute-notice');
    if (d.gpuRuntimes && !notice) {
      notice = document.createElement('p'); notice.id = 'gpu-compute-notice'; notice.className = 'muted';
      document.querySelector('.workspace-header')?.after(notice);
    }
    if (notice) {notice.hidden = !d.gpuRuntimes; notice.textContent = (d.gpuCount ? d.gpuCount+' GPU(s) required. ' : '')+(d.gpuCostNotice || '');}
  }
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
  if (d.type === 'courseData') { receiveCourseData(d); return; }
  if (d.type === 'dataReply') { if (pendingData && d.request === pendingData.request) pendingData.finish(d); return; }
  if (d.type === 'dataPreview' && d.plan) { showPreview(d.plan); return; }
  if (d.type === 'dataImported' && d.dataset) { imported(d.dataset); return; }
  if (d.type === 'dataStatus' && typeof d.text === 'string') { helpStatus(d.text); return; }
  if (d.type === 'notebookDebugResult') { debugReplies.get(d.request)?.(d); debugReplies.delete(d.request); }
  if (d.type === 'notebookDebugState') editors.receiveDebug(d);
  if (d.type === 'cellCompletions') editors.completed(d);
  if (d.type === 'codeResult') { editors.receive(d); composerMode(); }
  if (d.type === 'practiceToolResult' && typeof d.request === 'number') { toolReplies.get(d.request)?.(d); toolReplies.delete(d.request); }
  if (d.type === 'grant' && !room) {
    editors.aiEnabled = d.aiEnabled !== false;
    editors.runtime = typeof d.codeRuntime === 'string' ? d.codeRuntime.slice(0, 200) : 'Course runtime';
    // A new course brings its own language for new code cells.
    const picker = document.getElementById('cell-language') as HTMLSelectElement | null;
    const courseLanguage = !!picker && typeof d.codeLanguage === 'string' && [...picker.options].some(option => option.value === d.codeLanguage);
    if (courseLanguage) picker!.value = d.codeLanguage as string;
    // With a course language, new cells use it and each cell keeps its own picker: one fewer decision up front.
    picker?.closest('.add-code-group')?.classList.toggle('course-language', courseLanguage);
    void connect(d, attempt);
  }
  if (d.type === 'failed') { close(d.message); if (d.accessEnded === true) accessNotice(d.message); }
  if (d.type === 'videoChecked') {
    const v = videos.get(d.videoId);
    if (!v) return;
    if (!d.ok) { v.body.textContent = 'This video is unavailable in the dhimantAI catalog.'; return; }
    // Let the player negotiate its formats. A few canPlayType combinations
    // cannot predict which video/audio streams YouTube will choose.
    v.url = d.url; renderVideo(d.videoId, true);
  }
});
if (button('saved-practice')) button('saved-practice').onclick = () => {
  saveNotebook(true); host.postMessage({type:'savedPracticeNotebooks'});
};
if (button('course-notes')) button('course-notes').onclick = () => {saveNotebook(true); host.postMessage({type:'courseNotes',documentKey});};
button('tutor').onclick = () => {if(!sending)begin(mode, selectedLesson, browserObservationFailed);};
if(button('previous-chapter'))button('previous-chapter').onclick=()=>{const prior=adjacentChapter(true);if(prior)selectChapter(prior.id);};
if(button('skip-chapter'))button('skip-chapter').onclick=()=>{const next=adjacentChapter();if(next)selectChapter(next.id);};
if (byId('lesson-course')) byId('lesson-course').onchange = () => {
  preferredCourse = byId<HTMLSelectElement>('lesson-course').value;
  if (byId('lesson-search')) byId<HTMLInputElement>('lesson-search').value = '';
  renderLessons();
};
if (byId('lesson-search')) byId('lesson-search').oninput = renderLessons;
if (button('choose-course')) button('choose-course').onclick = loadCourseSelection;
if (button('reload-lessons')) button('reload-lessons').onclick = () => {
  if (selectedLesson) loadCourseSelection();
  else reloadLessons();
};
if (button('selection-back')) button('selection-back').onclick = () => showCourseSelection(false);
if (button('lesson-catalog')) button('lesson-catalog').onclick = () => host.postMessage({type:'courseCatalog'});
// The explicit handoff carries the draft; ordinary mode selection keeps separate drafts.
button('doubt_solver').onclick = () => changeWorkspace(mode==='tutor'?'doubt_solver':'tutor',undefined,mode==='doubt_solver');
button('end').onclick = () => close('Session ended. Choose an agent to start again.');
if (button('sound')) button('sound').onclick = async () => {
  voice = blockedAudio || !voice; blockedAudio = false;
  voiceByMode.set(mode, voice);
  for (const el of audio) el.muted = roomAudioMuted();
  controls();
  await resumeSpeaker();
};
field.addEventListener('pointerdown',()=>{if(blockedAudio)void resumeSpeaker();});
if (button('import-data')) button('import-data').onclick = () => { if (ready && dataState === 'ready') host.postMessage({type:'dataImport', attempt}); };
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
    steps.hidden = nextHelp === 1; // Progress through the hint ladder appears once a hint has been used.
  }
  const note = document.getElementById('help-note');
  if (note) note.textContent = d.waiting === true ? 'Try the last suggestion and run your code to unlock the next step.' : '';
  const trend = document.getElementById('help-trend');
  if (trend && typeof d.trend === 'string') trend.textContent = d.trend.slice(0, 160);
}
const helpButton = document.getElementById('practice-help') as HTMLButtonElement | null;
if (helpButton) helpButton.onclick = () => {
  const item = HELP_LEVELS[nextHelp - 1];
  if (!practice && mode === 'tutor') {
    // Lesson help belongs to the shared Instructor and its open checkpoint.
    // A previously selected code cell may be from an earlier learning objective.
    const current = openQuestion() ?? [...notebook.cells].reverse().find(cell => cell.kind === 'board' && !cell.packet?.notebook_help);
    const anchor = current ? '\n\nCurrent lesson question or explanation:\n' + current.text.slice(0, 6000) : '';
    void send(item.message + anchor, false, item.label, 'hint').then(sent => {
      if (sent) showHelp({next:Math.min(HELP_LEVELS.length, item.level + 1)});
    });
    return;
  }
  void send(item.message, false, item.label, 'small_steps', undefined, undefined, item.level, !practice);
};
const tutorActions = byId('notebook-help-actions');
function conversationProblem() {
  if (practice) return;
  const cells = mode === 'doubt_solver' ? doubtCells() : notebook.cells;
  return [...cells].reverse().find(cell => cell.kind === 'message' && cell.text.trim()
    && !cell.packet?.notebook_help && !cell.packet?.action
    && !notebookHelpActions.some(action => action.label === cell.text))?.text;
}
if (tutorActions) for (const item of notebookHelpActions) {
  const action = document.createElement('button'); action.type = 'button'; action.textContent = item.label;
  action.dataset.practiceStrategy = item.strategy;
  action.onclick = () => {
    const problem = item.strategy === 'plan' ? conversationProblem() : undefined;
    if (problem) {
      // Conceptual doubts belong to the existing conversation agent. The code
      // coach's selected-cell context can refer to an entirely different task.
      void send('Explain this problem from our current discussion, including what the quantities mean and what needs to be found:\n\n' + problem,
        false, item.label);
    } else void send(item.message, false, item.label, item.strategy, undefined, undefined, undefined, true);
  };
  tutorActions.append(action);
}
field.oninput = () => {
  if (deliveryNextStep) { deliveryNextStep = ''; byId('notebook-help-status').textContent = ''; }
  askNormally = false; controls(); saveNotebook(); smallerStep(false); if (!practiceMode && mode === 'tutor') watchIdle(openQuestion(), true); };
/** Doubt Solver composer: an optional "What I tried" note, which file is the question, and New doubt. */
function doubtComposer() {
  const doubt = mode === 'doubt_solver' && !practiceMode;
  let tried = document.getElementById('doubt-tried-box');
  if (!tried && doubt) {
    tried = document.createElement('details'); tried.id = 'doubt-tried-box'; tried.className = 'doubt-tried';
    const summary = document.createElement('summary'); summary.textContent = 'What I tried (optional)';
    const label = document.createElement('label'), input = document.createElement('textarea'), nudge = document.createElement('small');
    label.htmlFor = 'doubt-tried'; label.textContent = 'What I tried'; label.className = 'sr-only';
    input.addEventListener('input',()=>saveNotebook());
    input.id = 'doubt-tried'; input.rows = 1; input.maxLength = 1500; input.placeholder = 'The step you tried and where it stopped making sense';
    nudge.id = 'doubt-tried-nudge'; nudge.className = 'muted';
    nudge.textContent = 'Sharing what you tried helps Doubt Solver find the exact step that went wrong.';
    input.setAttribute('aria-describedby', nudge.id);
    tried.append(summary, label, input, nudge);
    document.querySelector('#composer .composer-support')?.prepend(tried);
    const fresh = document.createElement('button'); fresh.type = 'button'; fresh.id = 'new-doubt'; fresh.className = 'quiet'; fresh.textContent = 'New Chat';
    fresh.title = 'Start a fresh conversation. This chat stays in Chat history.';
    fresh.onclick = newDoubt;
    (byId('composer-mode-actions') ?? byId('composer')).prepend(fresh);
    const roles = document.createElement('fieldset'); roles.id = 'attachment-role'; roles.className = 'attachment-role';
    const legend = document.createElement('legend'); legend.textContent = 'These files show';
    roles.append(legend);
    for (const [value, text] of [['question', 'The question'], ['learner_attempt', 'My attempt']] as const) {
      const option = document.createElement('label'), radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'attachment-role'; radio.value = value; radio.checked = value === attachmentRole;
      radio.onchange = () => { if (radio.checked) attachmentRole = value; };
      option.append(radio, ' ' + text); roles.append(option);
    }
    document.getElementById('attachments')?.after(roles);
  }
  if (tried) tried.hidden = !doubt;
  const nudge = document.getElementById('doubt-tried-nudge'), input = document.getElementById('doubt-tried') as HTMLTextAreaElement | null;
  // A nudge on the first message of a doubt, never a requirement.
  if (nudge) nudge.hidden = !doubt || !!input?.value.trim() || doubtCells().some(cell => cell.kind === 'message');
  const fresh = document.getElementById('new-doubt') as HTMLButtonElement | null;
  if (fresh) { fresh.hidden = !doubt; fresh.disabled = sending || chatSwitchPending || !documentKey || !doubtCells().some(cell => cell.kind === 'message'); }
  const roles = document.getElementById('attachment-role') as HTMLFieldSetElement | null;
  if (roles) {
    if (!attachments.count && attachmentRole !== 'question') {
      attachmentRole = 'question';
      for (const radio of roles.querySelectorAll<HTMLInputElement>('input')) radio.checked = radio.value === 'question';
    }
    roles.hidden = !doubt || !attachments.count; roles.disabled = sending;
  }
}
async function sendDoubt(draft: LearnerMessage) {
  const input = document.getElementById('doubt-tried') as HTMLTextAreaElement | null, tried = input?.value.trim() ?? '';
  const message = draft.text;
  // The id of a first doubt is saved with a divider before its first message.
  if (!notebook.cells.some(isDivider) && notebook.cells.some(cell => cell.kind === 'message') === false && documentKey && ready)
    addCell('recap', 'New doubt', {doubt_divider:true, doubt_id:currentDoubt()});
  const text = (tried ? 'What I tried: ' + tried.replace(/\s+/g, ' ') + '\n' : '') + message;
  const ok = await send(text, draft, message + (tried ? '\n\nWhat I tried: ' + tried : ''));
  if (ok && input && input.value.trim() === tried) input.value = '';
  controls();
  return ok;
}
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
  if(runtimePicker.value==='finish')saveNotebook(true);
  host.postMessage({type:'runtime', runtime:runtimePicker.value});
  runtimePicker.value = selectedRuntime;
};
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.workspace-menu[open]')) {
    if (!menu.contains(event.target as Node)) { menu.open = false; continue; }
    if (!(event.target as Element).closest('button') || menu.querySelector('.delete-confirmation :focus')) continue;
    const returnFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (returnFocus) menu.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menus = document.querySelectorAll<HTMLDetailsElement>('.workspace-menu[open]');
  for (const menu of menus) {
    menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});
  }
  if (!menus.length && document.body.classList.contains('focus-view')) focusView(false);
});
// ---- Course data: preloaded samples and the learner's own files, asked about through the Coach ----
/** Imported files by name until the extension has described them, so a question can still name them. */
function knownData(): CourseDataset[] {
  return [...courseData, ...(notebook.dataImports ?? []).map(name => importedSets.get(name)
    ?? {id:'import:' + name, title:name, source:'import' as const, about:{title:name, summary:''}, tables:[]})];
}
function dataStatus(text: string) {
  let note = document.getElementById('course-data-status');
  if (!note && text) {
    note = document.createElement('small'); note.id = 'course-data-status'; note.setAttribute('role', 'status');
    (notebookSaveStatus ?? status).after(note);
  }
  if (note) { note.textContent = text; note.hidden = !text; }
}
function dataRoute(text: string) {
  return !practiceMode && !practice && dataState === 'ready' && !attachments.count && !askNormally && isDataQuestion(text, knownData());
}
/** Says, before sending, that a question will go the data route and which data it names; one click asks normally instead. */
function dataControls() {
  let line = document.getElementById('data-route');
  if (!line) {
    line = document.createElement('small'); line.id = 'data-route'; line.className = 'data-route'; line.hidden = true;
    const text = document.createElement('span'), toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'quiet'; toggle.textContent = 'Ask normally instead';
    toggle.onclick = () => { askNormally = true; dataControls(); field.focus(); };
    line.append(text, ' ', toggle);
    (byId('composer-context') ?? byId('composer')).after(line);
  }
  const on = dataRoute(field.value), named = namedDatasets(field.value, knownData());
  line.hidden = !on;
  line.querySelector('span')!.textContent = on ? `Data question: the Coach will look at the course data${named.length ? ' (' + named.map(d => d.id.split(':')[1]).join(', ') + ')' : ''}, write the steps and a read-only query, and show the rows it used.` : '';
  if (button('import-data')) { button('import-data').hidden = practiceMode || dataState !== 'ready'; button('import-data').disabled = !ready || sending; }
  let chips = document.getElementById('data-chips');
  if (!chips) {
    chips = document.createElement('div'); chips.id = 'data-chips'; chips.className = 'attachment-tray';
    chips.setAttribute('aria-label', 'Your files for the Coach');
    (document.getElementById('attachments') ?? byId('composer')).after(chips);
  }
  const names = dataState === 'ready' ? notebook.dataImports ?? [] : [];
  chips.hidden = !names.length;
  chips.replaceChildren(...names.map(name => {
    const chip = document.createElement('span'), remove = document.createElement('button');
    chip.className = 'attachment'; chip.textContent = 'Data: ' + (importedSets.get(name)?.title ?? name) + ' ';
    remove.type = 'button'; remove.textContent = '×'; remove.disabled = sending;
    remove.setAttribute('aria-label', 'Stop using ' + name + ' in this notebook'); remove.title = 'Stop using this file here. The file stays on this computer.';
    remove.onclick = () => {
      notebook.dataImports = (notebook.dataImports ?? []).filter(item => item !== name);
      if (notebook.dataset === 'import:' + name) delete notebook.dataset;
      saveNotebook(); dataControls();
    };
    chip.append(remove); return chip;
  }));
}
function receiveCourseData(d: {state?: unknown; datasets?: unknown; message?: unknown}) {
  if (d.state === 'loading') { dataState = 'loading'; dataStatus('Loading course data…'); }
  else if (d.state === 'error') { dataState = 'error'; dataStatus('Course data unavailable: ' + String(d.message ?? '').slice(0, 200)); }
  else if (d.state === 'ready' && Array.isArray(d.datasets)) {
    courseData = d.datasets as CourseDataset[]; dataState = 'ready';
    dataStatus('Course data ready: ' + courseData.map(set => set.id.split(':')[1]).join(', '));
    // The about cards and the privacy note, once per notebook.
    if (documentKey && !notebook.cells.some(cell => cell.packet?.data_part === 'info')) addCell('recap', aboutMarkdown(courseData), {data_part:'info'});
  } else { dataState = 'none'; courseData = []; dataStatus(''); }
  controls();
}
function renderDataCell(cell: NotebookCell) {
  appendCard('assistant', body => {
    body.parentElement?.setAttribute('data-cell-id', cell.id);
    renderDataBody(body, cell, text => host.postMessage({type:'dataCopy', attempt, text}));
    conversationControls(body, cell);
  }, !restoring && nearBottom());
}
/** The last four questions and the queries that answered them, from this notebook's own cells. */
function dataHistory() {
  return notebook.cells.filter(cell => cell.packet?.data_part === 'sql' && typeof cell.packet.question === 'string' && typeof cell.packet.sql === 'string')
    .slice(-4).map(cell => ({question:String(cell.packet!.question), sql:String(cell.packet!.sql)}));
}
async function sendData(text: string): Promise<boolean> {
  if (!ready || sending) return false;
  if (!editors.aiEnabled) { helpStatus('AI assistance is off. Turn on dhimantai.aiAssistance in Settings to ask ' + names[mode] + '.'); return false; }
  const id = attempt, draft = field.value, question = text.trim().slice(0, 500);
  if (!question) return false;
  sending = coaching = true; controls();
  try {
    helpStatus(names[mode] + ' is looking at the course data. This can take a minute…');
    const request = ++notebookCounter;
    const reply = await new Promise<DataReply>(resolve => {
      const timer = setTimeout(() => { pendingData = undefined; resolve({error:names[mode] + ' did not reply in time. Your question is still here; try again.'}); }, 200000);
      pendingData = {request, finish:reply => { clearTimeout(timer); pendingData = undefined; resolve(reply); }};
      host.postMessage({type:'dataAsk', attempt:id, request, question, last:notebook.dataset, imports:notebook.dataImports ?? [], history:dataHistory(),
        notebookText:[notebook.title, heading?.textContent ?? ''].join(' '),
        ...(mode === 'doubt_solver' ? {doubtId:currentDoubt()} : {}), ...(mode === 'tutor' && selectedLesson ? {chapterId:selectedLesson} : {})});
    });
    if (id !== attempt) return false;
    if (reply.accessEnded && reply.error) accessNotice(reply.error);
    if (reply.error || !reply.outcome) { helpStatus(reply.error ?? names[mode] + ' could not reply. Try again.'); return false; }
    if (mode === 'doubt_solver' && !notebook.cells.some(isDivider)) addCell('recap', 'New doubt', {doubt_divider:true, doubt_id:currentDoubt()});
    addCell('message', question);
    const titles = (setId: string) => knownData().find(set => set.id === setId)?.title ?? setId;
    for (const cell of outcomeCells(question, reply.outcome, titles)) addCell(cell.kind, cell.text, cell.packet);
    if ('dataset' in reply.outcome) notebook.dataset = reply.outcome.dataset;
    else if (reply.datasets?.length === 1) notebook.dataset = reply.datasets[0];
    saveNotebook();
    if (field.value === draft) field.value = '';
    helpStatus(reply.outcome.kind === 'answer' ? names[mode] + ' answered from the course data. Check it yourself with the question at the end.'
      : reply.outcome.kind === 'sqlError' ? 'The query did not run, even after one retry. Ask again in other words.' : names[mode] + ' replied.');
    return true;
  } finally { if (id === attempt) { sending = coaching = false; controls(); } }
}
function showPreview(plan: ImportPreview) {
  document.querySelector('.data-preview')?.remove();
  const card = previewCard(plan, () => { card.remove(); helpStatus('Creating the table in your course container…'); host.postMessage({type:'dataConfirmImport', attempt}); },
    () => { card.remove(); host.postMessage({type:'dataCancelImport', attempt}); });
  feed.append(card); card.scrollIntoView?.({block:'nearest'});
}
function imported(dataset: CourseDataset) {
  const name = dataset.id.split(':')[1];
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) return;
  importedSets.set(name, dataset);
  notebook.dataImports = [...new Set([...(notebook.dataImports ?? []), name])].slice(-10);
  notebook.dataset = dataset.id; saveNotebook();
  helpStatus(`Imported ${dataset.title} as the table ${name}. Ask about it by name, for example “${name}”.`);
  controls();
}

host.postMessage({type:'ready'});
window.addEventListener('pagehide', () => {
  attachments.clear();
  if (documentKey) host.postMessage({type:'notebookChanged',documentKey,sequence:++saveSequence,notebook:snapshotNotebook()});
  close('Session ended.');
});
