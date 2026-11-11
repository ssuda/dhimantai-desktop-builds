import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CdpClient, injectPlayer} from './inject';
import {AppServer} from './types';

/** The desktop's proposed integrated-browser API (vscode.proposed.browser.d.ts), used only when enabled. */
interface BrowserTab { readonly url: string; startCDPSession(): Thenable<BrowserCDPSession>; close(): Thenable<void> }
interface BrowserCDPSession { readonly onDidReceiveMessage: vscode.Event<unknown>; sendMessage(message: unknown): Thenable<void>; close(): Thenable<void> }
type BrowserWindow = {openBrowserTab?: (url: string, options?: {viewColumn?: vscode.ViewColumn; preserveFocus?: boolean}) => Thenable<BrowserTab>};

export interface InjectedTab { client: CdpClient; sessionId: string; dispose(): Promise<void> }
export interface TabRequest {
  url: string; home: string; media: string; adapter: string; learner?: string;
  /** learner, bridge and token from the loopback Instructor bridge; omitted for authoring replay (adapter only). */
  bridge?: URLSearchParams;
  /** Signs the learner in on the server side; its session cookie is handed to the tab. */
  server: AppServer;
}

/**
 * Opens the application beside the Instructor and installs the task player through DevTools.
 * Returns undefined when this desktop does not offer the browser API (for example stock VS Code),
 * so the caller can fall back to a player bundled in the application image.
 */
export async function openInjectedTab(request: TabRequest): Promise<InjectedTab | undefined> {
  let open: BrowserWindow['openBrowserTab'];
  try { open = (vscode.window as unknown as BrowserWindow).openBrowserTab; } catch { return undefined; }
  if (typeof open !== 'function') return undefined;
  const files = [join('apps', request.adapter + '.js'), ...(request.bridge ? [join('player', 'guide.js'), join('player', 'live.js')] : [])];
  const scripts = await Promise.all(files.map(path => readFile(join(request.media, path), 'utf8')));
  await request.server.login();
  const tab = await open(request.url + '/', {viewColumn: vscode.ViewColumn.Beside});
  const session = await tab.startCDPSession();
  const client = new CdpClient({send: message => session.sendMessage(message), onMessage: listener => session.onDidReceiveMessage(listener)});
  let sessionId: string;
  try {
    sessionId = await injectPlayer(client, {origin: request.url, scripts, home: request.home, cookie: request.server.sessionCookie(),
      session: request.bridge && request.learner ? {'dhimantai-erpnext-learner': request.learner, 'dhimantai-erpnext-instructor': JSON.stringify({
        origin: 'http://127.0.0.1:' + request.bridge.get('bridge'), token: request.bridge.get('token'), learner: request.learner})} : {}});
  } catch (error) { client.dispose(); await session.close(); throw error; }
  return {client, sessionId, async dispose() { client.dispose(); await session.close(); }};
}
