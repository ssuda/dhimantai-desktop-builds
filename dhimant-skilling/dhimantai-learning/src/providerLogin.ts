import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import type { Environment } from './environments';

const providers = {
  google: { label: 'Google', origin: 'https://accounts.google.com' },
  github: { label: 'GitHub', origin: 'https://github.com' },
  azure: { label: 'Microsoft', origin: 'https://login.microsoftonline.com' },
} as const;
export type LoginProvider = keyof typeof providers;
export function isLoginProvider(value: unknown): value is LoginProvider {
  return typeof value === 'string' && Object.hasOwn(providers, value);
}

const authority = 'optficial.dhimantai-learning';
export const providerCallbackPath = '/oauth-callback/';
const callbacks = new Map<string, (uri: vscode.Uri) => void>();

export function acceptProviderCallback(uri: vscode.Uri): boolean {
  if (uri.scheme !== vscode.env.uriScheme || uri.authority !== authority) return false;
  const accept = callbacks.get(uri.path);
  if (!accept) return false;
  callbacks.delete(uri.path);
  accept(uri);
  return true;
}

/** The verifier lives only in the initiating window while its account page is open. */
export async function requestProviderCode(service: Environment, provider: LoginProvider, signal: AbortSignal) {
  const { label, origin } = providers[provider];
  const path = providerCallbackPath + randomBytes(24).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const redirect = await vscode.env.asExternalUri(vscode.Uri.from({scheme: vscode.env.uriScheme, authority, path}));
  signal.throwIfAborted();
  const authorize = new URL(service.supabaseUrl + '/auth/v1/authorize');
  authorize.search = new URLSearchParams({
    provider, redirect_to: redirect.toString(true),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256',
  }).toString();
  if (provider === 'azure') authorize.searchParams.set('scopes', 'email');
  // Resolve the first hop here so a disabled provider can be reported on the account page.
  const response = await fetch(authorize, {redirect: 'manual', headers: {apikey: service.supabaseAnonKey},
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])});
  const location = response.headers.get('location');
  if (response.status !== 302 || !location || new URL(location).origin !== origin) {
    throw new Error(label + ' sign-in is unavailable on this service. Try another sign-in method.');
  }
  signal.throwIfAborted();
  let abort!: () => void;
  const code = await new Promise<string>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    callbacks.set(path, uri => {
      const query = new URLSearchParams(uri.query);
      const fragment = new URLSearchParams(uri.fragment);
      const code = query.get('code');
      if (query.has('error') || fragment.has('error') || !code) {
        reject(new Error(label + ' sign-in was not completed. Please try again.'));
      } else resolve(code);
    });
    Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(location))).then(opened => {
      if (!opened) reject(new Error('Could not open your browser. Please try again.'));
    }, () => reject(new Error('Could not open your browser. Please try again.')));
  }).finally(() => {
    signal.removeEventListener('abort', abort);
    callbacks.delete(path);
  });
  return {auth_code: code, code_verifier: verifier};
}
