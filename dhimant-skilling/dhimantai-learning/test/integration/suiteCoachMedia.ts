// Real VS Code resource/CSP check: a browser-only mock cannot verify worklet loading.
import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { audioControls, audioPolicy } from '../../src/coachAudio';

export async function run() {
  const ext = vscode.extensions.getExtension('optficial.dhimantai-learning')!;
  const media = vscode.Uri.joinPath(ext.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('dhimantai.mediaTest', 'Instructor media check', vscode.ViewColumn.One,
    {enableScripts: true, localResourceRoots: [media]});
  const webview = panel.webview, nonce = 'coach-media-test';
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Instructor media probe did not finish')), 15000);
    webview.onDidReceiveMessage(message => resolve(message));
  });
  webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${audioPolicy}; media-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}">
</head><body>${audioControls(webview, media, nonce)}
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'coachMarkdown.js'))}"></script>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
(async () => {
  let context;
  try {
    const rendered = window.CoachMarkdown.render('# Exercise\\n\\n- Read input\\n\\nUse \\x60word\\x60.');
    const parsed = document.createElement('div'); parsed.innerHTML = rendered;
    if (!parsed.querySelector('h1') || !parsed.querySelector('li') || !parsed.querySelector('code')) throw new Error('Markdown bundle did not render');
    context = new AudioContext();
    await context.audioWorklet.addModule(document.getElementById('coach-audio').dataset.worklet);
    const buffer = new AudioWorkletNode(context, 'coach-audio-buffer', {channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1]});
    buffer.disconnect();
    api.postMessage({ok: true, markdown: true, worklet: true});
  } catch (error) { api.postMessage({ok: false, error: String(error)}); }
  finally { if (context) await context.close(); }
})();
</script></body></html>`;
  try {
    const response = await result;
    assert.equal(response.ok, true, response.error);
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(response, null, 2));
  } finally { clearTimeout(timer!); panel.dispose(); }
}
