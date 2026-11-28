import * as vscode from 'vscode';
import { Api, ApiError } from './api';
import { Auth, SignInRequired } from './auth';
import { Environment, EnvironmentName } from './environments';
import { messageComposer } from './learningComposer';
import { mentorLanguageControl } from './coachingLanguage';
import { microphoneControl } from './dictation';

export interface SpokenReply {
  id: string; text: string; account: string; environment: EnvironmentName; path: string; query?: string;
}

export { audioPolicy, trustedRoomUrl } from './voiceHosts';
import { trustedRoomUrl } from './voiceHosts';

export { microphoneControl } from './dictation';

export function audioControls(webview: vscode.Webview, media: vscode.Uri, nonce: string, microphone = microphoneControl) {
  const script = (file: string) => `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, file))}"></script>`;
  return `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'audioControls.css'))}">` +
    `<div id="coach-audio" data-worklet="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'coachAudioBuffer.js'))}">` +
    microphone +
    '<button type="button" id="audio-toggle" aria-pressed="false" aria-describedby="audio-help">Enable spoken explanations</button>' +
    '<span id="audio-status" class="audio-sr-only" role="status">Spoken explanations off</span>' +
    '<p id="audio-help" class="audio-sr-only">Select the speaker to hear this and subsequent replies. The same control pauses, resumes or retries the explanation. Open the arrow menu to choose voice speed, mute, choose an output or turn spoken explanations off.</p></div>' +
    script('livekit-client.umd.js') + script('learning-room/audioControls.js') + script('coachAudio.js');
}

/** Instructor chats share their device controls and scripts as well as their message form. */
export function instructorComposer(webview: vscode.Webview, media: vscode.Uri, nonce: string,
    options: Omit<Parameters<typeof messageComposer>[0], 'assistant' | 'audio' | 'camera'> & {assistant?: 'Project Mentor'}, microphoneScript = 'dictation.js') {
  const form = messageComposer({assistant:'Instructor', ...options,
    support:(options.support ?? '') + (options.assistant === 'Project Mentor' ? mentorLanguageControl : ''),
    audio:audioControls(webview, media, nonce),
    camera:vscode.env.appName === 'dhimantAI'});
  const dictation = webview.asWebviewUri(vscode.Uri.joinPath(media, microphoneScript));
  return form + `<script nonce="${nonce}" src="${dictation}"></script>`;
}

export class CoachAudio {
  constructor(private readonly secrets: vscode.SecretStorage, private readonly service: (name: EnvironmentName) => Environment) {}

  bind(webview: vscode.Webview, current: () => SpokenReply | undefined): vscode.Disposable {
    let disposed = false;
    let ticket: string | undefined;
    let attempt = 0;
    const handler = webview.onDidReceiveMessage(async m => {
      if (m?.type !== 'audioJoin' && m?.type !== 'audioStart') return;
      const target = current();
      if (!target || m.id !== target.id || !Number.isSafeInteger(m.attempt)) return;
      if (m.type === 'audioJoin') {
        if (m.attempt <= attempt) return;
        attempt = m.attempt;
        ticket = undefined;
      } else if (attempt !== m.attempt || !ticket) return;
      const active = () => !disposed && m.attempt === attempt && current()?.id === target.id;
      try {
        const env = this.service(target.environment);
        const auth = new Auth(this.secrets, () => target.environment, () => env);
        const api = new Api(auth, () => {
          if (!active()) throw new Error('The selected reply changed');
          return env;
        }, target.account);
        if (m.type === 'audioStart') {
          const issued = ticket;
          ticket = undefined;
          const speed = [0.5, 1, 1.5, 2].includes(m.speed) ? m.speed : 1;
          await api.startAudio(target.path, target.text, issued!, speed, target.query);
          return;
        }
        const grant = await api.audioGrant(target.path, target.text, target.query);
        if (!active()) return;
        if (!trustedRoomUrl(target.environment, grant.url)) throw new Error('Unknown playback host');
        ticket = grant.token;
        await webview.postMessage({type: 'audioGrant', id: target.id, attempt, url: grant.url, token: grant.token});
      } catch (error) {
        if (!active()) return;
        const status = error instanceof ApiError ? error.status : undefined;
        let message = m.type === 'audioJoin' ? 'Could not open a speech session. Select the speaker to retry.'
          : 'The speech service could not start this explanation. Select the speaker to retry.';
        if (status === 0) message = 'Could not reach the speech service. Check your connection, then select the speaker to retry.';
        if (status === 401 || error instanceof SignInRequired) message = 'Sign in to hear spoken explanations, then select the speaker to retry.';
        if (status === 403 && m.type === 'audioJoin') message = 'Speech access was denied. Check your account and course access, then retry.';
        if (status === 404 && m.type === 'audioJoin') message = 'The speech service could not find audio for this lesson. If retrying fails, contact support.';
        if (status === 409) message = 'The lesson changed. Open the current lesson and select the speaker.';
        if (status === 429) message = 'Speech requests are temporarily limited. Wait a moment, then select the speaker to retry.';
        await webview.postMessage({type: 'audioError', id: target.id, attempt, message});
      }
    });
    return new vscode.Disposable(() => { disposed = true; ticket = undefined; handler.dispose(); });
  }
}
