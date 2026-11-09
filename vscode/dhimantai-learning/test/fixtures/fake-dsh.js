// A stand-in for the deepseek-harness runtime: the stdio JSON-RPC protocol of 0.2.1rc2, scripted.
// FAKE_DSH_MODE=crash exits on the first prompt. Every answer to our approval request is echoed in the reply.
const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let approval;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'ask-1') { approval = m.error ? 'refused' : 'granted'; return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, env: process.env.DSH_TELEMETRY_DISABLED } });
  if (m.method === 'shutdown') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return setTimeout(() => process.exit(0), 10); }
  if (m.method === 'session/resume') return send({ jsonrpc: '2.0', id: m.id, error: { code: 1, message: 'session/not-found' } });
  if (m.method === 'session/prompt') {
    if (process.env.FAKE_DSH_MODE === 'crash') process.exit(3);
    const sessionId = m.params.sessionId, text = m.params.contentBlocks[0].text;
    const ev = (event) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event } });
    ev({ type: 'session/title', data: {} }); // before the receipt: ignored
    send({ jsonrpc: '2.0', id: m.id, result: { messageId: 'msg-1' } });
    send({ jsonrpc: '2.0', id: 'ask-1', method: 'approval/request', params: { tool: 'bash' } });
    setTimeout(() => {
      ev({ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-1' }] } });
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'someone-else', event: { type: 'assistant/message', data: { content: [{ type: 'text', text: 'WRONG SESSION' }] } } } });
      ev({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `{"say":"You said: ${text.split('\n')[0]}","question":"approval ${approval}?","strategy":"trace","line":2,"replies":[]}` }] } } });
      ev({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
    }, 30);
  }
});
