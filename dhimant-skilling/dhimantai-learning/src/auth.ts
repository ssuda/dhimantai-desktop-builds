import * as vscode from 'vscode';
import { Environment, EnvironmentName } from './environments';
import { openAuthPage } from './authPage';
import { learnerRpc } from './learnerCatalog';
import { createHash, randomBytes } from 'node:crypto';
import { authInputErrors } from './authValidation';

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
const passwordRecoveries = new WeakMap<vscode.SecretStorage, {session: Session; environment: EnvironmentName; service: Environment}>();
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

async function gotrue(env: Environment, path: string, body: unknown,
    options: {method?: 'POST' | 'PUT'; token?: string} = {}): Promise<any> {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/${path}`, {
    method: options.method ?? 'POST',
    headers: { apikey: env.supabaseAnonKey, 'Content-Type': 'application/json',
      ...(options.token ? {Authorization: `Bearer ${options.token}`} : {}) },
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

  private recoveryKey(environment = this.envName(), env = this.env()) {
    return 'dhimantai.passwordRecovery:' + environment + ':' + createHash('sha256').update(env.supabaseUrl).digest('hex');
  }

  /** PKCE binds the email link to this installation without putting session tokens in a URL. */
  async requestPasswordReset(email: string): Promise<void> {
    const errors = authInputErrors({email}, 'forgotPassword');
    if (errors.email) throw new Error(errors.email);
    const environment = this.envName(), env = this.env(), key = this.recoveryKey(environment, env);
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('hex');
    const pending = JSON.stringify({verifier, state, email: email.trim().toLowerCase(), created: Date.now()});
    const redirect = `${vscode.env.uriScheme}://optficial.dhimantai-learning/password-reset?environment=${environment}&state=${state}`;
    this.clearPasswordRecovery();
    await this.secrets.store(key, pending);
    try {
      await gotrue(env, 'recover?redirect_to=' + encodeURIComponent(redirect), {
        email: email.trim(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256',
      });
    } catch (error) {
      if (await this.secrets.get(key) === pending) await this.secrets.delete(key);
      throw error;
    }
  }

  async acceptPasswordRecovery(uri: vscode.Uri): Promise<void> {
    const environment = this.envName(), env = this.env(), key = this.recoveryKey(environment, env);
    const invalid = () => new Error('This reset link has expired or belongs to another app or service. Request a new link from Forgot password.');
    const params = new URLSearchParams(uri.query);
    if (uri.scheme !== vscode.env.uriScheme || uri.authority !== 'optficial.dhimantai-learning'
        || uri.path !== '/password-reset' || params.get('environment') !== environment || !params.get('code')) throw invalid();
    let pending: {verifier: string; state: string; email: string; created: number};
    try { pending = JSON.parse(await this.secrets.get(key) ?? 'null'); } catch { throw invalid(); }
    if (!pending || params.get('state') !== pending.state || typeof pending.verifier !== 'string'
        || !Number.isFinite(pending.created) || Date.now() - pending.created > 60 * 60 * 1000) throw invalid();
    // Consume once, before exchange. A failed exchange requires a fresh email link.
    await this.secrets.delete(key);
    const session = toSession(await gotrue(env, 'token?grant_type=pkce', {auth_code: params.get('code'), code_verifier: pending.verifier}));
    if (environment !== this.envName() || env.supabaseUrl !== this.env().supabaseUrl
        || session.user.email?.toLowerCase() !== pending.email) throw invalid();
    passwordRecoveries.set(this.secrets, {session, environment, service: env});
    void openAuthPage(this.secrets, this, this.envName, 'resetPassword');
  }

  clearPasswordRecovery() { passwordRecoveries.delete(this.secrets); }

  async resetPassword(password: string, confirmation: string): Promise<void> {
    const errors = authInputErrors({password, confirmation}, 'resetPassword');
    if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
    const recovery = passwordRecoveries.get(this.secrets);
    if (!recovery || recovery.environment !== this.envName() || recovery.service.supabaseUrl !== this.env().supabaseUrl
        || recovery.session.expires_at <= Date.now() / 1000) {
      this.clearPasswordRecovery();
      throw new Error('Your reset link has expired. Request a new link from Forgot password.');
    }
    await gotrue(recovery.service, 'user', {password}, {method: 'PUT', token: recovery.session.access_token});
    this.clearPasswordRecovery();
    // Recovery never replaces the learner's saved sign-in session.
    await fetch(`${recovery.service.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: {apikey: recovery.service.supabaseAnonKey, Authorization: `Bearer ${recovery.session.access_token}`},
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
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

  async signUpWithPassword(name: string, email: string, password: string, notify = true): Promise<Session | undefined> {
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
      if (notify) void vscode.window.showInformationMessage('Check your email to confirm your account, then return to VS Code and sign in. If you already have an account, sign in with your existing password.', 'Sign In')
        .then(choice => { if (choice) return vscode.commands.executeCommand('dhimantai.signIn', environment); });
      return undefined;
    }
    return this.acceptSession(data, environment, env);
  }

  /** Opens the account page and resumes the caller after successful authentication. */
  signUp(): Promise<Session | undefined> {
    return openAuthPage(this.secrets, this, this.envName, 'signUp');
  }

  signIn(): Promise<Session | undefined> {
    return openAuthPage(this.secrets, this, this.envName, 'signIn');
  }
}
