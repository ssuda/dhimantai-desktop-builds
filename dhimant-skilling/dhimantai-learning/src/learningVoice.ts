import type * as vscode from 'vscode';
import type { Api } from './api';
import type { EnvironmentName } from './environments';
import { bindDictation } from './dictation';
import type { PracticeLink } from './practiceIpynb';
import { practiceVoiceMode } from './practiceVoiceMode';

export type VoiceMode = { mode: 'tutor' | 'doubt_solver' | 'pyq_practice'; } & Record<string, unknown>;
type Target = { key: string; api: Api; environment: EnvironmentName; path?: string; language?: string; mode: VoiceMode; };

export function notebookMicrophoneScript(appName: string) {
  return appName === 'dhimantAI' ? 'learning-room/learningVoice.js' : 'dictation.js';
}

/** The same room grant used by the learning tabs, scoped to the open exercise or selected cell. */
export function bindNotebookMicrophone(view: vscode.Webview, application: { appName: string; appRoot: string; }, current: () => Target | undefined) {
  if (application.appName !== 'dhimantAI') return bindDictation(view, current);
  let latest: string | undefined;
  const listener = view.onDidReceiveMessage(async msg => {
    if (msg?.type !== 'learningVoice' || typeof msg.id !== 'string' || msg.id.length > 80) return;
    const target = current();
    latest = msg.id;
    try {
      if (!target || target.key !== msg.key) throw new Error('Reopen the active notebook to use the microphone.');
      const mode = target.mode;
      const grant = await target.api.learningRoomGrant(mode.mode === 'doubt_solver' ? 'doubt_solver' : 'tutor',
        target.environment, application.appRoot, target.path);
      if (latest === msg.id && current()?.key === target.key)
        await view.postMessage({ type: 'learningVoiceGrant', id: msg.id, ...grant, mode: { ...mode, ...(target.language ? { language: target.language } : {}) } });
    } catch (error) {
      if (latest === msg.id) await view.postMessage({
        type: 'learningVoiceGrant', id: msg.id,
        error: error instanceof Error ? error.message : 'Could not connect the microphone.'
      });
    }
  });
  return { dispose() { latest = undefined; listener.dispose(); } };
}

export function cellVoiceMode(question: string, language: string, source: string, path: string, doubtId: string, practice?: PracticeLink): VoiceMode {
  const topic = question.trim().split('\n')[0].slice(0, 180);
  const cell = ('Selected notebook cell (' + language + ')\n' + source).slice(0, 1400);
  if (path.startsWith('/doubt-practice/')) return {
    mode: 'doubt_solver', doubt_id: doubtId,
    recap: [{ role: 'learner', text: question.slice(0, 1400) }, { role: 'learner', text: cell }]
  };
  if (practice) return practiceVoiceMode(practice.questionId, practice.title, question + '\n\n' + cell, practice.course || language, 'coding');
  return { mode: 'tutor', lesson_name: topic, lesson_subject: language, screen_context: { question: question.slice(0, 1000), cell } };
}
