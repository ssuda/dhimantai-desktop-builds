import * as vscode from 'vscode';
import { Api } from './api';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';

export interface SpokenReply {
  id: string; text: string; account: string; environment: EnvironmentName; path: string;
}

// Only the configured DhimantAI signaling hosts are reachable in this webview.
// Local development can run a private loopback server on a separate port.
const hosts: Record<EnvironmentName, string[]> = {
  production: ['wss://lk-prod.dhimant.ai', 'wss://lk.dhimant.ai'],
  staging: ['wss://lk-staging.dhimant.ai'], development: ['wss://lk-dev.vidyai.in'],
  local: ['ws://localhost:*', 'ws://127.0.0.1:*'],
};
export const audioPolicy = Object.values(hosts).flat().flatMap(u => [u, u.replace(/^ws/, 'http')]).join(' ');

export function trustedRoomUrl(environment: EnvironmentName, url: string) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password) return false;
  return environment === 'local'
    ? endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
    : hosts[environment].includes(endpoint.origin);
}

export const microphoneControl = '<button type="button" id="audio-microphone" disabled aria-label="Voice input is unavailable. Type your message." title="Voice input is unavailable. Type your message.">' +
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8M2 2l20 20"/></svg></button>';

export function audioControls(webview: vscode.Webview, media: vscode.Uri, nonce: string) {
  const script = (file: string) => `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, file))}"></script>`;
  return `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'audioControls.css'))}">` +
    `<div id="coach-audio" data-worklet="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'coachAudioBuffer.js'))}">` +
    microphoneControl +
    '<button type="button" id="audio-toggle" aria-pressed="false" aria-describedby="audio-help">Enable spoken replies</button>' +
    '<span id="audio-status" class="audio-sr-only" role="status">Spoken replies off</span>' +
    '<p id="audio-help" class="audio-sr-only">Select the speaker for a spoken explanation of the reply. The same control pauses, resumes or explains it again. Open the arrow menu to mute, choose an output or turn spoken replies off.</p></div>' +
    script('livekit-client.umd.js') + script('learning-room/audioControls.js') + script('coachAudio.js');
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
          await api.startAudio(target.path, target.text, issued!);
          return;
        }
        const grant = await api.audioGrant(target.path, target.text);
        if (!active()) return;
        if (!trustedRoomUrl(target.environment, grant.url)) throw new Error('Unknown playback host');
        ticket = grant.token;
        await webview.postMessage({type: 'audioGrant', id: target.id, attempt, url: grant.url, token: grant.token});
      } catch {
        if (active()) await webview.postMessage({type: 'audioError', id: target.id, attempt});
      }
    });
    return new vscode.Disposable(() => { disposed = true; ticket = undefined; handler.dispose(); });
  }
}
