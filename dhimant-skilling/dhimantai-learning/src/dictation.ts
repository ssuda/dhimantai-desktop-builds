import type * as vscode from 'vscode';
import type { Api } from './api';
import { coachingLanguage } from './coachingLanguage';
import { mediaIcon } from './mediaIcons';

export const microphoneControl = '<button type="button" id="audio-microphone" disabled aria-pressed="false" aria-label="Start microphone" title="Start microphone">' +
  mediaIcon('microphone', true) + '</button>';
export const dictationStatus = '<small id="dictation-status" role="status"></small>';

/** Only the visible, current conversation can request a microphone room. */
export function bindDictation(view: vscode.Webview, current: () => {key: string; api: Pick<Api, 'voiceInputGrant'>; language?: string} | undefined) {
  let pending: {id:string; controller:AbortController} | undefined;
  const listener = view.onDidReceiveMessage(async message => {
    if (message?.type === 'cancelDictation') {
      if (pending && pending.id === message.id) pending.controller.abort();
      return;
    }
    if (message?.type !== 'voiceInputGrant' || typeof message.id !== 'string' || message.id.length > 80) return;
    const target = current();
    pending?.controller.abort();
    if (!target || target.key !== message.key) {
      await view.postMessage({type:'voiceInputGrant', id:message.id, error:'Reopen the active chat and try the microphone again.'});
      return;
    }
    const controller = new AbortController();
    pending = {id:message.id, controller};
    try {
      const language = target.language === 'auto' ? undefined : coachingLanguage(target.language);
      const result = await target.api.voiceInputGrant(language, controller.signal);
      if (!controller.signal.aborted && current()?.key === target.key) await view.postMessage({type:'voiceInputGrant', id:message.id, url:result.url, token:result.token});
    } catch (error) {
      if (!controller.signal.aborted) await view.postMessage({type:'voiceInputGrant', id:message.id,
        error:error instanceof Error ? error.message : 'Voice transcription failed. Try again or type your question.'});
    } finally { if (pending?.controller === controller) pending = undefined; }
  });
  return {dispose() { pending?.controller.abort(); listener.dispose(); }};
}
