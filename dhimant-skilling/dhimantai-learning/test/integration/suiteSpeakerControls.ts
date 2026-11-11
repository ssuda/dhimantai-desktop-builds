import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { audioControls, audioPolicy } from '../../src/coachAudio';

/** Load the actual shared controls and styles through VS Code's resource/CSP boundary. */
export async function run() {
  const ext = vscode.extensions.getExtension('optficial.dhimantai-learning')!;
  const media = vscode.Uri.joinPath(ext.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('dhimantai.speakerTest', 'Speaker controls check', vscode.ViewColumn.One,
    {enableScripts: true, localResourceRoots: [media]});
  const webview = panel.webview, nonce = 'speaker-controls-test';
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Speaker controls probe did not finish')), 15000);
    webview.onDidReceiveMessage(resolve);
  });
  webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${audioPolicy}; media-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'coach.css'))}">
</head><body>${audioControls(webview, media, nonce)}
<script nonce="${nonce}">
const api = acquireVsCodeApi();
window.addEventListener('load', async () => {
  try {
    window.installCoachAudio({postMessage() { throw new Error('No playback requested'); }});
    const main = document.getElementById('audio-toggle'), group = main.parentElement;
    if (main.hidden || main.getAttribute('aria-label') !== 'Enable spoken explanations') throw new Error('Speaker unavailable');
    if (!document.getElementById('audio-microphone').disabled) throw new Error('Microphone should be disabled');
    if (document.getElementById('audio-resume') || document.getElementById('audio-mute')) throw new Error('Duplicate audio controls');
    if (Math.round(group.getBoundingClientRect().height) !== 44) throw new Error('Split-button CSS did not load');
    main.click();
    if (main.getAttribute('aria-pressed') !== 'true' || group.dataset.muted !== 'false') throw new Error('Enabled state not rendered');
    const arrow = group.querySelector('.audio-chevron'), picker = group.querySelector('.audio-picker');
    arrow.click();
    await new Promise(resolve => setTimeout(resolve, 250));
    if (picker.hidden || arrow.getAttribute('aria-expanded') !== 'true') throw new Error('Output picker did not open');
    const rect = picker.getBoundingClientRect();
    if (rect.width < 100 || rect.right > window.innerWidth || rect.left < 0) throw new Error('Output picker exceeds the panel');
    picker.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    if (!picker.hidden || document.activeElement !== arrow) throw new Error('Keyboard dismissal failed');
    arrow.click();
    group.querySelector('.audio-actions button:last-child').click();
    if (main.getAttribute('aria-pressed') !== 'false' || group.dataset.muted !== 'true') throw new Error('Off state not rendered');
    api.postMessage({ok: true, splitButton: true, disabledMicrophone: true, outputPicker: true, keyboard: true,
      sinkSelectionSupported: 'setSinkId' in AudioContext.prototype});
  } catch (error) { api.postMessage({ok: false, error: String(error)}); }
});
</script></body></html>`;
  try {
    const response = await result;
    assert.equal(response.ok, true, response.error);
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(response, null, 2));
  } finally { clearTimeout(timer!); panel.dispose(); }
}
