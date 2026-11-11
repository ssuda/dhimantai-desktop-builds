import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { Auth, Session, SignInRequired, setAuthDiagnostics } from '../../src/auth';
import { EnvironmentName } from '../../src/environments';

/** Exercise real Auth storage/events with controlled HTTP outcomes, no accounts or live service. */
export async function run() {
  await vscode.extensions.getExtension('optficial.dhimantai-learning')!.activate();
  const originalFetch = globalThis.fetch;
  const results: {step: string; ok: boolean}[] = [];
  const logs: string[] = [];
  const key = 'dhimantai.session.production';
  let environment: EnvironmentName = 'production';
  const service = {supabaseUrl: 'https://auth.invalid', supabaseAnonKey: 'fixture-key', apiUrl: 'https://api.invalid'};
  const values = new Map<string, string>();
  const secrets = {get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); }} as unknown as vscode.SecretStorage;
  const auth = new Auth(secrets, () => environment, () => service);
  const sibling = new Auth(secrets, () => environment, () => service);
  const current: Session = {access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_at: 1, user: {id: 'learner'}};
  const next: Session = {...current, access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', expires_at: Math.floor(Date.now() / 1000) + 3600};
  let calls = 0;
  let respond: () => Promise<Response>;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal, 'every request needs a deadline');
    calls++;
    return respond();
  };
  setAuthDiagnostics({appendLine: line => logs.push(line)});
  const check = async (step: string, action: () => Promise<void>) => {
    values.clear(); values.set(key, JSON.stringify(current)); environment = 'production'; calls = 0; logs.length = 0;
    try { await action(); results.push({step, ok: true}); }
    catch (error) { results.push({step, ok: false}); throw error; }
  };
  try {
    await check('healthy tokens do not refresh', async () => {
      values.set(key, JSON.stringify(next));
      assert.equal(await auth.accessToken(), next.access_token);
      assert.equal(calls, 0);
    });
    await check('offline requests share three bounded attempts and retain the saved session', async () => {
      respond = async () => { throw new TypeError('PRIVATE_NETWORK_DETAILS'); };
      const start = Date.now();
      const outcomes = await Promise.allSettled([auth.accessToken(), sibling.accessToken(), auth.accessToken()]);
      assert.equal(calls, 3);
      assert.ok(Date.now() - start >= 2900, 'one- and two-second backoff');
      for (const result of outcomes) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') {
          assert.ok(!(result.reason instanceof SignInRequired));
          assert.match(result.reason.message, /sign-in is saved/);
        }
      }
      assert.deepEqual(await auth.session(), current);
      assert.equal(logs.length, 3);
      assert.ok(logs.every(line => /\[\d{4}-.*Z\] Session refresh/.test(line)));
      assert.doesNotMatch(logs.join('\n'), /PRIVATE/);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(calls, 3, 'failure must not schedule another refresh');
      respond = async () => Response.json(next);
      assert.equal(await auth.accessToken(), next.access_token, 'explicit retry recovers after reconnecting');
      assert.deepEqual(await auth.session(), next);
    });
    await check('rate limit and server failure back off then recover with one session event', async () => {
      let events = 0;
      const listener = auth.onDidChange(() => events++);
      respond = async () => calls < 3 ? Response.json({message: 'PRIVATE_PROVIDER'}, {status: calls === 1 ? 429 : 503}) : Response.json(next);
      assert.equal(await auth.accessToken(), next.access_token);
      assert.equal(calls, 3); assert.equal(events, 1);
      assert.match(logs.join('\n'), /HTTP 429/); assert.match(logs.join('\n'), /HTTP 503/);
      assert.doesNotMatch(logs.join('\n'), /PRIVATE_PROVIDER/);
      listener.dispose();
    });
    await check('persistent server failures stop at three attempts without deleting the session', async () => {
      respond = async () => Response.json({error_code: 'unexpected_failure'}, {status: 503});
      await assert.rejects(auth.accessToken(), /sign-in is saved/);
      assert.equal(calls, 3); assert.deepEqual(await auth.session(), current);
    });
    await check('timeouts while reading the refresh response retry and recover', async () => {
      respond = async () => {
        const response = Response.json(next);
        if (calls === 1) response.json = async () => { throw new DOMException('PRIVATE_TIMEOUT', 'TimeoutError'); };
        return response;
      };
      assert.equal(await auth.accessToken(), next.access_token);
      assert.equal(calls, 2); assert.match(logs[0], /request timed out/);
      assert.doesNotMatch(logs[0], /PRIVATE_TIMEOUT/);
    });
    await check('revoked refresh tokens require sign-in without retries', async () => {
      respond = async () => Response.json({error_code: 'refresh_token_not_found', message: 'PRIVATE_TOKEN'}, {status: 400});
      await assert.rejects(auth.accessToken(), SignInRequired);
      assert.equal(calls, 1); assert.equal(await auth.session(), undefined);
      assert.match(logs[0], /refresh_token_not_found/); assert.doesNotMatch(logs[0], /PRIVATE/);
    });
    await check('unrecognized errors and malformed success preserve sign-in', async () => {
      for (const response of [Response.json({code: 'privatevalue'}, {status: 401}), Response.json({access_token: 'partial'})]) {
        respond = async () => response;
        await assert.rejects(auth.accessToken(), /sign-in is saved/);
        assert.deepEqual(await auth.session(), current);
      }
      assert.equal(calls, 2); assert.doesNotMatch(logs.join('\n'), /privatevalue/);
    });
    await check('a response for another account clears only the rejected session', async () => {
      respond = async () => Response.json({...next, user: {id: 'other'}});
      await assert.rejects(auth.accessToken(), /account changed/);
      assert.equal(await auth.session(), undefined);
    });
    await check('sign-out while refreshing cannot restore a session', async () => {
      let finish!: (value: Response) => void;
      respond = () => new Promise(resolve => { finish = resolve; });
      const pending = auth.accessToken();
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      respond = async () => new Response(null, {status: 204});
      await sibling.signOut();
      finish(Response.json(next));
      await assert.rejects(pending, /session changed/);
      assert.equal(await auth.session(), undefined);
    });
    await check('refresh completion cannot overwrite a newly signed-in session', async () => {
      let finish!: (value: Response) => void;
      respond = () => new Promise(resolve => { finish = resolve; });
      const pending = auth.accessToken();
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      values.set(key, JSON.stringify({...next, user: {id: 'replacement'}}));
      finish(Response.json({error_code: 'refresh_token_not_found'}, {status: 400}));
      await assert.rejects(pending, /session changed/);
      assert.equal((await auth.session())?.user.id, 'replacement');
    });
    await check('sign-out wins even when a refresh storage write has already started', async () => {
      const store = secrets.store;
      let finish!: () => void;
      secrets.store = async (key, value) => {
        await new Promise<void>(resolve => { finish = resolve; });
        await store(key, value);
      };
      try {
        respond = async () => Response.json(next);
        const pending = auth.accessToken();
        while (!finish) await new Promise(resolve => setImmediate(resolve));
        const logout = sibling.signOut();
        await new Promise(resolve => setImmediate(resolve));
        finish();
        await pending; await logout;
        assert.equal(await auth.session(), undefined);
      } finally { secrets.store = store; }
    });
    await check('switching services during refresh never writes or returns the wrong service token', async () => {
      let finish!: (value: Response) => void;
      respond = () => new Promise(resolve => { finish = resolve; });
      const pending = auth.accessToken();
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      environment = 'staging';
      finish(Response.json(next));
      await assert.rejects(pending, /service changed/);
      assert.equal(await auth.session(), undefined);
      assert.equal(JSON.parse(values.get(key)!).access_token, next.access_token);
    });
  } finally {
    globalThis.fetch = originalFetch;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
