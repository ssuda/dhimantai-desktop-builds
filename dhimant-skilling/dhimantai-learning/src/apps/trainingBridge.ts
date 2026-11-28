import {randomBytes} from 'node:crypto';
import type {CdpClient, CdpTransport} from './inject';

/** Relay only player traffic over the embedded browser's DevTools session. */
export async function trainingBridge(client: CdpClient, transport: CdpTransport, sessionId: string,
    {origin, port, token}: {origin: string; port: string; token: string}) {
  if (!/^\d{1,5}$/.test(port) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid training bridge.');
  const binding = '__dhimantai_' + randomBytes(12).toString('hex');
  const finish = binding + '_finish';
  const contexts = new Set<number>();
  const requests = new AbortController();
  const subscription = transport.onMessage(raw => {
    const event = raw as {sessionId?: string; method?: string; params?: any};
    if (event?.sessionId !== sessionId) return;
    const p = event.params;
    if (event.method === 'Runtime.executionContextCreated' && p.context?.origin === origin && p.context.auxData?.isDefault)
      contexts.add(p.context.id);
    if (event.method === 'Runtime.executionContextDestroyed') contexts.delete(p.executionContextId);
    if (event.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (event.method === 'Runtime.bindingCalled' && p.name === binding && contexts.has(p.executionContextId))
      void reply(p.executionContextId, p.payload).catch(() => {});
  });
  const dispose = () => { subscription.dispose(); requests.abort(); contexts.clear(); };
  async function reply(contextId: number, payload: string) {
    if (payload.length > 19_000) return;
    const {id, path, body} = JSON.parse(payload);
    if (!Number.isSafeInteger(id) || typeof path !== 'string' ||
        !(body === undefined ? /^\/(course|state)$/.test(path) :
          /^\/(observe|help|progress|question|focus|reconnect|continue-result|demonstration-result)$/.test(path))) return;
    let result;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: {Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: AbortSignal.any([requests.signal, AbortSignal.timeout(9000)]),
      });
      result = [response.status, await response.text()];
    } catch { result = [503, '{}']; }
    if (contexts.has(contextId)) await client.call('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(finish)}]?.(${id}, ${JSON.stringify(result)})`, contextId,
    }, sessionId, 1000);
  }
  try {
    await client.call('Runtime.enable', {}, sessionId);
    await client.call('Runtime.addBinding', {name: binding}, sessionId);
  } catch (error) { dispose(); throw error; }
  const source = `(() => {
    const send = globalThis[${JSON.stringify(binding)}];
    const pending = new Map();
    let next = 0;
    globalThis[${JSON.stringify(finish)}] = (id, result) => pending.get(id)?.(result);
    globalThis.dhimantaiTrainingRequest = (path, body) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Training connection timed out.')); }, 10000);
      pending.set(id, ([status, data]) => {
        pending.delete(id); clearTimeout(timer); resolve(new Response(data || null, {status}));
      });
      send(JSON.stringify({id, path, body}));
    });
  })();`;
  return {source, dispose};
}
