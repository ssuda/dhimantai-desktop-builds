import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

function fixture() {
  const stored = new Map<string, string>(), requests: {url: URL; options: RequestInit; body: any}[] = [], pages: string[] = [];
  let environment = 'staging', switched = false, account = 'learner@example.test', responseError = false;
  const service = {supabaseUrl: 'https://auth.example.test', supabaseAnonKey: 'public-key'};
  const secrets = {get: async (key: string) => stored.get(key), store: async (key: string, value: string) => {stored.set(key, value);},
    delete: async (key: string) => {stored.delete(key);}};
  const file = resolve(__dirname, '../src/auth.js'), realRequire = createRequire(file), exports: any = {};
  runInNewContext(readFileSync(file, 'utf8'), {exports, URLSearchParams, AbortSignal, Error, Date,
    fetch: async (input: string, options: RequestInit) => {
      const url = new URL(input), body = options.body ? JSON.parse(options.body as string) : undefined;
      requests.push({url, options, body});
      if (responseError) return new Response(JSON.stringify({error_code:'over_email_send_rate_limit',msg:'Rate limited'}), {status:429});
      if (url.searchParams.get('grant_type') === 'pkce') {
        if (switched) environment = 'production';
        return new Response(JSON.stringify({access_token:'recovery-only',refresh_token:'recovery-refresh',expires_in:3600,
          user:{id:'learner',email:account}}));
      }
      return new Response('{}');
    }, require: (id: string) => id === 'vscode' ? {env:{uriScheme:'dhimantai'}, EventEmitter:class {event = () => ({dispose(){}}); fire(){throw new Error('Recovery must not sign in');}}}
      : id === './authPage' ? {openAuthPage: (_owner: unknown, _auth: unknown, _env: unknown, mode: string) => {pages.push(mode);}}
      : realRequire(id)});
  const auth = new exports.Auth(secrets, () => environment, () => service);
  const link = () => {
    const request = requests.find(r => r.url.pathname.endsWith('/recover'))!;
    const url = new URL(request.url.searchParams.get('redirect_to')!);
    url.searchParams.set('code', 'email-code');
    return {scheme:url.protocol.slice(0,-1),authority:url.host,path:url.pathname,query:url.search.slice(1)};
  };
  return {auth, stored, requests, pages, link,
    another: () => new exports.Auth(secrets, () => environment, () => service),
    switchDuringExchange: () => {switched = true;}, wrongAccount: () => {account = 'other@example.test';},
    fail: () => {responseError = true;}, environment: (value: string) => {environment = value;}};
}

test('email recovery binds a one-use link to PKCE and changes only the verified account password', async () => {
  const f = fixture();
  await f.auth.requestPasswordReset(' learner@example.test ');
  const pending = JSON.parse([...f.stored.values()][0]);
  assert.equal(f.requests[0].body.email, 'learner@example.test');
  assert.equal(f.requests[0].body.code_challenge, createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.equal(f.requests[0].body.code_challenge_method, 's256');
  assert.ok(!f.link().query.includes(pending.verifier));
  const restarted = f.another();
  await restarted.acceptPasswordRecovery(f.link());
  assert.equal(f.stored.size, 0, 'one-use verifier survives restart and is consumed');
  assert.deepEqual(f.pages, ['resetPassword']);
  assert.equal(f.requests[1].body.code_verifier, pending.verifier);
  await assert.rejects(restarted.acceptPasswordRecovery(f.link()), /expired/);
  await assert.rejects(f.auth.resetPassword('short','short'), /at least 8/);
  await assert.rejects(f.auth.resetPassword('valid password','different password'), /same password/);
  await f.auth.resetPassword('valid password','valid password'); // An already-open helper Auth page shares recovery.
  const update = f.requests.find(r => r.options.method === 'PUT')!;
  assert.equal((update.options.headers as any).Authorization, 'Bearer recovery-only');
  assert.deepEqual(update.body, {password:'valid password'});
  assert.match(f.requests.at(-1)!.url.href, /logout\?scope=local$/);
  await assert.rejects(f.auth.resetPassword('valid password','valid password'), /expired/);
  assert.equal(f.stored.size, 0, 'recovery credentials are never persisted as a normal session');
});

test('invalid, expired, mismatched and cross-service reset links cannot authorize a password change', async () => {
  for (const problem of ['scheme','authority','state','expired','environment','exchangeEnvironment','account']) {
    const f = fixture(); await f.auth.requestPasswordReset('learner@example.test');
    const uri = f.link();
    if (problem === 'scheme') uri.scheme = 'https';
    if (problem === 'authority') uri.authority = 'other.extension';
    if (problem === 'state') uri.query = uri.query.replace(/state=[^&]+/, 'state=wrong');
    if (problem === 'environment') f.environment('production');
    if (problem === 'expired') {
      const [key, value] = [...f.stored][0];
      f.stored.set(key, JSON.stringify({...JSON.parse(value), created:Date.now() - 3_600_001}));
    }
    if (problem === 'exchangeEnvironment') f.switchDuringExchange();
    if (problem === 'account') f.wrongAccount();
    await assert.rejects(f.auth.acceptPasswordRecovery(uri), /expired|another app/);
    await assert.rejects(f.auth.resetPassword('valid password','valid password'), /expired/);
    assert.equal(f.pages.length, 0, problem);
    assert.ok(!f.requests.some(r => r.options.method === 'PUT'));
  }
});

test('invalid email, provider failure and cancelled reset leave no usable recovery session', async () => {
  const f = fixture();
  await assert.rejects(f.auth.requestPasswordReset('bad-email'), /valid email/);
  assert.equal(f.requests.length, 0);
  f.fail(); await assert.rejects(f.auth.requestPasswordReset('learner@example.test'), /Rate limited/);
  assert.equal(f.stored.size, 0);
  const g = fixture(); await g.auth.requestPasswordReset('learner@example.test'); await g.auth.acceptPasswordRecovery(g.link());
  g.auth.clearPasswordRecovery(); await assert.rejects(g.auth.resetPassword('valid password','valid password'), /expired/);
});
