import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Auth, Session } from './auth';
import { authPageHtml, AuthPageMode } from './authPageHtml';
import type { EnvironmentName } from './environments';

// Notebook helpers share SecretStorage, so every entry point reuses the same account page.
const pages = new WeakMap<object, AuthPage>();

export function openAuthPage(owner: object, auth: Auth, environment: () => EnvironmentName, mode: AuthPageMode): Promise<Session | undefined> {
  let page = pages.get(owner);
  if (!page) {
    page = new AuthPage(auth, environment, mode, () => pages.delete(owner));
    pages.set(owner, page);
  } else page.open(mode);
  return page.result;
}

class AuthPage {
  readonly result: Promise<Session | undefined>;
  private resolve!: (session: Session | undefined) => void;
  private readonly panel: vscode.WebviewPanel;
  private readonly environment: EnvironmentName;
  private busy = false;
  private closed = false;
  private mode: AuthPageMode;

  constructor(private readonly auth: Auth, private readonly currentEnvironment: () => EnvironmentName,
      mode: AuthPageMode, onClose: () => void) {
    this.environment = currentEnvironment();
    this.mode = mode;
    this.result = new Promise(resolve => { this.resolve = resolve; });
    this.panel = vscode.window.createWebviewPanel('dhimantai.auth', '', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const received = this.panel.webview.onDidReceiveMessage(message => this.handle(message));
    const config = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('dhimantai.environment') && this.environment !== currentEnvironment()) this.panel.dispose();
    });
    this.panel.onDidDispose(() => {
      this.closed = true;
      received.dispose(); config.dispose(); onClose(); this.resolve(undefined);
    });
    this.render();
  }

  open(mode: AuthPageMode) {
    if (!this.busy && mode !== this.mode) { this.mode = mode; this.render(); }
    this.panel.reveal();
  }

  private render(notice = '') {
    this.panel.title = this.mode === 'signUp' ? 'dhimantAI · Sign up' : 'dhimantAI · Sign in';
    this.panel.webview.html = authPageHtml(this.mode, randomBytes(18).toString('base64'), this.environment, notice);
  }

  private async handle(message: any) {
    if (this.closed || this.busy || !message || this.environment !== this.currentEnvironment()) return;
    if (message.type === 'navigate' && (message.mode === 'signIn' || message.mode === 'signUp')) {
      this.open(message.mode);
      return;
    }
    if (message.type !== 'submit' || message.mode !== this.mode) return;
    this.busy = true;
    try {
      const { email, password, name, confirmation } = message;
      if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error('Enter your email address.');
      if (typeof password !== 'string' || !password) throw new Error('Enter your password.');
      let session: Session | undefined;
      if (this.mode === 'signUp') {
        if (typeof name !== 'string') throw new Error('Enter your name.');
        if (confirmation !== password) throw new Error('Passwords do not match.');
        session = await this.auth.signUpWithPassword(name, email, password, false);
      } else session = await this.auth.signInWithPassword(email, password);
      if (this.closed) return;
      if (session) { this.resolve(session); this.panel.dispose(); }
      else {
        this.mode = 'signIn';
        this.render('Check your email to confirm your account, then sign in. If you already have an account, use your existing password.');
      }
    } catch (error) {
      if (!this.closed) await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not sign in. Please try again.' });
    } finally { this.busy = false; }
  }
}
