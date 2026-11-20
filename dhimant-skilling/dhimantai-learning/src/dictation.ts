import type * as vscode from 'vscode';
import type { Api } from './api';
import { coachingLanguage } from './coachingLanguage';
import { mediaIcon } from './mediaIcons';

export const microphoneControl = '<button type="button" id="audio-microphone" disabled aria-pressed="false" aria-label="Start microphone" title="Start microphone">' +
  mediaIcon('microphone', true) + '</button>';
export const dictationStatus = '<small id="dictation-status" role="status"></small>';

/** Only the visible, current draft may receive the result of a recording. */
export function bindDictation(view: vscode.Webview, current: () => {key: string; api: Api; language?: string} | undefined) {
  let pending: {id:string; controller:AbortController} | undefined;
  const listener = view.onDidReceiveMessage(async message => {
    if (message?.type === 'cancelDictation') {
      if (pending && pending.id === message.id) pending.controller.abort();
      return;
    }
    if (message?.type !== 'dictate' || typeof message.id !== 'string' || message.id.length > 80) return;
    const target = current();
    pending?.controller.abort();
    if (!target || target.key !== message.key || typeof message.pcm !== 'string' || !message.pcm.length || message.pcm.length > 1280000) {
      await view.postMessage({type:'dictated', id:message.id, error:'Reopen the active chat and try the microphone again.'});
      return;
    }
    const controller = new AbortController();
    pending = {id:message.id, controller};
    try {
      const {text} = await target.api.dictate(message.pcm, coachingLanguage(target.language), controller.signal);
      if (!controller.signal.aborted && current()?.key === target.key) await view.postMessage({type:'dictated', id:message.id, text});
    } catch (error) {
      if (!controller.signal.aborted) await view.postMessage({type:'dictated', id:message.id,
        error:error instanceof Error ? error.message : 'Voice transcription failed. Try again or type your question.'});
    } finally { if (pending?.controller === controller) pending = undefined; }
  });
  return {dispose() { pending?.controller.abort(); listener.dispose(); }};
}
