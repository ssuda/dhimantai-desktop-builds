import * as vscode from 'vscode';
import { Environment, EnvironmentName } from './environments';
import { STUDENT_SIGN_IN_FAILED, checkStudentIdentifier, isNetworkError, legacyStudentEmail, studentEmail } from './studentLogin';
import { WEB_APP_ORIGINS, studentSignupUrl } from './appLinks';
import { learnerRpc } from './learnerCatalog';

/** A Supabase GoTrue session, the same identity the Flutter app sends as a Bearer token. */
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email?: string; phone?: string };
}

export class SignInRequired extends Error {
  constructor(message = 'Sign in to dhimantAI to continue.') {
    super(message);
  }
}

class AuthResponseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

let diagnostics: Pick<vscode.OutputChannel, 'appendLine'> | undefined;
export function setAuthDiagnostics(output: Pick<vscode.OutputChannel, 'appendLine'>) { diagnostics = output; }
// Notebook helpers create their own Auth objects; share refreshes for the same stored session.
const refreshes = new WeakMap<vscode.SecretStorage, Map<string, Promise<Session>>>();
const sessionWrites = new WeakMap<vscode.SecretStorage, Promise<void>>();
const rejectedSessionCodes = new Set(['refresh_token_not_found', 'refresh_token_already_used',
  'session_not_found', 'session_expired', 'user_not_found', 'user_banned', 'invalid_grant']);

function refreshFailure(error: unknown): string {
  if (error instanceof AuthResponseError) {
    // Only structured codes, never provider messages, URLs, tokens or response bodies.
    const code = error.code && (rejectedSessionCodes.has(error.code)
      || ['unexpected_failure', 'over_request_rate_limit', 'request_timeout', 'validation_failed'].includes(error.code))
      ? ` (${error.code})` : '';
    return `HTTP ${error.status}${code}`;
  }
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'request timed out';
  if (error instanceof TypeError) return 'network connection failed';
  return 'invalid session response';
}

async function gotrue(env: Environment, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: env.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await response.json().catch(error => {
    if (error instanceof SyntaxError) return {};
    throw error; // A timeout or lost connection while reading the body is retryable too.
  }) ?? {};
  if (!response.ok) {
    const message = data.error_description || data.msg || data.message || data.error;
    throw new AuthResponseError(typeof message === 'string' && message ? message : `Sign-in failed (${response.status}).`,
      response.status, data.error_code ?? data.code ?? data.error);
  }
  return data;
}

function toSession(data: any): Session {
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) {
    throw new Error('Sign-in did not return a session.');
  }
  const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    user: { id: data.user.id, email: data.user.email || undefined, phone: data.user.phone || undefined },
  };
}

export class Auth {
  private readonly changed = new vscode.EventEmitter<Session | undefined>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly envName: () => EnvironmentName, private readonly env: () => Environment) {}

  private key() {
    return `dhimantai.session.${this.envName()}`;
  }

  async session(key = this.key()): Promise<Session | undefined> {
    const raw = await this.secrets.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return undefined;
    }
  }

  private async store(session: Session | undefined, key = this.key(), expected?: Session) {
    // Serialize the comparison and write with sign-out/sign-in across Auth helpers.
    const write = (sessionWrites.get(this.secrets) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (expected) {
        const stored = await this.session(key);
        if (stored?.refresh_token !== expected.refresh_token || stored?.user.id !== expected.user.id) {
          throw new Error('Your session changed. Reopen the lesson.');
        }
      }
      if (session) await this.secrets.store(key, JSON.stringify(session));
      else await this.secrets.delete(key);
      if (key === this.key()) this.changed.fire(session);
    });
    sessionWrites.set(this.secrets, write);
    try { await write; }
    finally { if (sessionWrites.get(this.secrets) === write) sessionWrites.delete(this.secrets); }
  }

  /** Forgets the local session immediately, then revokes it on the server (best effort). */
  async signOut() {
    const key = this.key(), env = this.env();
    const current = await this.session(key);
    // Forget immediately so a refresh completing during logout cannot restore the session.
    await this.store(undefined, key);
    if (current) {
      // scope=local revokes this device's refresh token only; other devices stay signed in.
      await fetch(`${env.supabaseUrl}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: env.supabaseAnonKey, Authorization: `Bearer ${current.access_token}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined); // Offline: the local session is still removed.
    }
  }

  /** Returns a fresh access token, refreshing when under 60 s remain (matches the Flutter client). */
  async accessToken(force = false): Promise<string> {
    const key = this.key(), env = this.env();
    const current = await this.session(key);
    if (key !== this.key()) throw new Error('Your service changed. Reopen the lesson.');
    if (!current) throw new SignInRequired();
    if (!force && current.expires_at - Date.now() / 1000 > 60) return current.access_token;
    let pending = refreshes.get(this.secrets);
    if (!pending) refreshes.set(this.secrets, pending = new Map());
    // A newly signed-in session must not join the previous account's refresh.
    const refreshKey = key + ':' + current.refresh_token;
    if (!pending.has(refreshKey)) {
      pending.set(refreshKey, this.refresh(current, key, env).finally(() => pending!.delete(refreshKey)));
    }
    const next = await pending.get(refreshKey)!;
    if (key !== this.key()) throw new Error('Your service changed. Reopen the lesson.');
    return next.access_token;
  }

  private async refresh(current: Session, key: string, env: Environment): Promise<Session> {
    const unchanged = async () => {
      const stored = await this.session(key);
      if (stored?.refresh_token !== current.refresh_token || stored?.user.id !== current.user.id) {
        throw new Error('Your session changed. Reopen the lesson.');
      }
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await unchanged();
      let next: Session;
      try {
        next = toSession(await gotrue(env, 'token?grant_type=refresh_token', { refresh_token: current.refresh_token }));
      } catch (error) {
        await unchanged();
        const rejected = error instanceof AuthResponseError && [400, 401, 403].includes(error.status)
          && rejectedSessionCodes.has(error.code ?? '');
        const retryable = error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          || (error instanceof AuthResponseError && (error.status >= 500 || [408, 429].includes(error.status)));
        diagnostics?.appendLine(`[${new Date().toISOString()}] Session refresh ${attempt}/3: ${refreshFailure(error)}; `
          + (rejected ? 'sign-in required.' : retryable && attempt < 3 ? 'retrying.' : 'saved session retained.'));
        if (rejected) {
          await this.store(undefined, key, current);
          throw new SignInRequired('Your dhimantAI session has expired or was revoked. Sign in again.');
        }
        if (!retryable || attempt === 3) {
          throw new Error('Could not refresh your dhimantAI session. Your sign-in is saved. Check your connection and try again. See the dhimantAI output channel for details.');
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        continue;
      }
      await unchanged();
      if (next.user.id !== current.user.id) {
        diagnostics?.appendLine(`[${new Date().toISOString()}] Session refresh: account mismatch; sign-in required.`);
        await this.store(undefined, key, current);
        throw new SignInRequired('Your account changed. Sign in again.');
      }
      await this.store(next, key, current);
      return next;
    }
    throw new Error('Session refresh attempt budget exhausted.');
  }

  async signInWithPassword(email: string, password: string): Promise<Session> {
    const environment = this.envName(), env = this.env();
    const data = await gotrue(env, 'token?grant_type=password', { email: email.trim(), password });
    return this.acceptSession(data, environment, env);
  }

  private async acceptSession(data: any, environment: EnvironmentName, env: Environment): Promise<Session> {
    const session = toSession(data);
    if (data.user?.user_metadata?.learner_type === 'individual') {
      await learnerRpc(env, 'complete_individual_signup', { p_name: data.user.user_metadata.name }, session.access_token);
    }
    if (this.envName() !== environment) throw new Error(`Your service changed. Sign in to ${environment} to continue.`);
    await this.store(session);
    return session;
  }

  async signUpWithPassword(name: string, email: string, password: string): Promise<Session | undefined> {
    if (name.trim().length < 2 || name.trim().length > 100) throw new Error('Enter a name between 2 and 100 characters.');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error('Enter your email address.');
    if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
    const environment = this.envName(), env = this.env();
    // Check rollout readiness before creating an auth identity that cannot complete onboarding.
    await learnerRpc(env, 'public_learning_catalog');
    if (this.envName() !== environment) throw new Error('Your service changed. Start signup again.');
    const data = await gotrue(env, 'signup', { email: email.trim(), password,
      data: { name: name.trim(), learner_type: 'individual' } });
    if (!data.access_token) {
      void vscode.window.showInformationMessage('Check your email to confirm your account, then return to VS Code and sign in. If you already have an account, sign in with your existing password.', 'Sign In')
        .then(choice => { if (choice) return vscode.commands.executeCommand('dhimantai.signIn', environment); });
      return undefined;
    }
    return this.acceptSession(data, environment, env);
  }

  async signUp(): Promise<Session | undefined> {
    const choice = await vscode.window.showQuickPick([
      { label: 'Individual learner', description: 'Email and password · choose your own courses', id: 'individual' },
      { label: 'Institute student', description: 'Register with your institute in the browser', id: 'institute' },
    ], { title: `Create a dhimantAI account${this.envName() === 'production' ? '' : ` (${this.envName()})`}` });
    if (!choice) return;
    if (choice.id === 'institute') { await this.signUpWithInstitute(); return; }
    const environment = this.envName();
    const name = await vscode.window.showInputBox({ title: 'Your name (step 1 of 4)', ignoreFocusOut: true,
      validateInput: value => value.trim().length >= 2 && value.trim().length <= 100 ? undefined : 'Use 2–100 characters.' });
    if (!name) return;
    const email = await vscode.window.showInputBox({ title: 'Your email address (step 2 of 4)', prompt: 'Use an email address you can verify.', ignoreFocusOut: true,
      validateInput: value => /^\S+@\S+\.\S+$/.test(value.trim()) ? undefined : 'Enter your email address.' });
    if (!email) return;
    const password = await vscode.window.showInputBox({ title: 'Create a password (step 3 of 4)', password: true, ignoreFocusOut: true,
      validateInput: value => value.length >= 8 ? undefined : 'Use at least 8 characters.' });
    if (!password) return;
    const confirmation = await vscode.window.showInputBox({ title: 'Confirm your password (step 4 of 4)', password: true, ignoreFocusOut: true,
      validateInput: value => value === password ? undefined : 'Passwords do not match.' });
    if (!confirmation) return;
    if (confirmation !== password) throw new Error('Passwords do not match.');
    if (this.envName() !== environment) throw new Error('Your service changed. Start signup again.');
    return this.signUpWithPassword(name, email, password);
  }

  /** Institute code + roll number + password, exactly as the app signs students in (current, then legacy format). */
  async signInWithStudentId(instituteCode: string, rollNumber: string, password: string): Promise<Session> {
    const email = studentEmail(instituteCode, rollNumber);
    if (!email) throw new Error('Enter your institute code and roll number.');
    try {
      return await this.signInWithPassword(email, password);
    } catch (first) {
      const message = first instanceof Error ? first.message : String(first);
      if (isNetworkError(message)) throw first;
      try {
        return await this.signInWithPassword(legacyStudentEmail(instituteCode, rollNumber), password);
      } catch (second) {
        const detail = second instanceof Error ? second.message : String(second);
        if (isNetworkError(detail)) throw second;
        throw new Error(/invalid login credentials/i.test(message) ? STUDENT_SIGN_IN_FAILED : message);
      }
    }
  }

  /** Registration stays in the app so profile requirements and institute approval stay in sync. */
  async signUpWithInstitute(): Promise<void> {
    const environment = this.envName();
    const url = studentSignupUrl(environment);
    if (!url) {
      throw new Error('For local signup, open /#/student-signup in your local DhimantAI web app. Complete registration and institute approval, then choose dhimantAI: Sign In in VS Code.');
    }
    if (!await vscode.env.openExternal(vscode.Uri.parse(url))) {
      throw new Error(`Could not open signup in your browser. Open ${url}, then return to VS Code and choose dhimantAI: Sign In.`);
    }
    // Leave the extension usable while the learner registers. Opening the browser is not sign-in.
    void vscode.window.showInformationMessage(
      `Complete student signup in your browser (${environment}). Have your institute code and roll number ready. After your institute approves your account, return here and sign in with those details and your password.`,
      'Sign In',
    ).then(async choice => {
      if (choice !== 'Sign In') return;
      if (this.envName() !== environment) {
        void vscode.window.showWarningMessage(`Signup was opened for ${environment}, but VS Code now uses ${this.envName()}. Select ${environment} in Dhimantai: Environment before signing in to that account.`);
        return;
      }
      await vscode.commands.executeCommand('dhimantai.signIn', environment);
    });
  }

  /** Interactive sign-in with the app's methods, plus a browser signup entry point. */
  async signIn(): Promise<Session | undefined> {
    const method = await vscode.window.showQuickPick(
      [
        { label: 'Email and password', description: 'Individual learners', id: 'email' },
        { label: 'Institute code and roll number', description: 'Institute students: the same details and password you use in the app', id: 'student' },
        { label: 'Phone number', description: 'Receive a one-time code by SMS', id: 'phone' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
        { label: 'Create an account', description: 'New to dhimantAI? The first chapter of every course is free', id: 'signup' },
        { label: 'Forgot password?', description: 'Institute students: reset it in the dhimantAI app', id: 'forgot' },
      ],
      { title: `Sign in to dhimantAI${this.envName() === 'production' ? '' : ` (${this.envName()})`}`, placeHolder: 'Use the same account you use in the dhimantAI app' },
    );
    if (!method) return undefined;
    if (method.id === 'signup') {
      return this.signUp();
    }
    if (method.id === 'forgot') {
      const origin = WEB_APP_ORIGINS[this.envName()];
      if (!origin) throw new Error('Password reset is not available for this service.');
      await vscode.env.openExternal(vscode.Uri.parse(origin + '/#/student-forgot-password'));
      return undefined;
    }
    const env = this.env();
    if (method.id === 'student') {
      const instituteCode = await vscode.window.showInputBox({ title: 'Institute code', prompt: 'From your school or institute', ignoreFocusOut: true, validateInput: v => checkStudentIdentifier(v, 'institute code') });
      if (!instituteCode) return undefined;
      const rollNumber = await vscode.window.showInputBox({ title: 'Roll number', ignoreFocusOut: true, validateInput: v => checkStudentIdentifier(v, 'roll number') });
      if (!rollNumber) return undefined;
      const password = await vscode.window.showInputBox({ title: 'Password', password: true, ignoreFocusOut: true, validateInput: v => (v ? undefined : 'Enter your password.') });
      if (!password) return undefined;
      return this.signInWithStudentId(instituteCode, rollNumber, password);
    }
    if (method.id === 'email') {
      const email = await vscode.window.showInputBox({ title: 'dhimantAI email', ignoreFocusOut: true, validateInput: v => (/^\S+@\S+\.\S+$/.test(v.trim()) ? undefined : 'Enter your email address.') });
      if (!email) return undefined;
      const password = await vscode.window.showInputBox({ title: 'dhimantAI password', password: true, ignoreFocusOut: true });
      if (!password) return undefined;
      return this.signInWithPassword(email, password);
    }
    const phone = await vscode.window.showInputBox({
      title: 'Phone number',
      prompt: 'Include the country code, for example +919876543210',
      ignoreFocusOut: true,
      validateInput: v => (/^\+[1-9]\d{7,14}$/.test(v.replace(/[\s-]/g, '')) ? undefined : 'Use international format, for example +919876543210.'),
    });
    if (!phone) return undefined;
    const normalized = phone.replace(/[\s-]/g, '');
    await gotrue(env, 'otp', { phone: normalized, create_user: false });
    const token = await vscode.window.showInputBox({ title: 'Enter the code sent by SMS', ignoreFocusOut: true, validateInput: v => (/^\d{4,8}$/.test(v.trim()) ? undefined : 'Enter the numeric code.') });
    if (!token) return undefined;
    const session = toSession(await gotrue(env, 'verify', { type: 'sms', phone: normalized, token: token.trim() }));
    await this.store(session);
    return session;
  }
}
